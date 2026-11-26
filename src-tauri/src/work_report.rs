//! Work totals shared by AI reports, comparisons and quick replies.
use crate::calendar::{self, WorkSettings};
use chrono::{Duration, NaiveDate};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};

pub fn period(
    args: &Value,
    from_key: &str,
    to_key: &str,
) -> Result<(NaiveDate, NaiveDate), String> {
    let parse = |key: &str| {
        args.get(key)
            .and_then(Value::as_str)
            .and_then(calendar::parse_date)
            .ok_or_else(|| format!("{key} は YYYY-MM-DD 形式で指定してください"))
    };
    let (from, to) = (parse(from_key)?, parse(to_key)?);
    if to < from || (to - from).num_days() > 3660 {
        return Err("期間は開始日から10年以内で指定してください".into());
    }
    Ok((from, to))
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

pub fn event_intervals(
    task: &Value,
    from: NaiveDate,
    to: NaiveDate,
) -> Vec<(NaiveDate, (i64, i64))> {
    let all_day = task
        .get("isAllDay")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let Ok((start, end)) = crate::event_data::range(
        text(task, "date"),
        task.get("endDate").and_then(Value::as_str),
        all_day,
        task.get("startTime").and_then(Value::as_str),
        task.get("endTime").and_then(Value::as_str),
    ) else {
        return vec![];
    };
    let mut day = start.date().max(from);
    let mut result = Vec::new();
    while day <= to {
        let midnight = day.and_hms_opt(0, 0, 0).expect("valid midnight");
        if midnight >= end {
            break;
        }
        let Some(next) = day.succ_opt() else {
            break;
        };
        let next_midnight = next.and_hms_opt(0, 0, 0).expect("valid midnight");
        let interval = (
            (start.max(midnight) - midnight).num_seconds(),
            (end.min(next_midnight) - midnight).num_seconds(),
        );
        if interval.1 > interval.0 {
            result.push((day, interval));
        }
        day = next;
    }
    result
}

#[derive(Default)]
struct Bucket {
    days: BTreeMap<NaiveDate, Vec<(i64, i64)>>,
    ids: HashSet<String>,
}
impl Bucket {
    fn add(&mut self, day: NaiveDate, interval: (i64, i64), id: &str) {
        self.days.entry(day).or_default().push(interval);
        self.ids.insert(id.into());
    }
    fn value(&self, work: &WorkSettings) -> Value {
        let (seconds, overtime) = self
            .days
            .values()
            .map(|ranges| work.summarize_intervals(ranges))
            .fold((0, 0), |(s, o), (ds, doo)| (s + ds, o + doo));
        json!({"count":self.ids.len(),"totalSeconds":seconds,"totalMinutes":seconds/60,"total":format_minutes(seconds/60),"seconds":seconds,"minutes":seconds/60,"duration":format_minutes(seconds/60),"overtimeSeconds":overtime,"overtimeMinutes":overtime/60,"overtime":format_minutes(overtime/60),"normalSeconds":seconds-overtime})
    }
}

pub fn format_minutes(minutes: i64) -> String {
    let sign = if minutes < 0 { "-" } else { "" };
    let value = minutes.abs();
    match (value / 60, value % 60) {
        (0, m) => format!("{sign}{m}分"),
        (h, 0) => format!("{sign}{h}時間"),
        (h, m) => format!("{sign}{h}時間{m}分"),
    }
}

pub fn summarize(
    tasks: &[Value],
    tags: &HashMap<String, String>,
    work: &WorkSettings,
    args: &Value,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Value, String> {
    let group = args.get("groupBy").and_then(Value::as_str).unwrap_or("day");
    if !["day", "tag", "title", "month", "year"].contains(&group) {
        return Err("groupBy は day/tag/title/month/year を指定してください".into());
    }
    let mut total = Bucket::default();
    let mut groups: BTreeMap<String, Bucket> = BTreeMap::new();
    let tag_filter = text(args, "tagName").to_lowercase();
    let words: Vec<_> = text(args, "keyword")
        .split_whitespace()
        .map(str::to_lowercase)
        .collect();
    for task in tasks {
        let tag_id = text(task, "tagId");
        let Some(tag_name) = tags.get(tag_id).filter(|_| !tag_id.is_empty()) else {
            continue;
        };
        if task.get("isAllDay").and_then(Value::as_bool) == Some(true)
            || text(task, "id").is_empty()
        {
            continue;
        }
        if !tag_name.to_lowercase().contains(&tag_filter) {
            continue;
        }
        let searchable = format!(
            "{} {} {} {}",
            text(task, "title"),
            text(task, "memo"),
            text(task, "localMemo"),
            tag_name
        )
        .to_lowercase();
        if words.iter().any(|word| !searchable.contains(word)) {
            continue;
        }
        for (day, interval) in event_intervals(task, from, to) {
            if work.work_intervals(&[interval]).is_empty() {
                continue;
            }
            total.add(day, interval, text(task, "id"));
            let key = match group {
                "tag" => tag_id.to_string(),
                "title" => text(task, "title").into(),
                "month" => day.format("%Y-%m").to_string(),
                "year" => day.format("%Y").to_string(),
                _ => day.to_string(),
            };
            groups
                .entry(key)
                .or_default()
                .add(day, interval, text(task, "id"));
        }
    }
    let mut result = total.value(work);
    let mut rows: Vec<_> = groups
        .into_iter()
        .map(|(key, bucket)| {
            let mut value = bucket.value(work);
            if group == "tag" {
                value["tagId"] = json!(key);
                value["key"] = json!(tags.get(&key).unwrap_or(&key));
            } else {
                value["key"] = json!(key);
            }
            value
        })
        .collect();
    if matches!(group, "tag" | "title") {
        rows.sort_by_key(|v| std::cmp::Reverse(v["totalSeconds"].as_i64().unwrap_or(0)));
    }
    result["truncated"] = json!(rows.len() > 500);
    rows.truncate(500);
    result["groups"] = json!(rows);
    result["groupBy"] = json!(group);
    result["registeredDays"] = json!(total.days.len());
    result["overtimeDays"] = json!(
        total
            .days
            .values()
            .filter(|r| work.summarize_intervals(r).1 > 0)
            .count()
    );
    Ok(result)
}

fn round_report(value: &mut Value) {
    let rounded = |seconds: i64| (seconds + 30).div_euclid(60);
    for (field, display, text_field) in [
        ("totalSeconds", "totalMinutes", "total"),
        ("overtimeSeconds", "overtimeMinutes", "overtime"),
    ] {
        if let Some(seconds) = value[field].as_i64() {
            let minutes = rounded(seconds);
            value[display] = json!(minutes);
            value[text_field] = json!(format_minutes(minutes));
        }
    }
    if let Some(seconds) = value["seconds"].as_i64() {
        value["minutes"] = json!(rounded(seconds));
        value["duration"] = json!(format_minutes(rounded(seconds)));
    }
    for (field, minutes_field, text_field) in [
        ("totalDeltaSeconds", "totalDeltaMinutes", "totalDelta"),
        (
            "overtimeDeltaSeconds",
            "overtimeDeltaMinutes",
            "overtimeDelta",
        ),
    ] {
        if let Some(seconds) = value[field].as_i64() {
            value[minutes_field] = json!(rounded(seconds));
            value[text_field] = json!(format_minutes(rounded(seconds)));
        }
    }
    if let Some(groups) = value.get_mut("groups").and_then(Value::as_array_mut) {
        for group in groups {
            round_report(group);
        }
    }
    if let Some(comparison) = value.get_mut("comparison") {
        round_report(comparison);
    }
}

pub fn work_report(
    tasks: &[Value],
    tags: &HashMap<String, String>,
    settings: &Value,
    args: &Value,
    today: NaiveDate,
) -> Result<Value, String> {
    let (from, to) = period(args, "dateFrom", "dateTo")?;
    let work = WorkSettings::from_settings(settings);
    let include_future = args
        .get("includeFuture")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let cutoff = if include_future { to } else { to.min(today) };
    let mut result = summarize(tasks, tags, &work, args, from, cutoff)?;
    result["dateFrom"] = json!(from.to_string());
    result["dateTo"] = json!(to.to_string());
    result["effectiveTo"] = if cutoff >= from {
        json!(cutoff.to_string())
    } else {
        Value::Null
    };
    result["includeFuture"] = json!(include_future);
    result["rules"] = json!({"timezone":"Asia/Tokyo","workStart":work.work_start,"workEnd":work.work_end,"overlap":"count once per day","tags":"existing tags only","overtime":"outside workStart/workEnd after excluding unpaid breaks; not statutory overtime","groupTotalsMayOverlap":true});
    if args.get("compareFrom").is_some() || args.get("compareTo").is_some() {
        let (cf, ct) = period(args, "compareFrom", "compareTo")?;
        let effective = if include_future { ct } else { ct.min(today) };
        let mut comparison = summarize(tasks, tags, &work, args, cf, effective)?;
        comparison["dateFrom"] = json!(cf.to_string());
        comparison["dateTo"] = json!(ct.to_string());
        comparison["effectiveTo"] = if effective >= cf {
            json!(effective.to_string())
        } else {
            Value::Null
        };
        let seconds = result["totalSeconds"].as_i64().unwrap_or(0)
            - comparison["totalSeconds"].as_i64().unwrap_or(0);
        let overtime = result["overtimeSeconds"].as_i64().unwrap_or(0)
            - comparison["overtimeSeconds"].as_i64().unwrap_or(0);
        comparison["totalDeltaSeconds"] = json!(seconds);
        comparison["totalDeltaMinutes"] = json!(seconds / 60);
        comparison["totalDelta"] = json!(format_minutes(seconds / 60));
        comparison["overtimeDeltaSeconds"] = json!(overtime);
        comparison["overtimeDeltaMinutes"] = json!(overtime / 60);
        comparison["overtimeDelta"] = json!(format_minutes(overtime / 60));
        result["comparison"] = comparison;
    }
    round_report(&mut result);
    Ok(result)
}

/// Available working ranges use calendar occupancy, independently of work tags.
pub fn business_ranges(
    tasks: &[Value],
    settings: &Value,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<BTreeMap<NaiveDate, Vec<(i64, i64)>>, String> {
    let mut result = BTreeMap::new();
    if to < from {
        return Ok(result);
    }
    use chrono::Datelike;
    if !(1980..=2099).contains(&from.year()) || !(1980..=2099).contains(&to.year()) {
        return Err("営業日を含む空き時間の計算は1980〜2099年に対応しています".into());
    }
    let work = WorkSettings::from_settings(settings);
    let start = calendar::time_to_seconds(&work.work_start).ok_or("勤務開始時刻が不正です")?;
    let end = calendar::time_to_seconds(&work.work_end).ok_or("勤務終了時刻が不正です")?;
    if end <= start {
        return Err("勤務終了時刻は開始時刻より後にしてください".into());
    }
    let mut busy: BTreeMap<NaiveDate, Vec<(i64, i64)>> = BTreeMap::new();
    for task in tasks {
        if task["outlookDetails"]["busyStatus"].as_i64() == Some(0) {
            continue;
        }
        for (day, range) in event_intervals(task, from, to) {
            busy.entry(day).or_default().push(range);
        }
    }
    let mut day = from;
    while day <= to {
        if work.is_business_day(day) {
            let mut free = work.work_intervals(&[(start, end)]);
            for range in calendar::merge_intervals(busy.get(&day).map(Vec::as_slice).unwrap_or(&[]))
            {
                free = calendar::subtract_interval(&free, range);
            }
            result.insert(day, free);
        }
        day += Duration::days(1);
    }
    Ok(result)
}

pub fn availability(tasks: &[Value], settings: &Value, args: &Value) -> Result<Value, String> {
    let (from, to) = period(args, "dateFrom", "dateTo")?;
    let minimum = args.get("minMinutes").and_then(Value::as_i64).unwrap_or(30);
    if !(1..=1440).contains(&minimum) {
        return Err("minMinutes は1〜1440を指定してください".into());
    }
    let mut slots = Vec::new();
    let mut seconds = 0;
    for (day, ranges) in business_ranges(tasks, settings, from, to)? {
        for (s, e) in ranges {
            if e - s >= minimum * 60 {
                seconds += e - s;
                slots.push(json!({"date":day.to_string(),"startTime":format!("{:02}:{:02}:{:02}",s/3600,s%3600/60,s%60),"endTime":format!("{:02}:{:02}:{:02}",e/3600,e%3600/60,e%60),"minutes":(e-s)/60,"seconds":e-s}));
            }
        }
    }
    let count = slots.len();
    slots.truncate(500);
    Ok(
        json!({"dateFrom":from.to_string(),"dateTo":to.to_string(),"slots":slots,"slotCount":count,"truncated":count>500,"totalMinutes":seconds/60,"totalSeconds":seconds,"total":format_minutes(seconds/60),"rules":"Business hours minus breaks and registered busy events, including untagged/all-day. Events explicitly marked Free do not block time."}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn renderer_parity_fixtures_cover_overlap_breaks_tags_midnight_and_seconds() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../scripts/fixtures/ai-work-reports.json"))
                .unwrap();
        for case in fixtures.as_array().unwrap() {
            let tags = case["tags"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tag| {
                    (
                        tag["id"].as_str().unwrap().to_string(),
                        tag["name"].as_str().unwrap().to_string(),
                    )
                })
                .collect();
            let report = work_report(
                case["tasks"].as_array().unwrap(),
                &tags,
                &case["settings"],
                &json!({"dateFrom":case["dateFrom"],"dateTo":case["dateTo"],"includeFuture":true}),
                crate::calendar::parse_date("2026-11-26").unwrap(),
            )
            .unwrap();
            assert_eq!(
                report["totalMinutes"], case["expected"]["totalMinutes"],
                "display minutes: {}",
                case["name"]
            );
            assert_eq!(
                report["overtimeMinutes"], case["expected"]["overtimeMinutes"],
                "display overtime: {}",
                case["name"]
            );
            assert_eq!(
                report["totalSeconds"], case["expected"]["totalSeconds"],
                "{}",
                case["name"]
            );
            assert_eq!(
                report["overtimeSeconds"], case["expected"]["overtimeSeconds"],
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn future_cutoff_comparison_and_invalid_ranges_are_explicit() {
        let tasks = vec![
            json!({"id":"1","date":"2026-11-02","tagId":"a","startTime":"18:00","endTime":"19:00"}),
            json!({"id":"2","date":"2026-11-27","tagId":"a","startTime":"18:00","endTime":"20:00"}),
            json!({"id":"3","date":"2026-10-02","tagId":"a","startTime":"18:00","endTime":"18:30"}),
        ];
        let tags = std::collections::HashMap::from([("a".into(), "作業".into())]);
        let today = crate::calendar::parse_date("2026-11-26").unwrap();
        let args = json!({"dateFrom":"2026-11-01","dateTo":"2026-11-30","compareFrom":"2026-10-01","compareTo":"2026-10-31"});
        let r = work_report(&tasks, &tags, &json!({}), &args, today).unwrap();
        assert_eq!(r["overtimeMinutes"], 60);
        assert_eq!(r["effectiveTo"], "2026-11-26");
        assert_eq!(r["comparison"]["overtimeDeltaMinutes"], 30);
        assert!(
            work_report(
                &tasks,
                &tags,
                &json!({}),
                &json!({"dateFrom":"2026-12-01","dateTo":"2026-11-01"}),
                today
            )
            .is_err()
        );
    }

    #[test]
    fn personal_memo_and_duplicate_tag_labels_do_not_drop_work() {
        let tasks = vec![
            json!({"id":"1","date":"2026-11-26","tagId":"a","startTime":"09:00","endTime":"10:00","localMemo":"needle"}),
            json!({"id":"2","date":"2026-11-26","tagId":"b","startTime":"09:00","endTime":"10:00","localMemo":"needle"}),
        ];
        let tags = HashMap::from([("a".into(), "同名".into()), ("b".into(), "同名".into())]);
        let result=work_report(&tasks,&tags,&json!({}),&json!({"dateFrom":"2026-11-26","dateTo":"2026-11-26","keyword":"needle","groupBy":"tag"}),crate::calendar::parse_date("2026-11-26").unwrap()).unwrap();
        assert_eq!(result["totalMinutes"], 60);
        assert_eq!(result["groups"].as_array().unwrap().len(), 2);
        assert_eq!(result["groups"][0]["tagId"], "a");
        assert_eq!(result["groups"][1]["tagId"], "b");
    }

    #[test]
    fn free_status_does_not_block_slots_and_unsupported_holiday_years_fail_safely() {
        let tasks = vec![
            json!({"id":"free","date":"2026-11-26","isAllDay":true,"outlookDetails":{"busyStatus":0}}),
            json!({"id":"busy","date":"2026-11-26","startTime":"09:00","endTime":"10:00"}),
        ];
        let result = availability(
            &tasks,
            &json!({}),
            &json!({"dateFrom":"2026-11-26","dateTo":"2026-11-26"}),
        )
        .unwrap();
        assert_eq!(result["totalMinutes"], 420);
        assert!(
            availability(
                &[],
                &json!({}),
                &json!({"dateFrom":"0001-01-01","dateTo":"0001-01-01"})
            )
            .is_err()
        );
    }

    #[test]
    fn availability_respects_untagged_and_all_day_events_and_work_rules() {
        let tasks = vec![
            json!({"id":"1","date":"2026-11-26","tagId":"","startTime":"09:00","endTime":"10:00"}),
            json!({"id":"2","date":"2026-11-27","isAllDay":true}),
        ];
        let result = availability(
            &tasks,
            &json!({}),
            &json!({"dateFrom":"2026-11-26","dateTo":"2026-11-28","minMinutes":60}),
        )
        .unwrap();
        assert_eq!(result["slots"].as_array().unwrap().len(), 2);
        assert_eq!(result["slots"][0]["startTime"], "10:00:00");
        assert_eq!(result["slots"][0]["endTime"], "12:00:00");
        assert_eq!(result["slots"][1]["startTime"], "13:00:00");
        assert_eq!(result["totalMinutes"], 420);
    }
}
