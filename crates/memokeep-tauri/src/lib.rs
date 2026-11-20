use std::{path::PathBuf, sync::Arc};

use memokeep_storage::{backup, images, search, Fields, Snapshot, StorageError};
use serde::{Deserialize, Serialize, Serializer};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Emitter, Manager, Runtime, State, WebviewWindow,
};
use thiserror::Error;

#[cfg(target_os = "macos")]
mod background;
#[cfg(target_os = "macos")]
mod files;
#[cfg(target_os = "macos")]
mod link_preview;
#[cfg(target_os = "macos")]
mod speech;
#[cfg(target_os = "macos")]
pub use speech::DesktopSpeech;

#[cfg(target_os = "macos")]
pub use tauri_plugin_dialog::init as desktop_dialog;
#[cfg(target_os = "macos")]
pub use tauri_plugin_dialog::DialogExt;

pub trait WorkspaceWriter: Send + Sync {
    fn reminder_context_light(
        &self,
        _transaction: &rusqlite::Connection,
        _data: &Fields,
    ) -> Result<Option<memokeep_storage::reminders::Context>, WorkspaceWriteError> {
        Ok(None)
    }
    fn write_records(
        &self,
        _expected_revision: i64,
        _records: &[memokeep_storage::records::CollectionPatch],
        _updated: &Fields,
        _removed: &[String],
        _context: Option<&serde_json::Value>,
    ) -> Result<i64, WorkspaceWriteError> {
        Err(WorkspaceWriteError {
            code: "RECORD_WRITER_REQUIRED".into(),
            message: "此版本尚未接入受控记录事务".into(),
        })
    }
    fn activate_records(&self, _expected_revision: i64) -> Result<i64, WorkspaceWriteError> {
        Err(WorkspaceWriteError {
            code: "RECORD_WRITER_REQUIRED".into(),
            message: "此版本尚未接入记录布局升级".into(),
        })
    }
    /// Optional committed metadata for local delivery. The core knows no sync protocol.
    fn reminder_context(
        &self,
        _transaction: &rusqlite::Connection,
        _data: &Fields,
    ) -> Result<Option<memokeep_storage::reminders::Context>, WorkspaceWriteError> {
        Ok(None)
    }

    fn write(
        &self,
        expected_revision: i64,
        fields: &Fields,
        removed: &[String],
        replace: bool,
        context: Option<&serde_json::Value>,
    ) -> Result<i64, WorkspaceWriteError>;
    fn prepare(
        &self,
        _transaction: &rusqlite::Connection,
        _before: &Fields,
        _after: &Fields,
    ) -> Result<(), WorkspaceWriteError> {
        Ok(())
    }
    fn restore(
        &self,
        transaction: &rusqlite::Connection,
        before: &Fields,
        after: &Fields,
    ) -> Result<(), WorkspaceWriteError> {
        self.prepare(transaction, before, after)
    }
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct WorkspaceWriteError {
    pub code: String,
    pub message: String,
}

pub struct DesktopWriter(pub Arc<dyn WorkspaceWriter>);

/// Optional private attachment providers; the public host does not know their tables.
pub struct DesktopBackupExtensions(pub Vec<Arc<dyn backup::BackupExtension>>);

struct Database {
    path: Arc<PathBuf>,
    scopes: &'static [&'static str],
    external_desktop_writer: bool,
    note_windows: bool,
}

impl Database {
    fn access(&self, label: &str, scope: &str) -> Result<(), CommandError> {
        let note_window = self.note_windows && scope == "desktop" && label.starts_with("note-");
        if (label != "main" && !note_window) || !self.scopes.contains(&scope) {
            return Err(CommandError::Permission);
        }
        Ok(())
    }

    fn require_direct_write(&self, scope: &str) -> Result<(), CommandError> {
        if scope == "desktop" && self.external_desktop_writer {
            return Err(CommandError::ExternalWriter);
        }
        Ok(())
    }
}

#[derive(Debug, Error)]
enum CommandError {
    #[error("此工作空间的写入由同步事务处理")]
    ExternalWriter,
    #[error("此页面无权访问数据")]
    Permission,
    #[error("数据库任务意外停止")]
    Worker,
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Backup(#[from] backup::BackupError),
    #[error(transparent)]
    Publishing(#[from] memokeep_storage::publishing::PublishingError),
    #[error(transparent)]
    Extension(#[from] WorkspaceWriteError),
    #[cfg(target_os = "macos")]
    #[error("文件选择器没有返回本地文件路径")]
    FileSelection,
}

impl Serialize for CommandError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Reply<'a> {
            code: &'a str,
            message: String,
        }
        let code = match self {
            Self::Extension(error) => &error.code,
            Self::ExternalWriter => "EXTERNAL_WRITER",
            Self::Permission => "PERMISSION_DENIED",
            Self::Storage(StorageError::StaleRevision) => "STALE_REVISION",
            Self::Storage(
                StorageError::Json(_)
                | StorageError::InvalidField
                | StorageError::InvalidImageId
                | StorageError::UnsupportedImage
                | StorageError::ImageTooLarge
                | StorageError::InvalidImageEncoding(_),
            ) => "INVALID_DATA",
            #[cfg(target_os = "macos")]
            Self::FileSelection => "STORAGE_FAILURE",
            Self::Worker | Self::Storage(_) | Self::Backup(_) | Self::Publishing(_) => {
                "STORAGE_FAILURE"
            }
        };
        Reply {
            code,
            message: self.to_string(),
        }
        .serialize(serializer)
    }
}

#[tauri::command]
async fn read<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    scope: String,
) -> Result<Snapshot, CommandError> {
    database.access(window.label(), &scope)?;
    // The blocking task owns a path reference while SQLite is open.
    let path = Arc::clone(&database.path);
    let result =
        tauri::async_runtime::spawn_blocking(move || memokeep_storage::read(&path, &scope))
            .await
            .map_err(|_| CommandError::Worker)??;
    Ok(result)
}

#[tauri::command]
async fn write<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    scope: String,
    expected_revision: i64,
    data: Fields,
    context: Option<serde_json::Value>,
) -> Result<i64, CommandError> {
    database.access(window.label(), &scope)?;
    database.require_direct_write(&scope)?;
    let writer = window
        .try_state::<DesktopWriter>()
        .map(|writer| Arc::clone(&writer.0));
    // The blocking task owns a path reference while SQLite is open.
    let path = Arc::clone(&database.path);
    let revision = tauri::async_runtime::spawn_blocking(move || {
        let revision = if let Some(writer) = writer {
            writer
                .write(expected_revision, &data, &[], true, context.as_ref())
                .map_err(CommandError::from)?
        } else {
            memokeep_storage::write(&path, &scope, expected_revision, &data)?
        };
        Ok::<_, CommandError>(revision)
    })
    .await
    .map_err(|_| CommandError::Worker)??;
    if revision != expected_revision {
        // Durable writes succeed even if no webview remains to receive the hint.
        let _ = window.app_handle().emit("workspace-changed", ());
    }
    Ok(revision)
}

#[tauri::command]
async fn publishing_status<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
) -> Result<memokeep_storage::publishing::Status, CommandError> {
    database.access(window.label(), "desktop")?;
    // The worker owns a path handle until the persistent status has been read.
    let path = Arc::clone(&database.path);
    tauri::async_runtime::spawn_blocking(move || memokeep_storage::publishing::status(&path))
        .await
        .map_err(|_| CommandError::Worker)?
        .map_err(Into::into)
}

#[tauri::command]
async fn choose_publish_directory<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
) -> Result<Option<String>, CommandError> {
    database.access(window.label(), "desktop")?;
    if window.label() != "main" {
        return Err(CommandError::Permission);
    }
    #[cfg(target_os = "macos")]
    {
        // The directory picker runs in a blocking worker while the UI stays responsive.
        let app = window.app_handle().clone();
        let path = Arc::clone(&database.path);
        tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_dialog::DialogExt;
            let Some(directory) = app
                .dialog()
                .file()
                .set_title("选择 Markdown 持续发布目录")
                .blocking_pick_folder()
            else {
                return Ok(None);
            };
            let directory = directory
                .into_path()
                .map_err(|_| CommandError::FileSelection)?;
            memokeep_storage::publishing::configure(&path, &directory)?;
            let _ = memokeep_storage::publishing::publish(&path);
            Ok(Some(directory.to_string_lossy().into_owned()))
        })
        .await
        .map_err(|_| CommandError::Worker)?
    }
    #[cfg(not(target_os = "macos"))]
    Err(CommandError::Permission)
}

pub fn init<R: Runtime>(scopes: &'static [&'static str]) -> TauriPlugin<R> {
    init_in(scopes, None)
}

#[tauri::command]
async fn read_fields<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    fields: Vec<String>,
) -> Result<Snapshot, CommandError> {
    database.access(window.label(), "desktop")?;
    // The blocking worker owns the path reference until SQLite closes.
    let path = Arc::clone(&database.path);
    Ok(tauri::async_runtime::spawn_blocking(move || {
        memokeep_storage::read_fields(&path, "desktop", &fields)
    })
    .await
    .map_err(|_| CommandError::Worker)??)
}

#[derive(Serialize)]
struct RecordStatus {
    enabled: bool,
    isolated: bool,
    revision: i64,
}

#[tauri::command]
async fn record_status<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
) -> Result<RecordStatus, CommandError> {
    database.access(window.label(), "desktop")?;
    // The worker owns the database path while inspecting the optional layout.
    let path = Arc::clone(&database.path);
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let isolated = path.parent().is_some_and(|directory| {
            let temporary = directory
                .canonicalize()
                .ok()
                .zip(std::env::temp_dir().canonicalize().ok())
                .is_some_and(|(dir, temp)| {
                    dir.starts_with(temp) || dir.starts_with("/private/tmp")
                });
            temporary
                && std::fs::read_to_string(directory.join(".memokeep-isolated"))
                    .is_ok_and(|value| value.trim() == "synthetic")
        });
        Ok::<_, StorageError>(RecordStatus {
            enabled: memokeep_storage::records::enabled(&path, "desktop")?,
            isolated,
            revision: memokeep_storage::read_fields(&path, "desktop", &[])?.revision,
        })
    })
    .await
    .map_err(|_| CommandError::Worker)??)
}

#[tauri::command]
async fn activate_records<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    expected_revision: i64,
    confirm: bool,
) -> Result<i64, CommandError> {
    database.access(window.label(), "desktop")?;
    if window.label() != "main" || !confirm {
        return Err(CommandError::Permission);
    }
    // The controlled extension and path must outlive the blocking transaction.
    let writer = window
        .try_state::<DesktopWriter>()
        .map(|writer| Arc::clone(&writer.0));
    let path = Arc::clone(&database.path);
    tauri::async_runtime::spawn_blocking(move || match writer {
        Some(writer) => writer
            .activate_records(expected_revision)
            .map_err(CommandError::from),
        None => Ok(memokeep_storage::records::activate(
            &path,
            "desktop",
            expected_revision,
        )?),
    })
    .await
    .map_err(|_| CommandError::Worker)?
}

#[tauri::command]
async fn read_records<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    requests: Vec<memokeep_storage::records::CollectionPatch>,
) -> Result<memokeep_storage::records::RecordSet, CommandError> {
    database.access(window.label(), "desktop")?;
    // The blocking read keeps all requested records on one SQLite snapshot.
    let path = Arc::clone(&database.path);
    Ok(tauri::async_runtime::spawn_blocking(move || {
        memokeep_storage::records::read_set(&path, "desktop", &requests)
    })
    .await
    .map_err(|_| CommandError::Worker)??)
}

#[tauri::command]
async fn note_summaries<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    collection: String,
    offset: usize,
    limit: usize,
) -> Result<memokeep_storage::records::SummaryPage, CommandError> {
    database.access(window.label(), "desktop")?;
    // Summaries exclude note bodies and history; SQLite performs the page selection.
    let path = Arc::clone(&database.path);
    Ok(tauri::async_runtime::spawn_blocking(move || {
        memokeep_storage::records::summaries(&path, "desktop", &collection, offset, limit)
    })
    .await
    .map_err(|_| CommandError::Worker)??)
}

#[tauri::command]
async fn write_records<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    expected_revision: i64,
    records: Vec<memokeep_storage::records::CollectionPatch>,
    updated: Fields,
    removed: Vec<String>,
    context: Option<serde_json::Value>,
) -> Result<i64, CommandError> {
    database.access(window.label(), "desktop")?;
    database.require_direct_write("desktop")?;
    // The optional edition writer commits business and extension facts atomically.
    let writer = window
        .try_state::<DesktopWriter>()
        .map(|writer| Arc::clone(&writer.0));
    let path = Arc::clone(&database.path);
    let revision = tauri::async_runtime::spawn_blocking(move || match writer {
        Some(writer) => writer
            .write_records(
                expected_revision,
                &records,
                &updated,
                &removed,
                context.as_ref(),
            )
            .map_err(CommandError::from),
        None => Ok(memokeep_storage::records::write(
            &path,
            "desktop",
            expected_revision,
            &records,
            &updated,
            &removed,
        )?),
    })
    .await
    .map_err(|_| CommandError::Worker)??;
    if revision != expected_revision {
        let _ = window.app_handle().emit("workspace-changed", ());
    }
    Ok(revision)
}

#[tauri::command]
async fn write_fields<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    expected_revision: i64,
    updated: Fields,
    removed: Vec<String>,
    context: Option<serde_json::Value>,
) -> Result<i64, CommandError> {
    database.access(window.label(), "desktop")?;
    database.require_direct_write("desktop")?;
    let writer = window
        .try_state::<DesktopWriter>()
        .map(|writer| Arc::clone(&writer.0));
    // The blocking worker owns the path reference until SQLite closes.
    let path = Arc::clone(&database.path);
    let revision = tauri::async_runtime::spawn_blocking(move || {
        let revision = if let Some(writer) = writer {
            writer
                .write(
                    expected_revision,
                    &updated,
                    &removed,
                    false,
                    context.as_ref(),
                )
                .map_err(CommandError::from)?
        } else {
            memokeep_storage::write_fields(&path, "desktop", expected_revision, &updated, &removed)?
        };
        Ok::<_, CommandError>(revision)
    })
    .await
    .map_err(|_| CommandError::Worker)??;
    if revision != expected_revision {
        let _ = window.app_handle().emit("workspace-changed", ());
    }
    Ok(revision)
}

#[tauri::command]
async fn index_search<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    revision: i64,
    entries: Vec<search::Entry>,
) -> Result<(), CommandError> {
    database.access(window.label(), "desktop")?;
    // The SQLite worker owns the path for the duration of the call.
    let path = Arc::clone(&database.path);
    tauri::async_runtime::spawn_blocking(move || search::update(&path, revision, &entries))
        .await
        .map_err(|_| CommandError::Worker)??;
    Ok(())
}

#[tauri::command]
async fn query_search<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    terms: Vec<String>,
) -> Result<Option<Vec<search::Entry>>, CommandError> {
    database.access(window.label(), "desktop")?;
    // The SQLite worker owns the path for the duration of the call.
    let path = Arc::clone(&database.path);
    Ok(
        tauri::async_runtime::spawn_blocking(move || search::query(&path, &terms))
            .await
            .map_err(|_| CommandError::Worker)??,
    )
}

#[derive(Deserialize)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[serde(tag = "action", rename_all = "camelCase")]
enum BackupRequest {
    Preview,
    Apply { token: String },
    Cancel { token: String },
    Status,
    Undo,
    Export,
    ExportModules,
}

#[derive(Serialize)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[serde(untagged)]
enum BackupReply {
    Preview(backup::Preview),
    Data(Fields),
    Status {
        #[serde(rename = "canUndo")]
        can_undo: bool,
    },
    File(String),
    Empty,
}

#[cfg(target_os = "macos")]
fn run_backup<R: Runtime>(
    database: &std::path::Path,
    application: &tauri::AppHandle<R>,
    request: BackupRequest,
) -> Result<BackupReply, CommandError> {
    use tauri_plugin_dialog::DialogExt;
    let registered = application.try_state::<DesktopBackupExtensions>();
    let extensions: Vec<&dyn backup::BackupExtension> = registered
        .as_ref()
        .into_iter()
        .flat_map(|state| state.0.iter().map(|provider| provider.as_ref()))
        .collect();
    match request {
        BackupRequest::Preview | BackupRequest::Export => {
            #[cfg(feature = "smoke-test")]
            if matches!(request, BackupRequest::Preview) {
                if let Some(dir) = std::env::var_os("MEMOKEEP_SMOKE_DATA_DIR").map(PathBuf::from) {
                    if database.parent() == Some(dir.as_path()) {
                        return Ok(BackupReply::Preview(backup::preview_with_extensions(
                            database,
                            &dir.join("fixture.json"),
                            &extensions,
                        )?));
                    }
                }
            }
            let dialog = application
                .dialog()
                .file()
                .add_filter("MemoKeep JSON 备份", &["json"]);
            let path = if matches!(request, BackupRequest::Preview) {
                dialog.set_title("选择 MemoKeep 备份").blocking_pick_file()
            } else {
                dialog
                    .set_title("导出 MemoKeep 备份")
                    .set_file_name("MemoKeep-backup.json")
                    .blocking_save_file()
            };
            let Some(path) = path else {
                return Ok(BackupReply::Empty);
            };
            let path = path.into_path().map_err(|_| CommandError::FileSelection)?;
            if matches!(request, BackupRequest::Preview) {
                Ok(BackupReply::Preview(backup::preview_with_extensions(
                    database,
                    &path,
                    &extensions,
                )?))
            } else {
                backup::export_with_extensions(database, &path, &extensions)?;
                Ok(BackupReply::File(path.to_string_lossy().into_owned()))
            }
        }
        BackupRequest::Apply { token } => Ok(BackupReply::Data(
            backup::apply_preview_with_extensions_and_commit(
                database,
                &token,
                &extensions,
                |tx, before, after| {
                    if let Some(writer) = application.try_state::<DesktopWriter>() {
                        writer
                            .0
                            .restore(tx, before, after)
                            .map_err(|error| error.message)?;
                    }
                    Ok(())
                },
            )?,
        )),
        BackupRequest::Cancel { token } => {
            backup::cancel_preview(database, &token)?;
            Ok(BackupReply::Empty)
        }
        BackupRequest::Status => Ok(BackupReply::Status {
            can_undo: backup::can_undo_with_extensions(database, &extensions)?,
        }),
        BackupRequest::Undo => Ok(BackupReply::Data(backup::undo_with_extensions_and_commit(
            database,
            &extensions,
            |tx, before, after| {
                if let Some(writer) = application.try_state::<DesktopWriter>() {
                    writer
                        .0
                        .restore(tx, before, after)
                        .map_err(|error| error.message)?;
                }
                Ok(())
            },
        )?)),
        BackupRequest::ExportModules => {
            let Some(path) = application.dialog().file().blocking_pick_folder() else {
                return Ok(BackupReply::Empty);
            };
            let path = path.into_path().map_err(|_| CommandError::FileSelection)?;
            let directory = backup::export_modules(database, &path)?;
            Ok(BackupReply::File(directory.to_string_lossy().into_owned()))
        }
    }
}

#[tauri::command]
async fn workspace_backup<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    request: BackupRequest,
) -> Result<BackupReply, CommandError> {
    database.access(window.label(), "desktop")?;
    if matches!(request, BackupRequest::Apply { .. } | BackupRequest::Undo) {
        database.require_direct_write("desktop")?;
    }
    #[cfg(target_os = "macos")]
    {
        // The native picker and SQLite work own these handles until completion.
        let path = Arc::clone(&database.path);
        let application = window.app_handle().clone();
        let result =
            tauri::async_runtime::spawn_blocking(move || run_backup(&path, &application, request))
                .await
                .map_err(|_| CommandError::Worker)??;
        if matches!(result, BackupReply::Data(_)) {
            let _ = window.app_handle().emit("workspace-changed", ());
        }
        Ok(result)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (database, request);
        Err(CommandError::Permission)
    }
}

#[tauri::command]
fn data_path<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
) -> Result<String, CommandError> {
    database.access(window.label(), "desktop")?;
    Ok(database.path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn save_image<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    bytes: String,
    name: String,
) -> Result<images::SavedImage, CommandError> {
    database.access(window.label(), "desktop")?;
    // The blocking task owns a path reference while SQLite is open.
    let path = Arc::clone(&database.path);
    Ok(
        tauri::async_runtime::spawn_blocking(move || images::save(&path, &bytes, &name))
            .await
            .map_err(|_| CommandError::Worker)??,
    )
}

#[tauri::command]
async fn read_image<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    id: String,
) -> Result<Option<images::ReadImage>, CommandError> {
    database.access(window.label(), "desktop")?;
    // The blocking task owns a path reference while SQLite is open.
    let path = Arc::clone(&database.path);
    Ok(
        tauri::async_runtime::spawn_blocking(move || images::read(&path, &id))
            .await
            .map_err(|_| CommandError::Worker)??,
    )
}

#[tauri::command]
async fn delete_image<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    id: String,
) -> Result<bool, CommandError> {
    database.access(window.label(), "desktop")?;
    // The blocking task owns a path reference while SQLite is open.
    let path = Arc::clone(&database.path);
    Ok(
        tauri::async_runtime::spawn_blocking(move || images::delete_unreferenced(&path, &id))
            .await
            .map_err(|_| CommandError::Worker)??,
    )
}

pub fn init_in<R: Runtime>(
    scopes: &'static [&'static str],
    directory: Option<PathBuf>,
) -> TauriPlugin<R> {
    build_plugin(scopes, directory, false, false)
}

pub fn init_pro_desktop<R: Runtime>(
    directory: Option<PathBuf>,
    external_writer: bool,
) -> TauriPlugin<R> {
    build_plugin(&["desktop"], directory, external_writer, true)
}

pub fn desktop_workspace_file<R: Runtime>(window: &WebviewWindow<R>) -> Option<PathBuf> {
    let database = window.try_state::<Database>()?;
    database.access(window.label(), "desktop").ok()?;
    Some(database.path.to_path_buf())
}

fn build_plugin<R: Runtime>(
    scopes: &'static [&'static str],
    directory: Option<PathBuf>,
    external_desktop_writer: bool,
    note_windows: bool,
) -> TauriPlugin<R> {
    Builder::new("memokeep-workspace")
        .invoke_handler(tauri::generate_handler![
            read,
            write,
            read_fields,
            record_status,
            activate_records,
            read_records,
            note_summaries,
            write_records,
            write_fields,
            data_path,
            save_image,
            read_image,
            delete_image,
            index_search,
            query_search,
            workspace_backup,
            publishing_status,
            choose_publish_directory,
            #[cfg(target_os = "macos")]
            link_preview::read_link_preview,
            #[cfg(target_os = "macos")]
            link_preview::read_link_preview_image,
            #[cfg(target_os = "macos")]
            background::pomodoro_get,
            #[cfg(target_os = "macos")]
            background::pomodoro_command,
            #[cfg(target_os = "macos")]
            background::desktop_notify,
            #[cfg(target_os = "macos")]
            background::open_app,
            #[cfg(target_os = "macos")]
            background::reminders_check,
            #[cfg(target_os = "macos")]
            background::reminders_ack,
            #[cfg(target_os = "macos")]
            files::files_pending,
            #[cfg(target_os = "macos")]
            files::files_ack,
            #[cfg(target_os = "macos")]
            files::files_revoke,
            #[cfg(target_os = "macos")]
            files::files_save,
            #[cfg(target_os = "macos")]
            speech::speech_available,
            #[cfg(target_os = "macos")]
            speech::speech_status,
            #[cfg(target_os = "macos")]
            speech::speech_start,
            #[cfg(target_os = "macos")]
            speech::speech_control,
            #[cfg(target_os = "macos")]
            speech::speech_settings
        ])
        .on_event(|_app, _event| {
            #[cfg(target_os = "macos")]
            files::on_event(_app, _event);
            if matches!(_event, tauri::RunEvent::Exit) {
                #[cfg(target_os = "macos")]
                if let Some(worker) = _app.try_state::<background::WorkerController>() {
                    worker.stop();
                }
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } = _event
            {
                if let Some(host) = _app.try_state::<DesktopSpeech>() {
                    host.cancel_owner(label);
                }
            }
        })
        .setup(move |app, _| {
            let default_directory;
            let directory = if let Some(directory) = &directory {
                directory
            } else {
                default_directory = app.path().app_data_dir()?;
                &default_directory
            };
            std::fs::create_dir_all(directory)?;
            let path = directory.join("workspace.sqlite3");
            memokeep_storage::initialize(&path)?;
            app.manage(Database {
                path: Arc::new(path),
                scopes,
                external_desktop_writer,
                note_windows,
            });
            if scopes.contains(&"desktop") {
                #[cfg(target_os = "macos")]
                {
                    app.manage(background::start(app, directory.join("workspace.sqlite3")));
                    files::startup(app);
                }
            }
            Ok(())
        })
        .build()
}
