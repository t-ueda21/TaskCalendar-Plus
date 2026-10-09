import assert from 'node:assert/strict';
globalThis.document = { addEventListener() {} };
const { openCreateDialog, openEditDialog, readDialogForm } = await import('../src-tauri/renderer/src/ui-utils.js');
function dialog(defaultValue) {
  const fields = Object.fromEntries(['title','startTime','endTime','allDay','memo','outlookEnabled','date','repeat'].map(name => [name, {value:'',checked:false,disabled:false,focus(){}}]));
  return { dataset:{outlookDefault:String(defaultValue)}, fields,
    querySelector(selector) { const name=selector.match(/^\[name=['"](\w+)['"]\]$/)?.[1]; return fields[name] ?? null; },
    setAttribute(){},removeAttribute(){},showModal(){} };
}
for(const initial of [true,false]) {
  const d=dialog(initial);
  openCreateDialog(d,{date:'2026-10-09'});
  assert.equal(d.fields.outlookEnabled.checked,initial);
  d.fields.outlookEnabled.checked=!initial;
  assert.equal(readDialogForm(d).outlookEnabled,!initial);
  openCreateDialog(d,{outlookEnabled:!initial});
  assert.equal(d.fields.outlookEnabled.checked,!initial);
  for(const saved of [true,false]) {
    openEditDialog(d,{id:'existing',date:'2026-10-09',outlookEnabled:saved},[]);
    assert.equal(d.fields.outlookEnabled.checked,saved,'existing choice overrides default');
    assert.equal(d.fields.outlookEnabled.disabled,false,'existing tasks must allow changing registration');
    d.fields.outlookEnabled.checked=!saved;
    assert.equal(readDialogForm(d).outlookEnabled,!saved);
  }
}
console.log('PASS: Outlook defaults, explicit choices, and editable saved selection');
