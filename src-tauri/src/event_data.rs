//! Calendar event range and editable metadata validation, shared by storage and COM.
use chrono::{NaiveDate,NaiveDateTime,NaiveTime,Duration};
use serde_json::{Value,json};

pub fn clock(value:&str)->Result<NaiveTime,String>{
    NaiveTime::parse_from_str(value,"%H:%M:%S").or_else(|_|NaiveTime::parse_from_str(value,"%H:%M")).map_err(|_|"時刻はHH:MMまたはHH:MM:SSで入力してください".into())
}
pub fn date_time(day:&str,time:&str)->Result<NaiveDateTime,String>{
    let day=NaiveDate::parse_from_str(day,"%Y-%m-%d").map_err(|_|"日付が不正です")?;
    if time=="24:00"||time=="24:00:00"{Ok(day.succ_opt().ok_or("日付が範囲外です")?.and_time(NaiveTime::MIN))}else{Ok(day.and_time(clock(time)?))}
}
pub fn range(date:&str,end_date:Option<&str>,all_day:bool,start:Option<&str>,end:Option<&str>)->Result<(NaiveDateTime,NaiveDateTime),String>{
    let last=end_date.filter(|s|!s.is_empty()).unwrap_or(date);
    let first=date_time(date,if all_day{"00:00"}else{start.ok_or("開始時刻が必要です")?})?;
    let last=date_time(last,if all_day{"24:00"}else{end.ok_or("終了時刻が必要です")?})?;
    if last<=first{return Err("終了日時は開始日時より後にしてください".into());}
    if last-first>Duration::days(3660){return Err("予定の期間は10年以内にしてください".into());}
    Ok((first,last))
}
pub const EDITABLE_DETAILS:&[&str]=&["location","busyStatus","sensitivity","importance","categories","reminderSet","reminderMinutesBeforeStart","startTimeZone","endTimeZone"];
pub fn validate_details(value:&Value)->Result<(),String>{
    if value.is_null(){return Ok(());}
    let object=value.as_object().ok_or("予定の詳細はオブジェクトで指定してください")?;
    for key in ["location","categories","startTimeZone","endTimeZone"]{
        if let Some(value)=object.get(key)&&!value.is_string(){return Err(format!("{key}は文字列で指定してください"));}
    }
    for (key,max) in [("busyStatus",4),("sensitivity",3),("importance",2),("reminderMinutesBeforeStart",525600)]{
        if let Some(value)=object.get(key)&&!value.as_i64().is_some_and(|n|(0..=max).contains(&n)){return Err(format!("{key}の値が範囲外です"));}
    }
    if let Some(value)=object.get("reminderSet")&&!value.is_boolean(){return Err("通知の設定が不正です".into());}
    Ok(())
}
pub fn merge_details(old:&Value,patch:Option<&Value>)->Value{
    let mut result=if old.is_object(){old.clone()}else{json!({})};
    if let Some(patch)=patch.and_then(Value::as_object){for (key,value) in patch{result[key]=value.clone();}}
    result
}
