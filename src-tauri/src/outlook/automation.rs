use super::*;
use windows::Win32::System::Com::{DISPATCH_FLAGS, DISPATCH_METHOD, DISPATCH_PROPERTYGET, DISPATCH_PROPERTYPUT, DISPPARAMS, IDispatch};
use windows::Win32::System::Variant::{VT_DISPATCH, VT_EMPTY, VT_NULL};
use windows::core::{BSTR, GUID, HSTRING, Interface, PCWSTR};

// All outbound calls use HRESULT success/failure semantics, not S_OK equality.
// VARIANT owns its BSTR/interface data throughout Invoke and clears it on exit.
pub(super) fn invoke(item: &w::IDispatch, name: &str, flags: DISPATCH_FLAGS, params: &[AutomationValue]) -> Result<AutomationValue,String> {
    let ptr=item.ptr();
    let dispatch=unsafe {IDispatch::from_raw_borrowed(&ptr)}.expect("non-null Outlook dispatch");
    let wide=HSTRING::from(name);
    let mut id=0;
    unsafe {dispatch.GetIDsOfNames(&GUID::zeroed(),&PCWSTR(wide.as_ptr()),1,w::LCID::USER_DEFAULT.raw(),&mut id)}
        .map_err(|error|format!("Outlook {name} (GetIDsOfNames): {error}"))?;
    let mut arguments:Vec<_>=params.iter().rev().cloned().collect();
    let mut named=-3; // DISPID_PROPERTYPUT
    let put=flags==DISPATCH_PROPERTYPUT;
    let args=DISPPARAMS {rgvarg:arguments.as_mut_ptr(),cArgs:arguments.len() as u32,
        rgdispidNamedArgs:if put {&mut named} else {std::ptr::null_mut()},cNamedArgs:if put {1}else{0}};
    let mut value=AutomationValue::default();
    let mut exception=w::EXCEPINFO::default();
    unsafe {dispatch.Invoke(id,&GUID::zeroed(),w::LCID::USER_DEFAULT.raw(),flags,&args,Some(&mut value),Some((&mut exception as *mut w::EXCEPINFO).cast()),None)}
        .map_err(|error| {
            let detail=if error.code().0==co::HRESULT::DISP_E_EXCEPTION.raw() as i32 {format!("[0x{:08x}] {}",exception.scode as u32,exception)}else{error.to_string()};
            format!("Outlook {name}: {detail}")
        })?;
    Ok(value)
}
pub(super) fn method(item:&w::IDispatch,name:&str,args:&[AutomationValue])->Result<AutomationValue,String>{invoke(item,name,DISPATCH_METHOD,args)}
pub(super) fn get(item:&w::IDispatch,name:&str)->Result<AutomationValue,String>{invoke(item,name,DISPATCH_PROPERTYGET,&[])}
pub(super) fn put(item:&w::IDispatch,name:&str,value:AutomationValue)->Result<(),String>{invoke(item,name,DISPATCH_PROPERTYPUT,&[value]).map(|_|())}

fn dispatch_value(value:AutomationValue,name:&str)->Result<Option<w::IDispatch>,String>{
    // Find/GetFirst/GetNext may return a null dispatch; cloning a null COM pointer
    // would crash. Inspect the tag and Option before transferring an owned AddRef.
    let inner=unsafe {&*value.Anonymous.Anonymous};
    match inner.vt {
        VT_EMPTY|VT_NULL=>Ok(None),
        VT_DISPATCH=>Ok(unsafe {inner.Anonymous.pdispVal.as_ref().map(|item|w::IDispatch::from_ptr(item.clone().into_raw()))}),
        _=>Err(format!("Outlook {name} returned an invalid object value")),
    }
}
pub(super) fn optional_method(item:&w::IDispatch,name:&str,args:&[AutomationValue])->Result<Option<w::IDispatch>,String>{dispatch_value(method(item,name,args)?,name)}
pub(super) fn object_method(item:&w::IDispatch,name:&str,args:&[AutomationValue])->Result<w::IDispatch,String>{optional_method(item,name,args)?.ok_or_else(||format!("Outlook {name} returned no object"))}
pub(super) fn object_get(item:&w::IDispatch,name:&str)->Result<w::IDispatch,String>{dispatch_value(get(item,name)?,name)?.ok_or_else(||format!("Outlook {name} returned no object"))}
pub(super) fn text(item:&w::IDispatch,name:&str)->Result<String,String>{
    let value=get(item,name)?;
    let text=BSTR::try_from(&value).map_err(|error|format!("Outlook {name} returned invalid text: {error}"))?.to_string();
    if text.is_empty(){Err(format!("Outlook {name} returned empty text"))}else{Ok(text)}
}
pub(super) fn integer(item:&w::IDispatch,name:&str)->Result<i32,String>{i32::try_from(&get(item,name)?).map_err(|error|format!("Outlook {name} returned an invalid number: {error}"))}
