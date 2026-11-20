use std::sync::Arc;

use memokeep_desktop_services::link_preview::{self, Preview};
use serde::{Serialize, Serializer};
use tauri::{Runtime, State, WebviewWindow};
use thiserror::Error;

use crate::Database;

#[derive(Debug, Error)]
pub(crate) enum LinkPreviewError {
    #[error("此窗口无权读取网页预览")]
    Permission,
    #[error("网页预览任务意外停止")]
    Worker,
    #[error(transparent)]
    Preview(#[from] link_preview::PreviewError),
}

impl Serialize for LinkPreviewError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[tauri::command]
pub(crate) async fn read_link_preview<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    url: String,
    refresh: Option<bool>,
) -> Result<Preview, LinkPreviewError> {
    database
        .access(window.label(), "desktop")
        .map_err(|_| LinkPreviewError::Permission)?;
    // The worker holds only a database-path reference until its bounded request ends.
    let path = Arc::clone(&database.path);
    tauri::async_runtime::spawn_blocking(move || {
        link_preview::fetch(&path, &url, refresh.unwrap_or(false))
    })
    .await
    .map_err(|_| LinkPreviewError::Worker)?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn read_link_preview_image<R: Runtime>(
    window: WebviewWindow<R>,
    database: State<'_, Database>,
    url: String,
) -> Result<String, LinkPreviewError> {
    database
        .access(window.label(), "desktop")
        .map_err(|_| LinkPreviewError::Permission)?;
    tauri::async_runtime::spawn_blocking(move || link_preview::fetch_image(&url))
        .await
        .map_err(|_| LinkPreviewError::Worker)?
        .map_err(Into::into)
}
