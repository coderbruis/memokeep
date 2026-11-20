//! Transactional projection work and crash-safe ownership evidence.
use std::collections::BTreeSet;

use rusqlite::{params, Connection};

pub(super) fn install(db: &Connection) -> rusqlite::Result<()> {
    let installed: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='markdown_publish_queue')", [], |row| row.get(0))?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS markdown_publish_queue(collection TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(collection,id));
        CREATE TABLE IF NOT EXISTS markdown_publish_intent(root TEXT NOT NULL,owner TEXT NOT NULL,path TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(root,owner,path,digest));")?;
    if !installed {
        db.execute("INSERT INTO markdown_publish_queue SELECT '*','*',coalesce((SELECT revision FROM workspace_revision WHERE scope='desktop'),0) FROM markdown_publishing WHERE slot=1 AND (pending<>0 OR published_revision IS NULL OR published_revision<>coalesce((SELECT revision FROM workspace_revision WHERE scope='desktop'),0))", [])?;
    }
    Ok(())
}

/// Called by an already-controlled workspace transaction, after a real change.
/// `None` requests a full projection; record IDs narrow document edits only.
pub fn enqueue_on(
    db: &Connection,
    scope: &str,
    revision: i64,
    field: &str,
    record_ids: Option<&[String]>,
) -> rusqlite::Result<()> {
    if scope != "desktop"
        || !matches!(
            field,
            "documents"
                | "cardDocuments"
                | "knowledgeBases"
                | "cardFolders"
                | "cardNotebooks"
                | "noteTags"
                | "version"
        )
    {
        return Ok(());
    }
    let configured: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='markdown_publishing')", [], |row| row.get(0))?;
    if !configured
        || !db.query_row(
            "SELECT EXISTS(SELECT 1 FROM markdown_publishing WHERE slot=1)",
            [],
            |row| row.get::<_, bool>(0),
        )?
    {
        return Ok(());
    }
    install(db)?;
    if matches!(field, "documents" | "cardDocuments") && record_ids.is_some() {
        for id in record_ids.into_iter().flatten() {
            db.execute("INSERT INTO markdown_publish_queue VALUES(?1,?2,?3) ON CONFLICT(collection,id) DO UPDATE SET revision=max(revision,excluded.revision)", params![field,id,revision])?;
        }
    } else {
        full_on(db, revision)?;
    }
    db.execute("UPDATE markdown_publishing SET pending=1 WHERE slot=1", [])?;
    Ok(())
}

pub(super) fn full_on(db: &Connection, revision: i64) -> rusqlite::Result<()> {
    db.execute("INSERT INTO markdown_publish_queue VALUES('*','*',?1) ON CONFLICT(collection,id) DO UPDATE SET revision=max(revision,excluded.revision)", [revision])?;
    Ok(())
}

pub(super) struct Plan {
    pub full: bool,
    pub documents: BTreeSet<String>,
    pub card_documents: BTreeSet<String>,
}

pub(super) fn plan(db: &Connection) -> rusqlite::Result<Plan> {
    let mut plan = Plan {
        full: false,
        documents: BTreeSet::new(),
        card_documents: BTreeSet::new(),
    };
    let mut query = db.prepare("SELECT collection,id FROM markdown_publish_queue")?;
    for row in query.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (collection, id) = row?;
        match collection.as_str() {
            "documents" => {
                plan.documents.insert(id);
            }
            "cardDocuments" => {
                plan.card_documents.insert(id);
            }
            _ => plan.full = true,
        }
    }
    Ok(plan)
}

pub(super) fn intended(
    db: &Connection,
    root: &str,
    owner: &str,
    path: &str,
    digest: &str,
) -> rusqlite::Result<bool> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM markdown_publish_intent WHERE root=?1 AND owner=?2 AND path=?3 AND digest=?4)", params![root,owner,path,digest], |row| row.get(0))
}

pub(super) fn intent(
    db: &Connection,
    root: &str,
    owner: &str,
    path: &str,
    digest: &str,
) -> rusqlite::Result<()> {
    db.execute(
        "INSERT OR IGNORE INTO markdown_publish_intent VALUES(?1,?2,?3,?4)",
        params![root, owner, path, digest],
    )?;
    Ok(())
}
