use std::path::PathBuf;

use tauri::{AppHandle, Builder, Wry};

#[tauri::command]
fn smoke_phase() -> Option<String> {
    std::env::var("MEMOKEEP_SMOKE_PHASE").ok()
}

#[tauri::command]
fn smoke_finish(app: AppHandle, error: Option<String>) {
    match error {
        Some(error) => {
            eprintln!("Tauri smoke failed: {error}");
            app.exit(1);
        }
        None => {
            println!("Tauri smoke passed");
            app.exit(0);
        }
    }
}

pub fn configure(builder: Builder<Wry>) -> Result<Builder<Wry>, std::env::VarError> {
    let dir = PathBuf::from(std::env::var("MEMOKEEP_SMOKE_DATA_DIR")?);
    Ok(builder
        .plugin(tauri_plugin_memokeep_workspace::init_in(
            &["desktop"],
            Some(dir),
        ))
        .invoke_handler(tauri::generate_handler![smoke_phase, smoke_finish]))
}
