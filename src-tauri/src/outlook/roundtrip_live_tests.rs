use super::*;
use std::sync::{Arc, Mutex};
struct CalendarGuard(Option<w::IDispatch>);
impl Drop for CalendarGuard {
    fn drop(&mut self) {
        if let Some(folder) = self.0.take() {
            let _ = automation::method(&folder, "Delete", &[]);
        }
    }
}
async fn synchronize(
    state: &crate::api::AppState,
    calendar: &str,
    range: OutlookSyncRange,
) -> Value {
    let (tracked, revision) = {
        let c = state.conn.lock().unwrap();
        (
            reconcile::capture(&c).unwrap(),
            crate::repositories::tasks_revision(&c).unwrap(),
        )
    };
    let snapshot = fetch_for_sync(calendar.into(), range, tracked)
        .await
        .unwrap();
    let c = state.conn.lock().unwrap();
    reconcile::synchronize(&c, &snapshot, "", revision).unwrap()
}
async fn flush(state: &crate::api::AppState) {
    assert!(crate::outlook_jobs::process_one(state).await.unwrap());
    let c = state.conn.lock().unwrap();
    assert_eq!(
        crate::outlook_jobs::counts(&c).unwrap()["failed"],
        0,
        "{:?}",
        crate::outlook_jobs::list(&c).unwrap()
    );
}
fn linked_item(state: &crate::api::AppState, namespace: &w::IDispatch, id: &str) -> w::IDispatch {
    let c = state.conn.lock().unwrap();
    let t = reconcile::capture(&c)
        .unwrap()
        .into_iter()
        .find(|t| t.id == id)
        .unwrap();
    reconcile::find_item(namespace, &t).unwrap().unwrap()
}
fn create_local(state: &crate::api::AppState, id: &str, date: &str, all_day: bool) {
    let c = state.conn.lock().unwrap();
    crate::repositories::tasks_insert(&c,serde_json::from_value(json!({"id":id,"title":id,"date":date,"startTime":"09:00","endTime":"10:00","isAllDay":all_day,"tagId":"local-tag","outlookEnabled":true})).unwrap()).unwrap();
}
fn edit_local(state: &crate::api::AppState, id: &str, title: &str) {
    let c = state.conn.lock().unwrap();
    let t = crate::repositories::tasks_list(&c)
        .unwrap()
        .into_iter()
        .find(|t| t.id == id)
        .unwrap();
    let mut value = serde_json::to_value(t).unwrap();
    value["title"] = json!(title);
    crate::repositories::tasks_update(&c, id, serde_json::from_value(value).unwrap()).unwrap();
}
#[tokio::test]
#[ignore = "creates a temporary Outlook calendar, tests CRUD without Send, then deletes that calendar"]
async fn live_bidirectional_matrix_in_temporary_calendar() {
    let _com = w::CoInitializeEx(co::COINIT::APARTMENTTHREADED).unwrap();
    let outlook = connect_outlook().unwrap();
    let ns = automation::object_method(&outlook, "GetNamespace", &[AutomationValue::from("MAPI")])
        .unwrap();
    let base = default_calendar_folder(&ns).unwrap();
    let folders = automation::object_get(&base, "Folders").unwrap();
    let name = format!(
        "TaskCalendar-sync-test-{}",
        chrono::Utc::now().timestamp_millis()
    );
    let folder = automation::object_method(
        &folders,
        "Add",
        &[
            AutomationValue::from(name.as_str()),
            AutomationValue::from(OL_FOLDER_CALENDAR),
        ],
    )
    .unwrap();
    let mut guard = CalendarGuard(Some(folder.clone()));
    let calendar = calendars::identify(&folder).unwrap();
    let c = rusqlite::Connection::open_in_memory().unwrap();
    crate::db::migrate(&c, "2026-10").unwrap();
    crate::repositories::settings_set(&c, &json!({"outlookWriteCalendarName":calendar})).unwrap();
    let state = crate::api::AppState {
        os_locale: "ja-JP".into(),
        conn: Arc::new(Mutex::new(c)),
        static_root: Default::default(),
        proposals: Default::default(),
        claude_command: None,
        codex_command: None,
        api_token: "isolated-test".into(),
    };
    let day = chrono::Local::now().date_naive().succ_opt().unwrap();
    let date = date_key(day);
    let range = OutlookSyncRange::dates(&date, &date).unwrap();
    // OFF before the first upsert is a no-op delete, not a restorable remote item.
    create_local(&state, "never-written", &date, false);
    {
        let c = state.conn.lock().unwrap();
        crate::outlook_jobs::disable(&c, "never-written").unwrap();
    }
    flush(&state).await;
    {
        let c = state.conn.lock().unwrap();
        let deleted: bool = c
            .query_row(
                "SELECT deleted_by_app FROM outlook_links WHERE task_id='never-written'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!deleted);
        crate::outlook_jobs::enable(&c, "never-written").unwrap();
    }
    flush(&state).await;
    crate::repositories::tasks_remove(&state.conn.lock().unwrap(), "never-written").unwrap();
    flush(&state).await;
    create_local(&state, "app-created", &date, false);
    flush(&state).await;
    // A migrated link without a baseline must not overwrite unverified remote state.
    {
        let c = state.conn.lock().unwrap();
        c.execute(
            "UPDATE outlook_links SET remote_meta=NULL WHERE task_id='app-created'",
            [],
        )
        .unwrap();
    }
    edit_local(&state, "app-created", "Legacy local edit");
    crate::outlook_jobs::process_one(&state).await.unwrap();
    {
        let c = state.conn.lock().unwrap();
        let error: String = c
            .query_row(
                "SELECT last_error FROM outlook_jobs WHERE task_id='app-created'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(error.starts_with("競合:"));
        crate::outlook_jobs::retry(&c, "app-created").unwrap();
    }
    flush(&state).await;
    let item = linked_item(&state, &ns, "app-created");
    // Both sides reached the same values: acknowledge convergence, not a conflict.
    edit_local(&state, "app-created", "Same on both sides");
    put_outlook_text(&item, "Subject", "Same on both sides").unwrap();
    automation::method(&item, "Save", &[]).unwrap();
    flush(&state).await;
    put_outlook_text(&item, "Subject", "Remote edit").unwrap();
    automation::put(&item, "Start", outlook_date(&date, "10:00").unwrap()).unwrap();
    automation::put(&item, "End", outlook_date(&date, "11:00").unwrap()).unwrap();
    automation::method(&item, "Save", &[]).unwrap();
    let result = synchronize(&state, &calendar, range).await;
    assert_eq!(result["updated"], 1);
    {
        let c = state.conn.lock().unwrap();
        let t = crate::repositories::tasks_list(&c).unwrap().remove(0);
        assert_eq!(t.title, "Remote edit");
        assert_eq!(t.tag_id, "local-tag");
        assert_eq!(crate::outlook_jobs::counts(&c).unwrap()["pending"], 0);
    }
    edit_local(&state, "app-created", "Local edit");
    flush(&state).await;
    assert_eq!(automation::text(&item, "Subject").unwrap(), "Local edit");
    // Switch timed -> all-day remotely, then all-day -> timed locally.
    automation::put(&item, "AllDayEvent", AutomationValue::from(true)).unwrap();
    automation::put(&item, "Start", outlook_date(&date, "00:00").unwrap()).unwrap();
    automation::put(&item, "End", outlook_date(&date, "24:00").unwrap()).unwrap();
    put_outlook_text(&item, "Body", "Remote memo").unwrap();
    automation::method(&item, "Save", &[]).unwrap();
    synchronize(&state, &calendar, range).await;
    {
        let c = state.conn.lock().unwrap();
        let task = crate::repositories::tasks_get(&c, "app-created")
            .unwrap()
            .unwrap();
        assert!(task.is_all_day);
        assert_eq!(task.memo.trim(), "Remote memo"); // Outlook may append whitespace when normalizing Body.
        let mut value = serde_json::to_value(task).unwrap();
        value["isAllDay"] = json!(false);
        value["startTime"] = json!("12:00");
        value["endTime"] = json!("13:00");
        crate::repositories::tasks_update(
            &c,
            "app-created",
            serde_json::from_value(value).unwrap(),
        )
        .unwrap();
    }
    flush(&state).await;
    assert_eq!(
        reconcile::date_property(&item, "Start")
            .unwrap()
            .format("%H:%M")
            .to_string(),
        "12:00"
    );
    assert_eq!(
        reconcile::date_property(&item, "End")
            .unwrap()
            .format("%H:%M")
            .to_string(),
        "13:00"
    );
    assert!(!bool::try_from(&automation::get(&item, "AllDayEvent").unwrap()).unwrap());
    automation::method(&item, "Delete", &[]).unwrap();
    drop(item);
    let result = synchronize(&state, &calendar, range).await;
    assert_eq!(result["deleted"], 1);
    assert!(
        crate::repositories::tasks_list(&state.conn.lock().unwrap())
            .unwrap()
            .is_empty()
    );
    let restore_track = {
        let c = state.conn.lock().unwrap();
        reconcile::capture(&c)
            .unwrap()
            .into_iter()
            .find(|t| t.id == "app-created")
            .unwrap()
    };
    let restored_remote = reconcile::restore_original(&ns, &restore_track, false).unwrap();
    assert_eq!(synchronize(&state, &calendar, range).await["added"], 1);
    {
        let c = state.conn.lock().unwrap();
        let restored = crate::repositories::tasks_get(&c, "app-created")
            .unwrap()
            .unwrap();
        assert_eq!(restored.tag_id, "local-tag");
        assert_eq!(crate::outlook_jobs::counts(&c).unwrap()["pending"], 0);
    }
    drop(restored_remote);
    let to_delete = linked_item(&state, &ns, "app-created");
    automation::method(&to_delete, "Delete", &[]).unwrap();
    drop(to_delete);

    eprintln!("PHASE Outlook origin");
    // Outlook-created record: edit and delete the same original object, not a copy.
    let items = automation::object_get(&folder, "Items").unwrap();
    let imported =
        automation::object_method(&items, "Add", &[AutomationValue::from(1_i32)]).unwrap();
    put_outlook_text(&imported, "Subject", "Outlook origin").unwrap();
    automation::put(&imported, "Start", outlook_date(&date, "13:00").unwrap()).unwrap();
    automation::put(&imported, "End", outlook_date(&date, "14:00").unwrap()).unwrap();
    automation::method(&imported, "Save", &[]).unwrap();
    let original_id = automation::text(&imported, "EntryID").unwrap();
    synchronize(&state, &calendar, range).await;
    let imported_id = crate::repositories::tasks_list(&state.conn.lock().unwrap())
        .unwrap()
        .remove(0)
        .id;
    edit_local(&state, &imported_id, "Edited imported original");
    flush(&state).await;
    assert_eq!(
        automation::text(&imported, "Subject").unwrap(),
        "Edited imported original"
    );
    assert_eq!(automation::text(&imported, "EntryID").unwrap(), original_id);
    assert_eq!(automation::integer(&items, "Count").unwrap(), 1);
    drop(imported);
    // A later no-op OFF must not erase the earlier confirmed deletion needed
    // to restore the original when ON is selected again.
    crate::outlook_jobs::disable(&state.conn.lock().unwrap(), &imported_id).unwrap();
    flush(&state).await;
    {
        let c = state.conn.lock().unwrap();
        crate::outlook_jobs::enable(&c, &imported_id).unwrap();
        crate::outlook_jobs::disable(&c, &imported_id).unwrap();
    }
    flush(&state).await;
    assert!(
        state
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT deleted_by_app FROM outlook_links WHERE task_id=?1",
                [&imported_id],
                |r| r.get::<_, bool>(0)
            )
            .unwrap(),
        "a no-op delete must retain the earlier confirmed deletion"
    );
    crate::outlook_jobs::enable(&state.conn.lock().unwrap(), &imported_id).unwrap();
    flush(&state).await;
    assert_eq!(automation::integer(&items, "Count").unwrap(), 1);
    let imported_snapshot = crate::repositories::tasks_list(&state.conn.lock().unwrap())
        .unwrap()
        .into_iter()
        .find(|t| t.id == imported_id)
        .unwrap();
    crate::repositories::tasks_remove(&state.conn.lock().unwrap(), &imported_id).unwrap();
    flush(&state).await;
    assert_eq!(automation::integer(&items, "Count").unwrap(), 0);
    // Undo restores the original object from Deleted Items, retaining meeting data.
    {
        let c = state.conn.lock().unwrap();
        let batch = serde_json::from_value(
            json!({"expected":[],"upserts":[imported_snapshot],"deleteIds":[]}),
        )
        .unwrap();
        assert!(crate::repositories::tasks_batch(&c, batch).is_ok());
    }
    flush(&state).await;
    assert_eq!(automation::integer(&items, "Count").unwrap(), 1);
    crate::repositories::tasks_remove(&state.conn.lock().unwrap(), &imported_id).unwrap();
    flush(&state).await;
    assert_eq!(automation::integer(&items, "Count").unwrap(), 0);
    assert_eq!(synchronize(&state, &calendar, range).await["added"], 0);
    eprintln!("PHASE cancellation");
    // Organizer cancellation, without creating recipients or sending cancellation mail.
    create_local(&state, "cancelled", &date, false);
    flush(&state).await;
    let canceled = linked_item(&state, &ns, "cancelled");
    automation::put(&canceled, "MeetingStatus", AutomationValue::from(5_i32)).unwrap();
    automation::method(&canceled, "Save", &[]).unwrap();
    assert_eq!(synchronize(&state, &calendar, range).await["deleted"], 1);
    // A known all-day record before the new-import window still reconciles deletion.
    let past = date_key(day.pred_opt().unwrap().pred_opt().unwrap());
    create_local(&state, "past-all-day", &past, true);
    flush(&state).await;
    automation::method(&linked_item(&state, &ns, "past-all-day"), "Delete", &[]).unwrap();
    assert_eq!(synchronize(&state, &calendar, range).await["deleted"], 1);
    eprintln!("PHASE native recurrence");
    // Native Outlook recurrence: update and remove one occurrence, never its master.
    let native = automation::object_method(&items, "Add", &[AutomationValue::from(1_i32)]).unwrap();
    put_outlook_text(&native, "Subject", "Native recurring").unwrap();
    automation::put(&native, "MeetingStatus", AutomationValue::from(1_i32)).unwrap(); // An unsent meeting, not a plain appointment series.
    automation::put(&native, "Start", outlook_date(&date, "16:00").unwrap()).unwrap();
    automation::put(&native, "End", outlook_date(&date, "17:00").unwrap()).unwrap();
    let pattern = automation::object_method(&native, "GetRecurrencePattern", &[]).unwrap();
    automation::put(&pattern, "RecurrenceType", AutomationValue::from(0_i32)).unwrap();
    automation::put(&pattern, "Interval", AutomationValue::from(1_i32)).unwrap();
    automation::put(&pattern, "Occurrences", AutomationValue::from(4_i32)).unwrap();
    automation::method(&native, "Save", &[]).unwrap();
    let native_entry = automation::text(&native, "EntryID").unwrap();
    let native_store = automation::text(&folder, "StoreID").unwrap();
    drop(pattern);
    drop(native); // Outlook caches exceptions while master/pattern references remain alive.
    let wider = OutlookSyncRange::dates(&date, &date_key(day + chrono::Duration::days(3))).unwrap();
    synchronize(&state, &calendar, wider).await;
    let occurrence = {
        let c = state.conn.lock().unwrap();
        let tasks = crate::repositories::tasks_list(&c).unwrap();
        let repeated: Vec<_> = tasks
            .into_iter()
            .filter(|t| t.title == "Native recurring")
            .collect();
        assert_eq!(repeated.len(), 4);
        repeated
            .into_iter()
            .find(|t| t.date == date_key(day + chrono::Duration::days(1)))
            .unwrap()
    };
    edit_local(&state, &occurrence.id, "Native single edit");
    flush(&state).await;
    synchronize(&state, &calendar, wider).await;
    edit_local(&state, &occurrence.id, "Native second edit");
    flush(&state).await;
    crate::repositories::tasks_remove(&state.conn.lock().unwrap(), &occurrence.id).unwrap();
    flush(&state).await;
    synchronize(&state, &calendar, wider).await;
    {
        let c = state.conn.lock().unwrap();
        assert_eq!(
            crate::repositories::tasks_list(&c)
                .unwrap()
                .iter()
                .filter(|t| t.title == "Native recurring")
                .count(),
            3
        );
    }
    // A deletion/cancellation performed in Outlook must remove only matching local occurrences.
    let remote_occurrence = {
        let c = state.conn.lock().unwrap();
        crate::repositories::tasks_list(&c)
            .unwrap()
            .into_iter()
            .find(|t| t.title == "Native recurring")
            .unwrap()
    };
    automation::method(
        &linked_item(&state, &ns, &remote_occurrence.id),
        "Delete",
        &[],
    )
    .unwrap();
    let result = synchronize(&state, &calendar, wider).await;
    assert_eq!(result["deleted"], 1, "{result}");
    // Cancel one occurrence while the master remains active.
    let single_cancel = {
        let c = state.conn.lock().unwrap();
        crate::repositories::tasks_list(&c)
            .unwrap()
            .into_iter()
            .find(|t| t.title == "Native recurring")
            .unwrap()
    };
    let canceled_occurrence = linked_item(&state, &ns, &single_cancel.id);
    // Materialize an exception first; a virtual appointment occurrence can ignore
    // a MeetingStatus-only change when the master was never sent as a meeting.
    put_outlook_text(&canceled_occurrence, "Subject", "Cancellation fixture").unwrap();
    automation::method(&canceled_occurrence, "Save", &[]).unwrap();
    automation::put(
        &canceled_occurrence,
        "MeetingStatus",
        AutomationValue::from(5_i32),
    )
    .unwrap();
    automation::method(&canceled_occurrence, "Save", &[]).unwrap();
    assert!(
        !reconcile::meeting_active(&canceled_occurrence).unwrap(),
        "fixture must actually be canceled before testing reconciliation"
    );
    drop(canceled_occurrence);
    // Read the persisted embedded message independently of the synchronizer.
    // Outlook may not persist an unsent occurrence's OOM MeetingStatus-only change.
    let persisted_canceled = {
        let master = automation::object_method(
            &ns,
            "GetItemFromID",
            &[
                AutomationValue::from(native_entry.as_str()),
                AutomationValue::from(native_store.as_str()),
            ],
        )
        .unwrap();
        let pattern = automation::object_method(&master, "GetRecurrencePattern", &[]).unwrap();
        let exceptions = automation::object_get(&pattern, "Exceptions").unwrap();
        let mut canceled = None;
        for index in 1..=automation::integer(&exceptions, "Count").unwrap() {
            let e = automation::object_method(&exceptions, "Item", &[AutomationValue::from(index)])
                .unwrap();
            if bool::try_from(&automation::get(&e, "Deleted").unwrap()).unwrap() {
                continue;
            }
            let a = automation::object_get(&e, "AppointmentItem").unwrap();
            if automation::text(&a, "Subject").unwrap() == "Cancellation fixture" {
                let p = automation::object_get(&a, "PropertyAccessor").unwrap();
                let flags=i32::try_from(&automation::method(&p,"GetProperty",&[AutomationValue::from("http://schemas.microsoft.com/mapi/id/{00062002-0000-0000-C000-000000000046}/82170003")]).unwrap()).unwrap();
                assert!((0..=7).contains(&flags));
                canceled = Some(flags & 4 != 0);
            }
        }
        canceled.expect("persisted exception exists")
    };
    eprintln!(
        "Persisted single-exception cancellation={persisted_canceled}; source flags, not title/transient OOM state, are authoritative"
    );
    let result = synchronize(&state, &calendar, wider).await;
    assert_eq!(
        result["deleted"],
        usize::from(persisted_canceled),
        "{result}"
    );
    let remaining = 2 - usize::from(persisted_canceled);
    assert_eq!(
        crate::repositories::tasks_list(&state.conn.lock().unwrap())
            .unwrap()
            .len(),
        remaining
    );
    let native = automation::object_method(
        &ns,
        "GetItemFromID",
        &[
            AutomationValue::from(native_entry.as_str()),
            AutomationValue::from(native_store.as_str()),
        ],
    )
    .unwrap();
    automation::put(&native, "MeetingStatus", AutomationValue::from(5_i32)).unwrap();
    automation::method(&native, "Save", &[]).unwrap();
    drop(native);
    let master_canceled=std::thread::spawn(move||{
  let _com=w::CoInitializeEx(co::COINIT::APARTMENTTHREADED).unwrap();let app=connect_outlook().unwrap();let ns=automation::object_method(&app,"GetNamespace",&[AutomationValue::from("MAPI")]).unwrap();let master=automation::object_method(&ns,"GetItemFromID",&[AutomationValue::from(native_entry.as_str()),AutomationValue::from(native_store.as_str())]).unwrap();let pa=automation::object_get(&master,"PropertyAccessor").unwrap();let flags=i32::try_from(&automation::method(&pa,"GetProperty",&[AutomationValue::from("http://schemas.microsoft.com/mapi/id/{00062002-0000-0000-C000-000000000046}/82170003")]).unwrap()).unwrap();assert!((0..=7).contains(&flags));flags&4!=0
 }).join().unwrap();
    eprintln!(
        "Persisted master cancellation={master_canceled}; no cancellation notifications were sent"
    );
    let result = synchronize(&state, &calendar, wider).await;
    assert_eq!(
        result["deleted"],
        if master_canceled { remaining } else { 0 },
        "{result}"
    );
    eprintln!("PHASE conflict");
    // Concurrent edits are visible failures, never a silent local overwrite.
    create_local(&state, "conflict", &date, false);
    flush(&state).await;
    let conflicting = linked_item(&state, &ns, "conflict");
    put_outlook_text(&conflicting, "Subject", "Remote concurrent").unwrap();
    automation::method(&conflicting, "Save", &[]).unwrap();
    edit_local(&state, "conflict", "Local concurrent");
    crate::outlook_jobs::process_one(&state).await.unwrap();
    {
        let c = state.conn.lock().unwrap();
        let error: String = c
            .query_row(
                "SELECT last_error FROM outlook_jobs WHERE task_id='conflict'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(error.starts_with("競合:"));
        assert_eq!(
            automation::text(&conflicting, "Subject").unwrap(),
            "Remote concurrent"
        );
        crate::outlook_jobs::retry(&c, "conflict").unwrap();
    }
    flush(&state).await;
    assert_eq!(
        automation::text(&conflicting, "Subject").unwrap(),
        "Local concurrent"
    );
    // Force retry may resolve a version conflict, never an unsupported shape.
    let later = date_key(day.succ_opt().unwrap());
    automation::put(&conflicting, "End", outlook_date(&later, "15:00").unwrap()).unwrap();
    automation::method(&conflicting, "Save", &[]).unwrap();
    edit_local(&state, "conflict", "Must not shorten multi-day");
    crate::outlook_jobs::process_one(&state).await.unwrap();
    {
        let c = state.conn.lock().unwrap();
        c.execute(
            "UPDATE outlook_jobs SET status='pending',force_write=1 WHERE task_id='conflict'",
            [],
        )
        .unwrap();
    }
    crate::outlook_jobs::process_one(&state).await.unwrap();
    {
        let c = state.conn.lock().unwrap();
        let status: String = c
            .query_row(
                "SELECT status FROM outlook_jobs WHERE task_id='conflict'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "failed");
    }
    assert_eq!(
        reconcile::date_property(&conflicting, "End")
            .unwrap()
            .date(),
        day.succ_opt().unwrap()
    );
    let removed = guard.0.take().unwrap();
    automation::method(&removed, "Delete", &[]).unwrap();
    eprintln!(
        "PASS live matrix: app/Outlook origin CRUD, cancellation, past all-day deletion, no echo/duplicates, explicit conflict retry; temporary calendar removed"
    );
}
#[tokio::test]
#[ignore = "operator-only: reconcile the closed app DB explicitly named by TCPLUS_SYNC_DB; Outlook is read-only"]
async fn live_reconcile_named_profile_database() {
    let db = std::env::var("TCPLUS_SYNC_DB").expect("TCPLUS_SYNC_DB required");
    assert_eq!(
        std::env::var("TCPLUS_SYNC_APPLY").as_deref(),
        Ok("1"),
        "explicit local DB apply required"
    );
    let path = std::path::Path::new(&db);
    assert!(path.is_absolute() && path.is_file());
    let conn = crate::db::open_database(path).unwrap();
    crate::db::migrate(&conn, &chrono::Local::now().format("%Y-%m").to_string()).unwrap();
    let settings = crate::repositories::settings_get(&conn)
        .unwrap()
        .unwrap_or(json!({}));
    let calendar = settings
        .get("outlookSyncCalendarName")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("Calendar")
        .to_string();
    let days = settings
        .get("outlookSyncDaysAhead")
        .and_then(Value::as_i64)
        .unwrap_or(90);
    let revision = crate::repositories::tasks_revision(&conn).unwrap();
    let tracked = reconcile::capture(&conn).unwrap();
    let legacy = reconcile::legacy_targets(&conn).unwrap();
    let snapshot = fetch_reconcile(
        calendar,
        OutlookSyncRange::new(chrono::Local::now().naive_local(), days),
        tracked,
        legacy,
    )
    .await
    .unwrap();
    let mut result = reconcile::synchronize(
        &conn,
        &snapshot,
        settings
            .get("outlookSyncTagId")
            .and_then(Value::as_str)
            .unwrap_or(""),
        revision,
    )
    .unwrap();
    result["legacyRemaining"] = json!(reconcile::legacy_targets(&conn).unwrap().len());
    result["outboundCounts"] = crate::outlook_jobs::counts(&conn).unwrap();
    if let Ok(report) = std::env::var("TCPLUS_SYNC_REPORT") {
        std::fs::write(report, serde_json::to_string_pretty(&result).unwrap()).unwrap();
    }
    eprintln!("PROFILE SYNC: {}", result);
}
