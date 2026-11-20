use std::{error::Error, path::Path};

use memokeep_storage::{initialize, pomodoro, read, write, Fields};
use serde_json::{json, Value};

const MINUTE: i64 = 60_000;
const START: i64 = 1_794_474_000_000;

fn setup() -> Result<(tempfile::TempDir, std::path::PathBuf), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let db = temp.path().join("workspace.sqlite");
    initialize(&db)?;
    let data: Fields = serde_json::from_value(json!({
        "settings": {"pomodoro": {"focus":25,"short":5,"long":15,"every":4,"autoBreak":true,"autoFocus":true}, "other":"keep"},
        "plans":[{"id":"plan-one","name":"学习计划"}], "focusSessions":[]
    }))?;
    write(&db, "desktop", 0, &data)?;
    Ok((temp, db))
}

fn command(db: &Path, action: &str, payload: Value, now: i64) -> Result<Value, Box<dyn Error>> {
    Ok(pomodoro::command(db, action, &payload, now)?)
}

#[test]
fn running_and_paused_timers_restore_from_the_database_and_preserve_real_active_intervals(
) -> Result<(), Box<dyn Error>> {
    let (_temp, db) = setup()?;
    command(
        &db,
        "start",
        json!({"planId":"plan-one","taskId":"task","taskName":"刷题"}),
        START,
    )?;
    let after_restart = pomodoro::get(&db, START + 6 * MINUTE + 8000)?;
    assert_eq!(after_restart["phase"], "focus");
    assert_eq!(after_restart["leftMs"], 25 * MINUTE - 6 * MINUTE - 8000);
    let paused = command(&db, "pause", Value::Null, START + 10 * MINUTE)?;
    assert_eq!(paused["leftMs"], 15 * MINUTE);
    assert!(pomodoro::recover(&db, START + 20 * MINUTE)?.is_none());
    assert_eq!(
        pomodoro::get(&db, START + 20 * MINUTE)?["leftMs"],
        paused["leftMs"]
    );
    command(&db, "resume", Value::Null, START + 20 * MINUTE)?;
    let finished = pomodoro::tick(&db, START + 35 * MINUTE)?.ok_or("missing completion")?;
    assert_eq!(finished["state"]["phase"], "break");
    assert_eq!(finished["state"]["running"], true);
    assert_eq!(finished["event"]["planName"], "学习计划");
    let saved = read(&db, "desktop")?;
    let session = &saved.data["focusSessions"][0];
    assert_eq!(session["planId"], "plan-one");
    assert_eq!(session["taskName"], "刷题");
    assert_eq!(session["minutes"], 25);
    assert_eq!(session["activeDurationMs"], 25 * MINUTE);
    assert_eq!(session["outcome"], "completed");
    assert_eq!(session["timeAccuracy"], "exact");
    assert_eq!(
        session["activeIntervals"]
            .as_array()
            .ok_or("missing intervals")?
            .len(),
        2
    );
    assert_eq!(saved.data["settings"]["other"], "keep");
    assert_eq!(session["id"], session["originSessionId"]);
    Ok(())
}

#[test]
fn recovery_records_expired_focus_once_at_its_deadline_and_never_autostarts_a_focus(
) -> Result<(), Box<dyn Error>> {
    let (_temp, db) = setup()?;
    command(&db, "start", Value::Null, START)?;
    let recovered =
        pomodoro::recover(&db, START + 2 * 60 * MINUTE)?.ok_or("missing recovered state")?;
    assert_eq!(recovered["state"]["phase"], "idle");
    assert_eq!(recovered["state"]["running"], false);
    assert_eq!(recovered["quiet"], true);
    let before = read(&db, "desktop")?;
    let session = &before.data["focusSessions"][0];
    assert_eq!(session["minutes"], 25);
    assert_eq!(session["activeDurationMs"], 25 * MINUTE);
    assert_eq!(session["endedAt"], "2026-11-12T09:25:00.000Z");
    assert_eq!(
        before.data["focusSessions"]
            .as_array()
            .ok_or("missing sessions")?
            .len(),
        1
    );
    assert!(pomodoro::recover(&db, START + 3 * 60 * MINUTE)?.is_none());
    assert_eq!(read(&db, "desktop")?.revision, before.revision);
    Ok(())
}

#[test]
fn recovery_preserves_the_remaining_break_and_live_ticks_honor_auto_focus(
) -> Result<(), Box<dyn Error>> {
    let (_temp, db) = setup()?;
    command(&db, "start", Value::Null, START)?;
    let result = pomodoro::recover(&db, START + 27 * MINUTE)?.ok_or("missing transition")?;
    assert_eq!(result["state"]["phase"], "break");
    assert_eq!(result["state"]["leftMs"], 3 * MINUTE);
    let complete = pomodoro::tick(&db, START + 30 * MINUTE)?.ok_or("missing break completion")?;
    assert_eq!(complete["event"]["type"], "break-complete");
    assert_eq!(complete["state"]["phase"], "focus");
    assert_eq!(complete["state"]["running"], true);
    assert_ne!(
        complete["state"]["focusSessionId"],
        result["state"]["focusSessionId"]
    );
    Ok(())
}

#[test]
fn stop_records_real_short_duration_and_skip_only_finishes_a_break() -> Result<(), Box<dyn Error>> {
    let (_temp, db) = setup()?;
    command(&db, "start", Value::Null, START)?;
    let unchanged = command(&db, "skip", Value::Null, START + 10_000)?;
    assert_eq!(unchanged["phase"], "focus");
    command(&db, "stop", Value::Null, START + 20_000)?;
    let data = read(&db, "desktop")?.data;
    assert_eq!(data["focusSessions"][0]["activeDurationMs"], 20_000);
    assert_eq!(data["focusSessions"][0]["outcome"], "stopped");
    assert_eq!(data["focusSessions"][0]["minutes"], 0);
    command(&db, "start", Value::Null, START + MINUTE)?;
    pomodoro::tick(&db, START + 26 * MINUTE)?;
    let skipped = command(&db, "skip", Value::Null, START + 27 * MINUTE)?;
    assert_eq!(skipped["phase"], "idle");
    assert_eq!(
        read(&db, "desktop")?.data["focusSessions"]
            .as_array()
            .ok_or("missing sessions")?
            .len(),
        2
    );
    Ok(())
}

#[test]
fn every_fourth_completed_focus_uses_the_long_break_and_settings_are_normalized(
) -> Result<(), Box<dyn Error>> {
    let (_temp, db) = setup()?;
    let settings = command(
        &db,
        "settings",
        json!({"focus":2,"short":0,"long":99,"every":4,"autoBreak":false,"autoFocus":false}),
        START,
    )?;
    assert_eq!(settings["settings"]["focus"], 5);
    assert_eq!(settings["settings"]["short"], 1);
    assert_eq!(settings["settings"]["long"], 60);
    for round in 0..4 {
        let at = START + round * 10 * MINUTE;
        command(&db, "start", Value::Null, at)?;
        let result = pomodoro::tick(&db, at + 5 * MINUTE)?.ok_or("missing completion")?;
        assert_eq!(result["state"]["long"], round == 3);
        assert_eq!(result["state"]["running"], false);
        assert_eq!(
            result["state"]["leftMs"],
            if round == 3 { 60 * MINUTE } else { MINUTE }
        );
    }
    Ok(())
}

#[test]
fn shared_commit_hook_is_atomic_and_retries_cannot_duplicate_a_completed_session(
) -> Result<(), Box<dyn Error>> {
    let (_temp, db) = setup()?;
    command(&db, "start", Value::Null, START)?;
    let baseline = read(&db, "desktop")?;
    let failure =
        pomodoro::tick_with_commit(&db, START + 25 * MINUTE, false, |tx, before, after| {
            assert!(!tx.is_autocommit());
            assert_eq!(before["focusSessions"].as_array().map(Vec::len), Some(0));
            assert_eq!(after["focusSessions"].as_array().map(Vec::len), Some(1));
            Err("同步账本写入失败".into())
        });
    assert!(failure.is_err());
    let retained = read(&db, "desktop")?;
    assert_eq!(retained.revision, baseline.revision);
    assert_eq!(retained.data, baseline.data);
    assert!(pomodoro::tick_with_commit(&db, START + 25 * MINUTE, false, |tx, _, _| {
        tx.execute_batch("CREATE TABLE hook_receipt(id INTEGER PRIMARY KEY); INSERT INTO hook_receipt VALUES(1)").map_err(|error| error.to_string())?;
        Ok(())
    })?.is_some());
    assert!(pomodoro::tick(&db, START + 25 * MINUTE)?.is_none());
    assert_eq!(
        read(&db, "desktop")?.data["focusSessions"]
            .as_array()
            .ok_or("missing sessions")?
            .len(),
        1
    );
    Ok(())
}

#[test]
fn bad_saved_state_and_clock_changes_do_not_create_invented_focus_time(
) -> Result<(), Box<dyn Error>> {
    let (_temp, db) = setup()?;
    let mut saved = read(&db, "desktop")?;
    saved.data["settings"]["pomodoroTimer"] = json!({"phase":"unknown","running":true});
    write(&db, "desktop", saved.revision, &saved.data)?;
    assert_eq!(pomodoro::get(&db, START)?["phase"], "idle");
    command(&db, "start", Value::Null, START)?;
    let paused = command(&db, "pause", Value::Null, START - 2000)?;
    assert_eq!(paused["focusElapsedMs"], 0);
    assert_eq!(paused["clockUncertain"], true);
    command(&db, "stop", Value::Null, START + 1000)?;
    let data = read(&db, "desktop")?.data;
    assert_eq!(data["focusSessions"][0]["timeAccuracy"], "clock-uncertain");
    assert_eq!(data["focusSessions"][0]["activeDurationMs"], 0);
    Ok(())
}
