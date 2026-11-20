use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager, Runtime, State, WebviewWindow};
use thiserror::Error;

const EVENT: &str = "workspace-speech";
const MAX_EVENT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum SpeechError {
    #[error("语音识别辅助程序不可用")]
    Unavailable,
    #[error("语音会话参数无效")]
    Invalid,
    #[error("无法开始语音识别：{0}")]
    Io(#[from] std::io::Error),
    #[error("语音会话暂时不可用")]
    Busy,
}

impl Serialize for SpeechError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub struct DesktopSpeech {
    name: &'static str,
    advanced: bool,
    current: Mutex<Option<Session>>,
}

struct Session {
    owner: String,
    input: ChildStdin,
    child: Arc<Mutex<Child>>,
}

impl DesktopSpeech {
    pub fn new(name: &'static str, advanced: bool) -> Self {
        Self {
            name,
            advanced,
            current: Mutex::new(None),
        }
    }

    fn executable(&self) -> Result<PathBuf, SpeechError> {
        let process = std::env::current_exe()?;
        process
            .parent()
            .map(|dir| dir.join(self.name))
            .filter(|path| path.is_file())
            .ok_or(SpeechError::Unavailable)
    }

    pub(crate) fn cancel_owner(&self, owner: &str) {
        if let Ok(mut active) = self.current.lock() {
            if active.as_ref().is_some_and(|item| item.owner == owner) {
                if let Some(session) = active.take() {
                    terminate(session, false);
                }
            }
        }
    }
}

fn terminate(mut session: Session, finish: bool) {
    let _ = session
        .input
        .write_all(if finish { b"stop\n" } else { b"cancel\n" });
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(if finish { 3500 } else { 500 }));
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
        }
    });
}

fn locale(value: &str) -> &str {
    match value {
        "zh-CN" | "zh-HK" | "en-US" => value,
        _ => "zh-CN",
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Options {
    locale: String,
    on_device: Option<bool>,
    detail: bool,
    max_minutes: Option<u8>,
    record_audio: bool,
}

#[tauri::command]
pub(crate) fn speech_available(host: State<'_, DesktopSpeech>) -> bool {
    host.executable().is_ok()
}

#[tauri::command]
pub(crate) async fn speech_status(
    host: State<'_, DesktopSpeech>,
    language: String,
) -> Result<Value, SpeechError> {
    let base = json!({"supported": false, "microphone": "unknown", "speech": "unknown", "onDevice": false, "recognizer": false});
    let Ok(helper) = host.executable() else {
        return Ok(base);
    };
    tauri::async_runtime::spawn_blocking(move || {
        let info = Command::new(helper).args(["--check", "--locale", locale(&language)]).output()
            .ok().filter(|reply| reply.status.success())
            .and_then(|reply| serde_json::from_slice::<Value>(&reply.stdout).ok());
        let status = |value: &Value| match value.as_u64() {
            Some(0) => "not-determined", Some(1) => "denied", Some(2) => "restricted",
            Some(3) => "granted", _ => "unknown",
        };
        // AVAuthorizationStatus orders restricted and denied differently from Speech.
        let microphone = |value: &Value| match value.as_u64() {
            Some(1) => "restricted", Some(2) => "denied", _ => status(value),
        };
        if let Some(info) = info {
            json!({"supported": true, "microphone": microphone(&info["microphone"]), "speech": status(&info["speech"]),
                "onDevice": info["onDevice"].as_bool() == Some(true), "recognizer": info["available"].as_bool() == Some(true)})
        } else { base }
    }).await.map_err(|_| SpeechError::Busy)
}

#[tauri::command]
pub(crate) async fn speech_start<R: Runtime>(
    window: WebviewWindow<R>,
    host: State<'_, DesktopSpeech>,
    id: String,
    terms: Vec<String>,
    options: Options,
) -> Result<Value, SpeechError> {
    if id.is_empty()
        || id.len() > 128
        || id.contains(char::is_control)
        || options.detail && !host.advanced
    {
        return Err(SpeechError::Invalid);
    }
    let hints: Vec<String> = terms
        .iter()
        .map(|term| term.trim())
        .filter(|term| !term.is_empty())
        .take(100)
        .map(|term| term.chars().take(60).collect())
        .collect();
    let hints = serde_json::to_string(&hints).map_err(|_| SpeechError::Invalid)?;
    let mut command = Command::new(host.executable()?);
    command.args(["--locale", locale(&options.locale), "--terms", &hints]);
    if options.on_device == Some(false) {
        command.arg("--allow-server");
    }
    if options.detail {
        command.args([
            "--detail",
            "--max-minutes",
            &options.max_minutes.unwrap_or(10).clamp(1, 10).to_string(),
        ]);
    }
    let recording = if options.detail && options.record_audio {
        let directory = tempfile::Builder::new()
            .prefix("memokeep-voice-")
            .tempdir()?;
        command
            .arg("--record-to")
            .arg(directory.path().join("recording.caf"));
        Some(directory)
    } else {
        None
    };
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut active = host.current.lock().map_err(|_| SpeechError::Busy)?;
    if let Some(previous) = active.take() {
        terminate(previous, true);
    }
    let mut child = command.spawn()?;
    let (Some(input), Some(output)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(SpeechError::Unavailable);
    };
    let child = Arc::new(Mutex::new(child));
    // The output reader reaps the process even after a new session replaces it.
    let reader_child = Arc::clone(&child);
    // The reader emits under the original session ID, independent of later requests.
    let session_id = id.clone();
    let owner = window.label().to_owned();
    *active = Some(Session {
        owner,
        input,
        child,
    });
    drop(active);
    thread::spawn(move || {
        let mut reader = BufReader::new(output);
        let mut settled = false;
        loop {
            let mut line = Vec::new();
            let bytes = std::io::Read::take(&mut reader, (MAX_EVENT_BYTES + 1) as u64)
                .read_until(b'\n', &mut line);
            let Ok(size) = bytes else { break };
            if size == 0 || size > MAX_EVENT_BYTES {
                break;
            }
            let Ok(Value::Object(mut event)) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            let terminal = matches!(
                event.get("type").and_then(Value::as_str),
                Some("final" | "error" | "cancelled")
            );
            if terminal && !settled && event.get("type").and_then(Value::as_str) == Some("final") {
                if let Some(encoded) = recording
                    .as_ref()
                    .and_then(|folder| recording_data(folder.path()))
                {
                    let _ = window.emit_to(window.label(), EVENT, json!({"type": "recording-audio", "session": session_id, "encoded": encoded}));
                }
            }
            settled |= terminal;
            event.insert("session".into(), json!(session_id));
            let _ = window.emit_to(window.label(), EVENT, event);
        }
        if let Ok(mut process) = reader_child.lock() {
            let _ = process.kill();
            let _ = process.wait();
        }
        if !settled {
            let _ = window.emit_to(window.label(), EVENT, json!({"type": "error", "code": "exited", "session": session_id, "message": "语音识别意外停止了"}));
        }
        if let Some(host) = window.try_state::<DesktopSpeech>() {
            if let Ok(mut active) = host.current.lock() {
                if active
                    .as_ref()
                    .is_some_and(|item| Arc::ptr_eq(&item.child, &reader_child))
                {
                    *active = None;
                }
            }
        }
    });
    Ok(json!({"ok": true, "session": id}))
}

fn recording_data(directory: &std::path::Path) -> Option<String> {
    let source = directory.join("recording.caf");
    let encoded = directory.join("recording.m4a");
    if !source.is_file() {
        return None;
    }
    // Finish encoding after dropping the mic tap, using the system file converter.
    let status = Command::new("/usr/bin/afconvert")
        .args(["-f", "m4af", "-d", "aac", "-c", "1", "-b", "64000"])
        .arg(source)
        .arg(&encoded)
        .stderr(Stdio::null())
        .status()
        .ok()?;
    if !status.success() {
        return None;
    }
    let length = encoded.metadata().ok()?.len();
    if length == 0 || length > 100 * 1024 * 1024 {
        return None;
    }
    std::fs::read(encoded)
        .ok()
        .map(|bytes| STANDARD.encode(bytes))
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Control {
    Stop,
    Cancel,
    Pause,
    Resume,
}

#[tauri::command]
pub(crate) fn speech_control<R: Runtime>(
    window: WebviewWindow<R>,
    host: State<'_, DesktopSpeech>,
    action: Control,
) -> Result<bool, SpeechError> {
    let mut active = host.current.lock().map_err(|_| SpeechError::Busy)?;
    let Some(session) = active.as_mut().filter(|item| item.owner == window.label()) else {
        return Ok(false);
    };
    let input: &[u8] = match action {
        Control::Stop => b"stop\n",
        Control::Cancel => {
            if let Some(session) = active.take() {
                terminate(session, false);
            }
            return Ok(true);
        }
        Control::Pause if host.advanced => b"pause\n",
        Control::Resume if host.advanced => b"resume\n",
        _ => return Ok(false),
    };
    Ok(session.input.write_all(input).is_ok())
}

#[tauri::command]
pub(crate) fn speech_settings(code: String) -> Result<(), SpeechError> {
    let key = if code == "speech-denied" {
        "Privacy_SpeechRecognition"
    } else {
        "Privacy_Microphone"
    };
    Command::new("/usr/bin/open")
        .arg(format!(
            "x-apple.systempreferences:com.apple.preference.security?{key}"
        ))
        .spawn()?;
    Ok(())
}
