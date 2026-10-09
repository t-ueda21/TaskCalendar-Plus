    use super::*;
    #[test]
    #[ignore = "requires Classic Outlook; creates and discards an unsaved appointment without Save or Send"]
    fn live_unsaved_outbound_properties() {
        let _com=w::CoInitializeEx(co::COINIT::APARTMENTTHREADED).unwrap();
        macro_rules! step { ($name:expr,$call:expr) => {{eprintln!("START {}",$name);let value=$call.map_err(|e|format!("{}: {e}",$name)).unwrap();eprintln!("PASS {}",$name);value}}; }
        let outlook=connect_outlook().unwrap();
        let namespace=step!("GetNamespace",outlook.invoke_method("GetNamespace",&[&w::Variant::from_str("MAPI")])).unwrap_dispatch_opt().unwrap();
        let folder=step!("DefaultCalendar",default_calendar_folder(&namespace));
        let items=step!("Items",folder.invoke_get("Items",&[])).unwrap_dispatch_opt().unwrap();
        step!("StoreID",folder.invoke_get("StoreID",&[]));
        let definitions=step!("UserDefinedProperties",folder.invoke_get("UserDefinedProperties",&[])).unwrap_dispatch_opt().unwrap();
        let found=step!("FindDefinition",invoke_optional_dispatch(&definitions,"Find",&[AutomationValue::from(TASK_KEY_PROPERTY)]));
        eprintln!("Definition exists: {}",found.is_some());
        if found.is_some() {
            let filter=format!("[{TASK_KEY_PROPERTY}] = 'diagnostic-read-only-key'");
            let matching=step!("Restrict",items.invoke_method("Restrict",&[&w::Variant::from_str(&filter)])).unwrap_dispatch_opt().unwrap();
            step!("Count",matching.invoke_get("Count",&[]));
        }
        // Unsaved diagnostic item: never call Save/Send, always discard it.
        let item=step!("Items.Add",items.invoke_method("Add",&[&w::Variant::I4(1)])).unwrap_dispatch_opt().unwrap();
        let result=(|| -> Result<(),String> {
            put_outlook_text(&item,"Subject","TaskCalendar unsaved diagnostic")?;
            put_outlook_text(&item,"Body","")?;
            for (name,value) in [("Start",outlook_date("2026-10-09","12:00")?),("End",outlook_date("2026-10-09","12:30")?),("AllDayEvent",AutomationValue::from(false))] {
                eprintln!("START {name}");
                automation::put(&item,name,value).map_err(|e|format!("{name}: {e}"))?;
                eprintln!("PASS {name}");
            }
            let props=item.invoke_get("UserProperties",&[]).map_err(|e|format!("UserProperties: {e}"))?.unwrap_dispatch_opt().unwrap();
            eprintln!("START UserProperties.Add");
            let property=automation::object_method(&props,"Add",&[AutomationValue::from(TASK_KEY_PROPERTY),AutomationValue::from(1_i32),AutomationValue::from(true)])?;
            put_outlook_text(&property,"Value","diagnostic-unsaved")?;
            Ok(())
        })();
        let _=item.invoke_method("Close",&[&w::Variant::I4(1)]);
        result.expect("unsaved write boundary");
    }