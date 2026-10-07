//! Display language is independent of Japan's calendar/time-zone rules.
use serde_json::Value;
use std::sync::OnceLock;

fn catalogs() -> &'static Value {
    static CATALOGS: OnceLock<Value> = OnceLock::new();
    CATALOGS.get_or_init(|| serde_json::from_str(include_str!("../renderer/src/locales/catalogs.json")).expect("validated locale catalogs"))
}

pub fn text(key: &str, locale: &str) -> String {
    catalogs().get(normalize_locale(locale)).and_then(|map|map.get(key)).and_then(Value::as_str)
        .or_else(||catalogs()["ja"].get(key).and_then(Value::as_str)).unwrap_or(key).to_string()
}

pub fn error_text(message: &str, locale: &str, fallback: &str) -> String {
    if normalize_locale(locale) == "ja" { return message.to_string(); }
    let matched = ["ja","en"].iter().find_map(|language|catalogs()[language].as_object()?.iter().find(|(_,value)|value.as_str()==Some(message)).map(|(key,_)|key.clone()));
    matched.map_or_else(||text(fallback,locale),|key|text(&key,locale))
}

pub fn normalize_locale(value: &str) -> &'static str {
    let code = value.trim().replace('_', "-").to_lowercase();
    if code.starts_with("zh") {
        return if code.split('-').any(|s| ["hant", "tw", "hk", "mo"].contains(&s)) { "zh-TW" } else { "zh-CN" };
    }
    match code.split('-').next().unwrap_or("") {
        "en" => "en", "ko" => "ko", "es" => "es", "fr" => "fr", "de" => "de", "pt" => "pt", _ => "ja",
    }
}

pub fn os_locale() -> String {
    #[cfg(windows)]
    {
        use windows::Win32::Globalization::{GetUserDefaultUILanguage, LCIDToLocaleName};
        let mut name = [0u16; 85];
        let length = unsafe { LCIDToLocaleName(u32::from(GetUserDefaultUILanguage()), Some(&mut name), 0) };
        if length > 0 { return String::from_utf16_lossy(&name[..length as usize - 1]); }
    }
    "ja".into()
}

pub fn effective_locale(settings: &Value, os: &str) -> &'static str {
    let setting = settings.get("uiLanguage").and_then(Value::as_str).unwrap_or("auto");
    normalize_locale(if setting == "auto" { os } else { setting })
}

pub fn language_name(locale: &str) -> &'static str {
    match normalize_locale(locale) {
        "en" => "English", "ko" => "Korean", "zh-CN" => "Simplified Chinese", "zh-TW" => "Traditional Chinese",
        "es" => "Spanish", "fr" => "French", "de" => "German", "pt" => "Portuguese", _ => "Japanese",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn language_is_explicit_or_windows_ui_with_japanese_fallback() {
        assert_eq!(effective_locale(&serde_json::json!({}), "ko-KR"), "ko");
        assert_eq!(effective_locale(&serde_json::json!({"uiLanguage":"en"}), "ko-KR"), "en");
        assert_eq!(normalize_locale("zh-Hant-HK"), "zh-TW");
        assert_eq!(normalize_locale("pt-BR"), "pt");
        assert_eq!(normalize_locale("ar-SA"), "ja");
        assert!(!os_locale().is_empty());
        assert_eq!(text("common.save","ko"),"저장");
        assert_eq!(error_text("モデル名を入力するか、取得した候補から選んでください。","en","errors.generic"),"Enter a model name or choose from the fetched list.");
    }
}
