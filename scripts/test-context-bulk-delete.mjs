import assert from 'node:assert/strict';
import {openHarness} from './refactor-20261008-harness.mjs';
const h=await openHarness();const p=h.page;p.setDefaultTimeout(5000);let passed=0;
const ids=['task-plan','task-meeting'];
const menu=p.locator('.taskTagContextMenu');const dialog=p.locator('[data-app-dialog]');
const view=name=>p.locator(`[data-view="${name}"]`);
const task=(name,id)=>view(name).locator(`[data-task-id="${id}"]:visible`).first();
async function setup(name,{series=false}={}){
  h.reset();
  if(series){
    const rows=h.state().tasks;
    const recurring={...rows.find(t=>t.id===ids[0]),recurrence:{type:'daily',groupId:'bulk-series',originDate:'2026-10-08',until:'2026-10-09'}};
    h.setTasks(rows.map(t=>t.id===recurring.id?recurring:t).concat({...recurring,id:'task-plan-next',date:'2026-10-09'}));
  }
  await h.boot();
  if(name==='tasks')await p.locator('nav.nav [data-nav-target="tasks"]').click();
  else await view(name).locator('[data-viewmode]').selectOption('day');
  await task(name,ids[0]).click();await task(name,ids[1]).click({modifiers:['Control']});
  await task(name,ids[0]).click({button:'right'});
}
async function requestDelete(){
  const action=menu.getByRole('button',{name:'選択した2件を削除…',exact:true});
  assert.equal(await action.count(),1,'selected tasks must offer one bulk-delete action');
  await action.click();await dialog.waitFor({state:'visible'});
  assert.match(await dialog.locator('[data-app-dialog-message]').innerText(),/2件/);
}
try{
  for(const name of ['calendar','tasks']){
    await setup(name);let before=h.state().tasks;await requestDelete();
    assert.deepEqual(h.state().tasks,before,'opening confirmation does not delete');
    await dialog.locator('[data-app-dialog-cancel]').click();await dialog.waitFor({state:'detached'});
    assert.deepEqual(h.state().tasks,before,'cancelling preserves all records');passed++;
    if(process.argv.includes('--smoke'))break;

    await setup(name,{series:true});before=h.state().tasks;await requestDelete();
    await dialog.locator('[data-app-dialog-confirm]').click();await dialog.waitFor({state:'detached'});
    assert.deepEqual(h.state().tasks,before.filter(t=>!ids.includes(t.id)),'only selected occurrences are deleted');passed++;

    await setup(name);before=h.state().tasks;await requestDelete();h.failNext('POST','/api/tasks/batch',409);
    await dialog.locator('[data-app-dialog-confirm]').click();await dialog.locator('[data-app-dialog-error]').waitFor({state:'visible'});
    assert.deepEqual(h.state().tasks,before,'failed delete cannot partially delete');
    assert.equal(await view(name).locator('[data-task-id][aria-selected="true"]:visible').count(),2);
    await dialog.locator('[data-app-dialog-confirm]').click();await dialog.waitFor({state:'detached'});
    assert.deepEqual(h.state().tasks,before.filter(t=>!ids.includes(t.id)));passed++;

    await setup(name);await requestDelete();
    const concurrent=h.state().tasks.map(t=>t.id===ids[1]?{...t,title:'変更された予定',updatedAt:'2026-10-08T02:00:00.000Z'}:t);h.setTasks(concurrent);
    await dialog.locator('[data-app-dialog-confirm]').click();await dialog.locator('[data-app-dialog-error]').waitFor({state:'visible'});
    assert.deepEqual(h.state().tasks,concurrent,'stale delete preserves concurrent edit and all other tasks');
    await dialog.locator('[data-app-dialog-cancel]').click();passed++;

    await setup(name);before=h.state().tasks;await requestDelete();
    let release;const gate=new Promise(r=>{release=r;});let requests=0;
    const handler=async route=>{requests++;await gate;await route.continue();};await p.route('**/api/tasks/batch',handler);
    try{
      await dialog.locator('[data-app-dialog-confirm]').click();
      await p.waitForFunction(()=>document.querySelector('[data-app-dialog]')?.getAttribute('aria-busy')==='true');
      await dialog.locator('[data-app-dialog-confirm]').dispatchEvent('click');
      await p.keyboard.press('Escape');assert.equal(await dialog.isVisible(),true);assert.deepEqual(h.state().tasks,before);
      release();await dialog.waitFor({state:'detached'});assert.equal(requests,1);
      assert.deepEqual(h.state().tasks,before.filter(t=>!ids.includes(t.id)));
    }finally{release();await p.unroute('**/api/tasks/batch',handler);}
    passed++;console.log('PASS: '+name+' confirmation, selected occurrences, retry, conflicts and pending delete');
  }
  assert.deepEqual(h.pageErrors,[]);assert.deepEqual(h.unexpectedRequests,[]);console.log(JSON.stringify({passed}));
}finally{await h.close();}
