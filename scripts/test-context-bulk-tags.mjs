// Production renderer interactions; isolated API/native/weather fixture, never native app startup.
import assert from 'node:assert/strict';
import {openHarness} from './refactor-20261008-harness.mjs';

const h=await openHarness();const p=h.page;p.setDefaultTimeout(5000);
const menu=p.locator('.taskTagContextMenu');
const selected=['task-plan','task-meeting'];
const canonical=rows=>rows.map(({updatedAt,...rest})=>rest).sort((a,b)=>a.id.localeCompare(b.id));
const view=name=>p.locator(`[data-view="${name}"]`);
const task=(name,id)=>view(name).locator(`[data-task-id="${id}"]:visible`).first();
const open=async(name,id)=>{await task(name,id).click({button:'right'});await menu.waitFor({state:'visible'});};
async function setup(name){
  h.reset();await h.boot();
  await p.evaluate(async()=>{window.__bulkTestStore=await import('/src/store.js');});
  if(name==='calendar')await view(name).locator('[data-viewmode]').selectOption('day');
  else await p.locator('nav.nav [data-nav-target="tasks"]').click();
  await task(name,selected[0]).click();
  await task(name,selected[1]).click({modifiers:['Control']});
}
async function waitTags(ids,tag){await p.waitForFunction(({ids,tag})=>{
  return ids.every(id=>window.__bulkTestStore.getAllTasks().find(t=>t.id===id)?.tagId===tag);
},{ids,tag});}
function expected(before,ids,tag){return canonical(before.map(t=>ids.includes(t.id)?{...t,tagId:tag}:t));}
let passed=0;
try{
  for(const name of ['calendar','tasks']){
    await setup(name);let before=h.state().tasks;
    await open(name,selected[0]);
    await menu.getByRole('button',{name:'設計',exact:true}).click();
    await waitTags([selected[0]],'tag-design');await menu.waitFor({state:'hidden'});
    assert.deepEqual(canonical(h.state().tasks),expected(before,selected,'tag-design'),name+': selected tasks only');
    assert.match(await view(name).locator('[data-selection-count]').innerText(),/2/);
    // Remove tags through the other selected member, keeping the selection usable.
    before=h.state().tasks;await open(name,selected[1]);
    await menu.getByRole('button',{name:'タグなし',exact:true}).click();await waitTags(selected,'');
    assert.deepEqual(canonical(h.state().tasks),expected(before,selected,''));
    passed++;console.log('PASS: '+name+' selected member updates all selected tags and removes tags');
    if(process.argv.includes('--smoke'))break;

    await setup(name);before=h.state().tasks;
    await task(name,'task-early').click();await task(name,'task-meeting').click({modifiers:['Shift']});
    await open(name,'task-plan');await menu.getByRole('button',{name:'タグなし',exact:true}).click();
    await waitTags(['task-early','task-plan','task-meeting'],'');
    assert.deepEqual(canonical(h.state().tasks),expected(before,['task-early','task-plan','task-meeting'],''));
    passed++;console.log('PASS: '+name+' Shift range applies tags to the selected range');

    await setup(name);before=h.state().tasks;await open(name,selected[0]);
    assert.match(await menu.innerText(),/2/);
    assert.equal(await menu.locator('button.active').count(),0,'mixed tags have no common active tag');
    assert.equal(await menu.getByRole('button',{name:'編集',exact:true}).count(),0,'bulk tag menu must not offer single-task edit');
    assert.equal(await menu.locator('button.danger').count(),0,'bulk tag menu must not offer single-task delete');
    await p.keyboard.press('Escape');assert.deepEqual(h.state().tasks,before);
    passed++;console.log('PASS: '+name+' mixed-tag menu and cancellation');

    await setup(name);before=h.state().tasks;await open(name,'task-personal');
    await menu.getByRole('button',{name:'打ち合わせ',exact:true}).click();await waitTags(['task-personal'],'tag-meeting');
    assert.deepEqual(canonical(h.state().tasks),expected(before,['task-personal'],'tag-meeting'));
    assert.equal(await view(name).locator('[data-task-id].isTaskSelected:visible').count(),1);
    passed++;console.log('PASS: '+name+' unselected right-click targets only that task');

    await setup(name);before=h.state().tasks;await open(name,selected[0]);h.failNext('POST','/api/tasks/batch',409);
    await menu.getByRole('button',{name:'打ち合わせ',exact:true}).click();
    await view(name).locator('[data-selection-status]').filter({hasText:/\S/}).waitFor();
    await p.waitForFunction(()=>!document.querySelector('.taskTagContextMenu button')?.disabled);
    assert.deepEqual(h.state().tasks,before,'failed request must not partially change tags');
    assert.equal(await view(name).locator('[data-task-id].isTaskSelected:visible').count(),2);
    await menu.getByRole('button',{name:'打ち合わせ',exact:true}).click();await waitTags(selected,'tag-meeting');
    assert.deepEqual(canonical(h.state().tasks),expected(before,selected,'tag-meeting'));
    passed++;console.log('PASS: '+name+' atomic failure and retry');

    await setup(name);await open(name,selected[0]);
    const concurrent=h.state().tasks.map(t=>t.id===selected[1]?{...t,title:'他の編集',updatedAt:'2026-10-08T02:00:00.000Z'}:t);
    h.setTasks(concurrent);
    await menu.getByRole('button',{name:'打ち合わせ',exact:true}).click();
    await view(name).locator('[data-selection-status]').filter({hasText:/\S/}).waitFor();
    await p.waitForFunction(()=>document.querySelector('.taskTagContextMenu button')?.disabled===false);
    assert.deepEqual(h.state().tasks,concurrent,'menu-open revisions must protect concurrent edits');
    passed++;console.log('PASS: '+name+' stale menu preserves concurrent edit');

    await setup(name);before=h.state().tasks;await open(name,selected[0]);
    let release;const gate=new Promise(resolve=>{release=resolve;});let calls=0;
    const handler=async route=>{calls++;await gate;await route.continue();};
    await p.route('**/api/tasks/batch',handler);
    try{
      await menu.getByRole('button',{name:'打ち合わせ',exact:true}).click();
      await p.waitForFunction(()=>document.querySelector('.taskTagContextMenu button')?.disabled===true);
      assert.deepEqual(h.state().tasks,before);
      // A second event while busy cannot enqueue a second batch.
      await menu.getByRole('button',{name:'タグなし',exact:true}).dispatchEvent('click');
      release();await waitTags(selected,'tag-meeting');assert.equal(calls,1);
    }finally{release();await p.unroute('**/api/tasks/batch',handler);}
    passed++;console.log('PASS: '+name+' pending save rejects duplicate submission');
  }
  assert.deepEqual(h.pageErrors,[]);assert.deepEqual(h.unexpectedRequests,[]);
  console.log(JSON.stringify({passed,scope:'isolated renderer; no native app or live services'}));
}finally{await h.close();}
