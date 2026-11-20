use memokeep_desktop_services::files::{self, FileError, Origin};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::{
    error::Error,
    fs,
    path::{Path, PathBuf},
};
use tempfile::{tempdir, TempDir};
use url::Url;

fn fixture() -> Result<(TempDir, PathBuf, PathBuf), Box<dyn Error>> {
    let directory = tempdir()?;
    let database = directory.path().join("workspace.sqlite3");
    let db = Connection::open(&database)?;
    db.execute_batch("CREATE TABLE workspace_field(scope TEXT,field TEXT,payload TEXT);")?;
    let source = directory.path().join("中文 空格.md");
    fs::write(&source, "\u{feff}# 原始笔记\n你好 😀")?;
    Ok((directory, database, source))
}
fn enqueue(database: &Path, source: &Path, origin: Origin) -> Result<(), Box<dyn Error>> {
    let report = files::enqueue(
        database,
        &[source.to_string_lossy().into_owned()],
        None,
        origin,
        None,
    )?;
    assert_eq!(report.added, 1);
    Ok(())
}
fn grant(database: &Path, source: &Path) -> Result<String, Box<dyn Error>> {
    enqueue(database, source, Origin::Drop)?;
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("source name")?;
    files::pending(database)?
        .into_iter()
        .find(|row| row.name == name && row.token.is_some())
        .and_then(|row| row.token)
        .ok_or_else(|| "missing grant".into())
}

#[test]
fn unicode_file_url_cold_queue_is_durable_ordered_and_strips_bom() -> Result<(), Box<dyn Error>> {
    let (_dir, db, source) = fixture()?;
    let second = source.with_file_name("下一篇.TXT");
    fs::write(&second, "第二篇")?;
    let sources = vec![
        Url::from_file_path(&source)
            .map_err(|_| "invalid URL")?
            .into(),
        second.to_string_lossy().into_owned(),
    ];
    assert_eq!(
        files::enqueue(&db, &sources, None, Origin::System, None)?.added,
        2
    );
    let first = files::pending(&db)?;
    assert_eq!(first.len(), 2);
    assert_eq!(first[0].name, "中文 空格.md");
    assert_eq!(first[0].content.as_deref(), Some("# 原始笔记\n你好 😀"));
    assert_eq!(first[1].content.as_deref(), Some("第二篇"));
    assert!(matches!(first[0].origin, Origin::System));
    // Reopening SQLite simulates a host restart; taking is intentionally non-destructive.
    assert_eq!(files::pending(&db)?[0].id, first[0].id);
    assert!(files::acknowledge(&db, &first[0].id)?);
    assert!(!files::acknowledge(&db, &first[0].id)?);
    assert_eq!(files::pending(&db)?.len(), 1);
    Ok(())
}

#[test]
fn pending_paths_are_deduplicated_but_user_can_reopen_after_ack() -> Result<(), Box<dyn Error>> {
    let (_dir, db, source) = fixture()?;
    enqueue(&db, &source, Origin::System)?;
    let duplicate = files::enqueue(
        &db,
        &[source.to_string_lossy().into_owned()],
        None,
        Origin::Drop,
        None,
    )?;
    assert_eq!(duplicate.added, 0);
    assert_eq!(duplicate.deduplicated, 1);
    assert_eq!(duplicate.ignored, 0);
    let item = files::pending(&db)?.remove(0);
    files::acknowledge(&db, &item.id)?;
    enqueue(&db, &source, Origin::Drop)?;
    assert!(matches!(files::pending(&db)?[0].origin, Origin::Drop));
    Ok(())
}

#[test]
fn missing_bad_utf8_and_oversize_files_do_not_block_other_files() -> Result<(), Box<dyn Error>> {
    let (dir, db, source) = fixture()?;
    let missing = dir.path().join("不存在.md");
    let bad = dir.path().join("编码.txt");
    fs::write(&bad, [0xff, 0xfe, 0])?;
    let big = dir.path().join("很大.md");
    let file = fs::File::create(&big)?;
    file.set_len(files::MAX_BYTES as u64 + 1)?;
    let sources = [missing, bad, big, source].map(|path| path.to_string_lossy().into_owned());
    assert_eq!(
        files::enqueue(&db, &sources, None, Origin::System, None)?.added,
        4
    );
    let pending = files::pending(&db)?;
    assert_eq!(pending.len(), 4);
    assert!(pending[..3].iter().all(|row| row.error.is_some()));
    assert!(pending[3].content.is_some());
    for row in pending {
        files::acknowledge(&db, &row.id)?;
    }
    assert!(files::pending(&db)?.is_empty());
    Ok(())
}

#[test]
fn only_supported_local_files_are_authorized() -> Result<(), Box<dyn Error>> {
    let (dir, db, _) = fixture()?;
    let report = files::enqueue(
        &db,
        &[
            "--isolated-demo".into(),
            "photo.png".into(),
            "https://example.com/secret.md".into(),
            "file://remote-host/tmp/a.md".into(),
            "file:///tmp/a.md?query=1".into(),
        ],
        Some(dir.path()),
        Origin::System,
        None,
    )?;
    assert_eq!(report.ignored, 2);
    assert_eq!(report.errors.len(), 3);
    assert!(files::pending(&db)?.iter().all(|row| row.token.is_none()));
    assert!(matches!(
        files::save_original(&db, "forged", "note.md", "x", None),
        Err(FileError::InvalidGrant)
    ));
    Ok(())
}

#[test]
fn original_directory_save_uses_grant_without_exposing_paths() -> Result<(), Box<dyn Error>> {
    let (dir, db, source) = fixture()?;
    let permission = grant(&db, &source)?;
    let result = files::save_original(&db, &permission, "新笔记.md", "# 新正文", None)?;
    assert!(result.saved);
    assert_eq!(
        fs::read_to_string(dir.path().join("新笔记.md"))?,
        "# 新正文"
    );
    assert_eq!(fs::read_to_string(&source)?, "\u{feff}# 原始笔记\n你好 😀");
    let encoded = serde_json::to_string(&files::pending(&db)?)?;
    assert!(!encoded.contains(&dir.path().to_string_lossy().to_string()));
    Ok(())
}

#[test]
fn acknowledge_and_revoke_are_separate_and_revocation_is_enforced() -> Result<(), Box<dyn Error>> {
    let (dir, db, source) = fixture()?;
    let permission = grant(&db, &source)?;
    let row = files::pending(&db)?.remove(0);
    files::acknowledge(&db, &row.id)?;
    assert!(files::pending(&db)?.is_empty());
    assert!(files::save_original(&db, &permission, "授权仍有效.txt", "copy", None)?.saved);
    assert!(files::revoke(&db, &permission)?);
    assert!(!files::revoke(&db, &permission)?);
    assert!(matches!(
        files::save_original(&db, &permission, "拒绝.txt", "no", None),
        Err(FileError::InvalidGrant)
    ));
    assert!(!dir.path().join("拒绝.txt").exists());
    Ok(())
}

#[test]
fn unsafe_names_and_oversize_writes_cannot_escape_authorized_directory(
) -> Result<(), Box<dyn Error>> {
    let (_dir, db, source) = fixture()?;
    let permission = grant(&db, &source)?;
    for name in [
        "../escape.md",
        "/tmp/escape.md",
        "sub/note.md",
        "sub\\note.md",
        "bad:stream.md",
        "bad\n.md",
        "image.png",
        ".",
        "",
    ] {
        assert!(
            matches!(
                files::save_original(&db, &permission, name, "x", None),
                Err(FileError::InvalidName)
            ),
            "{name}"
        );
    }
    assert!(matches!(
        files::save_original(
            &db,
            &permission,
            "large.md",
            &"x".repeat(files::MAX_BYTES + 1),
            None
        ),
        Err(FileError::TooLarge)
    ));
    Ok(())
}

#[test]
fn overwrite_requires_exact_one_time_confirmation_and_preserves_changed_targets(
) -> Result<(), Box<dyn Error>> {
    let (dir, db, source) = fixture()?;
    let permission = grant(&db, &source)?;
    let first = files::save_original(&db, &permission, "中文 空格.md", "修改", None)?;
    assert!(!first.saved);
    let confirmation = first.confirmation.ok_or("confirmation missing")?;
    assert_eq!(fs::read_to_string(&source)?, "\u{feff}# 原始笔记\n你好 😀");
    assert!(matches!(
        files::save_original(
            &db,
            &permission,
            "中文 空格.md",
            "不同请求",
            Some(&confirmation)
        ),
        Err(FileError::TargetChanged)
    ));
    assert!(
        files::save_original(
            &db,
            &permission,
            "中文 空格.md",
            "修改",
            Some(&confirmation)
        )?
        .saved
    );
    assert_eq!(fs::read_to_string(&source)?, "修改");
    assert!(matches!(
        files::save_original(
            &db,
            &permission,
            "中文 空格.md",
            "修改",
            Some(&confirmation)
        ),
        Err(FileError::TargetChanged)
    ));
    let target = dir.path().join("目标.txt");
    fs::write(&target, "其他程序的内容")?;
    let second = files::save_original(&db, &permission, "目标.txt", "新内容", None)?
        .confirmation
        .ok_or("confirmation missing")?;
    fs::write(&target, "确认后又被修改")?;
    assert!(matches!(
        files::save_original(&db, &permission, "目标.txt", "新内容", Some(&second)),
        Err(FileError::TargetChanged)
    ));
    assert_eq!(fs::read_to_string(target)?, "确认后又被修改");
    assert!(files::pending(&db)?[0].content.as_deref() == Some("修改"));
    Ok(())
}

#[test]
fn expired_grants_and_confirmation_cannot_authorize_saves() -> Result<(), Box<dyn Error>> {
    let (dir, db, source) = fixture()?;
    let permission = grant(&db, &source)?;
    let confirmation = files::save_original(&db, &permission, "中文 空格.md", "new", None)?
        .confirmation
        .ok_or("missing confirmation")?;
    let connection = Connection::open(&db)?;
    connection.execute("UPDATE desktop_file_confirmation SET expires_at=0", [])?;
    assert!(matches!(
        files::save_original(&db, &permission, "中文 空格.md", "new", Some(&confirmation)),
        Err(FileError::TargetChanged)
    ));
    connection.execute("UPDATE desktop_file_grant SET expires_at=0", [])?;
    assert!(matches!(
        files::save_original(&db, &permission, "new.md", "new", None),
        Err(FileError::InvalidGrant)
    ));
    assert!(!dir.path().join("new.md").exists());
    Ok(())
}

#[cfg(unix)]
#[test]
fn symlinks_and_replaced_parent_directory_never_redirect_reads_or_writes(
) -> Result<(), Box<dyn Error>> {
    use std::os::unix::fs::symlink;
    let (dir, db, source) = fixture()?;
    let external = tempdir()?;
    let outside = external.path().join("outside.md");
    fs::write(&outside, "private")?;
    let link = dir.path().join("链接.md");
    symlink(&outside, &link)?;
    enqueue(&db, &link, Origin::System)?;
    assert!(files::pending(&db)?[0].error.is_some());
    let permission = grant(&db, &source)?;
    assert!(matches!(
        files::save_original(&db, &permission, "链接.md", "overwrite", None),
        Err(FileError::Symlink)
    ));
    assert_eq!(fs::read_to_string(&outside)?, "private");
    let sub = dir.path().join("原目录");
    fs::create_dir(&sub)?;
    let selected = sub.join("note.md");
    fs::write(&selected, "inside")?;
    let permission = grant(&db, &selected)?;
    let moved = dir.path().join("已移走");
    fs::rename(&sub, &moved)?;
    symlink(external.path(), &sub)?;
    assert!(files::save_original(&db, &permission, "escape.md", "no", None).is_err());
    assert!(!external.path().join("escape.md").exists());
    Ok(())
}

#[test]
fn published_hash_suffix_matches_existing_note_only_inside_selected_publish_root(
) -> Result<(), Box<dyn Error>> {
    let (dir, db, _) = fixture()?;
    let id = "91def280-63bd-421c-933b-a9e65c73538c";
    let digest = format!("{:x}", Sha256::digest(id.as_bytes()));
    let name = format!("笔记-{}.md", &digest[..12]);
    let root = dir.path().join("发布");
    fs::create_dir(&root)?;
    let inside = root.join(&name);
    fs::write(&inside, "published")?;
    let outside = dir.path().join(&name);
    fs::write(&outside, "external")?;
    let connection = Connection::open(&db)?;
    connection.execute(
        "INSERT INTO workspace_field VALUES('desktop','documents',?1)",
        [serde_json::json!([{"id":id}]).to_string()],
    )?;
    let input = [inside, outside].map(|path| path.to_string_lossy().into_owned());
    files::enqueue(&db, &input, None, Origin::System, Some(&root))?;
    let pending = files::pending(&db)?;
    assert_eq!(pending[0].id_prefix, id);
    assert!(pending[1].id_prefix.is_empty());
    Ok(())
}

#[test]
fn queue_bridge_budget_pages_large_files_without_losing_pending_rows() -> Result<(), Box<dyn Error>>
{
    let (dir, db, first) = fixture()?;
    let second = dir.path().join("second.md");
    fs::write(&first, "a".repeat(files::MAX_BYTES))?;
    fs::write(&second, "b".repeat(files::MAX_BYTES))?;
    let input = [first, second].map(|path| path.to_string_lossy().into_owned());
    files::enqueue(&db, &input, None, Origin::Drop, None)?;
    let pending = files::pending(&db)?;
    assert_eq!(pending.len(), 1);
    files::acknowledge(&db, &pending[0].id)?;
    assert_eq!(files::pending(&db)?.len(), 1);
    Ok(())
}

#[test]
fn legacy_published_short_ids_require_an_unambiguous_hexadecimal_suffix(
) -> Result<(), Box<dyn Error>> {
    let (dir, db, _) = fixture()?;
    let root = dir.path().join("published");
    fs::create_dir(&root)?;
    let inside = root.join("原笔记-91def280.md");
    fs::write(&inside, "note")?;
    let bad = root.join("其他-abcdefgh.md");
    fs::write(&bad, "note")?;
    let connection = Connection::open(&db)?;
    connection.execute("INSERT INTO workspace_field VALUES('desktop','documents',?1)",[serde_json::json!([{"id":"91def280-first"},{"id":"91def280-second"},{"id":"abcdefgh-fake"},{"id":""}]).to_string()])?;
    let sources = [inside, bad].map(|path| path.to_string_lossy().into_owned());
    files::enqueue(&db, &sources, None, Origin::System, Some(&root))?;
    assert!(files::pending(&db)?
        .iter()
        .all(|row| row.id_prefix.is_empty()));
    Ok(())
}

#[test]
fn reopening_pending_file_can_wake_main_without_duplicating_even_when_queue_is_full(
) -> Result<(), Box<dyn Error>> {
    let (_dir, db, source) = fixture()?;
    enqueue(&db, &source, Origin::System)?;
    let original = files::pending(&db)?.remove(0);
    let connection = Connection::open(&db)?;
    for index in 1..256 {
        connection.execute("INSERT INTO desktop_file_queue(id,source_key,name,id_prefix,origin,error_text,status) VALUES(?1,?1,'fixture.md','','system','synthetic queue row','pending')",[format!("fixture-{index}")])?;
    }
    let report = files::enqueue(
        &db,
        &[
            "--unsupported-option".into(),
            "picture.png".into(),
            source.to_string_lossy().into_owned(),
        ],
        None,
        Origin::System,
        None,
    )?;
    assert_eq!(report.added, 0);
    assert_eq!(report.deduplicated, 1);
    assert_eq!(report.ignored, 2);
    assert!(report.errors.is_empty());
    assert_eq!(files::pending(&db)?[0].id, original.id);
    let count: i64 = connection.query_row(
        "SELECT count(*) FROM desktop_file_queue WHERE status='pending'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(count, 256);
    let unsupported = files::enqueue(&db, &["picture.png".into()], None, Origin::System, None)?;
    assert_eq!(unsupported.added, 0);
    assert_eq!(unsupported.deduplicated, 0);
    assert_eq!(unsupported.ignored, 1);
    Ok(())
}

#[test]
fn sqlite_failure_after_rename_reports_saved_and_retries_only_the_receipt(
) -> Result<(), Box<dyn Error>> {
    let (_dir, db, source) = fixture()?;
    let permission = grant(&db, &source)?;
    let original_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("source name")?;
    let confirmation =
        files::save_original(&db, &permission, original_name, "完整的新内容 😀", None)?
            .confirmation
            .ok_or("confirmation")?;
    let connection = Connection::open(&db)?;
    connection.execute_batch("CREATE TRIGGER fail_saved_source_identity BEFORE UPDATE OF source_identity ON desktop_file_grant BEGIN SELECT RAISE(ABORT,'isolated receipt write failure'); END;")?;
    let result = files::save_original(
        &db,
        &permission,
        original_name,
        "完整的新内容 😀",
        Some(&confirmation),
    )?;
    assert!(result.saved);
    assert!(result.receipt_pending);
    assert!(result
        .warning
        .as_deref()
        .is_some_and(|text| text.contains("文件已保存")));
    assert_eq!(fs::read_to_string(&source)?, "完整的新内容 😀");
    let state: String =
        connection.query_row("SELECT state FROM desktop_file_save_intent", [], |row| {
            row.get(0)
        })?;
    assert_eq!(state, "prepared");
    let after_publish = fs::metadata(&source)?;
    let modified = after_publish.modified()?;
    #[cfg(unix)]
    let inode = {
        use std::os::unix::fs::MetadataExt;
        after_publish.ino()
    };
    // Remove the injected fault and reopen the service: no in-memory operation state exists.
    connection.execute_batch("DROP TRIGGER fail_saved_source_identity;")?;
    let recovered = files::save_original(&db, &permission, original_name, "完整的新内容 😀", None)?;
    assert!(recovered.saved);
    assert!(!recovered.receipt_pending);
    assert!(recovered.warning.is_none());
    assert_eq!(fs::metadata(&source)?.modified()?, modified);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(fs::metadata(&source)?.ino(), inode);
    }
    assert_eq!(
        files::pending(&db)?[0].content.as_deref(),
        Some("完整的新内容 😀")
    );
    let state: String =
        connection.query_row("SELECT state FROM desktop_file_save_intent", [], |row| {
            row.get(0)
        })?;
    assert_eq!(state, "complete");
    // A second retry returns the completed receipt, rather than overwriting identical bytes.
    assert!(files::save_original(&db, &permission, original_name, "完整的新内容 😀", None)?.saved);
    assert_eq!(fs::metadata(&source)?.modified()?, modified);
    Ok(())
}

#[test]
fn pending_saved_receipt_preserves_external_changes_instead_of_rewriting_them(
) -> Result<(), Box<dyn Error>> {
    let (dir, db, source) = fixture()?;
    let permission = grant(&db, &source)?;
    let connection = Connection::open(&db)?;
    connection.execute_batch("CREATE TRIGGER fail_receipt_commit BEFORE UPDATE OF state ON desktop_file_save_intent WHEN NEW.state='complete' BEGIN SELECT RAISE(ABORT,'isolated final SQL fault'); END;")?;
    let saved = files::save_original(&db, &permission, "已保存.md", "第一版", None)?;
    assert!(saved.saved && saved.receipt_pending);
    let output = dir.path().join("已保存.md");
    assert_eq!(fs::read_to_string(&output)?, "第一版");
    fs::write(&output, "外部程序的新版本")?;
    connection.execute_batch("DROP TRIGGER fail_receipt_commit;")?;
    assert!(matches!(
        files::save_original(&db, &permission, "已保存.md", "第一版", None),
        Err(FileError::TargetChanged)
    ));
    assert_eq!(fs::read_to_string(&output)?, "外部程序的新版本");
    let state: String =
        connection.query_row("SELECT state FROM desktop_file_save_intent", [], |row| {
            row.get(0)
        })?;
    assert_eq!(state, "conflict");
    // A later explicit save can ask for a fresh native confirmation; recovery itself never publishes.
    let ask = files::save_original(&db, &permission, "已保存.md", "第一版", None)?;
    assert!(!ask.saved && ask.confirmation.is_some());
    assert_eq!(fs::read_to_string(&output)?, "外部程序的新版本");
    Ok(())
}

#[test]
fn durable_intent_failure_occurs_before_any_external_file_is_published(
) -> Result<(), Box<dyn Error>> {
    let (dir, db, source) = fixture()?;
    let permission = grant(&db, &source)?;
    let original = fs::read(&source)?;
    let connection = Connection::open(&db)?;
    connection.execute_batch("CREATE TRIGGER fail_intent BEFORE INSERT ON desktop_file_save_intent BEGIN SELECT RAISE(ABORT,'isolated prepare failure'); END;")?;
    assert!(files::save_original(&db, &permission, "未发布.md", "new", None).is_err());
    assert!(!dir.path().join("未发布.md").exists());
    assert_eq!(fs::read(&source)?, original);
    let count: i64 =
        connection.query_row("SELECT count(*) FROM desktop_file_save_intent", [], |row| {
            row.get(0)
        })?;
    assert_eq!(count, 0);
    Ok(())
}

#[test]
fn receipt_failure_does_not_misreport_a_newer_different_request_as_saved(
) -> Result<(), Box<dyn Error>> {
    let (dir, db, source) = fixture()?;
    let permission = grant(&db, &source)?;
    let connection = Connection::open(&db)?;
    connection.execute_batch("CREATE TRIGGER fail_receipt BEFORE UPDATE OF state ON desktop_file_save_intent WHEN NEW.state='complete' BEGIN SELECT RAISE(ABORT,'persistent SQL failure'); END;")?;
    assert!(files::save_original(&db, &permission, "版本.md", "已保存的旧内容", None)?.saved);
    assert!(matches!(
        files::save_original(&db, &permission, "版本.md", "尚未保存的新内容", None),
        Err(FileError::ReceiptPending)
    ));
    assert_eq!(
        fs::read_to_string(dir.path().join("版本.md"))?,
        "已保存的旧内容"
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn active_directory_save_lock_prevents_a_second_instance_from_publishing(
) -> Result<(), Box<dyn Error>> {
    let (dir, db, source) = fixture()?;
    let permission = grant(&db, &source)?;
    let directory = fs::File::open(dir.path())?;
    directory.lock()?;
    assert!(matches!(
        files::save_original(&db, &permission, "并发.md", "new", None),
        Err(FileError::SaveInProgress)
    ));
    assert!(!dir.path().join("并发.md").exists());
    drop(directory);
    assert!(files::save_original(&db, &permission, "并发.md", "new", None)?.saved);
    Ok(())
}

#[test]
fn full_queue_has_one_durable_overflow_notice_and_keeps_deduplicated_reopen_wakeable(
) -> Result<(), Box<dyn Error>> {
    let (dir, db, source) = fixture()?;
    enqueue(&db, &source, Origin::System)?;
    let connection = Connection::open(&db)?;
    for index in 1..256 {
        connection.execute("INSERT INTO desktop_file_queue(id,source_key,name,id_prefix,origin,error_text,status) VALUES(?1,?1,'fixture.md','','system','synthetic queue row','pending')",[format!("overflow-fixture-{index}")])?;
    }
    let excess = dir.path().join("稍后重开.md");
    fs::write(&excess, "not queued")?;
    let inputs = [
        excess.to_string_lossy().into_owned(),
        source.to_string_lossy().into_owned(),
    ];
    let first = files::enqueue(&db, &inputs, None, Origin::System, None)?;
    assert!(first.overflow);
    assert_eq!(first.added, 1);
    assert_eq!(first.deduplicated, 1);
    let notice = files::pending(&db)?.remove(0);
    assert_eq!(notice.name, "文件打开提示");
    assert!(notice
        .error
        .as_deref()
        .is_some_and(|message| message.contains("重新打开")));
    assert!(notice.token.is_none());
    // Reentering the service is a fresh SQLite open, including when no WebView was ready earlier.
    assert_eq!(files::pending(&db)?[0].id, notice.id);
    let again = files::enqueue(&db, &inputs, None, Origin::System, None)?;
    assert!(again.overflow);
    assert_eq!(again.added, 0);
    assert_eq!(again.deduplicated, 1);
    let count: i64 = connection.query_row(
        "SELECT count(*) FROM desktop_file_queue WHERE status='pending'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(count, 257);
    let notices:i64=connection.query_row("SELECT count(*) FROM desktop_file_queue WHERE status='pending' AND grant_token IS NULL AND name='文件打开提示'",[],|row|row.get(0))?;
    assert_eq!(notices, 1);
    files::acknowledge(&db, &notice.id)?;
    assert!(files::pending(&db)?.iter().all(|row| row.id != notice.id));
    let unsupported = files::enqueue(&db, &["ignored.png".into()], None, Origin::System, None)?;
    assert!(!unsupported.overflow);
    assert_eq!(unsupported.added, 0);
    assert_eq!(unsupported.deduplicated, 0);
    assert_eq!(fs::read_to_string(excess)?, "not queued");
    Ok(())
}
