use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const FILE_NAME: &str = "ui-preferences.json";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiPreferences {
    pub theme: String,
    pub zoom: f64,
}

impl Default for UiPreferences {
    fn default() -> Self {
        Self {
            theme: "light".into(),
            zoom: 1.0,
        }
    }
}

fn validate(preferences: &UiPreferences) -> Result<(), String> {
    if preferences.theme != "light" && preferences.theme != "dark" {
        return Err("invalid UI theme".into());
    }
    if !preferences.zoom.is_finite() || !(0.5..=3.0).contains(&preferences.zoom) {
        return Err("UI zoom must be between 0.5 and 3.0".into());
    }
    Ok(())
}

pub struct UiPreferencesState {
    path: PathBuf,
    current: Mutex<Option<UiPreferences>>,
}

impl UiPreferencesState {
    pub fn empty(data_dir: &Path) -> Self {
        Self { path: data_dir.join(FILE_NAME), current: Mutex::new(None) }
    }

    pub fn load(data_dir: &Path) -> Result<Self, String> {
        let path = data_dir.join(FILE_NAME);
        let current = match fs::read(&path) {
            Ok(bytes) => {
                let preferences: UiPreferences = serde_json::from_slice(&bytes)
                    .map_err(|e| format!("read {}: {e}", path.display()))?;
                validate(&preferences)?;
                Some(preferences)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("read {}: {e}", path.display())),
        };
        Ok(Self {
            path,
            current: Mutex::new(current),
        })
    }

    pub fn get(&self) -> Result<Option<UiPreferences>, String> {
        Ok(self.current.lock().map_err(|e| e.to_string())?.clone())
    }

    pub fn set_theme(&self, theme: String) -> Result<(), String> {
        if theme != "light" && theme != "dark" {
            return Err("invalid UI theme".into());
        }
        self.update(|preferences| preferences.theme = theme)
    }

    pub fn set_zoom(&self, zoom: f64) -> Result<(), String> {
        if !zoom.is_finite() || !(0.5..=3.0).contains(&zoom) {
            return Err("UI zoom must be between 0.5 and 3.0".into());
        }
        self.update(|preferences| preferences.zoom = zoom)
    }

    fn update(&self, change: impl FnOnce(&mut UiPreferences)) -> Result<(), String> {
        let mut current = self.current.lock().map_err(|e| e.to_string())?;
        let mut next = current.clone().unwrap_or_default();
        change(&mut next);
        self.persist(&next)?;
        *current = Some(next);
        Ok(())
    }

    fn persist(&self, preferences: &UiPreferences) -> Result<(), String> {
        let bytes = serde_json::to_vec(preferences).map_err(|e| e.to_string())?;
        let temporary = self.path.with_file_name(format!(
            "{FILE_NAME}.{}.{}.tmp",
            std::process::id(),
            rand::random::<u64>()
        ));
        let write_result = (|| -> std::io::Result<()> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&temporary, &self.path)?;
            Ok(())
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        write_result.map_err(|e| format!("save {}: {e}", self.path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_theme_and_zoom_across_loads() {
        let dir = tempfile::tempdir().unwrap();
        let state = UiPreferencesState::load(dir.path()).unwrap();
        assert_eq!(state.get().unwrap(), None);
        state.set_theme("dark".into()).unwrap();
        state.set_zoom(1.5).unwrap();
        assert_eq!(
            UiPreferencesState::load(dir.path()).unwrap().get().unwrap(),
            Some(UiPreferences {
                theme: "dark".into(),
                zoom: 1.5
            })
        );
    }

    #[test]
    fn rejects_invalid_values_without_overwriting_saved_preferences() {
        let dir = tempfile::tempdir().unwrap();
        let state = UiPreferencesState::load(dir.path()).unwrap();
        state.set_theme("dark".into()).unwrap();
        assert!(state.set_theme("blue".into()).is_err());
        assert!(state.set_zoom(f64::NAN).is_err());
        assert!(state.set_zoom(3.1).is_err());
        assert_eq!(
            UiPreferencesState::load(dir.path())
                .unwrap()
                .get()
                .unwrap()
                .unwrap()
                .theme,
            "dark"
        );
    }

    #[test]
    fn failed_write_can_be_retried_without_losing_current_state() {
        let dir = tempfile::tempdir().unwrap();
        let absent = dir.path().join("missing");
        let state = UiPreferencesState::load(&absent).unwrap();
        assert!(state.set_theme("dark".into()).is_err());
        assert_eq!(state.get().unwrap(), None);
        fs::create_dir(&absent).unwrap();
        state.set_theme("dark".into()).unwrap();
        assert_eq!(
            UiPreferencesState::load(&absent)
                .unwrap()
                .get()
                .unwrap()
                .unwrap()
                .theme,
            "dark"
        );
    }

    #[test]
    fn malformed_file_can_be_replaced_after_load_error() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE_NAME), br#"{"theme":"blue","zoom":1.5}"#).unwrap();
        assert!(UiPreferencesState::load(dir.path()).is_err());
        let state = UiPreferencesState::empty(dir.path());
        state.set_theme("dark".into()).unwrap();
        assert_eq!(UiPreferencesState::load(dir.path()).unwrap().get().unwrap().unwrap().theme, "dark");
    }
}
