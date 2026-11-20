use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::{connect, images, read_on, write_on, Fields, StorageError};

mod extension;
pub use extension::{
    register_extension, Attachment, BackupExtension, CaptureKind, ExtensionSnapshot,
    ExtensionSummary,
};

const DESKTOP_SCOPE: &str = "desktop";
const MAX_FILE: u64 = 700 * 1024 * 1024;
const MAX_MEDIA: usize = 512 * 1024 * 1024;
const COLLECTIONS: &[&str] = &[
    "documents",
    "cardDocuments",
    "cards",
    "items",
    "knowledgeBases",
    "cardFolders",
    "cardNotebooks",
    "memos",
    "plans",
    "focusSessions",
    "noteTags",
    "cardCandidates",
    "sourceChanges",
    "reviewRecords",
    "freeReviews",
    "trash",
];

#[derive(Debug, Error)]
pub enum BackupError {
    #[error("恢复事务无法提交：{0}")]
    Commit(String),
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error("备份读写失败：{0}")]
    Io(#[from] std::io::Error),
    #[error("备份无法解码：{0}")]
    Json(#[from] serde_json::Error),
    #[error("无法生成导出时间：{0}")]
    Date(#[from] time::error::Format),
    #[error("备份格式或版本不受支持")]
    Format,
    #[error("备份字段 {0} 无效")]
    Field(&'static str),
    #[error("备份超过大小上限")]
    TooLarge,
    #[error("缺少引用的图片 {0}")]
    MissingImage(String),
    #[error("重复的图片 {0}")]
    DuplicateImage(String),
    #[error("图片 {0} SHA-256 校验失败")]
    ImageChecksum(String),
    #[error("完整备份还没有工作空间数据")]
    EmptyWorkspace,
    #[error("恢复预览已过期或被替换，请重新选择备份")]
    Expired,
    #[error("备份文件较预览时已变化，请重新选择备份")]
    Changed,
    #[error("没有可撤销的恢复，或恢复后已有新的修改")]
    CannotUndo,
    #[error("备份附件扩展不可用：{0}")]
    UnsupportedExtension(String),
    #[error("备份附件校验失败：{0}")]
    AttachmentChecksum(String),
    #[error("备份附件无法处理：{0}")]
    Extension(String),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: String,
    version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    exported_at: Option<String>,
    #[serde(default)]
    media_included: bool,
    #[serde(default)]
    media: Vec<PortableImage>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    extensions: BTreeMap<String, extension::PortableExtension>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableImage {
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mime_type: Option<String>,
    data: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
}

#[derive(Serialize)]
struct PortableBackup<'a> {
    #[serde(flatten)]
    data: &'a Fields,
    backup: Manifest,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub revision: i64,
    pub notes: usize,
    pub card_notes: usize,
    pub libraries: usize,
    pub cards: usize,
    pub reviews: usize,
    pub images: usize,
}

fn rows<'a>(data: &'a Fields, field: &str) -> impl Iterator<Item = &'a Value> {
    data.get(field)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn report(data: &Fields, revision: i64, images: usize) -> Report {
    Report {
        revision,
        notes: rows(data, "documents").count(),
        card_notes: rows(data, "cardDocuments").count(),
        libraries: rows(data, "knowledgeBases").count(),
        cards: rows(data, "cards").count(),
        reviews: rows(data, "reviewRecords").count(),
        images,
    }
}

fn validate_data(data: &Fields) -> Result<(), BackupError> {
    if !data.get("documents").is_some_and(Value::is_array)
        || !data.get("cards").is_some_and(Value::is_array)
    {
        return Err(BackupError::Format);
    }
    if let Some(version) = data.get("version").filter(|value| !value.is_null()) {
        if !matches!(version.as_u64(), Some(1 | 2)) {
            return Err(BackupError::Format);
        }
    }
    for &field in COLLECTIONS {
        if data
            .get(field)
            .is_some_and(|value| !value.is_array() && !value.is_null())
        {
            return Err(BackupError::Field(field));
        }
        let mut ids = BTreeSet::new();
        for row in rows(data, field) {
            let id = row["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or(BackupError::Field(field))?;
            if !ids.insert(id) {
                return Err(BackupError::Field(field));
            }
        }
    }
    if rows(data, "documents")
        .chain(rows(data, "cardDocuments"))
        .any(|document| {
            let value = &document["metadata"]["versions"];
            !value.is_null() && !value.is_array()
        })
    {
        return Err(BackupError::Field("metadata.versions"));
    }
    if data
        .get("settings")
        .is_some_and(|value| !value.is_object() && !value.is_null())
    {
        return Err(BackupError::Field("settings"));
    }
    if ["backup", "constructor", "prototype", "__proto__"]
        .iter()
        .any(|key| data.contains_key(*key))
    {
        return Err(BackupError::Format);
    }
    Ok(())
}

fn add_references(ids: &mut BTreeSet<String>, value: &Value) {
    if let Some(content) = value.as_str() {
        let lower = content.to_ascii_lowercase();
        for tail in lower.split("memokeep-image://").skip(1) {
            if let Some(id) = tail.get(..36).filter(|value| {
                value
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
            }) {
                ids.insert(id.into());
            }
        }
    }
}

fn document_references(ids: &mut BTreeSet<String>, document: &Value) {
    add_references(ids, &document["content"]);
    add_references(ids, &document["metadata"]["noteContent"]);
    if let Some(versions) = document["metadata"]["versions"].as_array() {
        for version in versions {
            add_references(ids, &version["content"]);
            add_references(ids, &version["noteContent"]);
        }
    }
}

fn card_references(ids: &mut BTreeSet<String>, card: &Value) {
    add_references(ids, &card["question"]);
    add_references(ids, &card["answer"]);
    add_references(ids, &card["imageOcclusion"]["reference"]);
}

// Keep these fields compatible with the Electron portable-backup reference contract.
fn references(data: &Fields) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for document in rows(data, "documents").chain(rows(data, "cardDocuments")) {
        document_references(&mut ids, document);
    }
    for card in rows(data, "cards").chain(rows(data, "cardCandidates")) {
        card_references(&mut ids, card);
    }
    for memo in rows(data, "memos") {
        add_references(&mut ids, &memo["notes"]);
    }
    for change in rows(data, "sourceChanges") {
        add_references(&mut ids, &change["oldAnswer"]);
        add_references(&mut ids, &change["newAnswer"]);
    }
    for entry in rows(data, "trash") {
        document_references(&mut ids, &entry["document"]);
        card_references(&mut ids, &entry["card"]);
        if let Some(cards) = entry["cards"].as_array() {
            for card in cards {
                card_references(&mut ids, card);
            }
        }
    }
    ids
}

fn add_media_size(bytes: &mut usize, image_size: usize) -> Result<(), BackupError> {
    *bytes += image_size;
    if image_size > images::MAX_BYTES || *bytes > MAX_MEDIA {
        return Err(BackupError::TooLarge);
    }
    Ok(())
}

/// A human-readable projection of one SQLite snapshot. Portable backups include media separately.
pub fn export_modules(database: &Path, directory: &Path) -> Result<PathBuf, BackupError> {
    let snapshot = crate::read(database, DESKTOP_SCOPE)?;
    if snapshot.revision == 0 {
        return Err(BackupError::EmptyWorkspace);
    }
    let mut sections = snapshot.data;
    let temporary = tempfile::Builder::new()
        .prefix(".memokeep-export-")
        .tempdir_in(directory)?;
    let write = |name: &str, data: &Fields| -> Result<(), BackupError> {
        let mut file = BufWriter::new(File::create(temporary.path().join(name))?);
        serde_json::to_writer_pretty(&mut file, data)?;
        file.flush()?;
        file.get_ref().sync_all()?;
        Ok(())
    };
    let groups: &[(&str, &[&str])] = &[
        (
            "library.json",
            &["knowledgeBases", "noteTags", "documents", "items"],
        ),
        (
            "cards.json",
            &[
                "cardDocuments",
                "cardFolders",
                "cardNotebooks",
                "cards",
                "reviewRecords",
            ],
        ),
        ("planner.json", &["plans", "memos", "focusSessions"]),
        (
            "workspace.json",
            &[
                "version",
                "cardOrganizationVersion",
                "settings",
                "trash",
                "streak",
            ],
        ),
    ];
    for &(name, fields) in groups {
        let subset = fields
            .iter()
            .filter_map(|&key| sections.remove(key).map(|value| (key.into(), value)))
            .collect();
        write(name, &subset)?;
    }
    write("extra.json", &sections)?;
    let target = directory.join(format!("MemoKeep-JSON-{}", uuid::Uuid::new_v4()));
    std::fs::rename(temporary.path(), &target)?;
    Ok(target)
}

pub fn export(database: &Path, output: &Path) -> Result<Report, BackupError> {
    export_with_extensions(database, output, &[])
}

pub fn export_with_extensions(
    database: &Path,
    output: &Path,
    extensions: &[&dyn BackupExtension],
) -> Result<Report, BackupError> {
    let mut db = connect(database)?;
    let tx = db.transaction().map_err(StorageError::from)?;
    let captured = capture_backup(&tx, extensions, CaptureKind::Portable)?;
    tx.commit().map_err(StorageError::from)?;
    write_backup(output, captured)
}

struct CapturedBackup {
    data: Fields,
    manifest: Manifest,
    summary: Report,
    extension_fingerprint: String,
}

fn capture_backup(
    db: &Connection,
    extensions: &[&dyn BackupExtension],
    kind: CaptureKind,
) -> Result<CapturedBackup, BackupError> {
    let mut snapshot = read_on(db, DESKTOP_SCOPE)?;
    if snapshot.revision == 0 && matches!(kind, CaptureKind::Portable) {
        return Err(BackupError::EmptyWorkspace);
    }
    let attachments = extension::capture(db, &snapshot.data, extensions, kind)?;
    let extension_fingerprint = extension::fingerprint(&attachments);
    if snapshot.revision == 0 {
        if !snapshot.data.is_empty() {
            return Err(StorageError::InvalidRevision.into());
        }
        // Only an internal checkpoint may represent an uninitialized workspace.
        // Its logical empty state is a valid restore candidate, but the revision
        // remains zero here and every later apply/undo still advances normally.
        snapshot.data.insert("version".into(), Value::from(2));
        snapshot
            .data
            .insert("documents".into(), Value::Array(Vec::new()));
        snapshot
            .data
            .insert("cards".into(), Value::Array(Vec::new()));
    }
    validate_data(&snapshot.data)?;
    let mut total_media = 0;
    let mut media = Vec::new();
    for id in references(&snapshot.data) {
        let bytes = images::read_bytes(db, &id)?
            .ok_or_else(|| BackupError::MissingImage(id.to_string()))?;
        add_media_size(&mut total_media, bytes.len())?;
        let (_, mime) = images::image_type(&bytes)?;
        media.push(PortableImage {
            id,
            mime_type: Some(mime.into()),
            sha256: Some(format!("{:x}", Sha256::digest(&bytes))),
            data: STANDARD.encode(bytes),
        });
    }
    let summary = report(&snapshot.data, snapshot.revision, media.len());
    let extensions = extension::encode(attachments, &mut total_media)?;
    let manifest = Manifest {
        format: "MemoKeep".into(),
        // Old readers must reject a backup whose required attachments they cannot restore.
        version: if extensions.is_empty() { 1 } else { 2 },
        exported_at: Some(OffsetDateTime::now_utc().format(&Rfc3339)?),
        media_included: true,
        media,
        extensions,
    };
    Ok(CapturedBackup {
        data: snapshot.data,
        manifest,
        summary,
        extension_fingerprint,
    })
}

fn write_backup(output: &Path, captured: CapturedBackup) -> Result<Report, BackupError> {
    let backup = PortableBackup {
        data: &captured.data,
        backup: captured.manifest,
    };
    let parent = output
        .parent()
        .filter(|directory| !directory.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    {
        let mut writer = BufWriter::new(temporary.as_file_mut());
        serde_json::to_writer(&mut writer, &backup)?;
        writer.flush()?;
    }
    if temporary.as_file().metadata()?.len() > MAX_FILE {
        return Err(BackupError::TooLarge);
    }
    temporary.as_file().sync_all()?;
    temporary
        .persist_noclobber(output)
        .map_err(|error| error.error)?;
    Ok(captured.summary)
}

struct BackupReader<R> {
    inner: R,
    hash: Sha256,
}

impl<R: Read> Read for BackupReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let length = self.inner.read(buffer)?;
        self.hash.update(&buffer[..length]);
        Ok(length)
    }
}

struct Candidate {
    data: Fields,
    media: BTreeMap<String, Vec<u8>>,
    references: BTreeSet<String>,
    digest: String,
    legacy: bool,
    extensions: extension::Snapshots,
}

fn load(input: &Path) -> Result<Candidate, BackupError> {
    let file = File::open(input)?;
    if file.metadata()?.len() > MAX_FILE {
        return Err(BackupError::TooLarge);
    }
    let mut reader = BufReader::new(BackupReader {
        inner: file.take(MAX_FILE + 1),
        hash: Sha256::new(),
    });
    let mut data: Fields = serde_json::from_reader(&mut reader)?;
    let reader = reader.into_inner();
    if reader.inner.limit() == 0 {
        return Err(BackupError::TooLarge);
    }
    let digest = format!("{:x}", reader.hash.finalize());
    let manifest = data
        .remove("backup")
        .filter(|value| !value.is_null())
        .map(serde_json::from_value::<Manifest>)
        .transpose()?;
    validate_data(&data)?;
    let mut media = BTreeMap::new();
    let mut total_media = 0;
    let references = references(&data);
    let legacy = !manifest
        .as_ref()
        .is_some_and(|manifest| manifest.media_included);
    let mut extensions = BTreeMap::new();
    if let Some(manifest) = manifest {
        if manifest.format != "MemoKeep" || !matches!(manifest.version, 1 | 2) {
            return Err(BackupError::Format);
        }
        if manifest.version == 1 && !manifest.extensions.is_empty() {
            return Err(BackupError::Format);
        }
        for image in manifest.media {
            let id = images::checked_id(&image.id)?;
            let bytes = images::decode(&image.data)?;
            add_media_size(&mut total_media, bytes.len())?;
            if image
                .sha256
                .is_some_and(|hash| hash != format!("{:x}", Sha256::digest(&bytes)))
            {
                return Err(BackupError::ImageChecksum(id));
            }
            if media.contains_key(&id) {
                return Err(BackupError::DuplicateImage(id));
            }
            media.insert(id, bytes);
        }
        if manifest.media_included {
            if let Some(id) = references.iter().find(|id| !media.contains_key(*id)) {
                return Err(BackupError::MissingImage(id.to_string()));
            }
        }
        extensions = extension::decode(manifest.extensions, &mut total_media)?;
    }

    Ok(Candidate {
        data,
        media,
        references,
        digest,
        legacy,
        extensions,
    })
}

fn verify_references(db: &Connection, candidate: &Candidate) -> Result<(), BackupError> {
    for id in candidate
        .references
        .iter()
        .filter(|id| !candidate.media.contains_key(*id))
    {
        if images::read_bytes(db, id)?.is_none() {
            return Err(BackupError::MissingImage(id.to_string()));
        }
    }
    Ok(())
}

fn restore_on(
    tx: &Connection,
    candidate: &mut Candidate,
    expected_revision: i64,
    bump_revision: bool,
    extensions: &[&dyn BackupExtension],
) -> Result<Report, BackupError> {
    let original = read_on(tx, DESKTOP_SCOPE)?;
    if original.revision != expected_revision {
        return Err(StorageError::StaleRevision.into());
    }
    extension::prepare(tx, &candidate.data, &candidate.extensions, extensions)?;
    verify_references(tx, candidate)?;
    let Candidate {
        data,
        media,
        references,
        ..
    } = candidate;
    // The incoming file must not reassign the target's external export directory.
    let directory = original
        .data
        .get("settings")
        .and_then(|settings| settings.get("knowledgeStoragePath"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let settings = data
        .entry("settings")
        .or_insert_with(|| Value::Object(Fields::new()));
    if settings.is_null() {
        *settings = Value::Object(Fields::new());
    }
    let values = settings
        .as_object_mut()
        .ok_or(BackupError::Field("settings"))?;
    values.insert("knowledgeStoragePath".into(), Value::from(directory));

    let mut changed = false;
    for (id, bytes) in media.iter() {
        changed |= tx
            .execute(
                "INSERT INTO note_image VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE
             SET payload = excluded.payload WHERE payload <> excluded.payload",
                params![id, bytes],
            )
            .map_err(StorageError::from)?
            > 0;
    }
    let revision = write_on(
        tx,
        DESKTOP_SCOPE,
        original.revision,
        data,
        changed || bump_revision,
    )?;
    extension::restore(tx, &original.data, data, &candidate.extensions, extensions)?;
    crate::reminders::reset_on(tx).map_err(|error| BackupError::Commit(error.to_string()))?;
    Ok(report(data, revision, references.len()))
}

pub fn restore(
    database: &Path,
    input: &Path,
    expected_revision: i64,
) -> Result<Report, BackupError> {
    restore_with_extensions(database, input, expected_revision, &[])
}

pub fn restore_with_extensions(
    database: &Path,
    input: &Path,
    expected_revision: i64,
    extensions: &[&dyn BackupExtension],
) -> Result<Report, BackupError> {
    let mut candidate = load(input)?;
    let mut db = connect(database)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(StorageError::from)?;
    let result = restore_on(&tx, &mut candidate, expected_revision, false, extensions)?;
    tx.commit().map_err(StorageError::from)?;
    Ok(result)
}

pub(crate) fn install(db: &Connection) -> Result<(), StorageError> {
    db.execute_batch(
        "CREATE TABLE desktop_backup_preview (
            slot INTEGER PRIMARY KEY CHECK(slot=1), token TEXT NOT NULL, source TEXT NOT NULL,
            digest TEXT NOT NULL, revision INTEGER NOT NULL, expires INTEGER NOT NULL
         );
         CREATE TABLE desktop_backup_undo (
            slot INTEGER PRIMARY KEY CHECK(slot=1), revision INTEGER NOT NULL, checkpoint TEXT NOT NULL
         );",
    )?;
    Ok(())
}

#[derive(Serialize)]
pub struct PreviewSummary {
    libraries: usize,
    notes: usize,
    cards: usize,
    reviews: usize,
    memos: usize,
    candidates: usize,
    versions: usize,
    media: usize,
}

fn summary(candidate: &Candidate) -> PreviewSummary {
    let data = &candidate.data;
    let counts = report(data, 0, candidate.references.len());
    PreviewSummary {
        libraries: counts.libraries,
        notes: counts.notes + counts.card_notes,
        cards: counts.cards,
        reviews: counts.reviews,
        memos: rows(data, "memos").count(),
        candidates: rows(data, "cardCandidates").count(),
        versions: rows(data, "documents")
            .chain(rows(data, "cardDocuments"))
            .map(|doc| doc["metadata"]["versions"].as_array().map_or(0, Vec::len))
            .sum(),
        media: counts.images,
    }
}

#[derive(Serialize)]
pub struct Preview {
    pub token: String,
    pub name: String,
    pub summary: PreviewSummary,
    pub legacy: bool,
    pub changes: BTreeMap<&'static str, Changes>,
    pub extensions: BTreeMap<String, ExtensionSummary>,
    pub warnings: Vec<String>,
}

#[derive(Default, Serialize)]
pub struct Changes {
    added: usize,
    updated: usize,
    removed: usize,
}

fn count_changes<'a, T: PartialEq + 'a>(
    before: BTreeMap<&'a str, T>,
    after: BTreeMap<&'a str, T>,
) -> Changes {
    Changes {
        added: after.keys().filter(|id| !before.contains_key(*id)).count(),
        updated: after
            .iter()
            .filter(|(id, row)| before.get(*id).is_some_and(|old| old != *row))
            .count(),
        removed: before.keys().filter(|id| !after.contains_key(*id)).count(),
    }
}

fn by_id<'a>(data: &'a Fields, field: &str) -> BTreeMap<&'a str, &'a Value> {
    rows(data, field)
        .filter_map(|row| Some((row["id"].as_str()?, row)))
        .collect()
}

fn preview_changes(
    db: &Connection,
    before: &Fields,
    candidate: &Candidate,
) -> Result<BTreeMap<&'static str, Changes>, BackupError> {
    let note_changes = count_changes(
        by_id(before, "documents"),
        by_id(&candidate.data, "documents"),
    );
    let card_notes = count_changes(
        by_id(before, "cardDocuments"),
        by_id(&candidate.data, "cardDocuments"),
    );
    let old_images = references(before);
    let mut media = Changes {
        added: candidate.references.difference(&old_images).count(),
        removed: old_images.difference(&candidate.references).count(),
        updated: 0,
    };
    for id in candidate.references.intersection(&old_images) {
        if let Some(bytes) = candidate.media.get(id) {
            if images::read_bytes(db, id)?.as_ref() != Some(bytes) {
                media.updated += 1;
            }
        }
    }
    Ok(BTreeMap::from([
        (
            "notes",
            Changes {
                added: note_changes.added + card_notes.added,
                updated: note_changes.updated + card_notes.updated,
                removed: note_changes.removed + card_notes.removed,
            },
        ),
        (
            "cards",
            count_changes(by_id(before, "cards"), by_id(&candidate.data, "cards")),
        ),
        (
            "reviews",
            count_changes(
                by_id(before, "reviewRecords"),
                by_id(&candidate.data, "reviewRecords"),
            ),
        ),
        ("media", media),
    ]))
}

pub fn preview(database: &Path, source: &Path) -> Result<Preview, BackupError> {
    preview_with_extensions(database, source, &[])
}

pub fn preview_with_extensions(
    database: &Path,
    source: &Path,
    extensions: &[&dyn BackupExtension],
) -> Result<Preview, BackupError> {
    let candidate = load(source)?;
    let source_path = source.to_str().ok_or(BackupError::Field("文件路径"))?;
    let token = uuid::Uuid::new_v4().to_string();
    let mut db = connect(database)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(StorageError::from)?;
    verify_references(&tx, &candidate)?;
    let summaries = extension::prepare(&tx, &candidate.data, &candidate.extensions, extensions)?;
    let warnings = summaries
        .values()
        .flat_map(|summary| summary.warnings.iter().map(String::to_owned))
        .collect();
    let snapshot = read_on(&tx, DESKTOP_SCOPE)?;
    let current_attachments =
        extension::capture(&tx, &snapshot.data, extensions, CaptureKind::Checkpoint)?;
    extension::save_preview(&tx, &token, &extension::fingerprint(&current_attachments))?;
    let changes = preview_changes(&tx, &snapshot.data, &candidate)?;
    let expires = OffsetDateTime::now_utc().unix_timestamp() + 15 * 60;
    tx.execute(
        "INSERT OR REPLACE INTO desktop_backup_preview VALUES(1,?1,?2,?3,?4,?5)",
        params![
            token,
            source_path,
            candidate.digest,
            snapshot.revision,
            expires
        ],
    )
    .map_err(StorageError::from)?;
    tx.commit().map_err(StorageError::from)?;
    Ok(Preview {
        token,
        name: source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("MemoKeep 备份")
            .into(),
        summary: summary(&candidate),
        legacy: candidate.legacy,
        changes,
        extensions: summaries,
        warnings,
    })
}

fn pending(db: &Connection, token: &str) -> Result<(String, String, i64), BackupError> {
    db.query_row(
        "SELECT source,digest,revision FROM desktop_backup_preview WHERE token=?1 AND expires>=?2",
        params![token, OffsetDateTime::now_utc().unix_timestamp()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .optional()
    .map_err(StorageError::from)?
    .ok_or(BackupError::Expired)
}

pub fn cancel_preview(database: &Path, token: &str) -> Result<(), BackupError> {
    let mut db = connect(database)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(StorageError::from)?;
    tx.execute("DELETE FROM desktop_backup_preview WHERE token=?1", [token])
        .map_err(StorageError::from)?;
    extension::remove_preview(&tx, token)?;
    tx.commit().map_err(StorageError::from)?;
    Ok(())
}

fn undo_marker(db: &Connection) -> Result<Option<(i64, String)>, BackupError> {
    Ok(db
        .query_row(
            "SELECT revision,checkpoint FROM desktop_backup_undo WHERE slot=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(StorageError::from)?)
}

pub fn apply_preview(database: &Path, token: &str) -> Result<Fields, BackupError> {
    apply_preview_with_commit(database, token, |_, _, _| Ok(()))
}

pub fn apply_preview_with_commit<F>(
    database: &Path,
    token: &str,
    commit: F,
) -> Result<Fields, BackupError>
where
    F: FnOnce(&Connection, &Fields, &Fields) -> Result<(), String>,
{
    apply_preview_with_extensions_and_commit(database, token, &[], commit)
}

pub fn apply_preview_with_extensions(
    database: &Path,
    token: &str,
    extensions: &[&dyn BackupExtension],
) -> Result<Fields, BackupError> {
    apply_preview_with_extensions_and_commit(database, token, extensions, |_, _, _| Ok(()))
}

pub fn apply_preview_with_extensions_and_commit<F>(
    database: &Path,
    token: &str,
    extensions: &[&dyn BackupExtension],
    commit: F,
) -> Result<Fields, BackupError>
where
    F: FnOnce(&Connection, &Fields, &Fields) -> Result<(), String>,
{
    let mut db = connect(database)?;
    let (source, digest, expected) = pending(&db, token)?;
    let mut candidate = load(Path::new(&source))?;
    if candidate.digest != digest {
        return Err(BackupError::Changed);
    }
    if crate::revision(&db, DESKTOP_SCOPE)? != expected {
        return Err(StorageError::StaleRevision.into());
    }
    let checkpoint = database.with_file_name(format!("restore-{}.json", uuid::Uuid::new_v4()));
    let checkpoint_path = checkpoint.to_str().ok_or(BackupError::Field("文件路径"))?;
    let result = (|| {
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StorageError::from)?;
        pending(&tx, token)?;
        let previous = undo_marker(&tx)?;
        // Hold the same write transaction while capturing both business fields and
        // extension attachments: an attachment-only write cannot race the checkpoint.
        let captured = capture_backup(&tx, extensions, CaptureKind::Checkpoint)?;
        if captured.summary.revision != expected {
            return Err(StorageError::StaleRevision.into());
        }
        if let Some(expected_attachments) = extension::preview_state(&tx, token)? {
            if captured.extension_fingerprint != expected_attachments {
                return Err(StorageError::StaleRevision.into());
            }
        } else if !extensions.is_empty() {
            return Err(BackupError::Expired);
        }
        write_backup(&checkpoint, captured)?;
        let checkpoint_digest = backup_digest(&checkpoint)?;
        let before = read_on(&tx, DESKTOP_SCOPE)?.data;
        let report = restore_on(&tx, &mut candidate, expected, true, extensions)?;
        commit(&tx, &before, &candidate.data).map_err(BackupError::Commit)?;
        let attachment_state =
            extension::capture(&tx, &candidate.data, extensions, CaptureKind::Checkpoint)?;
        extension::save_undo(
            &tx,
            &checkpoint_digest,
            &extension::fingerprint(&attachment_state),
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO desktop_backup_undo VALUES(1,?1,?2)",
            params![report.revision, checkpoint_path],
        )
        .map_err(StorageError::from)?;
        tx.execute("DELETE FROM desktop_backup_preview WHERE token=?1", [token])
            .map_err(StorageError::from)?;
        extension::remove_preview(&tx, token)?;
        tx.commit().map_err(StorageError::from)?;
        if let Some((_, previous)) = previous {
            let _ = std::fs::remove_file(previous);
        }
        Ok(candidate.data)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(checkpoint);
    }
    result
}

pub fn can_undo(database: &Path) -> Result<bool, BackupError> {
    can_undo_with_extensions(database, &[])
}

pub fn can_undo_with_extensions(
    database: &Path,
    extensions: &[&dyn BackupExtension],
) -> Result<bool, BackupError> {
    let mut db = connect(database)?;
    let tx = db.transaction().map_err(StorageError::from)?;
    let revision = crate::revision(&tx, DESKTOP_SCOPE)?;
    let Some((expected, source)) = undo_marker(&tx)? else {
        return Ok(false);
    };
    if expected != revision || !Path::new(&source).is_file() {
        return Ok(false);
    }
    let Some((_, digest)) = extension::undo_state(&tx)? else {
        return Ok(extensions.is_empty());
    };
    let data = read_on(&tx, DESKTOP_SCOPE)?.data;
    let current = extension::capture(&tx, &data, extensions, CaptureKind::Checkpoint)?;
    Ok(extension::fingerprint(&current) == digest)
}

pub fn undo(database: &Path) -> Result<Fields, BackupError> {
    undo_with_commit(database, |_, _, _| Ok(()))
}

pub fn undo_with_commit<F>(database: &Path, commit: F) -> Result<Fields, BackupError>
where
    F: FnOnce(&Connection, &Fields, &Fields) -> Result<(), String>,
{
    undo_with_extensions_and_commit(database, &[], commit)
}

pub fn undo_with_extensions(
    database: &Path,
    extensions: &[&dyn BackupExtension],
) -> Result<Fields, BackupError> {
    undo_with_extensions_and_commit(database, extensions, |_, _, _| Ok(()))
}

pub fn undo_with_extensions_and_commit<F>(
    database: &Path,
    extensions: &[&dyn BackupExtension],
    commit: F,
) -> Result<Fields, BackupError>
where
    F: FnOnce(&Connection, &Fields, &Fields) -> Result<(), String>,
{
    let mut db = connect(database)?;
    let marker = undo_marker(&db)?.ok_or(BackupError::CannotUndo)?;
    if crate::revision(&db, DESKTOP_SCOPE)? != marker.0 {
        return Err(BackupError::CannotUndo);
    }
    let mut candidate = load(Path::new(&marker.1))?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(StorageError::from)?;
    if undo_marker(&tx)?.as_ref() != Some(&marker) {
        return Err(BackupError::CannotUndo);
    }
    let before = read_on(&tx, DESKTOP_SCOPE)?.data;
    if let Some((checkpoint_digest, digest)) = extension::undo_state(&tx)? {
        let current = extension::capture(&tx, &before, extensions, CaptureKind::Checkpoint)?;
        if candidate.digest != checkpoint_digest || extension::fingerprint(&current) != digest {
            return Err(BackupError::CannotUndo);
        }
    } else if !extensions.is_empty() {
        return Err(BackupError::CannotUndo);
    }
    restore_on(&tx, &mut candidate, marker.0, true, extensions)?;
    commit(&tx, &before, &candidate.data).map_err(BackupError::Commit)?;
    tx.execute("DELETE FROM desktop_backup_undo WHERE slot=1", [])
        .map_err(StorageError::from)?;
    extension::install_undo(&tx)?;
    tx.execute("DELETE FROM desktop_backup_extension_undo WHERE slot=1", [])
        .map_err(StorageError::from)?;
    tx.commit().map_err(StorageError::from)?;
    let _ = std::fs::remove_file(marker.1);
    Ok(candidate.data)
}

fn backup_digest(input: &Path) -> Result<String, BackupError> {
    let mut reader = BackupReader {
        inner: File::open(input)?,
        hash: Sha256::new(),
    };
    std::io::copy(&mut reader, &mut std::io::sink())?;
    Ok(format!("{:x}", reader.hash.finalize()))
}
