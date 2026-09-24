//! DBアクセス層。
//!
//! タスク・タグ・設定・AIメモリ・天気キャッシュの読み書きを提供する。
//! 繰り返し予定の展開は画面側で行い、ここでは行わない。

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

fn default_tag_id() -> String {
    String::new()
}

fn default_recurrence() -> Value {
    json!({ "type": "none" })
}

// ---------------------------------------------------------------------------
// tasks (recurrence展開もid自動生成も行わない単純なpass-through)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskRow {
    pub id: String,
    pub title: String,
    pub date: String,
    pub is_all_day: bool,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub tag_id: String,
    pub recurrence: Value,
    pub memo: String,
    pub outlook_occurrence_key: Option<String>,
    pub outlook_series_id: Option<String>,
    pub meeting_url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskInsertInput {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    pub date: String,
    #[serde(default)]
    pub is_all_day: bool,
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub end_time: Option<String>,
    #[serde(default)]
    pub tag_id: Option<String>,
    #[serde(default)]
    pub recurrence: Option<Value>,
    #[serde(default)]
    pub memo: Option<String>,
    #[serde(default)]
    pub outlook_occurrence_key: Option<String>,
    #[serde(default)]
    pub outlook_series_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdateInput {
    // updateは「送られてきた値で丸ごと置き換える」挙動
    // (title/date/memoは未指定または空ならそのまま空文字になる。既存値へは
    // フォールバックしない)。
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub is_all_day: bool,
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub end_time: Option<String>,
    #[serde(default)]
    pub tag_id: Option<String>,
    #[serde(default)]
    pub recurrence: Option<Value>,
    #[serde(default)]
    pub memo: Option<String>,
}

fn row_to_task(row: &rusqlite::Row) -> rusqlite::Result<TaskRow> {
    let recurrence_text: String = row.get("recurrence")?;
    let is_all_day_int: i64 = row.get("is_all_day")?;
    Ok(TaskRow {
        id: row.get("id")?,
        title: row.get("title")?,
        date: row.get("date")?,
        is_all_day: is_all_day_int != 0,
        start_time: row.get("start_time")?,
        end_time: row.get("end_time")?,
        tag_id: row.get("tag_id")?,
        recurrence: serde_json::from_str(&recurrence_text).unwrap_or_else(|_| default_recurrence()),
        memo: row.get("memo")?,
        outlook_occurrence_key: row.get("outlook_occurrence_key")?,
        outlook_series_id: row.get("outlook_series_id")?,
        meeting_url: row.get("meeting_url")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn tasks_list(conn: &Connection) -> rusqlite::Result<Vec<TaskRow>> {
    conn.prepare("SELECT * FROM tasks ORDER BY date, start_time")?
        .query_map([], row_to_task)?
        .collect()
}

fn tasks_get(conn: &Connection, id: &str) -> rusqlite::Result<Option<TaskRow>> {
    conn.query_row("SELECT * FROM tasks WHERE id = ?1", params![id], row_to_task)
        .optional()
}

pub fn tasks_insert(conn: &Connection, input: TaskInsertInput) -> rusqlite::Result<TaskRow> {
    let id = input.id.clone();
    let now = chrono::Utc::now().to_rfc3339();
    let recurrence = input.recurrence.unwrap_or_else(default_recurrence);
    conn.execute(
        "INSERT INTO tasks (id, title, date, is_all_day, start_time, end_time, tag_id, recurrence, memo, outlook_occurrence_key, outlook_series_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            input.id,
            input.title.filter(|t| !t.is_empty()).unwrap_or_default(),
            input.date,
            input.is_all_day as i64,
            input.start_time,
            input.end_time,
            // フィールド自体が無い場合は「タグなし」(空文字列)として保存する。
            // 既定タグは存在しないため、特定のタグIDへはフォールバックしない。
            input.tag_id.unwrap_or_else(default_tag_id),
            recurrence.to_string(),
            input.memo.filter(|m| !m.is_empty()).unwrap_or_default(),
            input.outlook_occurrence_key.filter(|k| !k.is_empty()),
            input.outlook_series_id.filter(|s| !s.is_empty()),
            input.created_at.unwrap_or_else(|| now.clone()),
            input.updated_at.unwrap_or(now),
        ],
    )?;
    Ok(tasks_get(conn, &id)?.expect("just inserted"))
}

/// 既存の単発予定の更新と、繰り返し分の追加を一度に確定する。
/// 途中で追加に失敗した場合、元の予定の変更も含めて取り消す。
pub enum RecurringTaskUpdateResult {
    Updated(Vec<TaskRow>),
    NotFound,
    Conflict,
}

pub fn tasks_update_with_occurrences(
    conn: &Connection,
    id: &str,
    expected_updated_at: &str,
    task: TaskUpdateInput,
    occurrences: Vec<TaskInsertInput>,
) -> rusqlite::Result<RecurringTaskUpdateResult> {
    let tx = conn.unchecked_transaction()?;
    let Some(current) = tasks_get(&tx, id)? else { return Ok(RecurringTaskUpdateResult::NotFound); };
    if current.updated_at != expected_updated_at {
        return Ok(RecurringTaskUpdateResult::Conflict);
    }
    if let Some(group) = current.recurrence.get("groupId").and_then(Value::as_str)
        && tasks_list(&tx)?.iter().any(|row| row.id != id && row.recurrence.get("groupId").and_then(Value::as_str) == Some(group))
    {
        return Ok(RecurringTaskUpdateResult::Conflict);
    }
    let updated = tasks_update(&tx, id, task)?.expect("task checked in transaction");
    let mut saved = vec![updated];
    for occurrence in occurrences {
        saved.push(tasks_insert(&tx, occurrence)?);
    }
    tx.commit()?;
    Ok(RecurringTaskUpdateResult::Updated(saved))
}

pub fn tasks_update(
    conn: &Connection,
    id: &str,
    input: TaskUpdateInput,
) -> rusqlite::Result<Option<TaskRow>> {
    if tasks_get(conn, id)?.is_none() {
        return Ok(None);
    }
    let now = chrono::Utc::now().to_rfc3339();
    let recurrence = input.recurrence.unwrap_or_else(default_recurrence);
    conn.execute(
        "UPDATE tasks SET title=?1, date=?2, is_all_day=?3, start_time=?4, end_time=?5,
            tag_id=?6, recurrence=?7, memo=?8, updated_at=?9
         WHERE id=?10",
        params![
            input.title.unwrap_or_default(),
            input.date.unwrap_or_default(),
            input.is_all_day as i64,
            input.start_time,
            input.end_time,
            // insertと同様、空文字列(タグなし選択)を既定タグへ戻さない。
            input.tag_id.unwrap_or_else(default_tag_id),
            recurrence.to_string(),
            input.memo.unwrap_or_default(),
            now,
            id,
        ],
    )?;
    tasks_get(conn, id)
}

pub fn tasks_remove(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
    /// 月間予定工数の下限・上限(分)。未設定はNone。
    /// 下限は上限が設定されている場合のみ意味を持つ(下限のみ設定は無し、3パターン:
    /// 未設定/上限のみ/下限+上限)。
    #[serde(rename = "budgetMinMinutes", skip_serializing_if = "Option::is_none")]
    pub budget_min_minutes: Option<i64>,
    #[serde(rename = "budgetMaxMinutes", skip_serializing_if = "Option::is_none")]
    pub budget_max_minutes: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct TagInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub color: String,
    #[serde(default, rename = "budgetMinMinutes")]
    pub budget_min_minutes: Option<i64>,
    #[serde(default, rename = "budgetMaxMinutes")]
    pub budget_max_minutes: Option<i64>,
}

pub fn tags_list(conn: &Connection) -> rusqlite::Result<Vec<Tag>> {
    conn.prepare("SELECT id, name, color, budget_min_minutes, budget_max_minutes FROM tags")?
        .query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                budget_min_minutes: row.get(3)?,
                budget_max_minutes: row.get(4)?,
            })
        })?
        .collect()
}

pub fn tags_create(conn: &Connection, input: TagInput) -> rusqlite::Result<Tag> {
    // 時刻由来のIDだと同じミリ秒に作ったタグ同士が重複するため、乱数で作る。
    let id = input.id.unwrap_or_else(|| format!("tag-{}", random_hex(16)));
    conn.execute(
        "INSERT INTO tags (id, name, color, budget_min_minutes, budget_max_minutes) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, input.name, input.color, input.budget_min_minutes, input.budget_max_minutes],
    )?;
    Ok(Tag {
        id,
        name: input.name,
        color: input.color,
        budget_min_minutes: input.budget_min_minutes,
        budget_max_minutes: input.budget_max_minutes,
    })
}

/// DBの実値を再取得せず入力をそのまま返す
/// (存在しないidを指定してもUPDATE文が0行影響のまま成功応答になる)。
pub fn tags_update(conn: &Connection, id: &str, input: TagInput) -> rusqlite::Result<Tag> {
    conn.execute(
        "UPDATE tags SET name=?1, color=?2, budget_min_minutes=?3, budget_max_minutes=?4 WHERE id=?5",
        params![input.name, input.color, input.budget_min_minutes, input.budget_max_minutes, id],
    )?;
    Ok(Tag {
        id: id.to_string(),
        name: input.name,
        color: input.color,
        budget_min_minutes: input.budget_min_minutes,
        budget_max_minutes: input.budget_max_minutes,
    })
}

/// 参照タスクを`fallback_id`へ再割当してからタグを削除する(F-TAG-008)。
/// 設定内の参照(月ごとのタグ順`monthTagOrders`、Outlook取り込み先`outlookSyncTagId`)からも取り除く。
pub fn tags_remove(conn: &Connection, id: &str, fallback_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE tasks SET tag_id = ?1 WHERE tag_id = ?2",
        params![fallback_id, id],
    )?;
    conn.execute("DELETE FROM tags WHERE id = ?1", params![id])?;

    if let Some(mut settings) = settings_get(conn)?
        && let Some(obj) = settings.as_object_mut()
    {
        let mut changed = false;
        if let Some(orders) = obj.get_mut("monthTagOrders").and_then(|v| v.as_object_mut()) {
            for ids in orders.values_mut().filter_map(|v| v.as_array_mut()) {
                let before = ids.len();
                ids.retain(|v| v.as_str() != Some(id));
                changed |= ids.len() != before;
            }
        }
        if obj.get("outlookSyncTagId").and_then(|v| v.as_str()) == Some(id) {
            obj.insert("outlookSyncTagId".to_string(), Value::String(String::new()));
            changed = true;
        }
        if changed {
            settings_set(conn, &settings)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// settings (key='main'の単一行に、まるごとJSONを保存する)
// ---------------------------------------------------------------------------

pub fn settings_get(conn: &Connection) -> rusqlite::Result<Option<Value>> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = 'main'", [], |row| row.get(0))
        .optional()?;
    Ok(raw.map(|text| serde_json::from_str(&text).unwrap_or(Value::Null)))
}

pub fn settings_set(conn: &Connection, value: &Value) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('main', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![value.to_string()],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// ai_memory (kind ∈ summary|notes|chat)
// ---------------------------------------------------------------------------

pub const AI_MEMORY_KINDS: [&str; 3] = ["summary", "notes", "chat"];

pub fn is_valid_ai_memory_kind(kind: &str) -> bool {
    AI_MEMORY_KINDS.contains(&kind)
}

pub fn ai_memory_get(conn: &Connection, kind: &str, date: &str) -> rusqlite::Result<Option<Value>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM ai_memory WHERE kind = ?1 AND date = ?2",
            params![kind, date],
            |row| row.get(0),
        )
        .optional()?;
    Ok(raw.map(|text| serde_json::from_str(&text).unwrap_or(Value::Null)))
}

pub fn ai_memory_set(conn: &Connection, kind: &str, date: &str, value: &Value) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO ai_memory (kind, date, value) VALUES (?1, ?2, ?3)
         ON CONFLICT(kind, date) DO UPDATE SET value = excluded.value",
        params![kind, date, value.to_string()],
    )?;
    Ok(())
}

pub fn ai_memory_remove(conn: &Connection, kind: &str, date: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM ai_memory WHERE kind = ?1 AND date = ?2",
        params![kind, date],
    )?;
    Ok(())
}

pub fn ai_memory_list_by_kind(conn: &Connection, kind: &str) -> rusqlite::Result<Map<String, Value>> {
    let mut out = Map::new();
    let mut stmt = conn.prepare("SELECT date, value FROM ai_memory WHERE kind = ?1")?;
    let rows = stmt.query_map(params![kind], |row| {
        let date: String = row.get(0)?;
        let value: String = row.get(1)?;
        Ok((date, value))
    })?;
    for row in rows {
        let (date, value) = row?;
        out.insert(date, serde_json::from_str(&value).unwrap_or(Value::Null));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// weather_cache (地点ごとの日別キャッシュ)
// ---------------------------------------------------------------------------

pub fn weather_cache_list_by_location(
    conn: &Connection,
    location_key: &str,
) -> rusqlite::Result<Map<String, Value>> {
    let mut out = Map::new();
    let mut stmt = conn.prepare("SELECT date, value FROM weather_cache WHERE location_key = ?1")?;
    let rows = stmt.query_map(params![location_key], |row| {
        let date: String = row.get(0)?;
        let value: String = row.get(1)?;
        Ok((date, value))
    })?;
    for row in rows {
        let (date, value) = row?;
        out.insert(date, serde_json::from_str(&value).unwrap_or(Value::Null));
    }
    Ok(out)
}

pub fn weather_cache_set_many(
    conn: &Connection,
    location_key: &str,
    records: &Map<String, Value>,
) -> rusqlite::Result<()> {
    for (date, value) in records {
        conn.execute(
            "INSERT INTO weather_cache (location_key, date, value) VALUES (?1, ?2, ?3)
             ON CONFLICT(location_key, date) DO UPDATE SET value = excluded.value",
            params![location_key, date, value.to_string()],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 全データのバックアップ/復元(タスク・タグ・設定・日次サマリー/メモ/会話)
// 天気キャッシュは取り直せるため含めない。
// ---------------------------------------------------------------------------

pub const BACKUP_FORMAT: &str = "taskcalendar-plus-backup";
pub const BACKUP_VERSION: u64 = 1;

pub fn backup_export(conn: &Connection) -> rusqlite::Result<Value> {
    let mut ai_memory = Map::new();
    for kind in AI_MEMORY_KINDS {
        ai_memory.insert(kind.to_string(), Value::Object(ai_memory_list_by_kind(conn, kind)?));
    }
    Ok(json!({
        "format": BACKUP_FORMAT,
        "version": BACKUP_VERSION,
        "exportedAt": chrono::Utc::now().to_rfc3339(),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "tasks": tasks_list(conn)?,
        "tags": tags_list(conn)?,
        "settings": settings_get(conn)?.unwrap_or_else(|| json!({})),
        "aiMemory": ai_memory,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupTask {
    id: String,
    #[serde(default)]
    title: String,
    date: String,
    #[serde(default)]
    is_all_day: bool,
    #[serde(default)]
    start_time: Option<String>,
    #[serde(default)]
    end_time: Option<String>,
    #[serde(default)]
    tag_id: String,
    #[serde(default = "default_recurrence")]
    recurrence: Value,
    #[serde(default)]
    memo: String,
    #[serde(default)]
    outlook_occurrence_key: Option<String>,
    #[serde(default)]
    outlook_series_id: Option<String>,
    #[serde(default)]
    meeting_url: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct RestoreCounts {
    pub tasks: usize,
    pub tags: usize,
    #[serde(rename = "aiMemory")]
    pub ai_memory: usize,
}

#[derive(Debug)]
pub enum RestoreError {
    /// バックアップファイルとして読めない(利用者向けの日本語メッセージ)。
    Invalid(String),
    Db(rusqlite::Error),
}

impl From<rusqlite::Error> for RestoreError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Db(err)
    }
}

/// バックアップで全データを置き換える。途中で失敗した場合は何も変更しない(トランザクション)。
pub fn backup_restore(conn: &Connection, data: &Value) -> Result<RestoreCounts, RestoreError> {
    let invalid = |msg: &str| RestoreError::Invalid(msg.to_string());
    if data.get("format").and_then(|v| v.as_str()) != Some(BACKUP_FORMAT) {
        return Err(invalid("TaskCalendar+ のバックアップファイルではありません。"));
    }
    if data.get("version").and_then(|v| v.as_u64()) != Some(BACKUP_VERSION) {
        return Err(invalid("対応していないバックアップのバージョンです。"));
    }
    let tasks: Vec<BackupTask> = serde_json::from_value(data.get("tasks").cloned().unwrap_or(json!([])))
        .map_err(|e| RestoreError::Invalid(format!("タスクのデータが不正です: {e}")))?;
    let tags: Vec<Tag> = serde_json::from_value(data.get("tags").cloned().unwrap_or(json!([])))
        .map_err(|e| RestoreError::Invalid(format!("タグのデータが不正です: {e}")))?;
    let settings = data.get("settings").cloned().unwrap_or(json!({}));
    if !settings.is_object() {
        return Err(invalid("設定のデータが不正です。"));
    }
    let ai_memory = data.get("aiMemory").and_then(|v| v.as_object()).cloned().unwrap_or_default();

    let tx = conn.unchecked_transaction()?;
    tx.execute_batch("DELETE FROM tasks; DELETE FROM tags; DELETE FROM settings; DELETE FROM ai_memory;")?;
    for task in &tasks {
        tx.execute(
            "INSERT INTO tasks (id, title, date, is_all_day, start_time, end_time, tag_id, recurrence, memo, outlook_occurrence_key, outlook_series_id, meeting_url, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                task.id,
                task.title,
                task.date,
                task.is_all_day as i64,
                task.start_time,
                task.end_time,
                task.tag_id,
                task.recurrence.to_string(),
                task.memo,
                task.outlook_occurrence_key,
                task.outlook_series_id,
                task.meeting_url,
                task.created_at,
                task.updated_at,
            ],
        )?;
    }
    for tag in &tags {
        tx.execute(
            "INSERT INTO tags (id, name, color, budget_min_minutes, budget_max_minutes) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![tag.id, tag.name, tag.color, tag.budget_min_minutes, tag.budget_max_minutes],
        )?;
    }
    settings_set(&tx, &settings)?;
    let mut ai_memory_count = 0;
    for (kind, items) in &ai_memory {
        if !is_valid_ai_memory_kind(kind) {
            continue;
        }
        for (date, value) in items.as_object().into_iter().flatten() {
            ai_memory_set(&tx, kind, date, value)?;
            ai_memory_count += 1;
        }
    }
    tx.commit()?;
    Ok(RestoreCounts { tasks: tasks.len(), tags: tags.len(), ai_memory: ai_memory_count })
}

// ---------------------------------------------------------------------------
// Outlook auto-sync
//
// Outlookから取得した予定とDBのタスクを突き合わせ、dedup・更新・
// 新規挿入・削除を行う。
// ---------------------------------------------------------------------------

use crate::outlook::OutlookEvent;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Serialize)]
pub struct AutoSyncResult {
    pub count: usize,
    pub added: usize,
    pub skipped: usize,
    pub deleted: usize,
    pub updated: usize,
}

struct ExistingRow {
    id: String,
    signature: String,
    key: String,
    series_id: String,
    meeting_url: Option<String>,
}

/// 重複判定用のシグネチャ(タイトル・日付・開始/終了時刻・メモ)。終日予定は時刻を`ALLDAY`とする。
fn signature(title: &str, date: &str, is_all_day: bool, start_time: Option<&str>, end_time: Option<&str>, memo: &str) -> String {
    let start_sig = if is_all_day { "ALLDAY".to_string() } else { start_time.unwrap_or("").trim().to_string() };
    let end_sig = if is_all_day { "ALLDAY".to_string() } else { end_time.unwrap_or("").trim().to_string() };
    format!("{}|{}|{}|{}|{}", title.trim(), date.trim(), start_sig, end_sig, memo.trim())
}

fn random_hex(n_bytes: usize) -> String {
    use rand::RngExt;
    let mut buf = vec![0u8; n_bytes];
    rand::rng().fill(&mut buf[..]);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// `tag_id`は未設定なら空文字列のまま挿入する(既定タグへはフォールバックしない)。
pub fn outlook_auto_sync(
    conn: &Connection,
    events: &[OutlookEvent],
    tag_id: &str,
    start_key: &str,
    end_key: &str,
) -> rusqlite::Result<AutoSyncResult> {
    let now = chrono::Utc::now().to_rfc3339();

    let mut rows: Vec<ExistingRow> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, title, date, is_all_day, start_time, end_time, memo, outlook_occurrence_key, outlook_series_id, meeting_url
             FROM tasks WHERE date >= ?1 AND date <= ?2",
        )?;
        let mut query = stmt.query(params![start_key, end_key])?;
        while let Some(row) = query.next()? {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let date: String = row.get(2)?;
            let is_all_day_int: i64 = row.get(3)?;
            let start_time: Option<String> = row.get(4)?;
            let end_time: Option<String> = row.get(5)?;
            let memo: String = row.get(6)?;
            let occurrence_key: Option<String> = row.get(7)?;
            let series_id: Option<String> = row.get(8)?;
            let meeting_url: Option<String> = row.get(9)?;
            let sig = signature(&title, &date, is_all_day_int != 0, start_time.as_deref(), end_time.as_deref(), &memo);
            rows.push(ExistingRow {
                id,
                signature: sig,
                key: occurrence_key.unwrap_or_default(),
                series_id: series_id.unwrap_or_default(),
                meeting_url,
            });
        }
    }

    let mut existing_signatures: HashSet<String> = HashSet::new();
    let mut existing_by_key: HashMap<String, Vec<usize>> = HashMap::new();
    let mut existing_by_signature: HashMap<String, usize> = HashMap::new();
    for (idx, row) in rows.iter().enumerate() {
        existing_signatures.insert(row.signature.clone());
        if row.key.is_empty() {
            continue;
        }
        existing_by_key.entry(row.key.clone()).or_default().push(idx);
        existing_by_signature.entry(row.signature.clone()).or_insert(idx);
    }

    let mut added = 0usize;
    let mut skipped = 0usize;
    let mut updated = 0usize;
    let mut current_keys: HashSet<String> = HashSet::new();

    for event in events {
        let occurrence_key = event.outlook_occurrence_key.clone();
        let series_id = event.outlook_series_id.clone();
        let sig = signature(
            &event.title,
            &event.date,
            event.is_all_day,
            event.start_time.as_deref(),
            event.end_time.as_deref(),
            &event.location,
        );

        // 1) Outlookキー一致を優先
        if !occurrence_key.is_empty()
            && let Some(indices) = existing_by_key.get(&occurrence_key).cloned() {
                skipped += 1;
                current_keys.insert(occurrence_key.clone());
                for idx in indices {
                    let mut changed = false;
                    if !series_id.is_empty() && rows[idx].series_id != series_id {
                        conn.execute(
                            "UPDATE tasks SET outlook_series_id=?1, updated_at=?2 WHERE id=?3",
                            params![series_id, now, rows[idx].id],
                        )?;
                        rows[idx].series_id = series_id.clone();
                        changed = true;
                    }
                    if rows[idx].signature != sig {
                        conn.execute(
                            "UPDATE tasks SET title=?1, date=?2, is_all_day=?3, start_time=?4, end_time=?5, memo=?6, updated_at=?7 WHERE id=?8",
                            params![
                                event.title,
                                event.date,
                                event.is_all_day as i64,
                                if event.is_all_day { None } else { event.start_time.clone() },
                                if event.is_all_day { None } else { event.end_time.clone() },
                                event.location,
                                now,
                                rows[idx].id,
                            ],
                        )?;
                        rows[idx].signature = sig.clone();
                        existing_signatures.insert(sig.clone());
                        changed = true;
                    }
                    if rows[idx].meeting_url != event.meeting_url {
                        conn.execute(
                            "UPDATE tasks SET meeting_url=?1, updated_at=?2 WHERE id=?3",
                            params![event.meeting_url, now, rows[idx].id],
                        )?;
                        rows[idx].meeting_url = event.meeting_url.clone();
                        changed = true;
                    }
                    if changed {
                        updated += 1;
                    }
                }
                continue;
            }

        // 2) 内容一致(タグ違いでも重複扱い)
        if existing_signatures.contains(&sig) {
            skipped += 1;
            if let Some(&idx) = existing_by_signature.get(&sig)
                && !occurrence_key.is_empty() {
                    current_keys.insert(occurrence_key.clone());
                    let should_update_key = rows[idx].key != occurrence_key;
                    let should_update_series = !series_id.is_empty() && rows[idx].series_id != series_id;
                    if should_update_key || should_update_series {
                        let next_series_id =
                            if !series_id.is_empty() { series_id.clone() } else { rows[idx].series_id.clone() };
                        conn.execute(
                            "UPDATE tasks SET outlook_occurrence_key=?1, outlook_series_id=?2, updated_at=?3 WHERE id=?4",
                            params![
                                occurrence_key,
                                if next_series_id.is_empty() { None } else { Some(next_series_id.clone()) },
                                now,
                                rows[idx].id,
                            ],
                        )?;
                        let old_key = rows[idx].key.clone();
                        if let Some(list) = existing_by_key.get_mut(&old_key) {
                            list.retain(|&i| i != idx);
                            if list.is_empty() {
                                existing_by_key.remove(&old_key);
                            }
                        }
                        rows[idx].key = occurrence_key.clone();
                        rows[idx].series_id = next_series_id;
                        existing_by_key.entry(occurrence_key.clone()).or_default().push(idx);
                        updated += 1;
                    }
                }
            continue;
        }

        // 3) 新規登録
        let task_id = format!("task-{}", random_hex(6));
        conn.execute(
            "INSERT OR IGNORE INTO tasks (id, title, date, is_all_day, start_time, end_time, tag_id, recurrence, memo, outlook_occurrence_key, outlook_series_id, meeting_url, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                task_id,
                event.title,
                event.date,
                event.is_all_day as i64,
                if event.is_all_day { None } else { event.start_time.clone() },
                if event.is_all_day { None } else { event.end_time.clone() },
                tag_id,
                event.recurrence.to_string(),
                event.location,
                if occurrence_key.is_empty() { None } else { Some(occurrence_key.clone()) },
                if series_id.is_empty() { None } else { Some(series_id.clone()) },
                event.meeting_url,
                now,
                now,
            ],
        )?;
        added += 1;
        existing_signatures.insert(sig.clone());
        if !occurrence_key.is_empty() {
            current_keys.insert(occurrence_key.clone());
            let new_idx = rows.len();
            rows.push(ExistingRow {
                id: task_id,
                signature: sig.clone(),
                key: occurrence_key.clone(),
                series_id: series_id.clone(),
                meeting_url: event.meeting_url.clone(),
            });
            existing_by_key.entry(occurrence_key).or_default().push(new_idx);
            existing_by_signature.entry(sig).or_insert(new_idx);
        }
    }

    // 4) Outlookに存在しなくなった予定を削除(Outlook由来キー付きタスクのみ)
    let mut deleted = 0usize;
    if !current_keys.is_empty() {
        let mut stale_ids = Vec::new();
        for (key, indices) in existing_by_key.iter() {
            if current_keys.contains(key) {
                continue;
            }
            for &idx in indices {
                stale_ids.push(rows[idx].id.clone());
            }
        }
        for id in &stale_ids {
            conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
        }
        deleted = stale_ids.len();
    }

    Ok(AutoSyncResult { count: events.len(), added, skipped, deleted, updated })
}

#[cfg(test)]
mod outlook_sync_tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn, "2026-08").unwrap();
        conn
    }

    fn sample_event(occurrence_key: &str, title: &str, date: &str, start: &str, end: &str) -> OutlookEvent {
        OutlookEvent {
            title: title.to_string(),
            date: date.to_string(),
            start_time: Some(start.to_string()),
            end_time: Some(end.to_string()),
            location: String::new(),
            is_all_day: false,
            outlook_series_id: "series-1".to_string(),
            outlook_occurrence_key: occurrence_key.to_string(),
            is_recurring: false,
            recurrence: json!({ "type": "none" }),
            meeting_url: None,
        }
    }

    #[test]
    fn inserts_new_event_on_first_sync() {
        let conn = setup();
        let events = vec![sample_event("series-1|2026-08-10T09:00", "打合せ", "2026-08-10", "09:00", "10:00")];
        let result = outlook_auto_sync(&conn, &events, "tag-1", "2026-08-01", "2026-08-31").unwrap();
        assert_eq!((result.added, result.skipped, result.updated, result.deleted), (1, 0, 0, 0));

        let tasks = tasks_list(&conn).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "打合せ");
        assert_eq!(tasks[0].outlook_occurrence_key.as_deref(), Some("series-1|2026-08-10T09:00"));
    }

    #[test]
    fn second_sync_with_same_event_is_skipped_not_duplicated() {
        let conn = setup();
        let events = vec![sample_event("series-1|2026-08-10T09:00", "打合せ", "2026-08-10", "09:00", "10:00")];
        outlook_auto_sync(&conn, &events, "tag-1", "2026-08-01", "2026-08-31").unwrap();
        let result = outlook_auto_sync(&conn, &events, "tag-1", "2026-08-01", "2026-08-31").unwrap();
        assert_eq!((result.added, result.skipped, result.updated, result.deleted), (0, 1, 0, 0));
        assert_eq!(tasks_list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn updates_content_when_occurrence_key_matches_but_title_changed() {
        let conn = setup();
        let events = vec![sample_event("series-1|2026-08-10T09:00", "打合せ", "2026-08-10", "09:00", "10:00")];
        outlook_auto_sync(&conn, &events, "tag-1", "2026-08-01", "2026-08-31").unwrap();

        let renamed = vec![sample_event("series-1|2026-08-10T09:00", "打合せ(変更後)", "2026-08-10", "09:00", "10:00")];
        let result = outlook_auto_sync(&conn, &renamed, "tag-1", "2026-08-01", "2026-08-31").unwrap();
        assert_eq!((result.added, result.skipped, result.updated, result.deleted), (0, 1, 1, 0));

        let tasks = tasks_list(&conn).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "打合せ(変更後)");
    }

    #[test]
    fn deletes_task_no_longer_present_in_outlook() {
        let conn = setup();
        let events = vec![sample_event("series-1|2026-08-10T09:00", "打合せ", "2026-08-10", "09:00", "10:00")];
        outlook_auto_sync(&conn, &events, "tag-1", "2026-08-01", "2026-08-31").unwrap();

        // 2回目のfetchで元の予定が削除され、別の予定に置き換わったケース。
        let replacement = vec![sample_event("series-1|2026-08-11T09:00", "別の打合せ", "2026-08-11", "09:00", "10:00")];
        let result = outlook_auto_sync(&conn, &replacement, "tag-1", "2026-08-01", "2026-08-31").unwrap();
        assert_eq!((result.added, result.skipped, result.updated, result.deleted), (1, 0, 0, 1));

        let tasks = tasks_list(&conn).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "別の打合せ");
    }

    #[test]
    fn manually_created_task_without_occurrence_key_is_never_deleted() {
        let conn = setup();
        // 手動作成タスク(outlook_occurrence_key無し)
        conn.execute(
            "INSERT INTO tasks (id, title, date, tag_id, created_at, updated_at)
             VALUES ('manual-1', '手動タスク', '2026-08-10', 'tag-1', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')",
            [],
        )
        .unwrap();

        // Outlook側には何も予定がない状態で同期。
        let result = outlook_auto_sync(&conn, &[], "tag-1", "2026-08-01", "2026-08-31").unwrap();
        assert_eq!((result.added, result.skipped, result.updated, result.deleted), (0, 0, 0, 0));
        assert_eq!(tasks_list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn content_match_against_keyless_manual_task_is_skipped_without_backfilling_key() {
        // outlook_occurrence_keyを持たない既存タスクは、existing_signaturesには
        // 登録されるが、existing_by_key/existing_by_signatureには登録されない。
        // そのため内容一致で「重複追加はしない(skip)」が、既存タスクへの
        // occurrence_keyのバックフィルも行われない。この境界挙動を確認する。
        let conn = setup();
        conn.execute(
            "INSERT INTO tasks (id, title, date, is_all_day, start_time, end_time, tag_id, memo, created_at, updated_at)
             VALUES ('t-1', '打合せ', '2026-08-10', 0, '09:00', '10:00', 'tag-1', '', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')",
            [],
        )
        .unwrap();

        let events = vec![sample_event("series-1|2026-08-10T09:00", "打合せ", "2026-08-10", "09:00", "10:00")];
        let result = outlook_auto_sync(&conn, &events, "tag-1", "2026-08-01", "2026-08-31").unwrap();
        assert_eq!((result.added, result.skipped, result.updated, result.deleted), (0, 1, 0, 0));

        let tasks = tasks_list(&conn).unwrap();
        assert_eq!(tasks.len(), 1, "重複挿入されないこと");
        assert_eq!(tasks[0].id, "t-1");
        assert_eq!(tasks[0].outlook_occurrence_key, None, "キーはバックフィルされない");
    }
}
