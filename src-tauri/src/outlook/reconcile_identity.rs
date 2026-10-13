//! One bounded, unexpanded identity catalog per calendar and observation.
use super::*;
use std::collections::HashMap;

struct UidIndex<T: Clone> {
    calendars: HashMap<String, Result<HashMap<String, Vec<T>>, String>>,
}
impl<T: Clone> Default for UidIndex<T> {
    fn default() -> Self {
        Self {
            calendars: HashMap::new(),
        }
    }
}
impl<T: Clone> UidIndex<T> {
    fn lookup(
        &mut self,
        calendar: &str,
        uid: &str,
        build: impl FnOnce() -> Result<HashMap<String, Vec<T>>, String>,
    ) -> Result<Option<T>, String> {
        let entries = self
            .calendars
            .entry(calendar.into())
            .or_insert_with(build)
            .as_ref()
            .map_err(Clone::clone)?;
        match entries.get(uid).map(Vec::as_slice).unwrap_or_default() {
            [] => Ok(None),
            [only] => Ok(Some(only.clone())),
            _ => Err("同じGlobalAppointmentIDのOutlook予定が複数あるため反映を保留しました".into()),
        }
    }
}

#[derive(Default)]
pub(super) struct LookupCache {
    folders: HashMap<String, Result<w::IDispatch, String>>,
    identities: UidIndex<w::IDispatch>,
}
impl LookupCache {
    pub(super) fn folder(
        &mut self,
        namespace: &w::IDispatch,
        calendar: &str,
    ) -> Result<w::IDispatch, String> {
        self.folders
            .entry(calendar.into())
            .or_insert_with(|| {
                if let Some(folder) = calendars::resolve(namespace, calendar)? {
                    Ok(folder)
                } else {
                    find_calendar_folder(namespace, calendar)
                }
            })
            .clone()
    }
    pub(super) fn imported(
        &mut self,
        folder: &w::IDispatch,
        uid: &str,
    ) -> Result<Option<w::IDispatch>, String> {
        if uid.trim().is_empty() {
            return Err("Outlookの予定識別情報が空のため復元を確認できません".into());
        }
        let calendar = format!(
            "{}|{}",
            automation::text(folder, "StoreID")?,
            automation::text(folder, "EntryID")?
        );
        self.identities
            .lookup(&calendar, uid, || master_catalog(folder))
    }
}
fn master_catalog(folder: &w::IDispatch) -> Result<HashMap<String, Vec<w::IDispatch>>, String> {
    let items = automation::object_get(folder, "Items")?;
    // IncludeRecurrences=false prevents an unbounded recurring master from
    // expanding into an infinite catalog. Never Restrict this lookup by date.
    automation::put(&items, "IncludeRecurrences", AutomationValue::from(false))?;
    let count = automation::integer(&items, "Count")?;
    if !(0..=SAFETY_MAX_ITEMS).contains(&count) {
        return Err(format!(
            "Outlookの識別情報照合が安全上限({SAFETY_MAX_ITEMS})を超えています"
        ));
    }
    let mut entries: HashMap<String, Vec<w::IDispatch>> = HashMap::new();
    let mut item = automation::optional_method(&items, "GetFirst", &[])?;
    let mut seen = 0;
    while let Some(candidate) = item {
        seen += 1;
        if seen > SAFETY_MAX_ITEMS {
            return Err("Outlookの識別情報照合中に予定件数が安全上限を超えました".into());
        }
        if automation::integer(&candidate, "Class")? == OL_APPOINTMENT_CLASS {
            if ![0, 1].contains(&automation::integer(&candidate, "RecurrenceState")?) {
                return Err(
                    "Outlookの未展開予定一覧に個別回が含まれているため反映を保留しました".into(),
                );
            }
            let uid = automation::text(&candidate, "GlobalAppointmentID")?;
            entries.entry(uid).or_default().push(candidate);
        }
        item = automation::optional_method(&items, "GetNext", &[])?;
    }
    if seen != count {
        return Err("Outlookの予定一覧が照合中に変化したため反映を保留しました".into());
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unique_global_identity_recovers_without_subject_or_date_matching() {
        let mut index = UidIndex::default();
        assert_eq!(
            index
                .lookup("calendar-a", "uid-1", || Ok(HashMap::from([(
                    "uid-1".into(),
                    vec!["restored-entry"]
                )])))
                .unwrap(),
            Some("restored-entry")
        );
        assert_eq!(
            index
                .lookup("calendar-a", "uid-1", || panic!(
                    "must reuse unexpanded calendar catalog"
                ))
                .unwrap(),
            Some("restored-entry")
        );
        assert_eq!(
            index
                .lookup("calendar-a", "absent", || panic!(
                    "missing identities must reuse catalog"
                ))
                .unwrap(),
            None
        );
    }
    #[test]
    fn duplicate_identity_and_catalog_failures_are_unknown_not_removed() {
        let mut index = UidIndex::default();
        assert!(
            index
                .lookup("a", "same", || Ok(HashMap::from([(
                    "same".into(),
                    vec![1, 2]
                )])))
                .is_err()
        );
        assert!(
            index
                .lookup("broken", "uid", || Err("provider unavailable".into()))
                .is_err()
        );
        assert_eq!(
            index
                .lookup("broken", "other", || panic!("failure must be cached"))
                .unwrap_err(),
            "provider unavailable"
        );
        assert_eq!(
            index
                .lookup("b", "same", || Ok(HashMap::from([(
                    "same".into(),
                    vec![3]
                )])))
                .unwrap(),
            Some(3)
        );
    }
}
