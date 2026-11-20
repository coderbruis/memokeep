use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use uuid::Uuid;

use crate::{connect, StorageError};

pub(crate) const MAX_BYTES: usize = 25 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImage {
    id: String,
    file_name: String,
    name: String,
    mime_type: &'static str,
    size: usize,
    reference: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadImage {
    id: String,
    file_name: String,
    mime_type: &'static str,
    size: usize,
    data_url: String,
}

pub(crate) fn image_type(bytes: &[u8]) -> Result<(&'static str, &'static str), StorageError> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok(("png", "image/png"))
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Ok(("jpg", "image/jpeg"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Ok(("gif", "image/gif"))
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Ok(("webp", "image/webp"))
    } else {
        Err(StorageError::UnsupportedImage)
    }
}

pub(crate) fn decode(encoded: &str) -> Result<Vec<u8>, StorageError> {
    if encoded.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err(StorageError::ImageTooLarge);
    }
    let bytes = STANDARD.decode(encoded)?;
    if bytes.len() > MAX_BYTES {
        return Err(StorageError::ImageTooLarge);
    }
    image_type(&bytes)?;
    Ok(bytes)
}

pub fn save(path: &Path, encoded: &str, name: &str) -> Result<SavedImage, StorageError> {
    let bytes = decode(encoded)?;
    let (extension, mime_type) = image_type(&bytes)?;
    let id = Uuid::new_v4().to_string();
    let name = Path::new(name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .replace(['\r', '\n', '\t'], " ");
    let name: String = name.trim().chars().take(160).collect();
    let db = connect(path)?;
    db.execute("INSERT INTO note_image VALUES (?1, ?2)", params![id, bytes])?;
    Ok(SavedImage {
        file_name: format!("{id}.{extension}"),
        reference: format!("memokeep-image://{id}"),
        id,
        name: if name.is_empty() {
            format!("图片.{extension}")
        } else {
            name
        },
        mime_type,
        size: bytes.len(),
    })
}

pub(crate) fn checked_id(id: &str) -> Result<String, StorageError> {
    let uuid = Uuid::parse_str(id).map_err(|_| StorageError::InvalidImageId)?;
    let canonical = uuid.to_string();
    if !(1..=5).contains(&uuid.get_version_num())
        || uuid.get_variant() != uuid::Variant::RFC4122
        || !id.eq_ignore_ascii_case(&canonical)
    {
        return Err(StorageError::InvalidImageId);
    }
    Ok(canonical)
}

pub fn read(path: &Path, id: &str) -> Result<Option<ReadImage>, StorageError> {
    let id = checked_id(id)?;
    let db = connect(path)?;
    let bytes = read_bytes(&db, &id)?;
    let Some(bytes) = bytes else {
        return Ok(None);
    };
    let (extension, mime_type) = image_type(&bytes)?;
    Ok(Some(ReadImage {
        file_name: format!("{id}.{extension}"),
        id,
        mime_type,
        size: bytes.len(),
        data_url: format!("data:{mime_type};base64,{}", STANDARD.encode(bytes)),
    }))
}

pub(crate) fn read_bytes(db: &Connection, id: &str) -> Result<Option<Vec<u8>>, StorageError> {
    Ok(db
        .query_row(
            "SELECT payload FROM note_image WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?)
}

pub fn delete_unreferenced(path: &Path, id: &str) -> Result<bool, StorageError> {
    let id = checked_id(id)?;
    let mut db = connect(path)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // Include history, trash, and extension fields when checking references.
    let reference = format!("memokeep-image://{id}");
    if crate::records::installed_on(&tx)? {
        let referenced: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM workspace_record WHERE instr(lower(payload),?1)>0)", [&reference], |row| row.get(0))?;
        if referenced { tx.commit()?; return Ok(false); }
    }
    let count = tx.execute(
        "DELETE FROM note_image WHERE id = ?1 AND NOT EXISTS (
            SELECT 1 FROM workspace_field WHERE instr(lower(payload), ?2) > 0
         )",
        params![id, reference],
    )?;
    tx.commit()?;
    Ok(count == 1)
}
