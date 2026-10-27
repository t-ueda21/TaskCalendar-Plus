// Real renderer with synthetic API and native bridge. No Tauri, Outlook or user data.
import assert from 'node:assert/strict';
import {openHarness,FIXED_NOW} from './refactor-20261008-harness.mjs';

const h=await openHarness();
const p=h.page;
p.setDefaultTimeout(8000);
const row=(id,startTime,endTime,extra={})=>({id,title:`Synthetic ${id}`,date:'2026-10-08',
  startTime,endTime,tagId:'tag-design',isAllDay:false,recurrence:{type:'none'},memo:'',
  createdAt:FIXED_NOW,updatedAt:FIXED_NOW,...extra});
const original=[
  row('imported','09:00','10:00',{memo:'Outlook body',localMemo:'Previous note',
    outlookOccurrenceKey:'synthetic-external-id',outlookDetails:{location:'Room A'}}),
  row('legacy','10:00','11:00',{memo:'Legacy note'}),
  row('unselected','13:00','14:00',{memo:'Keep this',localMemo:'Unselected note'}),
];
const records=()=>h.state().tasks.toSorted((a,b)=>a.id.localeCompare(b.id));

try {
  for(const mode of ['calendar','tasks']) {
    h.reset();h.setTasks(original);await h.boot();
    if(mode==='calendar') await p.locator('[data-view="calendar"] [data-viewmode]').selectOption('day');
    else await p.locator('nav [data-nav-target="tasks"]').click();
    const view=p.locator(`[data-view="${mode}"]`);
    const item=id=>mode==='tasks'
      ? view.locator(`[data-task-id="${id}"] .taskTitleCell`)
      : view.locator(`.taskBlock[data-task-id="${id}"]:visible`);
    const openBulk=async()=>{
      await item('imported').click();await item('legacy').click({modifiers:['Control']});
      await item('imported').click({button:'right'});
      await p.locator('.taskTagContextMenu [data-bulk-edit]').click();
      const dialog=p.locator('[data-bulk-dialog]');await dialog.waitFor({state:'visible'});
      await dialog.locator('[data-bulk-enable="memo"]').check();return dialog;
    };
    let dialog=await openBulk();await dialog.locator('[data-bulk-memo]').fill('  Updated personal note  ');
    const before=records();h.failNext('POST','/api/tasks/batch',409);
    await dialog.locator('[data-bulk-apply]').click();
    await dialog.locator('[data-bulk-error]').filter({hasText:/\S/}).waitFor();
    assert.deepEqual(records(),before,`${mode}: failed batch must not change any task`);
    const start=h.apiLog.length;await dialog.locator('[data-bulk-apply]').click();await dialog.waitFor({state:'detached'});
    const saved=records();
    for(const id of ['imported','legacy']) {
      const actual=saved.find(task=>task.id===id),prior=original.find(task=>task.id===id);
      assert.equal(actual.memo,prior.memo,`${mode}: original body for ${id} must remain intact`);
      assert.equal(actual.localMemo,'Updated personal note',`${mode}: ${id} saves the new personal note`);
      assert.deepEqual(actual.outlookDetails,prior.outlookDetails);
      assert.equal(actual.outlookOccurrenceKey,prior.outlookOccurrenceKey);
      assert.deepEqual(actual.recurrence,prior.recurrence);
    }
    assert.deepEqual(saved.find(task=>task.id==='unselected'),original.find(task=>task.id==='unselected'));
    const writes=h.apiLog.slice(start).filter(entry=>entry.method==='POST'&&entry.route==='/api/tasks/batch');
    assert.equal(writes.length,1);
    assert.deepEqual(writes[0].body.upserts.map(task=>[task.id,task.memo,task.localMemo]).toSorted(),[
      ['imported','Outlook body','Updated personal note'],['legacy','Legacy note','Updated personal note']]);

    await p.locator('nav [data-nav-target="tasks"]').click();
    const list=p.locator('[data-view="tasks"]'),editor=list.locator('[data-task-dialog]');
    for(const id of ['imported','legacy']) {
      await list.locator(`[data-task-id="${id}"] [data-edit]`).click();
      assert.equal(await editor.locator('[name="memo"]').inputValue(),'Updated personal note');
      await editor.locator('[data-cancel]').click();
    }
    await p.reload();await p.locator('[data-view="calendar"]:not([hidden])').waitFor();
    await p.locator('nav [data-nav-target="tasks"]').click();
    await list.locator('[data-task-id="imported"] [data-edit]').click();
    assert.equal(await editor.locator('[name="memo"]').inputValue(),'Updated personal note',`${mode}: note survives reload`);
    await editor.locator('[data-cancel]').click();
    await list.locator('[data-task-id="imported"] .taskTitleCell').click();
    await list.locator('[data-task-id="legacy"] .taskTitleCell').click({modifiers:['Control']});
    await list.locator('[data-task-id="imported"]').click({button:'right'});
    await p.locator('.taskTagContextMenu [data-bulk-edit]').click();
    dialog=p.locator('[data-bulk-dialog]');
    await dialog.locator('[data-bulk-enable="memo"]').check();
    await dialog.locator('[data-bulk-memo]').fill('');
    await dialog.locator('[data-bulk-apply]').click();await dialog.waitFor({state:'detached'});
    for(const id of ['imported','legacy']) {
      const actual=records().find(task=>task.id===id),prior=original.find(task=>task.id===id);
      assert.equal(actual.memo,prior.memo,`${mode}: clearing does not overwrite ${id}'s body`);
      assert.equal(actual.localMemo,'',`${mode}: ${id}'s personal note is explicitly cleared`);
      await list.locator(`[data-task-id="${id}"] [data-edit]`).click();
      assert.equal(await editor.locator('[name="memo"]').inputValue(),'');
      await editor.locator('[data-cancel]').click();
    }
    console.log(`PASS: ${mode} bulk note, retry, unrelated tasks, body preservation and reopen`);
  }
  assert.deepEqual(h.pageErrors,[]);assert.deepEqual(h.unexpectedRequests,[]);
} finally {await h.close();}
