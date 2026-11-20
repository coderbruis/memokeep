//! A one-way Markdown projection. SQLite remains authoritative.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use dom_query::{Document, NodeRef};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::{connect, images, read_fields_on, read_records_on, Fields, Snapshot, StorageError};

mod queue;
pub use queue::enqueue_on;

const MANIFEST: &str = ".memokeep-sync.json";
const MAX_MANIFEST: u64 = 8 * 1024 * 1024;
const MAX_DOCUMENT: usize = 64 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum PublishingError {
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error("发布记录无法保存：{0}")]
    Sql(#[from] rusqlite::Error),
    #[error("Markdown 发布失败：{0}")]
    Io(#[from] std::io::Error),
    #[error("发布清单格式无效：{0}")]
    Json(#[from] serde_json::Error),
    #[error("发布目录必须是独立的本地目录")]
    InvalidDirectory,
    #[error("发布路径包含符号链接或无效组件")]
    UnsafePath,
    #[error("发布清单属于其他工作空间，已保留原文件")]
    ForeignManifest,
    #[error("另一个发布任务正在处理该目录")]
    Busy,
    #[error("笔记内容过大或嵌套过深")]
    ContentLimit,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub root: Option<String>,
    pub pending: bool,
    pub export_error: Option<String>,
    pub published_revision: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub root: Option<String>,
    pub files_written: usize,
    pub notes_rendered: usize,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u8,
    workspace: String,
    files: Vec<String>,
    entries: BTreeMap<String, String>,
    #[serde(default)]
    outputs: BTreeMap<String, Vec<String>>,
}

struct Lease {
    root: PathBuf,
    owner: String,
    token: String,
}

fn install(db: &Connection) -> Result<(), PublishingError> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS markdown_publishing (
        slot INTEGER PRIMARY KEY CHECK(slot=1), root TEXT NOT NULL, owner TEXT NOT NULL,
        pending INTEGER NOT NULL DEFAULT 1, export_error TEXT,
        published_revision INTEGER, lease TEXT, lease_started INTEGER
    )",
    )?;
    queue::install(db)?;
    Ok(())
}

fn lock_database(database: &Path) -> Result<fs::File, PublishingError> {
    let lock = database.with_extension("markdown.lock");
    if fs::symlink_metadata(&lock).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(PublishingError::UnsafePath);
    }
    let handle = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock)?;
    match handle.try_lock() {
        Ok(()) => Ok(handle),
        Err(fs::TryLockError::WouldBlock) => Err(PublishingError::Busy),
        Err(fs::TryLockError::Error(error)) => Err(error.into()),
    }
}

/// Stores an explicitly selected directory. Imported settings cannot authorize writes.
pub fn configure(database: &Path, directory: &Path) -> Result<Status, PublishingError> {
    let _guard = lock_database(database)?;
    if !directory.is_absolute()
        || fs::symlink_metadata(directory).is_ok_and(|entry| entry.file_type().is_symlink())
    {
        return Err(PublishingError::InvalidDirectory);
    }
    fs::create_dir_all(directory)?;
    let root = fs::canonicalize(directory)?;
    let db_path = fs::canonicalize(database)?;
    if db_path.starts_with(&root) || !fs::metadata(&root)?.is_dir() {
        return Err(PublishingError::InvalidDirectory);
    }
    let mut db = connect(database)?;
    install(&db)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute("INSERT INTO markdown_publishing(slot,root,owner) VALUES(1,?1,?2)
        ON CONFLICT(slot) DO UPDATE SET root=excluded.root,pending=1,export_error=NULL,published_revision=NULL,lease=NULL,lease_started=NULL",
        params![root.to_string_lossy(), Uuid::new_v4().to_string()])?;
    queue::full_on(&tx, crate::revision(&tx, "desktop")?)?;
    tx.commit()?;
    status(database)
}

pub fn status(database: &Path) -> Result<Status, PublishingError> {
    let db = connect(database)?;
    let empty = || Status {
        root: None,
        pending: false,
        export_error: None,
        published_revision: None,
    };
    let (configured_table, queue_tables): (bool, i64) = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='markdown_publishing'), (SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('markdown_publish_queue','markdown_publish_intent'))",
        [], |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if !configured_table
        || !db.query_row(
            "SELECT EXISTS(SELECT 1 FROM markdown_publishing WHERE slot=1)",
            [],
            |row| row.get::<_, bool>(0),
        )?
    {
        return Ok(empty());
    }
    // Compatibility installation happens once for an older configured workspace.
    // Ordinary background status polls execute reads only.
    if queue_tables != 2 {
        install(&db)?;
    }
    let status = db.query_row("SELECT root, pending<>0 OR published_revision IS NULL OR EXISTS(SELECT 1 FROM markdown_publish_queue),export_error,published_revision FROM markdown_publishing WHERE slot=1", [], |row| Ok(Status {
        root: Some(row.get(0)?), pending: row.get(1)?, export_error: row.get(2)?, published_revision: row.get(3)?,
    })).optional()?;
    Ok(status.unwrap_or_else(empty))
}

fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().min(i64::MAX as u64) as i64)
        .unwrap_or(0)
}

fn acquire(db: &mut Connection) -> Result<Option<Lease>, PublishingError> {
    install(db)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let lease = tx
        .query_row(
            "SELECT root,owner FROM markdown_publishing WHERE slot=1",
            [],
            |row| {
                Ok(Lease {
                    root: PathBuf::from(row.get::<_, String>(0)?),
                    owner: row.get(1)?,
                    token: Uuid::new_v4().to_string(),
                })
            },
        )
        .optional()?;
    let Some(lease) = lease else {
        let configured: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM markdown_publishing)",
            [],
            |row| row.get(0),
        )?;
        if configured {
            return Err(PublishingError::Busy);
        }
        return Ok(None);
    };
    tx.execute(
        "UPDATE markdown_publishing SET pending=1,lease=?1,lease_started=?2 WHERE slot=1",
        params![lease.token, unix_seconds()],
    )?;
    tx.commit()?;
    Ok(Some(lease))
}

/// Drains durable work from the background task, independently of save replies.
/// A failure is recorded independently of the already committed workspace data.
pub fn publish(database: &Path) -> Result<Report, PublishingError> {
    let _guard = lock_database(database)?;
    let mut db = connect(database)?;
    let Some(lease) = acquire(&mut db)? else {
        return Ok(Report {
            root: None,
            files_written: 0,
            notes_rendered: 0,
            warnings: Vec::new(),
        });
    };
    let result: Result<Report, PublishingError> = (|| {
        let (snapshot, plan) = {
            let tx = db.transaction()?;
            let mut plan = queue::plan(&tx)?;
            let snapshot = projection_snapshot(&tx, &mut plan, &lease)?;
            tx.commit()?;
            (snapshot, plan)
        };
        let report = export(&db, &snapshot, &lease, &plan)?;
        let warning = if report.warnings.is_empty() {
            None
        } else {
            Some(report.warnings.join("；"))
        };
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if report.warnings.is_empty() {
            tx.execute(
                "DELETE FROM markdown_publish_queue WHERE revision<=?1",
                [snapshot.revision],
            )?;
        }
        tx.execute(
            "DELETE FROM markdown_publish_intent WHERE root=?1 AND owner=?2",
            params![lease.root.to_string_lossy(), lease.owner],
        )?;
        tx.execute("UPDATE markdown_publishing SET lease=NULL,lease_started=NULL,published_revision=?1,pending=?2 OR EXISTS(SELECT 1 FROM markdown_publish_queue),export_error=?3 WHERE lease=?4", params![snapshot.revision, !report.warnings.is_empty(), warning, lease.token])?;
        tx.commit()?;
        Ok(report)
    })();
    if let Err(error) = &result {
        db.execute("UPDATE markdown_publishing SET lease=NULL,lease_started=NULL,pending=1,export_error=?1 WHERE lease=?2", params![error.to_string(), lease.token])?;
    }
    result
}

fn safe_path(root: &Path, relative: &Path) -> Result<PathBuf, PublishingError> {
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(PublishingError::UnsafePath);
    }
    if fs::symlink_metadata(root)?.file_type().is_symlink() || fs::canonicalize(root)? != root {
        return Err(PublishingError::UnsafePath);
    }
    let mut target = root.to_path_buf();
    for part in relative.components() {
        target.push(part.as_os_str());
        match fs::symlink_metadata(&target) {
            Ok(entry) if entry.file_type().is_symlink() => return Err(PublishingError::UnsafePath),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(target)
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn file_digest(file: &Path) -> Result<Option<String>, PublishingError> {
    match fs::symlink_metadata(file) {
        Ok(entry) if entry.file_type().is_symlink() => return Err(PublishingError::UnsafePath),
        Ok(entry) if !entry.is_file() => return Err(PublishingError::UnsafePath),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let mut file = fs::File::open(file)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let length = file.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        hash.update(&buffer[..length]);
    }
    Ok(Some(format!("{:x}", hash.finalize())))
}

fn atomic_write(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), PublishingError> {
    let target = safe_path(root, Path::new(relative))?;
    let parent = target.parent().ok_or(PublishingError::UnsafePath)?;
    fs::create_dir_all(parent)?;
    safe_path(root, Path::new(relative))?;
    let mut pending = tempfile::NamedTempFile::new_in(parent)?;
    pending.write_all(bytes)?;
    pending.as_file().sync_all()?;
    safe_path(root, Path::new(relative))?;
    pending
        .persist(&target)
        .map_err(|error| PublishingError::Io(error.error))?;
    Ok(())
}

fn load_manifest(lease: &Lease) -> Result<Manifest, PublishingError> {
    let path = safe_path(&lease.root, Path::new(MANIFEST))?;
    let empty = || Manifest {
        version: 3,
        workspace: lease.owner.to_owned(),
        files: Vec::new(),
        entries: BTreeMap::new(),
        outputs: BTreeMap::new(),
    };
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(empty()),
        Err(error) => return Err(error.into()),
    };
    if file.metadata()?.len() > MAX_MANIFEST {
        return Err(PublishingError::ContentLimit);
    }
    let mut bytes = Vec::new();
    file.take(MAX_MANIFEST + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_MANIFEST {
        return Err(PublishingError::ContentLimit);
    }
    let value: Value = serde_json::from_slice(&bytes)?;
    // Legacy manifests have no content digests. Existing files are adopted only
    // when their bytes exactly equal the next rendered projection.
    if value["version"] == 2 {
        return Ok(empty());
    }
    let manifest: Manifest = serde_json::from_value(value)?;
    if manifest.version != 3 || manifest.workspace != lease.owner {
        return Err(PublishingError::ForeignManifest);
    }
    Ok(manifest)
}

struct Output<'a> {
    key: String,
    relative: String,
    document: &'a Value,
}

fn rows<'a>(data: &'a Fields, key: &str) -> impl Iterator<Item = &'a Value> {
    data.get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}

fn component(value: &str, fallback: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| {
            if "\\/:*?\"<>|".contains(ch) || ch.is_control() {
                '-'
            } else {
                ch
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    let mut result = String::new();
    for ch in cleaned.chars() {
        if result.len() + ch.len_utf8() > 120 {
            break;
        }
        result.push(ch);
    }
    if result.is_empty() {
        fallback.to_owned()
    } else {
        result
    }
}

fn folder_path(data: &Fields, collection: &str, id: &str) -> PathBuf {
    let by_id: BTreeMap<_, _> = rows(data, collection)
        .map(|row| (text(row, "id"), row))
        .collect();
    let mut seen = BTreeSet::new();
    let mut segments = Vec::new();
    let mut current = id;
    while let Some(row) = by_id.get(current) {
        if !seen.insert(current) {
            break;
        }
        segments.push(component(text(row, "name"), "未命名目录"));
        current = text(row, "parentId");
    }
    segments.into_iter().rev().collect()
}

fn plain_text(document: &Value) -> bool {
    let metadata = &document["metadata"];
    metadata["fileType"] == "txt"
        || metadata["editorMode"] == "text"
        || document["sourceType"] == "manual-text"
        || text(document, "sourceFileName")
            .to_lowercase()
            .ends_with(".txt")
            && metadata["editorMode"] != "note"
}

fn rich_text(document: &Value) -> bool {
    !plain_text(document)
        && document["metadata"]["editorMode"] == "note"
        && document["metadata"]["noteContentInitialized"] == true
}

fn extension(document: &Value) -> &str {
    if plain_text(document) {
        return "txt";
    }
    if rich_text(document) {
        return "md";
    }
    let suffix = text(document, "sourceFileName")
        .rsplit('.')
        .next()
        .unwrap_or("");
    match suffix.to_ascii_lowercase().as_str() {
        "md" => "md",
        "markdown" => "markdown",
        "csv" => "csv",
        "tsv" => "tsv",
        "txt" => "txt",
        _ if document["sourceType"] == "table" => "csv",
        _ => "md",
    }
}

fn output_name(title: &str, id: &str, document: &Value) -> String {
    format!(
        "{}-{}.{}",
        component(title, "未命名笔记"),
        &digest(id.as_bytes())[..12],
        extension(document)
    )
}

fn outputs(data: &Fields) -> Vec<Output<'_>> {
    let mut result = Vec::new();
    for document in rows(data, "documents") {
        let library_id = text(document, "knowledgeBaseId");
        if !rows(data, "knowledgeBases").any(|library| text(library, "id") == library_id) {
            continue;
        }
        let relative = Path::new("知识库")
            .join(folder_path(data, "knowledgeBases", library_id))
            .join(output_name(
                text(document, "title"),
                text(document, "id"),
                document,
            ));
        result.push(Output {
            key: format!("document:{}", text(document, "id")),
            relative: relative.to_string_lossy().into_owned(),
            document,
        });
    }
    for notebook in rows(data, "cardNotebooks") {
        let source_id = text(notebook, "sourceDocumentId");
        let Some(document) = rows(data, "documents")
            .chain(rows(data, "cardDocuments"))
            .find(|row| text(row, "id") == source_id)
        else {
            continue;
        };
        let title = notebook["name"]
            .as_str()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| text(document, "title"));
        let relative = Path::new("记忆卡片")
            .join(folder_path(data, "cardFolders", text(notebook, "folderId")))
            .join(output_name(title, text(notebook, "id"), document));
        result.push(Output {
            key: format!("notebook:{}", text(notebook, "id")),
            relative: relative.to_string_lossy().into_owned(),
            document,
        });
    }
    result
}

fn projection_snapshot(
    db: &Connection,
    plan: &mut queue::Plan,
    lease: &Lease,
) -> Result<Snapshot, PublishingError> {
    let previous = load_manifest(lease)?;
    plan.full |= previous.outputs.is_empty()
        || (plan.documents.is_empty() && plan.card_documents.is_empty());
    let mut names = vec![
        "knowledgeBases".into(),
        "cardFolders".into(),
        "cardNotebooks".into(),
    ];
    if plan.full {
        names.extend(["documents".into(), "cardDocuments".into()]);
    }
    let mut snapshot = read_fields_on(db, "desktop", &names)?;
    if !plan.full {
        let ids: Vec<_> = plan
            .documents
            .union(&plan.card_documents)
            .map(String::to_owned)
            .collect();
        for field in ["documents", "cardDocuments"] {
            snapshot.data.insert(
                field.into(),
                serde_json::to_value(read_records_on(db, "desktop", field, &ids)?)?,
            );
        }
        let affected: BTreeSet<_> = plan
            .documents
            .union(&plan.card_documents)
            .map(String::as_str)
            .collect();
        if let Some(notebooks) = snapshot
            .data
            .get_mut("cardNotebooks")
            .and_then(Value::as_array_mut)
        {
            notebooks.retain(|notebook| affected.contains(text(notebook, "sourceDocumentId")));
        }
    }
    Ok(snapshot)
}

fn export(
    db: &Connection,
    snapshot: &Snapshot,
    lease: &Lease,
    plan: &queue::Plan,
) -> Result<Report, PublishingError> {
    let previous = load_manifest(lease)?;
    let mut next = Manifest {
        version: 3,
        workspace: lease.owner.to_owned(),
        files: Vec::new(),
        entries: BTreeMap::new(),
        outputs: BTreeMap::new(),
    };
    if !plan.full {
        // Unchanged projection ownership is retained without loading or rendering its notes.
        next.entries = previous.entries.clone();
        // Each output's files are needed to retain images shared by unchanged notes.
        next.outputs = previous.outputs.clone();
        for id in &plan.documents {
            next.outputs.remove(&format!("document:{id}"));
        }
        for notebook in rows(&snapshot.data, "cardNotebooks") {
            next.outputs
                .remove(&format!("notebook:{}", text(notebook, "id")));
        }
    }
    let mut warnings = Vec::new();
    let mut written = 0;
    let mut notes_rendered = 0;
    for output in outputs(&snapshot.data) {
        notes_rendered += 1;
        let mut rendered = Manifest {
            version: 3,
            workspace: lease.owner.to_owned(),
            files: Vec::new(),
            entries: BTreeMap::new(),
            outputs: BTreeMap::new(),
        };
        let content = if plain_text(output.document) {
            text(output.document, "content").to_owned()
        } else if rich_text(output.document) {
            rich_markdown(text(&output.document["metadata"], "noteContent"))?
        } else {
            text(output.document, "content").to_owned()
        };
        let content = if plain_text(output.document) {
            content
        } else {
            render_images(
                db,
                &content,
                &output.relative,
                lease,
                &mut rendered,
                &mut warnings,
                &mut written,
            )?
        };
        manage_file(
            db,
            lease,
            &output.relative,
            content.as_bytes(),
            &previous,
            &mut rendered,
            &mut warnings,
            &mut written,
        )?;
        next.outputs.insert(output.key, rendered.files);
        next.entries.extend(rendered.entries);
    }
    let retained: BTreeSet<_> = next
        .outputs
        .values()
        .flatten()
        .map(String::as_str)
        .collect();
    next.entries
        .retain(|relative, _| retained.contains(relative.as_str()));
    // Notes are installed before old paths are removed. A failed render never
    // deletes the previous exported copy during a rename or folder move.
    for (relative, expected) in &previous.entries {
        if next.entries.contains_key(relative) {
            continue;
        }
        let path = safe_path(&lease.root, Path::new(relative))?;
        if let Some(current) = file_digest(&path)? {
            if &current == expected {
                fs::remove_file(path)?;
            } else {
                warnings.push(format!("已保留外部修改的文件：{relative}"));
            }
        }
    }
    next.files = next.entries.keys().map(String::to_owned).collect();
    let manifest = serde_json::to_vec_pretty(&next)?;
    if manifest.len() as u64 > MAX_MANIFEST {
        return Err(PublishingError::ContentLimit);
    }
    let current = fs::read(safe_path(&lease.root, Path::new(MANIFEST))?).ok();
    if current.as_deref() != Some(manifest.as_slice()) {
        atomic_write(&lease.root, MANIFEST, &manifest)?;
    }
    Ok(Report {
        root: Some(lease.root.to_string_lossy().into_owned()),
        files_written: written,
        notes_rendered,
        warnings,
    })
}

#[allow(clippy::too_many_arguments)]
fn manage_file(
    db: &Connection,
    lease: &Lease,
    relative: &str,
    bytes: &[u8],
    previous: &Manifest,
    next: &mut Manifest,
    warnings: &mut Vec<String>,
    written: &mut usize,
) -> Result<(), PublishingError> {
    let path = safe_path(&lease.root, Path::new(relative))?;
    let expected = digest(bytes);
    let existing = file_digest(&path)?;
    if let Some(existing) = existing.as_ref() {
        let recovery = queue::intended(
            db,
            &lease.root.to_string_lossy(),
            &lease.owner,
            relative,
            existing,
        )?;
        if existing != &expected && previous.entries.get(relative) != Some(existing) && !recovery {
            warnings.push(format!("已保留外部修改的文件：{relative}"));
            if let Some(prior) = previous.entries.get(relative) {
                next.entries.insert(relative.to_owned(), prior.to_owned());
            }
            next.files.push(relative.to_owned());
            return Ok(());
        }
    }
    if existing.as_ref() != Some(&expected) {
        queue::intent(
            db,
            &lease.root.to_string_lossy(),
            &lease.owner,
            relative,
            &expected,
        )?;
        atomic_write(&lease.root, relative, bytes)?;
        *written += 1;
    }
    next.files.push(relative.to_owned());
    next.entries.insert(relative.to_owned(), expected);
    Ok(())
}

fn render_images(
    db: &Connection,
    content: &str,
    note_path: &str,
    lease: &Lease,
    next: &mut Manifest,
    warnings: &mut Vec<String>,
    written: &mut usize,
) -> Result<String, PublishingError> {
    let mut result = String::new();
    let mut remaining = content;
    while let Some(position) = remaining.to_ascii_lowercase().find("memokeep-image://") {
        result.push_str(&remaining[..position]);
        remaining = &remaining[position..];
        let reference_end = "memokeep-image://".len() + 36;
        if !remaining.is_char_boundary(reference_end) || remaining.len() < reference_end {
            result.push_str(remaining);
            return Ok(result);
        }
        let candidate = &remaining["memokeep-image://".len()..reference_end];
        let id = match images::checked_id(candidate) {
            Ok(id) => id,
            Err(_) => {
                result.push_str("memokeep-image://");
                remaining = &remaining["memokeep-image://".len()..];
                continue;
            }
        };
        let image = images::read_bytes(db, &id)?;
        if let Some(image) = image {
            let (extension, _) = images::image_type(&image)?;
            let relative = format!("images/{id}.{extension}");
            let path = safe_path(&lease.root, Path::new(&relative))?;
            let expected = digest(&image);
            if let Some(found) = file_digest(&path)? {
                if found != expected {
                    warnings.push(format!("已保留外部修改的图片：{relative}"));
                    result.push_str(&remaining[..reference_end]);
                    remaining = &remaining[reference_end..];
                    continue;
                }
            } else {
                atomic_write(&lease.root, &relative, &image)?;
                *written += 1;
            }
            if !next.entries.contains_key(&relative) {
                next.files.push(relative.to_owned());
                next.entries.insert(relative.to_owned(), expected);
            }
            for _ in 0..Path::new(note_path)
                .parent()
                .map_or(0, |parent| parent.components().count())
            {
                result.push_str("../");
            }
            result.push_str(&relative);
        } else {
            warnings.push(format!("图片不存在，已保留引用：{id}"));
            result.push_str(&remaining[..reference_end]);
        }
        remaining = &remaining[reference_end..];
    }
    result.push_str(remaining);
    Ok(result)
}

fn children_markdown(node: NodeRef<'_>, depth: usize) -> Result<String, PublishingError> {
    node.children_it(false)
        .map(|child| markdown_node(child, depth + 1))
        .collect()
}

fn fence(content: &str, language: &str) -> String {
    let maximum = content
        .split(|ch| ch != '`')
        .map(str::len)
        .max()
        .unwrap_or(0);
    let marker = "`".repeat((maximum + 1).max(3));
    let ending = if content.ends_with('\n') { "" } else { "\n" };
    format!("\n\n{marker}{language}\n{content}{ending}{marker}\n\n")
}

fn language(node: NodeRef<'_>) -> String {
    let from_attribute = node.attr("data-language").map(|value| value.to_string());
    let class = node.attr("class");
    let value = from_attribute
        .as_deref()
        .or_else(|| {
            class.as_ref().and_then(|value| {
                value
                    .split_whitespace()
                    .find_map(|part| part.strip_prefix("language-"))
            })
        })
        .unwrap_or("");
    if value == "plain"
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        String::new()
    } else {
        value.to_owned()
    }
}

fn safe_url(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    !lower.starts_with("javascript:")
        && !lower.starts_with("data:")
        && !lower.starts_with("file:")
        && !lower.starts_with("vbscript:")
}

fn list_indent(node: NodeRef<'_>) -> usize {
    let quill = node
        .attr("class")
        .and_then(|class| {
            class
                .split_whitespace()
                .find_map(|part| part.strip_prefix("ql-indent-"))
                .and_then(|number| number.parse::<usize>().ok())
        })
        .unwrap_or(0);
    let nested = node
        .ancestors(None)
        .iter()
        .filter(|parent| parent.node_name().is_some_and(|name| name.as_ref() == "li"))
        .count();
    (quill + nested).min(32)
}

fn previous_list_items(node: NodeRef<'_>) -> usize {
    let mut previous = node.prev_element_sibling();
    let level = list_indent(node);
    let list_type = node.attr("data-list");
    let mut count = 0;
    while let Some(sibling) = previous {
        let sibling_level = list_indent(sibling);
        if sibling_level < level {
            break;
        }
        if sibling_level == level {
            if sibling.attr("data-list") != list_type {
                break;
            }
            if sibling
                .node_name()
                .is_some_and(|name| name.as_ref() == "li")
            {
                count += 1;
            }
        }
        previous = sibling.prev_element_sibling();
    }
    count
}

fn markdown_node(node: NodeRef<'_>, depth: usize) -> Result<String, PublishingError> {
    if depth > 128 {
        return Err(PublishingError::ContentLimit);
    }
    if node.is_text() {
        let mut output = String::new();
        let mut spaced = false;
        for ch in node.text().chars() {
            if ch.is_whitespace() {
                if !spaced {
                    output.push(' ');
                }
                spaced = true;
            } else {
                if "\\*[]_".contains(ch) {
                    output.push('\\');
                }
                output.push(ch);
                spaced = false;
            }
        }
        return Ok(output);
    }
    let name = node
        .node_name()
        .map(|name| name.to_string())
        .unwrap_or_default();
    if matches!(
        name.as_str(),
        "script" | "style" | "iframe" | "object" | "svg"
    ) || node.has_class("ql-ui")
    {
        return Ok(String::new());
    }
    if name == "pre" {
        return Ok(fence(
            &node.text(),
            &language(
                node.children_it(false)
                    .find(|child| child.is_element())
                    .unwrap_or(node),
            ),
        ));
    }
    if node.has_class("ql-code-block-container") {
        let mut output = String::new();
        let mut current_language = String::new();
        let mut lines = Vec::new();
        for line in node.children_it(false).filter(|line| line.is_element()) {
            let selected_language = language(line);
            if !lines.is_empty() && selected_language != current_language {
                output.push_str(&fence(&lines.join("\n"), &current_language));
                lines.clear();
            }
            current_language = selected_language;
            lines.push(line.text().to_string());
        }
        if !lines.is_empty() {
            output.push_str(&fence(&lines.join("\n"), &current_language));
        }
        return Ok(output);
    }
    if name == "table" {
        let mut rows = Vec::new();
        for row in node
            .descendants_it()
            .filter(|child| child.node_name().is_some_and(|name| name.as_ref() == "tr"))
        {
            let cells = row
                .children_it(false)
                .filter(|cell| {
                    cell.node_name()
                        .is_some_and(|name| name.as_ref() == "td" || name.as_ref() == "th")
                })
                .map(|cell| {
                    children_markdown(cell, depth + 1)
                        .map(|content| content.trim().replace('\n', "<br>").replace('|', "\\|"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            if !cells.is_empty() {
                rows.push(cells);
            }
        }
        let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
        let format_row = |cells: &[String]| {
            format!(
                "| {} |\n",
                (0..columns)
                    .map(|index| cells.get(index).map_or("", String::as_str))
                    .collect::<Vec<_>>()
                    .join(" | ")
            )
        };
        let Some(first) = rows.first() else {
            return Ok(String::new());
        };
        let mut output = format!(
            "\n\n{}{}",
            format_row(first),
            format_row(&vec!["---".into(); columns])
        );
        for row in rows.iter().skip(1) {
            output.push_str(&format_row(row));
        }
        return Ok(output + "\n");
    }
    if name == "img" {
        let src = node
            .attr("src")
            .map(|value| value.to_string())
            .unwrap_or_default();
        if !safe_url(&src)
            && ![
                "data:image/png;base64,",
                "data:image/jpeg;base64,",
                "data:image/gif;base64,",
                "data:image/webp;base64,",
            ]
            .iter()
            .any(|prefix| src.starts_with(prefix))
        {
            return Ok(String::new());
        }
        let alt = node
            .attr("alt")
            .map(|value| value.replace(['[', ']'], ""))
            .unwrap_or_default();
        return Ok(format!(
            "![{alt}]({})",
            src.replace('(', "%28").replace(')', "%29")
        ));
    }
    let content = children_markdown(node, depth)?;
    Ok(match name.as_str() {
        "h1" => format!("\n\n# {}\n\n", content.trim()),
        "h2" => format!("\n\n## {}\n\n", content.trim()),
        "h3" => format!("\n\n### {}\n\n", content.trim()),
        "h4" => format!("\n\n#### {}\n\n", content.trim()),
        "h5" => format!("\n\n##### {}\n\n", content.trim()),
        "h6" => format!("\n\n###### {}\n\n", content.trim()),
        "p" | "div" => format!("\n\n{}\n\n", content.trim()),
        "strong" | "b" => format!("**{content}**"),
        "em" | "i" => format!("*{content}*"),
        "s" | "del" | "strike" => format!("~~{content}~~"),
        "u" => format!("<u>{content}</u>"),
        "br" => "  \n".into(),
        "hr" => "\n\n---\n\n".into(),
        "code" => {
            let raw = node.text();
            let maximum = raw.split(|ch| ch != '`').map(str::len).max().unwrap_or(0);
            let marker = "`".repeat(maximum + 1);
            format!("{marker}{raw}{marker}")
        }
        "a" => {
            let href = node
                .attr("href")
                .map(|value| value.to_string())
                .unwrap_or_default();
            if safe_url(&href) {
                format!(
                    "[{content}]({})",
                    href.replace('(', "%28").replace(')', "%29")
                )
            } else {
                content
            }
        }
        "blockquote" => format!(
            "\n\n{}\n\n",
            content
                .trim()
                .lines()
                .map(|line| format!("> {line}"))
                .collect::<Vec<_>>()
                .join("\n")
        ),
        "li" => {
            let level = list_indent(node);
            let list_type = node
                .attr("data-list")
                .map(|value| value.to_string())
                .unwrap_or_default();
            let marker = match list_type.as_str() {
                "checked" => "- [x] ".into(),
                "unchecked" => "- [ ] ".into(),
                "ordered" => format!("{}. ", 1 + previous_list_items(node)),
                _ if node.parent().is_some_and(|parent| {
                    parent.node_name().is_some_and(|name| name.as_ref() == "ol")
                }) && list_type.is_empty() =>
                {
                    format!("{}. ", 1 + previous_list_items(node))
                }
                _ => "- ".into(),
            };
            let padding = "    ".repeat(level);
            format!("{padding}{marker}{}\n", content.trim())
        }
        "ul" | "ol" => format!("\n\n{}\n\n", content.trim_end()),
        _ => content,
    })
}

/// Converts shared rich-note HTML to Markdown without executing embedded content.
pub fn rich_markdown(html: &str) -> Result<String, PublishingError> {
    if html.len() > MAX_DOCUMENT {
        return Err(PublishingError::ContentLimit);
    }
    let document = Document::from(html);
    let source = document.select("body");
    let root = source
        .nodes()
        .first()
        .copied()
        .unwrap_or_else(|| document.html_root());
    let converted = children_markdown(root, 0)?;
    // Consolidate structural block separators, while preserving fenced-code lines.
    let mut output = String::new();
    let mut fence_marker = None;
    let mut newlines = 0;
    for line in converted.trim().lines() {
        let marker = line.trim_start();
        if marker.starts_with("```") {
            if fence_marker
                .as_deref()
                .is_some_and(|open: &str| marker == open)
            {
                fence_marker = None;
            } else if fence_marker.is_none() {
                fence_marker = Some(marker.trim_end_matches(|ch: char| ch != '`').to_owned());
            }
        }
        if line.is_empty() && fence_marker.is_none() {
            newlines += 1;
            if newlines > 1 {
                continue;
            }
        } else {
            newlines = 0;
        }
        output.push_str(line);
        output.push('\n');
    }
    Ok(output)
}
