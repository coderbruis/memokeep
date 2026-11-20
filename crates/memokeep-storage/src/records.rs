//! Optional record layout. Activation is explicit and caller transactions remain authoritative.
use crate::{connect, revision, Fields, StorageError};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

pub const COLLECTIONS: [&str; 2] = ["documents", "cardDocuments"];
pub fn is_collection(field: &str) -> bool {
    COLLECTIONS.contains(&field)
}

#[derive(Debug, Deserialize, Serialize)]
pub struct RecordChange {
    pub id: String,
    pub value: Option<Value>,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct CollectionPatch {
    pub field: String,
    pub changes: Vec<RecordChange>,
}
#[derive(Serialize)]
pub struct RecordSet {
    pub revision: i64,
    pub data: Fields,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryPage {
    pub revision: i64,
    pub rows: Vec<Value>,
    pub total: usize,
    pub next_offset: Option<usize>,
}

pub fn installed_on(db: &Connection) -> Result<bool, StorageError> {
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_record_mode')", [], |r| r.get(0))?)
}
pub fn enabled_on(db: &Connection, scope: &str) -> Result<bool, StorageError> {
    if !installed_on(db)? {
        return Ok(false);
    }
    let version: Option<i64> = db
        .query_row(
            "SELECT version FROM workspace_record_mode WHERE scope=?1",
            [scope],
            |row| row.get(0),
        )
        .optional()?;
    match version {
        None => Ok(false),
        Some(1) => Ok(true),
        Some(version) => Err(StorageError::UnsupportedRecordSchema(version)),
    }
}
pub fn enabled(path: &Path, scope: &str) -> Result<bool, StorageError> {
    enabled_on(&connect(path)?, scope)
}
pub fn present_on(db: &Connection, scope: &str, field: &str) -> Result<bool, StorageError> {
    db.query_row(
        "SELECT present FROM workspace_record_collection WHERE scope=?1 AND field=?2",
        params![scope, field],
        |r| r.get(0),
    )
    .optional()?
    .ok_or(StorageError::InvalidRecord)
}
pub fn activate(path: &Path, scope: &str, expected: i64) -> Result<i64, StorageError> {
    let mut db = connect(path)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let value = activate_on(&tx, scope, expected)?;
    tx.commit()?;
    Ok(value)
}
pub fn write(
    path: &Path,
    scope: &str,
    expected: i64,
    records: &[CollectionPatch],
    updated: &Fields,
    removed: &[String],
) -> Result<i64, StorageError> {
    let mut db = connect(path)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let result = crate::write_records_on(&tx, scope, expected, records, updated, removed)?;
    tx.commit()?;
    Ok(result)
}
pub fn activate_on(db: &Connection, scope: &str, expected: i64) -> Result<i64, StorageError> {
    if revision(db, scope)? != expected {
        return Err(StorageError::StaleRevision);
    }
    if enabled_on(db, scope)? {
        db.pragma_update(None, "user_version", 4)?;
        return Ok(expected);
    }
    db.execute_batch("CREATE TABLE IF NOT EXISTS workspace_record_mode(scope TEXT PRIMARY KEY,version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_record_collection(scope TEXT NOT NULL,field TEXT NOT NULL,present INTEGER NOT NULL,PRIMARY KEY(scope,field));
      CREATE TABLE IF NOT EXISTS workspace_record(scope TEXT NOT NULL,field TEXT NOT NULL,id TEXT NOT NULL,position INTEGER NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),PRIMARY KEY(scope,field,id));
      CREATE INDEX IF NOT EXISTS workspace_record_order ON workspace_record(scope,field,position,id);
      CREATE INDEX IF NOT EXISTS workspace_record_recent ON workspace_record(scope,field,coalesce(json_extract(payload,'$.updatedAt'),json_extract(payload,'$.importedAt'),'') DESC,id);")?;
    db.execute("INSERT INTO workspace_record_mode VALUES(?1,1)", [scope])?;
    for field in COLLECTIONS {
        db.execute(
            "INSERT INTO workspace_record_collection VALUES(?1,?2,0)",
            params![scope, field],
        )?;
        let payload: Option<String> = db
            .query_row(
                "SELECT payload FROM workspace_field WHERE scope=?1 AND field=?2",
                params![scope, field],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(payload) = payload {
            replace_on(db, scope, field, Some(&serde_json::from_str(&payload)?))?;
        }
        db.execute(
            "DELETE FROM workspace_field WHERE scope=?1 AND field=?2",
            params![scope, field],
        )?;
    }
    // Older v3 readers must reject this database rather than mistake removed arrays for empty notes.
    db.pragma_update(None, "user_version", 4)?;
    Ok(expected)
}
fn checked(field: &str, changes: &[RecordChange]) -> Result<(), StorageError> {
    let mut seen = BTreeSet::new();
    if !is_collection(field) {
        return Err(StorageError::InvalidRecord);
    }
    for change in changes {
        if change.id.is_empty()
            || !seen.insert(&change.id)
            || change
                .value
                .as_ref()
                .is_some_and(|v| !v.is_object() || v["id"].as_str() != Some(change.id.as_str()))
        {
            return Err(StorageError::InvalidRecord);
        }
    }
    Ok(())
}
pub(crate) fn apply_on(
    db: &Connection,
    scope: &str,
    field: &str,
    changes: &[RecordChange],
) -> Result<Vec<String>, StorageError> {
    checked(field, changes)?;
    let mut changed = Vec::new();
    let mut position: i64 = db.query_row(
        "SELECT COALESCE(MAX(position),-1)+1 FROM workspace_record WHERE scope=?1 AND field=?2",
        params![scope, field],
        |r| r.get(0),
    )?;
    for change in changes {
        let count = match &change.value {
            Some(value) => {
                let count = db.execute("INSERT INTO workspace_record VALUES(?1,?2,?3,?4,?5) ON CONFLICT(scope,field,id) DO UPDATE SET payload=excluded.payload WHERE workspace_record.payload<>excluded.payload",params![scope,field,change.id,position,serde_json::to_string(value)?])?;
                position += 1;
                count
            }
            None => db.execute(
                "DELETE FROM workspace_record WHERE scope=?1 AND field=?2 AND id=?3",
                params![scope, field, change.id],
            )?,
        };
        if count > 0 {
            changed.push(change.id.to_owned());
        }
    }
    if !changed.is_empty() {
        db.execute(
            "UPDATE workspace_record_collection SET present=1 WHERE scope=?1 AND field=?2 AND present<>1",
            params![scope, field],
        )?;
    }
    Ok(changed)
}
pub(crate) fn replace_on(
    db: &Connection,
    scope: &str,
    field: &str,
    value: Option<&Value>,
) -> Result<(bool, Vec<String>), StorageError> {
    if !is_collection(field) {
        return Err(StorageError::InvalidRecord);
    }
    let empty = Vec::new();
    let rows = match value {
        Some(value) => value.as_array().ok_or(StorageError::InvalidRecord)?,
        None => &empty,
    };
    let mut existing = BTreeMap::new();
    let mut query =
        db.prepare("SELECT id,position,payload FROM workspace_record WHERE scope=?1 AND field=?2")?;
    for row in query.query_map(params![scope, field], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
        ))
    })? {
        let (id, pos, payload) = row?;
        existing.insert(id, (pos, payload));
    }
    let mut changed = Vec::new();
    let mut seen = BTreeSet::new();
    for (position, row) in rows.iter().enumerate() {
        let id = row
            .get("id")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .ok_or(StorageError::InvalidRecord)?;
        if !seen.insert(id) {
            return Err(StorageError::InvalidRecord);
        }
        let payload = serde_json::to_string(row)?;
        let prior = existing.remove(id);
        if prior
            .as_ref()
            .is_none_or(|(prior_position, prior_payload)| {
                *prior_position != position as i64 || prior_payload != &payload
            })
        {
            db.execute("INSERT INTO workspace_record VALUES(?1,?2,?3,?4,?5) ON CONFLICT(scope,field,id) DO UPDATE SET position=excluded.position,payload=excluded.payload",params![scope,field,id,position as i64,payload])?;
            changed.push(id.to_owned());
        }
    }
    for (id, _) in existing {
        db.execute(
            "DELETE FROM workspace_record WHERE scope=?1 AND field=?2 AND id=?3",
            params![scope, field, id],
        )?;
        changed.push(id);
    }
    let presence_changed = present_on(db, scope, field)? != value.is_some();
    db.execute(
        "UPDATE workspace_record_collection SET present=?3 WHERE scope=?1 AND field=?2 AND present<>?3",
        params![scope, field, value.is_some()],
    )?;
    Ok((presence_changed || !changed.is_empty(), changed))
}
pub(crate) fn read_collection_on(
    db: &Connection,
    scope: &str,
    field: &str,
) -> Result<Option<Value>, StorageError> {
    if !present_on(db, scope, field)? {
        return Ok(None);
    }
    let mut query = db.prepare(
        "SELECT payload FROM workspace_record WHERE scope=?1 AND field=?2 ORDER BY position,id",
    )?;
    let mut values = Vec::new();
    for row in query.query_map(params![scope, field], |r| r.get::<_, String>(0))? {
        values.push(serde_json::from_str(&row?)?);
    }
    Ok(Some(Value::Array(values)))
}
pub fn read_ids_on(
    db: &Connection,
    scope: &str,
    field: &str,
    ids: &[String],
) -> Result<Vec<Value>, StorageError> {
    if !crate::valid_field(field) {
        return Err(StorageError::InvalidField);
    }
    if enabled_on(db, scope)? && is_collection(field) {
        let mut query = db.prepare(
            "SELECT payload FROM workspace_record WHERE scope=?1 AND field=?2 AND id=?3",
        )?;
        let mut result = Vec::new();
        for id in ids {
            if let Some(payload) = query
                .query_row(params![scope, field, id], |r| r.get::<_, String>(0))
                .optional()?
            {
                result.push(serde_json::from_str(&payload)?);
            }
        }
        return Ok(result);
    }
    let snapshot = crate::read_fields_on(db, scope, &[field.to_owned()])?;
    // Legacy parsing owns the array; selected records must outlive that temporary snapshot.
    Ok(snapshot
        .data
        .get(field)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|v| {
            v["id"]
                .as_str()
                .is_some_and(|id| ids.iter().any(|s| s == id))
        })
        .cloned()
        .collect())
}
pub fn read_set(
    path: &Path,
    scope: &str,
    requests: &[CollectionPatch],
) -> Result<RecordSet, StorageError> {
    let mut db = connect(path)?;
    let tx = db.transaction()?;
    let mut data = Fields::new();
    for request in requests {
        let ids = request
            .changes
            .iter()
            .map(|row| row.id.to_owned())
            .collect::<Vec<_>>();
        data.insert(
            request.field.to_owned(),
            Value::Array(read_ids_on(&tx, scope, &request.field, &ids)?),
        );
    }
    let result = RecordSet {
        revision: revision(&tx, scope)?,
        data,
    };
    tx.commit()?;
    Ok(result)
}
pub fn summaries(
    path: &Path,
    scope: &str,
    field: &str,
    offset: usize,
    limit: usize,
) -> Result<SummaryPage, StorageError> {
    if !is_collection(field) {
        return Err(StorageError::InvalidRecord);
    }
    let mut db = connect(path)?;
    let tx = db.transaction()?;
    if !enabled_on(&tx, scope)? {
        return Err(StorageError::RecordsInactive);
    }
    let total = tx.query_row(
        "SELECT count(*) FROM workspace_record WHERE scope=?1 AND field=?2",
        params![scope, field],
        |r| r.get::<_, usize>(0),
    )?;
    let limit = limit.clamp(1, 200);
    let mut rows = Vec::new();
    {
        let mut query=tx.prepare("SELECT json_object('id',id,'title',json_extract(payload,'$.title'),'knowledgeBaseId',json_extract(payload,'$.knowledgeBaseId'),'updatedAt',json_extract(payload,'$.updatedAt'),'createdAt',json_extract(payload,'$.createdAt'),'importedAt',json_extract(payload,'$.importedAt'),'sourceType',json_extract(payload,'$.sourceType'),'metadata',json_object('fileType',json_extract(payload,'$.metadata.fileType'),'editorMode',json_extract(payload,'$.metadata.editorMode'))) FROM workspace_record WHERE scope=?1 AND field=?2 ORDER BY coalesce(json_extract(payload,'$.updatedAt'),json_extract(payload,'$.importedAt'),'') DESC,id LIMIT ?3 OFFSET ?4")?;
        for row in query.query_map(params![scope, field, limit, offset], |r| {
            r.get::<_, String>(0)
        })? {
            rows.push(serde_json::from_str(&row?)?);
        }
    }
    let page = SummaryPage {
        revision: revision(&tx, scope)?,
        next_offset: if offset + rows.len() < total {
            Some(offset + rows.len())
        } else {
            None
        },
        rows,
        total,
    };
    tx.commit()?;
    Ok(page)
}
