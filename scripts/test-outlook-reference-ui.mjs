import {memoPatch} from '../src-tauri/renderer/src/task-notes.js';
import assert from 'node:assert/strict';
import {openHarness} from './refactor-20261008-harness.mjs';
assert.deepEqual(memoPatch(undefined,'New personal note'),{localMemo:'New personal note',memo:''});
const h=await openHarness();
try {
 await h.boot();
 await h.page.evaluate(async()=>{const U=await import('/src/ui-utils.js'),S=await import('/src/store.js');U.openEditDialog(document.querySelector('[data-view="calendar"] [data-task-dialog]'),{id:'imported',date:'2026-10-20',endDate:'2026-10-20',title:'Meeting',startTime:'09:00',endTime:'10:00',memo:'Outlook body / Teams info',outlookOccurrenceKey:'external-key',recurrence:{type:'native',native:{recurrenceType:1,interval:1,dayOfWeekMask:4,dayOfMonth:0,monthOfYear:0,instance:0,patternStartDate:'2026-10-20',patternEndDate:'2026-11-20',noEndDate:false}},outlookDetails:{location:'Room A'}},S.getAllTags());});
 const d=h.page.locator('[data-view="calendar"] [data-task-dialog]');
 assert.equal(await d.locator('[name=memo]').inputValue(),'','Outlook body must not populate personal notes');
 assert.equal(await d.locator('[data-event-location]').innerText(),'Room A');
 assert.equal(await d.locator('[data-native-recurrence]').count(),0,'unrequested advanced controls removed');
 assert.equal(await d.locator('[data-event-description], [data-event-body], details').count(),0,'no unrequested disclosure or Outlook body area');
 assert.ok(!(await d.innerText()).includes('Outlook body / Teams info'),'raw Outlook body is not shown in the editor');
 await d.locator('[name=memo]').fill('My private note');
 const form=await d.evaluate(async d=>(await import('/src/ui-utils.js')).readDialogForm(d));
 assert.equal(form.memo,'Outlook body / Teams info');assert.equal(form.localMemo,'My private note');assert.equal(form.recurrence.native.recurrenceType,1);
 console.log('PASS: personal memo separate, room readable, advanced panel absent, imported body and recurrence retained');
}finally{await h.close();}
