use std::{error::Error, fs, path::Path};

use memokeep_storage::{
    backup::{
        self, Attachment, BackupError, BackupExtension, CaptureKind, ExtensionSnapshot,
        ExtensionSummary,
    },
    initialize, read, write, Fields,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

struct FixtureExtension;
impl BackupExtension for FixtureExtension {
    fn namespace(&self) -> &'static str {
        "fixture.attachments"
    }
    fn capture(
        &self,
        db: &Connection,
        _data: &Fields,
        _kind: CaptureKind,
    ) -> Result<ExtensionSnapshot, BackupError> {
        assert!(
            !db.is_autocommit(),
            "attachment capture must share the snapshot transaction"
        );
        let bytes: Vec<u8> = db
            .query_row(
                "SELECT payload FROM fixture_blob WHERE id='one'",
                [],
                |row| row.get(0),
            )
            .map_err(memokeep_storage::StorageError::from)?;
        Ok(ExtensionSnapshot {
            metadata: json!({"version":1}),
            attachments: vec![Attachment {
                id: "one".into(),
                mime_type: "application/octet-stream".into(),
                bytes,
            }],
        })
    }
    fn prepare(
        &self,
        _db: &Connection,
        _data: &Fields,
        snapshot: Option<&ExtensionSnapshot>,
    ) -> Result<ExtensionSummary, BackupError> {
        if snapshot.is_none() {
            return Err(BackupError::Extension(
                "required fixture attachment missing".into(),
            ));
        }
        Ok(ExtensionSummary {
            label: "Fixture attachment".into(),
            attachments: 1,
            ..Default::default()
        })
    }
    fn restore(
        &self,
        db: &Connection,
        _before: &Fields,
        _after: &Fields,
        snapshot: Option<&ExtensionSnapshot>,
    ) -> Result<(), BackupError> {
        assert!(
            !db.is_autocommit(),
            "attachments must restore inside the business transaction"
        );
        let snapshot = snapshot.ok_or_else(|| BackupError::Extension("missing fixture".into()))?;
        db.execute(
            "UPDATE fixture_blob SET payload=?1 WHERE id='one'",
            params![snapshot.attachments[0].bytes],
        )
        .map_err(memokeep_storage::StorageError::from)?;
        Ok(())
    }
}

fn workspace(root: &Path, name: &str, bytes: &[u8]) -> Result<std::path::PathBuf, Box<dyn Error>> {
    let directory = root.join(name);
    fs::create_dir(&directory)?;
    let database = directory.join("workspace.sqlite3");
    initialize(&database)?;
    let data: Fields = serde_json::from_value(
        json!({"version":2,"documents":[{"id":name}],"cards":[],"settings":{"knowledgeStoragePath":""}}),
    )?;
    write(&database, "desktop", 0, &data)?;
    let db = Connection::open(&database)?;
    db.execute_batch("CREATE TABLE fixture_blob(id TEXT PRIMARY KEY,payload BLOB NOT NULL)")?;
    db.execute("INSERT INTO fixture_blob VALUES('one',?1)", [bytes])?;
    Ok(database)
}
fn bytes(database: &Path) -> Result<Vec<u8>, Box<dyn Error>> {
    Ok(Connection::open(database)?.query_row(
        "SELECT payload FROM fixture_blob WHERE id='one'",
        [],
        |row| row.get(0),
    )?)
}

#[test]
fn optional_provider_roundtrip_is_atomic_and_unknown_provider_never_silently_drops_bytes(
) -> Result<(), Box<dyn Error>> {
    let root = tempfile::tempdir()?;
    let source = workspace(root.path(), "source", b"original attachment")?;
    let target = workspace(root.path(), "target", b"target attachment")?;
    let file = root.path().join("portable.json");
    let extensions: &[&dyn BackupExtension] = &[&FixtureExtension];
    backup::register_extension(&Connection::open(&source)?, "fixture.attachments")?;
    assert!(matches!(
        backup::export(&source, &file),
        Err(BackupError::UnsupportedExtension(_))
    ));
    backup::export_with_extensions(&source, &file, extensions)?;
    let portable: Value = serde_json::from_slice(&fs::read(&file)?)?;
    assert_eq!(portable["backup"]["version"], 2);
    assert!(matches!(
        backup::preview(&target, &file),
        Err(BackupError::UnsupportedExtension(_))
    ));
    let preview = backup::preview_with_extensions(&target, &file, extensions)?;
    let initial = read(&target, "desktop")?;
    assert!(backup::apply_preview_with_extensions_and_commit(
        &target,
        &preview.token,
        extensions,
        |_, _, _| Err("synthetic ledger failure".into())
    )
    .is_err());
    assert_eq!(read(&target, "desktop")?.revision, initial.revision);
    assert_eq!(read(&target, "desktop")?.data, initial.data);
    assert_eq!(bytes(&target)?, b"target attachment");
    backup::apply_preview_with_extensions(&target, &preview.token, extensions)?;
    assert_eq!(bytes(&target)?, b"original attachment");
    assert!(backup::can_undo_with_extensions(&target, extensions)?);
    backup::undo_with_extensions(&target, extensions)?;
    assert_eq!(bytes(&target)?, b"target attachment");
    Ok(())
}

#[test]
fn corrupt_extensions_are_rejected_before_preview_or_target_changes() -> Result<(), Box<dyn Error>>
{
    let root = tempfile::tempdir()?;
    let source = workspace(root.path(), "source", b"payload")?;
    let target = workspace(root.path(), "target", b"keep")?;
    let file = root.path().join("backup.json");
    let extensions: &[&dyn BackupExtension] = &[&FixtureExtension];
    backup::export_with_extensions(&source, &file, extensions)?;
    let original: Value = serde_json::from_slice(&fs::read(&file)?)?;
    for field in ["sha256", "id", "size", "duplicate"] {
        // Each independent corruption case needs an owned backup document.
        let mut altered = original.clone();
        let attachments =
            &mut altered["backup"]["extensions"]["fixture.attachments"]["attachments"];
        match field {
            "sha256" => attachments[0]["sha256"] = json!("0".repeat(64)),
            "id" => attachments[0]["id"] = json!("../not-a-local-id"),
            "size" => attachments[0]["size"] = json!(999),
            _ => {
                let duplicate = attachments[0].to_owned();
                attachments
                    .as_array_mut()
                    .ok_or("attachment array missing")?
                    .push(duplicate);
            }
        }
        fs::write(&file, serde_json::to_vec(&altered)?)?;
        assert!(
            backup::preview_with_extensions(&target, &file, extensions).is_err(),
            "{field}"
        );
        assert_eq!(bytes(&target)?, b"keep");
        assert_eq!(read(&target, "desktop")?.revision, 1);
    }
    Ok(())
}

#[test]
fn attachment_only_changes_invalidate_restore_undo_even_without_business_revision_change(
) -> Result<(), Box<dyn Error>> {
    let root = tempfile::tempdir()?;
    let source = workspace(root.path(), "source", b"incoming")?;
    let target = workspace(root.path(), "target", b"before")?;
    let file = root.path().join("backup.json");
    let extensions: &[&dyn BackupExtension] = &[&FixtureExtension];
    backup::export_with_extensions(&source, &file, extensions)?;
    let preview = backup::preview_with_extensions(&target, &file, extensions)?;
    backup::apply_preview_with_extensions(&target, &preview.token, extensions)?;
    Connection::open(&target)?.execute(
        "UPDATE fixture_blob SET payload=?1 WHERE id='one'",
        [b"new independent bytes".as_slice()],
    )?;
    assert!(!backup::can_undo_with_extensions(&target, extensions)?);
    assert!(matches!(
        backup::undo_with_extensions(&target, extensions),
        Err(BackupError::CannotUndo)
    ));
    assert_eq!(bytes(&target)?, b"new independent bytes");
    Ok(())
}

#[test]
fn attachment_only_changes_after_preview_require_a_new_preview() -> Result<(), Box<dyn Error>> {
    let root = tempfile::tempdir()?;
    let source = workspace(root.path(), "source", b"incoming")?;
    let target = workspace(root.path(), "target", b"before")?;
    let file = root.path().join("backup.json");
    let extensions: &[&dyn BackupExtension] = &[&FixtureExtension];
    backup::export_with_extensions(&source, &file, extensions)?;
    let preview = backup::preview_with_extensions(&target, &file, extensions)?;
    Connection::open(&target)?.execute(
        "UPDATE fixture_blob SET payload=?1 WHERE id='one'",
        [b"changed after preview".as_slice()],
    )?;
    assert!(matches!(
        backup::apply_preview_with_extensions(&target, &preview.token, extensions),
        Err(BackupError::Storage(
            memokeep_storage::StorageError::StaleRevision
        ))
    ));
    assert_eq!(bytes(&target)?, b"changed after preview");
    assert_eq!(read(&target, "desktop")?.revision, 1);
    Ok(())
}

#[test]
fn first_restore_can_be_undone_to_a_logical_empty_workspace_without_resetting_revision(
) -> Result<(), Box<dyn Error>> {
    let root = tempfile::tempdir()?;
    let source = root.path().join("source.sqlite3");
    let empty = root.path().join("empty.sqlite3");
    initialize(&source)?;
    initialize(&empty)?;
    let data: Fields = serde_json::from_value(
        json!({"version":2,"documents":[{"id":"first"}],"cards":[],"settings":{"knowledgeStoragePath":""}}),
    )?;
    write(&source, "desktop", 0, &data)?;
    let file = root.path().join("backup.json");
    backup::export(&source, &file)?;
    assert!(matches!(
        backup::export(&empty, &root.path().join("not-a-real-backup.json")),
        Err(BackupError::EmptyWorkspace)
    ));
    let preview = backup::preview(&empty, &file)?;
    backup::apply_preview(&empty, &preview.token)?;
    assert_eq!(read(&empty, "desktop")?.revision, 1);
    assert!(backup::can_undo(&empty)?);
    backup::undo(&empty)?;
    let restored = read(&empty, "desktop")?;
    assert_eq!(restored.revision, 2);
    assert_eq!(restored.data["documents"], json!([]));
    assert_eq!(restored.data["cards"], json!([]));
    assert!(!backup::can_undo(&empty)?);
    let malformed = root.path().join("malformed.json");
    fs::write(&malformed,br#"{"version":2,"backup":{"format":"MemoKeep","version":2,"mediaIncluded":true,"media":[],"extensions":{}}}"#)?;
    assert!(matches!(
        backup::preview(&empty, &malformed),
        Err(BackupError::Format)
    ));
    assert_eq!(read(&empty, "desktop")?.revision, 2);
    Ok(())
}
