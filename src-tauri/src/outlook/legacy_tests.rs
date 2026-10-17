use super::*;
use crate::repositories as repo;

fn db() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    crate::db::migrate(&c, "2026-10").unwrap();
    c
}

#[test]
fn v02_database_migration_then_confirmed_cancel_removes_the_old_import() {
    let c = Connection::open_in_memory().unwrap();
    // The tasks schema shipped in v0.2.1: no source calendar and no link table.
    c.execute_batch(r#"CREATE TABLE tasks (
      id TEXT PRIMARY KEY,title TEXT NOT NULL DEFAULT '',date TEXT NOT NULL,
      is_all_day INTEGER NOT NULL DEFAULT 0,start_time TEXT,end_time TEXT,
      tag_id TEXT NOT NULL DEFAULT '',recurrence TEXT NOT NULL DEFAULT '{"type":"none"}',
      memo TEXT NOT NULL DEFAULT '',outlook_occurrence_key TEXT,outlook_series_id TEXT,
      meeting_url TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      INSERT INTO tasks(id,date,start_time,end_time,outlook_occurrence_key,outlook_series_id,created_at,updated_at)
      VALUES('old','2026-10-17','09:00','10:00','uid-old|2026-10-17T09:00','uid-old','c','r1');
      INSERT INTO tasks(id,date,created_at,updated_at) VALUES('manual','2026-10-17','c','r1');"#).unwrap();
    crate::db::migrate(&c, "2026-10").unwrap();
    assert_eq!(legacy::candidates(&c).unwrap().len(), 1);
    let source = calendar("A");
    legacy::confirm_source(
        &c,
        &source,
        &[legacy::Selection {
            id: "old".into(),
            updated_at: "r1".into(),
        }],
    )
    .unwrap();
    let mut s = snapshot(&source);
    s.cancelled.push(event("old", &source));
    assert_eq!(sync(&c, &s)["deleted"], 1);
    assert!(repo::tasks_get(&c, "old").unwrap().is_none());
    assert!(repo::tasks_get(&c, "manual").unwrap().is_some());
}
fn calendar(id: &str) -> String {
    format!(r#"outlook-folder:{{"entryId":"{id}","storeId":"store","label":"{id}"}}"#)
}
fn row(c: &Connection, id: &str, source: Option<&str>) {
    c.execute("INSERT INTO tasks(id,title,date,start_time,end_time,outlook_occurrence_key,outlook_series_id,outlook_calendar_ref,created_at,updated_at) VALUES(?1,'Legacy meeting','2026-10-17','09:00','10:00',?2,?3,?4,'created','revision-1')",
        params![id,format!("uid-{id}|2026-10-17T09:00"),format!("uid-{id}"),source]).unwrap();
}
fn event(id: &str, source: &str) -> OutlookEvent {
    OutlookEvent {
        title: "Legacy meeting".into(),
        date: "2026-10-17".into(),
        end_date: Some("2026-10-17".into()),
        start_time: Some("09:00".into()),
        end_time: Some("10:00".into()),
        location: String::new(),
        is_all_day: false,
        outlook_series_id: format!("uid-{id}"),
        outlook_occurrence_key: format!("uid-{id}|2026-10-17T09:00"),
        is_recurring: false,
        recurrence: json!({"type":"none"}),
        meeting_url: None,
        outlook_details: json!({}),
        remote: Some(RemoteIdentity {
            imported: true,
            calendar: source.into(),
            entry_id: format!("entry-{id}"),
            store_id: "store".into(),
            series_id: format!("uid-{id}"),
            version: "remote-1".into(),
            ..Default::default()
        }),
    }
}
fn snapshot(source: &str) -> OutlookSnapshot {
    OutlookSnapshot {
        events: vec![],
        cancelled: vec![],
        legacy_removed: vec![],
        observations: vec![],
        warnings: vec![],
        calendar_ref: source.into(),
        range: OutlookSyncRange::new(
            chrono::NaiveDate::from_ymd_opt(2026, 10, 17)
                .unwrap()
                .and_hms_opt(12, 0, 0)
                .unwrap(),
            90,
        ),
    }
}
fn sync(c: &Connection, s: &OutlookSnapshot) -> Value {
    synchronize(c, s, "", repo::tasks_revision(c).unwrap()).unwrap()
}

#[test]
fn legacy_targets_preserve_source_and_revision() {
    let c = db();
    let source = calendar("A");
    row(&c, "old", Some(&source));
    let value = serde_json::to_value(legacy_targets(&c).unwrap()).unwrap();
    assert_eq!(value[0]["calendar"], source);
    assert_eq!(value[0]["updatedAt"], "revision-1");
}
#[test]
fn unresolved_legacy_is_reported_without_deleting_it() {
    let c = db();
    row(&c, "old", None);
    let result = sync(&c, &snapshot(&calendar("A")));
    assert_eq!(result["legacyCandidates"].as_array().map(Vec::len), Some(1));
    assert_eq!(result["legacyCandidates"][0]["id"], "old");
    assert!(repo::tasks_get(&c, "old").unwrap().is_some());
}
#[test]
fn legacy_cancellation_from_another_calendar_does_not_delete() {
    let c = db();
    row(&c, "old", Some(&calendar("B")));
    let mut s = snapshot(&calendar("A"));
    s.cancelled.push(event("old", &calendar("A")));
    let result = sync(&c, &s);
    assert_eq!(result["deleted"], 0);
    assert!(repo::tasks_get(&c, "old").unwrap().is_some());
}

#[test]
fn started_legacy_meeting_is_deleted_after_verified_absence() {
    let c = db();
    let source = calendar("A");
    row(&c, "old", Some(&source));
    // A local task and another calendar must survive the same snapshot.
    row(&c, "other", Some(&calendar("B")));
    c.execute("INSERT INTO tasks(id,title,date,created_at,updated_at) VALUES('manual','Local','2026-10-17','c','u')",[]).unwrap();
    let mut s = snapshot(&source);
    let targets = legacy_targets(&c).unwrap();
    let mut queried = Vec::new();
    legacy::inspect_with(&mut s, &targets, |t| {
        queried.push(t.id.clone());
        Ok(true)
    });
    assert_eq!(queried, vec!["old"]);
    assert_eq!(
        s.range.start.time().to_string(),
        "12:00:00",
        "new imports remain future-only"
    );
    let result = sync(&c, &s);
    assert_eq!(result["deleted"], 1);
    assert!(repo::tasks_get(&c, "old").unwrap().is_none());
    assert!(repo::tasks_get(&c, "other").unwrap().is_some());
    assert!(repo::tasks_get(&c, "manual").unwrap().is_some());
}

#[test]
fn unknown_source_requires_explicit_selection_before_absence_deletion() {
    let c = db();
    let source = calendar("A");
    row(&c, "old", None);
    row(&c, "unselected", None);
    let mut s = snapshot(&source);
    legacy::inspect_with(&mut s, &legacy_targets(&c).unwrap(), |_| {
        panic!("unknown source must not be queried")
    });
    assert_eq!(sync(&c, &s)["deleted"], 0);
    let selection = legacy::Selection {
        id: "old".into(),
        updated_at: "revision-1".into(),
    };
    assert_eq!(
        legacy::confirm_source(&c, &source, &[selection]).unwrap(),
        1
    );
    assert_eq!(
        repo::tasks_list(&c).unwrap().len(),
        2,
        "confirmation does not delete anything"
    );
    let mut next = snapshot(&source);
    legacy::inspect_with(&mut next, &legacy_targets(&c).unwrap(), |_| Ok(true));
    assert_eq!(sync(&c, &next)["deleted"], 1);
    assert!(repo::tasks_get(&c, "unselected").unwrap().is_some());
}

#[test]
fn lookup_errors_and_live_moved_events_preserve_legacy_tasks_even_inside_range() {
    for removed in [
        Ok(false),
        Err("Access denied".to_string()),
        Err("Duplicate UID".to_string()),
    ] {
        let c = db();
        let source = calendar("A");
        row(&c, "old", Some(&source));
        let mut s = snapshot(&source);
        s.range = OutlookSyncRange::dates("2026-10-17", "2026-10-17").unwrap();
        legacy::inspect_with(&mut s, &legacy_targets(&c).unwrap(), |_| removed.clone());
        let result = sync(&c, &s);
        assert_eq!(result["deleted"], 0);
        assert!(repo::tasks_get(&c, "old").unwrap().is_some());
        assert_eq!(
            result["warnings"].as_array().unwrap().is_empty(),
            removed.is_ok()
        );
    }
}

#[test]
fn concurrent_changes_block_legacy_deletion_and_source_confirmation_is_atomic() {
    let c = db();
    let source = calendar("A");
    row(&c, "old", Some(&source));
    let mut s = snapshot(&source);
    legacy::inspect_with(&mut s, &legacy_targets(&c).unwrap(), |_| Ok(true));
    let revision = repo::tasks_revision(&c).unwrap();
    c.execute(
        "UPDATE tasks SET memo='User edit',updated_at='revision-2' WHERE id='old'",
        [],
    )
    .unwrap();
    let result = synchronize(&c, &s, "", revision).unwrap();
    assert_eq!(result["deleted"], 0);
    assert!(repo::tasks_get(&c, "old").unwrap().is_some());
    assert_eq!(
        legacy::apply_removed(&c, &s.legacy_removed, &source).unwrap(),
        0,
        "per-task guards also reject stale observations"
    );
    row(&c, "a", None);
    row(&c, "b", None);
    let result = legacy::confirm_source(
        &c,
        &source,
        &[
            legacy::Selection {
                id: "a".into(),
                updated_at: "revision-1".into(),
            },
            legacy::Selection {
                id: "b".into(),
                updated_at: "stale".into(),
            },
        ],
    );
    assert!(matches!(result, Err(rusqlite::Error::QueryReturnedNoRows)));
    assert!(
        legacy_targets(&c)
            .unwrap()
            .into_iter()
            .find(|t| t.id == "a")
            .unwrap()
            .calendar
            .is_none()
    );
}

#[test]
fn explicit_cancellation_handles_legacy_past_start_after_source_confirmation() {
    let c = db();
    row(&c, "old", None);
    let source = calendar("A");
    let mut s = snapshot(&source);
    s.cancelled.push(event("old", &source));
    assert_eq!(sync(&c, &s)["deleted"], 0);
    legacy::confirm_source(
        &c,
        &source,
        &[legacy::Selection {
            id: "old".into(),
            updated_at: "revision-1".into(),
        }],
    )
    .unwrap();
    assert_eq!(sync(&c, &s)["deleted"], 1);
    assert!(repo::tasks_get(&c, "old").unwrap().is_none());
}

#[test]
fn positive_fetch_does_not_rebind_a_foreign_or_unknown_legacy_source() {
    for source in [None, Some(calendar("B"))] {
        let c = db();
        row(&c, "old", source.as_deref());
        let mut s = snapshot(&calendar("A"));
        s.events.push(event("old", &calendar("A")));
        sync(&c, &s);
        assert!(
            capture(&c).unwrap().is_empty(),
            "must not attach a different calendar link"
        );
        assert_eq!(legacy_targets(&c).unwrap()[0].calendar, source);
        assert_eq!(repo::tasks_list(&c).unwrap().len(), 1);
        s.events.clear();
        s.cancelled.push(event("old", &calendar("A")));
        assert_eq!(sync(&c, &s)["deleted"], 0);
    }
}

#[test]
fn positive_legacy_read_with_confirmed_source_gains_normal_tracking() {
    let c = db();
    let source = calendar("A");
    row(&c, "old", Some(&source));
    let mut s = snapshot(&source);
    s.events.push(event("old", &source));
    sync(&c, &s);
    assert_eq!(capture(&c).unwrap().len(), 1);
    assert!(legacy_targets(&c).unwrap().is_empty());
    let track = capture(&c).unwrap().remove(0);
    let mut deleted = snapshot(&source);
    deleted.observations.push(Observation {
        track,
        state: RemoteState::Removed,
    });
    assert_eq!(sync(&c, &deleted)["deleted"], 1);
}

#[test]
fn moved_or_unverified_recurring_occurrence_is_not_treated_as_cancelled() {
    let c = db();
    let source = calendar("A");
    row(&c, "old", Some(&source));
    let target = legacy_targets(&c).unwrap().remove(0);
    let mut e = event("old", &source);
    e.is_recurring = true;
    e.remote.as_mut().unwrap().recurring = true;
    assert!(legacy::recurring_removed(&target, &e, false).is_err());
    e.remote.as_mut().unwrap().occurrence_start = Some("2026-10-17T09:00:00".into());
    assert_eq!(legacy::recurring_removed(&target, &e, false), Ok(true));
    assert_eq!(legacy::recurring_removed(&target, &e, true), Ok(false));
    e.outlook_occurrence_key = "uid-old|2026-10-18T09:00".into();
    assert!(legacy::recurring_removed(&target, &e, false).is_err());
}

#[test]
fn changed_start_cannot_silently_bind_an_unknown_or_pending_legacy_row() {
    for pending in [false, true] {
        let c = db();
        let source = calendar("A");
        row(&c, "old", pending.then_some(source.as_str()));
        if pending {
            c.execute("INSERT INTO outlook_jobs(task_id,operation,payload,status) VALUES('old','upsert','{}','pending')",[]).unwrap();
        }
        let mut moved = event("old", &source);
        moved.outlook_occurrence_key = "uid-old|2026-10-17T14:00".into();
        moved.start_time = Some("14:00".into());
        moved.end_time = Some("15:00".into());
        let mut s = snapshot(&source);
        s.events.push(moved);
        sync(&c, &s);
        let old = repo::tasks_get(&c, "old").unwrap().unwrap();
        assert_eq!(old.start_time.as_deref(), Some("09:00"));
        assert_eq!(
            old.outlook_occurrence_key.as_deref(),
            Some("uid-old|2026-10-17T09:00")
        );
        assert!(!capture(&c).unwrap().iter().any(|t| t.id == "old"));
        let saved: Option<String> = c
            .query_row(
                "SELECT outlook_calendar_ref FROM tasks WHERE id='old'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(saved, pending.then_some(source));
    }
}

#[test]
fn ambiguous_recurring_positive_and_cancelled_snapshots_cannot_bypass_identity_checks() {
    for active in [true, false] {
        for readonly in [false, true] {
            let c = db();
            let source = calendar("A");
            row(&c, "old", Some(&source));
            let mut e = event("old", &source);
            e.is_recurring = true;
            e.remote.as_mut().unwrap().recurring = true;
            if readonly {
                e.remote.as_mut().unwrap().occurrence_start = Some("2026-10-17T09:00:00".into());
                e.remote.as_mut().unwrap().read_only = Some("Ambiguous original occurrence".into());
            }
            let mut s = snapshot(&source);
            if active {
                s.events.push(e);
            } else {
                s.cancelled.push(e);
            }
            let result = sync(&c, &s);
            assert!(repo::tasks_get(&c, "old").unwrap().is_some());
            assert!(!capture(&c).unwrap().iter().any(|t| t.id == "old"));
            assert!(!result["warnings"].as_array().unwrap().is_empty());
        }
    }
}

#[test]
fn global_id_validation_rejects_entry_id_fallback_and_normalizes_exceptions() {
    let global = format!(
        "040000008200E00074C5B7101A82E008{}01000000AA",
        "00".repeat(20)
    );
    assert_eq!(legacy::stable_series_id(&global), Some(global.clone()));
    let mut exception = global.clone();
    exception.replace_range(32..40, "07EA0A11");
    assert_eq!(
        legacy::stable_series_id(&exception.to_lowercase()),
        Some(global)
    );
    assert!(legacy::stable_series_id("00000000ENTRYID").is_none());
    assert!(
        legacy::stable_series_id(&format!(
            "040000008200E00074C5B7101A82E008{}01000000",
            "00".repeat(20)
        ))
        .is_none()
    );
}
