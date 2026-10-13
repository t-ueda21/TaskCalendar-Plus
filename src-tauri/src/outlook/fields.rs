use super::*;
use windows::core::Interface;

fn text(item:&w::IDispatch,name:&str)->Result<String,String>{
    windows::core::BSTR::try_from(&automation::get(item,name)?).map(|s|s.to_string()).map_err(|e|format!("Outlook {name}: {e}"))
}
fn boolean(item:&w::IDispatch,name:&str)->Result<bool,String>{bool::try_from(&automation::get(item,name)?).map_err(|e|format!("Outlook {name}: {e}"))}

pub(super) fn read(item:&w::IDispatch)->Result<Value,String>{
    let mut data=json!({});
    for (key,property) in [("location","Location"),("categories","Categories"),("organizer","Organizer")]{data[key]=json!(text(item,property)?);}
    for (key,property) in [("busyStatus","BusyStatus"),("sensitivity","Sensitivity"),("importance","Importance"),("reminderMinutesBeforeStart","ReminderMinutesBeforeStart"),("responseStatus","ResponseStatus"),("meetingStatus","MeetingStatus")]{data[key]=json!(automation::integer(item,property)?);}
    data["reminderSet"]=json!(boolean(item,"ReminderSet")?);
    for (key,property) in [("startTimeZone","StartTimeZone"),("endTimeZone","EndTimeZone")]{data[key]=json!(automation::text(&automation::object_get(item,property)?,"ID")?);}
    let recipients=automation::object_get(item,"Recipients")?;
    let count=automation::integer(&recipients,"Count")?;
    if !(0..=5000).contains(&count){return Err("出席者の取得上限を超えています".into());}
    let mut attendees=Vec::new();
    for index in 1..=count{
        let recipient=automation::object_method(&recipients,"Item",&[AutomationValue::from(index)])?;
        attendees.push(json!({"name":text(&recipient,"Name")?,"address":text(&recipient,"Address")?,"type":automation::integer(&recipient,"Type")?,"responseStatus":automation::integer(&recipient,"MeetingResponseStatus")?}));
    }
    data["attendees"]=json!(attendees);
    let attachments=automation::object_get(item,"Attachments")?;
    let count=automation::integer(&attachments,"Count")?;
    if !(0..=5000).contains(&count){return Err("添付ファイルの取得上限を超えています".into());}
    let mut rows=Vec::new();
    for index in 1..=count{
        let attachment=automation::object_method(&attachments,"Item",&[AutomationValue::from(index)])?;
        rows.push(json!({"index":index,"name":text(&attachment,"FileName")?,"size":automation::integer(&attachment,"Size")?,"type":automation::integer(&attachment,"Type")?}));
    }
    data["attachments"]=json!(rows);
    Ok(data)
}

pub(super) fn matches(requested:&Value,current:&Value)->bool{
    crate::event_data::EDITABLE_DETAILS.iter().all(|key|requested.get(*key).is_none_or(|value|current.get(*key)==Some(value)))
}

/// Preserve attendees, attachments and body formatting unless that specific field changes.
pub(super) fn apply(item:&w::IDispatch,details:&Value)->Result<(),String>{
    crate::event_data::validate_details(details)?;
    for (key,property) in [("location","Location"),("categories","Categories")]{
        if let Some(value)=details.get(key).and_then(Value::as_str)&&text(item,property)?!=value{put_outlook_text(item,property,value)?;}
    }
    for (key,property) in [("busyStatus","BusyStatus"),("sensitivity","Sensitivity"),("importance","Importance"),("reminderMinutesBeforeStart","ReminderMinutesBeforeStart")]{
        if let Some(value)=details.get(key).and_then(Value::as_i64)&&automation::integer(item,property)?!=value as i32{automation::put(item,property,AutomationValue::from(value as i32))?;}
    }
    if let Some(value)=details.get("reminderSet").and_then(Value::as_bool)&&boolean(item,"ReminderSet")?!=value{automation::put(item,"ReminderSet",AutomationValue::from(value))?;}
    for (key,property) in [("startTimeZone","StartTimeZone"),("endTimeZone","EndTimeZone")]{
        if let Some(value)=details.get(key).and_then(Value::as_str).filter(|s|!s.is_empty()){
            let current=automation::object_get(item,property)?;
            if automation::text(&current,"ID")?!=value{
                let app=automation::object_get(item,"Application")?;
                let zones=automation::object_get(&app,"TimeZones")?;
                let zone=automation::object_method(&zones,"Item",&[AutomationValue::from(value)])?;
                let ptr=zone.ptr();let dispatch=unsafe{windows::Win32::System::Com::IDispatch::from_raw_borrowed(&ptr)}.expect("zone");
                automation::put_ref(item,property,AutomationValue::from(dispatch.clone()))?;
            }
        }
    }
    Ok(())
}

pub(super) fn validate_time_zones(item:&w::IDispatch,details:&Value)->Result<(),String>{
    for key in ["startTimeZone","endTimeZone"]{
        if let Some(value)=details.get(key).and_then(Value::as_str).filter(|s|!s.is_empty()){
            let app=automation::object_get(item,"Application")?;
            let zones=automation::object_get(&app,"TimeZones")?;
            automation::object_method(&zones,"Item",&[AutomationValue::from(value)])?;
        }
    }
    Ok(())
}
