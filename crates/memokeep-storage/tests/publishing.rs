use std::{error::Error, fs, path::Path};

use base64::{engine::general_purpose::STANDARD, Engine};
use memokeep_storage::{
    images, initialize, publishing, read,
    records::{self, CollectionPatch, RecordChange},
    write, write_fields, write_records_on, Fields,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn data() -> Result<Fields, serde_json::Error> {
    serde_json::from_value(json!({
        "knowledgeBases": [
            {"id": "library", "name": "资料"},
            {"id": "child", "name": "../网络", "parentId": "library"}
        ],
        "documents": [
            {"id": "doc-one", "title": "笔记/一", "knowledgeBaseId": "child",
                "content": "# Markdown\n\n保留 **正文**。\n", "sourceType": "manual-markdown"},
            {"id": "doc-two", "title": "纯文本", "knowledgeBaseId": "library",
                "content": "  空格\n\t原样 \n", "sourceType": "manual-text"}
        ],
        "cardDocuments": [{"id": "card-doc", "title": "内容", "content": "卡片正文"}],
        "cardFolders": [{"id": "folder", "name": "题目"}],
        "cardNotebooks": [{"id": "notebook", "folderId": "folder", "sourceDocumentId": "card-doc", "name": "问答"}],
        "settings": {"knowledgeStoragePath": "/untrusted/imported/path"}
    }))
}

fn paths(root: &Path) -> Result<Vec<String>, Box<dyn Error>> {
    let manifest: Value = serde_json::from_slice(&fs::read(root.join(".memokeep-sync.json"))?)?;
    Ok(manifest["files"]
        .as_array()
        .ok_or("missing files")?
        .iter()
        .map(|entry| entry.as_str().ok_or("invalid file").map(str::to_owned))
        .collect::<Result<_, _>>()?)
}

fn note_file(root: &Path, prefix: &str) -> Result<String, Box<dyn Error>> {
    paths(root)?
        .into_iter()
        .find(|file| {
            Path::new(file)
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with(prefix))
        })
        .ok_or_else(|| "exported note not found".into())
}

#[test]
fn publishes_only_explicitly_selected_workspace_and_updates_durable_retry_status(
) -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let db = temp.path().join("workspace.sqlite");
    let root = temp.path().join("published");
    initialize(&db)?;
    let original = data()?;
    write(&db, "desktop", 0, &original)?;
    assert!(publishing::status(&db)?.root.is_none());
    assert!(publishing::publish(&db)?.root.is_none());
    assert_eq!(
        publishing::configure(&db, &root)?.root.as_deref(),
        fs::canonicalize(&root)?.to_str()
    );
    assert!(publishing::status(&db)?.pending);
    let first = publishing::publish(&db)?;
    assert_eq!(first.files_written, 3);
    assert!(first.warnings.is_empty());
    assert!(!publishing::status(&db)?.pending);
    let file = note_file(&root, "笔记-一")?;
    assert!(file.starts_with("知识库/资料/"));
    assert!(!file.contains("../"));
    assert_eq!(
        fs::read_to_string(root.join(file))?,
        "# Markdown\n\n保留 **正文**。\n"
    );
    let plain = note_file(&root, "纯文本")?;
    assert!(plain.ends_with(".txt"));
    assert_eq!(fs::read_to_string(root.join(plain))?, "  空格\n\t原样 \n");
    assert!(paths(&root)?
        .iter()
        .any(|path| path.starts_with("记忆卡片/题目/问答")));
    assert_eq!(publishing::publish(&db)?.files_written, 0);
    let mut next = original;
    next["documents"][0]["content"] = json!("修改后");
    let revision = write(&db, "desktop", 1, &next)?;
    assert!(
        publishing::status(&db)?.pending,
        "A commit followed by process exit must still be discoverable"
    );
    publishing::publish(&db)?;
    assert_eq!(publishing::status(&db)?.published_revision, Some(revision));
    assert_eq!(
        read(&db, "desktop")?.data["settings"]["knowledgeStoragePath"],
        "/untrusted/imported/path"
    );
    Ok(())
}

#[test]
fn preserves_external_edits_and_only_removes_owned_unchanged_exports() -> Result<(), Box<dyn Error>>
{
    let temp = tempfile::tempdir()?;
    let db = temp.path().join("workspace.sqlite");
    let root = temp.path().join("published");
    initialize(&db)?;
    let mut original = data()?;
    write(&db, "desktop", 0, &original)?;
    publishing::configure(&db, &root)?;
    publishing::publish(&db)?;
    let old_path = note_file(&root, "笔记-一")?;
    let edited_path = note_file(&root, "纯文本")?;
    fs::write(root.join(&edited_path), "外部修改，必须保留")?;
    fs::write(root.join("user-file.md"), "用户文件")?;
    original["documents"][0]["title"] = json!("重命名");
    original["documents"][1]["content"] = json!("应用修改");
    write(&db, "desktop", 1, &original)?;
    let report = publishing::publish(&db)?;
    assert!(!root.join(&old_path).exists());
    assert!(note_file(&root, "重命名").is_ok());
    assert_eq!(
        fs::read_to_string(root.join(&edited_path))?,
        "外部修改，必须保留"
    );
    assert_eq!(fs::read_to_string(root.join("user-file.md"))?, "用户文件");
    assert!(!report.warnings.is_empty());
    assert!(publishing::status(&db)?.pending);
    assert!(publishing::status(&db)?.export_error.is_some());
    original["documents"] = json!([]);
    write(&db, "desktop", 2, &original)?;
    publishing::publish(&db)?;
    assert_eq!(
        fs::read_to_string(root.join(&edited_path))?,
        "外部修改，必须保留"
    );
    Ok(())
}

#[test]
fn an_unavailable_directory_records_failure_and_recovers_without_rewriting_the_database(
) -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let db = temp.path().join("workspace.sqlite");
    let root = temp.path().join("published");
    initialize(&db)?;
    let original = data()?;
    write(&db, "desktop", 0, &original)?;
    publishing::configure(&db, &root)?;
    fs::remove_dir(&root)?;
    fs::write(&root, "该路径临时被文件占用")?;
    assert!(publishing::publish(&db).is_err());
    assert!(publishing::status(&db)?.pending);
    assert!(publishing::status(&db)?.export_error.is_some());
    assert_eq!(read(&db, "desktop")?.revision, 1);
    fs::remove_file(&root)?;
    fs::create_dir(&root)?;
    publishing::publish(&db)?;
    assert!(!publishing::status(&db)?.pending);
    assert!(publishing::status(&db)?.export_error.is_none());
    Ok(())
}

#[test]
fn rich_notes_keep_code_spacing_tables_lists_and_safe_inline_formatting(
) -> Result<(), Box<dyn Error>> {
    let html = r#"<h2>标题 &amp; 说明</h2><p><strong>加粗</strong>与<em>斜体</em>、<u>下划线</u>、<s>删除</s>。</p>
        <div class="ql-code-block-container"><div data-language="rust">  fn main() {</div><div data-language="rust"></div><div data-language="rust">  }</div></div>
        <ol><li data-list="checked"><span class="ql-ui">忽略控件</span>已做</li><li data-list="unchecked">待做</li></ol>
        <table><tr><td>列一</td><td>列二</td></tr><tr><td>A|B</td><td>换<br>行</td></tr></table>
        <script>不能导出脚本</script><p><a href="https://example.com">链接</a><a href="javascript:alert(1)">危险链接</a></p>"#;
    let markdown = publishing::rich_markdown(html)?;
    let quill_list = publishing::rich_markdown("<ol><li data-list=\"ordered\">第一项</li><li data-list=\"bullet\" class=\"ql-indent-1\">子项</li><li data-list=\"ordered\">第二项</li></ol>")?;
    assert!(quill_list.contains("1. 第一项\n    - 子项\n2. 第二项"));
    assert_eq!(
        publishing::rich_markdown("<pre data-language=\"js\">  let x = 1;\n```</pre>")?,
        "````js\n  let x = 1;\n```\n````\n"
    );

    assert!(markdown.contains("## 标题 & 说明"));
    assert!(markdown.contains("**加粗**与*斜体*、<u>下划线</u>、~~删除~~。"));
    assert!(markdown.contains("```rust\n  fn main() {\n\n  }\n```"));
    assert!(markdown.contains("- [x] 已做\n- [ ] 待做"));
    assert!(markdown.contains("| 列一 | 列二 |\n| --- | --- |\n| A\\|B | 换  <br>行 |"));
    assert!(markdown.contains("[链接](https://example.com)"));
    assert!(
        !markdown.contains("javascript:")
            && !markdown.contains("不能导出脚本")
            && !markdown.contains("忽略控件")
    );
    Ok(())
}

#[test]
fn images_are_exported_from_sqlite_and_missing_bytes_remain_recoverable(
) -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let db = temp.path().join("workspace.sqlite");
    let root = temp.path().join("published");
    initialize(&db)?;
    let png = b"\x89PNG\r\n\x1a\nsynthetic";
    let image = serde_json::to_value(images::save(&db, &STANDARD.encode(png), "demo.png")?)?;
    let id = image["id"].as_str().ok_or("missing ID")?;
    let absent = "17834afd-89c7-4ec6-8788-5ed78981cd23";
    let mut original = data()?;
    original["documents"][0]["metadata"] = json!({"editorMode":"note","noteContentInitialized":true,
        "noteContent":format!("<p><img src=\"memokeep-image://{id}\" alt=\"示意\"></p><p><img src=\"memokeep-image://{absent}\" alt=\"缺图\"></p>")});
    write(&db, "desktop", 0, &original)?;
    publishing::configure(&db, &root)?;
    let first = publishing::publish(&db)?;
    assert_eq!(first.warnings.len(), 1);
    assert_eq!(fs::read(root.join(format!("images/{id}.png")))?, png);
    let file = fs::read_to_string(root.join(note_file(&root, "笔记-一")?))?;
    assert!(file.contains(&format!("../../../images/{id}.png")));
    assert!(file.contains(&format!("memokeep-image://{absent}")));
    Connection::open(&db)?.execute(
        "INSERT INTO note_image VALUES(?1,?2)",
        params![absent, png.as_slice()],
    )?;
    let fixed = publishing::publish(&db)?;
    assert!(fixed.warnings.is_empty());
    assert!(!publishing::status(&db)?.pending);
    Ok(())
}

#[test]
fn invalid_or_foreign_manifests_and_concurrent_publishers_preserve_existing_files(
) -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let db = temp.path().join("workspace.sqlite");
    let other_db = temp.path().join("other.sqlite");
    let root = temp.path().join("published");
    initialize(&db)?;
    initialize(&other_db)?;
    write(&db, "desktop", 0, &data()?)?;
    publishing::configure(&db, &root)?;
    publishing::publish(&db)?;
    let original = fs::read(root.join(".memokeep-sync.json"))?;
    publishing::configure(&other_db, &root)?;
    assert!(matches!(
        publishing::publish(&other_db),
        Err(publishing::PublishingError::ForeignManifest)
    ));
    assert_eq!(fs::read(root.join(".memokeep-sync.json"))?, original);
    let mut manifest: Value = serde_json::from_slice(&original)?;
    manifest["entries"]["../do-not-touch.md"] = json!("hash");
    fs::write(
        root.join(".memokeep-sync.json"),
        serde_json::to_vec(&manifest)?,
    )?;
    let protected = temp.path().join("do-not-touch.md");
    fs::write(&protected, "保留")?;
    assert!(matches!(
        publishing::publish(&db),
        Err(publishing::PublishingError::UnsafePath)
    ));
    assert_eq!(fs::read_to_string(protected)?, "保留");
    fs::write(root.join(".memokeep-sync.json"), original)?;
    let guard = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(db.with_extension("markdown.lock"))?;
    guard.try_lock()?;
    assert!(matches!(
        publishing::publish(&db),
        Err(publishing::PublishingError::Busy)
    ));
    Ok(())
}

#[cfg(unix)]
#[test]
fn symlinked_output_paths_are_rejected_without_touching_the_target() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let db = temp.path().join("workspace.sqlite");
    let root = temp.path().join("published");
    let outside = temp.path().join("outside");
    initialize(&db)?;
    write(&db, "desktop", 0, &data()?)?;
    publishing::configure(&db, &root)?;
    fs::create_dir(&outside)?;
    std::os::unix::fs::symlink(&outside, root.join("知识库"))?;
    assert!(matches!(
        publishing::publish(&db),
        Err(publishing::PublishingError::UnsafePath)
    ));
    assert!(fs::read_dir(&outside)?.next().is_none());
    assert!(
        publishing::configure(&db, temp.path()).is_err(),
        "The publisher cannot own the database directory"
    );
    Ok(())
}

#[test]
fn a_crashed_publish_lease_is_reclaimed_and_reselecting_the_same_folder_keeps_ownership(
) -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let db = temp.path().join("workspace.sqlite");
    let root = temp.path().join("published");
    initialize(&db)?;
    write(&db, "desktop", 0, &data()?)?;
    publishing::configure(&db, &root)?;
    publishing::publish(&db)?;
    let first = fs::read(root.join(".memokeep-sync.json"))?;
    publishing::configure(&db, &root)?;
    publishing::publish(&db)?;
    assert_eq!(fs::read(root.join(".memokeep-sync.json"))?, first);
    Connection::open(&db)?.execute("UPDATE markdown_publishing SET pending=1,lease='crashed-process',lease_started=strftime('%s','now') WHERE slot=1", [])?;
    assert!(publishing::publish(&db)?.warnings.is_empty());
    assert!(!publishing::status(&db)?.pending);
    Ok(())
}

fn simulate_replaced_file_before_manifest_commit(
    db: &Path,
    root: &Path,
    old_manifest: &[u8],
    relative: &str,
) -> Result<(), Box<dyn Error>> {
    let digest = format!("{:x}", Sha256::digest(fs::read(root.join(relative))?));
    let db = Connection::open(db)?;
    db.execute("INSERT INTO markdown_publish_intent(root,owner,path,digest) SELECT root,owner,?1,?2 FROM markdown_publishing WHERE slot=1", params![relative,digest])?;
    db.execute(
        "UPDATE markdown_publishing SET pending=1,lease='interrupted-publisher' WHERE slot=1",
        [],
    )?;
    fs::write(root.join(".memokeep-sync.json"), old_manifest)?;
    Ok(())
}

#[test]
fn interrupted_file_replacement_is_owned_until_manifest_recovery_even_after_another_edit(
) -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let db = temp.path().join("workspace.sqlite");
    let root = temp.path().join("published");
    initialize(&db)?;
    let mut data = data()?;
    write(&db, "desktop", 0, &data)?;
    publishing::configure(&db, &root)?;
    publishing::publish(&db)?;
    let original = fs::read(root.join(".memokeep-sync.json"))?;
    let relative = note_file(&root, "笔记-一")?;
    data["documents"][0]["content"] = json!("第二版");
    write(&db, "desktop", 1, &data)?;
    publishing::publish(&db)?;
    simulate_replaced_file_before_manifest_commit(&db, &root, &original, &relative)?;
    data["documents"][0]["content"] = json!("第三版");
    write(&db, "desktop", 2, &data)?;
    let report = publishing::publish(&db)?;
    assert!(report.warnings.is_empty());
    assert_eq!(fs::read_to_string(root.join(relative))?, "第三版");
    assert!(!publishing::status(&db)?.pending);
    assert_eq!(
        Connection::open(&db)?.query_row(
            "SELECT count(*) FROM markdown_publish_intent",
            [],
            |row| row.get::<_, i64>(0)
        )?,
        0
    );
    Ok(())
}

#[test]
fn interrupted_publication_does_not_authorize_overwriting_later_external_changes(
) -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let db = temp.path().join("workspace.sqlite");
    let root = temp.path().join("published");
    initialize(&db)?;
    let mut data = data()?;
    write(&db, "desktop", 0, &data)?;
    publishing::configure(&db, &root)?;
    publishing::publish(&db)?;
    let original = fs::read(root.join(".memokeep-sync.json"))?;
    let relative = note_file(&root, "笔记-一")?;
    data["documents"][0]["content"] = json!("第二版");
    write(&db, "desktop", 1, &data)?;
    publishing::publish(&db)?;
    simulate_replaced_file_before_manifest_commit(&db, &root, &original, &relative)?;
    fs::write(root.join(&relative), "此后由外部编辑器修改")?;
    data["documents"][0]["content"] = json!("第三版");
    write(&db, "desktop", 2, &data)?;
    assert!(!publishing::publish(&db)?.warnings.is_empty());
    assert_eq!(
        fs::read_to_string(root.join(relative))?,
        "此后由外部编辑器修改"
    );
    assert!(publishing::status(&db)?.pending);
    Ok(())
}

#[test]
fn record_edits_publish_only_changed_notes_and_structural_changes_force_full_projection(
) -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let db = temp.path().join("workspace.sqlite");
    let root = temp.path().join("published");
    initialize(&db)?;
    let mut data = data()?;
    let documents = data["documents"]
        .as_array_mut()
        .ok_or("missing documents")?;
    for i in 2..1_000 {
        documents.push(json!({"id":format!("note-{i}"),"title":format!("合成笔记{i}"),"knowledgeBaseId":"library","content":"合成正文"}));
    }
    write(&db, "desktop", 0, &data)?;
    records::activate(&db, "desktop", 1)?;
    publishing::configure(&db, &root)?;
    assert_eq!(publishing::publish(&db)?.notes_rendered, 1_001);
    let path = note_file(&root, "笔记-一")?;
    // A changed record needs independent ownership while the original test dataset is reused.
    let mut changed = data["documents"][0].clone();
    changed["content"] = json!("只修改这一篇");
    let mut conn = Connection::open(&db)?;
    let transaction = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    write_records_on(
        &transaction,
        "desktop",
        1,
        &[CollectionPatch {
            field: "documents".into(),
            changes: vec![RecordChange {
                id: "doc-one".into(),
                value: Some(changed),
            }],
        }],
        &Fields::new(),
        &[],
    )?;
    transaction.commit()?;
    assert!(publishing::status(&db)?.pending);
    assert!(
        !fs::read_to_string(root.join(&path))?.contains("只修改这一篇"),
        "a save commits only the durable publishing queue"
    );
    let published = publishing::publish(&db)?;
    assert_eq!(published.notes_rendered, 1);
    assert_eq!(published.files_written, 1);
    assert_eq!(fs::read_to_string(root.join(&path))?, "只修改这一篇");
    assert!(!publishing::status(&db)?.pending);
    write_fields(
        &db,
        "desktop",
        2,
        &serde_json::from_value(json!({"memos":[{"id":"unrelated"}]}))?,
        &[],
    )?;
    assert!(
        !publishing::status(&db)?.pending,
        "unrelated commits do not trigger Markdown renders"
    );
    let transaction = conn.transaction()?;
    write_records_on(
        &transaction,
        "desktop",
        3,
        &[CollectionPatch {
            field: "documents".into(),
            changes: vec![RecordChange {
                id: "doc-one".into(),
                value: None,
            }],
        }],
        &Fields::new(),
        &[],
    )?;
    transaction.commit()?;
    assert_eq!(publishing::publish(&db)?.notes_rendered, 0);
    assert!(!root.join(path).exists());
    data["knowledgeBases"][0]["name"] = json!("移动后的目录");
    let mut fields = Fields::new();
    fields.insert("knowledgeBases".into(), data["knowledgeBases"].take());
    write_fields(&db, "desktop", 4, &fields, &[])?;
    assert_eq!(publishing::publish(&db)?.notes_rendered, 1_000);
    assert!(paths(&root)?
        .iter()
        .any(|path| path.starts_with("知识库/移动后的目录/")));
    Ok(())
}

#[test]
fn publishing_work_rolls_back_with_its_workspace_transaction() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let db = temp.path().join("workspace.sqlite");
    initialize(&db)?;
    write(&db, "desktop", 0, &data()?)?;
    records::activate(&db, "desktop", 1)?;
    publishing::configure(&db, &temp.path().join("published"))?;
    publishing::publish(&db)?;
    let mut conn = Connection::open(&db)?;
    let transaction = conn.transaction()?;
    write_records_on(
        &transaction,
        "desktop",
        1,
        &[CollectionPatch {
            field: "documents".into(),
            changes: vec![RecordChange {
                id: "doc-one".into(),
                value: None,
            }],
        }],
        &Fields::new(),
        &[],
    )?;
    transaction.rollback()?;
    assert_eq!(read(&db, "desktop")?.revision, 1);
    assert!(!publishing::status(&db)?.pending);
    Ok(())
}

#[test]
fn incremental_source_updates_refresh_linked_notebooks_and_preserve_shared_images(
) -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let db = temp.path().join("workspace.sqlite");
    let root = temp.path().join("published");
    initialize(&db)?;
    let png = b"\x89PNG\r\n\x1a\nsynthetic-shared-image";
    let image = serde_json::to_value(images::save(&db, &STANDARD.encode(png), "shared.png")?)?;
    let image = image["id"].as_str().ok_or("missing image ID")?;
    let mut data = data()?;
    data["cardNotebooks"][0]["sourceDocumentId"] = json!("doc-one");
    for document in data["documents"]
        .as_array_mut()
        .ok_or("missing documents")?
    {
        document["sourceType"] = json!("manual-note");
        document["metadata"] = json!({"editorMode":"note","noteContentInitialized":true,"noteContent":format!("<p><img src=\"memokeep-image://{image}\"></p>")});
    }
    write(&db, "desktop", 0, &data)?;
    records::activate(&db, "desktop", 1)?;
    publishing::configure(&db, &root)?;
    assert_eq!(publishing::publish(&db)?.notes_rendered, 3);
    let old_note = note_file(&root, "笔记-一")?;
    let notebook = note_file(&root, "问答")?;
    let mut changed = data["documents"][0].take();
    changed["title"] = json!("重命名后的来源");
    changed["metadata"]["noteContent"] = json!(format!(
        "<p>新正文</p><p><img src=\"memokeep-image://{image}\"></p>"
    ));
    let mut conn = Connection::open(&db)?;
    let transaction = conn.transaction()?;
    write_records_on(
        &transaction,
        "desktop",
        1,
        &[CollectionPatch {
            field: "documents".into(),
            changes: vec![RecordChange {
                id: "doc-one".into(),
                value: Some(changed),
            }],
        }],
        &Fields::new(),
        &[],
    )?;
    transaction.commit()?;
    assert_eq!(publishing::publish(&db)?.notes_rendered, 2);
    assert!(!root.join(old_note).exists());
    assert!(fs::read_to_string(root.join(&notebook))?.contains("新正文"));
    let transaction = conn.transaction()?;
    write_records_on(
        &transaction,
        "desktop",
        2,
        &[CollectionPatch {
            field: "documents".into(),
            changes: vec![RecordChange {
                id: "doc-one".into(),
                value: None,
            }],
        }],
        &Fields::new(),
        &[],
    )?;
    transaction.commit()?;
    assert_eq!(publishing::publish(&db)?.notes_rendered, 0);
    assert!(!root.join(notebook).exists());
    assert_eq!(fs::read(root.join(format!("images/{image}.png")))?, png);
    assert!(note_file(&root, "纯文本").is_ok());
    Ok(())
}

#[test]
fn unconfigured_status_is_read_only_even_while_another_writer_holds_its_reservation(
) -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let database = temp.path().join("workspace.sqlite");
    initialize(&database)?;
    let mut writer = Connection::open(&database)?;
    let schema_version: i64 = writer.query_row("PRAGMA schema_version", [], |row| row.get(0))?;
    let transaction = writer.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    for _ in 0..2 {
        let status = publishing::status(&database)?;
        assert!(status.root.is_none());
        assert!(!status.pending);
    }
    assert_eq!(
        transaction.query_row("PRAGMA schema_version", [], |row| row.get::<_, i64>(0))?,
        schema_version
    );
    assert_eq!(
        transaction.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name LIKE 'markdown_%'",
            [],
            |row| row.get::<_, i64>(0)
        )?,
        0
    );
    transaction.commit()?;
    writer.execute_batch("CREATE TABLE markdown_publishing(slot INTEGER PRIMARY KEY,root TEXT NOT NULL,owner TEXT NOT NULL,pending INTEGER NOT NULL DEFAULT 1,export_error TEXT,published_revision INTEGER,lease TEXT,lease_started INTEGER)")?;
    assert!(
        publishing::status(&database)?.root.is_none(),
        "an empty legacy configuration table does not authorize or install publication"
    );
    assert_eq!(writer.query_row("SELECT count(*) FROM sqlite_master WHERE name IN ('markdown_publish_queue','markdown_publish_intent')", [], |row| row.get::<_, i64>(0))?, 0);
    Ok(())
}

#[test]
fn configured_status_installs_legacy_queue_once_then_remains_a_read_only_poll(
) -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let database = temp.path().join("workspace.sqlite");
    initialize(&database)?;
    write(&database, "desktop", 0, &data()?)?;
    publishing::configure(&database, &temp.path().join("published"))?;
    publishing::publish(&database)?;
    let mut writer = Connection::open(&database)?;
    writer.execute_batch("DROP TABLE markdown_publish_queue; DROP TABLE markdown_publish_intent; UPDATE markdown_publishing SET pending=1")?;
    assert!(publishing::status(&database)?.pending);
    assert_eq!(writer.query_row("SELECT count(*) FROM sqlite_master WHERE name IN ('markdown_publish_queue','markdown_publish_intent')", [], |row| row.get::<_, i64>(0))?, 2);
    publishing::publish(&database)?;
    let schema_version: i64 = writer.query_row("PRAGMA schema_version", [], |row| row.get(0))?;
    let transaction = writer.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    for _ in 0..2 {
        let status = publishing::status(&database)?;
        assert!(status.root.is_some());
        assert!(!status.pending);
        assert_eq!(status.published_revision, Some(1));
    }
    assert_eq!(
        transaction.query_row("PRAGMA schema_version", [], |row| row.get::<_, i64>(0))?,
        schema_version
    );
    assert_eq!(
        transaction.query_row("SELECT count(*) FROM markdown_publish_queue", [], |row| row
            .get::<_, i64>(0))?,
        0
    );
    Ok(())
}
