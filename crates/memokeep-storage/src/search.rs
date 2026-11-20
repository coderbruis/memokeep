use std::{collections::BTreeSet, path::Path};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::{connect, revision, StorageError};

const SCOPE: &str = "desktop";

pub(crate) fn install(db: &Connection) -> Result<(), StorageError> {
    db.execute_batch(
        "CREATE TABLE desktop_search_revision (slot INTEGER PRIMARY KEY CHECK (slot=1), revision INTEGER NOT NULL);
         CREATE TABLE desktop_search_entry (
             kind TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
             position INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(kind,id)
         );
         CREATE VIRTUAL TABLE desktop_search_trigram USING fts5(body, content='desktop_search_entry', content_rowid='rowid', tokenize='trigram');
         CREATE TRIGGER desktop_search_added AFTER INSERT ON desktop_search_entry BEGIN
             INSERT INTO desktop_search_trigram(rowid, body) VALUES(new.rowid, new.body);
         END;
         CREATE TRIGGER desktop_search_removed AFTER DELETE ON desktop_search_entry BEGIN
             INSERT INTO desktop_search_trigram(desktop_search_trigram, rowid, body) VALUES('delete', old.rowid, old.body);
         END;
         CREATE TRIGGER desktop_search_changed AFTER UPDATE OF body ON desktop_search_entry WHEN old.body <> new.body BEGIN
             INSERT INTO desktop_search_trigram(desktop_search_trigram, rowid, body) VALUES('delete', old.rowid, old.body);
             INSERT INTO desktop_search_trigram(rowid, body) VALUES(new.rowid, new.body);
         END;",
    )?;
    Ok(())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub text: String,
    pub normalized_title: String,
    pub normalized_body: String,
    pub label: String,
    pub path: String,
    pub excerpt: Option<String>,
}

fn indexed_revision(db: &Connection) -> Result<Option<i64>, StorageError> {
    Ok(db
        .query_row(
            "SELECT revision FROM desktop_search_revision WHERE slot=1",
            [],
            |row| row.get(0),
        )
        .optional()?)
}

pub fn update(path: &Path, expected: i64, entries: &[Entry]) -> Result<(), StorageError> {
    let mut db = connect(path)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if revision(&tx, SCOPE)? != expected {
        return Err(StorageError::StaleRevision);
    }
    if indexed_revision(&tx)? == Some(expected) {
        return Ok(());
    }
    let mut incoming = BTreeSet::new();
    {
        let mut change = tx.prepare(
            "INSERT INTO desktop_search_entry(kind,id,title,body,position,payload) VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(kind,id) DO UPDATE SET title=excluded.title,body=excluded.body,
                 position=excluded.position,payload=excluded.payload
             WHERE position<>excluded.position OR payload<>excluded.payload",
        )?;
        for (position, entry) in entries.iter().enumerate() {
            if !matches!(entry.kind.as_str(), "note" | "notebook" | "card" | "memo")
                || entry.id.is_empty()
                || !incoming.insert((entry.kind.as_str(), entry.id.as_str()))
            {
                return Err(StorageError::InvalidField);
            }
            change.execute(params![
                entry.kind,
                entry.id,
                entry.normalized_title,
                entry.normalized_body,
                position,
                serde_json::to_string(entry)?
            ])?;
        }
    }
    let previous = {
        let mut query = tx.prepare("SELECT kind,id FROM desktop_search_entry")?;
        let keys = query.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        keys.collect::<Result<Vec<_>, _>>()?
    };
    for (kind, id) in previous {
        if !incoming.contains(&(kind.as_str(), id.as_str())) {
            tx.execute(
                "DELETE FROM desktop_search_entry WHERE kind=?1 AND id=?2",
                params![kind, id],
            )?;
        }
    }
    tx.execute(
        "INSERT OR REPLACE INTO desktop_search_revision VALUES(1,?1)",
        [expected],
    )?;
    tx.commit()?;
    Ok(())
}

/// Short Chinese terms use the exact substring matcher, including two-character words.
pub fn query(path: &Path, terms: &[String]) -> Result<Option<Vec<Entry>>, StorageError> {
    let mut db = connect(path)?;
    let tx = db.transaction()?;
    if indexed_revision(&tx)? != Some(revision(&tx, SCOPE)?) {
        return Ok(None);
    }
    if terms.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let phrase = terms
        .iter()
        .find(|term| term.chars().take(3).count() == 3 && !term.contains('\0'))
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")));
    let entries = {
        let mut sql = String::from(
            "SELECT payload FROM desktop_search_entry WHERE NOT EXISTS
             (SELECT 1 FROM json_each(?1) WHERE instr(body, value)=0)",
        );
        if phrase.is_some() {
            sql.push_str(" AND rowid IN (SELECT rowid FROM desktop_search_trigram WHERE desktop_search_trigram MATCH ?2)");
        }
        sql.push_str(" ORDER BY (SELECT sum(CASE WHEN title=value THEN 0 WHEN instr(title,value)>0 THEN 1 ELSE 3 END)
                      FROM json_each(?1)), position LIMIT 50");
        let terms = serde_json::to_string(terms)?;
        let mut query = tx.prepare(&sql)?;
        let mut rows = if let Some(phrase) = phrase {
            query.query(params![terms, phrase])?
        } else {
            query.query([terms])?
        };
        let mut entries = Vec::new();
        while let Some(row) = rows.next()? {
            let payload: String = row.get(0)?;
            entries.push(serde_json::from_str(&payload)?);
        }
        entries
    };
    tx.commit()?;
    Ok(Some(entries))
}
