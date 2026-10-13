//! Serialize startup until the single-instance plugin has registered its IPC window.
//! This closes the plugin's Windows mutex/hidden-window creation race.
pub struct StartupGuard(isize);

#[cfg(windows)]
pub fn startup_guard(identifier: &str) -> Result<StartupGuard, String> {
    use windows::{
        Win32::{
            Foundation::{CloseHandle, WAIT_ABANDONED, WAIT_OBJECT_0},
            System::Threading::{CreateMutexW, WaitForSingleObject},
        },
        core::PCWSTR,
    };
    let name: Vec<u16> = format!("Local\\{identifier}-startup\0")
        .encode_utf16()
        .collect();
    let handle =
        unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }.map_err(|e| e.to_string())?;
    let result = unsafe { WaitForSingleObject(handle, 30000) };
    if result != WAIT_OBJECT_0 && result != WAIT_ABANDONED {
        unsafe {
            let _ = CloseHandle(handle);
        }
        return Err("Could not acquire the application startup lock".into());
    }
    Ok(StartupGuard(handle.0 as isize))
}

#[cfg(not(windows))]
pub fn startup_guard(_identifier: &str) -> Result<StartupGuard, String> {
    Ok(StartupGuard(0))
}

impl Drop for StartupGuard {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            let handle = windows::Win32::Foundation::HANDLE(self.0 as *mut std::ffi::c_void);
            let _ = windows::Win32::System::Threading::ReleaseMutex(handle);
            let _ = windows::Win32::Foundation::CloseHandle(handle);
        }
    }
}
use std::path::Path;

pub fn profile_identifier(base: &str, directory: &Path) -> std::io::Result<String> {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    // Resolve the same canonical identity on the first and every later launch.
    std::fs::create_dir_all(directory)?;
    let path = std::fs::canonicalize(directory)?;
    path.to_string_lossy().to_lowercase().hash(&mut hasher);
    Ok(format!("{base}.test{:x}", hasher.finish()))
}

/// Preserve plugin exit events before launching the replacement process.
pub fn restart(app: &tauri::AppHandle) {
    app.request_restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profile_identity_survives_first_directory_creation() {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("new-profile");
        let before = profile_identifier("test.app", &profile).unwrap();
        std::fs::create_dir_all(&profile).unwrap();
        assert_eq!(before, profile_identifier("test.app", &profile).unwrap());
    }
    #[test]
    fn equivalent_profile_paths_share_identity() {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        std::fs::create_dir_all(&profile).unwrap();
        assert_eq!(
            profile_identifier("test.app", &profile).unwrap(),
            profile_identifier("test.app", &profile.join(".")).unwrap()
        );
    }
}
