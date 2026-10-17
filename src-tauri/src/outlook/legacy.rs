//! Read-only reconciliation of pre-link imports, independent of the new-event range.
use super::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    pub key: String,
    pub date: String,
    pub title: String,
    pub series_id: String,
    pub calendar: Option<String>,
    pub updated_at: String,
}

pub fn targets(conn: &Connection) -> rusqlite::Result<Vec<Target>> {
    conn.prepare("SELECT id,outlook_occurrence_key,date,title,COALESCE(outlook_series_id,''),NULLIF(outlook_calendar_ref,''),updated_at FROM tasks
      WHERE outlook_occurrence_key IS NOT NULL AND outlook_occurrence_key<>'' AND outlook_enabled=0
      AND NOT EXISTS(SELECT 1 FROM outlook_links WHERE task_id=tasks.id)
      AND NOT EXISTS(SELECT 1 FROM outlook_jobs WHERE task_id=tasks.id AND status<>'done') ORDER BY date,id")?
        .query_map([], |r| Ok(Target { id:r.get(0)?,key:r.get(1)?,date:r.get(2)?,title:r.get(3)?,series_id:r.get(4)?,calendar:r.get(5)?,updated_at:r.get(6)? }))?.collect()
}

pub fn candidates(conn: &Connection) -> rusqlite::Result<Vec<Value>> {
    Ok(targets(conn)?
        .into_iter()
        .filter(|t| t.calendar.is_none())
        .map(|t| json!({"id":t.id,"title":t.title,"date":t.date,"updatedAt":t.updated_at}))
        .collect())
}

pub(super) fn protected_keys(
    conn: &Connection,
    calendar: &str,
) -> rusqlite::Result<std::collections::HashSet<String>> {
    let mut protected = std::collections::HashSet::new();
    let mut query=conn.prepare("SELECT outlook_occurrence_key,outlook_calendar_ref,outlook_enabled,EXISTS(SELECT 1 FROM outlook_jobs WHERE task_id=tasks.id AND status<>'done') FROM tasks WHERE outlook_occurrence_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM outlook_links WHERE task_id=tasks.id)")?;
    for row in query.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, bool>(2)?,
            r.get::<_, bool>(3)?,
        ))
    })? {
        let (key, source, outgoing, pending) = row?;
        if outgoing
            || pending
            || !source
                .as_deref()
                .is_some_and(|s| same_calendar(s, calendar))
        {
            protected.insert(key);
        }
    }
    Ok(protected)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub id: String,
    pub updated_at: String,
}

pub fn confirm_source(
    conn: &Connection,
    calendar: &str,
    selected: &[Selection],
) -> rusqlite::Result<usize> {
    if !calendars::is_stable_reference(calendar) || selected.is_empty() || selected.len() > 5000 {
        return Err(rusqlite::Error::InvalidParameterName(
            "予定表と対象の旧予定を選択してください".into(),
        ));
    }
    let tx = conn.unchecked_transaction()?;
    let current: std::collections::HashMap<_, _> = targets(&tx)?
        .into_iter()
        .map(|t| (t.id.clone(), t))
        .collect();
    let mut seen = std::collections::HashSet::new();
    for selection in selected {
        let target = current
            .get(&selection.id)
            .filter(|t| t.calendar.is_none() && t.updated_at == selection.updated_at)
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        if !seen.insert(&selection.id) {
            return Err(rusqlite::Error::InvalidParameterName(
                "同じ予定が重複しています".into(),
            ));
        }
        tx.execute(
            "UPDATE tasks SET outlook_calendar_ref=?2,updated_at=?3 WHERE id=?1",
            params![
                target.id,
                calendar,
                crate::repositories::next_revision(Some(&target.updated_at))
            ],
        )?;
    }
    tx.commit()?;
    Ok(selected.len())
}

// Outlook used to fall back to EntryID when GlobalAppointmentID was unavailable.
// An EntryID can change after moving/restoring an item; never use its absence to delete.
// MS-OXOCAL 2.2.1.27: normalize the exception-date bytes to the series identity.
// https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxocal/1d3aac05-a7b9-45cc-a213-47f0a0a2c5c1
pub(super) fn stable_series_id(value: &str) -> Option<String> {
    if value.len() < 80
        || !value.len().is_multiple_of(2)
        || !value.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return None;
    }
    let mut bytes = (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).ok())
        .collect::<Option<Vec<_>>>()?;
    if bytes[..16]
        != [
            4, 0, 0, 0, 130, 0, 224, 0, 116, 197, 183, 16, 26, 130, 224, 8,
        ]
    {
        return None;
    }
    if u32::from_le_bytes(bytes[36..40].try_into().ok()?) as usize != bytes.len() - 40 {
        return None;
    }
    bytes[16..20].fill(0);
    Some(bytes.iter().map(|b| format!("{b:02X}")).collect())
}

fn original_start(target: &Target) -> Result<chrono::NaiveDateTime, String> {
    let stamp = target
        .key
        .strip_prefix(&format!("{}|", target.series_id))
        .ok_or("旧予定の元の日時を確認できません")?;
    chrono::NaiveDateTime::parse_from_str(stamp, "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(stamp, "%Y-%m-%dT%H:%M"))
        .or_else(|_| {
            chrono::NaiveDate::parse_from_str(stamp, "%Y-%m-%d")
                .map(|d| d.and_time(chrono::NaiveTime::MIN))
        })
        .map_err(|_| "旧予定の元の日時を確認できません".into())
}

pub(super) fn inspect_with(
    snapshot: &mut OutlookSnapshot,
    targets: &[Target],
    mut removed: impl FnMut(&Target) -> Result<bool, String>,
) {
    for target in targets {
        if !target
            .calendar
            .as_deref()
            .is_some_and(|c| same_calendar(c, &snapshot.calendar_ref))
        {
            continue;
        }
        if snapshot
            .events
            .iter()
            .any(|e| e.outlook_occurrence_key == target.key)
        {
            continue;
        }
        if snapshot.cancelled.iter().any(|e| {
            e.outlook_occurrence_key == target.key
                && (!e.is_recurring || recurring_removed(target, e, false).is_ok())
        }) {
            continue;
        }
        match removed(target) {
            Ok(true) => snapshot.legacy_removed.push(target.clone()),
            Ok(false) => {}
            Err(error) => snapshot.warnings.push(format!(
                "旧予定「{}」の確認を保留しました: {error}",
                target.title
            )),
        }
    }
}

pub(super) fn inspect(snapshot: &mut OutlookSnapshot, targets: &[Target]) {
    // Construct the connection lazily; an unknown or different source is not queried.
    let mut namespace = None;
    let mut cache = identity_lookup::LookupCache::default();
    inspect_with(snapshot, targets, |target| {
        let uid = stable_series_id(&target.series_id)
            .ok_or("旧予定の安定した識別情報がありません。Outlookで確認してください")?;
        let ns = namespace.get_or_insert_with(|| {
            connect_outlook().and_then(|app| {
                automation::object_method(&app, "GetNamespace", &[AutomationValue::from("MAPI")])
            })
        });
        let ns = ns.as_ref().map_err(Clone::clone)?;
        let source = target
            .calendar
            .as_deref()
            .ok_or("旧予定の連携元が未確認です")?;
        let folder = cache.folder(ns, source)?;
        if !same_calendar(&calendars::identify(&folder)?, source) {
            return Err("旧予定の連携元を一意に確認できません".into());
        }
        let Some(master) = cache.legacy_imported(&folder, &uid)? else {
            return Ok(true);
        };
        if !meeting_active(&master)? {
            return Ok(true);
        }
        let recurring =
            bool::try_from(&automation::get(&master, "IsRecurring")?).map_err(|e| e.to_string())?;
        if !recurring {
            return Ok(false);
        }
        let original = original_start(target)?;
        let pattern = automation::object_method(&master, "GetRecurrencePattern", &[])?;
        // Old keys contain observed Start, not necessarily OriginalDate. A moved
        // exception can therefore miss this lookup while still being active.
        let item = automation::optional_method(
            &pattern,
            "GetOccurrence",
            &[outlook_date(
                &date_key(original.date()),
                &time_key(original),
            )?],
        )?
        .ok_or("旧版の繰り返し予定の個別回を確認できません。Outlookで確認してください")?;
        let (event, active) = read_item(&item, None, Some(&folder))?;
        recurring_removed(target, &event, active)
    });
}

pub(super) fn recurring_removed(
    target: &Target,
    event: &OutlookEvent,
    active: bool,
) -> Result<bool, String> {
    if event.outlook_occurrence_key != target.key
        || event
            .remote
            .as_ref()
            .is_none_or(|m| m.occurrence_start.is_none() || m.read_only.is_some())
    {
        return Err("旧版の繰り返し予定の元の日時を確認できません。予定を保持しました".into());
    }
    Ok(!active)
}

pub(super) fn apply_removed(
    conn: &Connection,
    removed: &[Target],
    calendar: &str,
) -> rusqlite::Result<usize> {
    let current: std::collections::HashMap<_, _> = targets(conn)?
        .into_iter()
        .map(|t| (t.id.clone(), t))
        .collect();
    let mut deleted = 0;
    for target in removed {
        if !target
            .calendar
            .as_deref()
            .is_some_and(|source| same_calendar(source, calendar))
        {
            continue;
        }
        if current.get(&target.id).is_some_and(|now| {
            now.key == target.key
                && now.updated_at == target.updated_at
                && now
                    .calendar
                    .as_deref()
                    .zip(target.calendar.as_deref())
                    .is_some_and(|(a, b)| same_calendar(a, b))
        }) {
            deleted += conn.execute("DELETE FROM tasks WHERE id=?1", [&target.id])?;
        }
    }
    Ok(deleted)
}
