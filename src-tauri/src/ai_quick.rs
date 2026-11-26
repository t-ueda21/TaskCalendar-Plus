//! Conservative local answers for unambiguous numeric work questions.
use chrono::{Datelike, Duration, NaiveDate};

#[derive(Debug)]
pub struct QuickQuery {
    pub from: NaiveDate,
    pub to: NaiveDate,
    pub metric: &'static str,
}

pub fn parse_question(
    question: &str,
    today: NaiveDate,
    view_date: Option<NaiveDate>,
) -> Option<QuickQuery> {
    let compact: String = question.chars().filter(|c| !c.is_whitespace()).collect();
    let mut text = compact.trim_end_matches(['?', '？', '。', '!', '！']);
    for ending in [
        "教えてください",
        "教えて",
        "知りたい",
        "何時間ですか",
        "何時間",
        "どれくらいですか",
        "どのくらいですか",
        "どれくらい",
        "どのくらい",
    ] {
        if let Some(rest) = text.strip_suffix(ending) {
            text = rest;
            break;
        }
    }
    text = text
        .strip_suffix('は')
        .or_else(|| text.strip_suffix('を'))
        .unwrap_or(text);
    let (period, metric) = [
        ("残業時間", "overtime"),
        ("残業", "overtime"),
        ("合計時間", "total"),
        ("作業時間", "total"),
        ("稼働時間", "total"),
        ("総工数", "total"),
        ("工数", "total"),
    ]
    .iter()
    .find_map(|(suffix, metric)| {
        text.strip_suffix(suffix)
            .map(|prefix| (prefix.trim_end_matches('の'), *metric))
    })?;
    let (from, to) = match period {
        "今日" => (today, today),
        "昨日" => {
            let day = today.checked_sub_signed(Duration::days(1))?;
            (day, day)
        }
        "選択日" | "この日" => {
            let day = view_date?;
            (day, day)
        }
        "今月" => crate::calendar::month_bounds(today.year(), today.month())?,
        "先月" => {
            let last = today.with_day(1)?.pred_opt()?;
            crate::calendar::month_bounds(last.year(), last.month())?
        }
        "この月" | "表示中の月" => {
            let day = view_date?;
            crate::calendar::month_bounds(day.year(), day.month())?
        }
        "今週" | "先週" => {
            let start = today.checked_sub_signed(Duration::days(
                i64::from(today.weekday().num_days_from_monday())
                    + if period == "先週" { 7 } else { 0 },
            ))?;
            (start, start.checked_add_signed(Duration::days(6))?)
        }
        "今年" | "去年" | "昨年" => {
            let year = today.year() - i32::from(period != "今年");
            (
                NaiveDate::from_ymd_opt(year, 1, 1)?,
                NaiveDate::from_ymd_opt(year, 12, 31)?,
            )
        }
        _ => {
            if let Some(day) = crate::calendar::parse_date(period) {
                (day, day)
            } else if let Some((year, month)) =
                period.strip_suffix('月').and_then(|s| s.split_once('年'))
            {
                crate::calendar::month_bounds(year.parse().ok()?, month.parse().ok()?)?
            } else {
                let year = period
                    .strip_suffix('年')
                    .and_then(|s| s.parse::<i32>().ok())?;
                (
                    NaiveDate::from_ymd_opt(year, 1, 1)?,
                    NaiveDate::from_ymd_opt(year, 12, 31)?,
                )
            }
        }
    };
    Some(QuickQuery { from, to, metric })
}

pub fn independent_question(
    messages: &serde_json::Value,
    settings: &serde_json::Value,
    today: NaiveDate,
    view_date: Option<NaiveDate>,
) -> bool {
    if settings["aiPersonalization"]["customInstructions"]
        .as_str()
        .is_some_and(|s| !s.trim().is_empty())
    {
        return false;
    }
    let Some(messages) = messages.as_array() else {
        return false;
    };
    messages
        .iter()
        .take(messages.len().saturating_sub(1))
        .all(|message| match message["role"].as_str() {
            Some("user") => message["content"]
                .as_str()
                .and_then(|s| parse_question(s, today, view_date))
                .is_some(),
            Some("assistant") => message["source"] == "application",
            _ => false,
        })
}

pub fn view_context(
    settings: &serde_json::Value,
    view_date: Option<NaiveDate>,
) -> serde_json::Value {
    let work = crate::calendar::WorkSettings::from_settings(settings);
    serde_json::json!({"selectedDate":view_date.map(|d|d.to_string()),"timezone":"Asia/Tokyo","workStart":work.work_start,"workEnd":work.work_end,"dailyWorkMinutes":work.daily_work_minutes()})
}

pub fn format_reply(query: &QuickQuery, report: &serde_json::Value) -> String {
    let metric = if query.metric == "overtime" {
        "残業時間"
    } else {
        "合計作業時間"
    };
    let value = report[if query.metric == "overtime" {
        "overtime"
    } else {
        "total"
    }]
    .as_str()
    .unwrap_or("0分");
    let Some(end) = report["effectiveTo"].as_str() else {
        return format!(
            "{}〜{}は未来の日付のため、今日までの集計対象に含まれません。未来の予定を含めて調べたい場合は、その条件を指定してください。",
            query.from, query.to
        );
    };
    let mut text = format!("{}〜{}の{}は **{}** です。", query.from, end, metric, value);
    text.push_str("\n\n登録済みのタグ付き予定を集計し、重複する時間は1回だけ数え、工数に含めない休憩を除いています。未来の日付は含めていません。");
    if query.metric == "overtime" {
        text.push_str(&format!(
            "\n残業は勤務時間 {}〜{} の外側です。",
            report["rules"]["workStart"].as_str().unwrap_or("09:00"),
            report["rules"]["workEnd"].as_str().unwrap_or("18:00")
        ));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    fn day(text: &str) -> chrono::NaiveDate {
        crate::calendar::parse_date(text).unwrap()
    }
    #[test]
    fn resolves_explicit_periods_and_selected_month_without_guessing() {
        let today = day("2026-11-26");
        for (text, from, to, metric) in [
            ("今月の残業時間は？", "2026-11-01", "2026-11-30", "overtime"),
            (
                "先月の合計時間を教えてください。",
                "2026-10-01",
                "2026-10-31",
                "total",
            ),
            (
                "今週の作業時間は何時間ですか？",
                "2026-11-23",
                "2026-11-29",
                "total",
            ),
            (
                "2024年2月の残業時間",
                "2024-02-01",
                "2024-02-29",
                "overtime",
            ),
            ("この月の残業は？", "2025-12-01", "2025-12-31", "overtime"),
            ("今年の残業時間", "2026-01-01", "2026-12-31", "overtime"),
        ] {
            let q = parse_question(text, today, Some(day("2025-12-12"))).unwrap();
            assert_eq!(q.from, day(from), "{text}");
            assert_eq!(q.to, day(to), "{text}");
            assert_eq!(q.metric, metric);
        }
    }
    #[test]
    fn project_followups_and_custom_instructions_are_not_shortcut() {
        let today = day("2026-11-26");
        let constrained = serde_json::json!([{"role":"user","content":"今後は案件Aだけを対象にして"},{"role":"assistant","content":"了解"},{"role":"user","content":"今月の残業時間は？"}]);
        assert!(!independent_question(
            &constrained,
            &serde_json::json!({}),
            today,
            None
        ));
        let simple = serde_json::json!([{"role":"user","content":"今日の残業時間は？"},{"role":"assistant","source":"application","content":"1時間"},{"role":"user","content":"今月の残業時間は？"}]);
        assert!(independent_question(
            &simple,
            &serde_json::json!({}),
            today,
            None
        ));
        assert!(!independent_question(
            &simple,
            &serde_json::json!({"aiPersonalization":{"customInstructions":"案件Aのみで回答"}}),
            today,
            None
        ));
    }
    #[test]
    fn future_only_questions_show_requested_scope_and_context_does_not_disclose_project_budgets() {
        let q = parse_question("2027年の残業時間", day("2026-11-26"), None).unwrap();
        let reply = format_reply(
            &q,
            &serde_json::json!({"effectiveTo":null,"overtime":"0分"}),
        );
        assert!(
            reply.contains("集計対象")
                && reply.contains("2027-01-01")
                && reply.contains("2027-12-31")
        );
        assert!(!reply.contains("0分"));
        let context = view_context(
            &serde_json::json!({"workStart":"08:00","tags":[{"name":"SECRET","budgetMaxMinutes":12345}]}),
            Some(day("2026-10-01")),
        );
        assert_eq!(context["selectedDate"], "2026-10-01");
        assert_eq!(context["workStart"], "08:00");
        assert!(!context.to_string().contains("SECRET") && !context.to_string().contains("12345"));
    }

    #[test]
    fn mixed_requests_advice_followups_and_unknown_scopes_go_to_the_ai() {
        for text in [
            "今月の残業時間を減らす方法は？",
            "今月の残業時間を教えて、予定も削除して",
            "先月と今月の残業時間を比較して",
            "残業時間は？",
            "それはなぜ？",
            "2026年13月の残業時間",
            "今月の残業時間は？英語で答えて",
            "今月の残業を2時間追加して",
        ] {
            assert!(
                parse_question(text, day("2026-11-26"), None).is_none(),
                "must defer: {text}"
            );
        }
    }
}
