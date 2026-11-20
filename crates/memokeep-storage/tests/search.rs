use std::error::Error;

use memokeep_storage::{initialize, search, write, Fields, StorageError};
use serde_json::json;

fn note(id: &str, title: &str, text: &str) -> search::Entry {
    search::Entry {
        kind: "note".into(),
        id: id.into(),
        title: title.into(),
        text: text.into(),
        normalized_title: title.to_lowercase(),
        normalized_body: format!("{title} {text}").to_lowercase(),
        label: "笔记".into(),
        path: String::new(),
        excerpt: None,
    }
}

#[test]
fn index_is_revision_checked_and_updates_chinese_matches() -> Result<(), Box<dyn Error>> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("store.sqlite");
    initialize(&path)?;
    let one = Fields::from_iter([("documents".into(), json!([{"id":"a"},{"id":"b"}]))]);
    let revision = write(&path, "desktop", 0, &one)?;
    assert!(search::query(&path, &["事务".into()])?.is_none());
    search::update(
        &path,
        revision,
        &[
            note("a", "事务", "数据库事务隔离"),
            note("b", "数据库", "事务日记"),
        ],
    )?;
    let exact = search::query(&path, &["事务".into()])?.ok_or("index missing")?;
    assert_eq!(
        exact.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
        ["a", "b"]
    );
    assert_eq!(
        search::query(&path, &["事务隔离".into()])?
            .ok_or("index missing")?
            .len(),
        1
    );

    let two = Fields::from_iter([("documents".into(), json!([{"id":"b","modified":true}]))]);
    let next = write(&path, "desktop", revision, &two)?;
    assert!(matches!(
        search::update(&path, revision, &[]),
        Err(StorageError::StaleRevision)
    ));
    search::update(&path, next, &[note("b", "数据库", "事务恢复")])?;
    assert!(search::query(&path, &["事务隔离".into()])?
        .ok_or("index missing")?
        .is_empty());
    assert_eq!(
        search::query(&path, &["事务恢复".into(), "数据库".into()])?
            .ok_or("index missing")?
            .len(),
        1
    );
    Ok(())
}
