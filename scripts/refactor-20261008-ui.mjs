// Role A behavior contracts, executed against production renderer + synthetic boundaries.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openHarness, fixture } from './refactor-20261008-harness.mjs';
import { runContextMenuContracts } from './refactor-20261008-context-menu.mjs';

const root=path.resolve(process.argv[2]||'.');
const output=path.resolve(process.argv[3]||'out/refactor-20261008/ui-contract-probe');
if(fs.existsSync(output))throw Error('Evidence output already exists: '+output);
fs.mkdirSync(output,{recursive:true});
const h=await openHarness({root,output});const p=h.page;p.setDefaultTimeout(7000);
const cases=[],browserDialogs=[];
p.on('dialog',async dialog=>{browserDialogs.push({type:dialog.type(),message:dialog.message()});await dialog.dismiss();});
const view=name=>p.locator('[data-view="'+name+'"]');
const tasks=()=>view('tasks');
const editor=()=>tasks().locator('[data-task-dialog]');
const navigateTasks=async()=>{await p.locator('nav.nav [data-nav-target="tasks"]').click();await tasks().waitFor({state:'visible'});};
const stateTasks=()=>h.state().tasks;
const waitForTask=async(title)=>p.waitForFunction(async expected=>(await import('/src/store.js')).getAllTasks().some(row=>row.title===expected),title);
const write=()=>fs.writeFileSync(path.join(output,'cases.json'),JSON.stringify({scope:h.meta.scope,cases,browserDialogs},null,2));
async function run(id,description,fn){
  try{h.reset();await h.boot();await fn();cases.push({id,description,required:true,status:'passed',evidence:'cases.json'});console.log('PASS: '+id);}
  catch(error){cases.push({id,description,required:true,status:'failed',error:error.stack,evidence:id+'.png'});await p.screenshot({path:path.join(output,id+'.png'),animations:'disabled'}).catch(()=>{});console.log('FAIL: '+id+' '+error.message);}
  write();
}
try{
  await run('UI-BOOT','Bootstrap uses expected fixture IDs and locale',async()=>{
    assert.equal(await p.title(),'TaskCalendar+');assert.equal(await p.locator('html').getAttribute('lang'),'ja');
    const ids=await p.evaluate(async()=> (await import('/src/store.js')).getAllTasks().map(row=>row.id).sort());
    assert.deepEqual(ids,fixture().tasks.map(row=>row.id).sort());
    await navigateTasks();assert.equal(await tasks().locator('tr[data-task-id]').count(),6);
  });
  await run('UI-WORK-TOTALS','Only tagged work contributes; daily sidebar retains tags without total/overtime',async()=>{
    const summary=await p.evaluate(async()=>{const S=await import('/src/store.js');const pack=x=>({...x,byTag:[...x.byTag]});return {day:pack(S.calcDaySummary('2026-10-08')),month:pack(S.calcMonthSummary('2026-10'))};});
    for(const value of Object.values(summary)){assert.equal(value.total,270);assert.equal(value.overtime,60);assert.deepEqual(value.byTag.sort(),[['tag-design',210],['tag-meeting',60]]);}
    for(const name of ['calendar','tasks']){
      if(name==='tasks')await navigateTasks();
      const daily=view(name).locator('[data-side-day-summary]');assert.equal(await daily.locator('.sideWorkTotals').count(),0);
      const text=await daily.innerText();assert.match(text,/設計/);assert.match(text,/打ち合わせ/);assert.doesNotMatch(text,/合計時間|残業時間/);
      assert.equal(await view(name).locator('[data-side-month-summary] .sideWorkTotals').count(),1);
    }
  });
  await run('UI-TASK-FILTER','Tag filtering shows exact IDs and clearing restores all tasks',async()=>{
    await navigateTasks();await tasks().locator('[data-tag-filter]').selectOption('tag-design');
    assert.deepEqual((await tasks().locator('tr[data-task-id]').evaluateAll(rows=>rows.map(row=>row.dataset.taskId))).sort(),['task-early','task-late','task-plan']);
    await tasks().locator('[data-tag-filter]').selectOption('__all__');assert.equal(await tasks().locator('tr[data-task-id]').count(),6);
  });
  await run('UI-MULTISELECT','Ctrl toggles and Shift selects the chronological range in list and calendar',async()=>{
    for(const name of ['calendar','tasks']){
      if(name==='tasks')await navigateTasks();const scope=view(name);
      const task=id=>scope.locator('[data-task-id="'+id+'"]:visible');
      const selected=async()=>[...new Set(await scope.locator('[data-task-id][aria-selected="true"]:visible').evaluateAll(nodes=>nodes.map(node=>node.dataset.taskId)))].sort();
      await task('task-early').click();assert.deepEqual(await selected(),['task-early']);
      await task('task-plan').click({modifiers:['Control']});assert.deepEqual(await selected(),['task-early','task-plan']);
      await task('task-early').click({modifiers:['Control']});assert.deepEqual(await selected(),['task-plan']);
      await task('task-plan').click();await task('task-late').click({modifiers:['Shift']});assert.deepEqual(await selected(),['task-late','task-meeting','task-personal','task-plan']);
      assert.equal(await scope.locator('[data-bulk-edit]').isEnabled(),true);await p.keyboard.press('Escape');assert.deepEqual(await selected(),[]);
    }
  });
  await run('UI-SELECTION-PRUNE','Filtering and changing date removes hidden selections',async()=>{
    await navigateTasks();await tasks().locator('[data-task-id="task-early"] .taskTitleCell').click();await tasks().locator('[data-task-id="task-plan"] .taskTitleCell').click({modifiers:['Control']});
    await tasks().locator('[data-tag-filter]').selectOption('tag-meeting');assert.equal(await tasks().locator('[aria-selected="true"][data-task-id]').count(),0);
    await tasks().locator('[data-tag-filter]').selectOption('__all__');await tasks().locator('[data-task-id="task-early"] .taskTitleCell').click();await tasks().locator('[data-task-id="task-plan"] .taskTitleCell').click({modifiers:['Control']});
    await tasks().locator('[data-task-day-next]').click();assert.equal(await tasks().locator('[aria-selected="true"][data-task-id]').count(),0);
  });
  await run('UI-BULK-SAVE','Bulk changes only enabled fields on selected task IDs',async()=>{
    await navigateTasks();const before=stateTasks();await tasks().locator('[data-task-id="task-plan"] .taskTitleCell').click();await tasks().locator('[data-task-id="task-meeting"] .taskTitleCell').click({modifiers:['Control']});
    await tasks().locator('[data-bulk-edit]').click();const dialog=p.locator('[data-bulk-dialog]');assert.equal(await dialog.locator('[data-bulk-apply]').isEnabled(),false);
    await dialog.locator('[data-bulk-enable="memo"]').check();await dialog.locator('[data-bulk-memo]').fill('一括更新したメモ');await dialog.locator('[data-bulk-apply]').click();await dialog.waitFor({state:'detached'});
    for(const id of ['task-plan','task-meeting']){const actual=stateTasks().find(row=>row.id===id);const original=before.find(row=>row.id===id);assert.deepEqual({...actual,updatedAt:original.updatedAt},{...original,memo:'一括更新したメモ'});}
    assert.deepEqual(stateTasks().filter(row=>!['task-plan','task-meeting'].includes(row.id)),before.filter(row=>!['task-plan','task-meeting'].includes(row.id)));
  });
  await run('UI-BULK-FAILURE','Failed bulk request changes nothing, keeps dialog open and permits retry',async()=>{
    await navigateTasks();const before=stateTasks();await tasks().locator('[data-task-id="task-plan"] .taskTitleCell').click();await tasks().locator('[data-task-id="task-meeting"] .taskTitleCell').click({modifiers:['Control']});
    await tasks().locator('[data-bulk-edit]').click();const dialog=p.locator('[data-bulk-dialog]');await dialog.locator('[data-bulk-enable="tag"]').check();await dialog.locator('[data-bulk-tag]').selectOption('');
    h.failNext('POST','/api/tasks/batch',409);await dialog.locator('[data-bulk-apply]').click();await p.waitForFunction(()=>Boolean(document.querySelector('[data-bulk-error]')?.textContent));
    assert.deepEqual(stateTasks(),before);assert.equal(await dialog.isVisible(),true);assert.equal(await dialog.locator('[data-bulk-apply]').isEnabled(),true);
    await dialog.locator('[data-bulk-apply]').click();await dialog.waitFor({state:'detached'});
    assert.equal(stateTasks().find(row=>row.id==='task-plan').tagId,'');assert.equal(stateTasks().find(row=>row.id==='task-meeting').tagId,'');assert.deepEqual(stateTasks().filter(row=>!['task-plan','task-meeting'].includes(row.id)),before.filter(row=>!['task-plan','task-meeting'].includes(row.id)));
  });
  await run('UI-BULK-STALE','Stale bulk snapshots preserve concurrent edits and other selected tasks',async()=>{
    await navigateTasks();await tasks().locator('[data-task-id="task-plan"] .taskTitleCell').click();await tasks().locator('[data-task-id="task-meeting"] .taskTitleCell').click({modifiers:['Control']});await tasks().locator('[data-bulk-edit]').click();
    const concurrent=stateTasks().map(row=>row.id==='task-plan'?{...row,memo:'別の場所で保存したメモ',updatedAt:'2026-10-08T01:16:00.000Z'}:row);h.setTasks(concurrent);
    const dialog=p.locator('[data-bulk-dialog]');await dialog.locator('[data-bulk-enable="memo"]').check();await dialog.locator('[data-bulk-memo]').fill('古い内容からの更新');await dialog.locator('[data-bulk-apply]').click();await p.waitForFunction(()=>Boolean(document.querySelector('[data-bulk-error]')?.textContent));
    assert.deepEqual(stateTasks(),concurrent);assert.equal(await dialog.isVisible(),true);await dialog.locator('[data-bulk-cancel]').click();
  });
  await run('UI-TAGLESS-BADGE','Task-list tagless badge is visible and aligned; editor retains tagless choice',async()=>{
    await navigateTasks();const row=tasks().locator('tr[data-task-id="task-personal"]');
    assert.equal(await row.locator('.isUntagged').innerText(),'タグなし');
    const badge=await row.locator('.isUntagged').boundingBox();const tagged=await tasks().locator('[data-task-id="task-plan"] .taskTagBadge').boundingBox();assert.ok(badge.width>20&&badge.height>10);assert.ok(Math.abs(badge.x-tagged.x)<2,'tagless and tagged badges align to the same column');
    await row.locator('[data-edit]').click();const tagless=editor().locator('[data-btn-group="tag"] [data-value=""]');
    assert.match(await tagless.innerText(),/タグなし/);assert.ok(await tagless.isVisible());
    await editor().locator('[data-cancel]').click();
  });
  await run('UI-EDIT-CANCEL','Cancelling an edited task preserves the complete API snapshot',async()=>{
    await navigateTasks();const before=stateTasks();await tasks().locator('[data-task-id="task-plan"] [data-edit]').click();
    await editor().locator('[name="title"]').fill('保存しない編集');await editor().locator('[name="memo"]').fill('保存しないメモ');
    await editor().locator('[data-cancel]').click();assert.deepEqual(stateTasks(),before);
  });
  await run('UI-EDIT-SAVE','Saving changes only the targeted task fields',async()=>{
    await navigateTasks();const before=stateTasks();await tasks().locator('[data-task-id="task-plan"] [data-edit]').click();
    await editor().locator('[name="title"]').fill('保存した計画');await editor().locator('[name="memo"]').fill('変更後のメモ');await editor().locator('[data-save]').click();
    await waitForTask('保存した計画');assert.equal(stateTasks().find(row=>row.id==='task-plan').memo,'変更後のメモ');
    assert.deepEqual(stateTasks().filter(row=>row.id!=='task-plan'),before.filter(row=>row.id!=='task-plan'));
  });
  await run('UI-CREATE','Creating a task preserves IDs and persists user-provided values',async()=>{
    await navigateTasks();const before=stateTasks();await tasks().locator('[data-new-task]').click();
    await editor().locator('[name="title"]').fill('追加の合成予定');await editor().locator('[name="startTime"]').fill('16:00');await editor().locator('[name="endTime"]').fill('17:00');await editor().locator('[data-dialog-title]').click();
    await editor().locator('[data-btn-group="tag"] [data-value="tag-design"]').click();await editor().locator('[data-save]').click();await waitForTask('追加の合成予定');
    const added=stateTasks().find(row=>row.title==='追加の合成予定');assert.equal(added.date,'2026-10-08');assert.equal(added.startTime,'16:00');assert.equal(added.endTime,'17:00');assert.equal(added.tagId,'tag-design');assert.equal(stateTasks().length,7);
    assert.deepEqual(stateTasks().filter(row=>row.id!==added.id),before);
  });
  await run('UI-DELETE-CONFIRM','In-app deletion confirmation cancels safely and deletes only the confirmed task',async()=>{
    await navigateTasks();const before=stateTasks();await tasks().locator('[data-task-id="task-personal"] [data-del]').click();
    const dialog=p.locator('[data-app-dialog]');await dialog.waitFor({state:'visible'});assert.equal(await dialog.locator('[data-app-dialog-cancel]').evaluate(node=>node===document.activeElement),true);
    await dialog.locator('[data-app-dialog-cancel]').click();assert.deepEqual(stateTasks(),before);
    await tasks().locator('[data-task-id="task-personal"] [data-del]').click();await dialog.locator('[data-app-dialog-confirm]').click();
    await p.waitForFunction(async()=>!(await import('/src/store.js')).getAllTasks().some(row=>row.id==='task-personal'));
    assert.deepEqual(stateTasks(),before.filter(row=>row.id!=='task-personal'));
  });
  await run('UI-TITLE','Double-click creation has a blank title without the former suffix',async()=>{
    await view('calendar').locator('[data-viewmode]').selectOption('day');
    await view('calendar').locator('[data-slots="day"] .slot[data-index="33"]').dblclick();
    const dialog=view('calendar').locator('[data-task-dialog]');await dialog.waitFor({state:'visible'});assert.equal(await dialog.locator('[name="title"]').inputValue(),'');
    await dialog.locator('[data-cancel]').click();assert.deepEqual(stateTasks(),fixture().tasks);
  });
  await run('UI-MINI','Disclosure, month/year pickers, wheel navigation and no picker overflow',async()=>{
    const scope=view('calendar');const grid=scope.locator('[data-mini-cal]');const label=scope.locator('[data-mini-month-label]');const toggle=scope.locator('[data-mini-calendar-toggle]');
    const start=await label.innerText();await toggle.click();assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert.equal(await label.innerText(),start);
    await toggle.click();assert.equal(await toggle.getAttribute('aria-expanded'),'true');assert.equal(await grid.getAttribute('data-picker-mode'),'days');
    for(const mode of ['days','months','years']){
      assert.equal(await grid.getAttribute('data-picker-mode'),mode);const before=await label.innerText();await grid.hover();await p.waitForTimeout(200);await p.mouse.wheel(0,120);
      await p.waitForFunction(({before,mode})=>{const scope=document.querySelector('[data-view="calendar"]');return scope.querySelector('[data-mini-cal]').dataset.pickerMode===mode&&scope.querySelector('[data-mini-month-label]').textContent!==before;},{before,mode});
      const bounds=await grid.evaluate(node=>({scrollHeight:node.scrollHeight,clientHeight:node.clientHeight,overflow:getComputedStyle(node).overflowY}));assert.ok(bounds.scrollHeight<=bounds.clientHeight+1,JSON.stringify(bounds));assert.ok(!['scroll','auto'].includes(bounds.overflow),JSON.stringify(bounds));
      if(mode!=='years')await label.click();
    }
  });
  await run('UI-SETTINGS-PAGES','Purpose-specific setting pages show one panel and preserve cancel/save',async()=>{
    await view('calendar').locator('[data-settings-btn]').click();const dialog=p.locator('[data-settings-dialog]');
    const expected=['general','advanced','tags','ai','outlook','about','app','shortcuts'];assert.deepEqual((await dialog.locator('[data-settings-tab]').evaluateAll(nodes=>nodes.map(node=>node.dataset.settingsTab))).sort(),expected.sort());
    for(const tab of expected){await dialog.locator('[data-settings-tab="'+tab+'"]').click();assert.equal(await dialog.locator('[data-settings-tab][aria-selected="true"]').count(),1);assert.equal(await dialog.locator('[data-settings-tab-panel]:not([hidden])').count(),1);assert.equal(await dialog.locator('[data-settings-tab-panel]:not([hidden])').getAttribute('data-settings-tab-panel'),tab);}
    const expectedPanels={'[data-language-select]':'general','[name="workStart"]':'advanced','[data-ai-provider-select]':'ai','[name="launchAtLogin"]':'app','[data-tag-list]':'tags'};
    for(const [selector,tab]of Object.entries(expectedPanels))assert.equal(await dialog.locator(selector).evaluate(node=>node.closest('[data-settings-tab-panel]').dataset.settingsTabPanel),tab);
    const before=h.state().settings;await dialog.locator('[data-settings-tab="advanced"]').click();await dialog.locator('[name="workStart"]').selectOption('08:00');await dialog.locator('[data-settings-cancel]').click();assert.deepEqual(h.state().settings,before);
    await view('calendar').locator('[data-settings-btn]').click();await dialog.locator('[data-settings-tab="advanced"]').click();await dialog.locator('[name="workStart"]').selectOption('08:00');await dialog.locator('[data-settings-save]').click();
    await p.waitForFunction(async()=> (await import('/src/store.js')).getSettings().workStart==='08:00');assert.equal(h.state().settings.workStart,'08:00');
  });
  await run('UI-LOCALES','English and Korean render translated controls while task text is preserved',async()=>{
    await navigateTasks();
    for(const [locale,label]of [['en','Tasks'],['ko','작업']]){
      await p.evaluate(async locale=>(await import('/src/store.js')).updateSettings({uiLanguage:locale}),locale);
      assert.equal(await p.locator('html').getAttribute('lang'),locale);assert.match(await p.locator('nav.nav').innerText(),new RegExp(label));assert.match(await tasks().locator('[data-task-id="task-plan"]').innerText(),/計画を整理/);
    }
  });
  await runContextMenuContracts(h,run);
  cases.push({id:'UI-NO-NATIVE-DIALOG',description:'No browser alert/confirm/prompt emitted during required flows',required:true,status:browserDialogs.length?'failed':'passed',evidence:'cases.json'});
  cases.push({id:'UI-NO-UNEXPECTED-ERRORS',description:'No uncaught renderer errors or unsupported synthetic API calls',required:true,status:h.pageErrors.length||h.unexpectedRequests.length?'failed':'passed',errors:h.pageErrors,requests:h.unexpectedRequests,evidence:'harness-environment.json'});
  write();if(cases.some(row=>row.status!=='passed'))process.exitCode=1;
  console.log(JSON.stringify({required:cases.length,passed:cases.filter(row=>row.status==='passed').length,failed:cases.filter(row=>row.status==='failed').length,output}));
}finally{await h.close();}
