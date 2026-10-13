use super::*;
struct Cleanup(w::IDispatch);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = automation::method(&self.0, "Delete", &[]);
    }
}
async fn sync(conn: &Connection, calendar: &str, range: OutlookSyncRange) -> Value {
    let tracked = capture(conn).unwrap();
    let revision = crate::repositories::tasks_revision(conn).unwrap();
    let snapshot = fetch_for_sync(calendar.into(), range, tracked)
        .await
        .unwrap();
    synchronize(conn, &snapshot, "", revision).unwrap()
}
#[tokio::test]
#[ignore = "operator only: creates an isolated calendar and its own appointments, no Send or real DB"]
async fn live_preserved_uid_restoration_outside_window_keeps_identity_and_off_flag() {
    let _com = w::CoInitializeEx(co::COINIT::APARTMENTTHREADED).unwrap();
    let outlook = connect_outlook().unwrap();
    let ns = automation::object_method(&outlook, "GetNamespace", &[AutomationValue::from("MAPI")])
        .unwrap();
    let base = default_calendar_folder(&ns).unwrap();
    let folders = automation::object_get(&base, "Folders").unwrap();
    let name = format!(
        "TaskCalendar-identity-test-{}",
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
    let calendar = calendars::identify(&folder).unwrap();
    let items = automation::object_get(&folder, "Items").unwrap();
    let past = date_key(chrono::Local::now().date_naive() - chrono::Duration::days(7));
    let today = date_key(chrono::Local::now().date_naive());
    let item = automation::object_method(&items, "Add", &[AutomationValue::from(1)]).unwrap();
    put_outlook_text(
        &item,
        "Subject",
        "Identity restoration outside import window",
    )
    .unwrap();
    automation::put(&item, "Start", outlook_date(&past, "09:00").unwrap()).unwrap();
    automation::put(&item, "End", outlook_date(&past, "10:00").unwrap()).unwrap();
    automation::method(&item, "Save", &[]).unwrap();
    let uid = automation::text(&item, "GlobalAppointmentID").unwrap();
    let accessor=automation::object_get(&item,"PropertyAccessor").unwrap();
    let goid_schema="http://schemas.microsoft.com/mapi/id/{6ED8DA90-450B-101B-98DA-00AA003F1305}/00030102";
    let goid=automation::method(&accessor,"GetProperty",&[AutomationValue::from(goid_schema)]).unwrap();drop(accessor);
    let conn = Connection::open_in_memory().unwrap();
    crate::db::migrate(&conn, "2026-10").unwrap();
    crate::repositories::settings_set(&conn,&json!({"outlookWriteEnabled":false,"outlookWriteDefault":false,"outlookWriteCalendarName":calendar})).unwrap();
    sync(
        &conn,
        &calendar,
        OutlookSyncRange::dates(&past, &past).unwrap(),
    )
    .await;
    let row = crate::repositories::tasks_list(&conn)
        .unwrap()
        .into_iter()
        .find(|r| r.title == "Identity restoration outside import window")
        .unwrap();
    let id = row.id;
    conn.execute(
        "UPDATE tasks SET outlook_enabled=0,tag_id='preserved-identity-tag' WHERE id=?1",
        [&id],
    )
    .unwrap();
    let trash =
        automation::object_method(&ns, "GetDefaultFolder", &[AutomationValue::from(3)]).unwrap();
    let trashed = automation::object_method(&item, "Move", &[dispatch_argument(&trash)]).unwrap();
    drop(item);
    let range = OutlookSyncRange::dates(&today, &today).unwrap();
    let removed = sync(&conn, &calendar, range).await;
    assert_eq!(removed["deleted"], 1);
    assert!(
        crate::repositories::tasks_get(&conn, &id)
            .unwrap()
            .is_none()
    );
    let restored =
        automation::object_method(&trashed, "Move", &[dispatch_argument(&folder)]).unwrap();
    drop(trashed);
    // This fixture models providers which retain the documented stable UID.
    // The installed provider's Move generates new GOID/RecordKey/SearchKey, a
    // separately verified unsupported identity-loss case. Never do this repair
    // in production: it writes only this test's own newly created appointment.
    if automation::text(&restored,"GlobalAppointmentID").unwrap()!=uid{
        let accessor=automation::object_get(&restored,"PropertyAccessor").unwrap();
        automation::method(&accessor,"SetProperty",&[AutomationValue::from(goid_schema),goid]).unwrap();
        automation::method(&restored,"Save",&[]).unwrap();
    }
    assert_eq!(
        automation::text(&restored, "GlobalAppointmentID").unwrap(),
        uid
    );
    let received = sync(&conn, &calendar, range).await;
    assert_eq!(
        received["restored"], 1,
        "restored past appointment must be resolved outside import window: {received}"
    );
    let row = crate::repositories::tasks_get(&conn, &id).unwrap().unwrap();
    assert_eq!(row.tag_id, "preserved-identity-tag");
    assert!(!row.outlook_enabled);
    assert_eq!(row.date, past);
    assert_eq!(crate::outlook_jobs::counts(&conn).unwrap()["pending"], 0);
}
fn dispatch_argument(item: &w::IDispatch) -> AutomationValue {
    use windows::core::Interface;
    let pointer = item.ptr();
    let borrowed =
        unsafe { windows::Win32::System::Com::IDispatch::from_raw_borrowed(&pointer) }.unwrap();
    AutomationValue::from(borrowed.clone())
}
