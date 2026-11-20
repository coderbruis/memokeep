//! Device-local reminder receipts. No field in this ledger is a shared entity.
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use chrono::{
    DateTime, Datelike, Duration, LocalResult, NaiveDateTime, SecondsFormat, TimeZone, Timelike,
    Utc,
};
use chrono_tz::{OffsetComponents, Tz};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::{connect, read_fields_on, read_on, Fields, StorageError};

#[derive(Debug, Error)]
pub enum ReminderError {
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error("提醒账本无法读取：{0}")]
    Sql(#[from] rusqlite::Error),
    #[error("提醒记录无效：{0}")]
    Json(#[from] serde_json::Error),
    #[error("提醒时间或循环规则无效")]
    InvalidReminder,
    #[error("提醒投递凭据无效")]
    InvalidReceipt,
    #[error("提醒上下文无法校验：{0}")]
    Context(String),
}

/// A private host may provide committed calendar metadata without exposing its protocol.
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub namespace: String,
    pub time_zone: String,
    #[serde(default)]
    pub memo_revisions: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub key: String,
    pub memo_id: String,
    pub at: String,
    pub occurrence_key: String,
    pub channel: String,
    pub title: String,
    pub body: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub handled: bool,
    pub time_zone: String,
    pub rows: Vec<Offer>,
    pub notifications: Vec<Offer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_valid: Option<bool>,
    pub issues: Vec<Issue>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    memo_id: String,
    message: String,
}

struct Due<'a> {
    rows: Vec<(&'a Value, i64, String)>,
    issues: Vec<Issue>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub key: String,
    pub memo_id: String,
}

fn install(db: &Connection) -> Result<(), ReminderError> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS desktop_reminder_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_reminder_delivery(key TEXT PRIMARY KEY,namespace TEXT NOT NULL,memo_id TEXT NOT NULL,revision TEXT NOT NULL,occurrence TEXT NOT NULL,channel TEXT NOT NULL,at INTEGER NOT NULL,status TEXT NOT NULL,lease_until INTEGER NOT NULL DEFAULT 0,source TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS desktop_reminder_scope ON desktop_reminder_delivery(namespace,memo_id);")?;
    for name in ["device", "epoch"] {
        db.execute(
            "INSERT OR IGNORE INTO desktop_reminder_meta VALUES(?1,?2)",
            params![name, Uuid::new_v4().to_string()],
        )?;
    }
    Ok(())
}

fn ensure_installed(db: &mut Connection) -> Result<(), ReminderError> {
    let installed: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='desktop_reminder_meta')",
        [], |row| row.get(0),
    )?;
    if !installed {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        install(&tx)?;
        tx.commit()?;
    }
    Ok(())
}

fn reminder_data(db: &Connection, light: bool) -> Result<Fields, ReminderError> {
    if light {
        Ok(read_fields_on(db, "desktop", &["memos".into(), "settings".into()])?.data)
    } else {
        Ok(read_on(db, "desktop")?.data)
    }
}

fn metadata(db: &Connection, name: &str) -> Result<String, ReminderError> {
    Ok(db.query_row(
        "SELECT value FROM desktop_reminder_meta WHERE key=?1",
        [name],
        |row| row.get(0),
    )?)
}

/// Run in the same transaction as a backup restore/undo. Old offers remain auditable,
/// but cannot acknowledge an occurrence in the newly restored local generation.
pub fn reset_on(db: &Connection) -> Result<(), ReminderError> {
    install(db)?;
    db.execute(
        "UPDATE desktop_reminder_meta SET value=?1 WHERE key='epoch'",
        [Uuid::new_v4().to_string()],
    )?;
    Ok(())
}

fn milliseconds(value: &Value) -> Result<i64, ReminderError> {
    if let Some(value) = value.as_i64() {
        return Ok(value);
    }
    DateTime::parse_from_rfc3339(value.as_str().ok_or(ReminderError::InvalidReminder)?)
        .map(|value| value.timestamp_millis())
        .map_err(|_| ReminderError::InvalidReminder)
}

fn instant(at: i64) -> Result<DateTime<Utc>, ReminderError> {
    DateTime::from_timestamp_millis(at).ok_or(ReminderError::InvalidReminder)
}

fn iso(at: i64) -> Result<String, ReminderError> {
    Ok(instant(at)?.to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// A repeated hour chooses its first occurrence. A spring gap moves forward by
/// the DST gap, preserving minutes instead of snapping to the first valid minute.
fn local_time(local: NaiveDateTime, zone: Tz) -> Result<i64, ReminderError> {
    match zone.from_local_datetime(&local) {
        LocalResult::Single(at) => Ok(at.timestamp_millis()),
        LocalResult::Ambiguous(first, second) => Ok(first.min(second).timestamp_millis()),
        LocalResult::None => {
            for minutes in 1..=180 {
                let prior = local
                    .checked_sub_signed(Duration::minutes(minutes))
                    .ok_or(ReminderError::InvalidReminder)?;
                let next = local
                    .checked_add_signed(Duration::minutes(minutes))
                    .ok_or(ReminderError::InvalidReminder)?;
                if let (Some(before), Some(after)) = (
                    zone.from_local_datetime(&prior).earliest(),
                    zone.from_local_datetime(&next).earliest(),
                ) {
                    let gap = after.offset().base_utc_offset() + after.offset().dst_offset()
                        - before.offset().base_utc_offset()
                        - before.offset().dst_offset();
                    let shifted = local
                        .checked_add_signed(gap)
                        .ok_or(ReminderError::InvalidReminder)?;
                    return zone
                        .from_local_datetime(&shifted)
                        .earliest()
                        .map(|at| at.timestamp_millis())
                        .ok_or(ReminderError::InvalidReminder);
                }
            }
            Err(ReminderError::InvalidReminder)
        }
    }
}

pub fn occurrence(
    memo: &Value,
    now: i64,
    default_zone: &str,
) -> Result<Option<(i64, String)>, ReminderError> {
    if memo["completed"] == true {
        return Ok(None);
    }
    let reminder = &memo["reminder"];
    let calendar = reminder["kind"] == "calendar";
    let at = if reminder["kind"] == "once" {
        &reminder["at"]
    } else if calendar {
        &reminder["anchorAt"]
    } else {
        &memo["remindAt"]
    };
    if at.is_null() || at == "" {
        return Ok(None);
    }
    let anchor = milliseconds(at)?;
    if anchor > now {
        return Ok(None);
    }
    let repeat = if reminder["kind"] == "once" {
        "none"
    } else if calendar {
        reminder["repeat"].as_str().unwrap_or("none")
    } else {
        memo["repeat"].as_str().unwrap_or("none")
    };
    if repeat == "none" {
        return Ok(Some((anchor, iso(anchor)?)));
    }
    let zone: Tz = reminder["timeZone"]
        .as_str()
        .unwrap_or(default_zone)
        .parse()
        .map_err(|_| ReminderError::InvalidReminder)?;
    let origin = instant(anchor)?.with_timezone(&zone);
    let current = instant(now)?.with_timezone(&zone);
    let date = current.date_naive();
    let natural = format!(
        "{}T{:02}:{:02}:{:02}",
        date,
        origin.hour(),
        origin.minute(),
        origin.second()
    );
    if !reminder["snoozeUntil"].is_null() {
        let until = milliseconds(&reminder["snoozeUntil"])?;
        if instant(until)?.with_timezone(&zone).date_naive() == date && now >= until {
            return Ok(Some((
                until,
                format!(
                    "{}:snooze:{}",
                    reminder["snoozeOccurrenceKey"]
                        .as_str()
                        .unwrap_or(&date.to_string()),
                    iso(until)?
                ),
            )));
        }
        if now < until && reminder["snoozeOccurrenceKey"].as_str() == Some(natural.as_str()) {
            return Ok(None);
        }
    }
    let allowed = match repeat {
        "daily" => true,
        "weekdays" => current.weekday().number_from_monday() <= 5,
        "weekly" => current.weekday() == origin.weekday(),
        "monthly" => current.day() == origin.day(),
        "yearly" => current.day() == origin.day() && current.month() == origin.month(),
        _ => return Err(ReminderError::InvalidReminder),
    };
    if !allowed {
        return Ok(None);
    }
    let local = date
        .and_hms_opt(origin.hour(), origin.minute(), origin.second())
        .ok_or(ReminderError::InvalidReminder)?;
    let scheduled = local_time(local, zone)?;
    Ok((scheduled <= now).then_some((scheduled, natural)))
}

fn digest(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

fn resolve_context(
    db: &Connection,
    data: &Fields,
    supplied: Option<Context>,
) -> Result<Context, ReminderError> {
    let mut context = supplied.unwrap_or_else(|| Context {
        time_zone: data
            .get("settings")
            .and_then(|s| s["timeZone"].as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".into())),
        ..Context::default()
    });
    let _: Tz = context
        .time_zone
        .parse()
        .map_err(|_| ReminderError::InvalidReminder)?;
    context.namespace = format!(
        "{}:{}:{}",
        metadata(db, "device")?,
        metadata(db, "epoch")?,
        context.namespace
    );
    Ok(context)
}

fn revision(memo: &Value, context: &Context) -> String {
    context
        .memo_revisions
        .get(memo["id"].as_str().unwrap_or(""))
        .map_or_else(
            || digest(&json!([memo["remindAt"], memo["repeat"], memo["reminder"]])),
            String::to_owned,
        )
}

fn key(context: &Context, memo: &Value, revision: &str, occurrence: &str, channel: &str) -> String {
    digest(&json!([
        context.namespace,
        memo["id"],
        revision,
        occurrence,
        channel
    ]))
}

fn plain_body(memo: &Value) -> String {
    let html = dom_query::Document::from(memo["notes"].as_str().unwrap_or(""));
    let body = html.select("body").text().to_string();
    [memo["title"].as_str().unwrap_or("备忘录"), body.trim()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        .chars()
        .take(512)
        .collect()
}

fn due<'a>(data: &'a Fields, now: i64, context: &Context) -> Due<'a> {
    let mut rows = Vec::new();
    let mut issues = Vec::new();
    for memo in data
        .get("memos")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = memo["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 512)
        else {
            continue;
        };
        match occurrence(memo, now, &context.time_zone) {
            Ok(Some((at, occurrence))) => rows.push((memo, at, occurrence)),
            Ok(None) => {}
            Err(error) => issues.push(Issue {
                memo_id: id.to_owned(),
                message: error.to_string(),
            }),
        }
    }
    rows.sort_by_key(|(_, at, _)| *at);
    Due { rows, issues }
}

pub fn check_with_context<F>(
    path: &Path,
    now: i64,
    claim_notifications: bool,
    context: F,
) -> Result<Batch, ReminderError>
where
    F: FnOnce(&Connection, &Fields) -> Result<Option<Context>, String>,
{
    check_with_visible(path, now, claim_notifications, None, context)
}

pub fn check_with_visible<F>(
    path: &Path,
    now: i64,
    claim_notifications: bool,
    active: Option<&Receipt>,
    context: F,
) -> Result<Batch, ReminderError>
where
    F: FnOnce(&Connection, &Fields) -> Result<Option<Context>, String>,
{
    check(path, now, claim_notifications, active, false, true, context)
}

/// The host callback validates its committed source using only memos/settings.
/// Its transaction is a read snapshot until a receipt actually needs updating.
pub fn check_light_with_visible<F>(
    path: &Path,
    now: i64,
    claim_notifications: bool,
    active: Option<&Receipt>,
    context: F,
) -> Result<Batch, ReminderError>
where
    F: Fn(&Connection, &Fields) -> Result<Option<Context>, String>,
{
    let result = check(
        path,
        now,
        claim_notifications,
        active,
        true,
        false,
        &context,
    );
    match result {
        Err(ReminderError::Sql(rusqlite::Error::SqliteFailure(error, _)))
            if matches!(
                error.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            ) =>
        {
            // An actual receipt write may race another writer after the read snapshot.
            // Retry once under a write reservation and revalidate the host context.
            check(path, now, claim_notifications, active, true, true, context)
        }
        result => result,
    }
}

fn check<F>(
    path: &Path,
    now: i64,
    claim_notifications: bool,
    active: Option<&Receipt>,
    light: bool,
    immediate: bool,
    context: F,
) -> Result<Batch, ReminderError>
where
    F: FnOnce(&Connection, &Fields) -> Result<Option<Context>, String>,
{
    let mut db = connect(path)?;
    ensure_installed(&mut db)?;
    let tx = db.transaction_with_behavior(if immediate {
        TransactionBehavior::Immediate
    } else {
        TransactionBehavior::Deferred
    })?;
    let data = reminder_data(&tx, light)?;
    let context = resolve_context(
        &tx,
        &data,
        context(&tx, &data).map_err(ReminderError::Context)?,
    )?;
    let due = due(&data, now, &context);
    let mut valid = BTreeSet::new();
    for (memo, _, occurrence) in &due.rows {
        let revision = revision(memo, &context);
        for channel in ["popup", "notification"] {
            valid.insert(key(&context, memo, &revision, occurrence, channel));
        }
    }
    let mut old = tx.prepare(
        "SELECT key FROM desktop_reminder_delivery WHERE status IN ('offered','pending','failed')",
    )?;
    let obsolete = old
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(old);
    for key in obsolete {
        if !valid.contains(&key) {
            tx.execute("UPDATE desktop_reminder_delivery SET status='cancelled',updated_at=?2 WHERE key=?1", params![key, now])?;
        }
    }
    let mut batch = Batch {
        handled: true,
        time_zone: context.time_zone.to_owned(),
        rows: Vec::new(),
        notifications: Vec::new(),
        active_valid: active.map(|receipt| {
            due.rows.iter().any(|(memo, _, occurrence)| {
                memo["id"] == receipt.memo_id
                    && key(
                        &context,
                        memo,
                        &revision(memo, &context),
                        occurrence,
                        "popup",
                    ) == receipt.key
            })
        }),
        issues: due.issues,
    };
    for (memo, at, occurrence) in due.rows {
        let revision = revision(memo, &context);
        for (channel, marker) in [("popup", "popupShownFor"), ("notification", "notifiedFor")] {
            let key = key(&context, memo, &revision, &occurrence, channel);
            let existing: Option<(String, i64)> = tx
                .query_row(
                    "SELECT status,lease_until FROM desktop_reminder_delivery WHERE key=?1",
                    [&key],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            // Old acknowledgement markers are optional compatibility hints.
            // A corrupt legacy date must not invalidate a valid normalized
            // reminder or stop delivery of unrelated rows in this batch.
            let legacy_time = milliseconds(&memo["remindAt"]).and_then(instant).ok();
            let legacy = existing.is_none()
                && memo[marker].is_string()
                && memo[marker] == memo["remindAt"]
                && legacy_time.is_some_and(|legacy| {
                    if memo["repeat"].as_str().is_none_or(|r| r == "none") {
                        return true;
                    }
                    let Ok(zone) = context.time_zone.parse::<Tz>() else {
                        return false;
                    };
                    instant(now).is_ok_and(|current| {
                        legacy.with_timezone(&zone).date_naive()
                            == current.with_timezone(&zone).date_naive()
                    })
                });
            if existing
                .as_ref()
                .is_some_and(|(status, _)| status == "delivered" || status == "submitted")
            {
                continue;
            }
            let (old_status, lease) = existing
                .as_ref()
                .map(|(s, l)| (s.as_str(), *l))
                .unwrap_or(("", 0));
            if legacy {
                save_row(
                    &tx,
                    &key,
                    &context.namespace,
                    memo,
                    &revision,
                    &occurrence,
                    channel,
                    at,
                    "delivered",
                    0,
                    "legacy-marker",
                    now,
                )?;
                continue;
            }
            if channel == "notification" {
                if data
                    .get("settings")
                    .is_none_or(|s| s["notificationsEnabled"] != true)
                {
                    continue;
                }
                if ["cancelled", "pending", "failed"].contains(&old_status) && lease > now {
                    if old_status == "cancelled" {
                        tx.execute(
                            "UPDATE desktop_reminder_delivery SET status='pending' WHERE key=?1",
                            [&key],
                        )?;
                    }
                    continue;
                }
                if !claim_notifications {
                    continue;
                }
            }
            if (channel == "popup" && batch.rows.len() >= 64)
                || (channel == "notification" && !batch.notifications.is_empty())
            {
                continue;
            }
            let status = if channel == "popup" {
                "offered"
            } else {
                "pending"
            };
            if channel != "popup" || old_status != "offered" {
                save_row(
                    &tx,
                    &key,
                    &context.namespace,
                    memo,
                    &revision,
                    &occurrence,
                    channel,
                    at,
                    status,
                    now.saturating_add(30_000),
                    "native",
                    now,
                )?;
            }
            let offer = Offer {
                key,
                memo_id: memo["id"].as_str().unwrap_or("").to_owned(),
                at: iso(at)?,
                occurrence_key: occurrence.to_owned(),
                channel: channel.into(),
                title: "备忘录提醒".into(),
                body: plain_body(memo),
            };
            if channel == "popup" {
                batch.rows.push(offer);
            } else {
                batch.notifications.push(offer);
            }
        }
    }
    tx.commit()?;
    Ok(batch)
}

#[allow(clippy::too_many_arguments)]
fn save_row(
    db: &Connection,
    key: &str,
    namespace: &str,
    memo: &Value,
    revision: &str,
    occurrence: &str,
    channel: &str,
    at: i64,
    status: &str,
    lease: i64,
    source: &str,
    now: i64,
) -> Result<(), ReminderError> {
    db.execute("INSERT INTO desktop_reminder_delivery VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(key) DO UPDATE SET status=excluded.status,lease_until=excluded.lease_until,updated_at=excluded.updated_at", params![key,namespace,memo["id"].as_str(),revision,occurrence,channel,at,status,lease,source,now])?;
    Ok(())
}

pub fn acknowledge_with_context<F>(
    path: &Path,
    receipt: &Receipt,
    now: i64,
    context: F,
) -> Result<bool, ReminderError>
where
    F: FnOnce(&Connection, &Fields) -> Result<Option<Context>, String>,
{
    acknowledge(path, receipt, now, false, context)
}

pub fn acknowledge_light_with_context<F>(
    path: &Path,
    receipt: &Receipt,
    now: i64,
    context: F,
) -> Result<bool, ReminderError>
where
    F: FnOnce(&Connection, &Fields) -> Result<Option<Context>, String>,
{
    acknowledge(path, receipt, now, true, context)
}

fn acknowledge<F>(
    path: &Path,
    receipt: &Receipt,
    now: i64,
    light: bool,
    context: F,
) -> Result<bool, ReminderError>
where
    F: FnOnce(&Connection, &Fields) -> Result<Option<Context>, String>,
{
    if receipt.key.len() != 64 || receipt.memo_id.is_empty() || receipt.memo_id.len() > 512 {
        return Err(ReminderError::InvalidReceipt);
    }
    let mut db = connect(path)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    install(&tx)?;
    let data = reminder_data(&tx, light)?;
    let context = resolve_context(
        &tx,
        &data,
        context(&tx, &data).map_err(ReminderError::Context)?,
    )?;
    let mut recorded = false;
    for (memo, _, occurrence) in due(&data, now, &context).rows {
        if memo["id"] != receipt.memo_id {
            continue;
        }
        let expected = key(
            &context,
            memo,
            &revision(memo, &context),
            &occurrence,
            "popup",
        );
        if expected != receipt.key {
            continue;
        }
        recorded = tx.execute("UPDATE desktop_reminder_delivery SET status='delivered',lease_until=0,updated_at=?3 WHERE key=?1 AND memo_id=?2 AND channel='popup' AND namespace=?4 AND status='offered'", params![receipt.key, receipt.memo_id, now, context.namespace])? == 1;
    }
    tx.commit()?;
    Ok(recorded)
}

/// The native API's success means submission to the OS, not proof the user saw it.
pub fn finish_notification(
    path: &Path,
    key: &str,
    success: bool,
    now: i64,
) -> Result<(), ReminderError> {
    let db = connect(path)?;
    db.execute("UPDATE desktop_reminder_delivery SET status=?2,lease_until=?3,updated_at=?4 WHERE key=?1 AND channel='notification' AND status='pending'", params![key, if success {"submitted"} else {"failed"}, if success {0} else {now.saturating_add(60_000)}, now])?;
    Ok(())
}
