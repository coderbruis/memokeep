//! Only OS-delivered files are granted to the main desktop window.
use std::{path::Path, sync::Arc};

use memokeep_desktop_services::files::{self, Origin};
use serde::{Serialize, Serializer};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};
use thiserror::Error;

use crate::Database;

#[derive(Debug, Error)]
pub(crate) enum FileHostError {
    #[error("此窗口无权访问系统打开的文件")]
    Permission,
    #[error("文件任务意外停止，请重试")]
    Worker,
    #[error("未取得拖入文件的系统目录授权，请通过系统“打开方式”重新打开文件后再试")]
    MissingDropPaths,
    #[error(transparent)]
    File(#[from] files::FileError),
}

impl Serialize for FileHostError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

fn main_window<R: Runtime>(
    window: &WebviewWindow<R>,
    database: &Database,
) -> Result<(), FileHostError> {
    database
        .access(window.label(), "desktop")
        .map_err(|_| FileHostError::Permission)?;
    if window.label() != "main" {
        return Err(FileHostError::Permission);
    }
    Ok(())
}

fn isolated_diagnostics(database: &Path) -> bool {
    let Some(parent) = database.parent() else {
        return false;
    };
    let Ok(directory) = parent.canonicalize() else {
        return false;
    };
    let temporary = std::env::temp_dir().canonicalize().ok();
    let system_temporary = Path::new("/tmp").canonicalize().ok();
    let in_temporary = temporary
        .iter()
        .chain(system_temporary.iter())
        .any(|root| directory.starts_with(root));
    in_temporary
        && std::fs::read(directory.join(".memokeep-isolated"))
            .is_ok_and(|marker| marker == b"synthetic")
}

fn emit_file_error<R: Runtime>(app: &AppHandle<R>, message: &str) {
    let _ = app.emit_to("main", "workspace-file-error", message);
}

struct NativeDrag<'a> {
    label: &'a str,
    source: &'static str,
    event: &'a tauri::DragDropEvent,
}

impl<'a> NativeDrag<'a> {
    fn window(label: &'a str, event: &'a tauri::WindowEvent) -> Option<Self> {
        match event {
            tauri::WindowEvent::DragDrop(event) => Some(Self {
                label,
                source: "window",
                event,
            }),
            _ => None,
        }
    }

    fn webview(label: &'a str, event: &'a tauri::WebviewEvent) -> Option<Self> {
        match event {
            tauri::WebviewEvent::DragDrop(event) => Some(Self {
                label,
                source: "webview",
                event,
            }),
            _ => None,
        }
    }

    fn main_event(&self) -> Option<&'a tauri::DragDropEvent> {
        (self.label == "main").then_some(self.event)
    }

    fn summary(&self) -> (&'static str, usize) {
        match self.event {
            tauri::DragDropEvent::Enter { paths, .. } => ("enter", paths.len()),
            tauri::DragDropEvent::Drop { paths, .. } => ("drop", paths.len()),
            tauri::DragDropEvent::Over { .. } => ("over", 0),
            tauri::DragDropEvent::Leave => ("leave", 0),
            _ => ("unknown", 0),
        }
    }
}

fn drop_sources(paths: &[std::path::PathBuf]) -> Result<Vec<String>, FileHostError> {
    let sources: Vec<_> = paths
        .iter()
        .filter_map(|path| path.to_str().map(str::to_owned))
        .collect();
    if sources.is_empty() {
        return Err(FileHostError::MissingDropPaths);
    }
    Ok(sources)
}

fn enqueue<R: Runtime>(app: &AppHandle<R>, sources: Vec<String>, origin: Origin) {
    let Some(database) = app.try_state::<Database>() else {
        return;
    };
    if !database.scopes.contains(&"desktop") || sources.is_empty() {
        return;
    }
    let diagnostics = isolated_diagnostics(&database.path);
    let origin_name = match origin {
        Origin::System => "system",
        Origin::Drop => "drop",
    };
    // This bounded task owns its database-path handle until the files are queued.
    let path = Arc::clone(&database.path);
    // Keep only a Tauri event handle while the local filesystem is read off-thread.
    let application = app.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let published = memokeep_storage::publishing::status(&path)
            .ok()
            .and_then(|state| state.root);
        match files::enqueue(
            &path,
            &sources,
            std::env::current_dir().ok().as_deref(),
            origin,
            published.as_deref().map(std::path::Path::new),
        ) {
            Ok(report) => {
                if diagnostics {
                    eprintln!("MEMOKEEP_FILE_DIAGNOSTIC enqueue origin={origin_name} added={} deduplicated={} ignored={} errors={} overflow={}",
                        report.added, report.deduplicated, report.ignored, report.errors.len(), report.overflow);
                }
                if !report.errors.is_empty() {
                    emit_file_error(&application, "部分文件未能打开，请查看文件打开提示后重试");
                }
                if report.added > 0 || report.deduplicated > 0 || report.overflow {
                    let _ = application.emit_to("main", "workspace-files", ());
                    if let Some(main) = application.get_webview_window("main") {
                        let _ = main.unminimize();
                        let _ = main.show();
                        let _ = main.set_focus();
                    }
                }
            }
            Err(_) => {
                if diagnostics {
                    eprintln!(
                        "MEMOKEEP_FILE_DIAGNOSTIC enqueue origin={origin_name} status=failed"
                    );
                }
                emit_file_error(
                    &application,
                    "无法将文件加入打开队列，请稍后重新拖入或通过系统“打开方式”重试",
                );
            }
        }
    });
}

pub(crate) fn startup<R: Runtime>(app: &AppHandle<R>) {
    if app
        .try_state::<Database>()
        .is_some_and(|database| isolated_diagnostics(&database.path))
    {
        let main = app
            .config()
            .app
            .windows
            .iter()
            .find(|window| window.label == "main");
        match main {
            Some(window) => eprintln!(
                "MEMOKEEP_FILE_DIAGNOSTIC startup label=main drag_drop_enabled={}",
                window.drag_drop_enabled
            ),
            None => eprintln!("MEMOKEEP_FILE_DIAGNOSTIC startup main_config_missing=true"),
        }
    }
    let sources = std::env::args_os()
        .skip(1)
        .filter_map(|arg| arg.into_string().ok())
        .filter(|arg| !arg.starts_with('-'))
        .collect();
    enqueue(app, sources, Origin::System);
}

#[cfg(debug_assertions)]
fn isolated_drop_fixture<R: Runtime>(app: &AppHandle<R>, database: &std::path::Path) {
    let run = || -> Result<(), Box<dyn std::error::Error>> {
        if std::env::var("MEMOKEEP_NATIVE_FIXTURE").as_deref() != Ok("1")
            || std::env::var("MEMOKEEP_RUST_AUTO_TEST").as_deref() != Ok("1")
        {
            return Ok(());
        }
        let Some(directory) = database.parent() else {
            return Ok(());
        };
        let Some(expected) = std::env::var_os("MEMOKEEP_ISOLATED_WORKSPACE") else {
            return Ok(());
        };
        let directory = directory.canonicalize()?;
        if directory != std::path::PathBuf::from(expected).canonicalize()?
            || (!directory.starts_with(std::env::temp_dir().canonicalize()?)
                && !directory.starts_with(std::path::Path::new("/tmp").canonicalize()?))
            || !directory.join(".memokeep-isolated").is_file()
        {
            return Ok(());
        }
        let fixture = directory.join("drop-preview.md");
        if !fixture.is_file() {
            return Ok(());
        }
        let db = rusqlite::Connection::open(database)?;
        let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM desktop_file_queue WHERE origin='drop' AND name='drop-preview.md')", [], |row| row.get(0))?;
        if !exists {
            // This fixed synthetic event exercises the OS event dispatcher, not a mouse drag.
            // Renderer-controlled paths never enter this isolated fixture.
            let event = tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop {
                paths: vec![fixture],
                position: tauri::PhysicalPosition::new(0.0, 0.0),
            });
            if let Some(drag) = NativeDrag::window("main", &event) {
                dispatch_native_drag(app, drag);
            }
        }
        Ok(())
    };
    if let Err(error) = run() {
        eprintln!("隔离 Drop 队列夹具：{error}");
    }
}

pub(crate) fn on_event<R: Runtime>(app: &AppHandle<R>, event: &tauri::RunEvent) {
    if let tauri::RunEvent::Opened { urls } = event {
        let sources = urls
            .iter()
            .filter(|url| url.scheme() == "file")
            .map(ToString::to_string)
            .collect();
        enqueue(app, sources, Origin::System);
    }
    let drag = match event {
        tauri::RunEvent::WebviewEvent { label, event, .. } => NativeDrag::webview(label, event),
        tauri::RunEvent::WindowEvent { label, event, .. } => NativeDrag::window(label, event),
        _ => None,
    };
    if let Some(drag) = drag {
        dispatch_native_drag(app, drag);
    }
}

fn dispatch_native_drag<R: Runtime>(app: &AppHandle<R>, drag: NativeDrag<'_>) {
    if app
        .try_state::<Database>()
        .is_some_and(|database| isolated_diagnostics(&database.path))
    {
        let (kind, count) = drag.summary();
        eprintln!(
            "MEMOKEEP_FILE_DIAGNOSTIC native source={} label={} kind={kind} paths_count={count}",
            drag.source, drag.label
        );
    }
    match drag.main_event() {
        Some(tauri::DragDropEvent::Drop { paths, .. }) => {
            let _ = app.emit_to("main", "workspace-file-drag", false);
            match drop_sources(paths) {
                Ok(sources) => enqueue(app, sources, Origin::Drop),
                Err(error) => emit_file_error(app, &error.to_string()),
            }
        }
        Some(tauri::DragDropEvent::Enter { .. }) => {
            let _ = app.emit_to("main", "workspace-file-drag", true);
        }
        Some(tauri::DragDropEvent::Leave) => {
            let _ = app.emit_to("main", "workspace-file-drag", false);
        }
        _ => {}
    }
}

#[tauri::command]
pub(crate) async fn files_pending<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
) -> Result<Vec<files::OpenedFile>, FileHostError> {
    main_window(&window, &database)?;
    // The read task owns its database-path handle until SQLite closes.
    let path = Arc::clone(&database.path);
    tauri::async_runtime::spawn_blocking(move || files::pending(&path))
        .await
        .map_err(|_| FileHostError::Worker)?
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn files_ack<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    id: String,
) -> Result<bool, FileHostError> {
    main_window(&window, &database)?;
    // The acknowledgement owns a database-path handle only for this transaction.
    let path = Arc::clone(&database.path);
    let acknowledged = tauri::async_runtime::spawn_blocking(move || files::acknowledge(&path, &id))
        .await
        .map_err(|_| FileHostError::Worker)??;
    #[cfg(debug_assertions)]
    if acknowledged {
        isolated_drop_fixture(window.app_handle(), &database.path);
    }
    if acknowledged {
        let _ = window.app_handle().emit_to("main", "workspace-files", ());
    }
    Ok(acknowledged)
}

#[tauri::command]
pub(crate) async fn files_revoke<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    token: String,
) -> Result<bool, FileHostError> {
    main_window(&window, &database)?;
    // Releasing a grant needs no persistent in-memory path or file handle.
    let path = Arc::clone(&database.path);
    tauri::async_runtime::spawn_blocking(move || files::revoke(&path, &token))
        .await
        .map_err(|_| FileHostError::Worker)?
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn files_save<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    token: String,
    file_name: String,
    content: String,
) -> Result<files::SaveResult, FileHostError> {
    main_window(&window, &database)?;
    // The native confirmation and filesystem work use these handles off-thread.
    let path = Arc::clone(&database.path);
    let application = window.app_handle().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        let initial = files::save_original(&path, &token, &file_name, &content, None)?;
        let Some(confirmation) = initial.confirmation.as_deref() else {
            return Ok::<_, files::FileError>(initial);
        };
        let accepted = application
            .dialog()
            .message(format!(
                "「{}」已存在。覆盖会替换该文件当前内容。",
                initial.name
            ))
            .title("覆盖已有文件？")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "覆盖文件".into(),
                "取消".into(),
            ))
            .blocking_show();
        if !accepted {
            let mut cancelled = initial;
            cancelled.confirmation = None;
            return Ok(cancelled);
        }
        files::save_original(&path, &token, &file_name, &content, Some(confirmation))
    })
    .await
    .map_err(|_| FileHostError::Worker)?
    .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn dropped(paths: Vec<PathBuf>) -> tauri::DragDropEvent {
        tauri::DragDropEvent::Drop {
            paths,
            position: tauri::PhysicalPosition::new(0.0, 0.0),
        }
    }

    #[test]
    fn main_window_drop_keeps_only_native_paths() -> Result<(), Box<dyn std::error::Error>> {
        let event = tauri::WindowEvent::DragDrop(dropped(vec![PathBuf::from("/test/note.md")]));
        let drag = NativeDrag::window("main", &event).ok_or("missing window drop")?;
        assert_eq!(drag.source, "window");
        assert_eq!(drag.summary(), ("drop", 1));
        let Some(tauri::DragDropEvent::Drop { paths, .. }) = drag.main_event() else {
            return Err("main window drop was filtered out".into());
        };
        assert_eq!(drop_sources(paths)?, vec!["/test/note.md"]);
        Ok(())
    }

    #[test]
    fn main_webview_drop_uses_the_same_authorization_boundary(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let event = tauri::WebviewEvent::DragDrop(dropped(vec![PathBuf::from("/test/text.txt")]));
        let drag = NativeDrag::webview("main", &event).ok_or("missing webview drop")?;
        assert_eq!(drag.source, "webview");
        assert_eq!(drag.summary(), ("drop", 1));
        let Some(tauri::DragDropEvent::Drop { paths, .. }) = drag.main_event() else {
            return Err("main webview drop was filtered out".into());
        };
        assert_eq!(drop_sources(paths)?, vec!["/test/text.txt"]);
        Ok(())
    }

    #[test]
    fn other_windows_cannot_authorize_dropped_files() -> Result<(), Box<dyn std::error::Error>> {
        let window = tauri::WindowEvent::DragDrop(dropped(vec![PathBuf::from("/test/private.md")]));
        let webview =
            tauri::WebviewEvent::DragDrop(dropped(vec![PathBuf::from("/test/private.md")]));
        assert!(NativeDrag::window("note-example", &window)
            .ok_or("missing non-main window event")?
            .main_event()
            .is_none());
        assert!(NativeDrag::webview("capture-example", &webview)
            .ok_or("missing non-main webview event")?
            .main_event()
            .is_none());
        Ok(())
    }

    #[test]
    fn empty_native_drop_reports_missing_authorization() -> Result<(), Box<dyn std::error::Error>> {
        let event = tauri::WindowEvent::DragDrop(dropped(Vec::new()));
        let drag = NativeDrag::window("main", &event).ok_or("missing empty drop")?;
        assert_eq!(drag.summary(), ("drop", 0));
        let Some(tauri::DragDropEvent::Drop { paths, .. }) = drag.main_event() else {
            return Err("empty drop was silently filtered out".into());
        };
        assert!(matches!(
            drop_sources(paths),
            Err(FileHostError::MissingDropPaths)
        ));
        Ok(())
    }

    #[test]
    fn unrelated_window_events_are_ignored() {
        assert!(NativeDrag::window("main", &tauri::WindowEvent::Focused(true)).is_none());
    }

    #[test]
    fn diagnostics_require_a_valid_temporary_isolation_marker(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempfile::tempdir()?;
        let database = directory.path().join("workspace.sqlite3");
        let marker = directory.path().join(".memokeep-isolated");
        assert!(!isolated_diagnostics(&database));
        std::fs::write(&marker, b"other")?;
        assert!(!isolated_diagnostics(&database));
        std::fs::write(&marker, b"synthetic")?;
        assert!(isolated_diagnostics(&database));
        assert!(!isolated_diagnostics(Path::new(
            "/not-existing/workspace.sqlite3"
        )));
        Ok(())
    }
}
