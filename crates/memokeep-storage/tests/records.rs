use memokeep_storage::{initialize, read, read_records_on, records, write, Fields, StorageError};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{error::Error, time::Instant};

fn fixture() -> Result<(tempfile::TempDir, std::path::PathBuf), Box<dyn Error>> {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("isolated.sqlite");
    initialize(&path)?;
    let fields: Fields = serde_json::from_value(
        json!({"documents":[{"id":"b","title":"B","content":"body-b","updatedAt":"2026-11-19T12:00:00Z"},{"id":"a","title":"A","content":"body-a","updatedAt":"2026-11-18T12:00:00Z"}],"cardDocuments":[],"unknown":{"keep":true}}),
    )?;
    write(&path, "desktop", 0, &fields)?;
    Ok((directory, path))
}
fn patch(id: &str, value: Option<Value>) -> Vec<records::CollectionPatch> {
    vec![records::CollectionPatch {
        field: "documents".into(),
        changes: vec![records::RecordChange {
            id: id.into(),
            value,
        }],
    }]
}

#[test]
fn activation_is_explicit_preserves_snapshot_and_compatibility_writers_share_the_record_truth(
) -> Result<(), Box<dyn Error>> {
    let (_directory, path) = fixture()?;
    let before = read(&path, "desktop")?;
    let version = |path: &std::path::Path| -> rusqlite::Result<i64> {
        Connection::open(path)?.query_row("PRAGMA user_version", [], |row| row.get(0))
    };
    assert_eq!(version(&path)?, 3);
    initialize(&path)?;
    assert_eq!(
        version(&path)?,
        3,
        "opening a v3 workspace cannot activate records"
    );
    assert!(!records::enabled(&path, "desktop")?);
    assert!(matches!(
        records::activate(&path, "desktop", 0),
        Err(StorageError::StaleRevision)
    ));
    assert_eq!(records::activate(&path, "desktop", 1)?, 1);
    assert_eq!(version(&path)?, 4);
    let old_reader_accepts = matches!(version(&path)?, 0..=3);
    assert!(
        !old_reader_accepts,
        "v3 readers must reject the new SQLite schema before reading removed arrays"
    );
    initialize(&path)?;
    assert_eq!(version(&path)?, 4);
    assert_eq!(read(&path, "desktop")?.data, before.data);
    let db = Connection::open(&path)?;
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM workspace_field WHERE field='documents'",
            [],
            |r| r.get::<_, usize>(0)
        )?,
        0
    );
    let mut changed = before.data;
    changed["documents"]
        .as_array_mut()
        .ok_or("array")?
        .reverse();
    changed["documents"][0]["title"] = json!("compat changed");
    assert_eq!(write(&path, "desktop", 1, &changed)?, 2);
    assert_eq!(read(&path, "desktop")?.data, changed);
    assert_eq!(
        read_records_on(&db, "desktop", "documents", &["a".into()])?[0]["title"],
        "compat changed"
    );
    Ok(())
}

#[test]
fn a_single_record_write_does_not_update_unrelated_rows_and_is_atomic_and_revision_checked(
) -> Result<(), Box<dyn Error>> {
    let (_directory, path) = fixture()?;
    records::activate(&path, "desktop", 1)?;
    let mut db = Connection::open(&path)?;
    db.execute_batch("CREATE TABLE writes(id TEXT);CREATE TRIGGER count_writes AFTER UPDATE ON workspace_record BEGIN INSERT INTO writes VALUES(NEW.id);END;")?;
    let changes = patch(
        "b",
        Some(json!({"id":"b","title":"edited","content":"one"})),
    );
    assert_eq!(
        records::write(&path, "desktop", 1, &changes, &Fields::new(), &[])?,
        2
    );
    assert_eq!(
        db.query_row("SELECT group_concat(id) FROM writes", [], |r| r
            .get::<_, String>(0))?,
        "b"
    );
    assert_eq!(
        records::write(&path, "desktop", 2, &changes, &Fields::new(), &[])?,
        2
    );
    assert!(matches!(
        records::write(&path, "desktop", 1, &changes, &Fields::new(), &[]),
        Err(StorageError::StaleRevision)
    ));
    let tx = db.transaction()?;
    memokeep_storage::write_records_on(&tx, "desktop", 2, &patch("a", None), &Fields::new(), &[])?;
    tx.rollback()?;
    assert_eq!(
        read(&path, "desktop")?.data["documents"]
            .as_array()
            .ok_or("array")?
            .len(),
        2
    );
    assert_eq!(read(&path, "desktop")?.revision, 2);
    Ok(())
}

#[test]
fn summaries_are_paged_without_bodies_and_get_uses_only_requested_ids() -> Result<(), Box<dyn Error>>
{
    let (_directory, path) = fixture()?;
    records::activate(&path, "desktop", 1)?;
    let page = records::summaries(&path, "desktop", "documents", 0, 1)?;
    assert_eq!(page.total, 2);
    assert_eq!(page.next_offset, Some(1));
    assert_eq!(page.rows[0]["id"], "b");
    assert!(!serde_json::to_string(&page)?.contains("body-b"));
    let page = records::summaries(&path, "desktop", "documents", 1, 1)?;
    assert_eq!(page.rows[0]["id"], "a");
    assert_eq!(page.next_offset, None);
    let result = records::read_set(&path, "desktop", &patch("a", None))?;
    assert_eq!(result.data["documents"].as_array().ok_or("array")?.len(), 1);
    assert_eq!(result.data["documents"][0]["content"], "body-a");
    Ok(())
}

#[test]
fn invalid_activation_rolls_back_the_optional_schema_and_record_deletion_retains_field_presence(
) -> Result<(), Box<dyn Error>> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("synthetic.sqlite");
    initialize(&path)?;
    let invalid: Fields =
        serde_json::from_value(json!({"documents":[{"id":"same"},{"id":"same"}]}))?;
    write(&path, "desktop", 0, &invalid)?;
    assert!(records::activate(&path, "desktop", 1).is_err());
    assert!(!records::enabled(&path, "desktop")?);
    assert_eq!(
        Connection::open(&path)?
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?,
        3
    );
    assert_eq!(read(&path, "desktop")?.data, invalid);
    let (_directory, path) = fixture()?;
    records::activate(&path, "desktop", 1)?;
    records::write(&path, "desktop", 1, &patch("a", None), &Fields::new(), &[])?;
    records::write(&path, "desktop", 2, &patch("b", None), &Fields::new(), &[])?;
    assert_eq!(read(&path, "desktop")?.data["documents"], json!([]));
    Ok(())
}

#[test]
fn record_backed_history_keeps_its_referenced_attachment_until_the_record_is_removed(
) -> Result<(), Box<dyn Error>> {
    let (_directory, path) = fixture()?;
    let id = uuid::Uuid::new_v4().to_string();
    let db = Connection::open(&path)?;
    db.execute(
        "INSERT INTO note_image VALUES(?1,?2)",
        params![id, b"\x89PNG\r\n\x1a\n".as_slice()],
    )?;
    records::activate(&path, "desktop", 1)?;
    records::write(
        &path,
        "desktop",
        1,
        &patch(
            "a",
            Some(
                json!({"id":"a","metadata":{"versions":[{"noteContent":format!("<img src=\"memokeep-image://{id}\">")}]}}),
            ),
        ),
        &Fields::new(),
        &[],
    )?;
    assert!(!memokeep_storage::images::delete_unreferenced(&path, &id)?);
    records::write(&path, "desktop", 2, &patch("a", None), &Fields::new(), &[])?;
    assert!(memokeep_storage::images::delete_unreferenced(&path, &id)?);
    Ok(())
}

#[test]
fn unsupported_or_incomplete_record_layout_never_silently_hides_the_notes(
) -> Result<(), Box<dyn Error>> {
    let (_directory, path) = fixture()?;
    records::activate(&path, "desktop", 1)?;
    let db = Connection::open(&path)?;
    db.execute("UPDATE workspace_record_mode SET version=2", [])?;
    assert!(matches!(
        read(&path, "desktop"),
        Err(StorageError::UnsupportedRecordSchema(2))
    ));
    db.execute("UPDATE workspace_record_mode SET version=1", [])?;
    db.execute(
        "DELETE FROM workspace_record_collection WHERE field='documents'",
        [],
    )?;
    assert!(matches!(
        read(&path, "desktop"),
        Err(StorageError::InvalidRecord)
    ));
    assert_eq!(
        db.query_row("SELECT count(*) FROM workspace_record", [], |r| r
            .get::<_, usize>(0))?,
        2
    );
    Ok(())
}

#[test]
fn record_and_related_field_changes_roll_back_together_on_a_failed_related_write(
) -> Result<(), Box<dyn Error>> {
    let (_directory, path) = fixture()?;
    records::activate(&path, "desktop", 1)?;
    let before = read(&path, "desktop")?;
    let db = Connection::open(&path)?;
    db.execute_batch("CREATE TRIGGER reject_related BEFORE INSERT ON workspace_field WHEN NEW.field='settings' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;")?;
    let updated = Fields::from_iter([("settings".into(), json!({"changed":true}))]);
    assert!(records::write(
        &path,
        "desktop",
        1,
        &patch("a", Some(json!({"id":"a","title":"must rollback"}))),
        &updated,
        &[]
    )
    .is_err());
    let after = read(&path, "desktop")?;
    assert_eq!(after.revision, before.revision);
    assert_eq!(after.data, before.data);
    Ok(())
}

#[test]
#[ignore = "explicit synthetic 1k/10k performance measurement"]
fn synthetic_record_storage_benchmark() -> Result<(), Box<dyn Error>> {
    for count in [1000usize, 10000] {
        let dir = tempfile::tempdir()?;
        let legacy = dir.path().join("legacy.sqlite");
        let record = dir.path().join("record.sqlite");
        initialize(&legacy)?;
        initialize(&record)?;
        let body = "合成笔记正文，不是真实数据。".repeat(160);
        let data: Fields = serde_json::from_value(
            json!({"documents":(0..count).map(|i|json!({"id":format!("note-{i}"),"title":format!("笔记{i}"),"content":body,"metadata":{"noteContent":"<p>synthetic</p>"}})).collect::<Vec<_>>(),"cardDocuments":[]}),
        )?;
        write(&legacy, "desktop", 0, &data)?;
        write(&record, "desktop", 0, &data)?;
        records::activate(&record, "desktop", 1)?;
        let mut legacy_times = Vec::new();
        let mut record_times = Vec::new();
        let mut old_bytes = 0;
        let mut new_bytes = 0;
        for run in 0..5 {
            let timer = Instant::now();
            let mut snapshot = read(&legacy, "desktop")?;
            snapshot.data["documents"][0]["title"] = json!(format!("edit-{run}"));
            write(&legacy, "desktop", snapshot.revision, &snapshot.data)?;
            legacy_times.push(timer.elapsed().as_micros());
            old_bytes = serde_json::to_vec(&snapshot.data)?.len();
            let timer = Instant::now();
            let selected = records::read_set(&record, "desktop", &patch("note-0", None))?;
            let mut value = selected.data["documents"]
                .as_array()
                .and_then(|rows| rows.first())
                .ok_or("missing synthetic note")?
                .to_owned();
            value["title"] = json!(format!("edit-{run}"));
            let change = patch("note-0", Some(value));
            records::write(
                &record,
                "desktop",
                selected.revision,
                &change,
                &Fields::new(),
                &[],
            )?;
            record_times.push(timer.elapsed().as_micros());
            new_bytes = serde_json::to_vec(&change)?.len();
        }
        legacy_times.sort();
        record_times.sort();
        println!(
            "{}",
            json!({"notes":count,"snapshotPayloadBytes":old_bytes,"recordPayloadBytes":new_bytes,"snapshotSaveMedianUs":legacy_times[2],"recordSaveMedianUs":record_times[2],"samples":5})
        );
        let db = Connection::open(&record)?;
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM workspace_record WHERE scope=?1",
                params!["desktop"],
                |r| r.get::<_, usize>(0)
            )?,
            count
        );
    }
    Ok(())
}

#[test]
fn portable_backup_restore_and_undo_preserve_the_v4_record_layout() -> Result<(), Box<dyn Error>> {
    let (directory, path) = fixture()?;
    memokeep_storage::write_fields(
        &path,
        "desktop",
        1,
        &Fields::from_iter([("cards".into(), json!([])), ("version".into(), json!(2))]),
        &[],
    )?;
    records::activate(&path, "desktop", 2)?;
    let portable = directory.path().join("synthetic-backup.json");
    memokeep_storage::backup::export(&path, &portable)?;
    records::write(
        &path,
        "desktop",
        2,
        &patch("a", Some(json!({"id":"a","title":"before restore"}))),
        &Fields::new(),
        &[],
    )?;
    let preview = memokeep_storage::backup::preview(&path, &portable)?;
    memokeep_storage::backup::apply_preview(&path, &preview.token)?;
    assert_eq!(
        read_records_on(
            &Connection::open(&path)?,
            "desktop",
            "documents",
            &["a".into()]
        )?[0]["title"],
        "A"
    );
    assert!(records::enabled(&path, "desktop")?);
    memokeep_storage::backup::undo(&path)?;
    let db = Connection::open(&path)?;
    assert_eq!(
        read_records_on(&db, "desktop", "documents", &["a".into()])?[0]["title"],
        "before restore"
    );
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?,
        4
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM workspace_field WHERE field='documents'",
            [],
            |row| row.get::<_, usize>(0)
        )?,
        0
    );
    Ok(())
}
