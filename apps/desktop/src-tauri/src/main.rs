fn main() -> Result<(), Box<dyn std::error::Error>> {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder
        .plugin(tauri_plugin_memokeep_workspace::desktop_dialog())
        .manage(tauri_plugin_memokeep_workspace::DesktopSpeech::new(
            "memokeep-speech-basic",
            false,
        ));
    #[cfg(not(feature = "smoke-test"))]
    let builder = builder.plugin(tauri_plugin_memokeep_workspace::init(&["desktop"]));
    #[cfg(feature = "smoke-test")]
    let builder = smoke::configure(builder)?;
    builder.run(tauri::generate_context!())?;
    Ok(())
}

#[cfg(feature = "smoke-test")]
mod smoke;
