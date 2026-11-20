//! Optional attachment providers. This module has no knowledge of feature tables.
use std::collections::{BTreeMap, BTreeSet};

use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{BackupError, Fields, MAX_MEDIA};

const MAX_ATTACHMENT: usize = 128 * 1024 * 1024;
const MAX_ATTACHMENTS: usize = 10_000;

#[derive(Clone, Copy)]
pub enum CaptureKind {
    Portable,
    Checkpoint,
}

pub struct Attachment {
    pub id: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

pub struct ExtensionSnapshot {
    pub metadata: Value,
    pub attachments: Vec<Attachment>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSummary {
    pub label: String,
    pub attachments: usize,
    pub missing: usize,
    pub warnings: Vec<String>,
}

/// All callbacks borrow the host's existing SQLite snapshot/transaction.
/// Providers must not open a second connection or commit the supplied connection.
pub trait BackupExtension: Send + Sync {
    fn namespace(&self) -> &'static str;
    fn capture(
        &self,
        db: &Connection,
        data: &Fields,
        kind: CaptureKind,
    ) -> Result<ExtensionSnapshot, BackupError>;
    fn prepare(
        &self,
        db: &Connection,
        data: &Fields,
        snapshot: Option<&ExtensionSnapshot>,
    ) -> Result<ExtensionSummary, BackupError>;
    fn restore(
        &self,
        db: &Connection,
        before: &Fields,
        after: &Fields,
        snapshot: Option<&ExtensionSnapshot>,
    ) -> Result<(), BackupError>;
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortableExtension {
    version: u8,
    metadata: Value,
    attachments: Vec<PortableAttachment>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortableAttachment {
    id: String,
    mime_type: String,
    size: usize,
    sha256: String,
    data: String,
}

pub(crate) type Snapshots = BTreeMap<String, ExtensionSnapshot>;

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !matches!(value, "__proto__" | "constructor" | "prototype")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn valid_attachment(attachment: &Attachment) -> bool {
    valid_name(&attachment.id)
        && !attachment.bytes.is_empty()
        && attachment.bytes.len() <= MAX_ATTACHMENT
        && attachment.mime_type.len() <= 256
        && attachment.mime_type.contains('/')
        && attachment
            .mime_type
            .bytes()
            .all(|byte| byte.is_ascii() && !byte.is_ascii_control())
}

fn table_exists(db: &Connection, name: &str) -> Result<bool, BackupError> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |row| row.get(0),
    )
    .map_err(|error| crate::StorageError::from(error).into())
}

fn providers<'a>(
    db: &Connection,
    extensions: &'a [&dyn BackupExtension],
) -> Result<BTreeMap<&'static str, &'a dyn BackupExtension>, BackupError> {
    let mut registered = BTreeMap::new();
    for extension in extensions {
        let namespace = extension.namespace();
        if !valid_name(namespace) || registered.insert(namespace, *extension).is_some() {
            return Err(BackupError::Field("backup.extensions"));
        }
    }
    if table_exists(db, "workspace_backup_extension")? {
        let mut query = db
            .prepare("SELECT namespace FROM workspace_backup_extension")
            .map_err(crate::StorageError::from)?;
        for name in query
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(crate::StorageError::from)?
        {
            let name = name.map_err(crate::StorageError::from)?;
            if !registered.contains_key(name.as_str()) {
                return Err(BackupError::UnsupportedExtension(name));
            }
        }
    }
    Ok(registered)
}

/// A host declares the providers needed for a complete backup of this device.
/// A tool without these providers must fail instead of silently omitting attachments.
pub fn register_extension(db: &Connection, namespace: &str) -> Result<(), BackupError> {
    if !valid_name(namespace) {
        return Err(BackupError::Field("backup.extensions"));
    }
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS workspace_backup_extension(namespace TEXT PRIMARY KEY)",
    )
    .map_err(crate::StorageError::from)?;
    db.execute(
        "INSERT OR IGNORE INTO workspace_backup_extension VALUES(?1)",
        [namespace],
    )
    .map_err(crate::StorageError::from)?;
    Ok(())
}

pub(crate) fn capture(
    db: &Connection,
    data: &Fields,
    extensions: &[&dyn BackupExtension],
    kind: CaptureKind,
) -> Result<Snapshots, BackupError> {
    providers(db, extensions)?
        .into_iter()
        .map(|(name, provider)| Ok((name.into(), provider.capture(db, data, kind)?)))
        .collect()
}

pub(crate) fn encode(
    snapshots: Snapshots,
    total_media: &mut usize,
) -> Result<BTreeMap<String, PortableExtension>, BackupError> {
    snapshots
        .into_iter()
        .map(|(namespace, snapshot)| {
            let mut ids = BTreeSet::new();
            if snapshot.attachments.len() > MAX_ATTACHMENTS {
                return Err(BackupError::TooLarge);
            }
            let mut attachments = Vec::new();
            for attachment in snapshot.attachments {
                // IDs are kept after each attachment is moved into its portable representation.
                if !valid_attachment(&attachment) || !ids.insert(attachment.id.to_owned()) {
                    return Err(BackupError::Field("backup.extensions.attachments"));
                }
                *total_media = total_media
                    .checked_add(attachment.bytes.len())
                    .filter(|total| *total <= MAX_MEDIA)
                    .ok_or(BackupError::TooLarge)?;
                attachments.push(PortableAttachment {
                    id: attachment.id,
                    mime_type: attachment.mime_type,
                    size: attachment.bytes.len(),
                    sha256: format!("{:x}", Sha256::digest(&attachment.bytes)),
                    data: STANDARD.encode(&attachment.bytes),
                });
            }
            Ok((
                namespace,
                PortableExtension {
                    version: 1,
                    metadata: snapshot.metadata,
                    attachments,
                },
            ))
        })
        .collect()
}

pub(crate) fn decode(
    portable: BTreeMap<String, PortableExtension>,
    total_media: &mut usize,
) -> Result<Snapshots, BackupError> {
    portable
        .into_iter()
        .map(|(namespace, value)| {
            if !valid_name(&namespace)
                || value.version != 1
                || value.attachments.len() > MAX_ATTACHMENTS
            {
                return Err(BackupError::Field("backup.extensions"));
            }
            let mut ids = BTreeSet::new();
            let mut attachments = Vec::new();
            for portable in value.attachments {
                if portable.data.len() > MAX_ATTACHMENT.div_ceil(3) * 4 {
                    return Err(BackupError::TooLarge);
                }
                let bytes = STANDARD
                    .decode(&portable.data)
                    .map_err(|_| BackupError::Field("backup.extensions.attachments.data"))?;
                let attachment = Attachment {
                    id: portable.id,
                    mime_type: portable.mime_type,
                    bytes,
                };
                // The duplicate-ID set outlives the attachment moved into the decoded vector.
                if !valid_attachment(&attachment)
                    || !ids.insert(attachment.id.to_owned())
                    || portable.size != attachment.bytes.len()
                {
                    return Err(BackupError::Field("backup.extensions.attachments"));
                }
                if portable.sha256 != format!("{:x}", Sha256::digest(&attachment.bytes)) {
                    return Err(BackupError::AttachmentChecksum(attachment.id));
                }
                *total_media = total_media
                    .checked_add(attachment.bytes.len())
                    .filter(|total| *total <= MAX_MEDIA)
                    .ok_or(BackupError::TooLarge)?;
                attachments.push(attachment);
            }
            Ok((
                namespace,
                ExtensionSnapshot {
                    metadata: value.metadata,
                    attachments,
                },
            ))
        })
        .collect()
}

pub(crate) fn prepare(
    db: &Connection,
    data: &Fields,
    snapshots: &Snapshots,
    extensions: &[&dyn BackupExtension],
) -> Result<BTreeMap<String, ExtensionSummary>, BackupError> {
    let providers = providers(db, extensions)?;
    if let Some(namespace) = snapshots
        .keys()
        .find(|name| !providers.contains_key(name.as_str()))
    {
        return Err(BackupError::UnsupportedExtension(namespace.to_owned()));
    }
    providers
        .into_iter()
        .map(|(name, provider)| {
            Ok((
                name.into(),
                provider.prepare(db, data, snapshots.get(name))?,
            ))
        })
        .collect()
}

pub(crate) fn restore(
    db: &Connection,
    before: &Fields,
    after: &Fields,
    snapshots: &Snapshots,
    extensions: &[&dyn BackupExtension],
) -> Result<(), BackupError> {
    for (name, provider) in providers(db, extensions)? {
        provider.restore(db, before, after, snapshots.get(name))?;
        // Installing attachment state also declares its provider requirement, even
        // when a non-Tauri caller restores into a newly initialized database.
        register_extension(db, name)?;
    }
    Ok(())
}

pub(crate) fn fingerprint(snapshots: &Snapshots) -> String {
    let mut hash = Sha256::new();
    let mut add = |value: &[u8]| {
        hash.update((value.len() as u64).to_le_bytes());
        hash.update(value);
    };
    add(b"MemoKeep-backup-extension-state-v1");
    add(&(snapshots.len() as u64).to_le_bytes());
    for (namespace, snapshot) in snapshots {
        add(namespace.as_bytes());
        add(snapshot.metadata.to_string().as_bytes());
        let mut attachments = snapshot.attachments.iter().collect::<Vec<_>>();
        attachments.sort_by(|left, right| left.id.cmp(&right.id));
        add(&(attachments.len() as u64).to_le_bytes());
        for attachment in attachments {
            add(attachment.id.as_bytes());
            add(attachment.mime_type.as_bytes());
            add(&attachment.bytes);
        }
    }
    format!("{:x}", hash.finalize())
}

pub(crate) fn install_undo(db: &Connection) -> Result<(), BackupError> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS desktop_backup_extension_undo(slot INTEGER PRIMARY KEY CHECK(slot=1), checkpoint_digest TEXT NOT NULL, extension_digest TEXT NOT NULL)")
        .map_err(crate::StorageError::from)?;
    Ok(())
}

pub(crate) fn undo_state(db: &Connection) -> Result<Option<(String, String)>, BackupError> {
    if !table_exists(db, "desktop_backup_extension_undo")? {
        return Ok(None);
    }
    db.query_row(
        "SELECT checkpoint_digest,extension_digest FROM desktop_backup_extension_undo WHERE slot=1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(|error| crate::StorageError::from(error).into())
}

pub(crate) fn save_preview(db: &Connection, token: &str, digest: &str) -> Result<(), BackupError> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS desktop_backup_extension_preview(token TEXT PRIMARY KEY,extension_digest TEXT NOT NULL); DELETE FROM desktop_backup_extension_preview")
        .map_err(crate::StorageError::from)?;
    db.execute(
        "INSERT INTO desktop_backup_extension_preview VALUES(?1,?2)",
        params![token, digest],
    )
    .map_err(crate::StorageError::from)?;
    Ok(())
}

pub(crate) fn preview_state(db: &Connection, token: &str) -> Result<Option<String>, BackupError> {
    if !table_exists(db, "desktop_backup_extension_preview")? {
        return Ok(None);
    }
    db.query_row(
        "SELECT extension_digest FROM desktop_backup_extension_preview WHERE token=?1",
        [token],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| crate::StorageError::from(error).into())
}

pub(crate) fn remove_preview(db: &Connection, token: &str) -> Result<(), BackupError> {
    if table_exists(db, "desktop_backup_extension_preview")? {
        db.execute(
            "DELETE FROM desktop_backup_extension_preview WHERE token=?1",
            [token],
        )
        .map_err(crate::StorageError::from)?;
    }
    Ok(())
}

pub(crate) fn save_undo(
    db: &Connection,
    checkpoint: &str,
    extensions: &str,
) -> Result<(), BackupError> {
    install_undo(db)?;
    db.execute(
        "INSERT OR REPLACE INTO desktop_backup_extension_undo VALUES(1,?1,?2)",
        params![checkpoint, extensions],
    )
    .map_err(crate::StorageError::from)?;
    Ok(())
}
