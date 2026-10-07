//! Persistent outbound Outlook operations; all COM work is delegated to the STA worker.
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WritePayload { pub task_id: String, pub title: String, pub date: String, pub is_all_day: bool, pub start_time: Option<String>, pub end_time: Option<String>, pub memo: String }

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let has_column: bool = conn.query_row("SELECT count(*) FROM pragma_table_info('tasks') WHERE name='outlook_enabled'", [], |row| Ok(row.get::<_,i64>(0)? > 0))?;
    if !has_column { conn.execute("ALTER TABLE tasks ADD COLUMN outlook_enabled INTEGER NOT NULL DEFAULT 0", [])?; }
    conn.execute_batch("CREATE TABLE IF NOT EXISTS outlook_identity(id INTEGER PRIMARY KEY CHECK(id=1), namespace TEXT NOT NULL);
      INSERT OR IGNORE INTO outlook_identity VALUES(1,lower(hex(randomblob(16))));
      CREATE TABLE IF NOT EXISTS outlook_links(task_id TEXT PRIMARY KEY, calendar_name TEXT NOT NULL, entry_id TEXT, store_id TEXT, external_key TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS outlook_jobs(task_id TEXT PRIMARY KEY,operation TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',revision INTEGER NOT NULL DEFAULT 1,last_error TEXT NOT NULL DEFAULT '');
      DROP TRIGGER IF EXISTS outlook_task_insert; DROP TRIGGER IF EXISTS outlook_task_update; DROP TRIGGER IF EXISTS outlook_task_delete;
      CREATE TRIGGER outlook_task_insert AFTER INSERT ON tasks WHEN NEW.outlook_enabled=1 AND EXISTS(SELECT 1 FROM outlook_links WHERE task_id=NEW.id) BEGIN
        INSERT INTO outlook_jobs(task_id,operation,payload) VALUES(NEW.id,'upsert',json_object('task_id',NEW.id,'title',NEW.title,'date',NEW.date,'is_all_day',json(CASE WHEN NEW.is_all_day THEN 'true' ELSE 'false' END),'start_time',NEW.start_time,'end_time',NEW.end_time,'memo',NEW.memo))
        ON CONFLICT(task_id) DO UPDATE SET operation='upsert',payload=excluded.payload,status='pending',last_error='',revision=revision+1;
      END;
      CREATE TRIGGER outlook_task_update AFTER UPDATE OF title,date,is_all_day,start_time,end_time,memo ON tasks
      WHEN NEW.outlook_enabled=1 AND EXISTS(SELECT 1 FROM outlook_links WHERE task_id=NEW.id) AND (OLD.title IS NOT NEW.title OR OLD.date IS NOT NEW.date OR OLD.is_all_day IS NOT NEW.is_all_day OR OLD.start_time IS NOT NEW.start_time OR OLD.end_time IS NOT NEW.end_time OR OLD.memo IS NOT NEW.memo) BEGIN
        INSERT INTO outlook_jobs(task_id,operation,payload) VALUES(NEW.id,'upsert',json_object('task_id',NEW.id,'title',NEW.title,'date',NEW.date,'is_all_day',json(CASE WHEN NEW.is_all_day THEN 'true' ELSE 'false' END),'start_time',NEW.start_time,'end_time',NEW.end_time,'memo',NEW.memo))
        ON CONFLICT(task_id) DO UPDATE SET operation='upsert',payload=excluded.payload,status='pending',last_error='',revision=revision+1;
      END;
      CREATE TRIGGER outlook_task_delete AFTER DELETE ON tasks WHEN OLD.outlook_enabled=1 AND EXISTS(SELECT 1 FROM outlook_links WHERE task_id=OLD.id) BEGIN
        INSERT INTO outlook_jobs(task_id,operation,payload) VALUES(OLD.id,'delete',json_object('task_id',OLD.id,'title',OLD.title,'date',OLD.date,'is_all_day',json(CASE WHEN OLD.is_all_day THEN 'true' ELSE 'false' END),'start_time',OLD.start_time,'end_time',OLD.end_time,'memo',OLD.memo))
        ON CONFLICT(task_id) DO UPDATE SET operation='delete',payload=excluded.payload,status='pending',last_error='',revision=revision+1;
      END;")?;
    // A crashed process may leave a claimed operation. Reconcile by stable external key on retry.
    conn.execute("UPDATE outlook_jobs SET status='pending' WHERE status='working'", [])?;
    Ok(())
}

pub fn enable(conn: &Connection, task_id: &str) -> rusqlite::Result<()> {
    let config = crate::repositories::settings_get(conn)?.unwrap_or(Value::Null);
    let default_calendar = config.get("outlookWriteCalendarName").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).unwrap_or("Calendar").trim();
    use rusqlite::OptionalExtension;
    let inherited = conn.query_row("SELECT l.calendar_name FROM outlook_links l JOIN tasks t ON t.id=l.task_id WHERE json_extract(CASE WHEN json_valid(t.recurrence) THEN t.recurrence ELSE '{}' END,'$.groupId')=(SELECT json_extract(recurrence,'$.groupId') FROM tasks WHERE id=?1) LIMIT 1",params![task_id],|row|row.get::<_,String>(0)).optional()?;
    let calendar = inherited.as_deref().unwrap_or(default_calendar);
    conn.execute("INSERT OR IGNORE INTO outlook_links(task_id,calendar_name,external_key) SELECT id,?2,(SELECT namespace FROM outlook_identity WHERE id=1)||':'||id FROM tasks WHERE id=?1", params![task_id,calendar])?;
    conn.execute("UPDATE tasks SET outlook_enabled=1 WHERE id=?1", params![task_id])?;
    conn.execute("INSERT INTO outlook_jobs(task_id,operation,payload) SELECT id,'upsert',json_object('task_id',id,'title',title,'date',date,'is_all_day',json(CASE WHEN is_all_day THEN 'true' ELSE 'false' END),'start_time',start_time,'end_time',end_time,'memo',memo) FROM tasks WHERE id=?1
      ON CONFLICT(task_id) DO UPDATE SET operation='upsert',payload=excluded.payload,status='pending',last_error='',revision=revision+1", params![task_id])?;
    Ok(())
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Value>> {
    let mut statement = conn.prepare("SELECT j.task_id,j.operation,j.status,j.last_error,j.payload,l.calendar_name FROM outlook_jobs j LEFT JOIN outlook_links l ON l.task_id=j.task_id ORDER BY CASE j.status WHEN 'failed' THEN 0 WHEN 'pending' THEN 1 WHEN 'working' THEN 2 ELSE 3 END,j.rowid DESC LIMIT 200")?;
    statement.query_map([], |row| {
        let payload: String = row.get(4)?;
        let data: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
        Ok(json!({"taskId":row.get::<_,String>(0)?,"operation":row.get::<_,String>(1)?,"status":row.get::<_,String>(2)?,"error":row.get::<_,String>(3)?,"title":data["title"],"calendarName":row.get::<_,Option<String>>(5)?}))
    })?.collect()
}

pub fn retry(conn: &Connection, task_id: &str) -> rusqlite::Result<usize> {
    conn.execute("UPDATE outlook_jobs SET status='pending',last_error='' WHERE task_id=?1 AND status='failed'",params![task_id])
}

pub fn counts(conn: &Connection) -> rusqlite::Result<Value> {
    let mut result = json!({"pending":0,"working":0,"failed":0,"done":0});
    let mut statement = conn.prepare("SELECT status,count(*) FROM outlook_jobs GROUP BY status")?;
    for pair in statement.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?)))? { let (status,count)=pair?;result[status]=json!(count); }
    Ok(result)
}

pub async fn process_one(state: &crate::api::AppState) -> Result<bool, String> {
    let job = {
        let conn = state.conn.lock().map_err(|_| "Database lock failed")?;
        use rusqlite::OptionalExtension;
        let found = conn.query_row("SELECT j.task_id,j.operation,j.payload,j.revision,l.calendar_name,l.entry_id,l.store_id,l.external_key FROM outlook_jobs j JOIN outlook_links l ON l.task_id=j.task_id WHERE j.status='pending' ORDER BY j.rowid LIMIT 1",[],|row| {
            Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,i64>(3)?,row.get::<_,String>(4)?,row.get::<_,Option<String>>(5)?,row.get::<_,Option<String>>(6)?,row.get::<_,String>(7)?))
        }).optional().map_err(|e|e.to_string())?;
        if let Some((id,_,_,revision,_,_,_,_)) = &found { conn.execute("UPDATE outlook_jobs SET status='working' WHERE task_id=?1 AND revision=?2",params![id,revision]).map_err(|e|e.to_string())?; }
        found
    };
    let Some((id,operation,payload,revision,calendar_name,entry_id,store_id,external_key)) = job else { return Ok(false) };
    let parsed = serde_json::from_str::<WritePayload>(&payload).map_err(|e|e.to_string());
    let result = match parsed {
        Ok(payload) => crate::outlook::write_event(crate::outlook::WriteRequest { operation: operation.clone(), payload, calendar_name, entry_id, store_id, external_key }).await,
        Err(error) => Err(error),
    };
    let conn = state.conn.lock().map_err(|_| "Database lock failed")?;
    match result {
        Ok(identity) => {
            if operation == "upsert" {
                conn.execute("UPDATE outlook_links SET entry_id=?2,store_id=?3 WHERE task_id=?1",params![id,identity.entry_id,identity.store_id]).map_err(|e|e.to_string())?;
                conn.execute("UPDATE tasks SET outlook_occurrence_key=?2,outlook_series_id=?3 WHERE id=?1 AND EXISTS(SELECT 1 FROM outlook_links WHERE task_id=?1)",params![id,identity.occurrence_key,identity.series_id]).map_err(|e|e.to_string())?;
            }
            conn.execute("UPDATE outlook_jobs SET status='done',last_error='' WHERE task_id=?1 AND revision=?2",params![id,revision]).map_err(|e|e.to_string())?;
            // Keep tombstones for Undo so a changed default calendar cannot redirect
            // restoration. A task with outlook_enabled=0 never activates the link.
        },
        Err(error) => { conn.execute("UPDATE outlook_jobs SET status='failed',last_error=?3 WHERE task_id=?1 AND revision=?2",params![id,revision,error]).map_err(|e|e.to_string())?; },
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn enabled_task_queues_updates_and_retains_deleted_identity() {
        let conn = Connection::open_in_memory().unwrap(); crate::db::migrate(&conn, "2026-10").unwrap();
        conn.execute("INSERT INTO tasks(id,title,date,created_at,updated_at) VALUES('a','Test','2026-10-07','x','x')", []).unwrap();
        enable(&conn, "a").unwrap();
        assert_eq!(list(&conn).unwrap()[0]["operation"], "upsert");
        conn.execute("UPDATE tasks SET title='Edited' WHERE id='a'", []).unwrap();
        assert_eq!(list(&conn).unwrap().len(), 1);
        conn.execute("DELETE FROM tasks WHERE id='a'", []).unwrap();
        assert_eq!(list(&conn).unwrap()[0]["operation"], "delete");
        assert_eq!(conn.query_row("SELECT count(*) FROM outlook_links WHERE task_id='a'", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
    }
    #[test]
    fn local_only_task_does_not_queue_and_migration_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap(); crate::db::migrate(&conn,"2026-10").unwrap(); crate::db::migrate(&conn,"2026-10").unwrap();
        conn.execute("INSERT INTO tasks(id,title,date,created_at,updated_at) VALUES('a','Test','2026-10-07','x','x')", []).unwrap();
        conn.execute("UPDATE tasks SET title='Edited' WHERE id='a'", []).unwrap();
        conn.execute("DELETE FROM tasks WHERE id='a'", []).unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }
    #[test]
    fn pending_local_edit_is_not_overwritten_or_deleted_by_inbound_sync() {
        let conn = Connection::open_in_memory().unwrap(); crate::db::migrate(&conn,"2026-10").unwrap();
        let input = serde_json::from_value(json!({"id":"a","title":"Local edit","date":"2026-10-07","startTime":"15:00","endTime":"16:00","outlookEnabled":true})).unwrap();
        crate::repositories::tasks_insert(&conn,input).unwrap();
        let key: String = conn.query_row("SELECT external_key FROM outlook_links WHERE task_id='a'",[],|row|row.get(0)).unwrap();
        let event = crate::outlook::OutlookEvent {title:"Remote old".into(),date:"2026-10-07".into(),start_time:Some("15:00".into()),end_time:Some("16:00".into()),location:String::new(),is_all_day:false,outlook_series_id:"series".into(),outlook_occurrence_key:format!("tcplus:{key}"),is_recurring:false,recurrence:json!({"type":"none"}),meeting_url:None};
        let range = crate::outlook::OutlookSyncRange::dates("2026-10-07","2026-10-07").unwrap();
        crate::repositories::outlook_sync_in_range(&conn,&[event],"",range).unwrap();
        let rows = crate::repositories::tasks_list(&conn).unwrap();
        assert_eq!(rows.len(),1); assert_eq!(rows[0].title,"Local edit");
        crate::repositories::outlook_sync_in_range(&conn,&[],"",range).unwrap();
        assert_eq!(crate::repositories::tasks_list(&conn).unwrap().len(),1);
    }
}
