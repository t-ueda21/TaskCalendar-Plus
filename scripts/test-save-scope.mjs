import assert from 'node:assert/strict';
import {openHarness} from './refactor-20261008-harness.mjs';
const h=await openHarness();
try{
 await h.boot();
 for(const view of ['calendar','tasks']){
  await h.page.locator(`nav [data-nav-target="${view}"]`).click();
  await h.page.evaluate(async view=>{const S=await import('/src/store.js'),U=await import('/src/ui-utils.js');const t=await S.createTask({title:'Scope test '+view,date:'2026-10-08',startTime:'09:00',endTime:'10:00',tagId:'tag-design',recurrence:{type:'weekly',until:'2026-10-22'},outlookDetails:{location:'Preserve room'}});U.openEditDialog(document.querySelector(`[data-view="${view}"] [data-task-dialog]`),t,S.getAllTags());},view);
  const d=h.page.locator(`[data-view="${view}"] [data-task-dialog]`);
  assert.equal(await d.locator('select[name=editScope]').count(),0,'B removes scope dropdown');
  assert.equal(await d.locator('[name=eventLocation]').count(),0,'location not editable');
  assert.equal(await d.locator('[name=memo]').isVisible(),true);
  await d.locator('[name=title]').fill('Edited '+view);
  await d.locator('[data-save]').click();
  const choice=h.page.locator('[data-save-scope]');await choice.waitFor();
  assert.equal(h.state().tasks.some(t=>t.title==='Edited '+view),false,'no mutation before confirmation');
  await choice.locator('[data-scope-back]').click();
  assert.equal(await d.locator('[name=title]').inputValue(),'Edited '+view,'back preserves draft');
  await d.locator('[data-save]').click();await choice.waitFor();
  await choice.locator('[value=single]').check();await choice.locator('[data-scope-confirm]').click();await d.waitFor({state:'hidden'});
  const saved=h.state().tasks.filter(t=>t.title==='Edited '+view);assert.equal(saved.length,1);assert.equal(saved[0].outlookDetails.location,'Preserve room');
 }
 for(const mode of ['future','series']){
  await h.page.locator('nav [data-nav-target="calendar"]').click();
  await h.page.evaluate(async mode=>{const S=await import('/src/store.js'),U=await import('/src/ui-utils.js');await S.createTask({title:'Range '+mode,date:'2026-10-08',startTime:'09:00',endTime:'10:00',tagId:'tag-design',recurrence:{type:'weekly',until:'2026-10-22'}});const t=S.getAllTasks().find(t=>t.title==='Range '+mode&&t.date==='2026-10-15');U.openEditDialog(document.querySelector('[data-view="calendar"] [data-task-dialog]'),t,S.getAllTags());},mode);
  const d=h.page.locator('[data-view="calendar"] [data-task-dialog]');await d.locator('[name=memo]').fill('Range change');await d.locator('[data-save]').click();
  const c=h.page.locator('[data-save-scope]');await c.waitFor();await c.locator(`[value=${mode}]`).check();await c.locator('[data-scope-confirm]').click();await d.waitFor({state:'hidden'});
  assert.equal(h.state().tasks.filter(t=>t.title==='Range '+mode&&t.localMemo==='Range change').length,mode==='future'?2:3);
 }
 assert.deepEqual(h.pageErrors,[]);
 console.log('PASS: both editors confirm before saving, back preserves input, single scope, hidden metadata retained');
}finally{await h.close();}
