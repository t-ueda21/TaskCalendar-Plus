//! 日本の祝日・会社休日・営業日、休憩を除いた所要時間の計算。
//!
//! AIエージェント向けの道具(`mcp.rs`)が、予算の残りや残りの稼働可能時間を計算するために使う。
//! 祝日の算出方式・所要時間の考え方は画面側(`renderer/src/holidays.js`、`store.js` の
//! `taskDurationMinutes`)と同じにしている。

use chrono::{Datelike, Duration, NaiveDate, Weekday};
use serde_json::Value;
use std::collections::BTreeMap;

fn date(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).expect("valid date")
}

fn nth_monday(year: i32, month: u32, nth: u32) -> NaiveDate {
    let first = date(year, month, 1);
    let offset = (7 - first.weekday().num_days_from_monday() as i64) % 7; // 最初の月曜までの日数
    first + Duration::days(offset + 7 * (nth as i64 - 1))
}

fn vernal_equinox_day(year: i32) -> u32 {
    (20.8431 + 0.242194 * (year - 1980) as f64).floor() as u32 - ((year - 1980) / 4) as u32
}

fn autumnal_equinox_day(year: i32) -> u32 {
    (23.2488 + 0.242194 * (year - 1980) as f64).floor() as u32 - ((year - 1980) / 4) as u32
}

/// 指定年の祝日(国民の休日・振替休日を含む)。
pub fn holidays_for_year(year: i32) -> BTreeMap<NaiveDate, &'static str> {
    let mut base = BTreeMap::new();
    base.insert(date(year, 1, 1), "元日");
    base.insert(nth_monday(year, 1, 2), "成人の日");
    base.insert(date(year, 2, 11), "建国記念の日");
    if year >= 2020 {
        base.insert(date(year, 2, 23), "天皇誕生日");
    }
    base.insert(date(year, 3, vernal_equinox_day(year)), "春分の日");
    base.insert(date(year, 4, 29), "昭和の日");
    base.insert(date(year, 5, 3), "憲法記念日");
    base.insert(date(year, 5, 4), "みどりの日");
    base.insert(date(year, 5, 5), "こどもの日");
    base.insert(nth_monday(year, 7, 3), "海の日");
    base.insert(date(year, 8, 11), "山の日");
    base.insert(nth_monday(year, 9, 3), "敬老の日");
    base.insert(date(year, 9, autumnal_equinox_day(year)), "秋分の日");
    base.insert(nth_monday(year, 10, 2), "スポーツの日");
    base.insert(date(year, 11, 3), "文化の日");
    base.insert(date(year, 11, 23), "勤労感謝の日");

    // 国民の休日: 前日と翌日がともに祝日である日(日曜は除く)。
    let mut with_national = base.clone();
    for day in base.keys() {
        let middle = *day + Duration::days(1);
        let next = *day + Duration::days(2);
        if !base.contains_key(&middle) && base.contains_key(&next) && middle.weekday() != Weekday::Sun {
            with_national.insert(middle, "国民の休日");
        }
    }

    // 振替休日: 祝日が日曜なら、その後の最初の祝日でない日。
    let mut result = with_national.clone();
    for day in with_national.keys() {
        if day.weekday() != Weekday::Sun {
            continue;
        }
        let mut cursor = *day + Duration::days(1);
        while result.contains_key(&cursor) {
            cursor += Duration::days(1);
        }
        result.insert(cursor, "振替休日");
    }
    result
}

pub fn holiday_name(day: NaiveDate) -> Option<&'static str> {
    holidays_for_year(day.year()).get(&day).copied()
}

pub fn parse_date(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d").ok()
}

/// "HH:MM"(24:00 も可)を分に変換する。
pub fn time_to_minutes(value: &str) -> Option<i64> {
    let (h, m) = value.trim().split_once(':')?;
    let (h, m): (i64, i64) = (h.parse().ok()?, m.parse().ok()?);
    if (0..=24).contains(&h) && (0..60).contains(&m) && h * 60 + m <= 24 * 60 {
        Some(h * 60 + m)
    } else {
        None
    }
}

pub fn weekday_jp(day: NaiveDate) -> &'static str {
    ["月", "火", "水", "木", "金", "土", "日"][day.weekday().num_days_from_monday() as usize]
}

/// 勤務に関する設定(設定JSONから読む)。
#[derive(Debug, Clone)]
pub struct WorkSettings {
    pub work_start: String,
    pub work_end: String,
    /// 工数から除外する休憩(countAsWork=false)。分単位の [開始, 終了)。
    excluded_breaks: Vec<(i64, i64)>,
    work_week_days: Vec<Weekday>,
    /// 会社休日: "YYYY-MM-DD"(特定日) または "--MM-DD"(毎年)。
    company_holidays: Vec<String>,
}

fn weekday_from_key(key: &str) -> Option<Weekday> {
    Some(match key {
        "Mon" => Weekday::Mon,
        "Tue" => Weekday::Tue,
        "Wed" => Weekday::Wed,
        "Thu" => Weekday::Thu,
        "Fri" => Weekday::Fri,
        "Sat" => Weekday::Sat,
        "Sun" => Weekday::Sun,
        _ => return None,
    })
}

impl WorkSettings {
    pub fn from_settings(settings: &Value) -> Self {
        let text = |key: &str, default: &str| {
            settings.get(key).and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
                .unwrap_or_else(|| default.to_string())
        };
        // 画面側の既定値と同じ(休憩は 12:00-13:00 を工数から除外)。
        let breaks = settings.get("breaks").and_then(|v| v.as_array()).cloned()
            .filter(|b| !b.is_empty())
            .unwrap_or_else(|| vec![serde_json::json!({ "start": "12:00", "end": "13:00", "countAsWork": false })]);
        let excluded_breaks = breaks
            .iter()
            .filter(|b| b.get("countAsWork").and_then(|v| v.as_bool()) != Some(true))
            .filter_map(|b| {
                let s = time_to_minutes(b.get("start")?.as_str()?)?;
                let e = time_to_minutes(b.get("end")?.as_str()?)?;
                (e > s).then_some((s, e))
            })
            .collect();
        let work_week_days = settings.get("workWeekDays").and_then(|v| v.as_array())
            .map(|days| days.iter().filter_map(|d| weekday_from_key(d.as_str()?)).collect::<Vec<_>>())
            .filter(|days| !days.is_empty())
            .unwrap_or_else(|| vec![Weekday::Mon, Weekday::Tue, Weekday::Wed, Weekday::Thu, Weekday::Fri]);
        let company_holidays = settings
            .get("companyHolidayEntries")
            .and_then(|v| v.as_array())
            .map(|rows| rows.iter().filter_map(|r| r.get("dateKey")?.as_str().map(String::from)).collect())
            .or_else(|| settings.get("companyHolidays").and_then(|v| v.as_array())
                .map(|rows| rows.iter().filter_map(|r| r.as_str().map(String::from)).collect()))
            .unwrap_or_default();
        Self {
            work_start: text("workStart", "09:00"),
            work_end: text("workEnd", "18:00"),
            excluded_breaks,
            work_week_days,
            company_holidays,
        }
    }

    /// 休憩(工数に含めないもの)との重なりを除いた所要時間(分)。終日・時刻なしは 0。
    pub fn duration_minutes(&self, start: Option<&str>, end: Option<&str>, all_day: bool) -> i64 {
        if all_day {
            return 0;
        }
        let (Some(s), Some(e)) = (start.and_then(time_to_minutes), end.and_then(time_to_minutes)) else {
            return 0;
        };
        if e <= s {
            return 0;
        }
        let overlap: i64 = self.excluded_breaks.iter().map(|(bs, be)| (e.min(*be) - s.max(*bs)).max(0)).sum();
        (e - s - overlap).max(0)
    }

    pub fn daily_work_minutes(&self) -> i64 {
        self.duration_minutes(Some(&self.work_start), Some(&self.work_end), false)
    }

    pub fn company_holiday(&self, day: NaiveDate) -> bool {
        let exact = day.format("%Y-%m-%d").to_string();
        let recurring = day.format("--%m-%d").to_string();
        self.company_holidays.iter().any(|k| *k == exact || *k == recurring)
    }

    /// 勤務曜日で、祝日・会社休日でない日。
    pub fn is_business_day(&self, day: NaiveDate) -> bool {
        self.work_week_days.contains(&day.weekday()) && holiday_name(day).is_none() && !self.company_holiday(day)
    }
}

/// 月の初日と末日。
pub fn month_bounds(year: i32, month: u32) -> Option<(NaiveDate, NaiveDate)> {
    let first = NaiveDate::from_ymd_opt(year, month, 1)?;
    let next = if month == 12 { NaiveDate::from_ymd_opt(year + 1, 1, 1)? } else { NaiveDate::from_ymd_opt(year, month + 1, 1)? };
    Some((first, next - Duration::days(1)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn name(y: i32, m: u32, d: u32) -> Option<&'static str> {
        holiday_name(date(y, m, d))
    }

    #[test]
    fn holidays_match_renderer_rules() {
        // scripts/test-holidays.mjs と同じ観点(山の日、ハッピーマンデー、春分・秋分、国民の休日、振替休日)。
        assert_eq!(name(2026, 8, 11), Some("山の日"));
        assert_eq!(name(2026, 1, 12), Some("成人の日"));
        assert_eq!(name(2026, 3, 20), Some("春分の日"));
        assert_eq!(name(2026, 9, 21), Some("敬老の日"));
        assert_eq!(name(2026, 9, 22), Some("国民の休日"));
        assert_eq!(name(2026, 9, 23), Some("秋分の日"));
        assert_eq!(name(2026, 5, 6), Some("振替休日")); // 5/3(日)の振替
        assert_eq!(name(2025, 2, 24), Some("振替休日")); // 2/23(日)の振替
        assert_eq!(name(2026, 9, 24), None);
    }

    #[test]
    fn duration_excludes_breaks_not_counted_as_work() {
        let w = WorkSettings::from_settings(&json!({}));
        assert_eq!(w.duration_minutes(Some("11:00"), Some("15:00"), false), 180);
        assert_eq!(w.duration_minutes(Some("09:00"), Some("10:00"), true), 0);
        assert_eq!(w.daily_work_minutes(), 480);
        let counted = WorkSettings::from_settings(&json!({ "breaks": [{ "start": "12:00", "end": "13:00", "countAsWork": true }] }));
        assert_eq!(counted.duration_minutes(Some("11:00"), Some("15:00"), false), 240);
    }

    #[test]
    fn business_days_respect_week_days_holidays_and_company_holidays() {
        let w = WorkSettings::from_settings(&json!({
            "companyHolidayEntries": [{ "dateKey": "2026-09-24", "name": "創立記念日" }, { "dateKey": "--09-25", "name": "毎年" }]
        }));
        assert!(!w.is_business_day(date(2026, 9, 22))); // 国民の休日
        assert!(!w.is_business_day(date(2026, 9, 24))); // 会社休日(特定日)
        assert!(!w.is_business_day(date(2026, 9, 25))); // 会社休日(毎年)
        assert!(!w.is_business_day(date(2026, 9, 26))); // 土曜
        assert!(w.is_business_day(date(2026, 9, 28)));
        let sat = WorkSettings::from_settings(&json!({ "workWeekDays": ["Sat"] }));
        assert!(sat.is_business_day(date(2026, 9, 26)));
    }

    #[test]
    fn month_bounds_handle_year_end() {
        assert_eq!(month_bounds(2026, 12), Some((date(2026, 12, 1), date(2026, 12, 31))));
        assert_eq!(month_bounds(2026, 2), Some((date(2026, 2, 1), date(2026, 2, 28))));
    }
}
