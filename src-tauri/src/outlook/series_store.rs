//! Atomically prepare a local series change and its single durable remote operation.
use super::*;
use crate::repositories as repo;
use rusqlite::{Connection,OptionalExtension,params};
use std::collections::HashSet;

fn original_date(task:&repo::TaskRow)->&str {task.recurrence.get("occurrenceDate").and_then(Value::as_str).unwrap_or(&task.date)}
fn day(value:&str)->Result<chrono::NaiveDate,String>{chrono::NaiveDate::parse_from_str(value,"%Y-%m-%d").map_err(|e|e.to_string())}
fn details_for_comparison(value:&Value)->Value {
    let mut result=json!({"location":"","busyStatus":2,"sensitivity":0,"importance":1,"categories":"","reminderSet":false,"reminderMinutesBeforeStart":15,"organizer":"","attendees":[],"attachments":[]});
    if let Some(object)=value.as_object(){for (key,value) in object{result[key]=value.clone();}}
    if result["reminderSet"]==false {result["reminderMinutesBeforeStart"]=json!(15);}
    result
}
fn normalized_fields(value:&Value)->Value {
    let mut result=value.clone();
    result["isAllDay"]=json!(value.get("isAllDay").and_then(Value::as_bool).unwrap_or(false));
    result["title"]=json!(value.get("title").and_then(Value::as_str).unwrap_or(""));
    result["endDate"]=value.get("endDate").filter(|v|v.is_string()).cloned().unwrap_or_else(||value["date"].clone());
    for key in ["startTime","endTime"] {
        result[key]=if value["isAllDay"]==true{Value::Null}else{value.get(key).and_then(Value::as_str).and_then(|s|crate::event_data::clock(s).ok()).map(|time|json!(time.format("%H:%M:%S").to_string())).unwrap_or_else(||value[key].clone())};
    }
    result["memo"]=json!(value.get("memo").and_then(Value::as_str).unwrap_or("").replace("\r\n","\n").trim_end());
    result["outlookDetails"]=details_for_comparison(&value["outlookDetails"]);
    result
}
fn template_at(template:&Value,date:&str)->Result<Value,String> {
    let mut value=template.clone();
    let base=template.get("date").and_then(Value::as_str).unwrap_or(date);
    let end=template.get("endDate").and_then(Value::as_str).unwrap_or(base);
    value["date"]=json!(date);value["endDate"]=json!(date_key(day(date)?+(day(end)?-day(base)?)));
    if value["isAllDay"]==true {value["startTime"]=Value::Null;value["endTime"]=Value::Null;}
    Ok(value)
}
fn is_exception(task:&repo::TaskRow,template:&Value)->Result<bool,String> {
    if task.recurrence.get("exception").and_then(Value::as_bool)==Some(true){return Ok(true)}
    let actual=normalized_fields(&serde_json::to_value(task).map_err(|e|e.to_string())?);
    let base=normalized_fields(&template_at(template,original_date(task))?);
    Ok(["title","date","endDate","isAllDay","startTime","endTime","memo","outlookDetails"].iter().any(|key|actual[*key]!=base[*key]))
}
fn make_template(task:&repo::TaskRow,old:&Value,edit:&Value,date:&str)->Result<Value,String>{
    let before=normalized_fields(&serde_json::to_value(task).map_err(|e|e.to_string())?);
    let after=normalized_fields(edit);
    let mut template=old.clone();
    for key in ["title","memo","isAllDay","startTime","endTime"] {
        if before[key]!=after[key]{template[key]=edit[key].clone();}
    }
    let mut details=old.get("outlookDetails").filter(|v|v.is_object()).cloned().unwrap_or(json!({}));
    for key in crate::event_data::EDITABLE_DETAILS {if before["outlookDetails"][*key]!=after["outlookDetails"][*key]{details[*key]=after["outlookDetails"][*key].clone();}}
    template["outlookDetails"]=details;
    let span=|value:&Value|->Result<i64,String>{let start=value.get("date").and_then(Value::as_str).ok_or("Date missing")?;let end=value.get("endDate").and_then(Value::as_str).unwrap_or(start);Ok((day(end)?-day(start)?).num_days())};
    let days=if span(&before)?!=span(&after)?{span(&after)?}else{span(old)?};
    template["date"]=json!(date);template["endDate"]=json!(date_key(day(date)?+chrono::Duration::days(days)));
    if template["isAllDay"]==true{template["startTime"]=Value::Null;template["endTime"]=Value::Null;}
    Ok(template)
}
fn remote_for(conn:&Connection,id:&str)->Result<Option<reconcile::RemoteIdentity>,String>{
    let raw:Option<String>=conn.query_row("SELECT remote_meta FROM outlook_links WHERE task_id=?1",[id],|r|r.get(0)).optional().map_err(|e|e.to_string())?.flatten();
    raw.map(|s|serde_json::from_str(&s).map_err(|e|e.to_string())).transpose()
}

pub(crate) fn apply_series_result(conn:&Connection,request:&recurrence::SeriesEditRequest,result:&recurrence::SeriesEditResult)->Result<(),String>{
    let payload=request.payload.as_ref().ok_or("Series payload missing")?;
    let group=payload.recurrence.get("groupId").and_then(Value::as_str).ok_or("Series group missing")?;
    let tasks=repo::tasks_list(conn).map_err(|e|e.to_string())?;
    for task in tasks.into_iter().filter(|t|t.recurrence.get("groupId").and_then(Value::as_str)==Some(group)&&result.affected_from.as_deref().is_none_or(|date|original_date(t)>=date)){
        let calendar:String=conn.query_row("SELECT calendar_name FROM outlook_links WHERE task_id=?1",[&task.id],|r|r.get(0)).map_err(|e|e.to_string())?;
        let recurring=result.rule.get("native").is_some_and(|v|!v.is_null());
        let all_day=task.recurrence.pointer("/template/isAllDay").and_then(Value::as_bool).unwrap_or(task.is_all_day);
        let clock=task.recurrence.pointer("/template/startTime").and_then(Value::as_str).or(task.start_time.as_deref()).unwrap_or("00:00");
        let original=if recurring{Some(crate::event_data::date_time(original_date(&task),if all_day{"00:00"}else{clock})?.format("%Y-%m-%dT%H:%M:%S").to_string())}else{None};
        let old=remote_for(conn,&task.id)?;
        let meta=reconcile::RemoteIdentity{imported:true,calendar,entry_id:result.new_entry_id.clone(),store_id:result.new_store_id.clone(),series_id:result.new_series_id.clone(),occurrence_start:original,recurring,read_only:old.and_then(|m|m.read_only),version:String::new()};
        conn.execute("UPDATE outlook_links SET entry_id=?2,store_id=?3,remote_meta=?4,deleted_by_app=0,original_occurrence_start=?5 WHERE task_id=?1",params![task.id,meta.entry_id,meta.store_id,serde_json::to_string(&meta).unwrap(),meta.occurrence_start]).map_err(|e|e.to_string())?;
        let mut actual=task.recurrence.clone();
        if let Some(native)=result.rule.get("native") {actual["native"]=native.clone();actual["type"]=json!("native");}
        else {actual.as_object_mut().map(|value|value.remove("native"));actual["type"]=json!("none");}
        if actual!=task.recurrence {
            conn.execute("UPDATE tasks SET outlook_enabled=0 WHERE id=?1",[&task.id]).map_err(|e|e.to_string())?;
            conn.execute("UPDATE tasks SET recurrence=?2,outlook_enabled=?3,updated_at=?4 WHERE id=?1",params![task.id,actual.to_string(),task.outlook_enabled as i64,chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos,true)]).map_err(|e|e.to_string())?;
            conn.execute("UPDATE outlook_jobs SET payload=json_set(payload,'$.recurrence',json(?2)) WHERE task_id=?1 AND operation IN('upsert','delete')",params![task.id,actual.to_string()]).map_err(|e|e.to_string())?;
        }
    }
    Ok(())
}

pub(crate) fn enqueue(conn:&Connection,id:&str,body:Value)->Result<Vec<repo::TaskRow>,String>{
    let tx=conn.unchecked_transaction().map_err(|e|e.to_string())?;
    let task=repo::tasks_get(&tx,id).map_err(|e|e.to_string())?.ok_or("Task not found")?;
    if body.get("expectedUpdatedAt").and_then(Value::as_str)!=Some(&task.updated_at){return Err("Task revision conflict".into());}
    let scope=body.get("scope").and_then(Value::as_str).ok_or("Scope missing")?;
    if !matches!(scope,"all"|"future"){return Err("Choose all or future occurrences".into());}
    let raw_rule=body.get("rule").ok_or("Rule missing")?;
    let mut rule=if raw_rule.is_null(){Value::Null}else{recurrence::validate(raw_rule)?};
    let patch=body.get("payload").and_then(Value::as_object).ok_or("Series payload missing")?;
    let changed_local_memo=patch.get("localMemo").filter(|value|value.as_str().is_some_and(|memo|memo!=task.personal_memo())).cloned();
    let mut edit=serde_json::to_value(&task).map_err(|e|e.to_string())?;
    for (key,value) in patch {edit[key]=value.clone();}
    crate::event_data::range(edit["date"].as_str().ok_or("Date missing")?,edit["endDate"].as_str(),edit["isAllDay"].as_bool().unwrap_or(false),edit["startTime"].as_str(),edit["endTime"].as_str())?;
    crate::event_data::validate_details(&edit["outlookDetails"])?;
    let original=original_date(&task).to_string();
    if scope=="future"&&!rule.is_null()&&task.recurrence.get("native").is_some_and(|r|!r.is_null()){rule=recurrence::normalize_future_rule(&task.recurrence,&rule,&original)?;}
    else if scope=="future"&&!rule.is_null()&&rule["patternStartDate"].as_str().is_some_and(|s|s<original.as_str()){rule["patternStartDate"]=json!(original);}
    let mut remote=remote_for(&tx,id)?;
    let has_group=task.recurrence.get("groupId").and_then(Value::as_str).filter(|s|!s.is_empty());
    let old_group=has_group.map(str::to_string).unwrap_or_else(||remote.as_ref().map(|m|format!("native:{}:{}:{}",m.calendar,m.store_id,m.series_id)).unwrap_or_else(||format!("local:{}",task.id)));
    let rows=repo::tasks_list(&tx).map_err(|e|e.to_string())?;
    let mut same_group=Vec::new();
    for row in rows {
        let belongs=if let Some(group)=has_group {row.recurrence.get("groupId").and_then(Value::as_str)==Some(group)}else if row.id==id{true}else if let (Some(source),Some(other))=(&remote,remote_for(&tx,&row.id)?){source.store_id==other.store_id&&source.calendar==other.calendar&&source.series_id==other.series_id}else{false};
        if belongs{same_group.push(row);}
    }
    let affected:Vec<_>=same_group.iter().filter(|t|scope=="all"||original_date(t)>=original.as_str()).cloned().collect();
    if affected.is_empty(){return Err("Series has no occurrences".into());}
    let before=normalized_fields(&serde_json::to_value(&task).map_err(|e|e.to_string())?);
    let after=normalized_fields(&edit);
    let note_only=changed_local_memo.is_some() && raw_rule==task.recurrence.get("native").unwrap_or(&Value::Null)
        && ["title","date","endDate","isAllDay","startTime","endTime","memo","outlookDetails","recurrence","tagId","outlookEnabled"].iter().all(|key|before[*key]==after[*key]);
    if note_only {
        for row in &affected {
            let mut value=serde_json::to_value(row).map_err(|e|e.to_string())?;
            value["localMemo"]=changed_local_memo.clone().unwrap();
            repo::tasks_update(&tx,&row.id,serde_json::from_value(value).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        }
        let saved=repo::tasks_list(&tx).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e|e.to_string())?;
        return Ok(saved);
    }

    // Never replace a possibly started COM operation, even if global OFF returned it to pending.
    let pending_rows:Vec<(String,String,String,i64)>=tx.prepare("SELECT task_id,payload,status,attempts FROM outlook_jobs WHERE operation='series' AND status<>'done'").map_err(|e|e.to_string())?.query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|e|e.to_string())?.collect::<rusqlite::Result<_>>().map_err(|e|e.to_string())?;
    let mut pending:Option<(String,recurrence::SeriesEditRequest)>=None;
    for (key,raw,status,attempts) in pending_rows {
        let value:Value=serde_json::from_str(&raw).map_err(|e|e.to_string())?;
        let previous:recurrence::SeriesEditRequest=serde_json::from_value(value["request"].clone()).map_err(|e|e.to_string())?;
        let same=previous.payload.as_ref().and_then(|p|p.recurrence.get("groupId")).and_then(Value::as_str)==Some(old_group.as_str());
        let same_remote=remote.as_ref().is_some_and(|m|m.entry_id==previous.entry_id&&m.store_id==previous.store_id);
        if !same&&!same_remote{continue;}
        if !same||attempts>0||!matches!(status.as_str(),"pending"|"paused")||pending.is_some(){return Err("この系列の反映処理が開始済みです。完了または再同期してから変更してください".into());}
        if scope=="future"&&previous.split_date.as_deref()!=Some(original.as_str()){return Err("保留中の系列変更を反映してから、この日以降を分割してください".into());}
        remote=remote_for(&tx,&key)?.or(remote);pending=Some((key,previous));
    }
    let old_template=task.recurrence.get("template").filter(|v|v.is_object()).cloned().or_else(||(!remote.as_ref().is_some_and(|m|m.recurring)).then(||serde_json::to_value(&task).unwrap())).ok_or("系列の基準情報がありません。Outlookから再取得してから変更してください")?;
    let exceptions:HashSet<String>=affected.iter().filter_map(|t|match is_exception(t,&old_template){Ok(true)=>Some(Ok(t.id.clone())),Ok(false)=>None,Err(e)=>Some(Err(e))}).collect::<Result<_,_>>()?;
    let stamp=chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let splitting=scope=="future"&&pending.is_none()&&same_group.iter().any(|t|original_date(t)<original.as_str());
    let group=if splitting{format!("{old_group}:split:{stamp:x}")}else{old_group.clone()};
    let anchor=if rule.is_null(){edit["date"].as_str().ok_or("Date missing")?}else{rule["patternStartDate"].as_str().ok_or("Pattern start missing")?};
    let template=if rule.is_null(){edit.clone()}else{make_template(&task,&old_template,&edit,anchor)?};
    let mut dates=if rule.is_null(){vec![anchor.to_string()]}else{
        let start_day=day(anchor)?;let mut horizon=start_day.max(chrono::Local::now().date_naive())+chrono::Duration::days(365);
        for row in &affected{horizon=horizon.max(day(original_date(row))?);}
        recurrence::occurrence_dates(&rule,&date_key(horizon))?
    };
    if !rule.is_null(){
        for row in &affected{if exceptions.contains(&row.id)&&!dates.iter().any(|date|date==original_date(row)){return Err(format!("{} の個別変更を新しい繰り返しルールに保持できません",original_date(row)));}}
        // Deleted occurrences remain deleted when the surrounding pattern is regenerated.
        let deleted:Vec<String>=tx.prepare("SELECT COALESCE(json_extract(COALESCE(l.deleted_task,l.last_task),'$.recurrence.occurrenceDate'),json_extract(COALESCE(l.deleted_task,l.last_task),'$.date')) FROM outlook_links l JOIN outlook_jobs j ON j.task_id=l.task_id WHERE NOT EXISTS(SELECT 1 FROM tasks WHERE id=l.task_id) AND json_extract(COALESCE(l.deleted_task,l.last_task),'$.recurrence.groupId')=?1 AND j.operation IN('delete','remote_removed')").map_err(|e|e.to_string())?.query_map([&old_group],|r|r.get(0)).map_err(|e|e.to_string())?.collect::<rusqlite::Result<_>>().map_err(|e|e.to_string())?;
        dates.retain(|date|!deleted.contains(date));
    }
    if dates.is_empty()||dates.len()>5000{return Err("Series must contain 1–5000 displayed occurrences".into());}
    let enabled=edit.get("outlookEnabled").and_then(Value::as_bool).unwrap_or(task.outlook_enabled);
    let changed_tag=edit.get("tagId").and_then(Value::as_str).filter(|tag|*tag!=task.tag_id);
    let source_reusable=!dates.iter().any(|date|date==original_date(&task));let mut source_reused=false;
    let mut prepared=Vec::new();
    for (index,date) in dates.iter().enumerate(){
        let previous=affected.iter().find(|row|original_date(row)==date);
        let retained=previous.or_else(||if source_reusable&&!source_reused{source_reused=true;Some(&task)}else{None});
        let next_id=retained.map(|row|row.id.clone()).unwrap_or_else(||format!("task-series-{stamp:x}-{index}"));
        let mut value=if !rule.is_null()&&previous.is_some_and(|row|exceptions.contains(&row.id)){serde_json::to_value(previous.unwrap()).unwrap()}else{template_at(&template,date)?};
        value["localMemo"]=changed_local_memo.clone().unwrap_or_else(||json!(retained.map(|row|row.personal_memo()).unwrap_or("")));
        if let Some(previous)=retained {
            // Read-only metadata belongs to each occurrence, never to the selected source row.
            if !exceptions.contains(&previous.id)||rule.is_null(){let editable=Value::Object(value["outlookDetails"].as_object().into_iter().flat_map(|map|map.iter()).filter(|(key,_)|crate::event_data::EDITABLE_DETAILS.contains(&key.as_str())).map(|(k,v)|(k.clone(),v.clone())).collect());value["outlookDetails"]=crate::event_data::merge_details(&previous.outlook_details,Some(&editable));}
            value["createdAt"]=json!(previous.created_at);
        }
        value["id"]=json!(next_id);value["tagId"]=json!(changed_tag.unwrap_or_else(||retained.map(|row|row.tag_id.as_str()).unwrap_or(&task.tag_id)));
        value["outlookEnabled"]=json!(false);value["recurrence"]=if rule.is_null(){json!({"type":"none","groupId":group})}else{json!({"type":"native","native":rule,"groupId":group,"occurrenceDate":date,"template":template,"exception":previous.is_some_and(|row|exceptions.contains(&row.id))})};
        crate::event_data::range(value["date"].as_str().ok_or("Date missing")?,value["endDate"].as_str(),value["isAllDay"].as_bool().unwrap_or(false),value["startTime"].as_str(),value["endTime"].as_str())?;
        prepared.push((next_id,value,retained.is_some()));
    }
    // All validation precedes mutation; the transaction also protects failures while saving.
    if splitting {
        let past_rule=recurrence::normalize_past_rule(&task.recurrence,&original)?;
        for past in same_group.iter().filter(|row|original_date(row)<original.as_str()){
            let mut rec=past.recurrence.clone();rec["native"]=past_rule.clone();
            tx.execute("UPDATE tasks SET outlook_enabled=0 WHERE id=?1",[&past.id]).map_err(|e|e.to_string())?;
            tx.execute("UPDATE tasks SET recurrence=?2,outlook_enabled=?3,updated_at=?4 WHERE id=?1",params![past.id,rec.to_string(),past.outlook_enabled as i64,chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos,true)]).map_err(|e|e.to_string())?;
            tx.execute("UPDATE outlook_jobs SET payload=json_set(payload,'$.recurrence',json(?2)),revision=revision+1 WHERE task_id=?1 AND operation='upsert' AND status<>'done'",params![past.id,rec.to_string()]).map_err(|e|e.to_string())?;
        }
    }
    if let Some((key,_))=&pending{tx.execute("UPDATE outlook_jobs SET status='done' WHERE task_id=?1",[key]).map_err(|e|e.to_string())?;}
    for old in &affected {tx.execute("UPDATE tasks SET outlook_enabled=0 WHERE id=?1",[&old.id]).map_err(|e|e.to_string())?;}
    let mut saved=Vec::new();
    for (next_id,value,existing) in prepared {
        if existing {
            tx.execute("UPDATE tasks SET title=?2,date=?3,end_date=?4,is_all_day=?5,start_time=?6,end_time=?7,memo=?8,outlook_details=?9,recurrence=?10,tag_id=?11,updated_at=?12,local_memo=?13 WHERE id=?1",params![next_id,value["title"].as_str().unwrap_or(""),value["date"].as_str(),value["endDate"].as_str(),value["isAllDay"].as_bool().unwrap_or(false) as i64,value["startTime"].as_str(),value["endTime"].as_str(),value["memo"].as_str().unwrap_or(""),value["outlookDetails"].to_string(),value["recurrence"].to_string(),value["tagId"].as_str().unwrap_or(""),chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos,true),value["localMemo"].as_str()]).map_err(|e|e.to_string())?;
        }else{repo::tasks_insert(&tx,serde_json::from_value(value).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;}
        crate::outlook_jobs::enable(&tx,&next_id).map_err(|e|e.to_string())?;
        if !enabled{crate::outlook_jobs::disable(&tx,&next_id).map_err(|e|e.to_string())?;}
        if let Some(meta)=&remote{tx.execute("UPDATE outlook_links SET calendar_name=?2 WHERE task_id=?1",params![next_id,meta.calendar]).map_err(|e|e.to_string())?;tx.execute("UPDATE outlook_jobs SET status='series_wait' WHERE task_id=?1",[&next_id]).map_err(|e|e.to_string())?;}
        saved.push(next_id);
    }
    for old in affected.iter().filter(|row|!saved.contains(&row.id)){
        repo::tasks_remove(&tx,&old.id).map_err(|e|e.to_string())?;tx.execute("UPDATE outlook_links SET sync_enabled=0 WHERE task_id=?1",[&old.id]).map_err(|e|e.to_string())?;tx.execute("UPDATE outlook_jobs SET operation='series_superseded',status='done',revision=revision+1 WHERE task_id=?1",[&old.id]).map_err(|e|e.to_string())?;
    }
    if let Some(meta)=remote {
        let coordinator=pending.as_ref().map(|(key,_)|key.clone()).unwrap_or_else(||format!("series-job-{stamp:x}"));
        let previous=pending.as_ref().map(|(_,request)|request);
        let payload=crate::outlook_jobs::WritePayload{task_id:id.into(),title:template["title"].as_str().unwrap_or("").into(),date:template["date"].as_str().ok_or("Template date missing")?.into(),end_date:template["endDate"].as_str().map(str::to_string),is_all_day:template["isAllDay"].as_bool().unwrap_or(false),start_time:template["startTime"].as_str().map(str::to_string),end_time:template["endTime"].as_str().map(str::to_string),memo:template["memo"].as_str().unwrap_or("").into(),outlook_details:template["outlookDetails"].clone(),recurrence:json!({"type":if rule.is_null(){"none"}else{"native"},"native":rule,"groupId":group,"template":template})};
        let request=recurrence::SeriesEditRequest{entry_id:previous.map(|p|p.entry_id.clone()).unwrap_or(meta.entry_id.clone()),store_id:previous.map(|p|p.store_id.clone()).unwrap_or(meta.store_id.clone()),expected_rule:previous.map(|p|p.expected_rule.clone()).unwrap_or_else(||task.recurrence.get("native").cloned().unwrap_or(Value::Null)),rule,scope:previous.map(|p|p.scope.clone()).unwrap_or(scope.into()),split_date:previous.map(|p|p.split_date.clone()).unwrap_or_else(||(scope=="future").then_some(original)),external_key:coordinator.clone(),payload:Some(payload)};
        tx.execute("INSERT INTO outlook_links(task_id,calendar_name,entry_id,store_id,external_key,remote_meta,sync_enabled) VALUES(?1,?2,?3,?4,?1,?5,1) ON CONFLICT(task_id) DO UPDATE SET sync_enabled=1",params![coordinator,meta.calendar,meta.entry_id,meta.store_id,serde_json::to_string(&meta).unwrap()]).map_err(|e|e.to_string())?;
        tx.execute("INSERT INTO outlook_jobs(task_id,operation,payload,status) VALUES(?1,'series',?2,'pending') ON CONFLICT(task_id) DO UPDATE SET operation='series',payload=excluded.payload,status='pending',last_error='',attempts=0,result=NULL,revision=revision+1",params![coordinator,json!({"request":request}).to_string()]).map_err(|e|e.to_string())?;
    }
    tx.commit().map_err(|e|e.to_string())?;repo::tasks_list(conn).map_err(|e|e.to_string())
}

#[cfg(test)]
mod queue_tests {
    use super::*;
    fn rule(mask:i64)->Value {json!({"recurrenceType":1,"interval":1,"dayOfWeekMask":mask,"dayOfMonth":0,"monthOfYear":0,"instance":0,"patternStartDate":"2026-10-09","patternEndDate":"2026-10-30","occurrences":null,"noEndDate":false})}
    fn fixture(enabled:bool)->Connection {
        let c=Connection::open_in_memory().unwrap();crate::db::migrate(&c,"2026-10").unwrap();repo::settings_set(&c,&json!({"outlookWriteEnabled":false})).unwrap();
        let template=json!({"title":"Master","date":"2026-10-09","endDate":"2026-10-09","isAllDay":false,"startTime":"09:00","endTime":"10:00","memo":"Master memo","outlookDetails":{"location":"Main room","organizer":"Owner"}});
        for (id,date) in [("a","2026-10-09"),("b","2026-10-16"),("c","2026-10-23"),("d","2026-10-30")] {
            repo::tasks_insert(&c,serde_json::from_value(json!({"id":id,"title":"Master","date":date,"endDate":date,"startTime":"09:00","endTime":"10:00","memo":"Master memo","recurrence":{"type":"native","native":rule(32),"groupId":"g","occurrenceDate":date,"template":template},"outlookDetails":{"location":"Main room","organizer":"Owner"},"outlookEnabled":enabled})).unwrap()).unwrap();
            if !enabled {crate::outlook_jobs::enable(&c,id).unwrap();crate::outlook_jobs::disable(&c,id).unwrap();}
            let remote=reconcile::RemoteIdentity{imported:true,calendar:"Calendar".into(),entry_id:"master".into(),store_id:"store".into(),series_id:"series".into(),occurrence_start:Some(format!("{date}T09:00:00")),recurring:true,read_only:None,version:"version".into()};
            c.execute("UPDATE outlook_links SET remote_meta=?2,entry_id='master',store_id='store' WHERE task_id=?1",params![id,serde_json::to_string(&remote).unwrap()]).unwrap();
            c.execute("UPDATE outlook_jobs SET status='done' WHERE task_id=?1",[id]).unwrap();
        }
        c
    }
    fn body(c:&Connection,id:&str,scope:&str,rule:Value)->Value {let task=repo::tasks_get(c,id).unwrap().unwrap();json!({"expectedUpdatedAt":task.updated_at,"scope":scope,"rule":rule,"payload":serde_json::to_value(task).unwrap()})}
    #[test]
    fn personal_notes_apply_to_selected_scope_without_outlook_jobs() {
        let c=fixture(true);
        c.execute("UPDATE tasks SET local_memo='Before'",[]).unwrap();
        let mut request=body(&c,"b","future",rule(32));
        request["payload"]["localMemo"]=json!("After");
        enqueue(&c,"b",request).unwrap();
        assert_eq!(repo::tasks_get(&c,"a").unwrap().unwrap().personal_memo(),"Before");
        for id in ["b","c","d"]{let task=repo::tasks_get(&c,id).unwrap().unwrap();assert_eq!(task.personal_memo(),"After");assert_eq!(task.memo,"Master memo");}
        let pending:i64=c.query_row("SELECT count(*) FROM outlook_jobs WHERE status<>'done'",[],|r|r.get(0)).unwrap();assert_eq!(pending,0);
    }
    fn coordinator(c:&Connection)->(String,Value) {let (id,raw):(String,String)=c.query_row("SELECT task_id,payload FROM outlook_jobs WHERE operation='series' AND status<>'done' ORDER BY rowid DESC LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();(id,serde_json::from_str::<Value>(&raw).unwrap()["request"].clone())}
    #[test]
    fn rule_only_edit_keeps_moved_exception_tag_and_private_metadata() {
        let c=fixture(true);c.execute("UPDATE tasks SET date='2026-10-17',end_date='2026-10-17',title='Exception',memo='Private note',tag_id='special',outlook_details=?1 WHERE id='b'",params![json!({"location":"Other room","organizer":"Other","attachments":[{"name":"proof.txt"}]}).to_string()]).unwrap();
        let mut changed=rule(32);changed["patternEndDate"]=json!("2026-11-06");
        enqueue(&c,"a",body(&c,"a","all",changed)).unwrap();
        let b=repo::tasks_get(&c,"b").unwrap().unwrap();assert_eq!(b.date,"2026-10-17");assert_eq!(b.title,"Exception");assert_eq!(b.memo,"Private note");assert_eq!(b.tag_id,"special");assert_eq!(b.outlook_details["attachments"][0]["name"],"proof.txt");
    }
    #[test]
    fn exception_outside_new_pattern_rejects_before_any_local_changes() {
        let c=fixture(true);c.execute("UPDATE tasks SET memo='Exception' WHERE id='b'",[]).unwrap();let before=serde_json::to_value(repo::tasks_list(&c).unwrap()).unwrap();
        assert!(enqueue(&c,"a",body(&c,"a","all",rule(16))).is_err());
        assert_eq!(serde_json::to_value(repo::tasks_list(&c).unwrap()).unwrap(),before);
    }
    #[test]
    fn future_segment_gets_distinct_group_and_later_edit_does_not_touch_past() {
        let c=fixture(true);enqueue(&c,"b",body(&c,"b","future",rule(32))).unwrap();
        let past=repo::tasks_get(&c,"a").unwrap().unwrap();let future=repo::tasks_get(&c,"b").unwrap().unwrap();assert_ne!(past.recurrence["groupId"],future.recurrence["groupId"]);
        let mut request=body(&c,"b","all",future.recurrence["native"].clone());request["payload"]["title"]=json!("Future only");enqueue(&c,"b",request).unwrap();
        assert_eq!(repo::tasks_get(&c,"a").unwrap().unwrap().title,"Master");
    }
    #[test]
    fn unattempted_queued_edits_keep_latest_request_and_original_remote_expectation() {
        let c=fixture(true);let initial=rule(32);let mut first=initial.clone();first["patternEndDate"]=json!("2026-11-06");enqueue(&c,"a",body(&c,"a","all",first)).unwrap();
        let mut second=initial.clone();second["patternEndDate"]=json!("2026-11-13");enqueue(&c,"a",body(&c,"a","all",second)).unwrap();
        assert_eq!(c.query_row("SELECT count(*) FROM outlook_jobs WHERE operation='series' AND status<>'done'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        let (_,request)=coordinator(&c);assert_eq!(request["expected_rule"],initial);assert_eq!(request["rule"]["patternEndDate"],"2026-11-13");
    }
    #[test]
    fn attempted_series_cannot_be_replaced_even_after_global_pause() {
        let c=fixture(true);enqueue(&c,"a",body(&c,"a","all",rule(32))).unwrap();c.execute("UPDATE outlook_jobs SET attempts=1,status='pending' WHERE operation='series'",[]).unwrap();let before=serde_json::to_value(repo::tasks_list(&c).unwrap()).unwrap();
        let mut second=rule(32);second["patternEndDate"]=json!("2026-11-06");assert!(enqueue(&c,"a",body(&c,"a","all",second)).is_err());assert_eq!(serde_json::to_value(repo::tasks_list(&c).unwrap()).unwrap(),before);
    }
    #[test]
    fn off_series_can_resume_when_all_affected_tasks_are_enabled() {
        let c=fixture(false);enqueue(&c,"a",body(&c,"a","all",rule(32))).unwrap();let (id,_)=coordinator(&c);
        for task in repo::tasks_list(&c).unwrap(){crate::outlook_jobs::enable(&c,&task.id).unwrap();}
        repo::settings_set(&c,&json!({"outlookWriteEnabled":true})).unwrap();c.execute("UPDATE outlook_jobs SET status='working' WHERE task_id=?1",[&id]).unwrap();
        assert!(crate::outlook_jobs::write_is_authorized(&c,&id,"series",1).unwrap());
    }
    #[test]
    fn changing_pattern_keeps_selected_id_when_its_old_day_disappears() {
        let c=fixture(true);enqueue(&c,"a",body(&c,"a","all",rule(16))).unwrap();let selected=repo::tasks_get(&c,"a").unwrap().unwrap();assert_eq!(selected.date,"2026-10-15");
    }
    #[test]
    fn rule_edit_from_exception_does_not_promote_exception_to_master_template() {
        let c=fixture(true);c.execute("UPDATE tasks SET title='Private exception',date='2026-10-17',end_date='2026-10-17' WHERE id='b'",[]).unwrap();
        enqueue(&c,"b",body(&c,"b","all",rule(32))).unwrap();
        let (_,request)=coordinator(&c);assert_eq!(request["payload"]["title"],"Master");
        assert_eq!(repo::tasks_get(&c,"b").unwrap().unwrap().title,"Private exception");assert_eq!(repo::tasks_get(&c,"a").unwrap().unwrap().title,"Master");
    }
    #[test]
    fn another_group_with_same_series_id_is_outside_local_rewrite() {
        let c=fixture(true);c.execute("UPDATE tasks SET outlook_series_id='shared-uid'",[]).unwrap();
        repo::tasks_insert(&c,serde_json::from_value(json!({"id":"foreign","title":"Foreign group","date":"2026-10-09","startTime":"11:00","endTime":"12:00","recurrence":{"type":"native","native":rule(32),"groupId":"different"}})).unwrap()).unwrap();c.execute("UPDATE tasks SET outlook_series_id='shared-uid' WHERE id='foreign'",[]).unwrap();
        let mut request=body(&c,"a","all",rule(32));request["payload"]["title"]=json!("Changed group");enqueue(&c,"a",request).unwrap();
        assert_eq!(repo::tasks_get(&c,"foreign").unwrap().unwrap().title,"Foreign group");
    }
    #[test]
    fn deleted_occurrence_is_not_regenerated_by_rule_edit() {
        let c=fixture(true);repo::tasks_remove(&c,"c").unwrap();let mut changed=rule(32);changed["patternEndDate"]=json!("2026-11-06");enqueue(&c,"a",body(&c,"a","all",changed)).unwrap();
        assert!(!repo::tasks_list(&c).unwrap().iter().any(|row|original_date(row)=="2026-10-23"));
    }
    #[test]
    fn apply_split_identity_uses_original_date_and_master_clock_for_moved_exception() {
        let c=fixture(true);c.execute("UPDATE tasks SET date='2026-10-08',end_date='2026-10-08',start_time='11:00',end_time='12:00' WHERE id='b'",[]).unwrap();
        let source=repo::tasks_get(&c,"a").unwrap().unwrap();
        let request=recurrence::SeriesEditRequest{entry_id:"master".into(),store_id:"store".into(),expected_rule:rule(32),rule:rule(32),scope:"future".into(),split_date:Some("2026-10-16".into()),external_key:"operation".into(),payload:Some(crate::outlook_jobs::WritePayload{task_id:"a".into(),title:source.title,date:source.date,end_date:source.end_date,is_all_day:false,start_time:source.start_time,end_time:source.end_time,memo:source.memo,outlook_details:source.outlook_details,recurrence:source.recurrence})};
        let mut canonical=rule(32);canonical["patternStartDate"]=json!("2026-10-16");canonical["occurrences"]=json!(3);
        let result=recurrence::SeriesEditResult{old_entry_id:"master".into(),old_store_id:"store".into(),new_entry_id:"new-master".into(),new_store_id:"store".into(),new_series_id:"new-series".into(),rule:json!({"type":"native","native":canonical}),affected_from:Some("2026-10-16".into())};
        apply_series_result(&c,&request,&result).unwrap();
        assert_eq!(repo::tasks_get(&c,"b").unwrap().unwrap().recurrence["native"],result.rule["native"]);
        let b=remote_for(&c,"b").unwrap().unwrap();assert_eq!(b.entry_id,"new-master");assert_eq!(b.occurrence_start.as_deref(),Some("2026-10-16T09:00:00"));assert_eq!(remote_for(&c,"a").unwrap().unwrap().entry_id,"master");
    }
    #[test]
    fn removing_recurrence_retains_selected_task_and_deletes_only_its_group() {
        let c=fixture(true);repo::tasks_insert(&c,serde_json::from_value(json!({"id":"other","title":"Other","date":"2026-10-09","startTime":"11:00","endTime":"12:00"})).unwrap()).unwrap();
        enqueue(&c,"b",body(&c,"b","all",Value::Null)).unwrap();let rows=repo::tasks_list(&c).unwrap();assert_eq!(rows.len(),2);assert!(rows.iter().any(|r|r.id=="b"));assert!(rows.iter().any(|r|r.id=="other"));
    }
}
