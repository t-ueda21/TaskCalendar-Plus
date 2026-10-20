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
