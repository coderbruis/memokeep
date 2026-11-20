//! Desktop background work has no long-lived business snapshot.
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use memokeep_storage::{pomodoro, publishing, reminders};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};
use thiserror::Error;

use crate::{Database, DesktopWriter};

pub(crate) struct WorkerController(Arc<AtomicBool>);

impl WorkerController {
    pub(crate) fn stop(&self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

#[derive(Debug, Error)]
pub(crate) enum BackgroundError {
    #[error("此窗口无权操作后台服务")]
    Permission,
    #[error("工作空间后台服务还未就绪")]
    WriterUnavailable,
    #[error("后台任务意外停止")]
    Worker,
    #[error("主窗口暂时不可用")]
    MissingWindow,
    #[error("无法显示主窗口：{0}")]
    Window(#[from] tauri::Error),
    #[error(transparent)]
    Timer(#[from] pomodoro::PomodoroError),
    #[error(transparent)]
    Reminder(#[from] reminders::ReminderError),
}

impl Serialize for BackgroundError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn writer<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<Arc<dyn crate::WorkspaceWriter>>, BackgroundError> {
    let current = app.try_state::<DesktopWriter>();
    let database = app.try_state::<Database>();
    // A private host may install a coordinated writer after plugin setup. Wait
    // until it is ready so a recovery commit cannot bypass its transaction hook.
    if current.is_none() && database.is_some_and(|db| db.note_windows || db.external_desktop_writer)
    {
        return Err(BackgroundError::WriterUnavailable);
    }
    // The worker needs the writer while its short-lived SQLite transaction runs.
    Ok(current.map(|writer| Arc::clone(&writer.0)))
}

fn advance<R: Runtime>(
    app: &AppHandle<R>,
    database: &Path,
    recovering: bool,
) -> Result<Option<Value>, BackgroundError> {
    let at = now();
    let timer = pomodoro::get(database, at)?;
    if !timer_due(&timer, at) {
        return Ok(None);
    }
    let writer = writer(app)?;
    Ok(pomodoro::tick_with_commit(
        database,
        at,
        recovering,
        |tx, before, after| {
            if let Some(writer) = writer {
                writer
                    .prepare(tx, before, after)
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        },
    )?)
}

fn timer_due(timer: &Value, at: i64) -> bool {
    timer["running"] == true && timer["endsAt"].as_i64().is_some_and(|end| at >= end)
}

fn announce<R: Runtime>(app: &AppHandle<R>, event: Value) {
    if event["quiet"] != true {
        notify_completion(&event);
    }
    let _ = app.emit("workspace-pomodoro", event);
    let _ = app.emit("workspace-changed", ());
}

/// Starts after plugin setup. The first iteration restores persisted deadlines.
pub(crate) fn start<R: Runtime>(app: &AppHandle<R>, database: PathBuf) -> WorkerController {
    let running = Arc::new(AtomicBool::new(true));
    // Notification submission owns a separate worker so a slow OS API cannot
    // delay the persisted focus timer or Markdown publication.
    let reminder_path = database.to_path_buf();
    // The reminder worker shares only the shutdown controller and Tauri event handle.
    let reminder_running = Arc::clone(&running);
    let reminder_app = app.to_owned();
    thread::spawn(move || {
        let application = reminder_app;
        let database = reminder_path;
        while reminder_running.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_secs(2));
            if !reminder_running.load(Ordering::Relaxed) {
                break;
            }
            match check_reminders(&application, &database, true, None) {
                Ok(batch) => {
                    for offer in &batch.notifications {
                        let submitted = send_notification(Notification {
                            title: offer.title.to_owned(),
                            body: offer.body.to_owned(),
                            silent: false,
                        });
                        if let Err(error) =
                            reminders::finish_notification(&database, &offer.key, submitted, now())
                        {
                            eprintln!("提醒投递收据：{error}");
                        }
                    }
                    if !batch.rows.is_empty() {
                        let _ = application.emit_to("main", "workspace-reminders", &batch);
                    }
                }
                Err(error) => eprintln!("备忘录后台任务：{error}"),
            }
        }
    });
    // Publication owns a separate worker so a large projection cannot delay deadlines.
    let publishing_path = database.to_path_buf();
    // This worker shares shutdown state only; its queue remains in SQLite.
    let publishing_running = Arc::clone(&running);
    thread::spawn(move || {
        while publishing_running.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_secs(2));
            if !publishing_running.load(Ordering::Relaxed) {
                break;
            }
            if publishing::status(&publishing_path).is_ok_and(|state| state.pending) {
                if let Err(error) = publishing::publish(&publishing_path) {
                    eprintln!("Markdown 后台发布：{error}");
                }
            }
        }
    });
    // The worker and plugin controller share only the shutdown flag.
    let flag = Arc::clone(&running);
    // Tauri's handle keeps event delivery available while application windows change.
    let application = app.to_owned();
    thread::spawn(move || {
        let mut recovered = false;
        while flag.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_secs(2));
            if !flag.load(Ordering::Relaxed) {
                break;
            }
            match advance(&application, &database, !recovered) {
                Ok(event) => {
                    recovered = true;
                    if let Some(event) = event {
                        announce(&application, event);
                    }
                }
                Err(BackgroundError::WriterUnavailable) => continue,
                Err(error) => eprintln!("番茄钟后台任务：{error}"),
            }
        }
    });
    WorkerController(running)
}

fn check_reminders<R: Runtime>(
    app: &AppHandle<R>,
    path: &Path,
    claim: bool,
    active: Option<&reminders::Receipt>,
) -> Result<reminders::Batch, BackgroundError> {
    let writer = writer(app)?;
    Ok(reminders::check_light_with_visible(
        path,
        now(),
        claim,
        active,
        |tx, data| {
            writer
                .as_ref()
                .map(|writer| {
                    writer
                        .reminder_context_light(tx, data)
                        .map_err(|error| error.message.to_owned())
                })
                .transpose()
                .map(Option::flatten)
        },
    )?)
}

#[tauri::command]
pub(crate) async fn reminders_check<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    active_receipt: Option<reminders::Receipt>,
) -> Result<reminders::Batch, BackgroundError> {
    database
        .access(window.label(), "desktop")
        .map_err(|_| BackgroundError::Permission)?;
    if window.label() != "main" {
        return Err(BackgroundError::Permission);
    }
    let application = window.app_handle().to_owned();
    // The bounded worker owns only the path and application handle until SQLite closes.
    let path = Arc::clone(&database.path);
    tauri::async_runtime::spawn_blocking(move || {
        check_reminders(&application, &path, false, active_receipt.as_ref())
    })
    .await
    .map_err(|_| BackgroundError::Worker)?
}

#[tauri::command]
pub(crate) async fn reminders_ack<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    receipt: reminders::Receipt,
) -> Result<Value, BackgroundError> {
    database
        .access(window.label(), "desktop")
        .map_err(|_| BackgroundError::Permission)?;
    if window.label() != "main" {
        return Err(BackgroundError::Permission);
    }
    let writer = writer(window.app_handle())?;
    // Receipt validation and acknowledgement share one database transaction.
    let path = Arc::clone(&database.path);
    let recorded = tauri::async_runtime::spawn_blocking(move || {
        reminders::acknowledge_light_with_context(&path, &receipt, now(), |tx, data| {
            writer
                .as_ref()
                .map(|writer| {
                    writer
                        .reminder_context_light(tx, data)
                        .map_err(|error| error.message.to_owned())
                })
                .transpose()
                .map(Option::flatten)
        })
    })
    .await
    .map_err(|_| BackgroundError::Worker)??;
    Ok(serde_json::json!({"handled":true,"recorded":recorded}))
}

fn quote(input: &str) -> String {
    let mut result = String::from("\"");
    for ch in input.chars() {
        match ch {
            '\\' | '"' => {
                result.push('\\');
                result.push(ch);
            }
            ch if ch.is_control() => result.push(' '),
            ch => result.push(ch),
        }
    }
    result.push('"');
    result
}

fn notify_completion(snapshot: &Value) {
    if cfg!(feature = "smoke-test") {
        return;
    }
    let event = &snapshot["event"];
    let (title, body) = match event["type"].as_str() {
        Some("focus-complete") => {
            let minutes = event["session"]["minutes"].as_i64().unwrap_or(0);
            let plan = event["planName"].as_str().unwrap_or("");
            (
                "完成一个番茄",
                if plan.is_empty() {
                    format!("{minutes} 分钟已记录")
                } else {
                    format!("{minutes} 分钟记入「{plan}」")
                },
            )
        }
        Some("break-complete") => ("休息好了", "准备好就开始下一个番茄".into()),
        _ => return,
    };
    send_notification(Notification {
        title: title.into(),
        body,
        silent: snapshot["state"]["settings"]["sound"] == false,
    });
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct Notification {
    title: String,
    body: String,
    silent: bool,
}

fn bounded(input: &str, limit: usize) -> String {
    input.chars().take(limit).collect()
}

fn notification_script(notification: &Notification) -> String {
    let title = if notification.title.trim().is_empty() {
        "MemoKeep"
    } else {
        &notification.title
    };
    let sound = if notification.silent {
        ""
    } else {
        " sound name \"Glass\""
    };
    format!(
        "display notification {} with title {}{sound}",
        quote(&bounded(&notification.body, 512)),
        quote(&bounded(title, 80))
    )
}

fn send_notification(notification: Notification) -> bool {
    if cfg!(feature = "smoke-test") {
        return false;
    }
    let child = Command::new("/usr/bin/osascript")
        .args(["-e", &notification_script(&notification)])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        return false;
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn desktop_notify<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    notification: Notification,
) -> Result<bool, BackgroundError> {
    database
        .access(window.label(), "desktop")
        .map_err(|_| BackgroundError::Permission)?;
    tauri::async_runtime::spawn_blocking(move || send_notification(notification))
        .await
        .map_err(|_| BackgroundError::Worker)
}

#[tauri::command]
pub(crate) async fn open_app<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
) -> Result<(), BackgroundError> {
    database
        .access(window.label(), "desktop")
        .map_err(|_| BackgroundError::Permission)?;
    let main = window
        .app_handle()
        .get_webview_window("main")
        .ok_or(BackgroundError::MissingWindow)?;
    main.unminimize()?;
    main.show()?;
    main.set_focus()?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn pomodoro_get<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
) -> Result<Value, BackgroundError> {
    database
        .access(window.label(), "desktop")
        .map_err(|_| BackgroundError::Permission)?;
    // The blocking read owns a database-path reference until SQLite closes.
    let path = Arc::clone(&database.path);
    tauri::async_runtime::spawn_blocking(move || pomodoro::get(&path, now()))
        .await
        .map_err(|_| BackgroundError::Worker)?
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn pomodoro_command<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    command: String,
    payload: Value,
) -> Result<Value, BackgroundError> {
    database
        .access(window.label(), "desktop")
        .map_err(|_| BackgroundError::Permission)?;
    let writer = writer(window.app_handle())?;
    // The worker uses the same database and coordinated writer as ordinary saves.
    let path = Arc::clone(&database.path);
    let result = tauri::async_runtime::spawn_blocking(move || {
        pomodoro::command_with_commit(&path, &command, &payload, now(), |tx, before, after| {
            if let Some(writer) = writer {
                writer
                    .prepare(tx, before, after)
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        })
    })
    .await
    .map_err(|_| BackgroundError::Worker)??;
    // The command result is also returned to the requesting view after delivery.
    let _ = window.app_handle().emit(
        "workspace-pomodoro",
        serde_json::json!({"state": result, "event": null}),
    );
    let _ = window.app_handle().emit("workspace-changed", ());
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{notification_script, quote, timer_due, Notification};

    #[test]
    fn timer_preflight_requests_a_write_only_for_a_running_expired_deadline() {
        assert!(!timer_due(
            &serde_json::json!({"running":false,"endsAt":0}),
            1
        ));
        assert!(!timer_due(
            &serde_json::json!({"running":true,"endsAt":10}),
            9
        ));
        assert!(timer_due(
            &serde_json::json!({"running":true,"endsAt":10}),
            10
        ));
        assert!(!timer_due(&serde_json::json!({"running":true}), 10));
    }

    #[test]
    fn system_notification_arguments_cannot_introduce_another_script_statement() {
        assert_eq!(
            quote("学习\"; do shell script \"touch bad\"\n"),
            "\"学习\\\"; do shell script \\\"touch bad\\\" \""
        );
    }

    #[test]
    fn notification_content_is_bounded_before_script_escaping() {
        let notification = Notification {
            title: "题".repeat(1000),
            body: "文".repeat(10000),
            silent: true,
        };
        let script = notification_script(&notification);
        assert_eq!(script.chars().filter(|ch| *ch == '题').count(), 80);
        assert_eq!(script.chars().filter(|ch| *ch == '文').count(), 512);
        assert!(!script.contains("sound name"));
    }
}
