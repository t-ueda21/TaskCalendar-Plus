//! Serialize startup until the single-instance plugin has registered its IPC window.
//! This closes the plugin's Windows mutex/hidden-window creation race.
pub struct StartupGuard(isize);

#[cfg(windows)]
pub fn startup_guard(identifier: &str) -> Result<StartupGuard,String> {
    use windows::{core::PCWSTR,Win32::{System::Threading::{CreateMutexW,WaitForSingleObject},Foundation::{WAIT_OBJECT_0,WAIT_ABANDONED,CloseHandle}}};
    let name: Vec<u16> = format!("Local\\{identifier}-startup\0").encode_utf16().collect();
    let handle = unsafe { CreateMutexW(None,false,PCWSTR(name.as_ptr())) }.map_err(|e|e.to_string())?;
    let result = unsafe { WaitForSingleObject(handle,30000) };
    if result != WAIT_OBJECT_0 && result != WAIT_ABANDONED { unsafe { let _ = CloseHandle(handle); } return Err("Could not acquire the application startup lock".into()); }
    Ok(StartupGuard(handle.0 as isize))
}

#[cfg(not(windows))]
pub fn startup_guard(_identifier: &str) -> Result<StartupGuard,String> { Ok(StartupGuard(0)) }

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
