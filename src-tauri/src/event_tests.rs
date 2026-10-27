use super::*;

#[test]
fn event_fields_survive_create_edit_and_batch_undo() {
    let c=Connection::open_in_memory().unwrap();
    crate::db::migrate(&c,"2026-10").unwrap();
    let input=json!({"id":"overnight","title":"Conference","date":"2026-10-09","endDate":"2026-10-11","startTime":"22:30:45","endTime":"08:15:30","outlookDetails":{"location":"Room A","busyStatus":3,"sensitivity":2,"importance":2,"categories":"Work","reminderSet":true,"reminderMinutesBeforeStart":30,"startTimeZone":"Tokyo Standard Time","endTimeZone":"Tokyo Standard Time","attendees":[{"name":"Guest","address":"guest@example.invalid","type":1,"responseStatus":3}]}});
    let created=tasks_insert(&c,serde_json::from_value(input).unwrap()).unwrap();
    let mut value=serde_json::to_value(&created).unwrap();
    assert_eq!(value["endDate"],"2026-10-11");
    assert_eq!(value["outlookDetails"]["location"],"Room A");
    value["title"]=json!("Edited conference");
    // Older clients omitting new fields must preserve the saved event details.
    value.as_object_mut().unwrap().remove("endDate");
    value.as_object_mut().unwrap().remove("outlookDetails");
    let edited=tasks_update(&c,"overnight",serde_json::from_value(value).unwrap()).unwrap().unwrap();
    let snapshot=serde_json::to_value(&edited).unwrap();
    assert_eq!(snapshot["endDate"],"2026-10-11");
    assert_eq!(snapshot["outlookDetails"]["attendees"][0]["address"],"guest@example.invalid");
    tasks_remove(&c,"overnight").unwrap();
    let batch=serde_json::from_value(json!({"expected":[],"upserts":[snapshot],"deleteIds":[]})).unwrap();
    assert!(tasks_batch(&c,batch).is_ok());
    let restored=serde_json::to_value(tasks_get(&c,"overnight").unwrap().unwrap()).unwrap();
    assert_eq!(restored["endDate"],"2026-10-11");
    assert_eq!(restored["startTime"],"22:30:45");
    assert_eq!(restored["outlookDetails"]["reminderMinutesBeforeStart"],30);
}

#[test]
fn invalid_multiday_range_is_rejected_before_persistence() {
    let c=Connection::open_in_memory().unwrap();crate::db::migrate(&c,"2026-10").unwrap();
    for (end_date,end_time) in [("2026-10-08","10:00"),("2026-10-09","08:59:59")] {
        let input=json!({"id":"invalid","date":"2026-10-09","endDate":end_date,"startTime":"09:00:00","endTime":end_time});
        assert!(tasks_insert(&c,serde_json::from_value(input).unwrap()).is_err());
        assert!(tasks_list(&c).unwrap().is_empty());
    }
}

#[test]
fn incoming_details_update_with_outgoing_off_without_erasing_unsent_local_edits(){
    use crate::outlook::{OutlookEvent,OutlookSnapshot,OutlookSyncRange,reconcile::{self,RemoteIdentity,RemoteState,Observation}};
    let c=Connection::open_in_memory().unwrap();crate::db::migrate(&c,"2026-10").unwrap();
    let mut e=OutlookEvent{title:"Remote".into(),date:"2026-10-09".into(),end_date:Some("2026-10-10".into()),start_time:Some("22:00:10".into()),end_time:Some("08:00:15".into()),is_all_day:false,location:"Memo".into(),outlook_details:json!({"location":"Room A"}),outlook_series_id:"series".into(),outlook_occurrence_key:"remote".into(),is_recurring:false,recurrence:json!({"type":"none"}),meeting_url:None,remote:Some(RemoteIdentity{imported:true,calendar:"Calendar".into(),entry_id:"entry".into(),store_id:"store".into(),series_id:"series".into(),version:"v1".into(),..Default::default()})};
    let range=OutlookSyncRange::dates("2026-10-09","2026-10-11").unwrap();
    let mut s=OutlookSnapshot{events:vec![e.clone()],observations:vec![],range,calendar_ref:"Calendar".into(),cancelled:vec![],legacy_removed:vec![],warnings:vec![]};
    reconcile::synchronize(&c,&s,"",tasks_revision(&c).unwrap()).unwrap();
    let task=tasks_list(&c).unwrap().remove(0);
    assert!(!task.outlook_enabled);
    assert_eq!(task.end_date.as_deref(),Some("2026-10-10"));
    assert_eq!(task.outlook_details["location"],"Room A");
    e.title="Remote edit".into();e.outlook_details["location"]=json!("Room B");e.remote.as_mut().unwrap().version="v2".into();
    s.events=vec![e.clone()];s.observations=vec![Observation{track:reconcile::capture(&c).unwrap().remove(0),state:RemoteState::Present(Box::new(e.clone()),e.remote.clone().unwrap())}];
    reconcile::synchronize(&c,&s,"",tasks_revision(&c).unwrap()).unwrap();
    let task=tasks_list(&c).unwrap().remove(0);assert!(!task.outlook_enabled);assert_eq!(task.title,"Remote edit");assert_eq!(task.outlook_details["location"],"Room B");
    s.events.clear();s.observations=vec![Observation{track:reconcile::capture(&c).unwrap().remove(0),state:RemoteState::Removed}];
    assert_eq!(reconcile::synchronize(&c,&s,"",tasks_revision(&c).unwrap()).unwrap()["deleted"],1);
    assert!(tasks_list(&c).unwrap().is_empty());
    s.events=vec![e.clone()];s.observations=vec![Observation{track:reconcile::capture(&c).unwrap().remove(0),state:RemoteState::Present(Box::new(e.clone()),e.remote.clone().unwrap())}];
    assert_eq!(reconcile::synchronize(&c,&s,"",tasks_revision(&c).unwrap()).unwrap()["added"],1,"Outlook restore must remain inbound while outgoing is OFF");
    assert!(!tasks_list(&c).unwrap()[0].outlook_enabled);
    let mut patch=serde_json::to_value(task).unwrap();patch["title"]=json!("Unsent local edit");{let task_id=patch["id"].as_str().unwrap().to_owned();tasks_update(&c,&task_id,serde_json::from_value(patch).unwrap())}.unwrap();
    s.observations=vec![Observation{track:reconcile::capture(&c).unwrap().remove(0),state:RemoteState::Removed}];
    let result=reconcile::synchronize(&c,&s,"",tasks_revision(&c).unwrap()).unwrap();
    assert_eq!(result["conflicts"],1);assert_eq!(tasks_list(&c).unwrap()[0].title,"Unsent local edit");
}
#[test]
fn personal_memo_is_separate_from_outlook_body_and_survives_updates() {
    let c=Connection::open_in_memory().unwrap();crate::db::migrate(&c,"2026-10").unwrap();
    let task=tasks_insert(&c,serde_json::from_value(json!({"id":"note","title":"Meeting","date":"2026-10-20","startTime":"09:00","endTime":"10:00","memo":"Outlook meeting body","localMemo":"My note","outlookOccurrenceKey":"external-key","outlookDetails":{"location":"Room A"}})).unwrap()).unwrap();
    assert_eq!(serde_json::to_value(&task).unwrap()["localMemo"],"My note");
    assert_eq!(task.memo,"Outlook meeting body");
    let mut patch=serde_json::to_value(&task).unwrap();patch["localMemo"]=json!("New personal note");
    let task=tasks_update(&c,"note",serde_json::from_value(patch).unwrap()).unwrap().unwrap();
    assert_eq!(task.memo,"Outlook meeting body");
    assert_eq!(serde_json::to_value(&task).unwrap()["localMemo"],"New personal note");
    c.execute("UPDATE tasks SET memo='New Outlook body' WHERE id='note'",[]).unwrap();
    assert_eq!(serde_json::to_value(tasks_get(&c,"note").unwrap().unwrap()).unwrap()["localMemo"],"New personal note");
}

#[test]
fn backup_restore_preserves_personal_memos_and_legacy_backup_rows() {
    let c=Connection::open_in_memory().unwrap();
    crate::db::migrate(&c,"2026-10").unwrap();
    for (id, body, note, key) in [
        ("local", "Local original", Some("Bulk note"), None),
        ("remote", "Outlook body", Some("Bulk note"), Some("external-1")),
        ("cleared", "Previous body", Some(""), Some("external-2")),
        ("legacy-local", "Legacy local note", None, None),
        ("legacy-remote", "Legacy Outlook body", None, Some("external-3")),
    ] {
        let input=json!({"id":id,"title":id,"date":"2026-10-20","startTime":"09:00","endTime":"10:00",
            "memo":body,"localMemo":note,"outlookOccurrenceKey":key,"outlookDetails":{"location":"Room A"}});
        tasks_insert(&c,serde_json::from_value(input).unwrap()).unwrap();
    }
    tasks_insert(&c,serde_json::from_value(json!({"id":"legacy-series","title":"legacy-series","date":"2026-10-20",
        "startTime":"09:00","endTime":"10:00","memo":"Series Outlook body","outlookSeriesId":"remote-series"})).unwrap()).unwrap();
    let mut backup=backup_export(&c).unwrap();
    let mut invalid_backup=backup.clone();
    invalid_backup["tasks"][0]["localMemo"]=json!(42);
    assert!(backup_restore(&c,&invalid_backup).is_err());
    assert_eq!(tasks_list(&c).unwrap().len(),6,"invalid backup must not replace existing data");
    for task in backup["tasks"].as_array_mut().unwrap() {
        if task["id"].as_str().unwrap().starts_with("legacy-") {
            task.as_object_mut().unwrap().remove("localMemo");
        }
    }
    backup_restore(&c,&backup).unwrap();
    let local=tasks_get(&c,"local").unwrap().unwrap();
    let remote=tasks_get(&c,"remote").unwrap().unwrap();
    let cleared=tasks_get(&c,"cleared").unwrap().unwrap();
    let legacy_local=tasks_get(&c,"legacy-local").unwrap().unwrap();
    let legacy_remote=tasks_get(&c,"legacy-remote").unwrap().unwrap();
    let legacy_series=tasks_get(&c,"legacy-series").unwrap().unwrap();
    assert_eq!(local.local_memo.as_deref(),Some("Bulk note"));
    assert_eq!(local.memo,"Local original");
    assert_eq!(remote.personal_memo(),"Bulk note");
    assert_eq!(remote.memo,"Outlook body");
    assert_eq!(remote.outlook_occurrence_key.as_deref(),Some("external-1"));
    assert_eq!(remote.outlook_details["location"],"Room A");
    assert_eq!(cleared.local_memo.as_deref(),Some(""));
    assert_eq!(cleared.personal_memo(),"");
    assert_eq!(legacy_local.local_memo,None);
    assert_eq!(legacy_local.personal_memo(),"Legacy local note");
    assert_eq!(legacy_remote.local_memo,None);
    assert_eq!(legacy_remote.personal_memo(),"");
    assert_eq!(legacy_remote.memo,"Legacy Outlook body");
    assert_eq!(legacy_series.local_memo,None);
    assert_eq!(legacy_series.personal_memo(),"");
    crate::db::migrate(&c,"2026-10").unwrap();
    let restarted_series=tasks_get(&c,"legacy-series").unwrap().unwrap();
    assert_eq!(restarted_series.local_memo,None);
    assert_eq!(restarted_series.personal_memo(),"");
    assert_eq!(restarted_series.memo,"Series Outlook body");
    assert_eq!(tasks_get(&c,"local").unwrap().unwrap().personal_memo(),"Bulk note");
    assert_eq!(tasks_get(&c,"remote").unwrap().unwrap().personal_memo(),"Bulk note");
    assert_eq!(tasks_get(&c,"cleared").unwrap().unwrap().local_memo.as_deref(),Some(""));
}

#[test]
fn series_only_import_does_not_turn_outlook_body_into_a_personal_memo() {
    let c=Connection::open_in_memory().unwrap();crate::db::migrate(&c,"2026-10").unwrap();
    let imported=tasks_insert(&c,serde_json::from_value(json!({"id":"series-import","title":"Remote","date":"2026-10-20",
        "startTime":"09:00","endTime":"10:00","memo":"Outlook body","outlookSeriesId":"remote-series"})).unwrap()).unwrap();
    assert_eq!(imported.local_memo,None);
    assert_eq!(imported.personal_memo(),"");
    assert_eq!(imported.memo,"Outlook body");
    let owned=tasks_insert(&c,serde_json::from_value(json!({"id":"series-owned","title":"Owned","date":"2026-10-20",
        "startTime":"09:00","endTime":"10:00","memo":"Owned note","outlookOccurrenceKey":"tcplus:owned","outlookSeriesId":"owned-series"})).unwrap()).unwrap();
    assert_eq!(owned.personal_memo(),"Owned note");
}

#[test]
fn series_only_legacy_migration_keeps_outlook_body_separate() {
    let c=Connection::open_in_memory().unwrap();crate::db::migrate(&c,"2026-10").unwrap();
    c.execute("INSERT INTO tasks(id,date,memo,local_memo,outlook_occurrence_key,outlook_series_id,created_at,updated_at) VALUES('legacy-series','2026-10-20','Outlook body',NULL,NULL,'remote-series','x','x')",[]).unwrap();
    c.execute("INSERT INTO tasks(id,date,memo,local_memo,outlook_occurrence_key,outlook_series_id,created_at,updated_at) VALUES('existing-note','2026-10-20','Outlook body','Personal note',NULL,'remote-series','x','x')",[]).unwrap();
    crate::db::migrate(&c,"2026-10").unwrap();crate::db::migrate(&c,"2026-10").unwrap();
    let row=tasks_get(&c,"legacy-series").unwrap().unwrap();
    assert_eq!(row.local_memo,None);
    assert_eq!(row.personal_memo(),"");
    assert_eq!(row.memo,"Outlook body");
    assert_eq!(tasks_get(&c,"existing-note").unwrap().unwrap().personal_memo(),"Personal note");
}

#[test]
fn legacy_migration_distinguishes_owned_prefix_case() {
    let c=Connection::open_in_memory().unwrap();crate::db::migrate(&c,"2026-10").unwrap();
    c.execute("INSERT INTO tasks(id,date,memo,local_memo,outlook_occurrence_key,created_at,updated_at) VALUES('foreign','2026-10-20','Outlook body',NULL,'TCPLUS:foreign','x','x'),('owned','2026-10-20','Owned note',NULL,'tcplus:owned','x','x')",[]).unwrap();
    crate::db::migrate(&c,"2026-10").unwrap();
    let foreign=tasks_get(&c,"foreign").unwrap().unwrap();
    let owned=tasks_get(&c,"owned").unwrap().unwrap();
    assert_eq!(foreign.local_memo,None);
    assert_eq!(foreign.personal_memo(),"");
    assert_eq!(foreign.memo,"Outlook body");
    assert_eq!(owned.personal_memo(),"Owned note");
}

#[test]
fn bulk_personal_memo_preserves_remote_body_and_does_not_queue_outlook() {
    let c=Connection::open_in_memory().unwrap();crate::db::migrate(&c,"2026-10").unwrap();
    let task=tasks_insert(&c,serde_json::from_value(json!({"id":"bulk-note","title":"Meeting","date":"2026-10-20",
        "startTime":"09:00","endTime":"10:00","memo":"Remote body","localMemo":"Before","outlookEnabled":true})).unwrap()).unwrap();
    c.execute("UPDATE outlook_jobs SET status='done' WHERE task_id=?1",[&task.id]).unwrap();
    let before:(String,i64,String)=c.query_row("SELECT status,revision,payload FROM outlook_jobs WHERE task_id=?1",[&task.id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
    let mut changed=serde_json::to_value(&task).unwrap();changed["localMemo"]=json!("Bulk note");
    let batch=json!({"expected":[{"id":task.id,"updatedAt":task.updated_at}],"upserts":[changed],"deleteIds":[]});
    assert!(tasks_batch(&c,serde_json::from_value(batch).unwrap()).is_ok());
    let saved=tasks_get(&c,&task.id).unwrap().unwrap();
    assert_eq!(saved.memo,"Remote body");assert_eq!(saved.personal_memo(),"Bulk note");
    let after:(String,i64,String)=c.query_row("SELECT status,revision,payload FROM outlook_jobs WHERE task_id=?1",[&task.id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
    assert_eq!(after,before,"a local note edit must not change or enqueue an Outlook job");
}

#[test]
fn backup_restore_preserves_personal_memo_without_reenabling_outlook() {
    let c=Connection::open_in_memory().unwrap();crate::db::migrate(&c,"2026-10").unwrap();
    tasks_insert(&c,serde_json::from_value(json!({"id":"linked-backup","title":"Meeting","date":"2026-10-20",
        "startTime":"09:00","endTime":"10:00","memo":"Remote body","localMemo":"Personal note","outlookEnabled":true})).unwrap()).unwrap();
    let backup=backup_export(&c).unwrap();backup_restore(&c,&backup).unwrap();
    let restored=tasks_get(&c,"linked-backup").unwrap().unwrap();
    assert_eq!(restored.personal_memo(),"Personal note");
    assert_eq!(restored.memo,"Remote body");
    assert!(!restored.outlook_enabled,"restoring a backup must not enable Outlook writes");
    let jobs:i64=c.query_row("SELECT COUNT(*) FROM outlook_jobs",[],|row|row.get(0)).unwrap();
    assert_eq!(jobs,0,"restoring a backup must not enqueue an Outlook job");
}
#[test]
fn personal_note_changes_never_queue_outbound_and_survive_batch_undo() {
    let c=Connection::open_in_memory().unwrap();crate::db::migrate(&c,"2026-10").unwrap();
    let task=tasks_insert(&c,serde_json::from_value(json!({"id":"linked-note","title":"Meeting","date":"2026-10-20","startTime":"09:00","endTime":"10:00","memo":"Remote body","localMemo":"Before","outlookEnabled":true})).unwrap()).unwrap();
    c.execute("UPDATE outlook_jobs SET status='done'",[]).unwrap();
    let mut changed=serde_json::to_value(&task).unwrap();changed["localMemo"]=json!("After");
    let changed=tasks_update(&c,&task.id,serde_json::from_value(changed).unwrap()).unwrap().unwrap();
    let status:String=c.query_row("SELECT status FROM outlook_jobs WHERE task_id=?1",[&task.id],|r|r.get(0)).unwrap();assert_eq!(status,"done");
    let batch=json!({"expected":[{"id":task.id,"updatedAt":changed.updated_at}],"upserts":[serde_json::to_value(&task).unwrap()],"deleteIds":[]});
    assert!(tasks_batch(&c,serde_json::from_value(batch).unwrap()).is_ok());
    let saved=tasks_get(&c,&task.id).unwrap().unwrap();assert_eq!(saved.personal_memo(),"Before");assert_eq!(saved.memo,"Remote body");
    tasks_remove(&c,&task.id).unwrap();
    let archived:String=c.query_row("SELECT deleted_task FROM outlook_links WHERE task_id=?1",[&task.id],|r|r.get(0)).unwrap();assert_eq!(serde_json::from_str::<Value>(&archived).unwrap()["localMemo"],"Before");
}

#[test]
fn migration_preserves_local_notes_and_separates_imported_body_without_erasing_it() {
    let c=Connection::open_in_memory().unwrap();crate::db::migrate(&c,"2026-10").unwrap();
    c.execute("INSERT INTO tasks(id,date,memo,outlook_occurrence_key,created_at,updated_at) VALUES('local','2026-10-20','Existing note',NULL,'x','x'),('remote','2026-10-20','Outlook body','uid|date','x','x')",[]).unwrap();
    crate::db::migrate(&c,"2026-10").unwrap();crate::db::migrate(&c,"2026-10").unwrap();
    let local=tasks_get(&c,"local").unwrap().unwrap();let remote=tasks_get(&c,"remote").unwrap().unwrap();
    assert_eq!(local.personal_memo(),"Existing note");assert_eq!(remote.personal_memo(),"");assert_eq!(remote.memo,"Outlook body");
}
