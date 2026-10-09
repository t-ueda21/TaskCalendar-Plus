//! Exercise the real COM boundary without requiring an Outlook profile.
use super::*;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::ffi::c_void;
use std::sync::atomic::{AtomicU32, Ordering};
use windows::Win32::System::Com::{DISPATCH_FLAGS, DISPPARAMS, EXCEPINFO, IDispatch_Vtbl};
use windows::Win32::System::Variant::{VARENUM, VARIANT, VT_BSTR, VT_DISPATCH, VT_EMPTY, VT_I4, VT_NULL};
use windows::core::{GUID, HRESULT, IUnknown_Vtbl, Interface, PCWSTR};

struct Reply {
    status: HRESULT,
    kind: VARENUM,
    item: bool,
}

#[repr(C)]
struct Items {
    vtable: &'static IDispatch_Vtbl,
    refs: AtomicU32,
    replies: RefCell<VecDeque<Reply>>,
}

unsafe extern "system" fn query(
    this: *mut c_void,
    iid: *const GUID,
    out: *mut *mut c_void,
) -> HRESULT {
    unsafe {
        *out = std::ptr::null_mut();
        if *iid == windows::core::IUnknown::IID
            || *iid == windows::Win32::System::Com::IDispatch::IID
        {
            *out = this;
            add_ref(this);
            HRESULT(0)
        } else {
            HRESULT(0x80004002u32 as i32)
        }
    }
}

unsafe extern "system" fn add_ref(this: *mut c_void) -> u32 {
    unsafe { (*this.cast::<Items>()).refs.fetch_add(1, Ordering::Relaxed) + 1 }
}

unsafe extern "system" fn release(this: *mut c_void) -> u32 {
    unsafe {
        let remaining = (*this.cast::<Items>()).refs.fetch_sub(1, Ordering::Relaxed) - 1;
        if remaining == 0 {
            drop(Box::from_raw(this.cast::<Items>()));
        }
        remaining
    }
}

unsafe extern "system" fn type_count(_: *mut c_void, out: *mut u32) -> HRESULT {
    unsafe {
        *out = 0;
    }
    HRESULT(0)
}

unsafe extern "system" fn type_info(
    _: *mut c_void,
    _: u32,
    _: u32,
    _: *mut *mut c_void,
) -> HRESULT {
    HRESULT(0x80004001u32 as i32)
}

unsafe extern "system" fn names(
    _: *mut c_void,
    _: *const GUID,
    names: *const PCWSTR,
    count: u32,
    _: u32,
    out: *mut i32,
) -> HRESULT {
    unsafe {
        if count != 1 {
            return HRESULT(0x80070057u32 as i32);
        }
        *out = match (*names).to_string().unwrap().as_str() {
            "GetFirst" => 1,
            "GetNext" => 2,
            "UserProperties" => 3,
            "Find" => 4,
            "Value" => 5,
            "Body" => 6,
            _ => return HRESULT(0x80020006u32 as i32),
        };
    }
    HRESULT(0)
}

unsafe extern "system" fn invoke(
    this: *mut c_void,
    id: i32,
    _: *const GUID,
    _: u32,
    flags: DISPATCH_FLAGS,
    params: *const DISPPARAMS,
    out: *mut VARIANT,
    exception: *mut EXCEPINFO,
    _: *mut u32,
) -> HRESULT {
    unsafe {
        let valid = match id {
            1 | 2 => flags.0 == 1 && (*params).cArgs == 0,
            3 => flags.0 == 2 && (*params).cArgs == 0,
            4 => {
                let args = std::slice::from_raw_parts((*params).rgvarg, (*params).cArgs as usize);
                flags.0 == 1 && (args.len() == 1 || args.len() == 2)
                    && windows::core::BSTR::try_from(&args[args.len()-1]).is_ok_and(|s| s == TASK_KEY_PROPERTY)
                    && (args.len() == 1 || bool::try_from(&args[0]) == Ok(true))
            },
            5 => flags.0 == 2 && (*params).cArgs == 0,
            6 => flags.0 == 4 && (*params).cArgs == 1
                && (*params).cNamedArgs == 1 && *(*params).rgdispidNamedArgs == -3
                && windows::core::BSTR::try_from(&*(*params).rgvarg).is_ok_and(|s| s.is_empty()),
            _ => false,
        };
        if !valid {
            return HRESULT(0x80070057u32 as i32);
        }
        let reply = (*this.cast::<Items>())
            .replies
            .borrow_mut()
            .pop_front()
            .unwrap();
        (*(*out).Anonymous.Anonymous).vt = reply.kind;
        if reply.kind == VT_BSTR {
            (*(*out).Anonymous.Anonymous).Anonymous.bstrVal =
                std::mem::ManuallyDrop::new(windows::core::BSTR::from("namespace:task-1"));
        }
        if reply.item {
            add_ref(this);
            (*(*out).Anonymous.Anonymous).Anonymous.pdispVal = std::mem::ManuallyDrop::new(Some(
                windows::Win32::System::Com::IDispatch::from_raw(this),
            ));
        }
        if reply.status.0 == 0x80020009u32 as i32 {
            (*exception).bstrDescription =
                std::mem::ManuallyDrop::new(windows::core::BSTR::from("calendar unavailable"));
        }
        reply.status
    }
}

static VTABLE: IDispatch_Vtbl = IDispatch_Vtbl {
    base__: IUnknown_Vtbl {
        QueryInterface: query,
        AddRef: add_ref,
        Release: release,
    },
    GetTypeInfoCount: type_count,
    GetTypeInfo: type_info,
    GetIDsOfNames: names,
    Invoke: invoke,
};

fn items(replies: Vec<Reply>) -> w::IDispatch {
    let raw = Box::into_raw(Box::new(Items {
        vtable: &VTABLE,
        refs: AtomicU32::new(1),
        replies: RefCell::new(replies.into()),
    }));
    unsafe { w::IDispatch::from_ptr(raw.cast()) }
}

#[test]
fn success_statuses_accept_empty_null_and_nothing_as_end() {
    for status in [0, 1] {
        for kind in [VT_EMPTY, VT_NULL, VT_DISPATCH] {
            for method in ["GetFirst", "GetNext"] {
                let source = items(vec![Reply {
                    status: HRESULT(status),
                    kind,
                    item: false,
                }]);
                let result = next_outlook_item(&source, method);
                assert!(
                    matches!(result, Ok(None)),
                    "status={status}, kind={kind:?}, {method}: {:?}",
                    result.err()
                );
            }
        }
    }
}

#[test]
fn s_false_does_not_discard_a_returned_item_or_abort_a_complete_collection() {
    for status in [0, 1] {
        let source = items(vec![
            Reply {
                status: HRESULT(status),
                kind: VT_DISPATCH,
                item: true,
            },
            Reply {
                status: HRESULT(1),
                kind: VT_DISPATCH,
                item: false,
            },
        ]);
        let mut first = true;
        let result = collect_bounded(5, || {
            let method = if first { "GetFirst" } else { "GetNext" };
            first = false;
            next_outlook_item(&source, method)
        });
        assert_eq!(result.expect("complete snapshot").len(), 1);
    }
}

#[test]
fn real_failures_abort_instead_of_returning_a_partial_snapshot() {
    for status in [0x80004005u32, 0x80070001, 0x80020009] {
        let source = items(vec![
            Reply {
                status: HRESULT(0),
                kind: VT_DISPATCH,
                item: true,
            },
            Reply {
                status: HRESULT(status as i32),
                kind: VT_EMPTY,
                item: false,
            },
        ]);
        let mut first = true;
        let result = collect_bounded(5, || {
            let method = if first { "GetFirst" } else { "GetNext" };
            first = false;
            next_outlook_item(&source, method)
        });
        let error = result.err().expect("partial snapshot must fail");
        assert!(error.contains("GetNext"));
        if status == 0x80020009 {
            assert!(error.contains("calendar unavailable"));
        }
    }
}

#[test]
fn success_with_a_non_object_value_is_not_a_complete_snapshot() {
    for status in [0, 1] {
        let source = items(vec![Reply {
            status: HRESULT(status),
            kind: VT_I4,
            item: false,
        }]);
        assert!(next_outlook_item(&source, "GetNext").is_err());
    }
}

#[test]
fn ordinary_outlook_appointment_without_app_property_is_not_a_crash() {
    // This test owns only a fake COM object, with no Outlook activation or profile.
    // Suppress OS error dialogs in the isolated test process for a crashing regression.
    #[link(name = "kernel32")]
    unsafe extern "system" { fn SetErrorMode(mode: u32) -> u32; }
    let previous = unsafe { SetErrorMode(0x0001 | 0x0002) };
    for status in [0,1] {
        for kind in [VT_EMPTY,VT_NULL,VT_DISPATCH] {
            let source = items(vec![
                Reply { status: HRESULT(0), kind: VT_DISPATCH, item: true },
                Reply { status: HRESULT(status), kind, item: false },
            ]);
            assert_eq!(task_property(&source).expect("missing property is a normal appointment"),None);
        }
    }
    unsafe { SetErrorMode(previous); }
}

#[test]
fn custom_property_found_value_and_reference_ownership_are_preserved() {
    let source = items(vec![
        Reply { status: HRESULT(0), kind: VT_DISPATCH, item: true },
        Reply { status: HRESULT(1), kind: VT_DISPATCH, item: true },
        Reply { status: HRESULT(0), kind: VT_BSTR, item: false },
    ]);
    assert_eq!(task_property(&source).unwrap().as_deref(),Some("namespace:task-1"));
    assert_eq!(unsafe { &*source.ptr().cast::<Items>() }.refs.load(Ordering::Relaxed),1);
}

#[test]
fn folder_definition_find_accepts_absence_and_retains_failures() {
    for status in [0,1] {
        for kind in [VT_EMPTY,VT_NULL,VT_DISPATCH] {
            let source=items(vec![Reply {status:HRESULT(status),kind,item:false}]);
            assert!(invoke_optional_dispatch(&source,"Find",&[AutomationValue::from(TASK_KEY_PROPERTY)]).unwrap().is_none());
        }
    }
    for (status,kind) in [(0,VT_I4),(0x80020009u32 as i32,VT_EMPTY)] {
        let source=items(vec![Reply {status:HRESULT(status),kind,item:false}]);
        let error=invoke_optional_dispatch(&source,"Find",&[AutomationValue::from(TASK_KEY_PROPERTY)]).err().unwrap();
        assert!(error.contains("Find"));
        if status!=0 {assert!(error.contains("calendar unavailable"));}
    }
}

#[test]
fn automation_result_structures_share_the_same_abi() {
    assert_eq!(std::mem::size_of::<w::VARIANT>(),std::mem::size_of::<VARIANT>());
    assert_eq!(std::mem::align_of::<w::VARIANT>(),std::mem::align_of::<VARIANT>());
    assert_eq!(std::mem::size_of::<w::EXCEPINFO>(),std::mem::size_of::<EXCEPINFO>());
    assert_eq!(std::mem::align_of::<w::EXCEPINFO>(),std::mem::align_of::<EXCEPINFO>());
}

#[test]
fn empty_memo_can_clear_outlook_body_without_out_of_memory() {
    let source = items(vec![Reply { status: HRESULT(0), kind: VT_EMPTY, item: false }]);
    put_outlook_text(&source, "Body", "").expect("empty memo is valid");
}
