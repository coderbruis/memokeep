use memokeep_storage::{
    initialize, read,
    reminders::{self, Batch, Context, Receipt},
    write,
};
use serde_json::{json, Value};
use std::{error::Error, path::Path};

fn at(value: &str) -> Result<i64, Box<dyn Error>> {
    Ok(chrono::DateTime::parse_from_rfc3339(value)?.timestamp_millis())
}
fn fixture(notifications: bool) -> Result<(tempfile::TempDir, i64), Box<dyn Error>> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("workspace.sqlite3");
    initialize(&path)?;
    write(
        &path,
        "desktop",
        0,
        &serde_json::from_value(
            json!({"memos":[{"id":"memo","title":"备忘提醒","notes":"<p>正文</p>","remindAt":"2026-11-17T11:59:00Z","repeat":"none","completed":false}],"settings":{"timeZone":"UTC","notificationsEnabled":notifications}}),
        )?,
    )?;
    Ok((dir, at("2026-11-17T12:00:00Z")?))
}
fn check(path: &Path, now: i64, claim: bool) -> Result<Batch, reminders::ReminderError> {
    reminders::check_with_context(path, now, claim, |_, _| Ok(None))
}
fn ack(path: &Path, key: &str, now: i64) -> Result<bool, reminders::ReminderError> {
    reminders::acknowledge_with_context(
        path,
        &Receipt {
            key: key.into(),
            memo_id: "memo".into(),
        },
        now,
        |_, _| Ok(None),
    )
}
fn update(path: &Path, modify: impl FnOnce(&mut Value)) -> Result<(), Box<dyn Error>> {
    let before = read(path, "desktop")?;
    let mut data = serde_json::to_value(before.data)?;
    modify(&mut data);
    write(
        path,
        "desktop",
        before.revision,
        &serde_json::from_value(data)?,
    )?;
    Ok(())
}

#[test]
fn popup_and_os_receipts_are_independent_local_and_survive_restart() -> Result<(), Box<dyn Error>> {
    let (dir, now) = fixture(true)?;
    let path = dir.path().join("workspace.sqlite3");
    let before = read(&path, "desktop")?;
    let batch = check(&path, now, true)?;
    assert_eq!(batch.rows.len(), 1);
    assert_eq!(batch.notifications.len(), 1);
    assert_eq!(batch.notifications[0].body, "备忘提醒\n正文");
    assert_eq!(check(&path, now, true)?.notifications.len(), 0);
    reminders::finish_notification(&path, &batch.notifications[0].key, true, now)?;
    assert_eq!(
        check(&path, now + 1, true)?.rows.len(),
        1,
        "an offer is not an actual popup display"
    );
    assert!(ack(&path, &batch.rows[0].key, now + 1)?);
    assert!(check(&path, now + 2, true)?.rows.is_empty());
    assert!(check(&path, now + 100_000, true)?.notifications.is_empty());
    let after = read(&path, "desktop")?;
    assert_eq!(before.revision, after.revision);
    assert_eq!(before.data, after.data);
    assert_eq!(after.data["memos"][0]["popupShownFor"], Value::Null);
    Ok(())
}

#[test]
fn idle_light_poll_reads_only_reminder_fields_without_taking_another_writers_lock(
) -> Result<(), Box<dyn Error>> {
    let (dir, now) = fixture(true)?;
    let path = dir.path().join("workspace.sqlite3");
    update(&path, |data| {
        data["memos"][0]["remindAt"] = json!("2026-11-18T12:00:00Z")
    })?;
    let poll = || {
        reminders::check_light_with_visible(&path, now, true, None, |_, data| {
            assert_eq!(data.len(), 2);
            assert!(data.contains_key("memos"));
            assert!(data.contains_key("settings"));
            Ok(None)
        })
    };
    assert!(poll()?.rows.is_empty());
    let mut writer = rusqlite::Connection::open(&path)?;
    let _transaction =
        writer.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    assert!(
        poll()?.rows.is_empty(),
        "an idle reader must coexist with a reserved writer"
    );
    Ok(())
}

#[test]
fn repeated_light_poll_does_not_rewrite_popup_receipts_or_notification_leases(
) -> Result<(), Box<dyn Error>> {
    let (dir, now) = fixture(true)?;
    let path = dir.path().join("workspace.sqlite3");
    let poll = |now| reminders::check_light_with_visible(&path, now, true, None, |_, _| Ok(None));
    let first = poll(now)?;
    assert_eq!(first.rows.len(), 1);
    assert_eq!(first.notifications.len(), 1);
    let db = rusqlite::Connection::open(&path)?;
    db.execute_batch("CREATE TRIGGER no_idle_receipt_insert BEFORE INSERT ON desktop_reminder_delivery BEGIN SELECT RAISE(ABORT,'idle receipt insert'); END;
        CREATE TRIGGER no_idle_receipt_update BEFORE UPDATE ON desktop_reminder_delivery BEGIN SELECT RAISE(ABORT,'idle receipt update'); END;")?;
    let next = poll(now + 2_000)?;
    assert_eq!(next.rows[0].key, first.rows[0].key);
    assert!(next.notifications.is_empty());
    Ok(())
}

#[test]
fn light_context_rejection_prevents_claiming_or_acknowledging_receipts(
) -> Result<(), Box<dyn Error>> {
    let (dir, now) = fixture(true)?;
    let path = dir.path().join("workspace.sqlite3");
    assert!(
        reminders::check_light_with_visible(&path, now, true, None, |_, _| Err(
            "uncontrolled source".into()
        ))
        .is_err()
    );
    let first = check(&path, now, true)?;
    let receipt = Receipt {
        key: first.rows[0].key.to_owned(),
        memo_id: "memo".into(),
    };
    assert!(
        reminders::acknowledge_light_with_context(&path, &receipt, now, |_, _| Err(
            "uncontrolled source".into()
        ))
        .is_err()
    );
    assert!(ack(&path, &receipt.key, now)?);
    Ok(())
}

#[test]
fn concurrent_light_claims_retry_against_fresh_snapshot_without_duplicate_submission(
) -> Result<(), Box<dyn Error>> {
    let (dir, now) = fixture(true)?;
    let path = dir.path().join("workspace.sqlite3");
    reminders::check_light_with_visible(&path, now - 120_000, false, None, |_, _| Ok(None))?;
    let barrier = std::sync::Barrier::new(2);
    let claims = std::thread::scope(|scope| {
        let poll = || {
            let first = std::cell::Cell::new(true);
            reminders::check_light_with_visible(&path, now, true, None, |_, _| {
                if first.replace(false) {
                    barrier.wait();
                }
                Ok(None)
            })
            .map(|batch| batch.notifications.len())
        };
        let first = scope.spawn(poll);
        let second = scope.spawn(poll);
        Ok::<_, Box<dyn Error>>(
            first.join().map_err(|_| "first worker panicked")??
                + second.join().map_err(|_| "second worker panicked")??,
        )
    })?;
    assert_eq!(claims, 1);
    Ok(())
}

#[test]
fn disabled_notifications_leave_pending_popup_and_notification_failure_has_retry_lease(
) -> Result<(), Box<dyn Error>> {
    let (dir, now) = fixture(false)?;
    let path = dir.path().join("workspace.sqlite3");
    let batch = check(&path, now, true)?;
    assert_eq!(batch.rows.len(), 1);
    assert!(batch.notifications.is_empty());
    update(&path, |data| {
        data["settings"]["notificationsEnabled"] = json!(true)
    })?;
    let batch = check(&path, now, true)?;
    assert_eq!(batch.notifications.len(), 1);
    reminders::finish_notification(&path, &batch.notifications[0].key, false, now)?;
    assert!(check(&path, now + 59_999, true)?.notifications.is_empty());
    assert_eq!(check(&path, now + 60_001, true)?.notifications.len(), 1);
    assert!(check(&path, now + 60_002, true)?.notifications.is_empty());
    assert_eq!(
        check(&path, now + 90_002, true)?.notifications.len(),
        1,
        "crashed submission may retry after its durable lease"
    );
    Ok(())
}

#[test]
fn foreground_check_cannot_claim_system_notification_or_write_shared_markers(
) -> Result<(), Box<dyn Error>> {
    let (dir, now) = fixture(true)?;
    let path = dir.path().join("workspace.sqlite3");
    let frontend = check(&path, now, false)?;
    assert!(frontend.notifications.is_empty());
    let native = check(&path, now, true)?;
    assert_eq!(native.notifications.len(), 1);
    check(&path, now, false)?;
    reminders::finish_notification(&path, &native.notifications[0].key, true, now)?;
    assert!(check(&path, now + 61_000, true)?.notifications.is_empty());
    Ok(())
}

#[test]
fn legacy_marker_seeds_this_device_only_without_changing_workspace() -> Result<(), Box<dyn Error>> {
    let (dir, now) = fixture(true)?;
    let path = dir.path().join("workspace.sqlite3");
    update(&path, |data| {
        data["memos"][0]["popupShownFor"] = data["memos"][0]["remindAt"].to_owned();
        data["memos"][0]["notifiedFor"] = data["memos"][0]["remindAt"].to_owned();
    })?;
    let before = read(&path, "desktop")?;
    let batch = check(&path, now, true)?;
    assert!(batch.rows.is_empty());
    assert!(batch.notifications.is_empty());
    assert_eq!(before.data, read(&path, "desktop")?.data);
    let db = rusqlite::Connection::open(path)?;
    let seeded: i64 = db.query_row(
        "SELECT count(*) FROM desktop_reminder_delivery WHERE source='legacy-marker'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(seeded, 2);
    Ok(())
}

#[test]
fn edits_deletions_and_restore_generation_reject_stale_popup_receipts() -> Result<(), Box<dyn Error>>
{
    let (dir, now) = fixture(true)?;
    let path = dir.path().join("workspace.sqlite3");
    let first = check(&path, now, true)?;
    update(&path, |data| {
        data["memos"][0]["remindAt"] = json!("2026-11-17T12:05:00Z")
    })?;
    assert!(!ack(&path, &first.rows[0].key, now)?);
    assert!(check(&path, now, true)?.rows.is_empty());
    let changed = check(&path, now + 300_000, true)?;
    assert_eq!(changed.rows.len(), 1);
    let mut db = rusqlite::Connection::open(&path)?;
    let tx = db.transaction()?;
    reminders::reset_on(&tx)?;
    tx.commit()?;
    assert!(!ack(&path, &changed.rows[0].key, now + 300_001)?);
    let restored = check(&path, now + 300_001, true)?;
    assert_ne!(restored.rows[0].key, changed.rows[0].key);
    update(&path, |data| data["memos"] = json!([]))?;
    assert!(!ack(&path, &restored.rows[0].key, now + 300_002)?);
    assert!(check(&path, now + 300_002, true)?.rows.is_empty());
    Ok(())
}

#[test]
fn calendar_preserves_wall_clock_across_dst_and_snoozes_occurrence() -> Result<(), Box<dyn Error>> {
    let daily = json!({"id":"daily","remindAt":"2026-03-07T14:00:00Z","repeat":"daily"});
    assert!(
        reminders::occurrence(&daily, at("2026-03-08T12:59:00Z")?, "America/New_York")?.is_none()
    );
    assert_eq!(
        reminders::occurrence(&daily, at("2026-03-08T13:00:00Z")?, "America/New_York")?
            .ok_or("missing occurrence")?
            .0,
        at("2026-03-08T13:00:00Z")?
    );
    let gap = json!({"remindAt":"2026-03-07T07:30:00Z","repeat":"daily"});
    assert_eq!(
        reminders::occurrence(&gap, at("2026-03-08T07:30:00Z")?, "America/New_York")?
            .ok_or("gap missing")?
            .0,
        at("2026-03-08T07:30:00Z")?
    );
    let overlap = json!({"remindAt":"2026-10-31T05:30:00Z","repeat":"daily"});
    assert_eq!(
        reminders::occurrence(&overlap, at("2026-11-01T06:45:00Z")?, "America/New_York")?
            .ok_or("overlap missing")?
            .0,
        at("2026-11-01T05:30:00Z")?
    );
    let snooze = json!({"reminder":{"kind":"calendar","anchorAt":"2026-03-07T14:00:00Z","repeat":"daily","timeZone":"America/New_York","snoozeUntil":"2026-03-08T13:10:00Z","snoozeOccurrenceKey":"2026-03-08T09:00:00"}});
    assert!(reminders::occurrence(&snooze, at("2026-03-08T13:05:00Z")?, "UTC")?.is_none());
    assert!(
        reminders::occurrence(&snooze, at("2026-03-08T13:10:00Z")?, "UTC")?
            .ok_or("missing snooze")?
            .1
            .contains(":snooze:")
    );
    Ok(())
}

#[test]
fn synced_calendar_metadata_is_optional_and_recovery_errors_never_fall_back(
) -> Result<(), Box<dyn Error>> {
    let (dir, now) = fixture(false)?;
    let path = dir.path().join("workspace.sqlite3");
    assert_eq!(check(&path, now, false)?.rows.len(), 1);
    let first = reminders::check_with_context(&path, now, false, |_, _| {
        Ok(Some(Context {
            namespace: "workspace:epoch1".into(),
            time_zone: "UTC".into(),
            ..Context::default()
        }))
    })?;
    let result = reminders::acknowledge_with_context(
        &path,
        &Receipt {
            key: first.rows[0].key.to_owned(),
            memo_id: "memo".into(),
        },
        now,
        |_, _| {
            Ok(Some(Context {
                namespace: "workspace:epoch2".into(),
                time_zone: "UTC".into(),
                ..Context::default()
            }))
        },
    )?;
    assert!(!result);
    assert!(reminders::check_with_context(&path, now, true, |_, _| Err(
        "SYNC_RECOVERY_REQUIRED".into()
    ))
    .is_err());
    assert_eq!(check(&path, now, false)?.rows.len(), 1);
    Ok(())
}

#[test]
fn batches_do_not_starve_new_reminders_behind_acknowledged_ones() -> Result<(), Box<dyn Error>> {
    let (dir, now) = fixture(false)?;
    let path = dir.path().join("workspace.sqlite3");
    update(&path, |data| {
        data["memos"]=json!((0..70).map(|id|json!({"id":format!("m{id}"),"remindAt":"2026-11-17T11:59:00Z","repeat":"none"})).collect::<Vec<_>>())
    })?;
    let first = check(&path, now, false)?;
    assert_eq!(first.rows.len(), 64);
    for row in first.rows {
        assert!(reminders::acknowledge_with_context(
            &path,
            &Receipt {
                key: row.key,
                memo_id: row.memo_id
            },
            now,
            |_, _| Ok(None)
        )?);
    }
    assert_eq!(check(&path, now, false)?.rows.len(), 6);
    Ok(())
}

#[test]
fn actual_backup_restore_and_undo_rotate_receipt_generation_atomically(
) -> Result<(), Box<dyn Error>> {
    let (dir, now) = fixture(false)?;
    let path = dir.path().join("workspace.sqlite3");
    update(&path, |data| {
        data["documents"] = json!([]);
        data["cards"] = json!([]);
    })?;
    let backup = dir.path().join("backup.json");
    memokeep_storage::backup::export(&path, &backup)?;
    let first = check(&path, now, false)?;
    let preview = memokeep_storage::backup::preview(&path, &backup)?;
    memokeep_storage::backup::apply_preview(&path, &preview.token)?;
    assert!(!ack(&path, &first.rows[0].key, now)?);
    let restored = check(&path, now, false)?;
    assert_ne!(restored.rows[0].key, first.rows[0].key);
    memokeep_storage::backup::undo(&path)?;
    assert!(!ack(&path, &restored.rows[0].key, now)?);
    assert_ne!(check(&path, now, false)?.rows[0].key, restored.rows[0].key);
    Ok(())
}

#[test]
fn concurrent_background_checks_claim_one_os_submission() -> Result<(), Box<dyn Error>> {
    let (dir, now) = fixture(true)?;
    let path = dir.path().join("workspace.sqlite3");
    let counts = std::thread::scope(|scope| {
        let first = scope.spawn(|| check(&path, now, true).map(|batch| batch.notifications.len()));
        let second = scope.spawn(|| check(&path, now, true).map(|batch| batch.notifications.len()));
        Ok::<_, Box<dyn Error>>((
            first.join().map_err(|_| "first worker panicked")??,
            second.join().map_err(|_| "second worker panicked")??,
        ))
    })?;
    assert_eq!(counts.0 + counts.1, 1);
    Ok(())
}

#[test]
fn failed_restore_rolls_back_local_receipt_generation_together_with_business_data(
) -> Result<(), Box<dyn Error>> {
    let (dir, now) = fixture(false)?;
    let path = dir.path().join("workspace.sqlite3");
    update(&path, |data| {
        data["documents"] = json!([]);
        data["cards"] = json!([]);
    })?;
    let backup = dir.path().join("backup.json");
    memokeep_storage::backup::export(&path, &backup)?;
    let first = check(&path, now, false)?;
    let before = read(&path, "desktop")?;
    let preview = memokeep_storage::backup::preview(&path, &backup)?;
    assert!(memokeep_storage::backup::apply_preview_with_commit(
        &path,
        &preview.token,
        |_, _, _| Err("isolated fault injection".into())
    )
    .is_err());
    assert!(ack(&path, &first.rows[0].key, now)?);
    let after = read(&path, "desktop")?;
    assert_eq!(before.revision, after.revision);
    assert_eq!(before.data, after.data);
    Ok(())
}

#[test]
fn invalid_imported_reminder_is_diagnosed_without_blocking_other_rows() -> Result<(), Box<dyn Error>>
{
    let (dir, now) = fixture(false)?;
    let path = dir.path().join("workspace.sqlite3");
    update(&path, |data| {
        data["memos"].as_array_mut().into_iter().for_each(|rows| {
            rows.push(json!({"id":"bad","remindAt":"not-a-date","repeat":"daily"}))
        })
    })?;
    let batch = check(&path, now, false)?;
    assert_eq!(batch.rows.len(), 1);
    assert_eq!(batch.rows[0].memo_id, "memo");
    assert_eq!(batch.issues.len(), 1);
    assert_eq!(
        read(&path, "desktop")?.data["memos"][1]["remindAt"],
        "not-a-date"
    );
    Ok(())
}

#[test]
fn visible_receipt_remains_valid_after_ack_but_not_after_reschedule() -> Result<(), Box<dyn Error>>
{
    let (dir, now) = fixture(false)?;
    let path = dir.path().join("workspace.sqlite3");
    let first = check(&path, now, false)?;
    let receipt = Receipt {
        key: first.rows[0].key.to_owned(),
        memo_id: "memo".into(),
    };
    assert!(ack(&path, &receipt.key, now)?);
    let valid = reminders::check_with_visible(&path, now, false, Some(&receipt), |_, _| Ok(None))?;
    assert_eq!(valid.active_valid, Some(true));
    assert!(valid.rows.is_empty());
    update(&path, |data| {
        data["memos"][0]["remindAt"] = json!("2026-11-17T12:30:00Z")
    })?;
    assert_eq!(
        reminders::check_with_visible(&path, now, false, Some(&receipt), |_, _| Ok(None))?
            .active_valid,
        Some(false)
    );
    Ok(())
}

#[test]
fn notification_batches_claim_only_one_submission_so_later_rows_do_not_lose_their_lease(
) -> Result<(), Box<dyn Error>> {
    let (dir, now) = fixture(true)?;
    let path = dir.path().join("workspace.sqlite3");
    update(&path, |data| {
        data["memos"]=json!((0..8).map(|id|json!({"id":format!("m{id}"),"remindAt":"2026-11-17T11:59:00Z","repeat":"none"})).collect::<Vec<_>>())
    })?;
    let first = check(&path, now, true)?;
    assert_eq!(first.notifications.len(), 1);
    assert_eq!(first.rows.len(), 8);
    let db = rusqlite::Connection::open(&path)?;
    let claims:i64=db.query_row("SELECT count(*) FROM desktop_reminder_delivery WHERE channel='notification' AND status='pending'",[],|r|r.get(0))?;
    assert_eq!(claims, 1);
    reminders::finish_notification(&path, &first.notifications[0].key, true, now + 29_000)?;
    let second = check(&path, now + 31_000, true)?;
    assert_eq!(second.notifications.len(), 1);
    assert_ne!(
        second.notifications[0].memo_id,
        first.notifications[0].memo_id
    );
    Ok(())
}

#[test]
fn corrupt_legacy_markers_do_not_block_normalized_or_unrelated_valid_reminders(
) -> Result<(), Box<dyn Error>> {
    let (dir, now) = fixture(false)?;
    let path = dir.path().join("workspace.sqlite3");
    update(&path, |data| {
        data["memos"].as_array_mut().into_iter().for_each(|rows| {
            rows.push(json!({"id":"normalized","remindAt":"bad","repeat":"daily","popupShownFor":"bad","notifiedFor":"bad","reminder":{"kind":"calendar","anchorAt":"2026-11-16T11:00:00Z","repeat":"daily","timeZone":"UTC"}}));
            rows.push(json!({"id":"normalized-once","remindAt":"bad","repeat":"none","popupShownFor":"bad","reminder":{"kind":"once","at":"2026-11-17T11:00:00Z"}}));
        });
    })?;
    let before = read(&path, "desktop")?;
    let batch = check(&path, now, false)?;
    assert_eq!(batch.rows.len(), 3);
    assert!(batch.rows.iter().any(|row| row.memo_id == "memo"));
    assert!(batch.rows.iter().any(|row| row.memo_id == "normalized"));
    assert!(batch
        .rows
        .iter()
        .any(|row| row.memo_id == "normalized-once"));
    assert_eq!(read(&path, "desktop")?.data, before.data);
    Ok(())
}
