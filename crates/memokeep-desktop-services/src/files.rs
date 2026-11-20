//! Device-local file-open queue and explicit source-directory grants.
//! Paths and grants never enter workspace business data, exports, or sync queues.
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use url::Url;
use uuid::Uuid;

pub const MAX_BYTES: usize = 5 * 1024 * 1024;
const BRIDGE_BUDGET: usize = 8 * 1024 * 1024;
const MAX_PENDING: i64 = 256;
const OVERFLOW_KEY: &str = "notice:overflow";
const GRANT_LIFETIME: i64 = 24 * 60 * 60 * 1000;
const CONFIRM_LIFETIME: i64 = 5 * 60 * 1000;

#[derive(Debug, Error)]
pub enum FileError {
    #[error("文件队列无法读取：{0}")]
    Database(#[from] rusqlite::Error),
    #[error("工作空间内容无法读取：{0}")]
    Json(#[from] serde_json::Error),
    #[error("文件无法读取或保存：{0}")]
    Io(#[from] std::io::Error),
    #[error("仅支持本机 Markdown 和文本文件")]
    InvalidSource,
    #[error("文件或原目录已变化，请重新打开文件")]
    SourceChanged,
    #[error("文件授权已失效，请重新打开文件")]
    InvalidGrant,
    #[error("文件名无效")]
    InvalidName,
    #[error("文件超过 5 MB，没有打开")]
    TooLarge,
    #[error("文件不是有效的 UTF-8 文本")]
    InvalidUtf8,
    #[error("不允许读取或覆盖符号链接")]
    Symlink,
    #[error("目标文件已变化，请重新确认保存")]
    TargetChanged,
    #[error("当前平台尚不支持安全的原目录保存")]
    Unsupported,
    #[error("该目录正在保存文件，请稍后重试")]
    SaveInProgress,
    #[error("上次保存的本机回执尚未补记，请稍后重试")]
    ReceiptPending,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    System,
    Drop,
}
impl Origin {
    fn name(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Drop => "drop",
        }
    }
    fn parse(value: &str) -> Self {
        if value == "drop" {
            Self::Drop
        } else {
            Self::System
        }
    }
}

#[derive(Debug, Serialize)]
pub struct EnqueueError {
    pub name: String,
    pub error: String,
}
#[derive(Debug, Default, Serialize)]
pub struct EnqueueReport {
    pub added: usize,
    pub deduplicated: usize,
    pub ignored: usize,
    pub overflow: bool,
    pub errors: Vec<EnqueueError>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    pub id: String,
    pub name: String,
    pub content: Option<String>,
    pub id_prefix: String,
    pub token: Option<String>,
    pub error: Option<String>,
    pub origin: Origin,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub saved: bool,
    pub name: String,
    pub confirmation: Option<String>,
    pub receipt_pending: bool,
    pub warning: Option<String>,
}

struct Grant {
    token: String,
    source: PathBuf,
    parent: PathBuf,
    name: String,
    parent_identity: String,
    source_identity: String,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|at| at.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn new_token() -> String {
    Uuid::new_v4().to_string()
}

fn connect(path: &Path) -> Result<Connection, FileError> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    db.busy_timeout(Duration::from_secs(5))?;
    db.execute_batch("PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS desktop_file_grant(
        token TEXT PRIMARY KEY,source TEXT NOT NULL,parent TEXT NOT NULL,name TEXT NOT NULL,
        parent_identity TEXT NOT NULL,source_identity TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,expires_at INTEGER);
      CREATE TABLE IF NOT EXISTS desktop_file_queue(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,source_key TEXT NOT NULL,
        grant_token TEXT REFERENCES desktop_file_grant(token) ON DELETE SET NULL,
        name TEXT NOT NULL,id_prefix TEXT NOT NULL,origin TEXT NOT NULL,error_text TEXT,status TEXT NOT NULL,acked_at INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS desktop_file_pending_path ON desktop_file_queue(source_key) WHERE status='pending';
      CREATE TABLE IF NOT EXISTS desktop_file_confirmation(
        id TEXT PRIMARY KEY,grant_token TEXT NOT NULL,name TEXT NOT NULL,target_fingerprint TEXT NOT NULL,
        content_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS desktop_file_save_intent(
        id TEXT PRIMARY KEY,resource_key TEXT NOT NULL,grant_token TEXT NOT NULL,name TEXT NOT NULL,
        content_hash TEXT NOT NULL,previous_fingerprint TEXT,state TEXT NOT NULL,created_at INTEGER NOT NULL,
        finished_at INTEGER,last_error TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS desktop_file_save_pending ON desktop_file_save_intent(resource_key) WHERE state='prepared';")?;
    Ok(db)
}

fn supported(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "md" | "markdown" | "txt"
            )
        })
}
fn input_path(source: &str, cwd: Option<&Path>) -> Result<Option<PathBuf>, FileError> {
    if source.is_empty() || source.starts_with('-') {
        return Ok(None);
    }
    if source.len() > 16 * 1024 {
        return Err(FileError::InvalidSource);
    }
    let path = if source.starts_with("file:") {
        let url = Url::parse(source).map_err(|_| FileError::InvalidSource)?;
        if url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || url
                .host_str()
                .is_some_and(|host| !host.is_empty() && host != "localhost")
        {
            return Err(FileError::InvalidSource);
        }
        url.to_file_path().map_err(|_| FileError::InvalidSource)?
    } else {
        if source.contains("://") {
            return Err(FileError::InvalidSource);
        }
        let path = PathBuf::from(source);
        if path.is_absolute() {
            path
        } else {
            cwd.unwrap_or(Path::new(".")).join(path)
        }
    };
    Ok(supported(&path).then_some(path))
}

#[cfg(unix)]
fn identity(metadata: &fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!("{}:{}", metadata.dev(), metadata.ino())
}
#[cfg(not(unix))]
fn identity(_metadata: &fs::Metadata) -> String {
    String::new()
}

#[cfg(unix)]
fn open_directory(grant: &Grant) -> Result<File, FileError> {
    use rustix::fs::{open, Mode, OFlags};
    let directory: File = open(
        &grant.parent,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(std::io::Error::from)?
    .into();
    if identity(&directory.metadata()?) != grant.parent_identity {
        return Err(FileError::SourceChanged);
    }
    Ok(directory)
}
#[cfg(not(unix))]
fn open_directory(_grant: &Grant) -> Result<File, FileError> {
    Err(FileError::Unsupported)
}

#[cfg(unix)]
fn open_child(directory: &File, name: &str) -> Result<File, FileError> {
    use rustix::fs::{openat, Mode, OFlags};
    let file: File = openat(
        directory,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| {
        if error == rustix::io::Errno::LOOP {
            FileError::Symlink
        } else {
            FileError::Io(error.into())
        }
    })?
    .into();
    if !file.metadata()?.is_file() {
        return Err(FileError::InvalidSource);
    }
    Ok(file)
}
#[cfg(not(unix))]
fn open_child(_directory: &File, _name: &str) -> Result<File, FileError> {
    Err(FileError::Unsupported)
}

fn read_text(file: &mut File) -> Result<String, FileError> {
    let before = file.metadata()?;
    if before.len() > MAX_BYTES as u64 {
        return Err(FileError::TooLarge);
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > MAX_BYTES {
        return Err(FileError::TooLarge);
    }
    let after = file.metadata()?;
    if before.len() != after.len() || before.modified()? != after.modified()? {
        return Err(FileError::SourceChanged);
    }
    let text = String::from_utf8(bytes).map_err(|_| FileError::InvalidUtf8)?;
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned())
}

fn prepare(path: &Path) -> Result<Grant, FileError> {
    let original = fs::symlink_metadata(path)?;
    if original.file_type().is_symlink() {
        return Err(FileError::Symlink);
    }
    if !original.is_file() {
        return Err(FileError::InvalidSource);
    }
    if original.len() > MAX_BYTES as u64 {
        return Err(FileError::TooLarge);
    }
    let source = path.canonicalize()?;
    let rechecked = fs::symlink_metadata(path)?;
    if rechecked.file_type().is_symlink() || identity(&original) != identity(&rechecked) {
        return Err(FileError::SourceChanged);
    }
    let parent = source
        .parent()
        .ok_or(FileError::InvalidSource)?
        .to_path_buf();
    let name = source
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or(FileError::InvalidSource)?
        .to_owned();
    if !supported(&source) || source.to_str().is_none() || parent.to_str().is_none() {
        return Err(FileError::InvalidSource);
    }
    let grant = Grant {
        token: new_token(),
        source,
        parent_identity: identity(&fs::metadata(&parent)?),
        source_identity: identity(&original),
        parent,
        name,
    };
    let directory = open_directory(&grant)?;
    if identity(&open_child(&directory, &grant.name)?.metadata()?) != grant.source_identity {
        return Err(FileError::SourceChanged);
    }
    Ok(grant)
}

fn published_id(db: &Connection, path: &Path, root: Option<&Path>) -> Result<String, FileError> {
    let Some(root) = root.and_then(|root| root.canonicalize().ok()) else {
        return Ok(String::new());
    };
    if !path
        .strip_prefix(&root)
        .is_ok_and(|relative| !relative.as_os_str().is_empty())
    {
        return Ok(String::new());
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    // Current publishing uses a stable hash suffix rather than exposing the note ID.
    let suffix = stem.rsplit('-').next().unwrap_or("");
    let mut statement = db.prepare("SELECT payload FROM workspace_field WHERE scope='desktop' AND field IN ('documents','cardDocuments')")?;
    let values = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut matching_id: Option<String> = None;
    for encoded in values {
        let value: Value = serde_json::from_str(&encoded)?;
        for document in value.as_array().into_iter().flatten() {
            let Some(id) = document["id"].as_str() else {
                continue;
            };
            if id.is_empty() || id.len() > 512 {
                continue;
            }
            let hexadecimal = suffix.bytes().all(|byte| byte.is_ascii_hexdigit());
            if (suffix.len() == 12 && hexadecimal && hash(id.as_bytes()).starts_with(suffix))
                || stem.ends_with(&format!("-{id}"))
                || (suffix.len() == 8
                    && hexadecimal
                    && id
                        .to_ascii_lowercase()
                        .starts_with(&suffix.to_ascii_lowercase()))
            {
                if matching_id.as_deref().is_some_and(|prior| prior != id) {
                    return Ok(String::new());
                }
                matching_id = Some(id.to_owned());
            }
        }
    }
    Ok(matching_id.unwrap_or_default())
}

/// Only native OS events / native drag paths may call this function. Renderers receive tokens.
pub fn enqueue(
    database: &Path,
    sources: &[String],
    cwd: Option<&Path>,
    origin: Origin,
    publish_root: Option<&Path>,
) -> Result<EnqueueReport, FileError> {
    let mut db = connect(database)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut report = EnqueueReport::default();
    let at = now();
    tx.execute(
        "DELETE FROM desktop_file_confirmation WHERE expires_at<?1 OR consumed=1",
        [at],
    )?;
    tx.execute(
        "DELETE FROM desktop_file_queue WHERE status='acked' AND acked_at<?1",
        [at - 30 * GRANT_LIFETIME],
    )?;
    tx.execute("DELETE FROM desktop_file_grant WHERE expires_at<?1", [at])?;
    for source in sources {
        let parsed = input_path(source, cwd);
        if matches!(parsed, Ok(None)) {
            report.ignored += 1;
            continue;
        }
        let raw_path = match &parsed {
            Ok(Some(path)) => path.to_path_buf(),
            _ => PathBuf::from(source),
        };
        let name = raw_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("文件")
            .chars()
            .take(255)
            .collect::<String>();
        let prepared = parsed.and_then(|path| prepare(&path.ok_or(FileError::InvalidSource)?));
        let source_key = hash(
            prepared
                .as_ref()
                .map(|grant| grant.source.to_string_lossy())
                .unwrap_or_else(|_| raw_path.to_string_lossy())
                .as_bytes(),
        );
        if tx
            .query_row(
                "SELECT 1 FROM desktop_file_queue WHERE source_key=?1 AND status='pending'",
                [&source_key],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            report.deduplicated += 1;
            continue;
        }
        let pending: i64 = tx.query_row(
            "SELECT count(*) FROM desktop_file_queue WHERE status='pending' AND source_key<>?1",
            [OVERFLOW_KEY],
            |r| r.get(0),
        )?;
        if pending >= MAX_PENDING {
            const MESSAGE: &str =
                "待打开文件过多，请先处理当前文件，再重新打开未加入队列的其余文件。";
            // This single durable notice remains visible across cold startup and
            // is acknowledged through the same channel as ordinary file errors.
            let added = tx.execute("INSERT OR IGNORE INTO desktop_file_queue(id,source_key,name,id_prefix,origin,error_text,status) VALUES(?1,?2,'文件打开提示','','system',?3,'pending')",params![new_token(),OVERFLOW_KEY,MESSAGE])?;
            if !report.overflow {
                report.errors.push(EnqueueError {
                    name: "文件打开提示".into(),
                    error: MESSAGE.into(),
                });
            }
            report.overflow = true;
            report.added += added;
            continue;
        }
        let id = new_token();
        match prepared {
            Ok(grant) => {
                let id_prefix = published_id(&tx, &grant.source, publish_root)?;
                tx.execute("INSERT INTO desktop_file_grant(token,source,parent,name,parent_identity,source_identity) VALUES(?1,?2,?3,?4,?5,?6)", params![grant.token,grant.source.to_str(),grant.parent.to_str(),grant.name,grant.parent_identity,grant.source_identity])?;
                tx.execute("INSERT INTO desktop_file_queue(id,source_key,grant_token,name,id_prefix,origin,status) VALUES(?1,?2,?3,?4,?5,?6,'pending')", params![id,source_key,grant.token,grant.name,id_prefix,origin.name()])?;
            }
            Err(error) => {
                let message = match &error {
                    FileError::Io(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        "文件不存在".into()
                    }
                    _ => error.to_string(),
                };
                tx.execute("INSERT INTO desktop_file_queue(id,source_key,name,id_prefix,origin,error_text,status) VALUES(?1,?2,?3,'',?4,?5,'pending')", params![id,source_key,name,origin.name(),message])?;
                report.errors.push(EnqueueError {
                    name,
                    error: message,
                });
            }
        }
        report.added += 1;
    }
    tx.commit()?;
    Ok(report)
}

fn read_grant(db: &Connection, token: &str) -> Result<Grant, FileError> {
    if token.len() > 128 {
        return Err(FileError::InvalidGrant);
    }
    db.query_row("SELECT source,parent,name,parent_identity,source_identity FROM desktop_file_grant WHERE token=?1 AND revoked=0 AND (expires_at IS NULL OR expires_at>=?2)", params![token,now()], |row| Ok(Grant { token: token.to_owned(), source: PathBuf::from(row.get::<_,String>(0)?), parent: PathBuf::from(row.get::<_,String>(1)?), name: row.get(2)?, parent_identity: row.get(3)?, source_identity: row.get(4)? })).optional()?.ok_or(FileError::InvalidGrant)
}

pub fn pending(database: &Path) -> Result<Vec<OpenedFile>, FileError> {
    let db = connect(database)?;
    let mut statement = db.prepare("SELECT id,grant_token,name,id_prefix,origin,error_text FROM desktop_file_queue WHERE status='pending' ORDER BY CASE WHEN source_key='notice:overflow' THEN 0 ELSE 1 END,seq LIMIT 32")?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut result = Vec::new();
    let mut budget = 0;
    for (id, grant_token, name, id_prefix, origin, saved_error) in rows {
        let outcome = if let Some(error) = saved_error {
            Err(error)
        } else {
            grant_token
                .as_deref()
                .ok_or(FileError::InvalidGrant)
                .and_then(|token| read_grant(&db, token))
                .and_then(|grant| {
                    let directory = open_directory(&grant)?;
                    let mut file = open_child(&directory, &grant.name)?;
                    if identity(&file.metadata()?) != grant.source_identity {
                        return Err(FileError::SourceChanged);
                    }
                    read_text(&mut file)
                })
                .map_err(|error| error.to_string())
        };
        let (content, error) = match outcome {
            Ok(content) => (Some(content), None),
            Err(error) => (None, Some(error)),
        };
        let size = content.as_ref().map_or(0, String::len);
        if !result.is_empty() && budget + size > BRIDGE_BUDGET {
            break;
        }
        budget += size;
        result.push(OpenedFile {
            id,
            name,
            content,
            id_prefix,
            token: if error.is_none() { grant_token } else { None },
            error,
            origin: Origin::parse(&origin),
        });
    }
    Ok(result)
}

/// Acknowledging a queue item does not revoke a preview's source-directory grant.
pub fn acknowledge(database: &Path, id: &str) -> Result<bool, FileError> {
    let mut db = connect(database)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let key: Option<String> = tx
        .query_row(
            "SELECT grant_token FROM desktop_file_queue WHERE id=?1 AND status='pending'",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let changed = tx.execute(
        "UPDATE desktop_file_queue SET status='acked',acked_at=?2 WHERE id=?1 AND status='pending'",
        params![id, now()],
    )?;
    if let Some(key) = key {
        tx.execute(
            "UPDATE desktop_file_grant SET expires_at=?2 WHERE token=?1 AND expires_at IS NULL",
            params![key, now() + GRANT_LIFETIME],
        )?;
    }
    tx.commit()?;
    Ok(changed > 0)
}
pub fn revoke(database: &Path, token: &str) -> Result<bool, FileError> {
    let db = connect(database)?;
    Ok(db.execute(
        "UPDATE desktop_file_grant SET revoked=1 WHERE token=?1 AND revoked=0",
        [token],
    )? > 0)
}

fn validate_name(name: &str) -> Result<(), FileError> {
    if name.is_empty()
        || name.len() > 240
        || name.contains(['/', '\\', ':'])
        || name.chars().any(char::is_control)
        || Path::new(name).components().count() != 1
        || !matches!(
            Path::new(name).components().next(),
            Some(Component::Normal(_))
        )
        || !supported(Path::new(name))
    {
        return Err(FileError::InvalidName);
    }
    Ok(())
}
struct TargetSnapshot {
    fingerprint: String,
    content_hash: String,
    identity: String,
}

fn snapshot(file: &mut File) -> Result<TargetSnapshot, FileError> {
    let before = file.metadata()?;
    if before.len() > MAX_BYTES as u64 {
        return Err(FileError::TooLarge);
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > MAX_BYTES {
        return Err(FileError::TooLarge);
    }
    let after = file.metadata()?;
    if before.len() != after.len() || before.modified()? != after.modified()? {
        return Err(FileError::SourceChanged);
    }
    std::str::from_utf8(&bytes).map_err(|_| FileError::InvalidUtf8)?;
    let identity = identity(&before);
    let content_hash = hash(&bytes);
    Ok(TargetSnapshot {
        fingerprint: format!(
            "{identity}:{}:{:?}:{content_hash}",
            before.len(),
            before.modified()?
        ),
        content_hash,
        identity,
    })
}

fn target(directory: &File, name: &str) -> Result<Option<TargetSnapshot>, FileError> {
    match open_child(directory, name) {
        Ok(mut file) => Ok(Some(snapshot(&mut file)?)),
        Err(FileError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn fingerprint(file: &mut File) -> Result<String, FileError> {
    Ok(snapshot(file)?.fingerprint)
}

fn lock_directory(directory: &File) -> Result<(), FileError> {
    // This short-lived advisory lock serializes cooperating MemoKeep instances
    // even while the durable SQLite intent is committed before filesystem I/O.
    match directory.try_lock() {
        Ok(()) => Ok(()),
        Err(fs::TryLockError::WouldBlock) => Err(FileError::SaveInProgress),
        Err(fs::TryLockError::Error(error)) => Err(error.into()),
    }
}

#[cfg(unix)]
fn write_atomic(
    directory: &File,
    name: &str,
    content: &str,
    existing: Option<&str>,
) -> Result<Option<String>, FileError> {
    use rustix::fs::{openat, renameat_with, unlinkat, AtFlags, Mode, OFlags, RenameFlags};
    let temporary = format!(".memokeep-save-{}", new_token());
    let mut file: File = openat(
        directory,
        temporary.as_str(),
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_bits_truncate(0o600),
    )
    .map_err(std::io::Error::from)?
    .into();
    let publish = (|| {
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        if let Some(expected) = existing {
            let actual = fingerprint(&mut open_child(directory, name)?)?;
            if actual != expected {
                return Err(FileError::TargetChanged);
            }
            // Both paths are anchored to the opened directory. External editors
            // may still change a target independently of this device-local journal.
            rustix::fs::renameat(directory, temporary.as_str(), directory, name)
                .map_err(std::io::Error::from)?;
        } else {
            renameat_with(
                directory,
                temporary.as_str(),
                directory,
                name,
                RenameFlags::NOREPLACE,
            )
            .map_err(|error| {
                if error == rustix::io::Errno::EXIST {
                    FileError::TargetChanged
                } else {
                    FileError::Io(error.into())
                }
            })?;
        }
        Ok::<_, FileError>(())
    })();
    if publish.is_err() {
        let _ = unlinkat(directory, temporary.as_str(), AtFlags::empty());
    }
    publish?;
    // Rename has already happened. A durability error cannot honestly be
    // reported as though the user's file was never saved.
    Ok(directory
        .sync_all()
        .err()
        .map(|_| "文件已保存，但目录的耐久同步尚未确认。".into()))
}
#[cfg(not(unix))]
fn write_atomic(
    _directory: &File,
    _name: &str,
    _content: &str,
    _existing: Option<&str>,
) -> Result<Option<String>, FileError> {
    Err(FileError::Unsupported)
}

struct SaveIntent {
    id: String,
    grant_token: String,
    name: String,
    content_hash: String,
    previous_fingerprint: Option<String>,
    state: String,
}

fn resource(grant: &Grant, name: &str) -> String {
    hash(format!("{}:{}", grant.parent_identity, name).as_bytes())
}

fn current_intent(
    db: &Connection,
    grant: &Grant,
    name: &str,
) -> Result<Option<SaveIntent>, FileError> {
    Ok(db.query_row("SELECT id,grant_token,name,content_hash,previous_fingerprint,state FROM desktop_file_save_intent WHERE resource_key=?1 AND state IN ('prepared','complete') ORDER BY created_at DESC,rowid DESC LIMIT 1",
        [resource(grant,name)], |row| Ok(SaveIntent { id:row.get(0)?,grant_token:row.get(1)?,name:row.get(2)?,content_hash:row.get(3)?,previous_fingerprint:row.get(4)?,state:row.get(5)? })).optional()?)
}

fn finish_receipt(
    db: &mut Connection,
    directory: &File,
    grant: &Grant,
    intent: &SaveIntent,
) -> Result<(), FileError> {
    let current = target(directory, &intent.name)?.ok_or(FileError::TargetChanged)?;
    if current.content_hash != intent.content_hash {
        return Err(FileError::TargetChanged);
    }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // Only the original grant for this exact source path may have its inode
    // refreshed. A sibling copy must not expand another grant's authority.
    let source = grant.parent.join(&grant.name);
    let updates_source = intent.grant_token == grant.token
        && open_child(directory, &grant.name)
            .ok()
            .and_then(|file| file.metadata().ok())
            .is_some_and(|metadata| identity(&metadata) == current.identity);
    if updates_source {
        tx.execute("UPDATE desktop_file_grant SET source_identity=?1 WHERE token=?2 AND source=?3 AND parent=?4 AND parent_identity=?5 AND name=?6",
            params![current.identity,intent.grant_token,source.to_str(),grant.parent.to_str(),grant.parent_identity,grant.name])?;
    }
    let changed=tx.execute("UPDATE desktop_file_save_intent SET state='complete',finished_at=?2,last_error=NULL WHERE id=?1 AND state IN ('prepared','complete')",params![intent.id,now()])?;
    if changed != 1 {
        return Err(FileError::TargetChanged);
    }
    tx.commit()?;
    Ok(())
}

fn saved_result(
    name: &str,
    receipt: Result<(), FileError>,
    publication_warning: Option<String>,
) -> SaveResult {
    let receipt_pending = receipt.is_err();
    let warning = if receipt_pending {
        Some("文件已保存，但本机回执待补记；重试只会核对文件并补回执。若文件已被外部修改，将停止恢复。".to_owned())
    } else {
        publication_warning
    };
    SaveResult {
        saved: true,
        name: name.to_owned(),
        confirmation: None,
        receipt_pending,
        warning,
    }
}

fn recover_receipt(
    db: &mut Connection,
    directory: &File,
    grant: &Grant,
    name: &str,
    content_hash: &str,
    confirmation: Option<&str>,
) -> Result<Option<SaveResult>, FileError> {
    let Some(intent) = current_intent(db, grant, name)? else {
        return Ok(None);
    };
    // A consumed authorization cannot publish again. Idempotent receipt lookup
    // without that challenge is safe because it never writes the external file.
    if intent.state == "complete" && confirmation.is_some() {
        return Ok(None);
    }
    let current = target(directory, name)?;
    let matches = current
        .as_ref()
        .is_some_and(|target| target.content_hash == intent.content_hash);
    let same_request = intent.grant_token == grant.token && intent.content_hash == content_hash;
    if matches {
        if intent.state == "complete" && !same_request {
            return Ok(None);
        }
        let receipt = finish_receipt(db, directory, grant, &intent);
        if same_request {
            return Ok(Some(saved_result(name, receipt, None)));
        }
        receipt.map_err(|_| FileError::ReceiptPending)?;
        return Ok(None);
    }
    if intent.state == "complete" {
        return Ok(None);
    }
    let unchanged = current.as_ref().map(|target| target.fingerprint.as_str())
        == intent.previous_fingerprint.as_deref();
    if unchanged {
        db.execute("UPDATE desktop_file_save_intent SET state='aborted',finished_at=?2,last_error='publication not observed' WHERE id=?1",params![intent.id,now()])?;
        return Ok(None);
    }
    db.execute("UPDATE desktop_file_save_intent SET state='conflict',finished_at=?2,last_error='external target changed; no automatic rewrite' WHERE id=?1",params![intent.id,now()])?;
    Err(FileError::TargetChanged)
}

/// The journal and external file are separate resources. Intent commits first;
/// retries only complete receipts after verifying the published target hash.
pub fn save_original(
    database: &Path,
    token: &str,
    file_name: &str,
    content: &str,
    confirmation: Option<&str>,
) -> Result<SaveResult, FileError> {
    validate_name(file_name)?;
    if content.len() > MAX_BYTES {
        return Err(FileError::TooLarge);
    }
    let mut db = connect(database)?;
    let grant = read_grant(&db, token)?;
    let directory = open_directory(&grant)?;
    lock_directory(&directory)?;
    let content_hash = hash(content.as_bytes());
    if let Some(result) = recover_receipt(
        &mut db,
        &directory,
        &grant,
        file_name,
        &content_hash,
        confirmation,
    )? {
        return Ok(result);
    }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let grant = read_grant(&tx, token)?;
    let existing = target(&directory, file_name)?;
    let fingerprint = existing.as_ref().map(|value| value.fingerprint.as_str());
    if let Some(fingerprint) = fingerprint {
        let confirmed = if let Some(challenge) = confirmation {
            tx.query_row("SELECT 1 FROM desktop_file_confirmation WHERE id=?1 AND grant_token=?2 AND name=?3 AND target_fingerprint=?4 AND content_hash=?5 AND expires_at>=?6 AND consumed=0",
                params![challenge,token,file_name,fingerprint,content_hash,now()],|_|Ok(())).optional()?.is_some()
        } else {
            false
        };
        if !confirmed {
            if confirmation.is_some() {
                return Err(FileError::TargetChanged);
            }
            let challenge = new_token();
            tx.execute(
                "INSERT INTO desktop_file_confirmation VALUES(?1,?2,?3,?4,?5,?6,0)",
                params![
                    challenge,
                    token,
                    file_name,
                    fingerprint,
                    content_hash,
                    now() + CONFIRM_LIFETIME
                ],
            )?;
            tx.commit()?;
            return Ok(SaveResult {
                saved: false,
                name: file_name.to_owned(),
                confirmation: Some(challenge),
                receipt_pending: false,
                warning: None,
            });
        }
    } else if confirmation.is_some() {
        return Err(FileError::TargetChanged);
    }
    let intent = SaveIntent {
        id: new_token(),
        grant_token: token.to_owned(),
        name: file_name.to_owned(),
        content_hash,
        previous_fingerprint: fingerprint.map(str::to_owned),
        state: "prepared".into(),
    };
    tx.execute("INSERT INTO desktop_file_save_intent(id,resource_key,grant_token,name,content_hash,previous_fingerprint,state,created_at) VALUES(?1,?2,?3,?4,?5,?6,'prepared',?7)",
        params![intent.id,resource(&grant,file_name),token,file_name,intent.content_hash,intent.previous_fingerprint,now()])?;
    if let Some(challenge) = confirmation {
        tx.execute(
            "UPDATE desktop_file_confirmation SET consumed=1 WHERE id=?1",
            [challenge],
        )?;
    }
    // This durable write occurs before any external file is changed.
    tx.commit()?;
    match write_atomic(
        &directory,
        file_name,
        content,
        intent.previous_fingerprint.as_deref(),
    ) {
        Ok(warning) => {
            let receipt = finish_receipt(&mut db, &directory, &grant, &intent);
            Ok(saved_result(file_name, receipt, warning))
        }
        Err(error) => {
            let _=db.execute("UPDATE desktop_file_save_intent SET state='aborted',finished_at=?2,last_error='filesystem publication failed' WHERE id=?1",params![intent.id,now()]);
            Err(error)
        }
    }
}
