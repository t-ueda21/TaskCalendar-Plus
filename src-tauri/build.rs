fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "get_api_token",
                "set_ui_zoom",
                "get_autostart_enabled",
                "set_autostart_enabled",
                "get_update_info",
                "check_app_update",
                "install_app_update",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
