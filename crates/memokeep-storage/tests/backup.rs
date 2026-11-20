use std::{error::Error, fs, path::Path};

use base64::{engine::general_purpose::STANDARD, Engine};
use memokeep_storage::{backup, images, initialize, read, write, Fields, StorageError};
use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const IMAGE_ID: &str = "8aad3c9a-37a8-4024-8460-eb661ced70e4";
const PNG: &[u8] = b"\x89PNG\r\n\x1a\nsynthetic";

fn fixture() -> Value {
    json!({
        "version": 2,
        "knowledgeBases": [{ "id": "library" }],
        "documents": [{ "id": "note", "metadata": {
            "versions": [{ "noteContent": format!("memokeep-image://{}", IMAGE_ID.to_ascii_uppercase()) }]
        } }],
        "cards": [{ "id": "card", "imageOcclusion": { "reference": format!("memokeep-image://{IMAGE_ID}") } }],
        "settings": { "knowledgeStoragePath": "/outside", "noteTheme": "blue" },
        "backup": { "version": 1, "format": "MemoKeep", "mediaIncluded": true, "media": [{
            "id": IMAGE_ID, "mimeType": "image/png", "data": STANDARD.encode(PNG),
            "sha256": format!("{:x}", Sha256::digest(PNG))
        }] }
    })
}

fn put(file: &Path, data: &Value) -> Result<(), Box<dyn Error>> {
    Ok(fs::write(file, serde_json::to_vec(data)?)?)
}

#[test]
fn backs_up_and_restores_history_image_and_workspace_without_repointing_storage(
) -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let source = temp.path().join("electron.json");
    let database = temp.path().join("workspace.sqlite");
    let backup_file = temp.path().join("tauri.json");
    let copy = temp.path().join("restored.sqlite");
    put(&source, &fixture())?;
    initialize(&database)?;
    let report = backup::restore(&database, &source, 0)?;
    assert_eq!((report.notes, report.cards, report.images), (1, 1, 1));
    assert_eq!(
        read(&database, "desktop")?.data["settings"]["knowledgeStoragePath"],
        ""
    );
    assert!(images::read(&database, IMAGE_ID)?.is_some());
    assert_eq!(backup::export(&database, &backup_file)?.images, 1);
    assert!(backup::export(&database, &backup_file).is_err());
    initialize(&copy)?;
    backup::restore(&copy, &backup_file, 0)?;
    assert_eq!(
        read(&database, "desktop")?.data,
        read(&copy, "desktop")?.data
    );
    assert_eq!(
        serde_json::to_value(images::read(&database, IMAGE_ID)?)?,
        serde_json::to_value(images::read(&copy, IMAGE_ID)?)?
    );
    Ok(())
}

#[test]
fn missing_or_corrupt_media_and_stale_revisions_leave_destination_untouched(
) -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let input = temp.path().join("backup.json");
    let database = temp.path().join("workspace.sqlite");
    initialize(&database)?;
    let original: Fields =
        serde_json::from_value(json!({"documents":[{"id":"keep"}], "cards":[]}))?;
    assert_eq!(write(&database, "desktop", 0, &original)?, 1);
    let mut incomplete = fixture();
    incomplete["backup"]["media"] = json!([]);
    put(&input, &incomplete)?;
    assert!(matches!(
        backup::restore(&database, &input, 1),
        Err(backup::BackupError::MissingImage(_))
    ));
    let mut corrupt = fixture();
    corrupt["backup"]["media"][0]["sha256"] = json!("wrong");
    put(&input, &corrupt)?;
    assert!(matches!(
        backup::restore(&database, &input, 1),
        Err(backup::BackupError::ImageChecksum(_))
    ));
    put(&input, &fixture())?;
    assert!(matches!(
        backup::restore(&database, &input, 0),
        Err(backup::BackupError::Storage(StorageError::StaleRevision))
    ));
    assert_eq!(read(&database, "desktop")?.data, original);
    assert!(images::read(&database, IMAGE_ID)?.is_none());
    Ok(())
}

#[test]
fn sqlite_failure_after_media_write_rolls_back_images_and_workspace() -> Result<(), Box<dyn Error>>
{
    let temp = tempfile::tempdir()?;
    let input = temp.path().join("backup.json");
    let database = temp.path().join("workspace.sqlite");
    initialize(&database)?;
    put(&input, &fixture())?;
    Connection::open(&database)?.execute_batch(
        "CREATE TRIGGER simulate_failure BEFORE INSERT ON workspace_field
         WHEN NEW.field = 'documents' BEGIN SELECT RAISE(ABORT, 'test interruption'); END;",
    )?;
    assert!(backup::restore(&database, &input, 0).is_err());
    assert_eq!(read(&database, "desktop")?.revision, 0);
    assert!(images::read(&database, IMAGE_ID)?.is_none());
    Ok(())
}

#[test]
fn backup_keeps_floating_point_values_bit_for_bit() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let input = temp.path().join("backup.json");
    let database = temp.path().join("workspace.sqlite");
    initialize(&database)?;
    let value = "0.30000000000000004";
    fs::write(
        &input,
        format!(r#"{{"documents":[],"cards":[],"extension":[{value}]}}"#),
    )?;
    backup::restore(&database, &input, 0)?;
    let original = value.parse::<f64>()?;
    let actual = read(&database, "desktop")?.data["extension"][0]
        .as_f64()
        .ok_or("missing number")?;
    assert_eq!(actual.to_bits(), original.to_bits());
    Ok(())
}

#[test]
fn preview_validates_file_identity_and_recovery_is_reversible_until_an_edit(
) -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let input = temp.path().join("backup.json");
    let database = temp.path().join("workspace.sqlite");
    initialize(&database)?;
    let original: Fields = serde_json::from_value(json!({
        "documents":[{"id":"original"}], "cards":[], "settings":{"knowledgeStoragePath":""}
    }))?;
    write(&database, "desktop", 0, &original)?;
    put(&input, &fixture())?;
    let preview = backup::preview(&database, &input)?;
    assert_eq!(read(&database, "desktop")?.data, original);
    let mut altered = fixture();
    altered["documents"][0]["title"] = json!("Changed on disk");
    put(&input, &altered)?;
    assert!(matches!(
        backup::apply_preview(&database, &preview.token),
        Err(backup::BackupError::Changed)
    ));
    assert!(!backup::can_undo(&database)?);
    backup::cancel_preview(&database, &preview.token)?;
    assert!(matches!(
        backup::apply_preview(&database, &preview.token),
        Err(backup::BackupError::Expired)
    ));

    put(&input, &fixture())?;
    let preview = backup::preview(&database, &input)?;
    let restored = backup::apply_preview(&database, &preview.token)?;
    assert_eq!(restored["documents"][0]["id"], "note");
    assert!(backup::can_undo(&database)?);
    initialize(&database)?;
    assert_eq!(backup::undo(&database)?, original);
    assert!(!backup::can_undo(&database)?);

    let preview = backup::preview(&database, &input)?;
    let mut updated = backup::apply_preview(&database, &preview.token)?;
    let revision = read(&database, "desktop")?.revision;
    updated.insert("checks".into(), json!(true));
    write(&database, "desktop", revision, &updated)?;
    assert!(matches!(
        backup::undo(&database),
        Err(backup::BackupError::CannotUndo)
    ));
    Ok(())
}
#[test]
fn module_export_reads_one_snapshot_and_keeps_extension_fields(
) -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let database = temp.path().join("workspace.sqlite3");
    initialize(&database)?;
    let data = serde_json::from_value(
        json!({"version": 2, "documents": [{"id": "one"}], "cards": [], "unknown": [2, 1]}),
    )?;
    write(&database, "desktop", 0, &data)?;
    let output = backup::export_modules(&database, temp.path())?;
    let section = |name: &str| -> Result<Fields, Box<dyn std::error::Error>> {
        Ok(serde_json::from_reader(std::fs::File::open(
            output.join(name),
        )?)?)
    };
    assert_eq!(section("library.json")?["documents"], data["documents"]);
    assert_eq!(section("cards.json")?["cards"], data["cards"]);
    assert_eq!(section("extra.json")?["unknown"], data["unknown"]);
    assert_eq!(read(&database, "desktop")?.revision, 1);
    Ok(())
}

#[test]
fn failed_backup_commit_hook_preserves_data_and_pending_confirmation() -> Result<(), Box<dyn Error>>
{
    let temporary = tempfile::tempdir()?;
    let database = temporary.path().join("workspace.sqlite3");
    initialize(&database)?;
    let initial = serde_json::from_value(
        json!({"version":2,"documents":[{"id":"retained","title":"Existing"}],"cards":[]}),
    )?;
    write(&database, "desktop", 0, &initial)?;
    let before = read(&database, "desktop")?;
    let source = temporary.path().join("incoming.json");
    put(&source, &fixture())?;
    let preview = backup::preview(&database, &source)?;
    let result =
        backup::apply_preview_with_commit(&database, &preview.token, |_tx, _before, _after| {
            Err("journal unavailable".into())
        });
    assert!(result.is_err());
    assert_eq!(read(&database, "desktop")?.data, before.data);
    assert_eq!(read(&database, "desktop")?.revision, before.revision);
    let restored = backup::apply_preview(&database, &preview.token)?;
    assert_eq!(restored["documents"][0]["id"], "note");
    Ok(())
}
