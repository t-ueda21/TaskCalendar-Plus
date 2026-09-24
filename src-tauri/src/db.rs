//! SQLiteスキーマ・初期化ロジック。
//!
//! rusqlite でテーブル構成とデフォルトシードを作成・移行する。
//! Outlook連携・繰り返し予定展開・HTTPサーバーはこのモジュールの対象外。

use rusqlite::{Connection, Result, params};
use std::path::Path;


/// DBファイルを開き、WALモードを有効化する。
pub fn open_database(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    Ok(conn)
}

/// テーブル作成・デフォルトシードを行う。何度呼んでも安全(冪等)。
///
/// `current_month` は `monthTagOrders` の初回シードに使う対象月(`YYYY-MM`)。
/// 呼び出し側(main.rs)がシステム時刻から算出して渡す。
pub fn migrate(conn: &Connection, current_month: &str) -> Result<()> {
    create_tables(conn)?;
    add_tags_budget_range_columns(conn)?;
    dedupe_outlook_occurrence_keys(conn)?;
    create_indexes(conn)?;
    seed_current_month_tag_order(conn, current_month)?;
    Ok(())
}

/// タグごとの月間予定工数の下限・上限(分)。CREATE TABLE IF NOT EXISTSは
/// 既存DBのテーブルには効かないため、列が無い場合だけALTER TABLEで追加する(冪等)。
fn add_tags_budget_range_columns(conn: &Connection) -> Result<()> {
    for column in ["budget_min_minutes", "budget_max_minutes"] {
        let has_column: bool = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('tags') WHERE name = ?1",
            params![column],
            |row| row.get::<_, i64>(0),
        )? > 0;
        if !has_column {
            conn.execute(&format!("ALTER TABLE tags ADD COLUMN {column} INTEGER"), [])?;
        }
    }
    Ok(())
}

fn create_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            date TEXT NOT NULL,
            is_all_day INTEGER NOT NULL DEFAULT 0,
            start_time TEXT,
            end_time TEXT,
            tag_id TEXT NOT NULL DEFAULT '',
            recurrence TEXT NOT NULL DEFAULT '{\"type\":\"none\"}',
            memo TEXT NOT NULL DEFAULT '',
            outlook_occurrence_key TEXT,
            outlook_series_id TEXT,
            meeting_url TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tags (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ai_memory (
            kind TEXT NOT NULL,
            date TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (kind, date)
        );

        CREATE TABLE IF NOT EXISTS weather_cache (
            location_key TEXT NOT NULL,
            date TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (location_key, date)
        );
        ",
    )
}

/// `outlook_occurrence_key`のUNIQUE INDEXを作る前に、既存の重複行を
/// (idが最小のものを残して)削除する。過去のタイムゾーン変換不具合で
/// 生成されうる重複行への対処(新規DBでは実質no-op)。
fn dedupe_outlook_occurrence_keys(conn: &Connection) -> Result<()> {
    conn.execute(
        "DELETE FROM tasks
         WHERE outlook_occurrence_key IS NOT NULL
           AND id NOT IN (
               SELECT MIN(id) FROM tasks
               WHERE outlook_occurrence_key IS NOT NULL
               GROUP BY outlook_occurrence_key
           )",
        [],
    )?;
    Ok(())
}

fn create_indexes(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_outlook_occurrence_key
         ON tasks(outlook_occurrence_key)
         WHERE outlook_occurrence_key IS NOT NULL",
        [],
    )?;
    Ok(())
}

/// 設定JSON(オブジェクト)。未保存・不正な場合は空のオブジェクト。
fn load_settings(conn: &Connection) -> Result<serde_json::Value> {
    Ok(crate::repositories::settings_get(conn)?
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({})))
}

/// `monthTagOrders`が一度も設定されていない場合だけ、当月分を
/// 現在のtags順(id昇順)で初期化する。既定タグは無いため、新規DBでは空配列になる。
fn seed_current_month_tag_order(conn: &Connection, current_month: &str) -> Result<()> {
    let mut settings = load_settings(conn)?;
    let has_any_month = settings
        .get("monthTagOrders")
        .and_then(|v| v.as_object())
        .map(|obj| !obj.is_empty())
        .unwrap_or(false);
    if has_any_month {
        return Ok(());
    }

    let mut tag_ids: Vec<String> = conn
        .prepare("SELECT id FROM tags ORDER BY id ASC")?
        .query_map([], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();
    tag_ids.sort();

    let obj = settings
        .as_object_mut()
        .expect("settings root must be a JSON object");
    let month_orders = obj
        .entry("monthTagOrders")
        .or_insert_with(|| serde_json::json!({}));
    month_orders[current_month] = serde_json::json!(tag_ids);

    crate::repositories::settings_set(conn, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn, "2026-08").unwrap();
        conn
    }

    #[test]
    fn creates_all_expected_tables() {
        let conn = setup();
        let mut names: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec!["ai_memory", "settings", "tags", "tasks", "weather_cache"]
        );
    }

    #[test]
    fn seeds_no_default_tags() {
        let conn = setup();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM tags", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);

        migrate(&conn, "2026-09").unwrap();
        let count_after: i64 = conn.query_row("SELECT COUNT(*) FROM tags", [], |r| r.get(0)).unwrap();
        assert_eq!(count_after, 0);
    }

    #[test]
    fn seeds_month_tag_order_only_once() {
        let conn = setup();
        let settings = load_settings(&conn).unwrap();
        let orders = settings.get("monthTagOrders").unwrap().as_object().unwrap();
        assert_eq!(orders.len(), 1);
        assert!(orders.contains_key("2026-08"));
        assert_eq!(
            orders["2026-08"],
            serde_json::json!([])
        );

        // 2回目のmigrate(別の月を渡す)では追加されない。
        migrate(&conn, "2026-09").unwrap();
        let settings_after = load_settings(&conn).unwrap();
        let orders_after = settings_after
            .get("monthTagOrders")
            .unwrap()
            .as_object()
            .unwrap();
        assert_eq!(orders_after.len(), 1);
        assert!(!orders_after.contains_key("2026-09"));
    }

    #[test]
    fn outlook_occurrence_key_unique_index_rejects_duplicates() {
        let conn = setup();
        let insert = |id: &str, key: &str| {
            conn.execute(
                "INSERT INTO tasks (id, date, tag_id, outlook_occurrence_key, created_at, updated_at)
                 VALUES (?1, '2026-08-04', 'tag-1', ?2, '2026-08-04T00:00:00Z', '2026-08-04T00:00:00Z')",
                (id, key),
            )
        };
        insert("t-1", "series-a|2026-08-04T09:00").unwrap();
        let result = insert("t-2", "series-a|2026-08-04T09:00");
        assert!(result.is_err(), "duplicate outlook_occurrence_key must be rejected");
    }

    #[test]
    fn null_outlook_occurrence_key_allows_multiple_rows() {
        let conn = setup();
        let insert = |id: &str| {
            conn.execute(
                "INSERT INTO tasks (id, date, tag_id, created_at, updated_at)
                 VALUES (?1, '2026-08-04', 'tag-1', '2026-08-04T00:00:00Z', '2026-08-04T00:00:00Z')",
                [id],
            )
        };
        insert("t-1").unwrap();
        insert("t-2").unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn dedupes_pre_existing_duplicate_outlook_rows_before_index_creation() {
        // 過去のタイムゾーン変換不具合で生成されうる重複行を、
        // UNIQUE INDEX作成前に(idが最小の行を残して)除去できることを確認する。
        let conn = Connection::open_in_memory().unwrap();
        create_tables(&conn).unwrap();
        conn.execute(
            "INSERT INTO tasks (id, date, tag_id, outlook_occurrence_key, created_at, updated_at)
             VALUES ('t-2', '2026-08-04', 'tag-1', 'dup-key', '2026-08-04T00:00:00Z', '2026-08-04T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, date, tag_id, outlook_occurrence_key, created_at, updated_at)
             VALUES ('t-1', '2026-08-04', 'tag-1', 'dup-key', '2026-08-04T00:00:00Z', '2026-08-04T00:00:00Z')",
            [],
        )
        .unwrap();

        migrate(&conn, "2026-08").unwrap();

        let remaining: Vec<String> = conn
            .prepare("SELECT id FROM tasks WHERE outlook_occurrence_key = 'dup-key'")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert_eq!(remaining, vec!["t-1"]);
    }
}
