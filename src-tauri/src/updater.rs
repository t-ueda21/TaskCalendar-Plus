use rusqlite::Connection;
use serde::Serialize;
use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri_plugin_updater::{Update, UpdaterExt};

pub struct UpdateState {
    update: tokio::sync::Mutex<Option<Update>>,
    conn: Arc<Mutex<Connection>>,
    data_dir: PathBuf,
}

impl UpdateState {
    pub fn new(conn: Arc<Mutex<Connection>>, data_dir: PathBuf) -> Self {
        Self {
            update: tokio::sync::Mutex::new(None),
            conn,
            data_dir,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current_version: String,
    install_supported: bool,
}

#[derive(Serialize)]
pub struct AvailableUpdate {
    version: String,
    notes: String,
}

#[derive(Clone, Serialize)]
pub struct Progress {
    phase: &'static str,
    downloaded: u64,
    total: Option<u64>,
}

#[tauri::command]
pub fn get_update_info(app: tauri::AppHandle) -> UpdateInfo {
    UpdateInfo {
        current_version: app.package_info().version.to_string(),
        install_supported: !cfg!(debug_assertions),
    }
}

#[tauri::command]
pub async fn check_app_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdateState>,
) -> Result<Option<AvailableUpdate>, String> {
    let mut slot = state.update.try_lock().map_err(|_| "更新の処理中です。")?;
    *slot = None;
    let update = app.updater_builder().timeout(Duration::from_secs(30)).build()
        .map_err(|e| format!("更新の準備に失敗しました: {e}"))?
        .check().await.map_err(|_| "更新を確認できませんでした。通信状況と公開リリースを確認して、もう一度お試しください。")?;
    // The check timeout is short; a full installer download may take longer.
    *slot = update.map(|mut u| {
        u.timeout = Some(Duration::from_secs(600));
        u
    });
    Ok(slot.as_ref().map(|u| AvailableUpdate {
        version: u.version.clone(),
        notes: u.body.clone().unwrap_or_default(),
    }))
}

fn save_backup(conn: &Connection, data_dir: &Path) -> Result<PathBuf, String> {
    let dir = data_dir.join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!(
        "before-update-{}-{:016x}.json",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        rand::random::<u64>()
    ));
    let backup = crate::repositories::backup_export(conn).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(&backup).map_err(|e| e.to_string())?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
pub async fn install_app_update(
    state: tauri::State<'_, UpdateState>,
    version: String,
    on_progress: tauri::ipc::Channel<Progress>,
) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("インストール版から更新してください。".into());
    }
    let slot = state.update.try_lock().map_err(|_| "更新の処理中です。")?;
    let update = slot
        .as_ref()
        .filter(|u| u.version == version)
        .ok_or("もう一度、更新を確認してください。")?;
    let mut downloaded = 0;
    let bytes = update.download(|chunk, total| {
        downloaded += chunk as u64;
        let _ = on_progress.send(Progress { phase: "downloading", downloaded, total });
    }, || {}).await.map_err(|_| "更新ファイルのダウンロードまたは署名の検証に失敗しました。もう一度お試しください。")?;
    // Hold the DB lock until the installer is launched, so nothing can be saved
    // between the complete backup and process exit. Never install if backup fails.
    let conn = state
        .conn
        .lock()
        .map_err(|_| "データベースを使用できません。")?;
    save_backup(&conn, &state.data_dir)
        .map_err(|e| format!("バックアップを作成できないため、更新を中止しました: {e}"))?;
    let _ = on_progress.send(Progress {
        phase: "installing",
        downloaded,
        total: Some(downloaded),
    });
    update
        .install(bytes)
        .map_err(|e| format!("更新を開始できませんでした: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backup_is_restorable_and_does_not_overwrite_previous_backups() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open_database(&dir.path().join("tasks.db")).unwrap();
        crate::db::migrate(&conn, "2026-09").unwrap();
        crate::repositories::settings_set(
            &conn,
            &serde_json::json!({"checkUpdatesOnStartup": false}),
        )
        .unwrap();
        let before = crate::repositories::backup_export(&conn).unwrap();
        let first = save_backup(&conn, dir.path()).unwrap();
        let second = save_backup(&conn, dir.path()).unwrap();
        assert_ne!(first, second);
        let backup: serde_json::Value =
            serde_json::from_slice(&std::fs::read(first).unwrap()).unwrap();
        for key in ["tasks", "tags", "settings", "aiMemory"] {
            assert_eq!(before[key], backup[key]);
        }
        crate::repositories::backup_restore(&conn, &backup).unwrap();
        assert_eq!(
            crate::repositories::settings_get(&conn).unwrap().unwrap()["checkUpdatesOnStartup"],
            false
        );
    }
    #[test]
    fn backup_failure_is_an_error_not_permission_to_install() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open_database(&dir.path().join("tasks.db")).unwrap();
        crate::db::migrate(&conn, "2026-09").unwrap();
        std::fs::write(dir.path().join("backups"), "blocked").unwrap();
        assert!(save_backup(&conn, dir.path()).is_err());
    }
}
