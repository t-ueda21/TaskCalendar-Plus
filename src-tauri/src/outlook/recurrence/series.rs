//! Series changes always target a master and retain representable exceptions.
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeriesEditRequest {
    pub entry_id: String,
    pub store_id: String,
    pub expected_rule: Value,
    pub rule: Value,
    pub scope: String,
    pub split_date: Option<String>,
    pub external_key: String,
    #[serde(default)]
    pub payload: Option<crate::outlook_jobs::WritePayload>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeriesEditResult {
    pub old_entry_id: String,
    pub old_store_id: String,
    pub new_entry_id: String,
    pub new_store_id: String,
    pub new_series_id: String,
    pub rule: Value,
    pub affected_from: Option<String>,
}
const FIELDS: &[&str] = &[
    "Subject",
    "Body",
    "RTFBody",
    "Location",
    "AllDayEvent",
    "Start",
    "End",
    "BusyStatus",
    "Sensitivity",
    "Importance",
    "ReminderSet",
    "ReminderMinutesBeforeStart",
    "Categories",
];
const SERIES_OPERATION_PROPERTY: &str = "TaskCalendarSeriesOperation";
type Fields = Vec<(&'static str, AutomationValue)>;
struct SavedAttachment {
    path: std::path::PathBuf,
    name: String,
    position: i32,
}
impl Drop for SavedAttachment {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        if let Some(parent) = self.path.parent()
            && parent
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("TaskCalendar-exception-"))
            {
                let _ = std::fs::remove_dir(parent);
            }
    }
}
struct UserProperty {
    name: String,
    kind: i32,
    value: AutomationValue,
}
struct ExceptionSnapshot {
    date: String,
    deleted: bool,
    fields: Fields,
    attachments: Vec<SavedAttachment>,
    properties: Vec<UserProperty>,
}
fn fields(item: &w::IDispatch) -> Result<Fields, String> {
    FIELDS
        .iter()
        .map(|name| {
            Ok((
                *name,
                automation::get(item, name).map_err(|e| format!("Snapshot {name}: {e}"))?,
            ))
        })
        .collect()
}
fn restore_fields(item: &w::IDispatch, values: &Fields) -> Result<(), String> {
    let occurrence = [2, 3].contains(&automation::integer(item, "RecurrenceState")?);
    for (name, value) in values {
        // Outlook exposes these inherited fields on occurrences but rejects PUT;
        // they remain on the master (copied for a future split).
        if occurrence && ["Sensitivity", "Categories"].contains(name) {
            continue;
        }
        put_field(item, name, value).map_err(|e| format!("Restore {name}: {e}"))?;
    }
    Ok(())
}
fn put_field(item: &w::IDispatch, name: &str, value: &AutomationValue) -> Result<(), String> {
    if name != "RTFBody" {
        return automation::put(item, name, value.clone());
    }
    let mut data = value.clone();
    let mut argument = AutomationValue::default();
    // RTFBody's Outlook automation setter consumes a VARIANT* byte array.
    unsafe {
        (*argument.Anonymous.Anonymous).vt =
            windows::Win32::System::Variant::VT_BYREF | windows::Win32::System::Variant::VT_VARIANT;
        (*argument.Anonymous.Anonymous).Anonymous.pvarVal = &mut data;
    }
    automation::put(item, name, argument)
}
fn open(ns: &w::IDispatch, id: &str, store: &str) -> Result<w::IDispatch, String> {
    automation::object_method(
        ns,
        "GetItemFromID",
        &[AutomationValue::from(id), AutomationValue::from(store)],
    )
}
fn exception_snapshots(master: &w::IDispatch) -> Result<Vec<ExceptionSnapshot>, String> {
    let p = automation::object_method(master, "GetRecurrencePattern", &[])?;
    let all = automation::object_get(&p, "Exceptions")?;
    let count = automation::integer(&all, "Count")?;
    if count > 5000 {
        return Err("Too many recurrence exceptions to preserve safely".into());
    }
    let mut result = Vec::new();
    for index in 1..=count {
        let ex = automation::object_method(&all, "Item", &[AutomationValue::from(index)])?;
        let date = property_date(&ex, "OriginalDate")?;
        let deleted =
            bool::try_from(&automation::get(&ex, "Deleted")?).map_err(|e| e.to_string())?;
        let mut saved_attachments = Vec::new();
        let mut saved_properties = Vec::new();
        let data = if deleted {
            Vec::new()
        } else {
            // GetOccurrence yields the logical appointment with inherited master
            // fields. Exception.AppointmentItem can be a partial IPM.OLE.Class
            // embedded message whose Sensitivity etc. getters are unsupported.
            let item = automation::object_method(
                &p,
                "GetOccurrence",
                &[automation::get(&ex, "OriginalDate")?],
            )?;
            let attachments = automation::object_get(&item, "Attachments")?;
            for n in 1..=automation::integer(&attachments, "Count")? {
                let attachment =
                    automation::object_method(&attachments, "Item", &[AutomationValue::from(n)])?;
                if automation::integer(&attachment, "Type")? != 1 {
                    return Err("埋め込みオブジェクトを持つ個別変更があります。情報を保護するため Outlook でルールを変更してください".into());
                }
                let name = automation::text(&attachment, "FileName")?;
                if std::path::Path::new(&name)
                    .file_name()
                    .is_none_or(|part| part != std::ffi::OsStr::new(&name))
                {
                    return Err("Attachment filename is unsafe to preserve".into());
                }
                let directory = std::env::temp_dir().join(format!(
                    "TaskCalendar-exception-{}-{n}",
                    rand::random::<u64>()
                ));
                std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
                let saved = SavedAttachment {
                    path: directory.join(&name),
                    name,
                    position: automation::integer(&attachment, "Position")?,
                };
                automation::method(
                    &attachment,
                    "SaveAsFile",
                    &[AutomationValue::from(saved.path.to_string_lossy().as_ref())],
                )?;
                saved_attachments.push(saved);
            }
            let properties = automation::object_get(&item, "UserProperties")?;
            for n in 1..=automation::integer(&properties, "Count")? {
                let property =
                    automation::object_method(&properties, "Item", &[AutomationValue::from(n)])?;
                let name = automation::text(&property, "Name")?;
                if name != TASK_KEY_PROPERTY && name != SERIES_OPERATION_PROPERTY {
                    let kind = automation::integer(&property, "Type")?;
                    if ![1, 3, 5, 6, 7, 11, 12, 14, 20, 21].contains(&kind) {
                        return Err(
                            "計算式などのカスタム項目は Outlook で保持して編集してください".into(),
                        );
                    }
                    saved_properties.push(UserProperty {
                        name,
                        kind,
                        value: automation::get(&property, "Value")?,
                    });
                }
            }
            if automation::integer(&item, "MeetingStatus")? != 0 {
                return Err("参加者がある個別変更を保持するため、繰り返しルールを Outlook で変更してください".into());
            }
            let message_class = automation::text(&item, "MessageClass")?;
            if ![
                "IPM.Appointment",
                "IPM.OLE.Class",
                "IPM.OLE.CLASS.{00061055-0000-0000-C000-000000000046}",
            ]
            .iter()
            .any(|known| message_class.eq_ignore_ascii_case(known))
            {
                return Err(format!(
                    "Custom appointment form {message_class} must be edited in Outlook"
                ));
            }
            fields(&item)?
        };
        result.push(ExceptionSnapshot {
            date,
            deleted,
            fields: data,
            attachments: saved_attachments,
            properties: saved_properties,
        });
    }
    Ok(result)
}
fn preflight_exceptions(rule: &Value, exceptions: &[&ExceptionSnapshot]) -> Result<(), String> {
    let Some(last) = exceptions.iter().map(|e| e.date.as_str()).max() else {
        return Ok(());
    };
    let dates: std::collections::HashSet<_> = occurrence_dates(rule, last)?.into_iter().collect();
    if let Some(ex) = exceptions
        .iter()
        .find(|e| !e.deleted && !dates.contains(&e.date))
    {
        return Err(format!(
            "変更後のルールに {} の個別変更を保持できません。Outlook で繰り返しルールを変更してください",
            ex.date
        ));
    }
    Ok(())
}
fn replay(
    ns: &w::IDispatch,
    id: &str,
    store: &str,
    exceptions: &[&ExceptionSnapshot],
) -> Result<(), String> {
    for ex in exceptions {
        // Release each master/pattern/occurrence before acquiring the next one.
        let master = open(ns, id, store)?;
        let p = automation::object_method(&master, "GetRecurrencePattern", &[])?;
        let time = reconcile::date_property(&p, "StartTime")?
            .format("%H:%M:%S")
            .to_string();
        let occurrence =
            automation::object_method(&p, "GetOccurrence", &[outlook_date(&ex.date, &time)?]);
        match occurrence {
            Ok(item) => {
                if ex.deleted {
                    automation::method(&item, "Delete", &[])?;
                } else {
                    restore_fields(&item, &ex.fields)?;
                    let attachments = automation::object_get(&item, "Attachments")?;
                    for n in (1..=automation::integer(&attachments, "Count")?).rev() {
                        automation::method(&attachments, "Remove", &[AutomationValue::from(n)])?;
                    }
                    for a in &ex.attachments {
                        automation::object_method(
                            &attachments,
                            "Add",
                            &[
                                AutomationValue::from(a.path.to_string_lossy().as_ref()),
                                AutomationValue::from(1),
                                AutomationValue::from(a.position),
                                AutomationValue::from(a.name.as_str()),
                            ],
                        )?;
                    }
                    if let Some((_, rtf)) = ex.fields.iter().find(|(name, _)| *name == "RTFBody") {
                        put_field(&item, "RTFBody", rtf)?;
                    }
                    let properties = automation::object_get(&item, "UserProperties")?;
                    for property in &ex.properties {
                        let p = match automation::optional_method(
                            &properties,
                            "Find",
                            &[
                                AutomationValue::from(property.name.as_str()),
                                AutomationValue::from(true),
                            ],
                        )? {
                            Some(p) => p,
                            None => automation::object_method(
                                &properties,
                                "Add",
                                &[
                                    AutomationValue::from(property.name.as_str()),
                                    AutomationValue::from(property.kind),
                                    AutomationValue::from(false),
                                ],
                            )?,
                        };
                        automation::put(&p, "Value", property.value.clone())?;
                    }
                    automation::method(&item, "Save", &[])?;
                }
            }
            Err(_) if ex.deleted => {}
            Err(error) => return Err(format!("Cannot restore exception {}: {error}", ex.date)),
        }
    }
    Ok(())
}
fn set_external_key(item: &w::IDispatch, key: &str) -> Result<(), String> {
    set_named_text(item, TASK_KEY_PROPERTY, key)
}
fn set_named_text(item: &w::IDispatch, name: &str, key: &str) -> Result<(), String> {
    let properties = automation::object_get(item, "UserProperties")?;
    let prop = match automation::optional_method(
        &properties,
        "Find",
        &[AutomationValue::from(name), AutomationValue::from(true)],
    )? {
        Some(p) => p,
        None => automation::object_method(
            &properties,
            "Add",
            &[
                AutomationValue::from(name),
                AutomationValue::from(1_i32),
                AutomationValue::from(true),
            ],
        )?,
    };
    automation::put(&prop, "Value", AutomationValue::from(key))
}
fn result(
    request: &SeriesEditRequest,
    master: &w::IDispatch,
    from: Option<String>,
) -> Result<SeriesEditResult, String> {
    Ok(SeriesEditResult {
        old_entry_id: request.entry_id.clone(),
        old_store_id: request.store_id.clone(),
        new_entry_id: automation::text(master, "EntryID")?,
        new_store_id: automation::text(&automation::object_get(master, "Parent")?, "StoreID")?,
        new_series_id: automation::text(master, "GlobalAppointmentID")?,
        rule: read(master)?,
        affected_from: from,
    })
}
fn find_prepared(master: &w::IDispatch, key: &str) -> Result<Option<w::IDispatch>, String> {
    let folder = automation::object_get(master, "Parent")?;
    let items = automation::object_get(&folder, "Items")?;
    automation::put(&items, "IncludeRecurrences", AutomationValue::from(false))?;
    // A new calendar may not have this user property in its folder schema yet.
    let mut item = automation::optional_method(&items, "GetFirst", &[])?;
    let mut inspected = 0;
    while let Some(candidate) = item {
        inspected += 1;
        if inspected > 5000 {
            return Err(
                "Calendar contains too many masters for safe series recovery lookup".into(),
            );
        }
        if automation::integer(&candidate, "Class")? == OL_APPOINTMENT_CLASS {
            let props = automation::object_get(&candidate, "UserProperties")?;
            let is_source =
                automation::text(&candidate, "EntryID")? == automation::text(master, "EntryID")?;
            if !is_source
                && let Some(p) = automation::optional_method(
                    &props,
                    "Find",
                    &[
                        AutomationValue::from(SERIES_OPERATION_PROPERTY),
                        AutomationValue::from(true),
                    ],
                )?
                    && automation::text(&p, "Value")? == key {
                        return Ok(Some(candidate));
                    }
            if let Some(p) = automation::optional_method(
                &props,
                "Find",
                &[
                    AutomationValue::from(TASK_KEY_PROPERTY),
                    AutomationValue::from(true),
                ],
            )?
                && automation::text(&p, "Value")? == key {
                    if automation::text(&candidate, "EntryID")?
                        == automation::text(master, "EntryID")?
                    {
                        return Err("A series split must use a new external operation key".into());
                    }
                    return Ok(Some(candidate));
                }
        }
        item = automation::optional_method(&items, "GetNext", &[])?;
    }
    Ok(None)
}
fn same_schedule(a: &Value, b: &Value) -> Result<bool, String> {
    let a = NativeRule::parse(a)?;
    let b = NativeRule::parse(b)?;
    if a.recurrence_type != b.recurrence_type
        || a.interval != b.interval
        || ([1, 3, 6].contains(&a.recurrence_type) && a.day_of_week_mask != b.day_of_week_mask)
        || ([2, 5].contains(&a.recurrence_type) && a.day_of_month != b.day_of_month)
        || ([5, 6].contains(&a.recurrence_type) && a.month_of_year != b.month_of_year)
        || ([3, 6].contains(&a.recurrence_type) && a.instance != b.instance)
        || a.no_end_date != b.no_end_date
    {
        return Ok(false);
    }
    let end = if a.no_end_date {
        let start = day(&a.pattern_start_date)?.min(day(&b.pattern_start_date)?);
        date_key(
            (start + chrono::Duration::days(366_i64 * i64::from(a.interval) * 2))
                .min(day("4500-12-31")?),
        )
    } else {
        a.pattern_end_date
            .as_ref()
            .into_iter()
            .chain(b.pattern_end_date.as_ref())
            .max()
            .cloned()
            .unwrap_or_else(|| "4500-12-31".into())
    };
    Ok(occurrence_dates(&serde_json::to_value(a).unwrap(), &end)?
        == occurrence_dates(&serde_json::to_value(b).unwrap(), &end)?)
}
pub(in crate::outlook) fn execute(
    namespace: &w::IDispatch,
    request: &SeriesEditRequest,
) -> Result<SeriesEditResult, String> {
    if let Some(payload) = &request.payload {
        super::super::validate_write_precision(payload)?;
    }
    let removing =
        request.rule.is_null() || request.rule.get("type").and_then(Value::as_str) == Some("none");
    let was_standalone = request.expected_rule.is_null()
        || request.expected_rule.get("type").and_then(Value::as_str) == Some("none");
    let mut proposed = if removing {
        Value::Null
    } else {
        validate(&request.rule)?
    };
    let expected = if was_standalone {
        Value::Null
    } else {
        validate(&request.expected_rule)?
    };
    if !["all", "series", "future"].contains(&request.scope.as_str()) {
        return Err("Series scope must be all or future".into());
    }
    if request.entry_id.is_empty() || request.store_id.is_empty() {
        return Err("Series identity is missing".into());
    }
    let cutoff = if request.scope == "future" {
        Some(day(request
            .split_date
            .as_deref()
            .ok_or("Future scope requires split date")?)?)
    } else {
        None
    };
    if let Some(cutoff) = cutoff
        && !removing && !was_standalone {
            proposed = future_rule(&expected, &proposed, &date_key(cutoff))?;
        }
    let master = open(namespace, &request.entry_id, &request.store_id)?;
    if was_standalone {
        if automation::integer(&master, "RecurrenceState")? != 0 {
            return Err("競合: Outlook 側で定期予定に変更されています。再同期してください".into());
        }
        let original = fields(&master)?;
        let mutation = (|| {
            if let Some(payload) = &request.payload {
                super::super::apply_payload(&master, payload)?;
            }
            if !removing {
                apply(&master, &proposed)?;
            }
            automation::method(&master, "Save", &[])?;
            Ok::<(), String>(())
        })();
        if let Err(error) = mutation {
            let rollback = (|| {
                if automation::integer(&master, "RecurrenceState")? != 0 {
                    automation::method(&master, "ClearRecurrencePattern", &[])?;
                }
                restore_fields(&master, &original)?;
                automation::method(&master, "Save", &[])?;
                Ok::<(), String>(())
            })();
            return Err(format!(
                "Series conversion failed: {error}; restoration: {}",
                rollback.map(|_| "completed".into()).unwrap_or_else(|e| e)
            ));
        }
        return result(request, &master, None);
    }
    if automation::integer(&master, "RecurrenceState")? != 1 {
        return Err("Series identity must refer to the recurrence master".into());
    }
    let current = validate(&read(&master)?)?;
    let prepared = if cutoff.is_some() && !request.external_key.is_empty() {
        find_prepared(&master, &request.external_key)?
    } else {
        None
    };
    // A retry after the original was trimmed returns the already prepared master.
    if let (Some(cut), Some(copy)) = (cutoff, prepared.as_ref()) {
        let cut = date_key(cut);
        if !removing && proposed["patternStartDate"].as_str().unwrap() < cut.as_str() {
            proposed["patternStartDate"] = json!(cut);
        }
        let prepared_matches = if removing {
            read(copy)?["type"] == "none"
        } else {
            same_schedule(&read(copy)?, &proposed)?
        };
        if prepared_matches
            && split_rule(&expected, &cut)
                .is_ok_and(|past| same_schedule(&current, &past).unwrap_or(false))
        {
            return result(request, copy, Some(cut));
        }
    }
    if !same_schedule(&current, &expected)? {
        return Err(
            "競合: Outlook 側の繰り返しルールが変更されています。再同期してください".into(),
        );
    }
    let old_fields = fields(&master)?;
    let snapshots = exception_snapshots(&master)?;
    let all: Vec<_> = snapshots.iter().collect();
    let cutoff =
        cutoff.filter(|d| *d > day(current["patternStartDate"].as_str().unwrap()).unwrap());
    if let Some(cutoff) = cutoff {
        if request.external_key.is_empty() {
            return Err("Future series requires a stable external key".into());
        }
        if automation::integer(&master, "MeetingStatus")? != 0 {
            return Err("会議の分割では参加者と通知の管理が必要です。Outlook でこの日以降の定期予定を変更してください".into());
        }
        let cutoff = date_key(cutoff);
        let past_rule = split_rule(&current, &cutoff)?;
        if !removing {
            if proposed["patternStartDate"].as_str().unwrap() < cutoff.as_str() {
                proposed["patternStartDate"] = json!(cutoff);
            }
            proposed = validate(&proposed)?;
        }
        let past: Vec<_> = all.iter().copied().filter(|ex| ex.date < cutoff).collect();
        let future: Vec<_> = all
            .iter()
            .copied()
            .filter(|ex| !removing && ex.date >= cutoff)
            .collect();
        if !removing {
            preflight_exceptions(&proposed, &future)?;
        }
        preflight_exceptions(&past_rule, &past)?;
        // Copy preserves master timezone, attachments and other provider metadata.
        // The copy is deleted if preparation fails, before the original is trimmed.
        let copy = if let Some(copy) = prepared {
            copy
        } else {
            // Save the operation marker before Copy. Outlook copies UserProperties,
            // so recovery can identify the new item even if the process stops
            // immediately after Copy, before its separate external key is saved.
            set_named_text(&master, SERIES_OPERATION_PROPERTY, &request.external_key)?;
            automation::method(&master, "Save", &[])?;
            automation::object_method(&master, "Copy", &[])?
        };
        let new_id = automation::text(&copy, "EntryID")?;
        let prepare = (|| {
            automation::method(&copy, "ClearRecurrencePattern", &[])?;
            set_external_key(&copy, &request.external_key)?;
            if removing && request.payload.is_none() {
                let start = reconcile::date_property(&copy, "Start")?;
                let end = reconcile::date_property(&copy, "End")?;
                let shifted = day(&cutoff)?.and_time(start.time());
                let shifted_end = shifted + (end - start);
                automation::put(
                    &copy,
                    "Start",
                    outlook_date(
                        &date_key(shifted.date()),
                        &shifted.format("%H:%M:%S").to_string(),
                    )?,
                )?;
                automation::put(
                    &copy,
                    "End",
                    outlook_date(
                        &date_key(shifted_end.date()),
                        &shifted_end.format("%H:%M:%S").to_string(),
                    )?,
                )?;
            }
            if let Some(payload) = &request.payload {
                super::super::apply_payload(&copy, payload)?;
            }
            if !removing {
                apply(&copy, &proposed)?;
            }
            automation::method(&copy, "Save", &[])?;
            Ok::<(), String>(())
        })();
        drop(copy);
        if let Err(error) = prepare {
            if let Ok(copy) = open(namespace, &new_id, &request.store_id) {
                let _ = automation::method(&copy, "Delete", &[]);
            }
            return Err(error);
        }
        if let Err(error) = replay(namespace, &new_id, &request.store_id, &future) {
            if let Ok(copy) = open(namespace, &new_id, &request.store_id) {
                let _ = automation::method(&copy, "Delete", &[]);
            }
            return Err(error);
        }
        let trim = (|| {
            apply(&master, &past_rule)?;
            automation::method(&master, "Save", &[])?;
            Ok::<(), String>(())
        })();
        drop(master);
        let finish =
            trim.and_then(|_| replay(namespace, &request.entry_id, &request.store_id, &past));
        if let Err(error) = finish {
            let rollback = (|| {
                let old = open(namespace, &request.entry_id, &request.store_id)?;
                restore_fields(&old, &old_fields)?;
                apply(&old, &current)?;
                automation::method(&old, "Save", &[])?;
                drop(old);
                replay(namespace, &request.entry_id, &request.store_id, &all)
            })();
            if rollback.is_ok()
                && let Ok(copy) = open(namespace, &new_id, &request.store_id) {
                    let _ = automation::method(&copy, "Delete", &[]);
                }
            return Err(format!(
                "Series split failed: {error}; original restoration: {}",
                rollback
                    .map(|_| "completed".to_string())
                    .unwrap_or_else(|e| format!("FAILED ({e}); keep both series for recovery"))
            ));
        }
        result(
            request,
            &open(namespace, &new_id, &request.store_id)?,
            Some(cutoff),
        )
    } else {
        if !removing {
            preflight_exceptions(&proposed, &all)?;
        }
        let mutation = (|| {
            if removing {
                automation::method(&master, "ClearRecurrencePattern", &[])?;
            }
            if let Some(payload) = &request.payload {
                super::super::apply_payload(&master, payload)?;
            }
            if !removing {
                apply(&master, &proposed)?;
            }
            automation::method(&master, "Save", &[])?;
            Ok::<(), String>(())
        })();
        drop(master);
        let finish = mutation.and_then(|_| {
            if removing {
                Ok(())
            } else {
                replay(namespace, &request.entry_id, &request.store_id, &all)
            }
        });
        if let Err(error) = finish {
            let rollback = (|| {
                let old = open(namespace, &request.entry_id, &request.store_id)?;
                restore_fields(&old, &old_fields)?;
                apply(&old, &current)?;
                automation::method(&old, "Save", &[])?;
                drop(old);
                replay(namespace, &request.entry_id, &request.store_id, &all)
            })();
            return Err(format!(
                "Series change failed: {error}; original restoration: {}",
                rollback
                    .map(|_| "completed".to_string())
                    .unwrap_or_else(|e| format!("FAILED ({e})"))
            ));
        }
        result(
            request,
            &open(namespace, &request.entry_id, &request.store_id)?,
            None,
        )
    }
}

fn split_rule(old: &Value, cutoff: &str) -> Result<Value, String> {
    let mut r = NativeRule::parse(old)?;
    let cutoff = day(cutoff)?;
    if cutoff <= day(&r.pattern_start_date)? {
        return Err("Split must follow the original series start".into());
    }
    let prior = cutoff.pred_opt().ok_or("Invalid split date")?;
    r.pattern_end_date = Some(date_key(prior));
    r.occurrences = None;
    r.no_end_date = false;
    let value = serde_json::to_value(r).map_err(|e| e.to_string())?;
    if occurrence_dates(&value, &date_key(prior))?.is_empty() {
        return Err("Split leaves no earlier occurrence; edit the whole series".into());
    }
    Ok(value)
}
pub(crate) fn normalize_past_rule(old: &Value, cutoff: &str) -> Result<Value, String> {
    split_rule(old, cutoff)
}
fn future_rule(old: &Value, proposed: &Value, cutoff: &str) -> Result<Value, String> {
    normalize_future_rule(old, proposed, cutoff)
}
pub(crate) fn normalize_future_rule(
    old: &Value,
    proposed: &Value,
    cutoff: &str,
) -> Result<Value, String> {
    let old = NativeRule::parse(old)?;
    let mut next = NativeRule::parse(proposed)?;
    let cut = day(cutoff)?;
    if cut <= day(&old.pattern_start_date)? {
        return validate(proposed);
    }
    if next.occurrences.is_some()
        && next.occurrences == old.occurrences
        && next.pattern_end_date == old.pattern_end_date
    {
        let before = occurrence_dates(
            &serde_json::to_value(&old).unwrap(),
            &date_key(cut.pred_opt().ok_or("Invalid split date")?),
        )?
        .len() as i32;
        next.occurrences = next.occurrences.map(|n| n - before);
    }
    if day(&next.pattern_start_date)? < cut {
        next.pattern_start_date = cutoff.into();
    }
    validate(&serde_json::to_value(next).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn baseline_accepts_outlook_computed_end_and_count() {
        let date_rule = json!({"recurrenceType":0,"interval":1,"dayOfWeekMask":0,"dayOfMonth":0,"monthOfYear":0,"instance":0,"patternStartDate":"2027-01-01","patternEndDate":"2027-01-10","occurrences":null,"noEndDate":false});
        let mut read_back = date_rule.clone();
        read_back["occurrences"] = json!(10);
        assert!(same_schedule(&read_back, &date_rule).unwrap());
        read_back["occurrences"] = json!(9);
        assert!(!same_schedule(&read_back, &date_rule).unwrap());
    }
    #[test]
    fn recovery_compares_only_fields_valid_for_pattern_type() {
        let a = json!({"recurrenceType":0,"interval":1,"dayOfWeekMask":2,"dayOfMonth":12,"monthOfYear":10,"instance":1,"patternStartDate":"2027-01-01","patternEndDate":null,"occurrences":null,"noEndDate":true});
        let mut b = a.clone();
        for key in ["dayOfWeekMask", "dayOfMonth", "monthOfYear", "instance"] {
            b[key] = json!(0);
        }
        assert!(same_schedule(&a, &b).unwrap());
    }
    #[test]
    fn truncation_preserves_past_without_count_overriding_end() {
        let old = json!({"recurrenceType":1,"interval":2,"dayOfWeekMask":10,"dayOfMonth":0,"monthOfYear":0,"instance":0,"patternStartDate":"2026-10-05","patternEndDate":"2026-12-30","occurrences":14,"noEndDate":false});
        let past = split_rule(&old, "2026-10-19").unwrap();
        assert_eq!(past["patternEndDate"], "2026-10-18");
        assert_eq!(past["occurrences"], Value::Null);
        assert_eq!(
            occurrence_dates(&past, "2026-12-31").unwrap(),
            ["2026-10-05", "2026-10-07"]
        );
        assert!(split_rule(&old, "2026-10-05").is_err());
    }
    #[test]
    fn unchanged_count_is_reduced_by_occurrences_before_split() {
        let old = json!({"recurrenceType":0,"interval":1,"dayOfWeekMask":0,"dayOfMonth":0,"monthOfYear":0,"instance":0,"patternStartDate":"2027-01-01","patternEndDate":"2027-01-10","occurrences":10,"noEndDate":false});
        let next = future_rule(&old, &old, "2027-01-05").unwrap();
        assert_eq!(next["occurrences"], 6);
        assert_eq!(next["patternStartDate"], "2027-01-05");
    }
}
