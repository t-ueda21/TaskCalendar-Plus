// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod ai_cli;
mod ai_models;
mod api;
mod calendar;
mod db;
mod mcp;
mod outlook;
mod repositories;
mod ui_preferences;
mod updater;

use std::sync::{Arc, Mutex};
use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

// AIは Claude Code / Codex だけを使う(設定画面の aiCliEnabled / aiProvider で選ぶ)。実行ファイルは
// PATHから探すが、環境変数 TCPLUS_CLAUDE_PATH / TCPLUS_CODEX_PATH で指定もできる。

/// 組み込みHTTP APIの合言葉(起動ごとに生成)。画面へはこのコマンドでだけ渡す。
struct ApiToken(String);

#[tauri::command]
fn get_api_token(token: tauri::State<'_, ApiToken>) -> String {
    token.0.clone()
}

// UI preference storage lives beside tasks.db, outside the localhost origin.
#[tauri::command]
fn get_ui_preferences(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ui_preferences::UiPreferencesState>,
) -> Result<Option<ui_preferences::UiPreferences>, String> {
    let preferences = state.get()?;
    if let Some(ref preferences) = preferences {
        window
            .set_zoom(preferences.zoom)
            .map_err(|e| e.to_string())?;
    }
    Ok(preferences)
}

#[tauri::command]
fn set_ui_theme(
    state: tauri::State<'_, ui_preferences::UiPreferencesState>,
    theme: String,
) -> Result<(), String> {
    state.set_theme(theme)
}

#[tauri::command]
fn set_ui_zoom(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ui_preferences::UiPreferencesState>,
    level: f64,
) -> Result<(), String> {
    state.set_zoom(level)?;
    window.set_zoom(level).map_err(|e| e.to_string())
}

// PCログイン時の自動起動を設定画面から切り替えられるようにする。
// 起動時にOSの登録状態は変更しない。ユーザーのON/OFF操作だけを反映する。
#[tauri::command]
fn get_autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|e| e.to_string())
}

// 「✕」ボタンでタスクトレイへ格納する機能。設定はDB(settingsテーブル)の
// trayEnabled/startMinimizedToTrayに保存される(store.js DEFAULT_SETTINGS参照)。
// 実行中の設定変更でもアイコン表示を同期する。
//
// トレイアイコンの左クリックは常にウィンドウを表示+最前面化する
// (非表示中はshow、表示中でも他ウィンドウの裏に隠れていれば前面に出す)。
// メニュー(リロード/再起動/閉じる)は右クリックのみで開く
// (show_menu_on_left_clickは常にfalse固定、右クリックでのメニュー表示は
// tauriのトレイアイコン標準動作に任せる)。
const TRAY_ICON_ID: &str = "main-tray";
const TRAY_MENU_RELOAD: &str = "reload";
const TRAY_MENU_RESTART: &str = "restart";
const TRAY_MENU_QUIT: &str = "quit";

/// 設定(settingsテーブル)の真偽値。未設定なら default。
fn bool_setting(conn: &rusqlite::Connection, key: &str, default: bool) -> bool {
    repositories::settings_get(conn)
        .ok()
        .flatten()
        .and_then(|v| v.get(key).and_then(|b| b.as_bool()))
        .unwrap_or(default)
}

fn ensure_tray(app: &tauri::AppHandle, static_root: &std::path::Path) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id(TRAY_ICON_ID) {
        return tray.set_visible(true).map_err(|e| e.to_string());
    }
    let icon_path = api::list_app_icon_candidates(static_root)
        .into_iter()
        .find(|p| p.extension().and_then(|e| e.to_str()) != Some("svg"))
        .ok_or("tray icon is unavailable")?;
    let icon = tauri::image::Image::from_path(&icon_path).map_err(|e| e.to_string())?;
    let menu = MenuBuilder::new(app)
        .text(TRAY_MENU_RELOAD, "リロード")
        .text(TRAY_MENU_RESTART, "再起動")
        .text(TRAY_MENU_QUIT, "閉じる")
        .build()
        .map_err(|e| e.to_string())?;
    TrayIconBuilder::with_id(TRAY_ICON_ID)
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_MENU_RELOAD => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.reload();
                }
            }
            TRAY_MENU_RESTART => app.restart(),
            TRAY_MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
                && let Some(window) = tray.app_handle().get_webview_window("main")
            {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_tray_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        let root = app.state::<StaticRoot>();
        ensure_tray(&app, &root.0)
    } else if let Some(tray) = app.tray_by_id(TRAY_ICON_ID) {
        tray.set_visible(false).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

struct StaticRoot(std::path::PathBuf);

// Outlook自動同期ループ。設定のoutlookAutoSync/outlookAutoSyncIntervalMinを
// ポーリングし、有効時のみ指定間隔でPOST /api/outlook/auto-syncを呼ぶ。
async fn outlook_auto_sync_loop(base_url: String, api_token: String) {
    let client = reqwest::Client::new();
    loop {
        let settings: Option<serde_json::Value> = match client
            .get(format!("{base_url}/api/settings"))
            .header(api::API_TOKEN_HEADER, &api_token)
            .send()
            .await
        {
            Ok(res) => res.json().await.ok(),
            Err(_) => None,
        };

        let Some(settings) = settings else {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            continue;
        };

        let auto_sync_enabled = settings
            .get("outlookAutoSync")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !auto_sync_enabled {
            // 無効時は1分後に再チェックする。
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            continue;
        }

        let interval_min = settings
            .get("outlookAutoSyncIntervalMin")
            .and_then(|v| v.as_f64())
            .map(|n| n.max(1.0) as u64)
            .unwrap_or(10);

        match client
            .post(format!("{base_url}/api/outlook/auto-sync"))
            .header(api::API_TOKEN_HEADER, &api_token)
            .header("Content-Type", "application/json")
            .body("{}")
            .send()
            .await
        {
            Ok(res) => {
                if let Ok(result) = res.json::<serde_json::Value>().await {
                    let added = result.get("added").and_then(|v| v.as_i64()).unwrap_or(0);
                    let deleted = result.get("deleted").and_then(|v| v.as_i64()).unwrap_or(0);
                    if added > 0 || deleted > 0 {
                        println!("[Outlook] auto-sync: +{added} added, -{deleted} deleted");
                    }
                }
                tokio::time::sleep(std::time::Duration::from_secs(interval_min * 60)).await;
            }
            Err(e) => {
                eprintln!("[Outlook] auto-sync error: {e}");
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            }
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            get_api_token,
            get_ui_preferences,
            set_ui_theme,
            set_ui_zoom,
            set_tray_enabled,
            get_autostart_enabled,
            set_autostart_enabled,
            updater::get_update_info,
            updater::check_app_update,
            updater::install_app_update
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();

            // 環境変数 TCPLUS_DATA_DIR があればそこに保存する(E2Eテストで普段のデータを汚さないため)。
            let data_dir = match std::env::var_os("TCPLUS_DATA_DIR") {
                Some(dir) => std::path::PathBuf::from(dir),
                None => app_handle
                    .path()
                    .app_data_dir()
                    .expect("resolve app data dir"),
            };
            std::fs::create_dir_all(&data_dir).expect("create app data dir");
            let ui_preferences = ui_preferences::UiPreferencesState::load(&data_dir)
                .unwrap_or_else(|error| {
                    eprintln!("[ui-preferences] {error}");
                    ui_preferences::UiPreferencesState::empty(&data_dir)
                });
            app.manage(ui_preferences);
            let db_path = data_dir.join("tasks.db");

            let conn = db::open_database(&db_path).expect("open database");
            let current_month = chrono::Local::now().format("%Y-%m").to_string();
            db::migrate(&conn, &current_month).expect("migrate database");

            // 画面資材(renderer/)の静的配信root。
            //
            // devビルドではソースツリーを直接見に行き(ホットリロード的に
            // 使える)、リリースビルドではbundle.resourcesとして同梱したコピーを
            // resource_dir()経由で見に行く。CARGO_MANIFEST_DIRはビルド時に開発機の
            // 絶対パスとして焼き込まれるため、リリースビルドで使うと他PCでは
            // 存在しないパスを指してしまい、静的ファイル配信が全滅する。
            #[cfg(debug_assertions)]
            let static_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("renderer");
            #[cfg(not(debug_assertions))]
            let static_root = app_handle
                .path()
                .resource_dir()
                .expect("resolve resource dir")
                .join("renderer");

            // renderer/assets/app-icon/配下のファイルをウィンドウ・タスクバー・
            // タスクトレイアイコンにする。tauri::imageはsvgをデコードできない
            // ため、svg以外の最初の候補を使う(拡張子.ico優先、以降はファイル名昇順)。
            let icon_path = api::list_app_icon_candidates(&static_root)
                .into_iter()
                .find(|p| p.extension().and_then(|e| e.to_str()) != Some("svg"));

            if let Some(ref icon_path) = icon_path
                && let Ok(icon) = tauri::image::Image::from_path(icon_path)
                && let Some(window) = app_handle.get_webview_window("main")
            {
                let _ = window.set_icon(icon);
            }

            let conn = Arc::new(Mutex::new(conn));
            app.manage(updater::UpdateState::new(
                Arc::clone(&conn),
                data_dir.clone(),
            ));
            app.manage(StaticRoot(static_root.clone()));

            // 起動時に有効な場合だけ作る。後から有効にした場合はコマンドか
            // 閉じる直前に作成し、作成に失敗したらウィンドウを隠さない。
            let tray_is_enabled = {
                let c = conn.lock().expect("db mutex poisoned");
                bool_setting(&c, "trayEnabled", true)
            };
            // trayEnabled且つstartMinimizedToTrayなら、起動時は
            // タスクトレイのみに常駐した状態で立ち上げる。
            let start_minimized = {
                let c = conn.lock().expect("db mutex poisoned");
                tray_is_enabled && bool_setting(&c, "startMinimizedToTray", false)
            };

            let tray_ready = tray_is_enabled && ensure_tray(&app_handle, &static_root).is_ok();

            if let Some(window) = app_handle.get_webview_window("main") {
                if start_minimized && tray_ready {
                    let _ = window.hide();
                }

                // 「✕」ボタン押下時、その時点のtrayEnabled設定を見て
                // トレイへ格納(hide)するか、既定どおり終了するかを分岐する。
                let conn_for_close = Arc::clone(&conn);
                let window_for_close = window.clone();
                let app_for_close = app_handle.clone();
                let root_for_close = static_root.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let enabled = {
                            let c = conn_for_close.lock().expect("db mutex poisoned");
                            bool_setting(&c, "trayEnabled", true)
                        };
                        if enabled && ensure_tray(&app_for_close, &root_for_close).is_ok() {
                            api.prevent_close();
                            let _ = window_for_close.hide();
                        }
                    }
                });
            }

            let api_token = format!("{:032x}", rand::random::<u128>());
            app.manage(ApiToken(api_token.clone()));

            let state = api::AppState {
                conn,
                static_root,
                proposals: Default::default(),
                claude_command: std::env::var_os("TCPLUS_CLAUDE_PATH")
                    .map(std::path::PathBuf::from),
                codex_command: std::env::var_os("TCPLUS_CODEX_PATH").map(std::path::PathBuf::from),
                api_token: api_token.clone(),
            };
            let router = api::build_router(state);

            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                    .await
                    .expect("bind HTTP server to 127.0.0.1");
                let port = listener.local_addr().expect("read local addr").port();

                if let Some(window) = app_handle.get_webview_window("main") {
                    let url = format!("http://127.0.0.1:{port}/")
                        .parse()
                        .expect("build window url");
                    window
                        .navigate(url)
                        .expect("navigate main window to http server");
                }

                // Outlook自動同期ループを起動する。
                tauri::async_runtime::spawn(outlook_auto_sync_loop(
                    format!("http://127.0.0.1:{port}"),
                    api_token,
                ));

                axum::serve(listener, router)
                    .await
                    .expect("http server crashed");
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
