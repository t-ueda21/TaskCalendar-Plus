use super::*;
use serde::{Deserialize, Serialize};

const PREFIX: &str = "outlook-folder:";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CalendarReference { entry_id: String, store_id: String, label: String }
#[derive(Debug, Clone, Serialize)]
pub struct CalendarChoice { pub id: String, pub label: String }
#[derive(Debug, Default, Serialize)]
pub struct CalendarList { pub calendars: Vec<CalendarChoice>, pub warnings: Vec<String> }

fn reference(value: &str) -> Result<Option<CalendarReference>, String> {
    let Some(encoded) = value.strip_prefix(PREFIX) else { return Ok(None) };
    let invalid = || "保存したOutlook予定表の識別情報が不正です。候補を再取得して選び直してください".to_string();
    if encoded.len() > 32768 { return Err(invalid()); }
    let selected: CalendarReference = serde_json::from_str(encoded).map_err(|_| invalid())?;
    if selected.entry_id.trim().is_empty() || selected.store_id.trim().is_empty() || selected.label.trim().is_empty() {
        return Err(invalid());
    }
    Ok(Some(selected))
}
pub fn calendar_label(value: &str) -> String {
    match reference(value) { Ok(Some(selected)) => selected.label, Ok(None) => value.to_string(), Err(_) => "保存済みの予定表".into() }
}

// A selected folder is resolved by BOTH IDs. An unavailable ID must not silently
// redirect reads or writes to another calendar with the same display name.
pub(super) fn resolve(namespace: &w::IDispatch, value: &str) -> Result<Option<w::IDispatch>, String> {
    let Some(selected) = reference(value)? else { return Ok(None) };
    let folder = invoke_optional_dispatch(namespace, "GetFolderFromID", &[
        AutomationValue::from(selected.entry_id.as_str()), AutomationValue::from(selected.store_id.as_str()),
    ]).map_err(|error|format!("予定表「{}」を開けません。候補を再取得して選び直してください: {error}",selected.label))?
        .ok_or("選択したOutlook予定表が見つかりません。候補を再取得して選び直してください")?;
    if variant_to_i32(&folder.invoke_get("DefaultItemType",&[]).map_err(|e|e.to_string())?) != Some(1) {
        return Err("選択したOutlookフォルダは予定表ではありません".into());
    }
    Ok(Some(folder))
}

// Bound traversal independently of COM so errors, duplicates and depth can be tested.
fn collect<T>(roots: Vec<T>, mut inspect: impl FnMut(T) -> Result<(Option<CalendarChoice>, Vec<T>), String>) -> CalendarList {
    let mut result=CalendarList::default();
    let mut queue: std::collections::VecDeque<_> = roots.into_iter().map(|node|(node,0)).collect();
    let mut visited=0;
    let mut limit_reported=false;
    let mut ids=std::collections::HashSet::new();
    while let Some((node,depth))=queue.pop_front() {
        if visited >= 5000 || depth > 32 {
            result.warnings.push("予定表フォルダの探索上限に達しました。一部の候補を取得できていません".into());
            break;
        }
        visited+=1;
        match inspect(node) {
            Ok((calendar, children)) => {
                if let Some(calendar)=calendar && ids.insert(calendar.id.clone()) { result.calendars.push(calendar); }
                let available=5000_usize.saturating_sub(queue.len()+visited);
                if children.len()>available && !limit_reported {
                    result.warnings.push("予定表フォルダの探索上限に達しました。一部の候補を取得できていません".into());
                    limit_reported=true;
                }
                queue.extend(children.into_iter().take(available).map(|child|(child,depth+1)));
            },
            Err(error) => result.warnings.push(error),
        }
    }
    result.calendars.sort_by(|a,b|a.label.cmp(&b.label).then(a.id.cmp(&b.id)));
    result
}

pub(super) fn children(parent: &w::IDispatch, warnings: &mut Vec<String>) -> Result<Vec<w::IDispatch>, String> {
    let folders=parent.invoke_get("Folders",&[]).map_err(|e|format!("フォルダ一覧を取得できません: {e}"))?
        .unwrap_dispatch_opt().ok_or("Outlookフォルダ一覧がありません")?;
    let mut children=Vec::new();
    for index in 1..=folder_count(&folders)? {
        match invoke_optional_dispatch(&folders,"Item",&[AutomationValue::from(index)]) {
            Ok(Some(folder)) => children.push(folder),
            Ok(None) => warnings.push("Outlookフォルダが見つかりません".into()),
            Err(error) => warnings.push(error),
        }
    }
    Ok(children)
}
fn text_property(folder: &w::IDispatch, name: &str) -> Result<String,String> {
    variant_to_opt_string(&folder.invoke_get(name,&[]).map_err(|e|format!("Outlook {name}: {e}"))?)
        .ok_or_else(||format!("Outlook {name} がありません"))
}

pub(super) fn discover() -> Result<CalendarList,String> {
    let outlook=connect_outlook()?;
    let namespace=invoke_optional_dispatch(&outlook,"GetNamespace",&[AutomationValue::from("MAPI")])?
        .ok_or("Outlook namespace unavailable")?;
    // Namespace.Folders contains stores mounted in the current Classic Outlook profile.
    let mut child_errors=Vec::new();
    let roots=children(&namespace,&mut child_errors)?;
    let mut result=collect(roots,|folder| {
        let kind=variant_to_i32(&folder.invoke_get("DefaultItemType",&[]).map_err(|e|e.to_string())?);
        let calendar=if kind==Some(1) {
            let selected=CalendarReference {entry_id:text_property(&folder,"EntryID")?,store_id:text_property(&folder,"StoreID")?,label:text_property(&folder,"FolderPath")?};
            Some(CalendarChoice {id:format!("{PREFIX}{}",serde_json::to_string(&selected).map_err(|e|e.to_string())?),label:selected.label})
        } else {None};
        let subfolders=children(&folder,&mut child_errors).unwrap_or_else(|error| {child_errors.push(error);Vec::new()});
        Ok((calendar,subfolders))
    });
    result.warnings.extend(child_errors);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn references_preserve_identity_and_reject_invalid_target_without_name_fallback() {
        let raw = r#"outlook-folder:{"entryId":"folder-a","storeId":"store-b","label":"Account / Calendar"}"#;
        let parsed=reference(raw).unwrap().expect("selected calendar must resolve by ID");
        assert_eq!(parsed.entry_id,"folder-a"); assert_eq!(parsed.store_id,"store-b");
        assert_eq!(calendar_label(raw),"Account / Calendar");
        assert!(reference("Calendar").unwrap().is_none());
        assert!(reference("outlook-folder:broken").is_err());
        assert!(reference(r#"outlook-folder:{"entryId":"","storeId":"b","label":"A"}"#).is_err());
    }
    #[test]
    fn enumeration_keeps_same_name_calendars_and_reports_inaccessible_branches() {
        let list=collect(vec![0],|node|Ok(match node {
            0 => (None,vec![1,2,3]),
            1 => (Some(CalendarChoice{id:"a".into(),label:"A / Calendar".into()}),vec![]),
            2 => (Some(CalendarChoice{id:"b".into(),label:"B / Calendar".into()}),vec![]),
            _ => return Err("access denied".into()),
        }));
        assert_eq!(list.calendars.len(),2);
        assert_ne!(list.calendars[0].id,list.calendars[1].id);
        assert_eq!(list.warnings,vec!["access denied"]);
    }
    #[test]
    fn traversal_limit_retains_already_queued_calendars() {
        let result=collect((0..5).collect(),|node|Ok(if node<5 {
            (None,(5+node*1000..5+(node+1)*1000).collect())
        }else {(Some(CalendarChoice{id:node.to_string(),label:node.to_string()}),vec![])}));
        assert_eq!(result.calendars.len(),4995);
        assert_eq!(result.warnings.len(),1);
    }
    #[test]
    fn enumeration_bounds_cycles_instead_of_hanging() {
        let list=collect(vec![0],|node|Ok((None,vec![node+1])));
        assert_eq!(list.warnings.len(),1);
    }
}

#[cfg(test)]
mod live_tests {
    #[tokio::test]
    #[ignore = "requires a configured Classic Outlook profile; read-only folder metadata"]
    async fn live_discover_calendar_names_without_reading_or_writing_appointments() {
        let calendars=tokio::time::timeout(std::time::Duration::from_secs(30),super::super::fetch_calendars()).await.expect("calendar discovery timeout").expect("Outlook discovery failed");
        eprintln!("Calendar discovery: {} calendars, {} warnings",calendars.calendars.len(),calendars.warnings.len());
        assert!(!calendars.calendars.is_empty());
        for calendar in calendars.calendars {assert!(super::reference(&calendar.id).unwrap().is_some());}
    }
}

pub(super) fn identify(folder:&w::IDispatch)->Result<String,String>{
    let reference=CalendarReference {entry_id:automation::text(folder,"EntryID")?,store_id:automation::text(folder,"StoreID")?,label:automation::text(folder,"FolderPath")?};
    Ok(format!("{PREFIX}{}",serde_json::to_string(&reference).map_err(|e|e.to_string())?))
}
pub fn same_calendar(a:&str,b:&str)->bool {
    match (reference(a),reference(b)) {
        (Ok(Some(a)),Ok(Some(b)))=>a.entry_id==b.entry_id&&a.store_id==b.store_id,
        (Ok(None),Ok(None))=>a.eq_ignore_ascii_case(b)||(is_default_calendar_name(a)&&is_default_calendar_name(b)),
        _=>false,
    }
}
