//! Outlook COM連携。
//!
//! windows-rs + winsafe(late-bound IDispatch自動化)でOutlookの予定を取得する。
//! COMはCOMアパートメント(STA)に紐づくため、専用スレッドを1本立てて
//! そこでCoInitializeEx済みの状態を保ち、以降のOutlook操作はすべて
//! そのスレッド上で処理する(呼び出し側のスレッドをブロックしないため)。

use serde_json::{Value, json};
use std::sync::mpsc as std_mpsc;
use std::sync::OnceLock;
use std::thread;
use tokio::sync::oneshot;
use winsafe::prelude::*;
use winsafe::{self as w, co};

const OL_FOLDER_CALENDAR: i32 = 9;
const OL_APPOINTMENT_CLASS: i32 = 26;
const SAFETY_MAX_ITEMS: i32 = 5000;

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
    #[allow(dead_code)]
    pub is_recurring: bool,
    pub recurrence: Value,
    pub meeting_url: Option<String>,
}

struct OutlookRequest {
    calendar_name: String,
    days_ahead: i64,
    reply: oneshot::Sender<Result<Vec<OutlookEvent>, String>>,
}

static WORKER: OnceLock<std_mpsc::Sender<OutlookRequest>> = OnceLock::new();

fn worker_sender() -> std_mpsc::Sender<OutlookRequest> {
    WORKER
        .get_or_init(|| {
            let (tx, rx) = std_mpsc::channel::<OutlookRequest>();
            thread::Builder::new()
                .name("outlook-com-worker".into())
                .spawn(move || outlook_worker_loop(rx))
                .expect("spawn outlook COM worker thread");
            tx
        })
        .clone()
}

fn outlook_worker_loop(rx: std_mpsc::Receiver<OutlookRequest>) {
    let com_guard = w::CoInitializeEx(co::COINIT::APARTMENTTHREADED | co::COINIT::DISABLE_OLE1DDE);
    let _com_guard = match com_guard {
        Ok(g) => g,
        Err(e) => {
            let msg = format!("CoInitializeEx に失敗しました: {e}");
            for req in rx {
                let _ = req.reply.send(Err(msg.clone()));
            }
            return;
        }
    };
    for req in rx {
        let result = get_outlook_events(&req.calendar_name, req.days_ahead);
        let _ = req.reply.send(result);
    }
    // _com_guardのDropでCoUninitializeが呼ばれる(ここまでスレッド生存)。
}

/// Outlookカレンダーから予定一覧を取得する(F-OUTLOOK-001, 002, 005)。
/// ブロッキングCOM呼び出しは専用ワーカースレッドへ委譲し、HTTPサーバー
/// 側のtokioランタイムをブロックしない。
pub async fn fetch_events(calendar_name: String, days_ahead: i64) -> Result<Vec<OutlookEvent>, String> {
    let tx = worker_sender();
    let (reply_tx, reply_rx) = oneshot::channel();
    tx.send(OutlookRequest { calendar_name, days_ahead, reply: reply_tx })
        .map_err(|_| "Outlookワーカースレッドが終了しています".to_string())?;
    reply_rx
        .await
        .map_err(|_| "Outlookワーカーからの応答がありませんでした".to_string())?
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
    w::CoCreateInstance::<w::IDispatch>(&clsid, None::<&w::IUnknown>, co::CLSCTX::LOCAL_SERVER).map_err(|e| {
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
        let clsid = windows::Win32::System::Com::CLSIDFromProgID(windows::core::w!("Outlook.Application"))
            .map_err(|e| format!("CLSIDFromProgID(windows crate)に失敗しました: {e}"))?;
        let mut punk: Option<windows::core::IUnknown> = None;
        GetActiveObject(&clsid, None, &mut punk).map_err(|e| format!("GetActiveObjectに失敗しました: {e}"))?;
        let unknown = punk.ok_or_else(|| "GetActiveObjectがオブジェクトを返しませんでした".to_string())?;
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

fn variant_to_opt_string(v: &w::Variant) -> Option<String> {
    match v {
        w::Variant::Bstr(s) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

fn variant_to_naive_datetime(v: &w::Variant) -> Option<chrono::NaiveDateTime> {
    match v {
        w::Variant::Date(st) => chrono::NaiveDate::from_ymd_opt(st.wYear as i32, st.wMonth as u32, st.wDay as u32)?
            .and_hms_opt(st.wHour as u32, st.wMinute as u32, st.wSecond as u32),
        _ => None,
    }
}

fn date_key(d: chrono::NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}
fn time_key(t: chrono::NaiveDateTime) -> String {
    t.format("%H:%M").to_string()
}

fn find_calendar_folder(namespace: &w::IDispatch, calendar_name: &str) -> Result<w::IDispatch, String> {
    let try_named = || -> AnyResultOpt {
        let folders = namespace.invoke_get("Folders", &[]).ok()?.unwrap_dispatch_opt()?;
        let folder_count = variant_to_i32(&folders.invoke_get("Count", &[]).ok()?)?;
        for i in 1..=folder_count {
            let folder = folders
                .invoke_method("Item", &[&w::Variant::I4(i)])
                .ok()?
                .unwrap_dispatch_opt()?;
            let subfolders = folder.invoke_get("Folders", &[]).ok()?.unwrap_dispatch_opt()?;
            let sub_count = variant_to_i32(&subfolders.invoke_get("Count", &[]).ok()?)?;
            for j in 1..=sub_count {
                let subfolder = subfolders
                    .invoke_method("Item", &[&w::Variant::I4(j)])
                    .ok()?
                    .unwrap_dispatch_opt()?;
                let name = subfolder
                    .invoke_get("Name", &[])
                    .ok()
                    .and_then(|v| variant_to_opt_string(&v))
                    .unwrap_or_default();
                if name.contains(calendar_name) {
                    return Some(subfolder);
                }
            }
        }
        None
    };
    if let Some(found) = try_named() {
        return Ok(found);
    }
    namespace
        .invoke_method("GetDefaultFolder", &[&w::Variant::I4(OL_FOLDER_CALENDAR)])
        .map_err(|e| format!("既定の予定表フォルダの取得に失敗しました: {e}"))?
        .unwrap_dispatch_opt()
        .ok_or_else(|| "既定の予定表フォルダの取得に失敗しました".to_string())
}

// unwrap_dispatchはDispatch以外だとpanicするため、探索コードでは
// panicしないOption版を使う(存在しないFolders等をエラーとして即打ち切らず、
// 既定フォルダへのフォールバックへ進めるため)。
type AnyResultOpt = Option<w::IDispatch>;
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
    let pattern = match item.invoke_method("GetRecurrencePattern", &[]).ok().and_then(|v| v.unwrap_dispatch_opt()) {
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

fn get_outlook_events(calendar_name: &str, days_ahead: i64) -> Result<Vec<OutlookEvent>, String> {
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
    let _ = items.invoke_method("Sort", &[&w::Variant::from_str("[Start]")]);
    let _ = items.invoke_put("IncludeRecurrences", &w::Variant::Bool(true));

    let now = chrono::Local::now().naive_local();
    let end_cutoff = (now + chrono::Duration::days(days_ahead)).date();

    // Restrict()でCOM側にて事前絞り込みする(全件イテレートは著しく遅いため)。
    // 失敗/0件時は全件イテレート+Rust側フィルタへフォールバックする。
    let end_exclusive = now + chrono::Duration::days(days_ahead);
    let us_date = |d: chrono::NaiveDateTime| d.format("%m/%d/%Y").to_string();
    let filter = format!("[Start] >= '{}' AND [Start] < '{}'", us_date(now), us_date(end_exclusive));

    let filtered_items = items
        .invoke_method("Restrict", &[&w::Variant::from_str(&filter)])
        .ok()
        .and_then(|v| v.unwrap_dispatch_opt())
        .filter(|restricted| restricted.invoke_method("Item", &[&w::Variant::I4(1)]).is_ok())
        .unwrap_or_else(|| items.clone());

    let mut events = Vec::new();
    for i in 1..=SAFETY_MAX_ITEMS {
        let item = match filtered_items.invoke_method("Item", &[&w::Variant::I4(i)]) {
            Ok(v) => match v.unwrap_dispatch_opt() {
                Some(d) => d,
                None => break,
            },
            Err(_) => break, // 範囲外(全件走査完了)
        };

        let class = item.invoke_get("Class", &[]).ok().and_then(|v| variant_to_i32(&v));
        if class != Some(OL_APPOINTMENT_CLASS) {
            continue;
        }

        let start_dt = match item.invoke_get("Start", &[]).ok().and_then(|v| variant_to_naive_datetime(&v)) {
            Some(d) => d,
            None => continue,
        };
        let end_dt = item
            .invoke_get("End", &[])
            .ok()
            .and_then(|v| variant_to_naive_datetime(&v))
            .unwrap_or(start_dt);

        let start_date = start_dt.date();
        if start_date > end_cutoff {
            break; // [Start]昇順ソート済みのため、これ以降も全て範囲外
        }
        let is_all_day = item.invoke_get("AllDayEvent", &[]).map(|v| variant_to_bool(&v)).unwrap_or(false);
        // 「今日以降」ではなく「今の時間以降」を同期対象にする
        // (進行中の会議を工数集計から除外するため)。終日予定はStartが
        // 00:00固定のため、この時刻比較だと今日の終日予定が丸ごと漏れて
        // しまう。終日予定だけは日付単位で判定する。
        let is_before_cutoff = if is_all_day {
            start_date < now.date()
        } else {
            start_dt < now
        };
        if is_before_cutoff {
            continue;
        }

        let start_time = if is_all_day { None } else { Some(time_key(start_dt)) };
        let end_time = if is_all_day { None } else { Some(time_key(end_dt)) };
        let location = item
            .invoke_get("Location", &[])
            .ok()
            .and_then(|v| variant_to_opt_string(&v))
            .unwrap_or_default();
        let entry_id = item.invoke_get("EntryID", &[]).ok().and_then(|v| variant_to_opt_string(&v));
        let global_id = item
            .invoke_get("GlobalAppointmentID", &[])
            .ok()
            .and_then(|v| variant_to_opt_string(&v));
        let is_recurring = item.invoke_get("IsRecurring", &[]).map(|v| variant_to_bool(&v)).unwrap_or(false);
        let stable_series_id = global_id.clone().or_else(|| entry_id.clone()).unwrap_or_default();
        let occurrence_stamp = if is_all_day {
            date_key(start_dt.date())
        } else {
            format!("{}T{}", date_key(start_dt.date()), time_key(start_dt))
        };
        let occurrence_key = if stable_series_id.is_empty() {
            String::new()
        } else {
            format!("{stable_series_id}|{occurrence_stamp}")
        };
        let body = item.invoke_get("Body", &[]).ok().and_then(|v| variant_to_opt_string(&v)).unwrap_or_default();
        let meeting_url = extract_teams_meeting_url(&body);
        let title = item
            .invoke_get("Subject", &[])
            .ok()
            .and_then(|v| variant_to_opt_string(&v))
            .unwrap_or_else(|| "(タイトルなし)".to_string());

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
    Ok(events)
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
        let events = fetch_events("Calendar".to_string(), 30)
            .await
            .expect("Outlookからの取得に失敗しました");
        eprintln!("fetched {} events", events.len());
        for e in events.iter().take(10) {
            eprintln!(
                "title={:?} date={} start={:?} end={:?} all_day={} recurring={} key={:?} recurrence={} meeting_url={:?}",
                e.title, e.date, e.start_time, e.end_time, e.is_all_day, e.is_recurring,
                e.outlook_occurrence_key, e.recurrence, e.meeting_url
            );
        }
    }
}
