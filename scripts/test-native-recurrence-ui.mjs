import assert from 'node:assert/strict';
import {openHarness} from './refactor-20261008-harness.mjs';
const h=await openHarness();
const rule={recurrenceType:1,interval:1,dayOfWeekMask:10,dayOfMonth:0,monthOfYear:0,instance:0,patternStartDate:'2026-10-05',patternEndDate:null,occurrences:3,noEndDate:false};
const task={...h.state().tasks[0],id:'native-import',title:'Imported weekly',date:'2026-10-05',endDate:'2026-10-05',startTime:'09:00',endTime:'10:00',isAllDay:false,memo:'Outlook description',localMemo:null,outlookEnabled:false,outlookOccurrenceKey:'uid|2026-10-05',outlookDetails:{location:'Room B'},recurrence:{type:'native',native:rule,groupId:'g',originDate:'2026-10-05',occurrenceDate:'2026-10-05'}};
h.setTasks([task]);
try {
 await h.boot();
 const calendar=h.page.locator('[data-view="calendar"]'),d=calendar.locator('[data-task-dialog]');
 const open=()=>h.page.evaluate(async()=>{const S=await import('/src/store.js'),U=await import('/src/ui-utils.js');U.openEditDialog(document.querySelector('[data-view="calendar"] [data-task-dialog]'),S.getAllTasks()[0],S.getAllTags());});
 await open();
 assert.equal(await d.locator('[data-native-recurrence],select[name=nativeType]').count(),0);
 assert.equal(await d.locator('[data-editor-native-rule]').isVisible(),true);
 assert.equal(await d.locator('[data-btn-group=repeat]').isVisible(),false);
 assert.equal(await d.locator('[name=memo]').inputValue(),'');
 await d.locator('[name=memo]').fill('Personal note');await d.locator('[data-save]').click();
 const noteScope=h.page.locator('[data-save-scope]');await noteScope.waitFor();await noteScope.locator('[value=single]').check();await noteScope.locator('[data-scope-confirm]').click();await d.waitFor({state:'hidden'});
 assert.equal(await h.page.locator('[data-save-scope]').count(),0,'selection closes after personal note save');
 let saved=h.state().tasks[0];assert.equal(saved.memo,task.memo);assert.equal(saved.localMemo,'Personal note');assert.deepEqual(saved.recurrence,task.recurrence);
 await open();assert.equal(await d.locator('[name=memo]').inputValue(),'Personal note');
 await d.locator('[name=title]').fill('Retitled');await d.locator('[data-save]').click();
 const scope=h.page.locator('[data-save-scope]');await scope.waitFor();await scope.locator('[value=single]').check();await scope.locator('[data-scope-confirm]').click();await d.waitFor({state:'hidden'});
 saved=h.state().tasks[0];assert.equal(saved.title,'Retitled');assert.deepEqual(saved.recurrence,task.recurrence);assert.equal(saved.memo,task.memo);assert.equal(saved.localMemo,'Personal note');
 assert.deepEqual(h.pageErrors,[]);
 console.log('PASS: imported recurrence read-only, no advanced panel, personal memo persists without replacing Outlook body/rule');
}finally{await h.close();}
