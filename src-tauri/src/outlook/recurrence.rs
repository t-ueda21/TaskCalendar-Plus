//! Native Outlook recurrence rules. Never expand a native rule into independent writes.
use super::*;

use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
mod series;
pub(super) use series::execute;
pub(crate) use series::normalize_future_rule;
pub(crate) use series::normalize_past_rule;
pub use series::{SeriesEditRequest, SeriesEditResult};
#[cfg(test)]
mod live_tests;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeRule {
    pub recurrence_type: i32,
    pub interval: i32,
    pub day_of_week_mask: i32,
    pub day_of_month: i32,
    pub month_of_year: i32,
    pub instance: i32,
    pub pattern_start_date: String,
    pub pattern_end_date: Option<String>,
    pub occurrences: Option<i32>,
    pub no_end_date: bool,
}
fn day(value: &str) -> Result<NaiveDate, String> {
    let d = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| format!("Invalid recurrence date: {value}"))?;
    if !(1601..=4500).contains(&d.year()) || d.format("%Y-%m-%d").to_string() != value {
        return Err("Recurrence dates must use YYYY-MM-DD (1601–4500)".into());
    }
    Ok(d)
}
impl NativeRule {
    pub fn parse(value: &Value) -> Result<Self, String> {
        let raw = value.get("native").unwrap_or(value);
        let r: Self = serde_json::from_value(raw.clone())
            .map_err(|e| format!("Invalid recurrence rule: {e}"))?;
        if ![0, 1, 2, 3, 5, 6].contains(&r.recurrence_type) {
            return Err("Invalid recurrence type".into());
        }
        if !(1..=999).contains(&r.interval) {
            return Err("Recurrence interval must be 1–999".into());
        }
        if [5, 6].contains(&r.recurrence_type) && r.interval % 12 != 0 {
            return Err("Native yearly intervals must be multiples of 12 months".into());
        }
        if !(0..=127).contains(&r.day_of_week_mask)
            || !(0..=31).contains(&r.day_of_month)
            || !(0..=12).contains(&r.month_of_year)
            || !(0..=5).contains(&r.instance)
        {
            return Err("Invalid recurrence day, month or instance".into());
        }
        if [1, 3, 6].contains(&r.recurrence_type) && r.day_of_week_mask == 0 {
            return Err("Select at least one recurrence weekday".into());
        }
        if [3,6].contains(&r.recurrence_type)&&![1,2,4,8,16,32,64,62,65,127].contains(&r.day_of_week_mask){return Err("Nth recurrence requires one weekday, weekdays, weekends or all days".into());}
        if [2, 5].contains(&r.recurrence_type) && r.day_of_month == 0 {
            return Err("Recurrence day must be 1–31".into());
        }
        if [3, 6].contains(&r.recurrence_type) && r.instance == 0 {
            return Err("Recurrence instance must be 1–5 (5=last)".into());
        }
        if [5, 6].contains(&r.recurrence_type) && r.month_of_year == 0 {
            return Err("Recurrence month must be 1–12".into());
        }
        let start = day(&r.pattern_start_date)?;
        if let Some(end) = &r.pattern_end_date
            && day(end)? < start {
                return Err("Recurrence end precedes start".into());
            }
        if r.occurrences.is_some_and(|n| !(1..=999).contains(&n)) {
            return Err("Recurrence occurrences must be 1–999".into());
        }
        if r.no_end_date && (r.pattern_end_date.is_some() || r.occurrences.is_some()) {
            return Err("No-end recurrence cannot specify an end date or count".into());
        }
        if !r.no_end_date && r.pattern_end_date.is_none() && r.occurrences.is_none() {
            return Err("Recurrence requires an end date or count".into());
        }
        Ok(r)
    }
}
pub fn validate(value: &Value) -> Result<Value, String> {
    serde_json::to_value(NativeRule::parse(value)?).map_err(|e| e.to_string())
}
fn month_end(date: NaiveDate) -> u32 {
    let next = if date.month() == 12 {
        NaiveDate::from_ymd_opt(date.year() + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(date.year(), date.month() + 1, 1)
    };
    next.unwrap().pred_opt().unwrap().day()
}
fn matches_date(r: &NativeRule, start: NaiveDate, date: NaiveDate) -> bool {
    if date < start {
        return false;
    }
    let days = (date - start).num_days();
    let months = (date.year() - start.year()) * 12 + date.month() as i32 - start.month() as i32;
    let masked = |d: NaiveDate| r.day_of_week_mask & (1 << d.weekday().num_days_from_sunday()) != 0;
    let nth = || {
        if !masked(date) {
            return false;
        }
        let first = NaiveDate::from_ymd_opt(date.year(), date.month(), 1).unwrap();
        let count = (0..date.day())
            .filter(|n| masked(first + chrono::Duration::days(*n as i64)))
            .count() as i32;
        if r.instance < 5 {
            count == r.instance
        } else {
            ((date.day() + 1)..=month_end(date))
                .all(|n| !masked(NaiveDate::from_ymd_opt(date.year(), date.month(), n).unwrap()))
        }
    };
    match r.recurrence_type {
        0 => days % i64::from(r.interval) == 0,
        1 => {
            (days + i64::from(start.weekday().num_days_from_sunday())) / 7 % i64::from(r.interval)
                == 0
                && masked(date)
        }
        2 => months % r.interval == 0 && date.day() == (r.day_of_month as u32).min(month_end(date)),
        3 => months % r.interval == 0 && nth(),
        5 => {
            (date.year() - start.year()) % (r.interval / 12) == 0
                && date.month() == r.month_of_year as u32
                && date.day() == (r.day_of_month as u32).min(month_end(date))
        }
        6 => {
            (date.year() - start.year()) % (r.interval / 12) == 0
                && date.month() == r.month_of_year as u32
                && nth()
        }
        _ => false,
    }
}
pub fn occurrence_dates(value: &Value, through: &str) -> Result<Vec<String>, String> {
    let r = NativeRule::parse(value)?;
    let start = day(&r.pattern_start_date)?;
    let mut end = day(through)?;
    if let Some(e) = &r.pattern_end_date {
        end = end.min(day(e)?);
    }
    let mut cursor = start;
    let mut dates = Vec::new();
    while cursor <= end {
        if matches_date(&r, start, cursor) {
            dates.push(cursor.format("%Y-%m-%d").to_string());
            if r.occurrences.is_some_and(|n| dates.len() >= n as usize) {
                break;
            }
            if dates.len() > 100_000 {
                return Err("Recurrence preview exceeds 100000 occurrences".into());
            }
        }
        cursor = cursor.succ_opt().ok_or("Recurrence date overflow")?;
    }
    Ok(dates)
}

fn property_date(item: &w::IDispatch, name: &str) -> Result<String, String> {
    reconcile::date_property(item, name).map(|d| date_key(d.date()))
}
pub(super) fn read(item: &w::IDispatch) -> Result<Value, String> {
    let recurring =
        bool::try_from(&automation::get(item, "IsRecurring")?).map_err(|e| e.to_string())?;
    if !recurring {
        return Ok(json!({"type":"none"}));
    }
    let pattern = automation::object_method(item, "GetRecurrencePattern", &[])?;
    let kind = automation::integer(&pattern, "RecurrenceType")?;
    let no_end =
        bool::try_from(&automation::get(&pattern, "NoEndDate")?).map_err(|e| e.to_string())?;
    let r = NativeRule {
        recurrence_type: kind,
        interval: automation::integer(&pattern, "Interval")?,
        day_of_week_mask: if [1, 3, 6].contains(&kind) {
            automation::integer(&pattern, "DayOfWeekMask")?
        } else {
            0
        },
        day_of_month: if [2, 5].contains(&kind) {
            automation::integer(&pattern, "DayOfMonth")?
        } else {
            0
        },
        month_of_year: if [5, 6].contains(&kind) {
            automation::integer(&pattern, "MonthOfYear")?
        } else {
            0
        },
        instance: if [3, 6].contains(&kind) {
            automation::integer(&pattern, "Instance")?
        } else {
            0
        },
        pattern_start_date: property_date(&pattern, "PatternStartDate")?,
        pattern_end_date: if no_end {
            None
        } else {
            Some(property_date(&pattern, "PatternEndDate")?)
        },
        occurrences: if no_end {
            None
        } else {
            Some(automation::integer(&pattern, "Occurrences")?)
        },
        no_end_date: no_end,
    };
    let native = serde_json::to_value(&r).map_err(|e| e.to_string())?;
    // Read is lossless even for provider rules outside the editor's safety limits.
    Ok(json!({"type":"native","native":native}))
}

pub(super) fn apply(item: &w::IDispatch, value: &Value) -> Result<(), String> {
    // Finish parsing and date conversion before any mutating COM operation.
    let r = NativeRule::parse(value)?;
    let start = outlook_date(&r.pattern_start_date, "00:00")?;
    let end = r
        .pattern_end_date
        .as_deref()
        .map(|d| outlook_date(d, "00:00"))
        .transpose()?;
    if ![0, 1].contains(&automation::integer(item, "RecurrenceState")?) {
        return Err("Apply a recurrence rule to the series master, not an occurrence".into());
    }
    let p = automation::object_method(item, "GetRecurrencePattern", &[])?;
    // Microsoft requires type first, then mask/interval, then start/end boundaries.
    automation::put(
        &p,
        "RecurrenceType",
        AutomationValue::from(r.recurrence_type),
    )?;
    automation::put(&p, "Interval", AutomationValue::from(r.interval))?;
    for (name, value, enabled) in [
        (
            "DayOfWeekMask",
            r.day_of_week_mask,
            [1, 3, 6].contains(&r.recurrence_type),
        ),
        (
            "DayOfMonth",
            r.day_of_month,
            [2, 5].contains(&r.recurrence_type),
        ),
        (
            "MonthOfYear",
            r.month_of_year,
            [5, 6].contains(&r.recurrence_type),
        ),
        ("Instance", r.instance, [3, 6].contains(&r.recurrence_type)),
    ] {
        if enabled && automation::integer(&p,name)?!=value {
            automation::put(&p, name, AutomationValue::from(value))?;
        }
    }
    automation::put(&p, "PatternStartDate", start)?;
    automation::put(&p, "NoEndDate", AutomationValue::from(r.no_end_date))?;
    if !r.no_end_date {
        // Outlook reports both computed date and count. Count preserves that series
        // after a pattern change; a date-driven edit explicitly clears occurrences.
        if let Some(count) = r.occurrences {
            automation::put(&p, "Occurrences", AutomationValue::from(count))?;
        } else if let Some(end) = end {
            automation::put(&p, "PatternEndDate", end)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rule(kind: i32) -> Value {
        json!({"recurrenceType":kind,"interval":if [5,6].contains(&kind){12}else{1},"dayOfWeekMask":2,"dayOfMonth":31,"monthOfYear":1,"instance":5,"patternStartDate":"2026-01-01","patternEndDate":null,"occurrences":null,"noEndDate":true})
    }
    #[test]
    fn all_native_types_roundtrip_without_loss() {
        for kind in [0, 1, 2, 3, 5, 6] {
            let value = rule(kind);
            assert_eq!(validate(&value).unwrap(), value);
        }
    }
    #[test]
    fn rejects_invalid_or_ambiguous_rule_before_com() {
        for (field, value) in [
            ("recurrenceType", json!(4)),
            ("interval", json!(0)),
            ("interval", json!(1.5)),
            ("patternStartDate", json!("2026-02-30")),
            ("dayOfWeekMask", json!(128)),
        ] {
            let mut r = rule(1);
            r[field] = value;
            assert!(validate(&r).is_err(), "{field}");
        }
        let mut r = rule(3);
        r["instance"] = json!(6);
        assert!(validate(&r).is_err());
        r = rule(2);
        r["dayOfMonth"] = json!(0);
        assert!(validate(&r).is_err());
        r = rule(5);
        r["monthOfYear"] = json!(13);
        assert!(validate(&r).is_err());
        r = rule(0);
        r["noEndDate"] = json!(false);
        assert!(validate(&r).is_err());
        r["patternEndDate"] = json!("2025-12-31");
        assert!(validate(&r).is_err());
        r = rule(0);
        r["occurrences"] = json!(0);
        assert!(validate(&r).is_err());
    }
    #[test]
    fn preserves_outlook_computed_end_and_count_together() {
        let mut r = rule(1);
        r["noEndDate"] = json!(false);
        r["patternEndDate"] = json!("2026-03-30");
        r["occurrences"] = json!(13);
        assert_eq!(validate(&json!({"type":"native","native":r})).unwrap(), r);
    }
    #[test]
    fn dates_honor_interval_masks_count_and_last_weekday() {
        let mut r = rule(1);
        r["interval"] = json!(2);
        r["dayOfWeekMask"] = json!(10);
        r["patternStartDate"] = json!("2026-10-05");
        r["noEndDate"] = json!(false);
        r["occurrences"] = json!(4);
        assert_eq!(
            occurrence_dates(&r, "2026-12-31").unwrap(),
            ["2026-10-05", "2026-10-07", "2026-10-19", "2026-10-21"]
        );
        r = rule(3);
        r["dayOfWeekMask"] = json!(32);
        r["patternStartDate"] = json!("2026-01-01");
        assert_eq!(
            occurrence_dates(&r, "2026-03-31").unwrap(),
            ["2026-01-30", "2026-02-27", "2026-03-27"]
        );
        r = rule(2);
        assert_eq!(
            occurrence_dates(&r, "2026-03-31").unwrap(),
            ["2026-01-31", "2026-02-28", "2026-03-31"]
        );
        r = rule(6);
        r["monthOfYear"] = json!(6);
        r["instance"] = json!(1);
        r["interval"] = json!(24);
        assert_eq!(
            occurrence_dates(&r, "2030-12-31").unwrap(),
            ["2026-06-01", "2028-06-05", "2030-06-03"]
        );
    }
    #[test]
    fn start_before_first_occurrence_preserves_interval_phase() {
        let mut r = rule(1);
        r["patternStartDate"] = json!("2027-01-01");
        r["interval"] = json!(2);
        assert_eq!(
            occurrence_dates(&r, "2027-01-31").unwrap(),
            ["2027-01-11", "2027-01-25"]
        );
        r = rule(2);
        r["patternStartDate"] = json!("2027-01-20");
        r["dayOfMonth"] = json!(15);
        r["interval"] = json!(2);
        assert_eq!(occurrence_dates(&r, "2027-05-01").unwrap(), ["2027-03-15"]);
    }
}
