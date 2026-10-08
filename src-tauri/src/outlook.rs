//! Outlook COM連携。
//!
//! windows-rs + winsafe(late-bound IDispatch自動化)でOutlookの予定を取得する。
//! COMはCOMアパートメント(STA)に紐づくため、専用スレッドを1本立てて
//! そこでCoInitializeEx済みの状態を保ち、以降のOutlook操作はすべて
//! そのスレッド上で処理する(呼び出し側のスレッドをブロックしないため)。

use serde_json::{Value, json};
use std::sync::OnceLock;
use std::sync::mpsc as std_mpsc;
use std::thread;
use tokio::sync::oneshot;
use winsafe::prelude::*;
use winsafe::{self as w, co};

const OL_FOLDER_CALENDAR: i32 = 9;
const OL_APPOINTMENT_CLASS: i32 = 26;
const SAFETY_MAX_ITEMS: i32 = 5000;

#[cfg(test)]
#[path = "outlook/enumeration_tests.rs"]
mod enumeration_tests;

fn meeting_status_is_active(status: i32) -> Result<bool, String> {
    // Outlook.OlMeetingStatus: 5=主催者側のキャンセル、7=受信したキャンセル。
    // 件名では判定しない。状態を確認できない場合は同期全体を中止して既存タスクを守る。
    match status {
        0 | 1 | 3 => Ok(true),
        5 | 7 => Ok(false),
        _ => Err(format!("Outlookの会議状態が不正です: {status}")),
    }
}

#[derive(Debug, Clone)]
pub struct OutlookEvent {
    pub title: String,
    pub date: String,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub location: String,
    pub is_all_day: bool,
    pub outlook_series_id: String,
    pub outlook_occurrence_key: String,
    pub is_recurring: bool,
    pub recurrence: Value,
    pub meeting_url: Option<String>,
}

/// COMで取得した範囲をそのまま削除判定にも使う。取得中に日付が変わっても再計算しない。
pub struct OutlookSnapshot {
    pub events: Vec<OutlookEvent>,
    pub range: OutlookSyncRange,
}

#[derive(Debug, Clone, Copy)]
pub struct OutlookSyncRange {
    pub start: chrono::NaiveDateTime,
    pub end_exclusive: chrono::NaiveDateTime,
}

impl OutlookSyncRange {
    #[cfg(test)]
    fn assert_current_time_boundary() {
        let noon = chrono::NaiveDate::from_ymd_opt(2026, 10, 7).unwrap().and_hms_opt(12, 0, 0).unwrap();
        let range = Self::new(noon, 1);
        assert!(!range.contains(noon - chrono::Duration::minutes(1)));
        assert!(range.contains(noon));
    }
    pub fn new(now: chrono::NaiveDateTime, days_ahead: i64) -> Self {
        Self {
            start: now,
            end_exclusive: (now.date() + chrono::Duration::days(days_ahead.clamp(1, 365) + 1)).and_hms_opt(0, 0, 0).unwrap(),
        }
    }

    pub fn dates(start: &str, end: &str) -> Result<Self, String> {
        let parse = |value: &str| chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| "Invalid date: use YYYY-MM-DD".to_string());
        let first = parse(start)?;
        let last = parse(end)?;
        if last < first { return Err("End date must not precede start date".into()); }
        if (last - first).num_days() > 365 { return Err("Select no more than 366 days".into()); }
        let next = last.succ_opt().ok_or("End date is out of range")?;
        Ok(Self { start: first.and_hms_opt(0,0,0).unwrap(), end_exclusive: next.and_hms_opt(0,0,0).unwrap() })
    }

    pub fn start_key(self) -> String {
        date_key(self.start.date())
    }
    pub fn end_key(self) -> String {
        date_key(self.end_exclusive.date() - chrono::Duration::days(1))
    }

    pub fn contains(self, start: chrono::NaiveDateTime) -> bool {
        self.start <= start && start < self.end_exclusive
    }

    pub fn contains_task(self, date: &str, time: Option<&str>) -> bool {
        let value = format!("{date} {}:00", time.unwrap_or("00:00"));
        chrono::NaiveDateTime::parse_from_str(&value, "%Y-%m-%d %H:%M:%S").is_ok_and(|start| self.contains(start))
    }

    fn restrict_filter(self) -> String {
        // COM's locale-dependent Restrict compares minute precision; contains()
        // applies the exact second boundary after enumeration.
        format!(
            "[Start] >= '{}' AND [Start] < '{}'",
            self.start.format("%m/%d/%Y %I:%M %p"),
            self.end_exclusive.format("%m/%d/%Y %I:%M %p")
        )
    }
}

struct OutlookRequest {
    calendar_name: String,
    range: OutlookSyncRange,
    reply: oneshot::Sender<Result<OutlookSnapshot, String>>,
}

#[derive(Clone)]
pub struct WriteRequest {
    pub operation: String,
    pub payload: crate::outlook_jobs::WritePayload,
    pub calendar_name: String,
    pub entry_id: Option<String>,
    pub store_id: Option<String>,
    pub external_key: String,
}

#[derive(Default)]
pub struct WriteIdentity { pub entry_id: String, pub store_id: String, pub occurrence_key: String, pub series_id: String }

enum WorkerRequest { Fetch(OutlookRequest), Write(Box<WriteRequest>, oneshot::Sender<Result<WriteIdentity, String>>) }

impl WorkerRequest {
    fn fail(self, message: String) {
        match self { Self::Fetch(request) => { let _ = request.reply.send(Err(message)); }, Self::Write(_, reply) => { let _ = reply.send(Err(message)); } }
    }
}

static WORKER: OnceLock<std_mpsc::Sender<WorkerRequest>> = OnceLock::new();

#[test]
fn current_time_excludes_past_starts() { OutlookSyncRange::assert_current_time_boundary(); }

fn worker_sender() -> std_mpsc::Sender<WorkerRequest> {
    WORKER
        .get_or_init(|| {
            let (tx, rx) = std_mpsc::channel::<WorkerRequest>();
            thread::Builder::new()
                .name("outlook-com-worker".into())
                .spawn(move || outlook_worker_loop(rx))
                .expect("spawn outlook COM worker thread");
            tx
        })
        .clone()
}

fn outlook_worker_loop(rx: std_mpsc::Receiver<WorkerRequest>) {
    let com_guard = w::CoInitializeEx(co::COINIT::APARTMENTTHREADED | co::COINIT::DISABLE_OLE1DDE);
    let _com_guard = match com_guard {
        Ok(g) => g,
        Err(e) => {
            let msg = format!("CoInitializeEx に失敗しました: {e}");
            for req in rx {
                req.fail(msg.clone());
            }
            return;
        }
    };
    for req in rx {
        match req {
            WorkerRequest::Fetch(req) => { let result = get_outlook_events(&req.calendar_name, req.range); let _ = req.reply.send(result); },
            WorkerRequest::Write(request, reply) => { let _ = reply.send(write_outlook_event(&request)); },
        }
    }
    // _com_guardのDropでCoUninitializeが呼ばれる(ここまでスレッド生存)。
}

/// Outlookカレンダーから予定一覧を取得する(F-OUTLOOK-001, 002, 005)。
/// ブロッキングCOM呼び出しは専用ワーカースレッドへ委譲し、HTTPサーバー
/// 側のtokioランタイムをブロックしない。
#[cfg(test)]
pub async fn fetch_events(
    calendar_name: String,
    days_ahead: i64,
) -> Result<OutlookSnapshot, String> {
    fetch_events_in_range(calendar_name, OutlookSyncRange::new(chrono::Local::now().naive_local(), days_ahead)).await
}

pub async fn fetch_events_in_range(calendar_name: String, range: OutlookSyncRange) -> Result<OutlookSnapshot, String> {
    let tx = worker_sender();
    let (reply_tx, reply_rx) = oneshot::channel();
    tx.send(WorkerRequest::Fetch(OutlookRequest {
        calendar_name,
        range,
        reply: reply_tx,
    }))
    .map_err(|_| "Outlookワーカースレッドが終了しています".to_string())?;
    reply_rx
        .await
        .map_err(|_| "Outlookワーカーからの応答がありませんでした".to_string())?
}

pub async fn write_event(request: WriteRequest) -> Result<WriteIdentity,String> {
    let (reply, response) = oneshot::channel();
    worker_sender().send(WorkerRequest::Write(Box::new(request),reply)).map_err(|_| "Outlook worker stopped")?;
    response.await.map_err(|_| "Outlook worker did not return a response")?
}

const TASK_KEY_PROPERTY: &str = "TCPlusTaskKey";

fn imported_memo(body: &str, location: &str, managed: bool) -> String {
    if managed { body.to_string() } else { location.to_string() }
}

#[test]
fn managed_appointments_preserve_body_as_task_memo() {
    assert_eq!(imported_memo("User memo","Room A",true),"User memo");
    assert_eq!(imported_memo("External body","Room A",false),"Room A");
}

fn task_property(item: &w::IDispatch) -> Result<Option<String>,String> {
    let properties = item.invoke_get("UserProperties", &[]).map_err(|e|e.to_string())?.unwrap_dispatch_opt().ok_or("Outlook user properties unavailable")?;
    let property = properties.invoke_method("Find", &[&w::Variant::from_str(TASK_KEY_PROPERTY), &w::Variant::Bool(true)]).map_err(|e|e.to_string())?.unwrap_dispatch_opt();
    match property { Some(property) => Ok(variant_to_opt_string(&property.invoke_get("Value",&[]).map_err(|e|e.to_string())?)), None => Ok(None) }
}

fn outlook_date(date: &str, time: &str) -> Result<w::Variant,String> {
    use chrono::{Datelike,Timelike};
    let day = chrono::NaiveDate::parse_from_str(date,"%Y-%m-%d").map_err(|_| "Invalid appointment date")?;
    let value = if time == "24:00" { day.succ_opt().ok_or("Invalid appointment end")?.and_hms_opt(0,0,0).unwrap() } else {
        day.and_time(chrono::NaiveTime::parse_from_str(time,"%H:%M").map_err(|_| "Invalid appointment time")?)
    };
    Ok(w::Variant::Date(w::SYSTEMTIME { wYear:value.year() as u16,wMonth:value.month() as u16,wDay:value.day() as u16,wHour:value.hour() as u16,wMinute:value.minute() as u16,..Default::default() }))
}

fn write_outlook_event(request: &WriteRequest) -> Result<WriteIdentity,String> {
    let outlook = connect_outlook()?;
    let namespace = outlook.invoke_method("GetNamespace", &[&w::Variant::from_str("MAPI")]).map_err(|e|e.to_string())?.unwrap_dispatch_opt().ok_or("Outlook namespace unavailable")?;
    let folder = if is_default_calendar_name(&request.calendar_name) { default_calendar_folder(&namespace)? } else {
        resolve_named_calendar(&request.calendar_name,lookup_named_calendar(&namespace,&request.calendar_name,true))?
    };
    let items = folder.invoke_get("Items", &[]).map_err(|e|e.to_string())?.unwrap_dispatch_opt().ok_or("Outlook items unavailable")?;
    let store_id = variant_to_opt_string(&folder.invoke_get("StoreID",&[]).map_err(|e|e.to_string())?).ok_or("Outlook store ID unavailable")?;
    // Register the folder field before Restrict. Then no matches is a proven absence,
    // including a retry after Save succeeded but its response was lost.
    let definitions = folder.invoke_get("UserDefinedProperties",&[]).map_err(|e|e.to_string())?.unwrap_dispatch_opt().ok_or("Outlook field definitions unavailable")?;
    if definitions.invoke_method("Find", &[&w::Variant::from_str(TASK_KEY_PROPERTY)]).map_err(|e|e.to_string())?.unwrap_dispatch_opt().is_none() {
        definitions.invoke_method("Add", &[&w::Variant::from_str(TASK_KEY_PROPERTY),&w::Variant::I4(1)]).map_err(|e|e.to_string())?;
    }
    let known = match (&request.entry_id,&request.store_id) {
        (Some(id),Some(store)) => namespace.invoke_method("GetItemFromID", &[&w::Variant::from_str(id),&w::Variant::from_str(store)]).ok().and_then(|value| value.unwrap_dispatch_opt()),
        _ => None,
    };
    let found = if let Some(item) = known {
        if task_property(&item)?.as_deref() != Some(&request.external_key) { return Err("Outlook appointment identity does not match this task; refusing to modify it".into()); }
        Some(item)
    } else {
        let filter = format!("[{TASK_KEY_PROPERTY}] = '{}'",request.external_key.replace('\'',"''"));
        let matching = items.invoke_method("Restrict", &[&w::Variant::from_str(&filter)]).map_err(|e|format!("Cannot safely reconcile Outlook appointment: {e}"))?.unwrap_dispatch_opt().ok_or("Outlook reconciliation unavailable")?;
        let count = variant_to_i32(&matching.invoke_get("Count", &[]).map_err(|e|e.to_string())?).ok_or("Outlook reconciliation returned invalid count")?;
        if count > 1 { return Err("Multiple Outlook appointments have the same task identity".into()); }
        if count == 1 { matching.invoke_method("Item", &[&w::Variant::I4(1)]).map_err(|e|e.to_string())?.unwrap_dispatch_opt() } else { None }
    };
    if request.operation == "delete" {
        if let Some(item) = found { item.invoke_method("Delete",&[]).map_err(|e|e.to_string())?; }
        return Ok(WriteIdentity::default());
    }
    if request.operation != "upsert" { return Err("Invalid Outlook write operation".into()); }
    let item = match found { Some(item) => item, None => items.invoke_method("Add", &[&w::Variant::I4(1)]).map_err(|e|e.to_string())?.unwrap_dispatch_opt().ok_or("Could not create Outlook appointment")? };
    let payload = &request.payload;
    let start = outlook_date(&payload.date, if payload.is_all_day { "00:00" } else { payload.start_time.as_deref().ok_or("Start time missing")? })?;
    let end = outlook_date(&payload.date, if payload.is_all_day { "24:00" } else { payload.end_time.as_deref().ok_or("End time missing")? })?;
    item.invoke_put("Subject",&w::Variant::from_str(&payload.title)).map_err(|e|e.to_string())?;
    item.invoke_put("Body",&w::Variant::from_str(&payload.memo)).map_err(|e|e.to_string())?;
    item.invoke_put("Start",&start).map_err(|e|e.to_string())?;
    item.invoke_put("End",&end).map_err(|e|e.to_string())?;
    item.invoke_put("AllDayEvent",&w::Variant::Bool(payload.is_all_day)).map_err(|e|e.to_string())?;
    let properties = item.invoke_get("UserProperties",&[]).map_err(|e|e.to_string())?.unwrap_dispatch_opt().ok_or("Outlook properties unavailable")?;
    let property = match properties.invoke_method("Find", &[&w::Variant::from_str(TASK_KEY_PROPERTY),&w::Variant::Bool(true)]).map_err(|e|e.to_string())?.unwrap_dispatch_opt() {
        Some(property) => property,
        None => properties.invoke_method("Add", &[&w::Variant::from_str(TASK_KEY_PROPERTY),&w::Variant::I4(1),&w::Variant::Bool(true)]).map_err(|e|e.to_string())?.unwrap_dispatch_opt().ok_or("Could not tag Outlook appointment")?,
    };
    property.invoke_put("Value",&w::Variant::from_str(&request.external_key)).map_err(|e|e.to_string())?;
    item.invoke_method("Save",&[]).map_err(|e|e.to_string())?;
    let entry_id = variant_to_opt_string(&item.invoke_get("EntryID",&[]).map_err(|e|e.to_string())?).ok_or("Saved Outlook appointment did not return its ID")?;
    let series_id = variant_to_opt_string(&item.invoke_get("GlobalAppointmentID",&[]).map_err(|e|e.to_string())?).unwrap_or_else(||entry_id.clone());
    Ok(WriteIdentity {entry_id,store_id,occurrence_key:format!("tcplus:{}",request.external_key),series_id})
}

fn connect_outlook() -> Result<w::IDispatch, String> {
    // 1) 既存起動中インスタンスへアタッチ(GetObject相当)。新規アクティブ化より
    //    Outlookのオブジェクトモデルガードによる確認ダイアログが出にくいため優先する。
    if let Ok(disp) = try_get_active_outlook() {
        return Ok(disp);
    }
    // 2) 新規アクティブ化(CreateObject相当)
    let clsid = w::CLSIDFromProgID("Outlook.Application")
        .map_err(|e| format!("CLSIDFromProgID(Outlook.Application)に失敗しました: {e}"))?;
    w::CoCreateInstance::<w::IDispatch>(&clsid, None::<&w::IUnknown>, co::CLSCTX::LOCAL_SERVER)
        .map_err(|e| {
            format!(
                "Outlookアプリケーションに接続できません。\n確認事項:\n\
             1) New Outlook ではなく Classic Outlook を使用してください。\n\
             2) Outlookを一度手動起動し、初期設定/プロファイル作成を完了してください。\n\
             3) その後、アプリ側の同期を再実行してください。\n詳細: {e}"
            )
        })
}

/// `GetActiveObject`はwinsafeに未実装のため、windowsクレート側で直接呼び、
/// 得たIDispatchポインタの所有権をwinsafe側へ引き渡す。
fn try_get_active_outlook() -> Result<w::IDispatch, String> {
    use windows::Win32::System::Com::IDispatch as WinIDispatch;
    use windows::Win32::System::Ole::GetActiveObject;
    use windows::core::Interface;

    unsafe {
        let clsid =
            windows::Win32::System::Com::CLSIDFromProgID(windows::core::w!("Outlook.Application"))
                .map_err(|e| format!("CLSIDFromProgID(windows crate)に失敗しました: {e}"))?;
        let mut punk: Option<windows::core::IUnknown> = None;
        GetActiveObject(&clsid, None, &mut punk)
            .map_err(|e| format!("GetActiveObjectに失敗しました: {e}"))?;
        let unknown =
            punk.ok_or_else(|| "GetActiveObjectがオブジェクトを返しませんでした".to_string())?;
        let dispatch: WinIDispatch = unknown
            .cast()
            .map_err(|e| format!("IDispatchへのQueryInterfaceに失敗しました: {e}"))?;
        let raw = dispatch.into_raw(); // 所有権をwinsafe側へ移す(Releaseは呼ばれない)。
        Ok(w::IDispatch::from_ptr(raw))
    }
}

fn variant_to_i32(v: &w::Variant) -> Option<i32> {
    match v {
        w::Variant::I4(n) => Some(*n),
        w::Variant::I2(n) => Some(*n as i32),
        w::Variant::UI4(n) => Some(*n as i32),
        w::Variant::R8(n) => Some(*n as i32),
        _ => None,
    }
}

fn variant_to_bool(v: &w::Variant) -> bool {
    matches!(v, w::Variant::Bool(true))
}

fn variant_to_required_bool(v: &w::Variant) -> Option<bool> {
    match v {
        w::Variant::Bool(value) => Some(*value),
        _ => None,
    }
}

fn variant_to_opt_string(v: &w::Variant) -> Option<String> {
    match v {
        w::Variant::Bstr(s) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

fn variant_to_naive_datetime(v: &w::Variant) -> Option<chrono::NaiveDateTime> {
    match v {
        w::Variant::Date(st) => {
            chrono::NaiveDate::from_ymd_opt(st.wYear as i32, st.wMonth as u32, st.wDay as u32)?
                .and_hms_opt(st.wHour as u32, st.wMinute as u32, st.wSecond as u32)
        }
        _ => None,
    }
}

fn date_key(d: chrono::NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}
fn time_key(t: chrono::NaiveDateTime) -> String {
    t.format("%H:%M").to_string()
}

fn find_calendar_folder(
    namespace: &w::IDispatch,
    calendar_name: &str,
) -> Result<w::IDispatch, String> {
    if is_default_calendar_name(calendar_name) {
        return default_calendar_folder(namespace);
    }
    resolve_named_calendar(
        calendar_name,
        lookup_named_calendar(namespace, calendar_name, false),
    )
}

fn is_default_calendar_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("Calendar") || name == "予定表"
}

fn resolve_named_calendar<T>(name: &str, lookup: Result<Option<T>, String>) -> Result<T, String> {
    lookup?.ok_or_else(|| format!("指定された予定表「{name}」が見つかりません"))
}

fn default_calendar_folder(namespace: &w::IDispatch) -> Result<w::IDispatch, String> {
    namespace
        .invoke_method("GetDefaultFolder", &[&w::Variant::I4(OL_FOLDER_CALENDAR)])
        .map_err(|e| format!("既定の予定表フォルダの取得に失敗しました: {e}"))?
        .unwrap_dispatch_opt()
        .ok_or_else(|| "既定の予定表フォルダの取得に失敗しました".to_string())
}

fn lookup_named_calendar(
    namespace: &w::IDispatch,
    calendar_name: &str,
    exact: bool,
) -> Result<Option<w::IDispatch>, String> {
    if calendar_name.trim().is_empty() {
        return Err("予定表名が空です".into());
    }
    let folders = namespace
        .invoke_get("Folders", &[])
        .map_err(|e| format!("Outlookのフォルダ一覧を取得できません: {e}"))?
        .unwrap_dispatch_opt()
        .ok_or_else(|| "Outlookのフォルダ一覧が不正です".to_string())?;
    let root_count = folder_count(&folders)?;
    let mut found = None;
    for i in 1..=root_count {
        let folder = folders
            .invoke_method("Item", &[&w::Variant::I4(i)])
            .map_err(|e| format!("Outlookのフォルダ{i}を取得できません: {e}"))?
            .unwrap_dispatch_opt()
            .ok_or_else(|| format!("Outlookのフォルダ{i}が不正です"))?;
        let subfolders = folder
            .invoke_get("Folders", &[])
            .map_err(|e| format!("Outlookの子フォルダ一覧を取得できません: {e}"))?
            .unwrap_dispatch_opt()
            .ok_or_else(|| "Outlookの子フォルダ一覧が不正です".to_string())?;
        let sub_count = folder_count(&subfolders)?;
        for j in 1..=sub_count {
            let subfolder = subfolders
                .invoke_method("Item", &[&w::Variant::I4(j)])
                .map_err(|e| format!("Outlookの子フォルダ{j}を取得できません: {e}"))?
                .unwrap_dispatch_opt()
                .ok_or_else(|| format!("Outlookの子フォルダ{j}が不正です"))?;
            let name_value = subfolder
                .invoke_get("Name", &[])
                .map_err(|e| format!("Outlookの子フォルダ名を取得できません: {e}"))?;
            let name = variant_to_opt_string(&name_value)
                .ok_or_else(|| "Outlookの子フォルダ名が不正です".to_string())?;
            let item_type = variant_to_i32(&subfolder.invoke_get("DefaultItemType",&[]).map_err(|e|e.to_string())?).ok_or("Cannot identify Outlook folder type")?;
            if item_type == 1 && if exact { name.eq_ignore_ascii_case(calendar_name) } else { name.contains(calendar_name) } {
                if found.is_some() {
                    return Err(format!(
                        "予定表名「{calendar_name}」に複数のフォルダが一致します"
                    ));
                }
                found = Some(subfolder.clone());
            }
            if item_type == 1 {
                // Secondary calendars are commonly children of the default calendar.
                let children = subfolder.invoke_get("Folders",&[]).map_err(|e|e.to_string())?.unwrap_dispatch_opt().ok_or("Calendar folders unavailable")?;
                for child_index in 1..=folder_count(&children)? {
                    let child = children.invoke_method("Item",&[&w::Variant::I4(child_index)]).map_err(|e|e.to_string())?.unwrap_dispatch_opt().ok_or("Calendar folder unavailable")?;
                    let child_name = variant_to_opt_string(&child.invoke_get("Name",&[]).map_err(|e|e.to_string())?).ok_or("Calendar name unavailable")?;
                    let child_type = variant_to_i32(&child.invoke_get("DefaultItemType",&[]).map_err(|e|e.to_string())?);
                    if child_type == Some(1) && if exact { child_name.eq_ignore_ascii_case(calendar_name) } else { child_name.contains(calendar_name) } {
                        if found.is_some() { return Err(format!("Multiple calendars match {calendar_name}")); }
                        found=Some(child);
                    }
                }
            }
        }
    }
    Ok(found)
}

fn folder_count(folders: &w::IDispatch) -> Result<i32, String> {
    let count = folders
        .invoke_get("Count", &[])
        .map_err(|e| format!("Outlookのフォルダ件数を取得できません: {e}"))?;
    let count =
        variant_to_i32(&count).ok_or_else(|| "Outlookのフォルダ件数が不正です".to_string())?;
    if !(0..=1000).contains(&count) {
        return Err("Outlookのフォルダ件数が安全上限を超えています".into());
    }
    Ok(count)
}

// unwrap_dispatchはDispatch以外だとpanicするため、探索コードでは
// panicしないOption版を使う(存在しないFolders等をエラーとして即打ち切らず、
// 既定フォルダへのフォールバックへ進めるため)。
trait UnwrapDispatchOpt {
    fn unwrap_dispatch_opt(&self) -> Option<w::IDispatch>;
}
impl UnwrapDispatchOpt for w::Variant {
    fn unwrap_dispatch_opt(&self) -> Option<w::IDispatch> {
        match self {
            w::Variant::Dispatch(d) => Some(d.clone()),
            _ => None,
        }
    }
}

const RECURRENCE_TYPE_DAILY: i32 = 0;
const RECURRENCE_TYPE_WEEKLY: i32 = 1;
const RECURRENCE_TYPE_MONTHLY: i32 = 2;

fn extract_recurrence(
    item: &w::IDispatch,
    now: chrono::NaiveDateTime,
    days_ahead: i64,
    item_start: chrono::NaiveDateTime,
) -> Value {
    let is_recurring = item
        .invoke_get("IsRecurring", &[])
        .map(|v| variant_to_bool(&v))
        .unwrap_or(false);
    if !is_recurring {
        return json!({ "type": "none" });
    }
    let pattern = match item
        .invoke_method("GetRecurrencePattern", &[])
        .ok()
        .and_then(|v| v.unwrap_dispatch_opt())
    {
        Some(p) => p,
        None => return json!({ "type": "none" }),
    };
    let recurrence_type = pattern
        .invoke_get("RecurrenceType", &[])
        .ok()
        .and_then(|v| variant_to_i32(&v))
        .unwrap_or(-1);
    // 取得失敗だけでなく、Intervalが0の場合も1へフォールバックする。
    let interval = pattern
        .invoke_get("Interval", &[])
        .ok()
        .and_then(|v| variant_to_i32(&v))
        .filter(|&n| n != 0)
        .unwrap_or(1);
    let no_end = pattern
        .invoke_get("NoEndDate", &[])
        .map(|v| variant_to_bool(&v))
        .unwrap_or(false);

    let mapped = if interval == 1 {
        match recurrence_type {
            RECURRENCE_TYPE_DAILY => Some("daily"),
            RECURRENCE_TYPE_WEEKLY => Some("weekly"),
            RECURRENCE_TYPE_MONTHLY => Some("monthly"),
            _ => None,
        }
    } else {
        None
    };
    let Some(mapped) = mapped else {
        return json!({ "type": "none" });
    };

    let fallback_until = now + chrono::Duration::days(365);
    let mut until_dt = if no_end {
        fallback_until
    } else {
        pattern
            .invoke_get("PatternEndDate", &[])
            .ok()
            .and_then(|v| variant_to_naive_datetime(&v))
            .unwrap_or(fallback_until)
    };
    let min_until = now + chrono::Duration::days(days_ahead.max(30));
    if until_dt.date() <= item_start.date() {
        until_dt = min_until;
    }

    json!({ "type": mapped, "until": date_key(until_dt.date()) })
}

fn extract_teams_meeting_url(body: &str) -> Option<String> {
    let idx = body.find("https://teams.microsoft.com/l/meetup-join/")?;
    let rest = &body[idx..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '<' || c == '>')
        .unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

fn collect_bounded<T>(
    limit: usize,
    mut next: impl FnMut() -> Result<Option<T>, String>,
) -> Result<Vec<T>, String> {
    let mut items = Vec::new();
    loop {
        match next()? {
            None => return Ok(items),
            Some(_) if items.len() >= limit => {
                return Err(format!(
                    "Outlookの予定件数が安全上限({limit})を超えています"
                ));
            }
            Some(item) => items.push(item),
        }
    }
}

#[repr(C)]
struct VariantDispatchLayout {
    _vt: u16,
    _reserved: [u16; 3],
    dispatch: *mut std::ffi::c_void,
}

fn next_outlook_item(items: &w::IDispatch, method: &str) -> Result<Option<w::IDispatch>, String> {
    // winsafeのVariant::from_rawはVT_DISPATCHのnullポインタでもAddRefを呼ぶ。
    // OutlookのNothing終端を安全に扱うため、この列挙呼び出しだけ生VARIANTを確認する。
    let id = items
        .GetIDsOfNames(&[method], w::LCID::USER_DEFAULT)
        .map_err(|e| format!("Outlookの予定列挙({method})に失敗しました: {e}"))?[0];
    // winsafe 0.0.28のInvokeはS_OK以外をすべてErrにするため、成功応答の
    // S_FALSE(0x00000001)まで「ファンクションが間違っています」と表示する。
    // windows-rsの呼び出しでHRESULTの成功/失敗を判定し、成功時は返却値を
    // 必ず確認する。S_FALSEだけで終端と決めると返却された予定を失う恐れがある。
    use windows::Win32::System::Com::{DISPATCH_METHOD, DISPPARAMS, IDispatch};
    use windows::core::{GUID, Interface};

    let mut raw = w::VARIANT::default();
    let mut exception = w::EXCEPINFO::default();
    let ptr = items.ptr();
    // 両クレートの構造体は同じWindows COM ABI。winsafe側がDropで
    // VARIANT/BSTRを解放し、借用したIDispatchの所有権はitemsが保持する。
    let result = unsafe {
        IDispatch::from_raw_borrowed(&ptr)
            .expect("items is a non-null IDispatch")
            .Invoke(
                id,
                &GUID::zeroed(),
                w::LCID::USER_DEFAULT.raw(),
                DISPATCH_METHOD,
                &DISPPARAMS::default(),
                Some((&mut raw as *mut w::VARIANT).cast()),
                Some((&mut exception as *mut w::EXCEPINFO).cast()),
                None,
            )
    };
    if let Err(error) = result {
        let hr = unsafe { co::HRESULT::from_raw(error.code().0 as u32) };
        let detail = if hr == co::HRESULT::DISP_E_EXCEPTION {
            exception.to_string()
        } else {
            hr.to_string()
        };
        return Err(format!(
            "Outlookの予定列挙({method})に失敗しました: {detail}"
        ));
    }
    match raw.vt() {
        co::VT::EMPTY | co::VT::NULL => Ok(None),
        co::VT::DISPATCH => {
            // winsafe 0.0.28のVARIANTはrepr(C)で、vt+予約3語の後にポインタを持つ。
            // 生VARIANTがDrop時にReleaseするため、返却用にAddRefした所有ポインタを作る。
            let ptr = unsafe {
                (&raw as *const w::VARIANT)
                    .cast::<VariantDispatchLayout>()
                    .read()
                    .dispatch
            };
            if ptr.is_null() {
                return Ok(None);
            }
            let borrowed = unsafe { w::IDispatch::from_ptr(ptr) };
            let item = borrowed.clone();
            std::mem::forget(borrowed);
            Ok(Some(item))
        }
        _ => Err("Outlookの予定列挙が不正な値を返しました".into()),
    }
}

fn get_outlook_events(calendar_name: &str, range: OutlookSyncRange) -> Result<OutlookSnapshot, String> {
    let now = range.start;
    let days_ahead = (range.end_exclusive.date() - now.date()).num_days();
    let outlook = connect_outlook()?;
    let namespace = outlook
        .invoke_method("GetNamespace", &[&w::Variant::from_str("MAPI")])
        .map_err(|e| format!("GetNamespace('MAPI')に失敗しました: {e}"))?
        .unwrap_dispatch_opt()
        .ok_or_else(|| "GetNamespace('MAPI')に失敗しました".to_string())?;
    let calendar_folder = find_calendar_folder(&namespace, calendar_name)?;

    let items = calendar_folder
        .invoke_get("Items", &[])
        .map_err(|e| format!("Itemsコレクションの取得に失敗しました: {e}"))?
        .unwrap_dispatch_opt()
        .ok_or_else(|| "Itemsコレクションの取得に失敗しました".to_string())?;
    items
        .invoke_method("Sort", &[&w::Variant::from_str("[Start]")])
        .map_err(|e| format!("Outlookの予定を並べ替えられません: {e}"))?;
    items
        .invoke_put("IncludeRecurrences", &w::Variant::Bool(true))
        .map_err(|e| format!("繰り返し予定を取得できません: {e}"))?;

    // Restrict()でCOM側にて事前絞り込みする(全件イテレートは著しく遅いため)。
    // 失敗を空の予定表と扱うと既存予定が消えるため、取得そのものを中止する。
    let filter = range.restrict_filter();

    let filtered_items = items
        .invoke_method("Restrict", &[&w::Variant::from_str(&filter)])
        .map_err(|e| format!("Outlookの予定を絞り込めません: {e}"))?
        .unwrap_dispatch_opt()
        .ok_or_else(|| "Outlookの予定を絞り込めません".to_string())?;
    let mut first = true;
    let fetched_items = collect_bounded(SAFETY_MAX_ITEMS as usize, || {
        let method = if first { "GetFirst" } else { "GetNext" };
        first = false;
        next_outlook_item(&filtered_items, method)
    })?;

    let mut events = Vec::new();
    for (index, item) in fetched_items.into_iter().enumerate() {
        let i = index + 1;

        let class_value = item
            .invoke_get("Class", &[])
            .map_err(|e| format!("Outlookの予定{i}の種類を取得できません: {e}"))?;
        let class = variant_to_i32(&class_value);
        let class = class.ok_or_else(|| format!("Outlookの予定{i}の種類が不正です"))?;
        if class != OL_APPOINTMENT_CLASS {
            continue;
        }

        let meeting_status_value = item
            .invoke_get("MeetingStatus", &[])
            .map_err(|e| format!("Outlookの予定{i}の会議状態を取得できません: {e}"))?;
        let meeting_status = variant_to_i32(&meeting_status_value)
            .ok_or_else(|| format!("Outlookの予定{i}の会議状態が不正です"))?;
        if !meeting_status_is_active(meeting_status)? {
            // 取得範囲内のキャンセル済み予定は有効な取得一覧から外す。
            // 全件取得が成功した後、削除済み予定と同じ照合処理でDBから削除される。
            continue;
        }

        let start_value = item
            .invoke_get("Start", &[])
            .map_err(|e| format!("Outlookの予定{i}の開始時刻を取得できません: {e}"))?;
        let start_dt = variant_to_naive_datetime(&start_value)
            .ok_or_else(|| format!("Outlookの予定{i}の開始時刻が不正です"))?;
        let end_value = item
            .invoke_get("End", &[])
            .map_err(|e| format!("Outlookの予定{i}の終了時刻を取得できません: {e}"))?;
        let end_dt = variant_to_naive_datetime(&end_value)
            .ok_or_else(|| format!("Outlookの予定{i}の終了時刻が不正です"))?;

        let all_day_value = item
            .invoke_get("AllDayEvent", &[])
            .map_err(|e| format!("Outlookの予定{i}の終日設定を取得できません: {e}"))?;
        let is_all_day = variant_to_required_bool(&all_day_value)
            .ok_or_else(|| format!("Outlookの予定{i}の終日設定が不正です"))?;
        // Use the same exact boundary for fetching and stale-row reconciliation.
        if !range.contains(start_dt) {
            continue;
        }

        let start_time = if is_all_day {
            None
        } else {
            Some(time_key(start_dt))
        };
        let end_time = if is_all_day {
            None
        } else {
            Some(time_key(end_dt))
        };
        let location_value = item
            .invoke_get("Location", &[])
            .map_err(|e| format!("Outlookの予定{i}の場所を取得できません: {e}"))?;
        let location = variant_to_opt_string(&location_value).unwrap_or_default();
        let entry_id = item
            .invoke_get("EntryID", &[])
            .ok()
            .and_then(|v| variant_to_opt_string(&v));
        let global_id = item
            .invoke_get("GlobalAppointmentID", &[])
            .ok()
            .and_then(|v| variant_to_opt_string(&v));
        let recurring_value = item
            .invoke_get("IsRecurring", &[])
            .map_err(|e| format!("Outlookの予定{i}の繰り返し設定を取得できません: {e}"))?;
        let is_recurring = variant_to_required_bool(&recurring_value)
            .ok_or_else(|| format!("Outlookの予定{i}の繰り返し設定が不正です"))?;
        let stable_series_id = global_id
            .clone()
            .or_else(|| entry_id.clone())
            .ok_or_else(|| format!("Outlookの予定{i}の識別子を取得できません"))?;
        let occurrence_stamp = if is_all_day {
            date_key(start_dt.date())
        } else {
            format!("{}T{}", date_key(start_dt.date()), time_key(start_dt))
        };
        let managed_key = task_property(&item)?;
        let occurrence_key = match &managed_key { Some(key) => format!("tcplus:{key}"), None => format!("{stable_series_id}|{occurrence_stamp}") };
        let body_value = item
            .invoke_get("Body", &[])
            .map_err(|e| format!("Outlookの予定{i}の本文を取得できません: {e}"))?;
        let body = variant_to_opt_string(&body_value).unwrap_or_default();
        let location = imported_memo(&body,&location,managed_key.is_some());
        let meeting_url = extract_teams_meeting_url(&body);
        let title_value = item
            .invoke_get("Subject", &[])
            .map_err(|e| format!("Outlookの予定{i}の件名を取得できません: {e}"))?;
        let title =
            variant_to_opt_string(&title_value).unwrap_or_else(|| "(タイトルなし)".to_string());

        events.push(OutlookEvent {
            title,
            date: date_key(start_dt.date()),
            start_time,
            end_time,
            location,
            is_all_day,
            outlook_series_id: stable_series_id,
            outlook_occurrence_key: occurrence_key,
            is_recurring,
            recurrence: extract_recurrence(&item, now, days_ahead, start_dt),
            meeting_url,
        });
    }
    Ok(OutlookSnapshot { events, range })
}

#[cfg(test)]
mod sync_range_tests {
    use super::*;

    #[test]
    fn cancelled_meeting_statuses_are_excluded_and_unknown_status_aborts() {
        for status in [0, 1, 3] {
            assert!(meeting_status_is_active(status).unwrap());
        }
        for status in [5, 7] {
            assert!(!meeting_status_is_active(status).unwrap());
        }
        for status in [-1, 2, 99] {
            assert!(meeting_status_is_active(status).is_err());
        }
    }

    #[test]
    fn cancelled_and_deleted_occurrences_are_removed_without_touching_other_tasks() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn, "2026-09").unwrap();
        let events: Vec<_> = [
            "active",
            "cancelled-organizer",
            "cancelled-attendee",
            "cancelled-all-day",
            "deleted",
            "outside",
        ]
        .into_iter()
        .map(|key| OutlookEvent {
            title: key.into(),
            date: if key == "outside" {
                "2026-09-01"
            } else {
                "2026-09-26"
            }
            .into(),
            start_time: Some("09:00".into()),
            end_time: Some("10:00".into()),
            location: String::new(),
            is_all_day: key == "cancelled-all-day",
            outlook_series_id: "shared-recurrence".into(),
            outlook_occurrence_key: key.into(),
            is_recurring: true,
            recurrence: json!({"type":"daily","until":"2026-10-01"}),
            meeting_url: None,
        })
        .collect();
        crate::repositories::outlook_auto_sync(&conn, &events, "", "2026-09-01", "2026-10-01")
            .unwrap();
        conn.execute("INSERT INTO tasks (id,title,date,created_at,updated_at) VALUES ('manual','manual','2026-09-26','a','a')", []).unwrap();
        let remaining: Vec<_> = events[..4]
            .iter()
            .zip([3, 5, 7, 5])
            .filter_map(|(event, status)| {
                meeting_status_is_active(status)
                    .unwrap()
                    .then_some(event.clone())
            })
            .collect();
        let result = crate::repositories::outlook_auto_sync(
            &conn,
            &remaining,
            "",
            "2026-09-26",
            "2026-10-01",
        )
        .unwrap();
        assert_eq!(result.deleted, 4);
        let mut titles: Vec<_> = crate::repositories::tasks_list(&conn)
            .unwrap()
            .into_iter()
            .map(|row| row.title)
            .collect();
        titles.sort();
        assert_eq!(titles, ["active", "manual", "outside"]);
        let repeated = crate::repositories::outlook_auto_sync(
            &conn,
            &remaining,
            "",
            "2026-09-26",
            "2026-10-01",
        )
        .unwrap();
        assert_eq!((repeated.added, repeated.deleted), (0, 0));
    }

    #[test]
    fn custom_calendar_lookup_never_falls_back_on_missing_or_error() {
        assert!(is_default_calendar_name("Calendar"));
        assert!(is_default_calendar_name("予定表"));
        assert!(!is_default_calendar_name("Team Calendar"));
        assert!(resolve_named_calendar::<()>("Team Calendar", Ok(None)).is_err());
        let failure =
            resolve_named_calendar::<()>("Team Calendar", Err("COM lookup failed".into()));
        assert_eq!(failure.unwrap_err(), "COM lookup failed");
        assert!(resolve_named_calendar("Team Calendar", Ok(Some(7))).is_ok());
    }

    #[test]
    fn bounded_collector_requires_normal_end_and_never_returns_partial_results() {
        assert!(collect_bounded::<i32>(2, || Ok(None)).unwrap().is_empty());
        let mut calls = 0;
        let failed = collect_bounded(2, || {
            calls += 1;
            if calls == 1 {
                Ok(Some(1))
            } else {
                Err("COM failure".into())
            }
        });
        assert!(failed.is_err());
        let mut calls = 0;
        let exceeded = collect_bounded(2, || {
            calls += 1;
            Ok(Some(calls))
        });
        assert!(exceeded.is_err());
        let mut calls = 0;
        let complete = collect_bounded(2, || {
            calls += 1;
            Ok((calls <= 2).then_some(calls))
        })
        .unwrap();
        assert_eq!(complete, vec![1, 2]);
    }

    fn at(value: &str) -> chrono::NaiveDateTime {
        chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S").unwrap()
    }

    #[test]
    fn fetching_again_in_the_afternoon_preserves_morning_and_ongoing_events() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn, "2026-09").unwrap();
        let events: Vec<_> = [
            ("morning", "09:00", "10:00"),
            ("ongoing", "12:00", "14:00"),
            ("future", "15:00", "16:00"),
        ]
        .into_iter()
        .map(|(key, start, end)| OutlookEvent {
            title: key.into(),
            date: "2026-09-25".into(),
            start_time: Some(start.into()),
            end_time: Some(end.into()),
            location: String::new(),
            is_all_day: false,
            outlook_series_id: key.into(),
            outlook_occurrence_key: key.into(),
            is_recurring: false,
            recurrence: json!({"type":"none"}),
            meeting_url: None,
        })
        .collect();
        crate::repositories::outlook_auto_sync(&conn, &events, "", "2026-09-25", "2026-10-25")
            .unwrap();
        let now = at("2026-09-25 13:00:00");
        let range = OutlookSyncRange::new(now, 30);
        let fetched: Vec<_> = events
            .into_iter()
            .filter(|event| {
                let start = at(&format!(
                    "{} {}:00",
                    event.date,
                    event.start_time.as_deref().unwrap()
                ));
                range.contains(start)
            })
            .collect();
        let result = crate::repositories::outlook_sync_in_range(
            &conn,
            &fetched,
            "",
            range,
        )
        .unwrap();
        assert_eq!(
            result.deleted, 0,
            "時間が進んでも、Outlookに残る予定を削除しない"
        );
        assert_eq!(crate::repositories::tasks_list(&conn).unwrap().len(), 3);
    }

    #[test]
    fn range_includes_current_time_and_the_last_day() {
        let range = OutlookSyncRange::new(at("2026-09-25 13:00:00"), 1);
        assert!(!range.contains(at("2026-09-24 23:59:59")));
        assert!(!range.contains(at("2026-09-25 00:00:00")), "今日の終日予定は過去に開始");
        assert!(!range.contains(at("2026-09-25 09:00:00")), "過去に開始した予定");
        assert!(range.contains(at("2026-09-25 13:00:00")));
        assert!(
            range.contains(at("2026-09-26 23:59:59")),
            "終了日の最後まで"
        );
        assert!(!range.contains(at("2026-09-27 00:00:00")));
        assert_eq!(
            range.restrict_filter(),
            "[Start] >= '09/25/2026 01:00 PM' AND [Start] < '09/27/2026 12:00 AM'"
        );
        assert_eq!(
            (range.start_key(), range.end_key()),
            ("2026-09-25".into(), "2026-09-26".into())
        );
    }

    #[test]
    fn snapshot_keeps_its_fetch_dates_across_midnight_and_year_end() {
        let snapshot = OutlookSnapshot {
            events: vec![],
            range: OutlookSyncRange::new(at("2026-12-31 23:59:59"), 1),
        };
        // 取得完了が翌日でも、呼び出し側はsnapshotの範囲を使う。
        assert_eq!(snapshot.range.start_key(), "2026-12-31");
        assert_eq!(snapshot.range.end_key(), "2027-01-01");
        assert_eq!(
            snapshot.range.restrict_filter(),
            "[Start] >= '12/31/2026 11:59 PM' AND [Start] < '01/02/2027 12:00 AM'"
        );
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    // 実際に起動中のOutlookが必要な検証用テスト。通常のcargo testでは実行されず
    // (`cargo test -- --ignored`で明示実行)、CI/自動テストの対象外とする。
    // 読み取りのみで、Outlook側の予定表を作成・変更・削除することは一切ない。
    #[tokio::test]
    #[ignore]
    async fn live_connect_and_fetch_events_from_real_outlook() {
        // fetch_events経由(実運用と同じCoInitializeEx済みの専用ワーカースレッド)で呼ぶ。
        let snapshot = fetch_events("Calendar".to_string(), 30)
            .await
            .expect("Outlookからの取得に失敗しました");
        eprintln!("fetched {} events", snapshot.events.len());
        for e in snapshot.events.iter().take(10) {
            eprintln!(
                "title={:?} date={} start={:?} end={:?} all_day={} recurring={} key={:?} recurrence={} meeting_url={:?}",
                e.title,
                e.date,
                e.start_time,
                e.end_time,
                e.is_all_day,
                e.is_recurring,
                e.outlook_occurrence_key,
                e.recurrence,
                e.meeting_url
            );
        }
    }
}
