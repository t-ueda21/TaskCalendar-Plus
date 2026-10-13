use super::*;
struct Cleanup(w::IDispatch);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = automation::method(&self.0, "Delete", &[]);
    }
}
fn appointment(folder: &w::IDispatch, rule: &Value) -> w::IDispatch {
    let items = automation::object_get(folder, "Items").unwrap();
    let item = automation::object_method(&items, "Add", &[AutomationValue::from(1)]).unwrap();
    automation::put(
        &item,
        "Subject",
        AutomationValue::from("TaskCalendar native recurrence isolated test"),
    )
    .unwrap();
    automation::put(
        &item,
        "Start",
        outlook_date("2027-01-01", "09:00:00").unwrap(),
    )
    .unwrap();
    automation::put(
        &item,
        "End",
        outlook_date("2027-01-01", "10:00:00").unwrap(),
    )
    .unwrap();
    apply(&item, rule).unwrap();
    automation::method(&item, "Save", &[]).unwrap();
    item
}
fn get(ns: &w::IDispatch, id: &str, store: &str) -> w::IDispatch {
    automation::object_method(
        ns,
        "GetItemFromID",
        &[AutomationValue::from(id), AutomationValue::from(store)],
    )
    .unwrap()
}
fn occurrence(master: &w::IDispatch, date: &str) -> Result<w::IDispatch, String> {
    let p = automation::object_method(master, "GetRecurrencePattern", &[])?;
    automation::object_method(&p, "GetOccurrence", &[outlook_date(date, "09:00:00")?])
}
#[test]
#[ignore = "operator only: creates and deletes one isolated Outlook test calendar; never sends"]
fn live_native_rules_and_series_exceptions_in_temporary_calendar() {
    let _com = w::CoInitializeEx(co::COINIT::APARTMENTTHREADED).unwrap();
    let outlook = connect_outlook().unwrap();
    let ns = automation::object_method(&outlook, "GetNamespace", &[AutomationValue::from("MAPI")])
        .unwrap();
    let base = default_calendar_folder(&ns).unwrap();
    let folders = automation::object_get(&base, "Folders").unwrap();
    let name = format!(
        "TaskCalendar-native-test-{}",
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
    let _cleanup = Cleanup(folder.clone());
    let store = automation::text(&folder, "StoreID").unwrap();
    for kind in [0, 1, 2, 3, 5, 6] {
        eprintln!("Testing native recurrence type {kind}");
        let interval = if [5, 6].contains(&kind) { 24 } else { 2 };
        let rule = json!({"recurrenceType":kind,"interval":interval,"dayOfWeekMask":2,"dayOfMonth":15,"monthOfYear":6,"instance":5,"patternStartDate":"2027-01-01","patternEndDate":null,"occurrences":5,"noEndDate":false});
        let item = appointment(&folder, &rule);
        let id = automation::text(&item, "EntryID").unwrap();
        drop(item);
        let item = get(&ns, &id, &store);
        let imported = read(&item).unwrap();
        assert_eq!(imported["native"]["recurrenceType"], kind);
        assert_eq!(imported["native"]["interval"], interval);
        assert_eq!(imported["native"]["occurrences"], 5);
        apply(&item, &imported).unwrap();
        automation::method(&item, "Save", &[]).unwrap();
        drop(item);
        assert_eq!(
            read(&get(&ns, &id, &store)).unwrap(),
            imported,
            "native type {kind}"
        );
    }
    let rule = json!({"recurrenceType":0,"interval":1,"dayOfWeekMask":0,"dayOfMonth":0,"monthOfYear":0,"instance":0,"patternStartDate":"2027-01-01","patternEndDate":"2027-01-10","occurrences":null,"noEndDate":false});
    let standalone = appointment(&folder, &rule);
    automation::method(&standalone, "ClearRecurrencePattern", &[]).unwrap();
    automation::method(&standalone, "Save", &[]).unwrap();
    let standalone_id = automation::text(&standalone, "EntryID").unwrap();
    drop(standalone);
    let conversion = SeriesEditRequest {
        entry_id: standalone_id.clone(),
        store_id: store.clone(),
        expected_rule: Value::Null,
        rule: rule.clone(),
        scope: "all".into(),
        split_date: None,
        external_key: "conversion-test".into(),
        payload: None,
    };
    let converted = execute(&ns, &conversion).unwrap();
    assert_eq!(converted.rule["type"], "native");
    let removal = SeriesEditRequest {
        expected_rule: converted.rule,
        rule: Value::Null,
        ..conversion
    };
    let removed = execute(&ns, &removal).unwrap();
    assert_eq!(removed.rule["type"], "none");
    assert_eq!(removed.new_entry_id, standalone_id);
    let item = appointment(&folder, &rule);
    let id = automation::text(&item, "EntryID").unwrap();
    let ex = occurrence(&item, "2027-01-02").unwrap();
    automation::put(
        &ex,
        "Subject",
        AutomationValue::from("Past exception preserved"),
    )
    .unwrap();
    automation::method(&ex, "Save", &[]).unwrap();
    drop(ex);
    drop(item);
    let asset_dir = tempfile::tempdir().unwrap();
    let asset = asset_dir.path().join("exception-note.txt");
    std::fs::write(&asset, "Preserve attachment bytes 日本語").unwrap();
    let item = get(&ns, &id, &store);
    let ex = occurrence(&item, "2027-01-07").unwrap();
    automation::put(
        &ex,
        "Body",
        AutomationValue::from("Future exception body preserved"),
    )
    .unwrap();
    let attachments = automation::object_get(&ex, "Attachments").unwrap();
    automation::object_method(
        &attachments,
        "Add",
        &[AutomationValue::from(asset.to_string_lossy().as_ref())],
    )
    .unwrap();
    drop(attachments);
    let props = automation::object_get(&ex, "UserProperties").unwrap();
    let custom = automation::object_method(
        &props,
        "Add",
        &[
            AutomationValue::from("TestCustomField"),
            AutomationValue::from(1),
            AutomationValue::from(false),
        ],
    )
    .unwrap();
    automation::put(&custom, "Value", AutomationValue::from("custom 日本語")).unwrap();
    drop(custom);
    drop(props);
    automation::method(&ex, "Save", &[]).unwrap();
    drop(ex);
    drop(item);
    let item = get(&ns, &id, &store);
    let ex = occurrence(&item, "2027-01-08").unwrap();
    automation::method(&ex, "Delete", &[]).unwrap();
    drop(ex);
    drop(item);
    let item = get(&ns, &id, &store);
    let baseline = read(&item).unwrap();
    let old_series = automation::text(&item, "GlobalAppointmentID").unwrap();
    drop(item);
    let request = SeriesEditRequest {
        entry_id: id.clone(),
        store_id: store.clone(),
        expected_rule: baseline.clone(),
        rule: baseline.clone(),
        scope: "future".into(),
        split_date: Some("2027-01-05".into()),
        external_key: format!("native-test-{}", chrono::Utc::now().timestamp_millis()),
        payload: None,
    };
    // Simulate process interruption immediately after Copy: its operation marker
    // exists, but its independent external key and new rule have not been saved.
    let old = get(&ns, &id, &store);
    let props = automation::object_get(&old, "UserProperties").unwrap();
    let marker = automation::object_method(
        &props,
        "Add",
        &[
            AutomationValue::from("TaskCalendarSeriesOperation"),
            AutomationValue::from(1),
            AutomationValue::from(true),
        ],
    )
    .unwrap();
    automation::put(
        &marker,
        "Value",
        AutomationValue::from(request.external_key.as_str()),
    )
    .unwrap();
    drop(marker);
    drop(props);
    automation::method(&old, "Save", &[]).unwrap();
    let interrupted = automation::object_method(&old, "Copy", &[]).unwrap();
    let interrupted_id = automation::text(&interrupted, "EntryID").unwrap();
    drop(interrupted);
    drop(old);
    let saved = execute(&ns, &request).unwrap();
    assert_ne!(saved.new_entry_id, id);
    assert_eq!(
        saved.new_entry_id, interrupted_id,
        "interrupted copy must be recovered without another master"
    );
    assert_ne!(
        saved.new_series_id, old_series,
        "split must have an independent series identity"
    );
    assert_eq!(
        saved.rule["native"]["patternEndDate"], "2027-01-10",
        "splitting an unchanged rule must retain its original termination"
    );
    let old = get(&ns, &id, &store);
    assert_eq!(
        automation::text(&occurrence(&old, "2027-01-02").unwrap(), "Subject").unwrap(),
        "Past exception preserved"
    );
    assert!(occurrence(&old, "2027-01-05").is_err());
    drop(old);
    let future = get(&ns, &saved.new_entry_id, &store);
    let ex = occurrence(&future, "2027-01-07").unwrap();
    assert_eq!(
        automation::text(&ex, "Body").unwrap().trim_end(),
        "Future exception body preserved"
    );
    let attachments = automation::object_get(&ex, "Attachments").unwrap();
    assert_eq!(automation::integer(&attachments, "Count").unwrap(), 1);
    let attached =
        automation::object_method(&attachments, "Item", &[AutomationValue::from(1)]).unwrap();
    assert_eq!(
        automation::text(&attached, "FileName").unwrap(),
        "exception-note.txt"
    );
    let restored = asset_dir.path().join("restored.txt");
    automation::method(
        &attached,
        "SaveAsFile",
        &[AutomationValue::from(restored.to_string_lossy().as_ref())],
    )
    .unwrap();
    assert_eq!(
        std::fs::read(restored).unwrap(),
        std::fs::read(asset).unwrap()
    );
    drop(attached);
    drop(attachments);
    let props = automation::object_get(&ex, "UserProperties").unwrap();
    let custom = automation::object_method(
        &props,
        "Find",
        &[
            AutomationValue::from("TestCustomField"),
            AutomationValue::from(true),
        ],
    )
    .unwrap();
    assert_eq!(automation::text(&custom, "Value").unwrap(), "custom 日本語");
    drop(custom);
    drop(props);
    drop(ex);
    assert!(occurrence(&future, "2027-01-08").is_err());
    drop(future);
    let again = execute(&ns, &request).unwrap();
    assert_eq!(
        again.new_entry_id, saved.new_entry_id,
        "retry must not duplicate future master"
    );
}
