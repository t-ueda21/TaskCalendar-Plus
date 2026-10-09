use super::*;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct RemoteIdentity {
    #[serde(default)]
    pub imported: bool,
    pub calendar: String,
    pub entry_id: String,
    pub store_id: String,
    pub series_id: String,
    pub occurrence_start: Option<String>,
    pub recurring: bool,
    pub read_only: Option<String>,
    pub version: String,
}
#[derive(Debug, Clone)]
pub struct Tracked {
    pub id: String,
    pub task_revision: Option<String>,
    pub job_revision: i64,
    pub job_status: String,
    pub operation: String,
    pub external_key: String,
    pub calendar: String,
    pub entry_id: Option<String>,
    pub store_id: Option<String>,
    pub remote: Option<RemoteIdentity>,
    pub enabled: bool,
    pub subscribed: bool,
    pub source_key: Option<String>,
}
#[derive(Debug, Clone)]
pub enum RemoteState {
    Present(Box<OutlookEvent>, RemoteIdentity),
    Removed,
    Unknown(String),
}
#[derive(Debug, Clone)]
pub struct Observation {
    pub track: Tracked,
    pub state: RemoteState,
}
#[derive(Default, Serialize, Debug)]
pub struct ReconcileResult {
    pub updated: usize,
    pub deleted: usize,
    pub restored: usize,
    pub conflicts: usize,
    pub warnings: Vec<String>,
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    for (table, column, kind) in [
        ("outlook_links", "remote_meta", "TEXT"),
        ("outlook_links", "last_task", "TEXT"),
        (
            "outlook_links",
            "deleted_by_app",
            "INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "outlook_links",
            "sync_enabled",
            "INTEGER NOT NULL DEFAULT 1",
        ),
        ("outlook_links", "source_key", "TEXT"),
        ("outlook_jobs", "force_write", "INTEGER NOT NULL DEFAULT 0"),
        ("tasks", "outlook_calendar_ref", "TEXT"),
    ] {
        let exists: bool = conn.query_row(
            &format!("SELECT count(*)>0 FROM pragma_table_info('{table}') WHERE name=?1"),
            [column],
            |r| r.get(0),
        )?;
        if !exists {
            conn.execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} {kind}"),
                [],
            )?;
            if column == "sync_enabled" {
                conn.execute("UPDATE outlook_links SET sync_enabled=COALESCE((SELECT outlook_enabled FROM tasks WHERE id=outlook_links.task_id),0)",[])?;
            }
        }
    }
    conn.execute("UPDATE outlook_links SET source_key=COALESCE((SELECT outlook_occurrence_key FROM tasks WHERE id=outlook_links.task_id),json_extract(last_task,'$.outlookOccurrenceKey'),CASE WHEN COALESCE(json_extract(remote_meta,'$.imported'),0)=0 THEN 'tcplus:'||external_key END) WHERE source_key IS NULL",[])?;
    conn.execute_batch("CREATE TRIGGER IF NOT EXISTS outlook_keep_deleted_snapshot BEFORE DELETE ON tasks WHEN EXISTS(SELECT 1 FROM outlook_links WHERE task_id=OLD.id) BEGIN
        UPDATE outlook_links SET last_task=json_object('id',OLD.id,'title',OLD.title,'date',OLD.date,'startTime',OLD.start_time,'endTime',OLD.end_time,'isAllDay',json(CASE WHEN OLD.is_all_day THEN 'true' ELSE 'false' END),'tagId',OLD.tag_id,'memo',OLD.memo,'recurrence',json(CASE WHEN json_valid(OLD.recurrence) THEN OLD.recurrence ELSE '{}' END),'outlookOccurrenceKey',OLD.outlook_occurrence_key,'createdAt',OLD.created_at,'updatedAt',OLD.updated_at) WHERE task_id=OLD.id;
      END;")?;
    Ok(())
}
pub fn capture(conn: &Connection) -> rusqlite::Result<Vec<Tracked>> {
    conn.prepare("SELECT l.task_id,t.updated_at,COALESCE(j.revision,0),COALESCE(j.status,'done'),COALESCE(j.operation,'upsert'),l.external_key,l.calendar_name,l.entry_id,l.store_id,l.remote_meta,COALESCE(t.outlook_enabled,0),COALESCE(t.outlook_occurrence_key,l.source_key,json_extract(l.last_task,'$.outlookOccurrenceKey')),l.sync_enabled FROM outlook_links l LEFT JOIN tasks t ON t.id=l.task_id LEFT JOIN outlook_jobs j ON j.task_id=l.task_id")?
      .query_map([],|r| {let raw:Option<String>=r.get(9)?;Ok(Tracked{id:r.get(0)?,task_revision:r.get(1)?,job_revision:r.get(2)?,job_status:r.get(3)?,operation:r.get(4)?,external_key:r.get(5)?,calendar:r.get(6)?,entry_id:r.get(7)?,store_id:r.get(8)?,remote:raw.and_then(|v|serde_json::from_str(&v).ok()),enabled:r.get::<_,i64>(10)?!=0,source_key:r.get(11)?,subscribed:r.get(12)?})})?.collect()
}
pub fn apply(conn: &Connection, observations: &[Observation]) -> rusqlite::Result<ReconcileResult> {
    let transaction = if conn.is_autocommit() {
        Some(conn.unchecked_transaction()?)
    } else {
        None
    };
    let tx = conn;
    let mut result = ReconcileResult::default();
    let mut current_by_id: std::collections::HashMap<_, _> = capture(tx)?
        .into_iter()
        .map(|row| (row.id.clone(), row))
        .collect();
    for observation in observations {
        let track = &observation.track;
        let current = current_by_id.remove(&track.id);
        let Some(current) = current else { continue };
        if current.task_revision != track.task_revision
            || current.job_revision != track.job_revision
            || current.job_status != track.job_status
        {
            result.conflicts += 1;
            continue;
        }
        if !current.subscribed {
            continue;
        }
        if let RemoteState::Unknown(error) = &observation.state {
            result.warnings.push(error.clone());
            continue;
        }
        if current.task_revision.is_some() && !current.enabled {
            continue;
        }
        if current.job_status != "done" {
            result.conflicts += 1;
            continue;
        }
        let task = crate::repositories::tasks_get(tx, &track.id)?;
        match &observation.state {
            RemoteState::Removed => {
                if let Some(task) = task {
                    tx.execute(
                        "UPDATE outlook_links SET last_task=?2 WHERE task_id=?1",
                        params![track.id, serde_json::to_string(&task).unwrap()],
                    )?;
                    tx.execute(
                        "UPDATE tasks SET outlook_enabled=0 WHERE id=?1",
                        params![track.id],
                    )?;
                    tx.execute("DELETE FROM tasks WHERE id=?1", params![track.id])?;
                    tx.execute("UPDATE outlook_jobs SET operation='remote_removed',status='done',last_error='',revision=revision+1 WHERE task_id=?1",params![track.id])?;
                    result.deleted += 1;
                } else if track.operation == "delete" {
                    // A fresh negative observation distinguishes confirmed absence
                    // from a delayed pre-delete view that merely still shows the item.
                    tx.execute("UPDATE outlook_jobs SET operation='remote_removed',revision=revision+1 WHERE task_id=?1",params![track.id])?;
                }
            }
            RemoteState::Present(event, identity) => {
                if let Some(reason) = &identity.read_only {
                    result.warnings.push(format!("{}: {reason}", event.title));
                }
                if task.is_none()
                    && (!matches!(track.operation.as_str(), "delete" | "remote_removed")
                        || track.operation == "delete"
                            && track.remote.as_ref().is_none_or(|old| {
                                old.version == identity.version && old.entry_id == identity.entry_id
                            }))
                {
                    continue;
                }
                let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
                let mut rec = event.recurrence.clone();
                if !identity.imported
                    && let Some(task) = &task
                {
                    rec = task.recurrence.clone();
                }
                if let Some(task) = &task {
                    if task.title != event.title
                        || task.date != event.date
                        || task.start_time != event.start_time
                        || task.end_time != event.end_time
                        || task.is_all_day != event.is_all_day
                        || task.memo != event.location
                        || task.meeting_url != event.meeting_url
                        || task.recurrence != rec
                    {
                        // Turn off only the outbound trigger during the remote apply.
                        // Never call enable(), which would queue an echo write.
                        tx.execute(
                            "UPDATE tasks SET outlook_enabled=0 WHERE id=?1",
                            params![track.id],
                        )?;
                        tx.execute("UPDATE tasks SET title=?2,date=?3,is_all_day=?4,start_time=?5,end_time=?6,memo=?7,recurrence=?8,meeting_url=?9,updated_at=?10 WHERE id=?1",params![track.id,event.title,event.date,event.is_all_day as i64,event.start_time,event.end_time,event.location,rec.to_string(),event.meeting_url,now])?;
                        result.updated += 1;
                    }
                } else {
                    let saved: Option<String> = tx.query_row(
                        "SELECT last_task FROM outlook_links WHERE task_id=?1",
                        params![track.id],
                        |r| r.get(0),
                    )?;
                    let saved: Value = saved
                        .and_then(|raw| serde_json::from_str(&raw).ok())
                        .unwrap_or(json!({}));
                    if !identity.imported {
                        rec = saved.get("recurrence").cloned().unwrap_or(rec);
                    }
                    let input=serde_json::from_value(json!({"id":track.id,"createdAt":saved.get("createdAt"),"title":event.title,"date":event.date,"isAllDay":event.is_all_day,"startTime":event.start_time,"endTime":event.end_time,"memo":event.location,"recurrence":rec,"tagId":saved.get("tagId").and_then(Value::as_str).unwrap_or("")})).map_err(|e|rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                    crate::repositories::tasks_insert(tx, input)?;
                    result.restored += 1;
                }
                if track.remote.as_ref() != Some(identity) {
                    tx.execute(
                        "UPDATE tasks SET updated_at=?2 WHERE id=?1",
                        params![track.id, now],
                    )?;
                }
                tx.execute("UPDATE tasks SET outlook_enabled=1,outlook_occurrence_key=?2,outlook_series_id=?3,outlook_calendar_ref=?4,meeting_url=?5 WHERE id=?1",params![track.id,event.outlook_occurrence_key,event.outlook_series_id,identity.calendar,event.meeting_url])?;
                tx.execute("UPDATE outlook_links SET calendar_name=?2,entry_id=?3,store_id=?4,remote_meta=?5,source_key=?6,deleted_by_app=0 WHERE task_id=?1",params![track.id,identity.calendar,identity.entry_id,identity.store_id,serde_json::to_string(identity).unwrap(),event.outlook_occurrence_key])?;
                tx.execute("UPDATE outlook_jobs SET operation='upsert',status='done',last_error='',force_write=0 WHERE task_id=?1",params![track.id])?;
            }
            RemoteState::Unknown(_) => unreachable!(),
        }
    }
    if let Some(transaction) = transaction {
        transaction.commit()?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(status: &str) -> (Connection, Tracked) {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn, "2026-10").unwrap();
        crate::repositories::tasks_insert(&conn,serde_json::from_value(json!({"id":"a","title":"Local","date":"2026-10-09","startTime":"09:00","endTime":"10:00","tagId":"local-tag","outlookEnabled":true})).unwrap()).unwrap();
        conn.execute("UPDATE outlook_jobs SET status=?1", [status])
            .unwrap();
        conn.execute(
            "UPDATE outlook_links SET entry_id='entry',store_id='store'",
            [],
        )
        .unwrap();
        let track = capture(&conn).unwrap().remove(0);
        (conn, track)
    }
    fn changed(track: Tracked) -> Observation {
        let event = OutlookEvent {
            title: "Remote edit".into(),
            date: "2026-10-10".into(),
            start_time: Some("11:00".into()),
            end_time: Some("12:00".into()),
            location: "Remote memo".into(),
            is_all_day: false,
            outlook_series_id: "series".into(),
            outlook_occurrence_key: format!("tcplus:{}", track.external_key),
            is_recurring: false,
            recurrence: json!({"type":"none"}),
            remote: None,
            meeting_url: None,
        };
        Observation {
            track,
            state: RemoteState::Present(
                Box::new(event),
                RemoteIdentity {
                    calendar: "Calendar".into(),
                    entry_id: "entry".into(),
                    store_id: "store".into(),
                    version: "remote-2".into(),
                    ..Default::default()
                },
            ),
        }
    }
    #[test]
    fn completed_link_accepts_remote_edit_without_echo_and_keeps_tag() {
        let (conn, track) = fixture("done");
        let result = apply(&conn, &[changed(track)]).unwrap();
        assert_eq!(result.updated, 1);
        let task = crate::repositories::tasks_list(&conn).unwrap().remove(0);
        assert_eq!(
            (
                task.title.as_str(),
                task.date.as_str(),
                task.tag_id.as_str()
            ),
            ("Remote edit", "2026-10-10", "local-tag")
        );
        assert_eq!(
            crate::outlook_jobs::list(&conn).unwrap()[0]["status"],
            "done"
        );
    }
    #[test]
    fn confirmed_remote_removal_deletes_locally_without_outbound_delete() {
        let (conn, track) = fixture("done");
        assert_eq!(
            apply(
                &conn,
                &[Observation {
                    track,
                    state: RemoteState::Removed
                }]
            )
            .unwrap()
            .deleted,
            1
        );
        assert!(crate::repositories::tasks_list(&conn).unwrap().is_empty());
        assert_eq!(
            crate::outlook_jobs::list(&conn).unwrap()[0]["status"],
            "done"
        );
        assert_eq!(
            crate::outlook_jobs::list(&conn).unwrap()[0]["operation"],
            "remote_removed"
        );
    }
    #[test]
    fn unsent_work_unknown_remote_and_stale_snapshots_never_destroy_local_changes() {
        for status in ["pending", "working", "failed"] {
            let (conn, track) = fixture(status);
            assert_eq!(
                apply(
                    &conn,
                    &[Observation {
                        track,
                        state: RemoteState::Removed
                    }]
                )
                .unwrap()
                .conflicts,
                1
            );
            assert_eq!(crate::repositories::tasks_list(&conn).unwrap().len(), 1);
        }
        let (conn, track) = fixture("done");
        assert_eq!(
            apply(
                &conn,
                &[Observation {
                    track: track.clone(),
                    state: RemoteState::Unknown("offline".into())
                }]
            )
            .unwrap()
            .warnings,
            vec!["offline"]
        );
        conn.execute(
            "UPDATE tasks SET title='New local edit',updated_at='new'",
            [],
        )
        .unwrap();
        apply(&conn, &[changed(track)]).unwrap();
        assert_eq!(
            crate::repositories::tasks_list(&conn).unwrap()[0].title,
            "New local edit"
        );
    }
    #[test]
    fn confirmed_restore_preserves_app_recurrence_even_with_unchanged_remote_version() {
        let (conn, _) = fixture("done");
        let recurrence = json!({"type":"daily","until":"2026-10-12","groupId":"series-local","originDate":"2026-10-09"});
        conn.execute(
            "UPDATE tasks SET recurrence=?1",
            params![recurrence.to_string()],
        )
        .unwrap();
        let meta = RemoteIdentity {
            calendar: "Calendar".into(),
            entry_id: "entry".into(),
            store_id: "store".into(),
            version: "same-version".into(),
            ..Default::default()
        };
        conn.execute(
            "UPDATE outlook_links SET remote_meta=?1",
            params![serde_json::to_string(&meta).unwrap()],
        )
        .unwrap();
        let track = capture(&conn).unwrap().remove(0);
        apply(
            &conn,
            &[Observation {
                track,
                state: RemoteState::Removed,
            }],
        )
        .unwrap();
        let track = capture(&conn).unwrap().remove(0);
        let mut present = changed(track);
        if let RemoteState::Present(_, identity) = &mut present.state {
            *identity = RemoteIdentity {
                entry_id: "restored-entry".into(),
                ..meta
            };
        }
        assert_eq!(apply(&conn, &[present]).unwrap().restored, 1);
        assert_eq!(
            crate::repositories::tasks_list(&conn).unwrap()[0].recurrence,
            recurrence
        );
    }
    #[test]
    fn registration_off_then_local_delete_never_resubscribes_on_remote_restore() {
        let (conn, _) = fixture("done");
        crate::outlook_jobs::disable(&conn, "a").unwrap();
        crate::repositories::tasks_remove(&conn, "a").unwrap();
        conn.execute("UPDATE outlook_jobs SET status='done'", [])
            .unwrap();
        let track = capture(&conn).unwrap().remove(0);
        assert!(!track.subscribed);
        apply(&conn, &[changed(track)]).unwrap();
        assert!(crate::repositories::tasks_list(&conn).unwrap().is_empty());
    }
    #[test]
    fn disabled_registration_remains_local_when_remote_is_removed() {
        let (conn, _) = fixture("done");
        crate::outlook_jobs::disable(&conn, "a").unwrap();
        conn.execute("UPDATE outlook_jobs SET status='done'", [])
            .unwrap();
        let track = capture(&conn).unwrap().remove(0);
        apply(
            &conn,
            &[Observation {
                track,
                state: RemoteState::Removed,
            }],
        )
        .unwrap();
        assert_eq!(crate::repositories::tasks_list(&conn).unwrap().len(), 1);
    }
}
pub(super) fn date_property(
    item: &w::IDispatch,
    name: &str,
) -> Result<chrono::NaiveDateTime, String> {
    let value = automation::get(item, name)?;
    if unsafe { value.Anonymous.Anonymous.vt } != windows::Win32::System::Variant::VT_DATE {
        return Err(format!("Outlook {name}: invalid date type"));
    }
    let time = w::VariantTimeToSystemTime(unsafe { value.Anonymous.Anonymous.Anonymous.date })
        .map_err(|e| e.to_string())?;
    variant_to_naive_datetime(&w::Variant::Date(time))
        .ok_or_else(|| format!("Outlook {name}: invalid date"))
}
fn optional_string(item: &w::IDispatch, name: &str) -> Result<String, String> {
    let value = automation::get(item, name)?;
    windows::core::BSTR::try_from(&value)
        .map(|s| s.to_string())
        .map_err(|e| format!("Outlook {name}: {e}"))
}
pub(super) fn read_item(
    item: &w::IDispatch,
    original_start: Option<&str>,
    folder_hint: Option<&w::IDispatch>,
) -> Result<(OutlookEvent, bool), String> {
    use chrono::Timelike;
    let start = date_property(item, "Start")?;
    let end = date_property(item, "End")?;
    let all_day =
        bool::try_from(&automation::get(item, "AllDayEvent")?).map_err(|e| e.to_string())?;
    let recurring =
        bool::try_from(&automation::get(item, "IsRecurring")?).map_err(|e| e.to_string())?;
    let recurrence_state = automation::integer(item, "RecurrenceState")?;
    let body = optional_string(item, "Body")?;
    let title = optional_string(item, "Subject")?;
    let mut active = meeting_active(item)?;
    let entry_id = automation::text(item, "EntryID")?;
    let series = automation::text(item, "GlobalAppointmentID").unwrap_or_else(|_| entry_id.clone());
    let key = task_property(item)?;
    let stamp = if all_day {
        date_key(start.date())
    } else {
        format!("{}T{}", date_key(start.date()), time_key(start))
    };
    let next_day = start.date().succ_opt();
    let representable = if all_day {
        Some(end.date()) == next_day
    } else {
        start.date() == end.date()
            || (Some(end.date()) == next_day && end.time() == chrono::NaiveTime::MIN)
    };
    let exception = if recurring && recurrence_state == 3 {
        exception_details(item, start, end, &title).ok().flatten()
    } else {
        None
    };
    // A virtual expanded occurrence may inherit the master's status/flags.
    // The matching embedded exception supplies the per-occurrence cancellation.
    if let Some((_, exception_active)) = &exception {
        active = active && *exception_active;
    }
    let exception_verified = exception.is_some();
    let occurrence_start = original_start
        .map(str::to_string)
        .or_else(|| {
            (recurring && recurrence_state == 2)
                .then(|| start.format("%Y-%m-%dT%H:%M:%S").to_string())
        })
        .or_else(|| exception.map(|(original, _)| original));
    let read_only = if start.second() != 0 || end.second() != 0 {
        Some("秒単位の予定はOutlookで編集してください".into())
    } else if !representable {
        Some("複数日にまたがる予定はOutlookで編集してください".into())
    } else if recurring && recurrence_state == 3 && !exception_verified {
        Some("繰り返し例外の状態を一意に確認できません。Outlookで編集してください".into())
    } else if recurring && occurrence_start.is_none() {
        Some("繰り返し例外の元の日時を確認できません。Outlookで編集してください".into())
    } else {
        None
    };
    let parent = automation::object_get(item, "Parent")?;
    // Expanded recurrence occurrences may have a non-Folder Parent. The caller
    // already proved their calendar through its collection or GetOccurrence.
    let folder = if automation::text(&parent, "StoreID").is_ok() {
        parent
    } else if recurring {
        folder_hint
            .cloned()
            .ok_or("繰り返し予定の所属カレンダーを確認できません")?
    } else {
        return Err("予定の所属カレンダーを確認できません".into());
    };
    let version = json!([
        title,
        body,
        start.to_string(),
        end.to_string(),
        all_day,
        recurring,
        recurrence_state,
        date_property(item, "LastModificationTime")?.to_string()
    ])
    .to_string();
    let remote = RemoteIdentity {
        imported: key.is_none(),
        calendar: calendars::identify(&folder).map_err(|e| {
            format!("Appointment parent (recurring={recurring}, state={recurrence_state}): {e}")
        })?,
        entry_id,
        store_id: automation::text(&folder, "StoreID")?,
        series_id: series.clone(),
        occurrence_start,
        recurring,
        read_only,
        version,
    };
    let event = OutlookEvent {
        title: if title.is_empty() {
            "(タイトルなし)".into()
        } else {
            title
        },
        date: date_key(start.date()),
        start_time: (!all_day).then(|| time_key(start)),
        end_time: (!all_day).then(|| {
            if end.date() > start.date() && end.time() == chrono::NaiveTime::MIN {
                "24:00".into()
            } else {
                time_key(end)
            }
        }),
        location: body.clone(),
        is_all_day: all_day,
        outlook_series_id: series.clone(),
        outlook_occurrence_key: key
            .map(|key| format!("tcplus:{key}"))
            .unwrap_or_else(|| format!("{series}|{stamp}")),
        is_recurring: recurring,
        recurrence: extract_recurrence(item, start, 365, start),
        meeting_url: extract_teams_meeting_url(&body),
        remote: Some(remote),
    };
    Ok((event, active))
}
fn missing(error: &str) -> bool {
    error.to_ascii_lowercase().contains("0x8004010f")
}
pub(super) fn find_item(
    namespace: &w::IDispatch,
    track: &Tracked,
) -> Result<Option<w::IDispatch>, String> {
    // Prove the linked calendar is accessible before treating a missing item as deletion.
    let folder = if let Some(folder) = calendars::resolve(namespace, &track.calendar)? {
        folder
    } else {
        find_calendar_folder(namespace, &track.calendar)?
    };
    let known = match (&track.entry_id, &track.store_id) {
        (Some(entry), Some(store)) => match invoke_optional_dispatch(
            namespace,
            "GetItemFromID",
            &[
                AutomationValue::from(entry.as_str()),
                AutomationValue::from(store.as_str()),
            ],
        ) {
            Ok(value) => value,
            Err(e) if missing(&e) => None,
            Err(e) => return Err(e),
        },
        _ => None,
    };
    let imported = track.remote.as_ref().is_some_and(|meta| meta.imported);
    let item = if let Some(item) = known {
        Some(item)
    } else if !imported {
        let defs = automation::object_get(&folder, "UserDefinedProperties")?;
        if invoke_optional_dispatch(&defs, "Find", &[AutomationValue::from(TASK_KEY_PROPERTY)])?
            .is_none()
        {
            return Ok(None);
        }
        let items = automation::object_get(&folder, "Items")?;
        let filter = format!(
            "[{TASK_KEY_PROPERTY}] = '{}'",
            track.external_key.replace('\'', "''")
        );
        let found = automation::object_method(
            &items,
            "Restrict",
            &[AutomationValue::from(filter.as_str())],
        )?;
        match automation::integer(&found, "Count")? {
            0 => None,
            1 => Some(automation::object_method(
                &found,
                "Item",
                &[AutomationValue::from(1_i32)],
            )?),
            _ => return Err("同じ連携キーのOutlook予定が複数あります".into()),
        }
    } else {
        None
    };
    let Some(mut item) = item else {
        return Ok(None);
    };
    if automation::integer(&automation::object_get(&item, "Parent")?, "DefaultItemType")? != 1 {
        return Ok(None);
    }
    if imported {
        let meta = track.remote.as_ref().unwrap();
        if automation::text(&item, "GlobalAppointmentID")? != meta.series_id {
            return Err("Outlookの予定識別情報が一致しません".into());
        }
        if meta.recurring && automation::integer(&item, "RecurrenceState")? == 1 {
            let original = meta
                .occurrence_start
                .as_deref()
                .ok_or("繰り返し例外の元の日時を確認できないため保持しました")?;
            let time = chrono::NaiveDateTime::parse_from_str(original, "%Y-%m-%dT%H:%M:%S")
                .map_err(|e| e.to_string())?;
            let pattern = automation::object_method(&item, "GetRecurrencePattern", &[])?;
            item = match automation::optional_method(
                &pattern,
                "GetOccurrence",
                &[outlook_date(&date_key(time.date()), &time_key(time))?],
            ) {
                Ok(Some(item)) => item,
                Ok(None) => return Ok(None),
                Err(error) if missing(&error) => return Ok(None),
                Err(error) => {
                    if occurrence_deleted(&pattern, time)? {
                        return Ok(None);
                    }
                    return Err(error);
                }
            };
        }
    } else if task_property(&item)?.as_deref() != Some(track.external_key.as_str()) {
        return Err("Outlookの連携キーが一致しません".into());
    }
    Ok(Some(item))
}
fn matches_event(track: &Tracked, event: &OutlookEvent) -> bool {
    if event.outlook_occurrence_key == format!("tcplus:{}", track.external_key) {
        return event.remote.as_ref().is_some_and(|meta| {
            same_calendar(&track.calendar, &meta.calendar)
                || track.entry_id.as_deref() == Some(meta.entry_id.as_str())
        });
    }
    let (Some(old), Some(new)) = (&track.remote, &event.remote) else {
        return false;
    };
    if !old.imported || !same_calendar(&old.calendar, &new.calendar) {
        return false;
    }
    if !track.subscribed
        && old.series_id == new.series_id
        && (!old.recurring && !new.recurring
            || old.occurrence_start.is_some() && old.occurrence_start == new.occurrence_start)
    {
        return true;
    }
    track.source_key.as_deref() == Some(event.outlook_occurrence_key.as_str())
        || (old.entry_id == new.entry_id
            && old.store_id == new.store_id
            && (!old.recurring
                || old.occurrence_start.is_some() && old.occurrence_start == new.occurrence_start))
}
pub(super) fn observe(
    tracks: Vec<Tracked>,
    events: &[OutlookEvent],
    cancelled: &[OutlookEvent],
) -> Vec<Observation> {
    if tracks.is_empty() {
        return Vec::new();
    }
    let namespace = connect_outlook().and_then(|outlook| {
        automation::object_method(&outlook, "GetNamespace", &[AutomationValue::from("MAPI")])
    });
    tracks.into_iter().filter(|track|track.subscribed).map(|track|{
        let state=(||->Result<RemoteState,String>{
            let candidates:Vec<_>=events.iter().filter(|event|matches_event(&track,event)).collect();
            if candidates.len()>1{return Err("同じ予定の候補が複数あるため反映を保留しました".into());}
            if let Some(event)=candidates.first(){
                let mut meta=event.remote.clone().expect("fetched metadata");
                if let Some(old)=&track.remote {meta.imported=old.imported;if meta.occurrence_start.is_none(){meta.occurrence_start=old.occurrence_start.clone();if meta.occurrence_start.is_some()&&meta.read_only.as_deref().is_some_and(|reason|reason=="繰り返し例外の元の日時を確認できません。Outlookで編集してください"){meta.read_only=None;}}}
                return Ok(RemoteState::Present(Box::new((*event).clone()),meta));
            }
            if cancelled.iter().any(|event|matches_event(&track,event)){return Ok(RemoteState::Removed);}
            let namespace=namespace.as_ref().map_err(Clone::clone)?;
            let Some(item)=find_item(namespace,&track)? else{return Ok(RemoteState::Removed)};
            let calendar=if let Some(folder)=calendars::resolve(namespace,&track.calendar)?{folder}else{find_calendar_folder(namespace,&track.calendar)?};
            let (event,active)=read_item(&item,track.remote.as_ref().and_then(|meta|meta.occurrence_start.as_deref()),Some(&calendar))?;
            if !active{return Ok(RemoteState::Removed);}
            let mut identity=event.remote.clone().expect("read_item identity");
            if let Some(old)=&track.remote {identity.imported=old.imported;}
            Ok(RemoteState::Present(Box::new(event),identity))
        })().unwrap_or_else(RemoteState::Unknown);
        Observation{track,state}
    }).collect()
}

pub fn same_calendar(a: &str, b: &str) -> bool {
    calendars::same_calendar(a, b)
}
pub fn synchronize(
    conn: &Connection,
    snapshot: &OutlookSnapshot,
    tag: &str,
    expected_revision: i64,
) -> rusqlite::Result<Value> {
    let tx = conn.unchecked_transaction()?;
    let import_is_current = crate::repositories::tasks_revision(&tx)? == expected_revision;
    let mut result = apply(&tx, &snapshot.observations)?;
    result.warnings.extend(snapshot.warnings.clone());
    let mut imported = crate::repositories::AutoSyncResult {
        count: 0,
        added: 0,
        skipped: 0,
        deleted: 0,
        updated: 0,
    };
    if import_is_current {
        let tracked = capture(&tx)?;
        let untracked: Vec<_> = snapshot
            .events
            .iter()
            .filter(|event| !tracked.iter().any(|track| matches_event(track, event)))
            .cloned()
            .collect();
        imported = crate::repositories::outlook_sync_in_scope(
            &tx,
            &untracked,
            tag,
            snapshot.range,
            Some(&snapshot.calendar_ref),
        )?;
        for event in &untracked {
            let Some(meta) = &event.remote else { continue };
            let mut meta = meta.clone();
            meta.imported = true;
            let id:Option<String>=tx.query_row("SELECT id FROM tasks WHERE outlook_occurrence_key=?1 AND NOT EXISTS(SELECT 1 FROM outlook_links WHERE task_id=tasks.id)",params![event.outlook_occurrence_key],|r|r.get(0)).optional()?;
            let Some(id) = id else { continue };
            tx.execute("INSERT INTO outlook_links(task_id,calendar_name,entry_id,store_id,external_key,remote_meta,source_key) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![id,meta.calendar,meta.entry_id,meta.store_id,format!("import:{id}"),serde_json::to_string(&meta).unwrap(),event.outlook_occurrence_key])?;
            tx.execute(
                "UPDATE tasks SET outlook_enabled=1,outlook_calendar_ref=?2 WHERE id=?1",
                params![id, meta.calendar],
            )?;
            let task = crate::repositories::tasks_get(&tx, &id)?.expect("imported task");
            tx.execute(
                "UPDATE outlook_links SET last_task=?2 WHERE task_id=?1",
                params![id, serde_json::to_string(&task).unwrap()],
            )?;
            let payload = crate::outlook_jobs::WritePayload {
                task_id: id.clone(),
                title: task.title,
                date: task.date,
                is_all_day: task.is_all_day,
                start_time: task.start_time,
                end_time: task.end_time,
                memo: task.memo,
            };
            tx.execute("INSERT OR IGNORE INTO outlook_jobs(task_id,operation,payload,status) VALUES(?1,'upsert',?2,'done')",params![id,serde_json::to_string(&payload).unwrap()])?;
            if let Some(reason) = &meta.read_only {
                result.warnings.push(format!("{}: {reason}", event.title));
            }
        }
        // Explicit cancellation carries its identity even if a legacy row's source
        // was never recorded. Absence alone is insufficient for those old rows.
        for event in &snapshot.cancelled {
            let id:Option<String>=tx.query_row("SELECT id FROM tasks WHERE outlook_occurrence_key=?1 AND NOT EXISTS(SELECT 1 FROM outlook_links WHERE task_id=tasks.id)",params![event.outlook_occurrence_key],|r|r.get(0)).optional()?;
            if let Some(id) = id {
                tx.execute("DELETE FROM tasks WHERE id=?1", params![id])?;
                result.deleted += 1;
            }
        }
    } else {
        result.warnings.push(
            "取得中にタスクが変更されたため、新規取り込みを保留しました。再度取得してください"
                .into(),
        );
    }
    tx.commit()?;
    Ok(
        json!({"success":true,"count":imported.count,"added":imported.added+result.restored,"updated":imported.updated+result.updated,"deleted":imported.deleted+result.deleted,"skipped":imported.skipped,"conflicts":result.conflicts,"warnings":result.warnings}),
    )
}
#[cfg(test)]
mod matrix_tests {
    use super::*;
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c, "2026-10").unwrap();
        c
    }
    fn event(key: &str, calendar: &str) -> OutlookEvent {
        OutlookEvent {
            title: "Same title".into(),
            date: "2026-10-09".into(),
            start_time: Some("09:00".into()),
            end_time: Some("10:00".into()),
            location: "Body".into(),
            is_all_day: false,
            outlook_series_id: format!("series-{key}"),
            outlook_occurrence_key: key.into(),
            is_recurring: false,
            recurrence: json!({"type":"none"}),
            meeting_url: None,
            remote: Some(RemoteIdentity {
                imported: true,
                calendar: calendar.into(),
                entry_id: format!("entry-{key}"),
                store_id: "store".into(),
                series_id: format!("series-{key}"),
                version: "v1".into(),
                ..Default::default()
            }),
        }
    }
    fn snapshot(events: Vec<OutlookEvent>, calendar: &str) -> OutlookSnapshot {
        OutlookSnapshot {
            events,
            range: OutlookSyncRange::dates("2026-10-09", "2026-10-09").unwrap(),
            calendar_ref: calendar.into(),
            observations: vec![],
            cancelled: vec![],
            warnings: vec![],
        }
    }
    fn sync(c: &Connection, s: &OutlookSnapshot) -> Value {
        synchronize(c, s, "", crate::repositories::tasks_revision(c).unwrap()).unwrap()
    }
    #[test]
    fn outlook_import_binds_original_and_local_edits_and_delete_queue_that_identity() {
        let c = db();
        sync(&c, &snapshot(vec![event("e1", "A")], "A"));
        let t = crate::repositories::tasks_list(&c).unwrap().remove(0);
        assert!(t.outlook_enabled);
        let track = capture(&c).unwrap().remove(0);
        assert_eq!(track.entry_id.as_deref(), Some("entry-e1"));
        assert_eq!(track.job_status, "done");
        let mut patch = serde_json::to_value(&t).unwrap();
        patch["title"] = json!("Local edit");
        crate::repositories::tasks_update(&c, &t.id, serde_json::from_value(patch).unwrap())
            .unwrap();
        assert_eq!(
            crate::outlook_jobs::list(&c).unwrap()[0]["operation"],
            "upsert"
        );
        crate::repositories::tasks_remove(&c, &t.id).unwrap();
        assert_eq!(
            crate::outlook_jobs::list(&c).unwrap()[0]["operation"],
            "delete"
        );
        assert_eq!(
            capture(&c).unwrap()[0].entry_id.as_deref(),
            Some("entry-e1")
        );
    }
    #[test]
    fn imported_off_tombstone_suppresses_restored_original_even_when_entry_and_time_change() {
        let c = db();
        let mut e = event("e1", "A");
        sync(&c, &snapshot(vec![e.clone()], "A"));
        let id = crate::repositories::tasks_list(&c).unwrap().remove(0).id;
        crate::outlook_jobs::disable(&c, &id).unwrap();
        crate::repositories::tasks_remove(&c, &id).unwrap();
        c.execute("UPDATE outlook_jobs SET status='done'", [])
            .unwrap();
        e.remote.as_mut().unwrap().entry_id = "restored-new-entry".into();
        assert_eq!(sync(&c, &snapshot(vec![e.clone()], "A"))["added"], 0);
        assert!(crate::repositories::tasks_list(&c).unwrap().is_empty());
        e.outlook_occurrence_key = "e1-new-time".into();
        e.start_time = Some("15:00".into());
        e.end_time = Some("16:00".into());
        assert_eq!(sync(&c, &snapshot(vec![e], "A"))["added"], 0);
        assert!(crate::repositories::tasks_list(&c).unwrap().is_empty());
    }
    #[test]
    fn wrong_calendar_empty_snapshot_does_not_delete_other_imports() {
        let c = db();
        sync(&c, &snapshot(vec![event("e1", "A")], "A"));
        sync(&c, &snapshot(vec![], "B"));
        assert_eq!(crate::repositories::tasks_list(&c).unwrap().len(), 1);
    }
    #[test]
    fn distinct_outlook_ids_with_identical_content_stay_distinct() {
        let c = db();
        sync(&c, &snapshot(vec![event("e1", "A"), event("e2", "A")], "A"));
        assert_eq!(crate::repositories::tasks_list(&c).unwrap().len(), 2);
    }
    #[test]
    fn stale_import_snapshot_is_held_instead_of_rolling_back_newer_local_change() {
        let c = db();
        let revision = crate::repositories::tasks_revision(&c).unwrap();
        c.execute("INSERT INTO tasks(id,title,date,created_at,updated_at) VALUES('manual','Newest','2026-10-09','x','x')",[]).unwrap();
        let r = synchronize(&c, &snapshot(vec![event("old", "A")], "A"), "", revision).unwrap();
        assert_eq!(r["added"], 0);
        assert!(!r["warnings"].as_array().unwrap().is_empty());
    }
    #[test]
    fn remote_delete_and_restore_retains_id_and_local_tag_without_write_echo() {
        let c = db();
        let e = event("e1", "A");
        sync(&c, &snapshot(vec![e.clone()], "A"));
        let t = crate::repositories::tasks_list(&c).unwrap().remove(0);
        c.execute("UPDATE tasks SET tag_id='mine' WHERE id=?1", params![t.id])
            .unwrap();
        let track = capture(&c).unwrap().remove(0);
        apply(
            &c,
            &[Observation {
                track,
                state: RemoteState::Removed,
            }],
        )
        .unwrap();
        assert!(crate::repositories::tasks_list(&c).unwrap().is_empty());
        let track = capture(&c).unwrap().remove(0);
        let mut meta = e.remote.clone().unwrap();
        meta.version = "v2-restored".into();
        apply(
            &c,
            &[Observation {
                track,
                state: RemoteState::Present(Box::new(e), meta),
            }],
        )
        .unwrap();
        let restored = crate::repositories::tasks_list(&c).unwrap().remove(0);
        assert_eq!(restored.id, t.id);
        assert_eq!(restored.tag_id, "mine");
        assert_eq!(crate::outlook_jobs::counts(&c).unwrap()["pending"], 0);
    }
    #[test]
    fn snapshot_captured_before_local_delete_does_not_resurrect_it() {
        let c = db();
        let e = event("e1", "A");
        sync(&c, &snapshot(vec![e.clone()], "A"));
        let t = crate::repositories::tasks_list(&c).unwrap().remove(0);
        let track = capture(&c).unwrap().remove(0);
        crate::repositories::tasks_remove(&c, &t.id).unwrap();
        c.execute("UPDATE outlook_jobs SET status='done'", [])
            .unwrap();
        let meta = e.remote.clone().unwrap();
        apply(
            &c,
            &[Observation {
                track,
                state: RemoteState::Present(Box::new(e), meta),
            }],
        )
        .unwrap();
        assert!(crate::repositories::tasks_list(&c).unwrap().is_empty());
    }
    #[test]
    fn local_delete_waits_for_absence_or_new_identity_before_remote_restore() {
        let c = db();
        let e = event("e1", "A");
        sync(&c, &snapshot(vec![e.clone()], "A"));
        let id = crate::repositories::tasks_list(&c).unwrap().remove(0).id;
        crate::repositories::tasks_remove(&c, &id).unwrap();
        c.execute("UPDATE outlook_jobs SET status='done'", [])
            .unwrap();
        let track = capture(&c).unwrap().remove(0);
        apply(
            &c,
            &[Observation {
                track,
                state: RemoteState::Present(Box::new(e.clone()), e.remote.clone().unwrap()),
            }],
        )
        .unwrap();
        assert!(crate::repositories::tasks_list(&c).unwrap().is_empty());
        let track = capture(&c).unwrap().remove(0);
        apply(
            &c,
            &[Observation {
                track,
                state: RemoteState::Removed,
            }],
        )
        .unwrap();
        let track = capture(&c).unwrap().remove(0);
        apply(
            &c,
            &[Observation {
                track,
                state: RemoteState::Present(Box::new(e.clone()), e.remote.unwrap()),
            }],
        )
        .unwrap();
        assert_eq!(crate::repositories::tasks_list(&c).unwrap().len(), 1);
    }
    #[test]
    fn legacy_unknown_calendar_requires_positive_cancellation_evidence() {
        let c = db();
        c.execute("INSERT INTO tasks(id,title,date,outlook_occurrence_key,outlook_series_id,created_at,updated_at) VALUES('legacy','Meeting','2026-10-09','e1','series-e1','x','x')",[]).unwrap();
        sync(&c, &snapshot(vec![], "B"));
        assert_eq!(crate::repositories::tasks_list(&c).unwrap().len(), 1);
        let mut s = snapshot(vec![], "A");
        s.cancelled.push(event("e1", "A"));
        sync(&c, &s);
        assert!(crate::repositories::tasks_list(&c).unwrap().is_empty());
    }
    #[test]
    fn unsupported_multiday_edit_is_blocked_before_local_data_changes() {
        let c = db();
        let mut e = event("multi", "A");
        e.remote.as_mut().unwrap().read_only = Some("複数日".into());
        sync(&c, &snapshot(vec![e], "A"));
        let t = crate::repositories::tasks_list(&c).unwrap().remove(0);
        let mut patch = serde_json::to_value(&t).unwrap();
        patch["title"] = json!("Unsafe edit");
        assert!(
            crate::repositories::tasks_update(&c, &t.id, serde_json::from_value(patch).unwrap())
                .is_err()
        );
        assert_eq!(
            crate::repositories::tasks_list(&c).unwrap()[0].title,
            "Same title"
        );
    }
}
pub fn validate_edit(
    conn: &Connection,
    current: &crate::repositories::TaskRow,
    recurrence: &Value,
    content_changed: bool,
) -> rusqlite::Result<()> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT remote_meta FROM outlook_links WHERE task_id=?1",
            params![current.id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let Some(meta) = raw.and_then(|raw| serde_json::from_str::<RemoteIdentity>(&raw).ok()) else {
        return Ok(());
    };
    if content_changed && let Some(reason) = meta.read_only {
        return Err(rusqlite::Error::InvalidParameterName(reason));
    }
    if meta.imported
        && meta.recurring
        && (recurrence.get("type") != current.recurrence.get("type")
            || recurrence.get("until") != current.recurrence.get("until"))
    {
        return Err(rusqlite::Error::InvalidParameterName("Outlookの繰り返しルールはOutlookで変更してください。取得済みの各回の内容は個別に編集できます".into()));
    }
    Ok(())
}

pub fn legacy_targets(conn: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    conn.prepare("SELECT outlook_occurrence_key,date FROM tasks WHERE outlook_occurrence_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM outlook_links WHERE task_id=tasks.id)")?.query_map([],|row|Ok((row.get(0)?,row.get(1)?)))?.collect()
}
pub(super) fn adopt_legacy(
    snapshot: &mut OutlookSnapshot,
    calendar: &str,
    legacy: Vec<(String, String)>,
) {
    let keys: std::collections::HashSet<_> = legacy.iter().map(|(key, _)| key.as_str()).collect();
    let months: std::collections::BTreeSet<_> = legacy
        .iter()
        .filter_map(|(_, date)| date.get(..7))
        .collect();
    if months.len() > 32 {
        snapshot.warnings.push(
            "旧データの追加確認は32か月までです。残りは期間を指定して取得してください".into(),
        );
    }
    for month in months.into_iter().rev().take(32) {
        let Some(start) =
            chrono::NaiveDate::parse_from_str(&format!("{month}-01"), "%Y-%m-%d").ok()
        else {
            continue;
        };
        let Some(end) = start
            .checked_add_months(chrono::Months::new(1))
            .and_then(|d| d.pred_opt())
        else {
            continue;
        };
        let Ok(range) = OutlookSyncRange::dates(&date_key(start), &date_key(end)) else {
            continue;
        };
        match get_outlook_events(calendar, range) {
            Ok(extra) => {
                for event in extra
                    .events
                    .into_iter()
                    .filter(|e| keys.contains(e.outlook_occurrence_key.as_str()))
                {
                    snapshot
                        .events
                        .retain(|old| old.outlook_occurrence_key != event.outlook_occurrence_key);
                    snapshot
                        .cancelled
                        .retain(|old| old.outlook_occurrence_key != event.outlook_occurrence_key);
                    snapshot.events.push(event);
                }
                for event in extra
                    .cancelled
                    .into_iter()
                    .filter(|e| keys.contains(e.outlook_occurrence_key.as_str()))
                {
                    snapshot
                        .events
                        .retain(|old| old.outlook_occurrence_key != event.outlook_occurrence_key);
                    snapshot
                        .cancelled
                        .retain(|old| old.outlook_occurrence_key != event.outlook_occurrence_key);
                    snapshot.cancelled.push(event);
                }
            }
            Err(error) => snapshot
                .warnings
                .push(format!("旧データ {month} の確認を保留しました: {error}")),
        }
    }
}

pub(super) fn restore_original(
    namespace: &w::IDispatch,
    track: &Tracked,
    force: bool,
) -> Result<w::IDispatch, String> {
    if track.remote.as_ref().is_some_and(|meta| meta.recurring) {
        return Err("削除済みのOutlook繰り返し予定の回はOutlook側で復元してください".into());
    }
    let folder = if let Some(folder) = calendars::resolve(namespace, &track.calendar)? {
        folder
    } else {
        find_calendar_folder(namespace, &track.calendar)?
    };
    let store = automation::object_get(&folder, "Store")?;
    let deleted =
        automation::object_method(&store, "GetDefaultFolder", &[AutomationValue::from(3_i32)])?;
    let items = automation::object_get(&deleted, "Items")?;
    let appointments = automation::object_method(
        &items,
        "Restrict",
        &[AutomationValue::from("[MessageClass] = 'IPM.Appointment'")],
    )?;
    let mut first = true;
    let candidates = collect_bounded(5000, || {
        let method = if first { "GetFirst" } else { "GetNext" };
        first = false;
        invoke_optional_dispatch(&appointments, method, &[])
    })?;
    let mut matched = None;
    for candidate in candidates {
        let same = if let Some(meta) = track.remote.as_ref().filter(|meta| meta.imported) {
            automation::text(&candidate, "GlobalAppointmentID")? == meta.series_id
        } else {
            task_property(&candidate)?.as_deref() == Some(track.external_key.as_str())
        };
        if same {
            if matched.is_some() {
                return Err("復元候補が複数あるため、Outlook側で復元してください".into());
            }
            matched = Some(candidate);
        }
    }
    let item =
        matched.ok_or("削除済みアイテムに元の予定が見つかりません。Outlook側で復元してください")?;
    let (event, active) = read_item(
        &item,
        track
            .remote
            .as_ref()
            .and_then(|meta| meta.occurrence_start.as_deref()),
        Some(&deleted),
    )?;
    if !active {
        return Err("キャンセル済みの会議はOutlook側で確認してください".into());
    }
    if let Some(reason) = event
        .remote
        .as_ref()
        .and_then(|meta| meta.read_only.as_ref())
    {
        return Err(reason.clone());
    }
    if !force
        && track.remote.as_ref().is_some_and(|old| {
            event
                .remote
                .as_ref()
                .is_some_and(|new| !same_content_version(&old.version, &new.version))
        })
    {
        return Err("競合: 削除済みアイテム側でも内容が変更されています。「再試行」でアプリ側を優先して復元します".into());
    }
    use windows::core::Interface;
    let ptr = folder.ptr();
    let target =
        unsafe { windows::Win32::System::Com::IDispatch::from_raw_borrowed(&ptr) }.expect("folder");
    automation::object_method(&item, "Move", &[AutomationValue::from(target.clone())])
}

pub(super) fn same_content_version(a: &str, b: &str) -> bool {
    match (
        serde_json::from_str::<Vec<Value>>(a),
        serde_json::from_str::<Vec<Value>>(b),
    ) {
        (Ok(mut a), Ok(mut b)) if !a.is_empty() && !b.is_empty() => {
            a.pop();
            b.pop();
            a == b
        }
        _ => a == b,
    }
}

fn occurrence_deleted(
    pattern: &w::IDispatch,
    original: chrono::NaiveDateTime,
) -> Result<bool, String> {
    let exceptions = automation::object_get(pattern, "Exceptions")?;
    let count = automation::integer(&exceptions, "Count")?;
    if !(0..=5000).contains(&count) {
        return Err("繰り返し例外の件数が確認上限を超えています".into());
    }
    for index in 1..=count {
        let exception =
            automation::object_method(&exceptions, "Item", &[AutomationValue::from(index)])?;
        if date_property(&exception, "OriginalDate")?.date() == original.date() {
            return bool::try_from(&automation::get(&exception, "Deleted")?)
                .map_err(|e| e.to_string());
        }
    }
    Ok(false)
}

pub(super) fn meeting_active(item: &w::IDispatch) -> Result<bool, String> {
    let active = meeting_status_is_active(automation::integer(item, "MeetingStatus")?)?;
    // Recurrence exceptions can expose an inherited MeetingStatus. The MAPI
    // asfCanceled bit is the explicit cancellation flag; never infer from Subject.
    let accessor = automation::object_get(item, "PropertyAccessor")?;
    let property =
        "http://schemas.microsoft.com/mapi/id/{00062002-0000-0000-C000-000000000046}/82170003";
    let flags =
        match automation::method(&accessor, "GetProperty", &[AutomationValue::from(property)]) {
            Ok(value) => value,
            Err(error) if missing(&error) => return Ok(active), // Optional property.
            Err(error) => return Err(error),
        };
    if unsafe { flags.Anonymous.Anonymous.vt } != windows::Win32::System::Variant::VT_I4 {
        return Err("Outlookの取消状態の型が不正です".into());
    }
    let flags = i32::try_from(&flags).map_err(|error| error.to_string())?;
    if !(0..=7).contains(&flags) {
        return Err("Outlookの取消状態を確認できません".into());
    }
    Ok(active && flags & 4 == 0)
}

fn exception_details(
    item: &w::IDispatch,
    start: chrono::NaiveDateTime,
    end: chrono::NaiveDateTime,
    title: &str,
) -> Result<Option<(String, bool)>, String> {
    let pattern = automation::object_method(item, "GetRecurrencePattern", &[])?;
    let master = automation::object_get(&pattern, "Parent")?;
    let master_active = meeting_active(&master)?;
    let exceptions = automation::object_get(&pattern, "Exceptions")?;
    let count = automation::integer(&exceptions, "Count")?;
    if !(0..=5000).contains(&count) {
        return Err("繰り返し例外の確認上限を超えています".into());
    }
    let mut original = None;
    for index in 1..=count {
        let exception =
            automation::object_method(&exceptions, "Item", &[AutomationValue::from(index)])?;
        if bool::try_from(&automation::get(&exception, "Deleted")?).map_err(|e| e.to_string())? {
            continue;
        }
        let candidate = automation::object_get(&exception, "AppointmentItem")?;
        if date_property(&candidate, "Start")? == start
            && date_property(&candidate, "End")? == end
            && optional_string(&candidate, "Subject")? == title
        {
            if original.is_some() {
                return Ok(None);
            }
            let mut date = date_property(&exception, "OriginalDate")?;
            if date.time() == chrono::NaiveTime::MIN {
                date = date
                    .date()
                    .and_time(date_property(&pattern, "StartTime")?.time());
            }
            original = Some((
                date.format("%Y-%m-%dT%H:%M:%S").to_string(),
                master_active && meeting_active(&candidate)?,
            ));
        }
    }
    Ok(original)
}

pub(super) fn payload_matches_event(
    payload: &crate::outlook_jobs::WritePayload,
    event: &OutlookEvent,
) -> bool {
    payload.title == event.title
        && payload.date == event.date
        && payload.is_all_day == event.is_all_day
        && (payload.is_all_day
            || payload.start_time == event.start_time && payload.end_time == event.end_time)
        && payload.memo.replace("\r\n", "\n").trim_end()
            == event.location.replace("\r\n", "\n").trim_end()
}
