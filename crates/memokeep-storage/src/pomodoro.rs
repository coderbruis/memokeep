//! Database-owned desktop timer, shared by every application window.
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use thiserror::Error;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{connect, read_on, write_on, Fields, StorageError};

const MINUTE: i64 = 60_000;

#[derive(Debug, Error)]
pub enum PomodoroError {
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error("番茄钟数据无法保存：{0}")]
    Sql(#[from] rusqlite::Error),
    #[error("番茄钟指令无效")]
    InvalidCommand,
    #[error("番茄钟时间无效")]
    InvalidTime,
    #[error("番茄钟结果无法序列化")]
    Json(#[from] serde_json::Error),
    #[error("番茄钟提交失败：{0}")]
    Commit(String),
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Idle,
    Focus,
    Break,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct State {
    phase: Phase,
    running: bool,
    ends_at: Option<i64>,
    left_ms: i64,
    total_ms: i64,
    plan_id: Option<String>,
    task_id: Option<String>,
    task_name: String,
    done_in_cycle: u32,
    focus_started_at: Option<i64>,
    focus_elapsed_ms: i64,
    running_since: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    focus_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_intervals: Option<Vec<Interval>>,
    clock_uncertain: bool,
    long: bool,
}

#[derive(Serialize)]
struct Interval {
    start: i64,
    end: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    focus: i64,
    short: i64,
    long: i64,
    every: u32,
    auto_break: bool,
    auto_focus: bool,
    sound: bool,
    pinned: bool,
    float_size: String,
    float_color: String,
    last_plan_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    float_position: Option<Value>,
}

fn number(input: &Value) -> Option<i64> {
    let value = input.as_f64()?;
    if !value.is_finite() || value.abs() > i64::MAX as f64 {
        return None;
    }
    Some(value.round() as i64)
}

fn minutes(input: Option<&Value>, fallback: i64, low: i64, high: i64) -> i64 {
    let value = match input {
        Some(Value::Null) => Some(0),
        Some(Value::Bool(value)) => Some(i64::from(*value)),
        Some(Value::String(value)) => {
            let text = value.trim();
            if text.is_empty() {
                Some(0)
            } else {
                text.parse::<f64>()
                    .ok()
                    .filter(|number| number.is_finite())
                    .map(|number| number.round() as i64)
            }
        }
        Some(value) => number(value),
        None => None,
    };
    value.unwrap_or(fallback).clamp(low, high)
}

fn optional_id(input: &Value) -> Option<String> {
    input
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn settings(input: &Value) -> Settings {
    let color = input["floatColor"]
        .as_str()
        .filter(|value| ["auto", "ink", "tomato", "mint", "sky", "apricot"].contains(value))
        .unwrap_or("auto");
    let position = &input["floatPosition"];
    Settings {
        focus: minutes(input.get("focus"), 25, 5, 120),
        short: minutes(input.get("short"), 5, 1, 30),
        long: minutes(input.get("long"), 15, 5, 60),
        every: minutes(input.get("every"), 4, 2, 8) as u32,
        auto_break: input["autoBreak"].as_bool().unwrap_or(true),
        auto_focus: input["autoFocus"].as_bool().unwrap_or(false),
        sound: input["sound"].as_bool().unwrap_or(true),
        pinned: input["pinned"].as_bool().unwrap_or(false),
        float_size: if input["floatSize"] == "card" {
            "card".into()
        } else {
            "pill".into()
        },
        float_color: color.into(),
        last_plan_id: optional_id(&input["lastPlanId"]),
        // The candidate owns only the validated pair until this one transaction commits.
        float_position: if position["x"].as_f64().is_some_and(f64::is_finite)
            && position["y"].as_f64().is_some_and(f64::is_finite)
        {
            Some(json!({"x": position["x"], "y": position["y"]}))
        } else {
            None
        },
    }
}

fn idle(settings: &Settings, plan_id: Option<String>, done_in_cycle: u32) -> State {
    State {
        phase: Phase::Idle,
        running: false,
        ends_at: None,
        left_ms: settings.focus * MINUTE,
        total_ms: settings.focus * MINUTE,
        plan_id,
        task_id: None,
        task_name: String::new(),
        done_in_cycle,
        focus_started_at: None,
        focus_elapsed_ms: 0,
        running_since: None,
        focus_session_id: None,
        active_intervals: None,
        clock_uncertain: false,
        long: false,
    }
}

fn restored(saved: &Value, settings: &Settings) -> State {
    let base = idle(settings, settings.last_plan_id.to_owned(), 0);
    let phase = match saved["phase"].as_str() {
        Some("focus") => Phase::Focus,
        Some("break") => Phase::Break,
        Some("idle") => Phase::Idle,
        _ => return base,
    };
    let mut state = State {
        phase,
        running: saved["running"].as_bool().unwrap_or(false) && phase != Phase::Idle,
        ends_at: number(&saved["endsAt"]),
        left_ms: number(&saved["leftMs"]).unwrap_or(base.left_ms).max(0),
        total_ms: number(&saved["totalMs"]).unwrap_or(base.total_ms).max(1),
        plan_id: optional_id(&saved["planId"]).or(base.plan_id),
        task_id: optional_id(&saved["taskId"]),
        task_name: saved["taskName"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(120)
            .collect(),
        done_in_cycle: number(&saved["doneInCycle"])
            .unwrap_or(0)
            .clamp(0, u32::MAX as i64) as u32,
        focus_started_at: number(&saved["focusStartedAt"]),
        focus_elapsed_ms: number(&saved["focusElapsedMs"]).unwrap_or(0).max(0),
        running_since: number(&saved["runningSince"]),
        focus_session_id: optional_id(&saved["focusSessionId"]),
        active_intervals: None,
        clock_uncertain: saved["clockUncertain"] == true,
        long: saved["long"] == true,
    };
    if let Some(rows) = saved["activeIntervals"]
        .as_array()
        .filter(|_| state.focus_session_id.is_some())
    {
        let intervals: Vec<_> = rows
            .iter()
            .filter_map(|row| {
                let (start, end) = (number(&row["start"])?, number(&row["end"])?);
                (end >= start).then_some(Interval { start, end })
            })
            .collect();
        state.clock_uncertain |= rows.len() != intervals.len();
        state.active_intervals = Some(intervals);
    }
    if state.running && (state.ends_at.is_none() || state.running_since.is_none()) {
        state.running = false;
        state.ends_at = None;
        state.running_since = None;
    }
    state
}

fn start(mut state: State, settings: &Settings, now: i64, payload: &Value) -> State {
    let plan = if payload.get("planId").is_some() {
        optional_id(&payload["planId"])
    } else {
        state
            .plan_id
            .take()
            .or_else(|| settings.last_plan_id.to_owned())
    };
    let mut next = idle(settings, plan, state.done_in_cycle);
    next.phase = Phase::Focus;
    next.task_id = optional_id(&payload["taskId"]);
    next.task_name = payload["taskName"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(120)
        .collect();
    next.focus_started_at = Some(now);
    next.focus_session_id = Some(Uuid::new_v4().to_string());
    next.active_intervals = Some(Vec::new());
    run(next, now)
}

fn run(mut state: State, now: i64) -> State {
    state.running = true;
    state.running_since = Some(now);
    state.ends_at = now.checked_add(state.left_ms);
    if state.ends_at.is_none() {
        state.running = false;
        state.running_since = None;
    }
    state
}

fn pause(mut state: State, now: i64) -> State {
    if !state.running {
        return state;
    }
    let since = state.running_since.unwrap_or(now);
    let end = now.min(state.ends_at.unwrap_or(now));
    let elapsed = end.saturating_sub(since).max(0).min(state.left_ms);
    if state.phase == Phase::Focus {
        if let Some(intervals) = &mut state.active_intervals {
            if end > since {
                intervals.push(Interval { start: since, end });
            }
        }
        state.focus_elapsed_ms = state.focus_elapsed_ms.saturating_add(elapsed);
    }
    state.clock_uncertain |= now < since;
    state.left_ms = state.left_ms.saturating_sub(elapsed).max(0);
    state.running = false;
    state.running_since = None;
    state.ends_at = None;
    state
}

fn iso(timestamp: i64) -> Result<String, PomodoroError> {
    let value = OffsetDateTime::from_unix_timestamp_nanos(i128::from(timestamp) * 1_000_000)
        .map_err(|_| PomodoroError::InvalidTime)?;
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        value.year(),
        value.month() as u8,
        value.day(),
        value.hour(),
        value.minute(),
        value.second(),
        value.millisecond()
    ))
}

fn session(state: &State, ended_at: i64, outcome: &str) -> Result<Value, PomodoroError> {
    let id = state
        .focus_session_id
        .as_deref()
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let exact = state.active_intervals.is_some() && state.focus_session_id.is_some();
    let intervals = state
        .active_intervals
        .as_ref()
        .into_iter()
        .flatten()
        .map(|interval| Ok(json!({"start": iso(interval.start)?, "end": iso(interval.end)?})))
        .collect::<Result<Vec<Value>, PomodoroError>>()?;
    Ok(
        json!({ "id": id, "originSessionId": id, "planId": state.plan_id, "taskId": state.task_id, "taskName": state.task_name,
            "startedAt": iso(state.focus_started_at.unwrap_or(ended_at))?, "endedAt": iso(ended_at)?,
            "minutes": (state.focus_elapsed_ms as f64 / MINUTE as f64).round() as i64,
            "activeDurationMs": state.focus_elapsed_ms, "outcome": outcome, "activeIntervals": intervals,
            "timeAccuracy": if exact { if state.clock_uncertain { "clock-uncertain" } else { "exact" } } else { "legacy-summary" }
        }),
    )
}

fn start_break(mut state: State, settings: &Settings, now: i64) -> State {
    state.long = state.done_in_cycle > 0 && state.done_in_cycle.is_multiple_of(settings.every);
    state.left_ms = if state.long {
        settings.long
    } else {
        settings.short
    } * MINUTE;
    state.total_ms = state.left_ms;
    state.phase = Phase::Break;
    state.running = false;
    state.ends_at = None;
    state.running_since = None;
    state.focus_started_at = None;
    state.focus_elapsed_ms = 0;
    if settings.auto_break {
        run(state, now)
    } else {
        state
    }
}

fn advance(
    state: State,
    settings: &Settings,
    now: i64,
    allow_auto_focus: bool,
) -> Result<(State, Option<Value>), PomodoroError> {
    let Some(ends_at) = state.ends_at.filter(|end| state.running && now >= *end) else {
        return Ok((state, None));
    };
    if state.phase == Phase::Focus {
        let mut ended = pause(state, ends_at);
        let event =
            json!({"type": "focus-complete", "session": session(&ended, ends_at, "completed")?});
        ended.done_in_cycle = ended.done_in_cycle.saturating_add(1);
        return Ok((start_break(ended, settings, now), Some(event)));
    }
    let rested = idle(settings, state.plan_id, state.done_in_cycle);
    let next = if allow_auto_focus && settings.auto_focus {
        start(rested, settings, now, &Value::Null)
    } else {
        rested
    };
    Ok((next, Some(json!({"type": "break-complete"}))))
}

fn record(data: &mut Fields, event: &mut Value) -> Result<(), PomodoroError> {
    let Some(session) = event.get("session") else {
        return Ok(());
    };
    let id = session["id"].as_str().ok_or(PomodoroError::InvalidTime)?;
    // Take ownership of the candidate collection while its enclosing JSON value is moved.
    let mut rows = data
        .remove("focusSessions")
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    if !rows.iter().any(|row| row["id"].as_str() == Some(id)) {
        // The completed session is also returned to the UI after this transaction.
        rows.push(session.clone());
    }
    data.insert("focusSessions".into(), Value::Array(rows));
    let plan_name = data
        .get("plans")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|plan| plan["id"] == session["planId"])
        .and_then(|plan| plan["name"].as_str())
        .unwrap_or("");
    event["planName"] = json!(plan_name);
    Ok(())
}

fn view(state: &State, settings: &Settings, now: i64) -> Result<Value, PomodoroError> {
    let mut snapshot = serde_json::to_value(state)?;
    if state.running {
        snapshot["leftMs"] = json!(state
            .left_ms
            .min(state.ends_at.unwrap_or(now).saturating_sub(now).max(0)));
    }
    snapshot["round"] = json!(state.done_in_cycle % settings.every + 1);
    snapshot["every"] = json!(settings.every);
    snapshot["settings"] = serde_json::to_value(settings)?;
    Ok(snapshot)
}

fn load(data: &Fields) -> (State, Settings) {
    let input = data.get("settings").unwrap_or(&Value::Null);
    let settings = settings(&input["pomodoro"]);
    (restored(&input["pomodoroTimer"], &settings), settings)
}

fn install_state(
    data: &mut Fields,
    state: &State,
    settings: &Settings,
    now: i64,
) -> Result<(), PomodoroError> {
    // The JSON value is moved out of the candidate; preserve every unrelated setting.
    let mut config = data
        .remove("settings")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    config.insert("pomodoro".into(), serde_json::to_value(settings)?);
    let mut timer = serde_json::to_value(state)?;
    timer["savedAt"] = json!(now);
    config.insert("pomodoroTimer".into(), timer);
    data.insert("settings".into(), Value::Object(config));
    Ok(())
}

/// Reads the persisted timer without maintaining an application-wide memory copy.
pub fn get(database: &Path, now: i64) -> Result<Value, PomodoroError> {
    let snapshot = crate::read_fields(database, "desktop", &["settings".into()])?;
    let (state, settings) = load(&snapshot.data);
    view(&state, &settings, now)
}

pub fn command(
    database: &Path,
    command: &str,
    payload: &Value,
    now: i64,
) -> Result<Value, PomodoroError> {
    command_with_commit(database, command, payload, now, |_, _, _| Ok(()))
}

/// A private host may extend the same transaction with a generic committed-change ledger.
pub fn command_with_commit<F>(
    database: &Path,
    command: &str,
    payload: &Value,
    now: i64,
    commit: F,
) -> Result<Value, PomodoroError>
where
    F: FnOnce(&Connection, &Fields, &Fields) -> Result<(), String>,
{
    if command == "get" {
        return get(database, now);
    }
    iso(now)?;
    let mut db = connect(database)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let snapshot = read_on(&tx, "desktop")?;
    // The hook receives both the durable baseline and the isolated candidate.
    let mut candidate = snapshot.data.clone();
    let (mut state, mut settings) = load(&candidate);
    let mut event = Value::Null;
    match command {
        "start" => {
            state = start(state, &settings, now, payload);
            settings.last_plan_id = state.plan_id.to_owned();
        }
        "pause" => {
            state = pause(state, now);
        }
        "resume" if state.phase != Phase::Idle && !state.running => {
            state = run(state, now);
        }
        "resume" => {}
        "stop" => {
            if state.phase == Phase::Focus {
                state = pause(state, now);
                event =
                    json!({"type": "focus-stopped", "session": session(&state, now, "stopped")?});
            }
            state = idle(&settings, state.plan_id, state.done_in_cycle);
        }
        "skip" if state.phase == Phase::Break => {
            state = idle(&settings, state.plan_id, state.done_in_cycle);
            event = json!({"type": "break-skipped"});
        }
        "skip" => {}
        "set-plan" => {
            state.plan_id = optional_id(&payload["planId"]);
            settings.last_plan_id = state.plan_id.to_owned();
        }
        "settings" | "pin" | "float-size" | "float-color" | "float-position" => {
            let mut value = serde_json::to_value(&settings)?;
            let patch: Map<String, Value> = match command {
                "pin" => Map::from_iter([("pinned".into(), json!(payload["pinned"] == true))]),
                "float-size" => Map::from_iter([("floatSize".into(), payload["size"].to_owned())]),
                "float-color" => {
                    Map::from_iter([("floatColor".into(), payload["color"].to_owned())])
                }
                "float-position" => Map::from_iter([("floatPosition".into(), payload.to_owned())]),
                _ => payload
                    .as_object()
                    .map(|map| {
                        map.iter()
                            .filter(|(key, _)| {
                                [
                                    "focus",
                                    "short",
                                    "long",
                                    "every",
                                    "autoBreak",
                                    "autoFocus",
                                    "sound",
                                ]
                                .contains(&key.as_str())
                            })
                            .map(|(key, value)| (key.to_owned(), value.to_owned()))
                            .collect()
                    })
                    .unwrap_or_default(),
            };
            if let Some(object) = value.as_object_mut() {
                object.extend(patch);
            }
            settings = self::settings(&value);
            if command == "settings" && state.phase == Phase::Idle {
                state = idle(&settings, state.plan_id, state.done_in_cycle);
            }
        }
        _ => return Err(PomodoroError::InvalidCommand),
    }
    record(&mut candidate, &mut event)?;
    install_state(&mut candidate, &state, &settings, now)?;
    write_on(&tx, "desktop", snapshot.revision, &candidate, false)?;
    commit(&tx, &snapshot.data, &candidate).map_err(PomodoroError::Commit)?;
    tx.commit()?;
    view(&state, &settings, now)
}

pub fn tick(database: &Path, now: i64) -> Result<Option<Value>, PomodoroError> {
    tick_with_commit(database, now, false, |_, _, _| Ok(()))
}

pub fn recover(database: &Path, now: i64) -> Result<Option<Value>, PomodoroError> {
    tick_with_commit(database, now, true, |_, _, _| Ok(()))
}

/// Recovery settles elapsed phases at their original deadline and never starts a new focus.
pub fn tick_with_commit<F>(
    database: &Path,
    now: i64,
    recovering: bool,
    commit: F,
) -> Result<Option<Value>, PomodoroError>
where
    F: FnOnce(&Connection, &Fields, &Fields) -> Result<(), String>,
{
    iso(now)?;
    let mut db = connect(database)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let timer: Option<String> = tx
        .query_row(
            "SELECT payload FROM workspace_field WHERE scope='desktop' AND field='settings'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let mut timer_fields = Fields::new();
    if let Some(timer) = timer {
        timer_fields.insert("settings".into(), serde_json::from_str(&timer)?);
    }
    let (mut state, settings) = load(&timer_fields);
    if !state.running || !state.ends_at.is_some_and(|end| now >= end) {
        return Ok(None);
    }
    let snapshot = read_on(&tx, "desktop")?;
    // The hook must see a stable before-image while the timer candidate is changed.
    let mut candidate = snapshot.data.clone();
    let mut last_event = Value::Null;
    for _ in 0..4 {
        if !state.running || !state.ends_at.is_some_and(|end| now >= end) {
            break;
        }
        let at = if recovering {
            state.ends_at.unwrap_or(now)
        } else {
            now
        };
        let (next, mut event) = advance(state, &settings, at, !recovering)?;
        state = next;
        if let Some(event) = &mut event {
            record(&mut candidate, event)?;
        }
        last_event = event.unwrap_or(Value::Null);
        if !recovering {
            break;
        }
    }
    install_state(&mut candidate, &state, &settings, now)?;
    write_on(&tx, "desktop", snapshot.revision, &candidate, false)?;
    commit(&tx, &snapshot.data, &candidate).map_err(PomodoroError::Commit)?;
    tx.commit()?;
    Ok(Some(
        json!({"state": view(&state, &settings, now)?, "event": last_event, "quiet": recovering}),
    ))
}
