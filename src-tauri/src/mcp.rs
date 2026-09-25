//! AIエージェント(Claude Code / Codex)向けの MCP サーバー(Streamable HTTP の JSON-RPC)。
//!
//! AIモードのチャット1回ごとにセッションを発行し、CLIはこのサーバーの道具で予定を調べたり、
//! 予定の作成・変更・削除を「提案」したりする。道具はDBへ書き込まない。提案はセッションごとに
//! 記録してチャットの応答と一緒に画面へ返し、利用者が確認カードで確定したときだけ画面側が実行する。
//! 時間はすべて分と「○時間○分」の両方で返し、AIに計算させない。

use crate::calendar::{self, WorkSettings};
use crate::repositories as repo;
use chrono::{Datelike, Duration, NaiveDate};
use rusqlite::Connection;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

pub const SERVER_NAME: &str = "taskcalendar";
const DEFAULT_PROTOCOL_VERSION: &str = "2025-06-18";
const DEFAULT_TASK_LIMIT: usize = 100;
const MAX_TASK_LIMIT: usize = 500;
const MAX_NOTE_DAYS: i64 = 62;

/// セッションID → そのチャットで出された提案。セッションはチャットの開始時に登録し、終了時に取り除く。
pub type ProposalStore = Arc<Mutex<HashMap<String, Vec<Value>>>>;

pub struct McpContext<'a> {
    pub conn: &'a Connection,
    pub today: NaiveDate,
    pub session: &'a str,
    pub proposals: &'a ProposalStore,
}

pub fn format_minutes(minutes: i64) -> String {
    let sign = if minutes < 0 { "-" } else { "" };
    let abs = minutes.abs();
    match (abs / 60, abs % 60) {
        (0, m) => format!("{sign}{m}分"),
        (h, 0) => format!("{sign}{h}時間"),
        (h, m) => format!("{sign}{h}時間{m}分"),
    }
}

fn arg_str<'v>(args: &'v Value, key: &str) -> Option<&'v str> {
    args.get(key).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty())
}

fn arg_date(args: &Value, key: &str) -> Result<Option<NaiveDate>, String> {
    match arg_str(args, key) {
        None => Ok(None),
        Some(text) => calendar::parse_date(text).map(Some).ok_or_else(|| format!("{key} は YYYY-MM-DD 形式で指定してください: {text}")),
    }
}

fn contains_ci(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

// ── 道具の定義 ────────────────────────────────────────────────

fn tool_definitions() -> Value {
    let date = json!({ "type": "string", "description": "YYYY-MM-DD" });
    let time = json!({ "type": "string", "description": "HH:MM(24時間表記)" });
    json!([
        {
            "name": "get_context",
            "description": "今日の日付・曜日、勤務時間(始業・終業・1日の稼働時間)、勤務曜日、タグの一覧と月間予算を返す。日付の解釈や集計の前提を確認するときに使う。",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "search_tasks",
            "description": "予定・作業記録を検索する。期間(dateFrom〜dateTo、両端を含む)、キーワード(タイトル・メモ・タグ名。空白区切りはすべてを含むもの)、タグ名で絞り込める。各予定の所要時間は休憩を除いた分数。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "dateFrom": date, "dateTo": date,
                    "keyword": { "type": "string" },
                    "tagName": { "type": "string" },
                    "limit": { "type": "integer", "description": "返す件数の上限(既定100、最大500)" }
                }
            }
        },
        {
            "name": "summarize_work",
            "description": "期間の作業時間を集計する。groupBy で tag(タグ別)・day(日別)・title(タイトル別)を選ぶ。キーワード・タグ名で絞り込める。合計工数の質問に使う。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "dateFrom": date, "dateTo": date,
                    "groupBy": { "type": "string", "enum": ["tag", "day", "title"] },
                    "keyword": { "type": "string" },
                    "tagName": { "type": "string" }
                },
                "required": ["dateFrom", "dateTo"]
            }
        },
        {
            "name": "month_status",
            "description": "指定月(既定は今月)のタグ別月間予算(上限・下限・実績・残り)と、あと使える時間(今日以降の営業日 × 1日の稼働時間 − 登録済みの予定。availableWorkTime.answer にそのまま使える文がある)を返す。『あとどれくらい工数を使えるか』の質問に使う。",
            "inputSchema": { "type": "object", "properties": { "month": { "type": "string", "description": "YYYY-MM" } } }
        },
        {
            "name": "get_daily_notes",
            "description": "期間(最大62日)の日次サマリーと気づきメモを返す。その日の様子や振り返りを答えるときに使う。",
            "inputSchema": { "type": "object", "properties": { "dateFrom": date, "dateTo": date }, "required": ["dateFrom", "dateTo"] }
        },
        {
            "name": "propose_create_task",
            "description": "予定の作成を提案する。実際の登録はされず、利用者が画面のカードで確定したときに登録される。終日でなければ startTime と endTime を指定する(終了が不明なら開始の1時間後)。tagName は get_context のタグから選ぶ(無ければ新しいタグとして提案される)。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "date": date, "startTime": time, "endTime": time,
                    "allDay": { "type": "boolean" },
                    "title": { "type": "string" },
                    "tagName": { "type": "string" },
                    "memo": { "type": "string" }
                },
                "required": ["date", "title"]
            }
        },
        {
            "name": "propose_update_task",
            "description": "既存の予定の変更を提案する。taskId は search_tasks で調べる。変える項目だけを指定する。実際の変更は利用者が画面のカードで確定したときに行われる。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "taskId": { "type": "string" },
                    "date": date, "startTime": time, "endTime": time,
                    "allDay": { "type": "boolean" },
                    "title": { "type": "string" },
                    "tagName": { "type": "string" },
                    "memo": { "type": "string" }
                },
                "required": ["taskId"]
            }
        },
        {
            "name": "propose_delete_task",
            "description": "既存の予定の削除を提案する。taskId は search_tasks で調べる。実際の削除は利用者が画面のカードで確定したときに行われる。",
            "inputSchema": { "type": "object", "properties": { "taskId": { "type": "string" } }, "required": ["taskId"] }
        }
    ])
}

// ── データ ───────────────────────────────────────────────────

struct Data {
    tasks: Vec<repo::TaskRow>,
    tag_names: HashMap<String, String>,
    tags: Vec<repo::Tag>,
    work: WorkSettings,
}

fn load(conn: &Connection) -> Result<Data, String> {
    let tasks = repo::tasks_list(conn).map_err(|e| e.to_string())?;
    let tags = repo::tags_list(conn).map_err(|e| e.to_string())?;
    let settings = repo::settings_get(conn).map_err(|e| e.to_string())?.unwrap_or(Value::Null);
    Ok(Data {
        tag_names: tags.iter().map(|t| (t.id.clone(), t.name.clone())).collect(),
        tags,
        tasks,
        work: WorkSettings::from_settings(&settings),
    })
}

impl Data {
    fn tag_name(&self, task: &repo::TaskRow) -> String {
        self.tag_names.get(&task.tag_id).cloned().unwrap_or_default()
    }

    fn minutes(&self, task: &repo::TaskRow) -> i64 {
        self.work.duration_minutes(task.start_time.as_deref(), task.end_time.as_deref(), task.is_all_day)
    }

    fn describe(&self, task: &repo::TaskRow) -> Value {
        let minutes = self.minutes(task);
        let weekday = calendar::parse_date(&task.date).map(calendar::weekday_jp).unwrap_or("");
        json!({
            "id": task.id,
            "date": task.date,
            "weekday": weekday,
            "startTime": task.start_time,
            "endTime": task.end_time,
            "allDay": task.is_all_day,
            "title": task.title,
            "tag": self.tag_name(task),
            "minutes": minutes,
            "duration": format_minutes(minutes),
            "memo": task.memo,
        })
    }

    /// 期間・キーワード・タグで絞り込んだ予定(日付・開始時刻順)。
    fn filter(&self, args: &Value) -> Result<Vec<&repo::TaskRow>, String> {
        let from = arg_date(args, "dateFrom")?;
        let to = arg_date(args, "dateTo")?;
        let words: Vec<&str> = arg_str(args, "keyword").map(|k| k.split_whitespace().collect()).unwrap_or_default();
        let tag = arg_str(args, "tagName");
        let mut rows: Vec<&repo::TaskRow> = self
            .tasks
            .iter()
            .filter(|t| {
                let Some(day) = calendar::parse_date(&t.date) else { return false };
                from.is_none_or(|f| day >= f) && to.is_none_or(|x| day <= x)
            })
            .filter(|t| tag.is_none_or(|name| contains_ci(&self.tag_name(t), name)))
            .filter(|t| {
                let tag_name = self.tag_name(t);
                words.iter().all(|w| contains_ci(&t.title, w) || contains_ci(&t.memo, w) || contains_ci(&tag_name, w))
            })
            .collect();
        rows.sort_by(|a, b| a.date.cmp(&b.date).then(a.start_time.cmp(&b.start_time)));
        Ok(rows)
    }
}

// ── 道具の実装 ───────────────────────────────────────────────

fn get_context(ctx: &McpContext, data: &Data) -> Value {
    json!({
        "today": ctx.today.format("%Y-%m-%d").to_string(),
        "weekday": calendar::weekday_jp(ctx.today),
        "timezone": "Asia/Tokyo",
        "workStart": data.work.work_start,
        "workEnd": data.work.work_end,
        "dailyWorkMinutes": data.work.daily_work_minutes(),
        "dailyWork": format_minutes(data.work.daily_work_minutes()),
        "isTodayBusinessDay": data.work.is_business_day(ctx.today),
        "tags": data.tags.iter().map(|t| json!({
            "name": t.name,
            "budgetMaxMinutes": t.budget_max_minutes,
            "budgetMinMinutes": t.budget_min_minutes,
        })).collect::<Vec<_>>(),
    })
}

fn search_tasks(data: &Data, args: &Value) -> Result<Value, String> {
    let rows = data.filter(args)?;
    let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as usize).unwrap_or(DEFAULT_TASK_LIMIT).clamp(1, MAX_TASK_LIMIT);
    let total: i64 = rows.iter().map(|t| data.minutes(t)).sum();
    Ok(json!({
        "count": rows.len(),
        "totalMinutes": total,
        "total": format_minutes(total),
        "truncated": rows.len() > limit,
        "tasks": rows.iter().take(limit).map(|t| data.describe(t)).collect::<Vec<_>>(),
    }))
}

fn summarize_work(data: &Data, args: &Value) -> Result<Value, String> {
    let rows = data.filter(args)?;
    let group_by = arg_str(args, "groupBy").unwrap_or("tag");
    let mut groups: BTreeMap<String, (i64, usize)> = BTreeMap::new();
    let mut total = 0;
    for t in &rows {
        let minutes = data.minutes(t);
        total += minutes;
        let key = match group_by {
            "day" => t.date.clone(),
            "title" => t.title.clone(),
            _ => Some(data.tag_name(t)).filter(|n| !n.is_empty()).unwrap_or_else(|| "タグなし".to_string()),
        };
        let entry = groups.entry(key).or_default();
        entry.0 += minutes;
        entry.1 += 1;
    }
    let mut list: Vec<(String, (i64, usize))> = groups.into_iter().collect();
    if group_by != "day" {
        list.sort_by_key(|(_, (minutes, _))| std::cmp::Reverse(*minutes));
    }
    Ok(json!({
        "groupBy": group_by,
        "count": rows.len(),
        "totalMinutes": total,
        "total": format_minutes(total),
        "groups": list.into_iter().map(|(key, (minutes, count))| json!({
            "key": key, "minutes": minutes, "duration": format_minutes(minutes), "count": count,
        })).collect::<Vec<_>>(),
    }))
}

fn month_status(ctx: &McpContext, data: &Data, args: &Value) -> Result<Value, String> {
    let (year, month) = match arg_str(args, "month") {
        Some(text) => {
            let (y, m) = text.split_once('-').ok_or("month は YYYY-MM 形式で指定してください")?;
            (y.parse::<i32>().map_err(|e| e.to_string())?, m.parse::<u32>().map_err(|e| e.to_string())?)
        }
        None => (ctx.today.year(), ctx.today.month()),
    };
    let (first, last) = calendar::month_bounds(year, month).ok_or("month が不正です")?;
    let in_month = |t: &&repo::TaskRow| calendar::parse_date(&t.date).is_some_and(|d| d >= first && d <= last);

    let mut used_by_tag: HashMap<&str, i64> = HashMap::new();
    let mut minutes_by_day: HashMap<NaiveDate, i64> = HashMap::new();
    for t in data.tasks.iter().filter(in_month) {
        let minutes = data.minutes(t);
        *used_by_tag.entry(t.tag_id.as_str()).or_default() += minutes;
        if let Some(day) = calendar::parse_date(&t.date) {
            *minutes_by_day.entry(day).or_default() += minutes;
        }
    }
    let budgets: Vec<Value> = data
        .tags
        .iter()
        .filter(|t| t.budget_max_minutes.is_some_and(|m| m > 0))
        .map(|t| {
            let max = t.budget_max_minutes.unwrap_or(0);
            let used = used_by_tag.get(t.id.as_str()).copied().unwrap_or(0);
            let state = if max >= used { format!("残り{}", format_minutes(max - used)) } else { format!("{}超過", format_minutes(used - max)) };
            json!({
                "summary": format!("{}: 今月の実績{} / 上限{} → {state}", t.name, format_minutes(used), format_minutes(max)),
                "tag": t.name,
                "usedMinutes": used, "used": format_minutes(used),
                "maxMinutes": max, "max": format_minutes(max),
                "minMinutes": t.budget_min_minutes, "min": t.budget_min_minutes.map(format_minutes),
                "remainingMinutes": max - used,
                "remaining": if max >= used { format!("残り{}", format_minutes(max - used)) } else { format!("{}超過", format_minutes(used - max)) },
            })
        })
        .collect();

    let daily = data.work.daily_work_minutes();
    let start = if ctx.today > first { ctx.today } else { first };
    let (mut total_days, mut scheduled) = (0, 0);
    let mut remaining_dates = Vec::new();
    let mut day = first;
    while day <= last {
        if data.work.is_business_day(day) {
            total_days += 1;
            if day >= start {
                remaining_dates.push(format!("{}({})", day.format("%m/%d"), calendar::weekday_jp(day)));
                scheduled += daily.min(minutes_by_day.get(&day).copied().unwrap_or(0));
            }
        }
        day += Duration::days(1);
    }
    let remaining_days = remaining_dates.len() as i64;
    let remaining_work = remaining_days * daily;
    let available = (remaining_work - scheduled).max(0);
    let worked: i64 = minutes_by_day.iter().filter(|(d, _)| **d < ctx.today).map(|(_, m)| m).sum();
    Ok(json!({
        "month": format!("{year:04}-{month:02}"),
        "availableWorkTime": {
            // 「あとどれくらい使えるか」の答え。読み違えないよう、計算の内訳を文にして先頭に置く。
            "answer": format!(
                "あと使える時間は{}です(残り営業日{}日 × 1日{} = {}、そのうち登録済みの予定{}を除く)。",
                format_minutes(available), remaining_days, format_minutes(daily), format_minutes(remaining_work), format_minutes(scheduled),
            ),
            "availableMinutes": available,
            "remainingBusinessDates": remaining_dates,
            "remainingBusinessDays": remaining_days,
            "businessDaysInMonth": total_days,
            "dailyWorkMinutes": daily,
            "remainingWorkMinutes": remaining_work,
            "alreadyScheduledMinutes": scheduled,
            "workedBeforeTodayMinutes": worked,
            "workedBeforeToday": format_minutes(worked),
        },
        "budgets": budgets,
        "budgetNote": "予算の実績は月内の予定すべて(今日以降に登録済みの予定を含む)。",
    }))
}

fn get_daily_notes(ctx: &McpContext, args: &Value) -> Result<Value, String> {
    let from = arg_date(args, "dateFrom")?.ok_or("dateFrom は必須です")?;
    let to = arg_date(args, "dateTo")?.ok_or("dateTo は必須です")?;
    if to < from || (to - from).num_days() > MAX_NOTE_DAYS {
        return Err(format!("期間は{MAX_NOTE_DAYS}日以内で指定してください"));
    }
    let mut days = Vec::new();
    let mut day = from;
    while day <= to {
        let key = day.format("%Y-%m-%d").to_string();
        let summary = repo::ai_memory_get(ctx.conn, "summary", &key).map_err(|e| e.to_string())?;
        let notes = repo::ai_memory_get(ctx.conn, "notes", &key).map_err(|e| e.to_string())?;
        let summary_text = summary.as_ref().and_then(|s| s.get("summaryText")).and_then(|v| v.as_str()).unwrap_or("");
        let note_texts: Vec<&str> = notes.as_ref().and_then(|n| n.as_array())
            .map(|a| a.iter().filter_map(|n| n.get("text").and_then(|t| t.as_str())).collect())
            .unwrap_or_default();
        if !summary_text.is_empty() || !note_texts.is_empty() {
            days.push(json!({ "date": key, "summary": summary_text, "notes": note_texts }));
        }
        day += Duration::days(1);
    }
    Ok(json!({ "days": days }))
}

/// 提案の予定内容を検証して正規化する。
fn normalized_task(args: &Value, base: Option<&Map<String, Value>>) -> Result<Map<String, Value>, String> {
    let pick = |key: &str| -> Option<Value> {
        args.get(key).filter(|v| !v.is_null()).cloned().or_else(|| base.and_then(|b| b.get(key)).cloned())
    };
    let text = |key: &str| pick(key).and_then(|v| v.as_str().map(|s| s.trim().to_string())).unwrap_or_default();
    let date = text("date");
    calendar::parse_date(&date).ok_or_else(|| format!("date は YYYY-MM-DD 形式で指定してください: {date}"))?;
    let title = text("title");
    if title.is_empty() {
        return Err("title は必須です".to_string());
    }
    let all_day = pick("allDay").and_then(|v| v.as_bool()).unwrap_or(false);
    let (start, end) = if all_day {
        (String::new(), String::new())
    } else {
        let start = text("startTime");
        let s = calendar::time_to_minutes(&start).ok_or("終日でない予定には startTime(HH:MM)が必要です")?;
        let end = match text("endTime") {
            e if e.is_empty() => format!("{:02}:{:02}", ((s + 60).min(24 * 60)) / 60, ((s + 60).min(24 * 60)) % 60),
            e => e,
        };
        let e = calendar::time_to_minutes(&end).ok_or("endTime は HH:MM 形式で指定してください")?;
        if e <= s {
            return Err("endTime は startTime より後にしてください".to_string());
        }
        (format!("{:02}:{:02}", s / 60, s % 60), format!("{:02}:{:02}", e / 60, e % 60))
    };
    let mut task = Map::new();
    task.insert("date".into(), json!(date));
    task.insert("startTime".into(), json!(start));
    task.insert("endTime".into(), json!(end));
    task.insert("allDay".into(), json!(all_day));
    task.insert("title".into(), json!(title));
    task.insert("tagName".into(), json!(text("tagName")));
    task.insert("memo".into(), json!(text("memo")));
    Ok(task)
}

fn task_as_map(data: &Data, task: &repo::TaskRow) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("date".into(), json!(task.date));
    m.insert("startTime".into(), json!(task.start_time.clone().unwrap_or_default()));
    m.insert("endTime".into(), json!(task.end_time.clone().unwrap_or_default()));
    m.insert("allDay".into(), json!(task.is_all_day));
    m.insert("title".into(), json!(task.title));
    m.insert("tagName".into(), json!(data.tag_name(task)));
    m.insert("memo".into(), json!(task.memo));
    m
}

fn add_proposal(ctx: &McpContext, mut proposal: Map<String, Value>) -> Result<Value, String> {
    let id = format!("p-{:016x}", rand::random::<u64>());
    proposal.insert("id".into(), json!(id));
    let mut store = ctx.proposals.lock().map_err(|_| "proposal store poisoned".to_string())?;
    let list = store.get_mut(ctx.session).ok_or("このチャットのセッションは終了しています")?;
    list.push(Value::Object(proposal));
    Ok(json!({
        "proposalId": id,
        "status": "pending_user_confirmation",
        "message": "提案を画面に表示しました。利用者がカードの［確定］を押すまで反映されません。「登録しました」「削除しました」とは言わず、確認を促してください。",
    }))
}

fn tag_exists(data: &Data, name: &str) -> bool {
    name.is_empty() || data.tags.iter().any(|t| t.name.eq_ignore_ascii_case(name))
}

fn propose_create(ctx: &McpContext, data: &Data, args: &Value) -> Result<Value, String> {
    let task = normalized_task(args, None)?;
    let tag = task.get("tagName").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut p = Map::new();
    p.insert("action".into(), json!("create"));
    p.insert("newTag".into(), json!(!tag_exists(data, &tag)));
    p.insert("task".into(), Value::Object(task));
    add_proposal(ctx, p)
}

fn find_task<'d>(data: &'d Data, args: &Value) -> Result<&'d repo::TaskRow, String> {
    let id = arg_str(args, "taskId").ok_or("taskId は必須です(search_tasks で調べてください)")?;
    data.tasks.iter().find(|t| t.id == id).ok_or_else(|| format!("taskId {id} の予定は見つかりません"))
}

fn propose_update(ctx: &McpContext, data: &Data, args: &Value) -> Result<Value, String> {
    let target = find_task(data, args)?;
    let before = task_as_map(data, target);
    let after = normalized_task(args, Some(&before))?;
    if after == before {
        return Err("変更する項目がありません".to_string());
    }
    let tag = after.get("tagName").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut p = Map::new();
    p.insert("action".into(), json!("update"));
    p.insert("taskId".into(), json!(target.id));
    p.insert("newTag".into(), json!(!tag_exists(data, &tag)));
    p.insert("before".into(), Value::Object(before));
    p.insert("expectedUpdatedAt".into(), json!(target.updated_at));
    p.insert("task".into(), Value::Object(after));
    add_proposal(ctx, p)
}

fn propose_delete(ctx: &McpContext, data: &Data, args: &Value) -> Result<Value, String> {
    let target = find_task(data, args)?;
    let mut p = Map::new();
    p.insert("action".into(), json!("delete"));
    p.insert("taskId".into(), json!(target.id));
    p.insert("expectedUpdatedAt".into(), json!(target.updated_at));
    p.insert("task".into(), Value::Object(task_as_map(data, target)));
    add_proposal(ctx, p)
}

fn call_tool(ctx: &McpContext, name: &str, args: &Value) -> Result<Value, String> {
    let data = load(ctx.conn)?;
    match name {
        "get_context" => Ok(get_context(ctx, &data)),
        "search_tasks" => search_tasks(&data, args),
        "summarize_work" => summarize_work(&data, args),
        "month_status" => month_status(ctx, &data, args),
        "get_daily_notes" => get_daily_notes(ctx, args),
        "propose_create_task" => propose_create(ctx, &data, args),
        "propose_update_task" => propose_update(ctx, &data, args),
        "propose_delete_task" => propose_delete(ctx, &data, args),
        _ => Err(format!("unknown tool: {name}")),
    }
}

// ── JSON-RPC ─────────────────────────────────────────────────

fn rpc_result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// JSON-RPC のメッセージ1件を処理する。通知(id なし)には応答しない(None)。
pub fn handle_message(ctx: &McpContext, message: &Value) -> Option<Value> {
    let id = message.get("id")?.clone();
    let method = message.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    Some(match method {
        "initialize" => rpc_result(&id, json!({
            "protocolVersion": params.get("protocolVersion").and_then(|v| v.as_str()).unwrap_or(DEFAULT_PROTOCOL_VERSION),
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
            "instructions": "TaskCalendar+ の予定・作業記録を調べる道具と、予定の作成・変更・削除を提案する道具です。",
        })),
        "ping" => rpc_result(&id, json!({})),
        "tools/list" => rpc_result(&id, json!({ "tools": tool_definitions() })),
        "tools/call" => {
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            match call_tool(ctx, name, &args) {
                Ok(value) => rpc_result(&id, json!({
                    "content": [{ "type": "text", "text": value.to_string() }],
                    "structuredContent": value,
                    "isError": false,
                })),
                Err(message) => rpc_result(&id, json!({
                    "content": [{ "type": "text", "text": format!("エラー: {message}") }],
                    "isError": true,
                })),
            }
        }
        _ => rpc_error(&id, -32601, &format!("method not found: {method}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (Connection, ProposalStore) {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn, "2026-09").unwrap();
        conn.execute_batch(
            "INSERT INTO tags (id, name, color, budget_max_minutes, budget_min_minutes) VALUES ('g1','会議','#111111',600,NULL),('g2','開発','#222222',300,120),('g3','学習','#333333',NULL,NULL);
             INSERT INTO tasks (id, title, date, is_all_day, start_time, end_time, tag_id, memo, created_at, updated_at) VALUES
              ('1','定例','2026-09-01',0,'10:00','11:00','g1','','x','x'),
              ('2','設計レビュー','2026-09-15',0,'09:00','12:00','g2','API設計','x','x'),
              ('3','定例','2026-09-15',0,'13:00','14:30','g1','','x','x'),
              ('4','設計レビュー','2026-09-18',0,'11:00','15:00','g2','','x','x'),
              ('5','定例','2026-09-25',0,'09:00','10:00','g1','','x','x');",
        )
        .unwrap();
        let store: ProposalStore = Arc::new(Mutex::new(HashMap::new()));
        store.lock().unwrap().insert("s1".into(), vec![]);
        (conn, store)
    }

    fn call(conn: &Connection, store: &ProposalStore, name: &str, args: Value) -> Value {
        let ctx = McpContext { conn, today: NaiveDate::from_ymd_opt(2026, 9, 24).unwrap(), session: "s1", proposals: store };
        let res = handle_message(&ctx, &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": args } })).unwrap();
        res["result"].clone()
    }

    #[test]
    fn initialize_list_and_notifications() {
        let (conn, store) = setup();
        let ctx = McpContext { conn: &conn, today: NaiveDate::from_ymd_opt(2026, 9, 24).unwrap(), session: "s1", proposals: &store };
        let init = handle_message(&ctx, &json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } })).unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert!(handle_message(&ctx, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
        let list = handle_message(&ctx, &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).unwrap();
        assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 8);
        let unknown = handle_message(&ctx, &json!({ "jsonrpc": "2.0", "id": 3, "method": "foo" })).unwrap();
        assert_eq!(unknown["error"]["code"], -32601);
    }

    #[test]
    fn search_and_summarize_use_break_aware_minutes() {
        let (conn, store) = setup();
        let r = call(&conn, &store, "search_tasks", json!({ "dateFrom": "2026-09-15", "dateTo": "2026-09-15" }));
        assert_eq!(r["structuredContent"]["count"], 2);
        assert_eq!(r["structuredContent"]["totalMinutes"], 270);
        let s = call(&conn, &store, "summarize_work", json!({ "dateFrom": "2026-09-01", "dateTo": "2026-09-30", "keyword": "設計レビュー" }));
        // 9/15 180分 + 9/18 11:00-15:00 から昼休み60分を除いた180分
        assert_eq!(s["structuredContent"]["totalMinutes"], 360);
        assert_eq!(s["structuredContent"]["total"], "6時間");
        assert_eq!(s["structuredContent"]["groups"][0]["key"], "開発");
    }

    #[test]
    fn month_status_budgets_and_capacity() {
        let (conn, store) = setup();
        let r = call(&conn, &store, "month_status", json!({}))["structuredContent"].clone();
        assert_eq!(r["month"], "2026-09");
        assert_eq!(r["budgets"][0]["tag"], "会議");
        assert_eq!(r["budgets"][0]["remainingMinutes"], 600 - 210);
        assert_eq!(r["budgets"][1]["remaining"], "1時間超過");
        // 9/24以降の営業日: 24,25,28,29,30 = 5日(21〜23は祝日)
        let a = &r["availableWorkTime"];
        assert_eq!(a["businessDaysInMonth"], 19);
        assert_eq!(a["remainingBusinessDays"], 5);
        assert_eq!(a["remainingBusinessDates"], json!(["09/24(木)", "09/25(金)", "09/28(月)", "09/29(火)", "09/30(水)"]));
        assert_eq!(a["remainingWorkMinutes"], 2400);
        assert_eq!(a["alreadyScheduledMinutes"], 60);
        assert_eq!(a["availableMinutes"], 2340);
        assert_eq!(a["answer"], "あと使える時間は39時間です(残り営業日5日 × 1日8時間 = 40時間、そのうち登録済みの予定1時間を除く)。");
        assert_eq!(r["budgets"][0]["summary"], "会議: 今月の実績3時間30分 / 上限10時間 → 残り6時間30分");
    }

    #[test]
    fn proposals_are_recorded_but_not_written() {
        let (conn, store) = setup();
        let r = call(&conn, &store, "propose_create_task", json!({ "date": "2026-09-25", "startTime": "15:00", "title": "設計会議", "tagName": "会議" }));
        assert_eq!(r["isError"], false);
        let del = call(&conn, &store, "propose_delete_task", json!({ "taskId": "5" }));
        assert_eq!(del["isError"], false);
        let upd = call(&conn, &store, "propose_update_task", json!({ "taskId": "1", "startTime": "10:30", "endTime": "11:30" }));
        assert_eq!(upd["isError"], false);
        let list = store.lock().unwrap().get("s1").cloned().unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0]["task"]["endTime"], "16:00", "終了が無ければ1時間後");
        assert_eq!(list[0]["newTag"], false);
        assert_eq!(list[1]["action"], "delete");
        assert_eq!(list[2]["before"]["startTime"], "10:00");
        assert_eq!(list[2]["task"]["startTime"], "10:30");
        let revision: String = conn.query_row("SELECT updated_at FROM tasks WHERE id='1'", [], |r| r.get(0)).unwrap();
        assert_eq!(list[2]["expectedUpdatedAt"], revision);
        assert!(list[1]["expectedUpdatedAt"].as_str().is_some_and(|s| !s.is_empty()));
        // DBは変わっていない
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 5);
    }

    #[test]
    fn invalid_proposals_are_errors() {
        let (conn, store) = setup();
        let r = call(&conn, &store, "propose_create_task", json!({ "date": "9/25", "title": "x" }));
        assert_eq!(r["isError"], true);
        let r = call(&conn, &store, "propose_create_task", json!({ "date": "2026-09-25", "startTime": "15:00", "endTime": "14:00", "title": "x" }));
        assert_eq!(r["isError"], true);
        let r = call(&conn, &store, "propose_update_task", json!({ "taskId": "nope", "title": "x" }));
        assert_eq!(r["isError"], true);
        let ended = McpContext { conn: &conn, today: NaiveDate::from_ymd_opt(2026, 9, 24).unwrap(), session: "gone", proposals: &store };
        let res = handle_message(&ended, &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "propose_delete_task", "arguments": { "taskId": "1" } } })).unwrap();
        assert_eq!(res["result"]["isError"], true, "終了したセッションには提案できない");
    }
}
