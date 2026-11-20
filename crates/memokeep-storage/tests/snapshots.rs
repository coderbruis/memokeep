use std::{error::Error, fs, sync::Barrier, thread};

use memokeep_storage::{
    images, initialize, read, read_fields, write, write_fields, Fields, StorageError,
};
use serde_json::json;

#[test]
fn persistent_snapshots_preserve_null_unknown_fields_and_array_order() -> Result<(), Box<dyn Error>>
{
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("store.sqlite");
    initialize(&path)?;
    assert_eq!(read(&path, "desktop")?.revision, 0);
    let data: Fields =
        serde_json::from_value(json!({"notes":[{"id":"b"},{"id":"a"}], "extension":null}))?;
    assert_eq!(write(&path, "desktop", 0, &data)?, 1);
    initialize(&path)?;
    assert_eq!(read(&path, "desktop")?.data, data);
    assert_eq!(write(&path, "desktop", 1, &data)?, 1);
    assert!(read(&path, "mobile")?.data.is_empty());
    assert_eq!(write(&path, "desktop", 1, &Fields::new())?, 2);
    assert!(read(&path, "desktop")?.data.is_empty());
    fs::remove_file(&path)?;
    assert!(read(&path, "desktop").is_err());
    assert!(!path.exists());
    Ok(())
}

#[test]
fn competing_writes_conflict_without_losing_the_committed_snapshot() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("store.sqlite");
    initialize(&path)?;
    let gate = Barrier::new(2);
    let candidates = [
        Fields::from_iter([("note".into(), json!("a"))]),
        Fields::from_iter([("note".into(), json!("b"))]),
    ];
    let results = thread::scope(|scope| {
        let writes = candidates
            .iter()
            .map(|candidate| {
                let path = path.as_path();
                let gate = &gate;
                scope.spawn(move || {
                    gate.wait();
                    write(path, "desktop", 0, candidate)
                })
            })
            .collect::<Vec<_>>();
        writes
            .into_iter()
            .map(|child| child.join())
            .collect::<Vec<_>>()
    });
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Ok(Ok(1))))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Ok(Err(StorageError::StaleRevision))))
            .count(),
        1
    );
    let saved = read(&path, "desktop")?;
    assert_eq!(saved.revision, 1);
    assert!(candidates.contains(&saved.data));
    Ok(())
}

#[test]
fn selective_writes_preserve_unrelated_fields_and_reject_stale_or_invalid_changes(
) -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("store.sqlite");
    initialize(&path)?;
    let initial =
        serde_json::from_value(json!({"documents":[{"id":"a"}],"removeMe":true,"plans":[]}))?;
    let first = write(&path, "desktop", 0, &initial)?;
    let updated = Fields::from_iter([("documents".into(), json!(null))]);
    let removed = ["removeMe".into()];
    let second = write_fields(&path, "desktop", first, &updated, &removed)?;
    assert!(second > first);
    let selected = read_fields(&path, "desktop", &["documents".into(), "removeMe".into()])?;
    assert_eq!(selected.revision, second);
    assert_eq!(selected.data, updated);
    assert_eq!(read(&path, "desktop")?.data["plans"], json!([]));
    assert!(matches!(
        write_fields(&path, "desktop", first, &Fields::new(), &["plans".into()]),
        Err(StorageError::StaleRevision)
    ));
    assert!(matches!(
        write_fields(&path, "desktop", second, &updated, &["documents".into()]),
        Err(StorageError::InvalidField)
    ));
    assert_eq!(
        write_fields(&path, "desktop", second, &updated, &removed)?,
        second
    );
    Ok(())
}

#[test]
fn unknown_schema_and_invalid_fields_do_not_overwrite_data() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("store.sqlite");
    initialize(&path)?;
    let invalid = Fields::from_iter([("__proto__".into(), json!("bad"))]);
    assert!(matches!(
        write(&path, "desktop", 0, &invalid),
        Err(StorageError::InvalidField)
    ));
    assert_eq!(read(&path, "desktop")?.revision, 0);
    rusqlite::Connection::open(&path)?.pragma_update(None, "user_version", 99)?;
    assert!(matches!(
        initialize(&path),
        Err(StorageError::UnsupportedSchema(99))
    ));
    assert!(matches!(
        read(&path, "desktop"),
        Err(StorageError::UnsupportedSchema(99))
    ));
    Ok(())
}

#[test]
fn failed_write_rolls_back_earlier_fields_and_revision() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("store.sqlite");
    initialize(&path)?;
    let initial = Fields::from_iter([("a".into(), json!(1))]);
    let revision = write(&path, "desktop", 0, &initial)?;
    rusqlite::Connection::open(&path)?.execute_batch(
        "CREATE TRIGGER fail_test BEFORE INSERT ON workspace_field
         WHEN new.field = 'z' BEGIN SELECT raise(ABORT, 'test failure'); END;",
    )?;
    let updated = Fields::from_iter([("a".into(), json!(2)), ("z".into(), json!(3))]);
    assert!(matches!(
        write(&path, "desktop", revision, &updated),
        Err(StorageError::Sql(_))
    ));
    let snapshot = read(&path, "desktop")?;
    assert_eq!(snapshot.revision, revision);
    assert_eq!(snapshot.data, initial);
    Ok(())
}

#[test]
fn image_schema_upgrades_and_keeps_images_referenced_by_note_history() -> Result<(), Box<dyn Error>>
{
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("store.sqlite");
    rusqlite::Connection::open(&path)?.execute_batch(
        "CREATE TABLE workspace_revision(scope TEXT PRIMARY KEY, revision INTEGER NOT NULL);
         CREATE TABLE workspace_field(scope TEXT NOT NULL REFERENCES workspace_revision(scope),
            field TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(scope,field));
         INSERT INTO workspace_revision VALUES('desktop',1);
         INSERT INTO workspace_field VALUES('desktop','note','\"original\"');
         PRAGMA user_version=1;",
    )?;
    initialize(&path)?;
    assert_eq!(read(&path, "desktop")?.data["note"], "original");

    let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDeQAAAAASUVORK5CYII=";
    let image = serde_json::to_value(images::save(&path, png, "../test.png")?)?;
    let id = image["id"].as_str().ok_or("missing image ID")?;
    assert_eq!(image["name"], "test.png");
    let reference = image["reference"]
        .as_str()
        .ok_or("missing image reference")?;
    let referenced = Fields::from_iter([("history".into(), json!([{"body":reference}]))]);
    write(&path, "desktop", 1, &referenced)?;
    assert!(!images::delete_unreferenced(&path, id)?);
    let saved = serde_json::to_value(images::read(&path, id)?)?;
    assert_eq!(saved["dataUrl"], format!("data:image/png;base64,{png}"));
    write(&path, "desktop", 2, &Fields::new())?;
    assert!(images::delete_unreferenced(&path, id)?);
    assert!(images::read(&path, id)?.is_none());
    assert!(matches!(
        images::read(&path, "../invalid"),
        Err(StorageError::InvalidImageId)
    ));
    assert!(matches!(
        images::save(&path, "YWJj", "fake.png"),
        Err(StorageError::UnsupportedImage)
    ));
    Ok(())
}
