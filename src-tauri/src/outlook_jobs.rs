//! Persistent outbound Outlook operations; all COM work is delegated to the STA worker.
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WritePayload { #[serde(default)] pub recurrence:Value, #[serde(default)] pub end_date:Option<String>, #[serde(default)] pub outlook_details:Value, pub task_id: String, pub title: String, pub date: String, pub is_all_day: bool, pub start_time: Option<String>, pub end_time: Option<String>, pub memo: String }

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let has_column: bool = conn.query_row("SELECT count(*) FROM pragma_table_info('tasks') WHERE name='outlook_enabled'", [], |row| Ok(row.get::<_,i64>(0)? > 0))?;
    if !has_column { conn.execute("ALTER TABLE tasks ADD COLUMN outlook_enabled INTEGER NOT NULL DEFAULT 0", [])?; }
    conn.execute_batch("CREATE TABLE IF NOT EXISTS outlook_jobs(task_id TEXT PRIMARY KEY,operation TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',revision INTEGER NOT NULL DEFAULT 1,last_error TEXT NOT NULL DEFAULT '',force_write INTEGER NOT NULL DEFAULT 0);")?;
    let force_exists:bool=conn.query_row("SELECT count(*)>0 FROM pragma_table_info('outlook_jobs') WHERE name='force_write'",[],|r|r.get(0))?;
    if !force_exists {conn.execute("ALTER TABLE outlook_jobs ADD COLUMN force_write INTEGER NOT NULL DEFAULT 0",[])?;}
    let attempts_exists:bool=conn.query_row("SELECT count(*)>0 FROM pragma_table_info('outlook_jobs') WHERE name='attempts'",[],|r|r.get(0))?;
    if !attempts_exists {conn.execute("ALTER TABLE outlook_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",[])?;}
    let result_exists:bool=conn.query_row("SELECT count(*)>0 FROM pragma_table_info('outlook_jobs') WHERE name='result'",[],|r|r.get(0))?;
    if !result_exists {conn.execute("ALTER TABLE outlook_jobs ADD COLUMN result TEXT",[])?;}
    conn.execute_batch("CREATE TABLE IF NOT EXISTS outlook_series_results(task_id TEXT NOT NULL,revision INTEGER NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(task_id,revision));")?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS outlook_identity(id INTEGER PRIMARY KEY CHECK(id=1), namespace TEXT NOT NULL);
      INSERT OR IGNORE INTO outlook_identity VALUES(1,lower(hex(randomblob(16))));
      CREATE TABLE IF NOT EXISTS outlook_links(task_id TEXT PRIMARY KEY, calendar_name TEXT NOT NULL, entry_id TEXT, store_id TEXT, external_key TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS outlook_jobs(task_id TEXT PRIMARY KEY,operation TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',revision INTEGER NOT NULL DEFAULT 1,last_error TEXT NOT NULL DEFAULT '');
      DROP TRIGGER IF EXISTS outlook_task_insert; DROP TRIGGER IF EXISTS outlook_task_update; DROP TRIGGER IF EXISTS outlook_task_delete;
      CREATE TRIGGER outlook_task_insert AFTER INSERT ON tasks WHEN NEW.outlook_enabled=1 AND EXISTS(SELECT 1 FROM outlook_links WHERE task_id=NEW.id) BEGIN
        INSERT INTO outlook_jobs(task_id,operation,payload) VALUES(NEW.id,'upsert',json_object('task_id',NEW.id,'title',NEW.title,'date',NEW.date,'is_all_day',json(CASE WHEN NEW.is_all_day THEN 'true' ELSE 'false' END),'start_time',NEW.start_time,'end_time',NEW.end_time,'memo',NEW.memo,'end_date',NEW.end_date,'outlook_details',json(NEW.outlook_details),'recurrence',json(NEW.recurrence)))
        ON CONFLICT(task_id) DO UPDATE SET operation='upsert',payload=excluded.payload,status='pending',last_error='',force_write=0,result=NULL,attempts=0,revision=revision+1;
      END;
      CREATE TRIGGER outlook_task_update AFTER UPDATE OF title,date,end_date,is_all_day,start_time,end_time,memo,outlook_details,recurrence ON tasks
      WHEN NEW.outlook_enabled=1 AND EXISTS(SELECT 1 FROM outlook_links WHERE task_id=NEW.id) AND (OLD.title IS NOT NEW.title OR OLD.date IS NOT NEW.date OR OLD.end_date IS NOT NEW.end_date OR OLD.outlook_details IS NOT NEW.outlook_details OR OLD.is_all_day IS NOT NEW.is_all_day OR OLD.start_time IS NOT NEW.start_time OR OLD.end_time IS NOT NEW.end_time OR OLD.memo IS NOT NEW.memo OR (OLD.recurrence IS NOT NEW.recurrence AND NOT EXISTS(SELECT 1 FROM outlook_links WHERE task_id=NEW.id AND remote_meta IS NOT NULL))) BEGIN
        INSERT INTO outlook_jobs(task_id,operation,payload) VALUES(NEW.id,'upsert',json_object('task_id',NEW.id,'title',NEW.title,'date',NEW.date,'is_all_day',json(CASE WHEN NEW.is_all_day THEN 'true' ELSE 'false' END),'start_time',NEW.start_time,'end_time',NEW.end_time,'memo',NEW.memo,'end_date',NEW.end_date,'outlook_details',json(NEW.outlook_details),'recurrence',json(NEW.recurrence)))
        ON CONFLICT(task_id) DO UPDATE SET operation='upsert',payload=excluded.payload,status='pending',last_error='',force_write=0,result=NULL,attempts=0,revision=revision+1;
      END;
      CREATE TRIGGER outlook_task_delete AFTER DELETE ON tasks WHEN OLD.outlook_enabled=1 AND EXISTS(SELECT 1 FROM outlook_links WHERE task_id=OLD.id) BEGIN
        INSERT INTO outlook_jobs(task_id,operation,payload) VALUES(OLD.id,'delete',json_object('task_id',OLD.id,'title',OLD.title,'date',OLD.date,'is_all_day',json(CASE WHEN OLD.is_all_day THEN 'true' ELSE 'false' END),'start_time',OLD.start_time,'end_time',OLD.end_time,'memo',OLD.memo,'end_date',OLD.end_date,'outlook_details',json(OLD.outlook_details),'recurrence',json(OLD.recurrence)))
        ON CONFLICT(task_id) DO UPDATE SET operation='delete',payload=excluded.payload,status='pending',last_error='',force_write=0,result=NULL,attempts=0,revision=revision+1;
      END;")?;
    crate::outlook::reconcile::migrate(conn)?;
    let original_exists:bool=conn.query_row("SELECT count(*)>0 FROM pragma_table_info('outlook_links') WHERE name='original_occurrence_start'",[],|r|r.get(0))?;
    if !original_exists {conn.execute("ALTER TABLE outlook_links ADD COLUMN original_occurrence_start TEXT",[])?;}
    conn.execute_batch("DROP VIEW IF EXISTS outlook_job_status;
      CREATE VIEW outlook_job_status AS SELECT eligible.*,CASE WHEN status='series_wait' OR (status<>'done' AND NOT authorized) THEN 'paused' ELSE status END AS display_status FROM (
        SELECT j.*,l.calendar_name,
          (COALESCE((SELECT json_type(value,'$.outlookWriteEnabled')='true' FROM settings WHERE key='main'),0)
          AND COALESCE(l.sync_enabled,0)=1
          AND ((j.operation='upsert' AND COALESCE(t.outlook_enabled,0)=1)
            OR (j.operation='delete' AND t.id IS NULL) OR (j.operation='series'
              AND EXISTS(SELECT 1 FROM tasks member WHERE json_extract(member.recurrence,'$.groupId')=json_extract(j.payload,'$.request.payload.recurrence.groupId') AND COALESCE(json_extract(member.recurrence,'$.occurrenceDate'),member.date)>=COALESCE(json_extract(j.payload,'$.request.split_date'),'0000-00-00'))
              AND NOT EXISTS(SELECT 1 FROM tasks member WHERE json_extract(member.recurrence,'$.groupId')=json_extract(j.payload,'$.request.payload.recurrence.groupId') AND COALESCE(json_extract(member.recurrence,'$.occurrenceDate'),member.date)>=COALESCE(json_extract(j.payload,'$.request.split_date'),'0000-00-00') AND member.outlook_enabled<>1)))
          AND (j.operation='series' OR NOT EXISTS(SELECT 1 FROM outlook_jobs series WHERE series.operation='series' AND series.status IN('pending','working','failed','paused') AND json_extract(series.payload,'$.request.payload.recurrence.groupId')=json_extract(j.payload,'$.recurrence.groupId')))) AS authorized
        FROM outlook_jobs j LEFT JOIN outlook_links l ON l.task_id=j.task_id LEFT JOIN tasks t ON t.id=j.task_id
      ) eligible;
      DROP TRIGGER IF EXISTS outlook_task_off;
      DROP TRIGGER IF EXISTS outlook_global_off_update;
      CREATE TRIGGER outlook_global_off_update AFTER UPDATE OF value ON settings
      WHEN NEW.key='main' AND COALESCE(json_type(OLD.value,'$.outlookWriteEnabled')='true',0) AND NOT COALESCE(json_type(NEW.value,'$.outlookWriteEnabled')='true',0) BEGIN
        UPDATE outlook_jobs SET status=CASE WHEN status='working' THEN 'pending' ELSE status END,revision=revision+1,force_write=0 WHERE status<>'done';
      END;
      DROP TRIGGER IF EXISTS outlook_global_off_delete;
      CREATE TRIGGER outlook_global_off_delete AFTER DELETE ON settings WHEN OLD.key='main' BEGIN
        UPDATE outlook_jobs SET status=CASE WHEN status='working' THEN 'pending' ELSE status END,revision=revision+1,force_write=0 WHERE status<>'done';
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
    conn.execute("UPDATE outlook_links SET sync_enabled=1,incoming_enabled=1 WHERE task_id=?1",params![task_id])?;
    if let Some(task)=crate::repositories::tasks_get(conn,task_id)?
        && task.recurrence.get("native").is_some_and(Value::is_object) {
            conn.execute("UPDATE outlook_links SET original_occurrence_start=COALESCE(original_occurrence_start,?2) WHERE task_id=?1",params![task_id,task_original_start(&task)])?;
        }
    conn.execute("UPDATE tasks SET outlook_enabled=1 WHERE id=?1", params![task_id])?;
    conn.execute("INSERT INTO outlook_jobs(task_id,operation,payload) SELECT id,'upsert',json_object('task_id',id,'title',title,'date',date,'is_all_day',json(CASE WHEN is_all_day THEN 'true' ELSE 'false' END),'start_time',start_time,'end_time',end_time,'memo',memo,'end_date',end_date,'outlook_details',json(outlook_details),'recurrence',json(recurrence)) FROM tasks WHERE id=?1
      ON CONFLICT(task_id) DO UPDATE SET operation='upsert',payload=excluded.payload,status='pending',last_error='',force_write=0,result=NULL,attempts=0,revision=revision+1", params![task_id])?;
    Ok(())
}

/// Stop outgoing synchronization, retaining both appointments and their remote identity.
pub fn disable(conn: &Connection, task_id: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE outlook_links SET sync_enabled=0 WHERE task_id=?1",params![task_id])?;
    conn.execute("UPDATE tasks SET outlook_enabled=0 WHERE id=?1",params![task_id])?;
    conn.execute("UPDATE outlook_jobs SET status='paused',revision=revision+1,force_write=0 WHERE task_id=?1 AND status<>'done'",params![task_id])?;
    conn.execute("UPDATE outlook_jobs SET status=CASE WHEN status='working' THEN 'pending' ELSE status END,revision=revision+1,force_write=0 WHERE operation='series' AND status<>'done' AND json_extract(payload,'$.request.payload.recurrence.groupId')=(SELECT json_extract(recurrence,'$.groupId') FROM tasks WHERE id=?1) AND COALESCE(json_extract(payload,'$.request.split_date'),'0000-00-00')<=(SELECT COALESCE(json_extract(recurrence,'$.occurrenceDate'),date) FROM tasks WHERE id=?1)",params![task_id])?;
    Ok(())
}

pub fn write_enabled(conn: &Connection) -> rusqlite::Result<bool> {
    Ok(crate::repositories::settings_get(conn)?.and_then(|v|v.get("outlookWriteEnabled").and_then(Value::as_bool)).unwrap_or(false))
}

/// Rechecked by the STA worker while holding the database lock immediately before COM.
pub fn write_is_authorized(conn: &Connection, task_id: &str, operation: &str, revision: i64) -> rusqlite::Result<bool> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM outlook_job_status WHERE task_id=?1 AND operation=?2 AND revision=?3 AND status='working' AND authorized=1)",params![task_id,operation,revision],|row|row.get(0))
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Value>> {
    let mut statement = conn.prepare("SELECT task_id,operation,display_status,last_error,payload,calendar_name,result FROM outlook_job_status ORDER BY CASE display_status WHEN 'failed' THEN 0 WHEN 'pending' THEN 1 WHEN 'working' THEN 2 WHEN 'paused' THEN 3 ELSE 4 END,task_id LIMIT 200")?;
    statement.query_map([], |row| {
        let payload: String = row.get(4)?;
        let data: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
        Ok(json!({"taskId":row.get::<_,String>(0)?,"operation":row.get::<_,String>(1)?,"status":row.get::<_,String>(2)?,"error":row.get::<_,String>(3)?,"title":data.get("title").or_else(||data.pointer("/request/payload/title")),"result":row.get::<_,Option<String>>(6)?.and_then(|raw|serde_json::from_str::<Value>(&raw).ok()),"calendarName":row.get::<_,Option<String>>(5)?.map(|value|crate::outlook::calendar_label(&value))}))
    })?.collect()
}

pub fn retry(conn: &Connection, task_id: &str) -> rusqlite::Result<usize> {
    conn.execute("UPDATE outlook_jobs SET status='pending',force_write=CASE WHEN last_error LIKE '競合:%' THEN 1 ELSE 0 END,last_error='' WHERE task_id=?1 AND status='failed' AND EXISTS(SELECT 1 FROM outlook_job_status WHERE task_id=?1 AND authorized=1)",params![task_id])
}

pub fn counts(conn: &Connection) -> rusqlite::Result<Value> {
    let mut result = json!({"pending":0,"working":0,"failed":0,"paused":0,"done":0});
    let mut statement = conn.prepare("SELECT display_status,count(*) FROM outlook_job_status GROUP BY display_status")?;
    for pair in statement.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?)))? { let (status,count)=pair?;result[status]=json!(count); }
    Ok(result)
}

fn task_original_start(task:&crate::repositories::TaskRow)->String {
    let date=task.recurrence.get("occurrenceDate").and_then(Value::as_str).unwrap_or(&task.date);
    let all_day=task.recurrence.pointer("/template/isAllDay").and_then(Value::as_bool).unwrap_or(task.is_all_day);
    let time=task.recurrence.pointer("/template/startTime").and_then(Value::as_str).or(task.start_time.as_deref()).unwrap_or("00:00");
    let time=if all_day {"00:00:00".to_string()} else if time.len()==5 {format!("{time}:00")} else {time.to_string()};
    format!("{date}T{time}")
}

fn sibling_template_baseline(task:&crate::repositories::TaskRow)->Option<Value> {
    let template=task.recurrence.get("template").filter(|v|v.is_object())?;
    let date=task.recurrence.get("occurrenceDate").and_then(Value::as_str).unwrap_or(&task.date);
    let mut baseline=serde_json::to_value(task).ok()?;
    baseline["date"]=json!(date);
    baseline["title"]=json!(template.get("title").and_then(Value::as_str).unwrap_or("").trim());
    baseline["memo"]=json!(template.get("memo").and_then(Value::as_str).unwrap_or("").trim());
    let all_day=template.get("isAllDay").and_then(Value::as_bool).unwrap_or(false);
    baseline["isAllDay"]=json!(all_day);
    for name in ["startTime","endTime"] {baseline[name]=if all_day {Value::Null}else{template.get(name).cloned().unwrap_or(Value::Null)};}
    baseline["outlookDetails"]=template.get("outlookDetails").cloned().unwrap_or(json!({}));
    baseline["endDate"]=match template.get("endDate").and_then(Value::as_str) {
        None=>Value::Null,
        Some(end)=>{
            let parse=|v:&str|chrono::NaiveDate::parse_from_str(v,"%Y-%m-%d").ok();
            let days=parse(end)?.signed_duration_since(parse(template.get("date").and_then(Value::as_str)?)?);
            json!(parse(date)?.checked_add_signed(days)?.format("%Y-%m-%d").to_string())
        }
    };
    Some(baseline)
}

fn bind_series_siblings(conn:&Connection,source_id:&str,recurrence:&Value,remote:&crate::outlook::reconcile::RemoteIdentity)->rusqlite::Result<()> {
    if !remote.recurring {return Ok(())}
    let Some(group)=recurrence.get("groupId").and_then(Value::as_str).filter(|s|!s.is_empty()) else {return Ok(())};
    if !recurrence.get("native").is_some_and(Value::is_object) {return Ok(())}
    let ids:Vec<String>=conn.prepare("SELECT t.id FROM tasks t LEFT JOIN outlook_links l ON l.task_id=t.id WHERE t.id<>?1 AND json_extract(t.recurrence,'$.groupId')=?2 AND l.remote_meta IS NULL")?.query_map(params![source_id,group],|row|row.get(0))?.collect::<rusqlite::Result<_>>()?;
    for id in ids {
        let Some(task)=crate::repositories::tasks_get(conn,&id)? else {continue};
        let mut baseline_task=task.clone();
        baseline_task.recurrence=recurrence.clone();
        baseline_task.recurrence["occurrenceDate"]=task.recurrence.get("occurrenceDate").cloned().unwrap_or(json!(task.date));
        conn.execute("INSERT OR IGNORE INTO outlook_links(task_id,calendar_name,external_key,sync_enabled,original_occurrence_start) VALUES(?1,?2,(SELECT namespace FROM outlook_identity WHERE id=1)||':'||?1,?3,?4)",params![id,remote.calendar,task.outlook_enabled as i64,task_original_start(&baseline_task)])?;
        conn.execute("UPDATE outlook_links SET original_occurrence_start=COALESCE(original_occurrence_start,?2) WHERE task_id=?1",params![id,task_original_start(&baseline_task)])?;
        let mut inherited=remote.clone();inherited.imported=true;inherited.version.clear();
        inherited.occurrence_start=conn.query_row("SELECT original_occurrence_start FROM outlook_links WHERE task_id=?1",params![id],|row|row.get(0))?;
        conn.execute("UPDATE outlook_links SET entry_id=?2,store_id=?3,remote_meta=?4,last_task=COALESCE(last_task,?5) WHERE task_id=?1 AND remote_meta IS NULL",params![id,inherited.entry_id,inherited.store_id,serde_json::to_string(&inherited).unwrap(),sibling_template_baseline(&baseline_task).map(|v|v.to_string())])?;
    }
    Ok(())
}

fn inherited_series_remote(conn: &Connection, payload: &WritePayload) -> Result<Option<crate::outlook::reconcile::RemoteIdentity>,String> {
    use rusqlite::OptionalExtension;
    let Some(group)=payload.recurrence.get("groupId").and_then(Value::as_str).filter(|v|!v.is_empty()) else {return Ok(None)};
    if !payload.recurrence.get("native").is_some_and(Value::is_object) {return Ok(None)}
    let raw:Option<String>=conn.query_row("SELECT l.remote_meta FROM outlook_links l LEFT JOIN tasks t ON t.id=l.task_id WHERE l.task_id<>?1 AND COALESCE(json_extract(t.recurrence,'$.groupId'),json_extract(COALESCE(l.deleted_task,l.last_task),'$.recurrence.groupId'))=?2 AND json_extract(l.remote_meta,'$.recurring')=1 ORDER BY COALESCE(t.date,json_extract(COALESCE(l.deleted_task,l.last_task),'$.date')),t.start_time,l.rowid LIMIT 1",params![payload.task_id,group],|row|row.get(0)).optional().map_err(|e|e.to_string())?;
    let Some(raw)=raw else {return Ok(None)};
    let mut remote:crate::outlook::reconcile::RemoteIdentity=serde_json::from_str(&raw).map_err(|e|e.to_string())?;
    let (start,_)=crate::event_data::range(&payload.date,payload.end_date.as_deref(),payload.is_all_day,payload.start_time.as_deref(),payload.end_time.as_deref())?;
    let original:Option<String>=conn.query_row("SELECT original_occurrence_start FROM outlook_links WHERE task_id=?1",params![payload.task_id],|row|row.get(0)).optional().map_err(|e|e.to_string())?.flatten();
    remote.occurrence_start=Some(original.unwrap_or_else(||start.format("%Y-%m-%dT%H:%M:%S").to_string()));
    remote.imported=true;
    // Another occurrence's version is not a baseline for this one. COM still rejects
    // divergent values; a matching occurrence can converge without writing.
    remote.version.clear();
    Ok(Some(remote))
}

fn recover_first_identity(conn:&Connection,id:&str,payload:&WritePayload,identity:&crate::outlook::WriteIdentity)->Result<(),String>{
    let changed=conn.execute("UPDATE outlook_links SET entry_id=?2,store_id=?3,remote_meta=?4,source_key=?5,deleted_by_app=0 WHERE task_id=?1 AND remote_meta IS NULL",params![id,identity.entry_id,identity.store_id,identity.remote.as_ref().map(|remote|serde_json::to_string(remote).unwrap()),identity.occurrence_key]).map_err(|e|e.to_string())?;
    if changed==0 {return Ok(())}
    if let Some(task)=crate::repositories::tasks_get(conn,id).map_err(|e|e.to_string())? {
        // The write used this immutable request, not any edits made while COM completed.
        let mut baseline=serde_json::to_value(task).map_err(|e|e.to_string())?;
        for (key,value) in [("title",json!(payload.title)),("date",json!(payload.date)),("endDate",json!(payload.end_date)),("startTime",json!(payload.start_time)),("endTime",json!(payload.end_time)),("isAllDay",json!(payload.is_all_day)),("memo",json!(payload.memo)),("outlookDetails",payload.outlook_details.clone()),("recurrence",payload.recurrence.clone())] {baseline[key]=value;}
        conn.execute("UPDATE outlook_links SET last_task=?2 WHERE task_id=?1",params![id,baseline.to_string()]).map_err(|e|e.to_string())?;
    }
    if let Some(remote)=identity.remote.as_ref() {bind_series_siblings(conn,id,&payload.recurrence,remote).map_err(|e|e.to_string())?;}
    Ok(())
}

fn previous_series_result(conn:&Connection,id:&str,request:&crate::outlook::recurrence::SeriesEditRequest)->Result<Option<crate::outlook::recurrence::SeriesEditResult>,String>{
    use rusqlite::OptionalExtension;
    let raw:Option<String>=conn.query_row("SELECT result FROM outlook_series_results WHERE task_id=?1 AND json_extract(request,'$.external_key')=?2 ORDER BY revision DESC LIMIT 1",params![id,request.external_key],|row|row.get(0)).optional().map_err(|e|e.to_string())?;
    raw.map(|raw|serde_json::from_str(&raw).map_err(|e|e.to_string())).transpose()
}

fn finish_series_job(conn:&Connection,id:&str,revision:i64,request:&crate::outlook::recurrence::SeriesEditRequest,result:Result<crate::outlook::recurrence::SeriesEditResult,String>)->Result<(),String>{
    match result {
        Ok(result)=>{
            let raw=serde_json::to_string(&result).map_err(|e|e.to_string())?;
            // A confirmed remote split needs a durable mapping even when OFF or a newer edit
            // supersedes its job between COM completion and this callback.
            conn.execute("INSERT OR REPLACE INTO outlook_series_results(task_id,revision,request,result) VALUES(?1,?2,?3,?4)",params![id,revision,serde_json::to_string(request).map_err(|e|e.to_string())?,raw]).map_err(|e|e.to_string())?;
            if !write_is_authorized(conn,id,"series",revision).map_err(|e|e.to_string())? {return Ok(())}
            let tx=conn.unchecked_transaction().map_err(|e|e.to_string())?;
            if let Err(error)=crate::outlook::apply_series_result(&tx,request,&result) {
                tx.rollback().map_err(|e|e.to_string())?;
                conn.execute("UPDATE outlook_jobs SET status='failed',last_error=?3 WHERE task_id=?1 AND revision=?2",params![id,revision,error]).map_err(|e|e.to_string())?;
                return Ok(());
            }
            tx.execute("UPDATE outlook_jobs SET result=?3,status='done',last_error='',force_write=0 WHERE task_id=?1 AND revision=?2",params![id,revision,raw]).map_err(|e|e.to_string())?;
            if let Some(group)=request.payload.as_ref().and_then(|p|p.recurrence.get("groupId")).and_then(Value::as_str) {
                tx.execute("UPDATE outlook_jobs SET status='pending' WHERE status='series_wait' AND task_id IN(SELECT id FROM tasks WHERE json_extract(recurrence,'$.groupId')=?1)",params![group]).map_err(|e|e.to_string())?;
            }
            tx.commit().map_err(|e|e.to_string())?;
        },
        Err(error)=>{conn.execute("UPDATE outlook_jobs SET status='failed',last_error=?3 WHERE task_id=?1 AND revision=?2 AND status='working'",params![id,revision,error]).map_err(|e|e.to_string())?;}
    }
    Ok(())
}

// One claimed queue item. Column mapping stays next to the field names.
struct ClaimedJob {
    id: String,
    operation: String,
    payload: String,
    revision: i64,
    calendar_name: String,
    entry_id: Option<String>,
    store_id: Option<String>,
    external_key: String,
    remote_meta: Option<String>,
    force: bool,
    restore_deleted: bool,
}

impl ClaimedJob {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            operation: row.get(1)?,
            payload: row.get(2)?,
            revision: row.get(3)?,
            calendar_name: row.get(4)?,
            entry_id: row.get(5)?,
            store_id: row.get(6)?,
            external_key: row.get(7)?,
            remote_meta: row.get(8)?,
            force: row.get(9)?,
            restore_deleted: row.get(10)?,
        })
    }
}

pub async fn process_one(state: &crate::api::AppState) -> Result<bool, String> {
    let job = {
        let conn = state.conn.lock().map_err(|_| "Database lock failed")?;
        use rusqlite::OptionalExtension;
        let found = conn.query_row("SELECT j.task_id,j.operation,j.payload,j.revision,l.calendar_name,l.entry_id,l.store_id,l.external_key,l.remote_meta,j.force_write,l.deleted_by_app FROM outlook_jobs j JOIN outlook_links l ON l.task_id=j.task_id WHERE j.status='pending' AND EXISTS(SELECT 1 FROM outlook_job_status s WHERE s.task_id=j.task_id AND s.authorized=1) ORDER BY CASE j.operation WHEN 'series' THEN 0 ELSE 1 END,json_extract(j.payload,'$.date'),j.rowid LIMIT 1",[],ClaimedJob::from_row).optional().map_err(|e|e.to_string())?;
        if let Some(ClaimedJob { id, revision, .. }) = &found { conn.execute("UPDATE outlook_jobs SET status='working',attempts=attempts+1 WHERE task_id=?1 AND revision=?2",params![id,revision]).map_err(|e|e.to_string())?; }
        found
    };
    let Some(ClaimedJob { id,operation,payload,revision,calendar_name,entry_id,store_id,external_key,remote_meta,force,restore_deleted }) = job else { return Ok(false) };
    if operation=="series" {
        let request=serde_json::from_str::<Value>(&payload).map_err(|e|e.to_string()).and_then(|value|serde_json::from_value::<crate::outlook::recurrence::SeriesEditRequest>(value["request"].clone()).map_err(|e|e.to_string()));
        match request {
            Ok(request)=>{
                let saved={let conn=state.conn.lock().map_err(|_|"Database lock failed")?;previous_series_result(&conn,&id,&request)};
                let result=match saved {
                    Ok(Some(result))=>Ok(result),
                    Ok(None)=>crate::outlook::edit_series(request.clone(),crate::outlook::WriteAuthorization{conn:state.conn.clone(),revision},id.clone()).await,
                    Err(error)=>Err(error)
                };
                let conn=state.conn.lock().map_err(|_|"Database lock failed")?;
                finish_series_job(&conn,&id,revision,&request,result)?;
            },
            Err(error)=>{let conn=state.conn.lock().map_err(|_|"Database lock failed")?;conn.execute("UPDATE outlook_jobs SET status='failed',last_error=?3 WHERE task_id=?1 AND revision=?2 AND status='working'",params![id,revision,error]).map_err(|e|e.to_string())?;}
        }
        return Ok(true);
    }
    let parsed = serde_json::from_str::<WritePayload>(&payload).map_err(|e|e.to_string());
    let result = match parsed {
        Ok(payload) => {
            let remote=match remote_meta {
                Some(raw)=>serde_json::from_str(&raw).map(Some).map_err(|e|e.to_string()),
                None=>{let conn=state.conn.lock().map_err(|_|"Database lock failed")?;inherited_series_remote(&conn,&payload)}
            };
            match remote {
                Ok(remote)=>{
                    let entry_id=remote.as_ref().map(|r|r.entry_id.clone()).or(entry_id);
                    let store_id=remote.as_ref().map(|r|r.store_id.clone()).or(store_id);
                    crate::outlook::write_event(crate::outlook::WriteRequest { authorization:Some(crate::outlook::WriteAuthorization{conn:state.conn.clone(),revision}), restore_deleted,remote,force,operation: operation.clone(), payload, calendar_name, entry_id, store_id, external_key }).await
                },Err(error)=>Err(error)
            }
        },
        Err(error) => Err(error),
    };
    let conn = state.conn.lock().map_err(|_| "Database lock failed")?;
    // OFF, a newer edit, or an Undo may supersede the claimed operation while it runs.
    // Never let its completion overwrite the newer link or job state.
    if !write_is_authorized(&conn,&id,&operation,revision).map_err(|e|e.to_string())? {
        if operation=="upsert" && let Ok(identity)=&result && let Ok(request)=serde_json::from_str::<WritePayload>(&payload) {
            recover_first_identity(&conn,&id,&request,identity)?;
        }
        return Ok(true);
    }
    match result {
        Ok(identity) => {
            if operation == "upsert" {
                conn.execute("UPDATE outlook_links SET entry_id=?2,store_id=?3,remote_meta=?4,source_key=?5,deleted_by_app=0 WHERE task_id=?1",params![id,identity.entry_id,identity.store_id,identity.remote.as_ref().map(|meta|serde_json::to_string(meta).unwrap()),identity.occurrence_key]).map_err(|e|e.to_string())?;
                conn.execute("UPDATE tasks SET outlook_occurrence_key=?2,outlook_series_id=?3 WHERE id=?1 AND outlook_enabled=1 AND EXISTS(SELECT 1 FROM outlook_links WHERE task_id=?1)",params![id,identity.occurrence_key,identity.series_id]).map_err(|e|e.to_string())?;
                if let Some(task)=crate::repositories::tasks_get(&conn,&id).map_err(|e|e.to_string())? {
                    conn.execute("UPDATE outlook_links SET last_task=?2 WHERE task_id=?1",params![id,serde_json::to_string(&task).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
                    if let Some(remote)=identity.remote.as_ref() {bind_series_siblings(&conn,&task.id,&task.recurrence,remote).map_err(|e|e.to_string())?;}
                }
            }
            // Preserve an earlier confirmed deletion across ON/OFF changes
            // that complete as a no-op. Only a successful restore clears it.
            if operation=="delete" {conn.execute("UPDATE outlook_links SET deleted_by_app=MAX(deleted_by_app,?2) WHERE task_id=?1",params![id,identity.deleted_existing as i64]).map_err(|e|e.to_string())?;}
            conn.execute("UPDATE outlook_jobs SET status='done',last_error='',force_write=0 WHERE task_id=?1 AND revision=?2",params![id,revision]).map_err(|e|e.to_string())?;
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
        let event = crate::outlook::OutlookEvent { end_date:None,outlook_details:json!({}),title:"Remote old".into(),date:"2026-10-07".into(),start_time:Some("15:00".into()),end_time:Some("16:00".into()),location:String::new(),is_all_day:false,outlook_series_id:"series".into(),outlook_occurrence_key:format!("tcplus:{key}"),is_recurring:false,recurrence:json!({"type":"none"}),remote:None,meeting_url:None};
        let range = crate::outlook::OutlookSyncRange::dates("2026-10-07","2026-10-07").unwrap();
        crate::repositories::outlook_sync_in_range(&conn,&[event],"",range).unwrap();
        let rows = crate::repositories::tasks_list(&conn).unwrap();
        assert_eq!(rows.len(),1); assert_eq!(rows[0].title,"Local edit");
        crate::repositories::outlook_sync_in_range(&conn,&[],"",range).unwrap();
        assert_eq!(crate::repositories::tasks_list(&conn).unwrap().len(),1);
    }
    #[test]
    fn inbound_fetch_never_deletes_or_rolls_back_app_managed_records() {
        let conn = Connection::open_in_memory().unwrap(); crate::db::migrate(&conn,"2026-10").unwrap();
        crate::repositories::settings_set(&conn,&json!({"outlookWriteCalendarName":"Calendar B"})).unwrap();
        let input=serde_json::from_value(json!({"id":"a","title":"New local state","date":"2026-10-07","startTime":"15:00","endTime":"16:00","outlookEnabled":true})).unwrap();
        crate::repositories::tasks_insert(&conn,input).unwrap();
        let key: String=conn.query_row("SELECT external_key FROM outlook_links WHERE task_id='a'",[],|row|row.get(0)).unwrap();
        conn.execute("UPDATE tasks SET outlook_occurrence_key=?1,outlook_series_id='series' WHERE id='a'",params![format!("tcplus:{key}")]).unwrap();
        conn.execute("UPDATE outlook_jobs SET status='done'",[]).unwrap();
        let old=crate::outlook::OutlookEvent { end_date:None,outlook_details:json!({}),title:"Old fetched state".into(),date:"2026-10-07".into(),start_time:Some("15:00".into()),end_time:Some("16:00".into()),location:String::new(),is_all_day:false,outlook_series_id:"series".into(),outlook_occurrence_key:format!("tcplus:{key}"),is_recurring:false,recurrence:json!({"type":"none"}),remote:None,meeting_url:None};
        let range=crate::outlook::OutlookSyncRange::dates("2026-10-07","2026-10-07").unwrap();
        crate::repositories::outlook_sync_in_range(&conn,&[old],"",range).unwrap();
        assert_eq!(crate::repositories::tasks_list(&conn).unwrap()[0].title,"New local state","a delayed snapshot after completed Upsert cannot roll back local state");
        crate::repositories::outlook_sync_in_range(&conn,&[],"",range).unwrap();
        assert_eq!(crate::repositories::tasks_list(&conn).unwrap().len(),1,"fetching another calendar or moving remote event out of range cannot delete an app-owned record");
        assert_eq!(list(&conn).unwrap()[0]["status"],"done","read-side reconciliation must not enqueue outbound mutation");
    }
}

#[cfg(test)]
mod selection_tests {
    use super::*;
    use crate::repositories as repo;
    fn fixture(enabled: bool) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn,"2026-10").unwrap();
        repo::tasks_insert(&conn,serde_json::from_value(json!({"id":"a","title":"Task","date":"2026-10-09","startTime":"09:00","endTime":"10:00","outlookEnabled":enabled})).unwrap()).unwrap();
        conn
    }
    fn update(conn: &Connection, enabled: Option<bool>) -> repo::TaskRow {
        let mut value=serde_json::to_value(&repo::tasks_list(conn).unwrap()[0]).unwrap();
        if let Some(enabled)=enabled { value["outlookEnabled"]=json!(enabled); }
        else { value.as_object_mut().unwrap().remove("outlookEnabled"); }
        repo::tasks_update(conn,"a",serde_json::from_value(value).unwrap()).unwrap().unwrap()
    }
    #[test]
    fn existing_task_can_enable_then_disable_and_reenable_outlook() {
        let conn=fixture(false);
        assert!(update(&conn,Some(true)).outlook_enabled);
        let key: String=conn.query_row("SELECT external_key FROM outlook_links WHERE task_id='a'",[],|r|r.get(0)).unwrap();
        assert_eq!(list(&conn).unwrap()[0]["operation"],"upsert");
        conn.execute("UPDATE outlook_jobs SET status='failed',last_error='failure'",[]).unwrap();
        assert!(!update(&conn,Some(false)).outlook_enabled);
        assert_eq!(repo::tasks_list(&conn).unwrap().len(),1);
        assert_eq!(list(&conn).unwrap()[0]["operation"],"upsert");
        assert_eq!(list(&conn).unwrap()[0]["status"],"paused");
        let revision: i64=conn.query_row("SELECT revision FROM outlook_jobs",[],|r|r.get(0)).unwrap();
        update(&conn,Some(false));
        assert_eq!(conn.query_row("SELECT revision FROM outlook_jobs",[],|r|r.get::<_,i64>(0)).unwrap(),revision);
        assert!(update(&conn,Some(true)).outlook_enabled);
        assert_eq!(list(&conn).unwrap()[0]["operation"],"upsert");
        assert_eq!(conn.query_row("SELECT external_key FROM outlook_links",[],|r|r.get::<_,String>(0)).unwrap(),key);
    }
    #[test]
    fn omitted_selection_preserves_enabled_task_and_local_task_has_no_job() {
        let conn=fixture(true);
        assert!(update(&conn,None).outlook_enabled);
        let conn=fixture(false);
        assert!(!update(&conn,Some(false)).outlook_enabled);
        assert!(list(&conn).unwrap().is_empty());
    }
    #[test]
    fn enabling_imported_task_protects_local_changes_from_old_snapshot() {
        let conn=fixture(false);
        conn.execute("UPDATE tasks SET outlook_occurrence_key='external-key',outlook_series_id='external-series'",[]).unwrap();
        let input=serde_json::from_value(json!({"title":"Local change","date":"2026-10-09","startTime":"09:00","endTime":"10:00","outlookEnabled":true})).unwrap();
        repo::tasks_update(&conn,"a",input).unwrap();
        let event=crate::outlook::OutlookEvent { end_date:None,outlook_details:json!({}),title:"Task".into(),date:"2026-10-09".into(),start_time:Some("09:00".into()),end_time:Some("10:00".into()),location:String::new(),is_all_day:false,outlook_series_id:"external-series".into(),outlook_occurrence_key:"external-key".into(),is_recurring:false,recurrence:json!({"type":"none"}),remote:None,meeting_url:None};
        let range=crate::outlook::OutlookSyncRange::dates("2026-10-09","2026-10-09").unwrap();
        repo::outlook_sync_in_range(&conn,&[event],"",range).unwrap();
        let rows=repo::tasks_list(&conn).unwrap();
        assert_eq!(rows.iter().find(|t|t.id=="a").unwrap().title,"Local change");
        assert_eq!(list(&conn).unwrap()[0]["title"],"Local change");
    }
    #[test]
    fn imported_snapshot_cannot_rekey_completed_managed_task() {
        let conn=fixture(true);
        let key: String=conn.query_row("SELECT external_key FROM outlook_links WHERE task_id='a'",[],|r|r.get(0)).unwrap();
        let managed_key=format!("tcplus:{key}");
        conn.execute("UPDATE tasks SET outlook_occurrence_key=?1,outlook_series_id='managed-series'",params![managed_key]).unwrap();
        conn.execute("UPDATE outlook_jobs SET status='done'",[]).unwrap();
        let mut event=crate::outlook::OutlookEvent { end_date:None,outlook_details:json!({}),title:"Task".into(),date:"2026-10-09".into(),start_time:Some("09:00".into()),end_time:Some("10:00".into()),location:String::new(),is_all_day:false,outlook_series_id:"external-series".into(),outlook_occurrence_key:"external-key".into(),is_recurring:false,recurrence:json!({"type":"none"}),remote:None,meeting_url:None};
        let range=crate::outlook::OutlookSyncRange::dates("2026-10-09","2026-10-09").unwrap();
        repo::outlook_sync_in_range(&conn,&[event.clone()],"",range).unwrap();
        assert_eq!(repo::tasks_list(&conn).unwrap()[0].outlook_occurrence_key.as_deref(),Some(managed_key.as_str()));
        event.title="External edit".into();
        repo::outlook_sync_in_range(&conn,&[event],"",range).unwrap();
        assert_eq!(repo::tasks_list(&conn).unwrap().iter().find(|t|t.id=="a").unwrap().title,"Task");
        assert_eq!(list(&conn).unwrap()[0]["status"],"done");
    }
    #[test]
    fn omitted_batch_selection_preserves_registration() {
        let conn=fixture(true);
        let current=repo::tasks_list(&conn).unwrap().remove(0);
        let mut task=serde_json::to_value(&current).unwrap();
        task.as_object_mut().unwrap().remove("outlookEnabled");
        task["title"]=json!("Edited without selection");
        let input=serde_json::from_value(json!({"upserts":[task],"deleteIds":[],"expected":[{"id":"a","updatedAt":current.updated_at}]})).unwrap();
        assert!(repo::tasks_batch(&conn,input).is_ok());
        assert!(repo::tasks_list(&conn).unwrap()[0].outlook_enabled);
        assert_eq!(list(&conn).unwrap()[0]["operation"],"upsert");
    }
    #[test]
    fn disabled_task_survives_inbound_sync_after_remote_delete() {
        let conn=fixture(true);
        conn.execute("UPDATE tasks SET outlook_occurrence_key='tcplus:test',outlook_series_id='series'",[]).unwrap();
        update(&conn,Some(false));
        conn.execute("UPDATE outlook_jobs SET status='done'",[]).unwrap();
        let range=crate::outlook::OutlookSyncRange::dates("2026-10-09","2026-10-09").unwrap();
        repo::outlook_sync_in_range(&conn,&[],"",range).unwrap();
        let task=repo::tasks_list(&conn).unwrap().remove(0);
        assert!(!task.outlook_enabled);
        assert_eq!(task.outlook_occurrence_key.as_deref(),Some("tcplus:test"));
        assert_eq!(task.outlook_series_id.as_deref(),Some("series"));
    }
    #[test]
    fn selection_and_task_changes_roll_back_when_job_cannot_be_saved() {
        let conn=fixture(false);
        conn.execute_batch("CREATE TRIGGER reject_outlook_job BEFORE INSERT ON outlook_jobs BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
        let input=serde_json::from_value(json!({"title":"Must roll back","date":"2026-10-09","outlookEnabled":true})).unwrap();
        assert!(repo::tasks_update(&conn,"a",input).is_err());
        let task=repo::tasks_list(&conn).unwrap().remove(0);
        assert_eq!(task.title,"Task");
        assert!(!task.outlook_enabled);
        assert_eq!(conn.query_row("SELECT count(*) FROM outlook_links",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
    #[test]
    fn batch_edit_and_undo_restore_outlook_selection() {
        let conn=fixture(false);
        for enabled in [true,false,true] {
            let current=repo::tasks_list(&conn).unwrap().remove(0);
            let mut task=serde_json::to_value(&current).unwrap();task["outlookEnabled"]=json!(enabled);
            let input=serde_json::from_value(json!({"upserts":[task],"deleteIds":[],"expected":[{"id":"a","updatedAt":current.updated_at}]})).unwrap();
            assert!(repo::tasks_batch(&conn,input).is_ok());
            assert_eq!(repo::tasks_list(&conn).unwrap()[0].outlook_enabled,enabled);
            assert_eq!(list(&conn).unwrap()[0]["operation"],"upsert");
        }
    }
}


#[cfg(test)]
mod outbound_gate_tests {
    use super::*;
    fn fixture(global: Option<bool>, task: bool) -> Connection {
        let conn=Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn,"2026-10").unwrap();
        if let Some(value)=global { crate::repositories::settings_set(&conn,&json!({"outlookWriteEnabled":value})).unwrap(); }
        crate::repositories::tasks_insert(&conn,serde_json::from_value(json!({"id":"gate","title":"Original","date":"2026-10-09","outlookEnabled":task})).unwrap()).unwrap();
        conn
    }
    #[test]
    fn outgoing_write_requires_both_gates_and_current_claim() {
        for (global,task,want) in [(false,false,false),(false,true,false),(true,false,false),(true,true,true)] {
            let conn=fixture(Some(global),true);
            if !task { disable(&conn,"gate").unwrap(); }
            // Even a manually retried/stale job must not bypass either flag at the COM boundary.
            conn.execute("UPDATE outlook_jobs SET status='working'",[]).unwrap();
            let revision:i64=conn.query_row("SELECT revision FROM outlook_jobs",[],|r|r.get(0)).unwrap();
            assert_eq!(write_is_authorized(&conn,"gate","upsert",revision).unwrap(),want);
            assert!(!write_is_authorized(&conn,"gate","upsert",revision-1).unwrap());
            assert!(!write_is_authorized(&conn,"gate","delete",revision).unwrap());
        }
    }
    #[test]
    fn deleted_task_requires_previous_enabled_link_and_global_permission() {
        let conn=fixture(Some(true),true);
        conn.execute("DELETE FROM tasks WHERE id='gate'",[]).unwrap();
        conn.execute("UPDATE outlook_jobs SET status='working'",[]).unwrap();
        let revision:i64=conn.query_row("SELECT revision FROM outlook_jobs",[],|r|r.get(0)).unwrap();
        assert!(write_is_authorized(&conn,"gate","delete",revision).unwrap());
        crate::repositories::settings_set(&conn,&json!({"outlookWriteEnabled":false})).unwrap();
        assert!(!write_is_authorized(&conn,"gate","delete",revision).unwrap());
        assert_eq!(list(&conn).unwrap()[0]["status"],"paused");
        crate::repositories::settings_set(&conn,&json!({"outlookWriteEnabled":true})).unwrap();
        conn.execute("UPDATE outlook_jobs SET status='working'",[]).unwrap();
        let current:i64=conn.query_row("SELECT revision FROM outlook_jobs",[],|r|r.get(0)).unwrap();
        assert!(write_is_authorized(&conn,"gate","delete",current).unwrap());
        conn.execute("UPDATE outlook_links SET sync_enabled=0",[]).unwrap();
        assert!(!write_is_authorized(&conn,"gate","delete",current).unwrap());
    }
    #[test]
    fn disabled_task_deletion_never_schedules_remote_delete() {
        let conn=fixture(Some(true),true);
        disable(&conn,"gate").unwrap();
        conn.execute("DELETE FROM tasks WHERE id='gate'",[]).unwrap();
        assert_eq!(list(&conn).unwrap()[0]["operation"],"upsert");
        assert_eq!(list(&conn).unwrap()[0]["status"],"paused");
    }
    #[test]
    fn task_off_preserves_remote_identity_and_invalidates_working_job() {
        let conn=fixture(Some(true),true);
        conn.execute("UPDATE outlook_links SET entry_id='remote',store_id='store',source_key='source'",[]).unwrap();
        conn.execute("UPDATE tasks SET outlook_occurrence_key='source',outlook_series_id='series'",[]).unwrap();
        conn.execute("UPDATE outlook_jobs SET status='working'",[]).unwrap();
        let before:i64=conn.query_row("SELECT revision FROM outlook_jobs",[],|r|r.get(0)).unwrap();
        disable(&conn,"gate").unwrap();
        let after:i64=conn.query_row("SELECT revision FROM outlook_jobs",[],|r|r.get(0)).unwrap();
        assert!(after>before,"OFF must invalidate an already claimed write");
        let job=&list(&conn).unwrap()[0];
        assert_eq!(job["operation"],"upsert","OFF does not schedule deletion");
        assert_eq!(job["status"],"paused");
        let identity:(String,String,String)=conn.query_row("SELECT l.entry_id,t.outlook_occurrence_key,t.outlook_series_id FROM outlook_links l JOIN tasks t ON t.id=l.task_id",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(identity,("remote".into(),"source".into(),"series".into()));
        assert_eq!(retry(&conn,"gate").unwrap(),0);
        conn.execute("UPDATE tasks SET title='Latest while off'",[]).unwrap();
        enable(&conn,"gate").unwrap();
        assert_eq!(list(&conn).unwrap()[0]["title"],"Latest while off");
    }
    #[test]
    fn global_gate_pauses_pending_work_until_explicitly_enabled() {
        for value in [None,Some(false)] {
            let conn=fixture(value,true);
            assert_eq!(counts(&conn).unwrap()["paused"],1);
            assert_eq!(list(&conn).unwrap()[0]["status"],"paused");
            conn.execute("UPDATE tasks SET title='Latest paused change'",[]).unwrap();
            crate::repositories::settings_set(&conn,&json!({"outlookWriteEnabled":true})).unwrap();
            assert_eq!(list(&conn).unwrap()[0]["status"],"pending");
            assert_eq!(list(&conn).unwrap()[0]["title"],"Latest paused change");
        }
    }
    #[test]
    fn global_off_invalidates_working_revision_and_retry_cannot_bypass() {
        let conn=fixture(Some(true),true);
        conn.execute("UPDATE outlook_jobs SET status='working'",[]).unwrap();
        let before:i64=conn.query_row("SELECT revision FROM outlook_jobs",[],|r|r.get(0)).unwrap();
        crate::repositories::settings_set(&conn,&json!({"outlookWriteEnabled":false})).unwrap();
        assert!(conn.query_row("SELECT revision FROM outlook_jobs",[],|r|r.get::<_,i64>(0)).unwrap()>before);
        conn.execute("UPDATE outlook_jobs SET status='failed',last_error='failure'",[]).unwrap();
        assert_eq!(retry(&conn,"gate").unwrap(),0);
    }
}


#[cfg(test)]
mod recurrence_queue_tests {
    use super::*;
    use crate::outlook::{recurrence::{SeriesEditRequest,SeriesEditResult},reconcile::RemoteIdentity};
    fn fixture()->Connection {
        let conn=Connection::open_in_memory().unwrap();crate::db::migrate(&conn,"2026-10").unwrap();
        crate::repositories::settings_set(&conn,&json!({"outlookWriteEnabled":true})).unwrap();
        for (id,date) in [("first","2026-10-09"),("second","2026-10-16")] {
            conn.execute("INSERT INTO tasks(id,title,date,start_time,end_time,recurrence,created_at,updated_at) VALUES(?1,'Weekly',?2,'09:00','10:00',?3,'x','x')",params![id,date,json!({"type":"native","groupId":"g","occurrenceDate":date,"native":{"recurrenceType":1,"patternStartDate":"2026-10-09"}}).to_string()]).unwrap();
            enable(&conn,id).unwrap();
        }
        conn
    }
    fn payload(conn:&Connection,id:&str)->WritePayload {
        let raw:String=conn.query_row("SELECT payload FROM outlook_jobs WHERE task_id=?1",params![id],|row|row.get(0)).unwrap();serde_json::from_str(&raw).unwrap()
    }
    fn coordinator(conn:&Connection,split:Option<&str>)->SeriesEditRequest {
        let request=SeriesEditRequest{entry_id:"master".into(),store_id:"store".into(),expected_rule:json!({}),rule:json!({}),scope:if split.is_some(){"future"}else{"all"}.into(),split_date:split.map(str::to_string),external_key:"series-operation".into(),payload:Some(payload(conn,"second"))};
        conn.execute("INSERT INTO outlook_links(task_id,calendar_name,external_key,sync_enabled) VALUES('coordinator','Calendar','series-operation',1)",[]).unwrap();
        conn.execute("INSERT INTO outlook_jobs(task_id,operation,payload,status) VALUES('coordinator','series',?1,'working')",params![json!({"request":request}).to_string()]).unwrap();
        request
    }
    fn bind_first(conn:&Connection) {
        let remote=RemoteIdentity{imported:false,calendar:"Calendar".into(),entry_id:"master".into(),store_id:"store".into(),series_id:"global-series".into(),occurrence_start:Some("2026-10-09T09:00:00".into()),recurring:true,read_only:None,version:"first-version".into()};
        let task=crate::repositories::tasks_get(conn,"first").unwrap().unwrap();
        conn.execute("UPDATE outlook_links SET remote_meta=?1,last_task=?2 WHERE task_id='first'",params![serde_json::to_string(&remote).unwrap(),serde_json::to_string(&task).unwrap()]).unwrap();
    }
    #[test]
    fn native_rule_is_queued_and_precreation_edits_refresh_it() {
        let conn=fixture();assert_eq!(payload(&conn,"first").recurrence["native"]["recurrenceType"],1);
        conn.execute("UPDATE tasks SET recurrence=json_set(recurrence,'$.native.interval',2) WHERE id='first'",[]).unwrap();
        assert_eq!(payload(&conn,"first").recurrence["native"]["interval"],2);
        bind_first(&conn);conn.execute("UPDATE outlook_jobs SET status='done' WHERE task_id='first'",[]).unwrap();
        conn.execute("UPDATE tasks SET recurrence=json_set(recurrence,'$.native.interval',3) WHERE id='first'",[]).unwrap();
        assert_eq!(conn.query_row("SELECT status FROM outlook_jobs WHERE task_id='first'",[],|row|row.get::<_,String>(0)).unwrap(),"done","bound series rule updates use explicit series queue");
    }
    #[test]
    fn later_occurrence_reuses_live_or_deleted_sibling_identity_and_original_start() {
        let conn=fixture();bind_first(&conn);
        conn.execute("UPDATE tasks SET date='2026-10-17',start_time='11:00',end_time='12:00' WHERE id='second'",[]).unwrap();
        let task=payload(&conn,"second");
        for delete_leader in [false,true] {
            if delete_leader {conn.execute("DELETE FROM tasks WHERE id='first'",[]).unwrap();}
            let inherited=inherited_series_remote(&conn,&task).unwrap().unwrap();
            assert_eq!(inherited.entry_id,"master");assert_eq!(inherited.series_id,"global-series");assert_eq!(inherited.occurrence_start.as_deref(),Some("2026-10-16T09:00:00"));
            assert!(inherited.imported);assert!(inherited.version.is_empty());
            assert!(conn.query_row("SELECT source_key FROM outlook_links WHERE task_id='second'",[],|row|row.get::<_,Option<String>>(0)).unwrap().is_none());
        }
    }
    #[test]
    fn confirmed_master_binds_off_siblings_without_sending_and_keeps_template_baseline() {
        let conn=fixture();
        let template=json!({"title":"Weekly","date":"2026-10-09","endDate":"2026-10-10","startTime":"09:00","endTime":"10:00","memo":"Original","isAllDay":false,"outlookDetails":{"location":"Room"}});
        conn.execute("UPDATE tasks SET recurrence=json_set(recurrence,'$.template',json(?1))",params![template.to_string()]).unwrap();
        disable(&conn,"second").unwrap();conn.execute("DELETE FROM outlook_links WHERE task_id='second'",[]).unwrap();
        conn.execute("UPDATE tasks SET title='Edited while off',date='2026-10-17',start_time='11:00',end_time='12:00' WHERE id='second'",[]).unwrap();
        bind_first(&conn);
        let source=crate::repositories::tasks_get(&conn,"first").unwrap().unwrap();
        let remote=inherited_series_remote(&conn,&payload(&conn,"second")).unwrap().unwrap();
        bind_series_siblings(&conn,&source.id,&source.recurrence,&remote).unwrap();
        let (enabled,raw,baseline):(bool,String,String)=conn.query_row("SELECT sync_enabled,remote_meta,last_task FROM outlook_links WHERE task_id='second'",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
        assert!(!enabled);assert!(!crate::repositories::tasks_get(&conn,"second").unwrap().unwrap().outlook_enabled);
        assert_eq!(serde_json::from_str::<Value>(&raw).unwrap()["occurrence_start"],"2026-10-16T09:00:00");
        let baseline:Value=serde_json::from_str(&baseline).unwrap();assert_eq!(baseline["title"],"Weekly");assert_eq!(baseline["date"],"2026-10-16");assert_eq!(baseline["endDate"],"2026-10-17");assert_eq!(baseline["memo"],"Original");
        assert_eq!(conn.query_row("SELECT status FROM outlook_jobs WHERE task_id='second'",[],|row|row.get::<_,String>(0)).unwrap(),"paused");
    }
    #[test]
    fn superseded_first_success_keeps_identity_and_original_baseline_without_completing_new_edit() {
        let conn=fixture();let original=payload(&conn,"first");
        conn.execute("UPDATE tasks SET title='Newer local title' WHERE id='first'",[]).unwrap();
        bind_first(&conn);
        let raw:String=conn.query_row("SELECT remote_meta FROM outlook_links WHERE task_id='first'",[],|row|row.get(0)).unwrap();
        let remote:RemoteIdentity=serde_json::from_str(&raw).unwrap();
        conn.execute("UPDATE outlook_links SET remote_meta=NULL,last_task=NULL WHERE task_id='first'",[]).unwrap();
        let identity=crate::outlook::WriteIdentity{entry_id:remote.entry_id.clone(),store_id:remote.store_id.clone(),series_id:remote.series_id.clone(),occurrence_key:"saved-first".into(),remote:Some(remote),..Default::default()};
        recover_first_identity(&conn,"first",&original,&identity).unwrap();
        let raw:String=conn.query_row("SELECT last_task FROM outlook_links WHERE task_id='first'",[],|row|row.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&raw).unwrap()["title"],"Weekly");
        assert_eq!(crate::repositories::tasks_get(&conn,"first").unwrap().unwrap().title,"Newer local title");
        assert_eq!(conn.query_row("SELECT status FROM outlook_jobs WHERE task_id='first'",[],|row|row.get::<_,String>(0)).unwrap(),"pending");
        assert!(conn.query_row("SELECT remote_meta IS NOT NULL FROM outlook_links WHERE task_id='second'",[],|row|row.get::<_,bool>(0)).unwrap());
        conn.execute("UPDATE outlook_links SET entry_id='newer-identity' WHERE task_id='first'",[]).unwrap();
        recover_first_identity(&conn,"first",&original,&identity).unwrap();
        assert_eq!(conn.query_row("SELECT entry_id FROM outlook_links WHERE task_id='first'",[],|row|row.get::<_,String>(0)).unwrap(),"newer-identity");
    }
    #[test]
    fn series_gate_checks_every_affected_member_and_blocks_children() {
        let conn=fixture();coordinator(&conn,None);
        assert!(write_is_authorized(&conn,"coordinator","series",1).unwrap());
        assert_eq!(list(&conn).unwrap().iter().find(|j|j["taskId"]=="second").unwrap()["status"],"paused");
        disable(&conn,"second").unwrap();
        assert!(!write_is_authorized(&conn,"coordinator","series",1).unwrap());
        let revision:i64=conn.query_row("SELECT revision FROM outlook_jobs WHERE task_id='coordinator'",[],|row|row.get(0)).unwrap();assert!(revision>1);
        enable(&conn,"second").unwrap();conn.execute("UPDATE outlook_jobs SET status='working' WHERE task_id='coordinator'",[]).unwrap();
        assert!(write_is_authorized(&conn,"coordinator","series",revision).unwrap());
        conn.execute("DELETE FROM tasks",[]).unwrap();assert!(!write_is_authorized(&conn,"coordinator","series",revision).unwrap());
    }
    #[test]
    fn future_series_gate_excludes_earlier_disabled_occurrences() {
        let conn=fixture();disable(&conn,"first").unwrap();coordinator(&conn,Some("2026-10-16"));
        assert!(write_is_authorized(&conn,"coordinator","series",1).unwrap());
        conn.execute("UPDATE tasks SET date='2026-10-08' WHERE id='second'",[]).unwrap();
        disable(&conn,"second").unwrap();assert!(!write_is_authorized(&conn,"coordinator","series",1).unwrap());
    }
    #[test]
    fn superseded_series_success_keeps_durable_mapping_without_releasing_children() {
        let conn=fixture();let request=coordinator(&conn,None);
        conn.execute("UPDATE outlook_jobs SET status='series_wait' WHERE task_id='second'",[]).unwrap();
        disable(&conn,"first").unwrap();
        let result=SeriesEditResult{old_entry_id:"old".into(),old_store_id:"store".into(),new_entry_id:"new".into(),new_store_id:"store".into(),new_series_id:"new-series".into(),rule:json!({"interval":2}),affected_from:Some("2026-10-16".into())};
        finish_series_job(&conn,"coordinator",1,&request,Ok(result)).unwrap();
        let raw:String=conn.query_row("SELECT result FROM outlook_series_results WHERE task_id='coordinator' AND revision=1",[],|row|row.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&raw).unwrap()["new_entry_id"],"new");
        assert_eq!(previous_series_result(&conn,"coordinator",&request).unwrap().unwrap().new_entry_id,"new");
        let mut another=request.clone();another.external_key="another-operation".into();
        assert!(previous_series_result(&conn,"coordinator",&another).unwrap().is_none());
        assert_eq!(conn.query_row("SELECT status FROM outlook_jobs WHERE task_id='second'",[],|row|row.get::<_,String>(0)).unwrap(),"series_wait");
    }
}
