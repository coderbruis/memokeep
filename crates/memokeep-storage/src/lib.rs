use std::{collections::BTreeSet, path::Path, time::Duration};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::{Map, Value};
use thiserror::Error;

pub mod backup;
pub mod images;
pub mod pomodoro;
pub mod publishing;
pub mod records;
pub mod reminders;
pub mod search;

const SCHEMA_VERSION: i64 = 4;
const MAX_SAFE_REVISION: i64 = 9_007_199_254_740_991;
pub type Fields = Map<String, Value>;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("数据库操作失败")]
    Sql(#[from] rusqlite::Error),
    #[error("工作空间 JSON 无效")]
    Json(#[from] serde_json::Error),
    #[error("数据库版本不受支持：{0}")]
    UnsupportedSchema(i64),
    #[error("工作空间已更新，请重新读取后保存")]
    StaleRevision,
    #[error("数据库修订值无效")]
    InvalidRevision,
    #[error("工作空间包含无效字段")]
    InvalidField,
    #[error("记录存储尚未显式启用")]
    RecordsInactive,
    #[error("记录布局版本不受支持：{0}")]
    UnsupportedRecordSchema(i64),
    #[error("笔记记录或集合格式无效")]
    InvalidRecord,
    #[error("图片 ID 无效")]
    InvalidImageId,
    #[error("仅支持 PNG、JPEG、GIF 或 WebP 图片")]
    UnsupportedImage,
    #[error("图片不能超过 25 MB")]
    ImageTooLarge,
    #[error("图片内容无法读取")]
    InvalidImageEncoding(#[from] base64::DecodeError),
}

#[derive(Debug, Serialize)]
pub struct Snapshot {
    pub revision: i64,
    pub data: Fields,
}

pub fn initialize(path: &Path) -> Result<(), StorageError> {
    let mut db = Connection::open(path)?;
    db.busy_timeout(Duration::from_secs(5))?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version = schema_version(&tx)?;
    if !(0..=SCHEMA_VERSION).contains(&version) {
        return Err(StorageError::UnsupportedSchema(version));
    }
    if version == 0 {
        tx.execute_batch(
            "CREATE TABLE workspace_revision (
                scope TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision > 0)
             );
             CREATE TABLE workspace_field (
                scope TEXT NOT NULL REFERENCES workspace_revision(scope),
                field TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
                PRIMARY KEY (scope, field)
             );",
        )?;
    }
    if version < 2 {
        tx.execute_batch(
            "CREATE TABLE note_image (
                id TEXT PRIMARY KEY, payload BLOB NOT NULL
             );
             PRAGMA user_version = 2;",
        )?;
    }
    if version < 3 {
        search::install(&tx)?;
        backup::install(&tx)?;
        tx.pragma_update(None, "user_version", 3)?;
    }
    tx.commit()?;
    Ok(())
}

fn schema_version(db: &Connection) -> Result<i64, StorageError> {
    Ok(db.query_row("PRAGMA user_version", [], |row| row.get(0))?)
}

pub(crate) fn connect(path: &Path) -> Result<Connection, StorageError> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    db.busy_timeout(Duration::from_secs(5))?;
    db.pragma_update(None, "foreign_keys", true)?;
    let version = schema_version(&db)?;
    if !matches!(version, 3 | 4) {
        return Err(StorageError::UnsupportedSchema(version));
    }
    if version == 4 && !records::installed_on(&db)? {
        return Err(StorageError::InvalidRecord);
    }
    Ok(db)
}

pub(crate) fn revision(db: &Connection, scope: &str) -> Result<i64, StorageError> {
    let revision = db
        .query_row(
            "SELECT revision FROM workspace_revision WHERE scope = ?1",
            [scope],
            |row| row.get(0),
        )
        .optional()?;
    match revision {
        None => Ok(0),
        Some(value) if (1..=MAX_SAFE_REVISION).contains(&value) => Ok(value),
        Some(_) => Err(StorageError::InvalidRevision),
    }
}

/// A read transaction keeps the revision and its fields on the same SQLite snapshot.
pub fn read(path: &Path, scope: &str) -> Result<Snapshot, StorageError> {
    let mut db = connect(path)?;
    let tx = db.transaction()?;
    let snapshot = read_on(&tx, scope)?;
    tx.commit()?;
    Ok(snapshot)
}

/// Reads the requested fields on the same snapshot as the returned revision.
pub fn read_fields(path: &Path, scope: &str, names: &[String]) -> Result<Snapshot, StorageError> {
    let mut db = connect(path)?;
    let tx = db.transaction()?;
    let snapshot = read_fields_on(&tx, scope, names)?;
    tx.commit()?;
    Ok(snapshot)
}

pub fn read_fields_on(
    db: &Connection,
    scope: &str,
    names: &[String],
) -> Result<Snapshot, StorageError> {
    let revision = revision(db, scope)?;
    let mut data = Fields::new();
    {
        let mut query =
            db.prepare("SELECT payload FROM workspace_field WHERE scope=?1 AND field=?2")?;
        for name in names {
            if !valid_field(name) {
                return Err(StorageError::InvalidField);
            }
            if records::enabled_on(db, scope)? && records::is_collection(name) {
                if let Some(value) = records::read_collection_on(db, scope, name)? {
                    data.insert(name.to_owned(), value);
                }
                continue;
            }
            let payload: Option<String> = query
                .query_row(params![scope, name], |row| row.get(0))
                .optional()?;
            if let Some(payload) = payload {
                data.insert(name.to_owned(), serde_json::from_str(&payload)?);
            }
        }
    }
    Ok(Snapshot { revision, data })
}

pub fn read_on(db: &Connection, scope: &str) -> Result<Snapshot, StorageError> {
    let revision = revision(db, scope)?;
    let mut data = {
        let mut query =
            db.prepare("SELECT field, payload FROM workspace_field WHERE scope = ?1")?;
        let mut rows = query.query([scope])?;
        let mut fields = Fields::new();
        while let Some(row) = rows.next()? {
            let field: String = row.get(0)?;
            let json: String = row.get(1)?;
            fields.insert(field, serde_json::from_str(&json)?);
        }
        fields
    };
    if records::enabled_on(db, scope)? {
        for name in records::COLLECTIONS {
            data.remove(name);
            if let Some(value) = records::read_collection_on(db, scope, name)? {
                data.insert(name.to_owned(), value);
            }
        }
    }
    Ok(Snapshot { revision, data })
}

pub fn read_records_on(
    db: &Connection,
    scope: &str,
    field: &str,
    ids: &[String],
) -> Result<Vec<Value>, StorageError> {
    records::read_ids_on(db, scope, field, ids)
}

pub fn write_snapshot_on(
    db: &Connection,
    scope: &str,
    expected: i64,
    fields: &Fields,
) -> Result<i64, StorageError> {
    write_on(db, scope, expected, fields, false)
}

pub fn write_fields_on(
    db: &Connection,
    scope: &str,
    expected: i64,
    updated: &Fields,
    removed: &[String],
) -> Result<i64, StorageError> {
    apply_fields(db, scope, expected, updated, removed, false)
}

pub fn write_records_on(
    db: &Connection,
    scope: &str,
    expected: i64,
    changes: &[records::CollectionPatch],
    updated: &Fields,
    removed: &[String],
) -> Result<i64, StorageError> {
    apply_fields_records(db, scope, expected, updated, removed, false, changes)
}

/// The compatibility snapshot is supplied per request. Only changed fields are persisted.
pub fn write(
    path: &Path,
    scope: &str,
    expected_revision: i64,
    fields: &Fields,
) -> Result<i64, StorageError> {
    let mut db = connect(path)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let saved = write_on(&tx, scope, expected_revision, fields, false)?;
    tx.commit()?;
    Ok(saved)
}

fn write_on(
    db: &Connection,
    scope: &str,
    expected_revision: i64,
    fields: &Fields,
    images_changed: bool,
) -> Result<i64, StorageError> {
    let mut previous_fields = {
        let mut query = db.prepare("SELECT field FROM workspace_field WHERE scope = ?1")?;
        let names = query.query_map([scope], |row| row.get::<_, String>(0))?;
        names.collect::<Result<BTreeSet<_>, _>>()?
    };
    if records::enabled_on(db, scope)? {
        for field in records::COLLECTIONS {
            if records::present_on(db, scope, field)? {
                previous_fields.insert(field.to_owned());
            }
        }
    }
    let removed = previous_fields
        .into_iter()
        .filter(|field| !fields.contains_key(field))
        .collect::<Vec<_>>();
    apply_fields(
        db,
        scope,
        expected_revision,
        fields,
        &removed,
        images_changed,
    )
}

fn valid_field(name: &str) -> bool {
    !name.is_empty() && !matches!(name, "__proto__" | "constructor" | "prototype")
}

pub fn write_fields(
    path: &Path,
    scope: &str,
    expected_revision: i64,
    updated: &Fields,
    removed: &[String],
) -> Result<i64, StorageError> {
    let mut db = connect(path)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let saved = apply_fields(&tx, scope, expected_revision, updated, removed, false)?;
    tx.commit()?;
    Ok(saved)
}

fn apply_fields(
    db: &Connection,
    scope: &str,
    expected_revision: i64,
    fields: &Fields,
    removed: &[String],
    images_changed: bool,
) -> Result<i64, StorageError> {
    apply_fields_records(
        db,
        scope,
        expected_revision,
        fields,
        removed,
        images_changed,
        &[],
    )
}

fn apply_fields_records(
    db: &Connection,
    scope: &str,
    expected_revision: i64,
    fields: &Fields,
    removed: &[String],
    images_changed: bool,
    record_patches: &[records::CollectionPatch],
) -> Result<i64, StorageError> {
    if fields.keys().any(|field| !valid_field(field))
        || removed
            .iter()
            .any(|field| !valid_field(field) || fields.contains_key(field))
    {
        return Err(StorageError::InvalidField);
    }
    let current = revision(db, scope)?;
    if expected_revision != current {
        return Err(StorageError::StaleRevision);
    }
    let next = current
        .checked_add(1)
        .filter(|value| *value <= MAX_SAFE_REVISION)
        .ok_or(StorageError::InvalidRevision)?;
    if current == 0 {
        db.execute(
            "INSERT INTO workspace_revision VALUES (?1, ?2)",
            params![scope, next],
        )?;
    }
    let mut changed = 0;
    let record_mode = records::enabled_on(db, scope)?;
    let mut publishing_changes: Vec<(String, Option<Vec<String>>)> = Vec::new();
    let mut record_fields = BTreeSet::new();
    for patch in record_patches {
        if !record_mode {
            return Err(StorageError::RecordsInactive);
        }
        if !record_fields.insert(&patch.field)
            || fields.contains_key(&patch.field)
            || removed.contains(&patch.field)
        {
            return Err(StorageError::InvalidRecord);
        }
        let ids = records::apply_on(db, scope, &patch.field, &patch.changes)?;
        if !ids.is_empty() {
            changed += 1;
            publishing_changes.push((patch.field.to_owned(), Some(ids)));
        }
    }
    for (name, value) in fields {
        if record_mode && records::is_collection(name) {
            let (did_change, ids) = records::replace_on(db, scope, name, Some(value))?;
            if did_change {
                changed += 1;
                publishing_changes.push((name.to_owned(), Some(ids)));
            }
            continue;
        }
        let payload = serde_json::to_string(value)?;
        let count = db.execute(
            "INSERT INTO workspace_field VALUES (?1, ?2, ?3)
             ON CONFLICT(scope, field) DO UPDATE SET payload = excluded.payload
             WHERE workspace_field.payload <> excluded.payload",
            params![scope, name, payload],
        )?;
        changed += count;
        if count > 0 {
            publishing_changes.push((name.to_owned(), None));
        }
    }
    for field in removed {
        if record_mode && records::is_collection(field) {
            let (did_change, ids) = records::replace_on(db, scope, field, None)?;
            if did_change {
                changed += 1;
                publishing_changes.push((field.to_owned(), Some(ids)));
            }
            continue;
        }
        let count = db.execute(
            "DELETE FROM workspace_field WHERE scope = ?1 AND field = ?2",
            params![scope, field],
        )?;
        changed += count;
        if count > 0 {
            publishing_changes.push((field.to_owned(), None));
        }
    }
    let saved = if changed > 0 || current == 0 || images_changed {
        next
    } else {
        current
    };
    if saved != current && current != 0 {
        db.execute(
            "UPDATE workspace_revision SET revision = ?2 WHERE scope = ?1",
            params![scope, saved],
        )?;
    }
    if images_changed {
        publishing_changes.push(("version".to_owned(), None));
    }
    for (field, ids) in publishing_changes {
        publishing::enqueue_on(db, scope, saved, &field, ids.as_deref())?;
    }
    Ok(saved)
}
