import assert from 'node:assert/strict';
import fs from 'node:fs';
import {openHarness} from './refactor-20261008-harness.mjs';
const h=await openHarness();const p=h.page;const results=[];
try{
  for(const width of [1440,800])for(const name of ['calendar','tasks']){
    h.reset();await p.setViewportSize({width,height:1000});await h.boot();
    if(name==='tasks')await p.locator('nav.nav [data-nav-target="tasks"]').click();
    else await p.locator('[data-view="calendar"] [data-viewmode]').selectOption('day');
    const view=p.locator(`[data-view="${name}"]`);
    const task=id=>view.locator(`[data-task-id="${id}"]:visible`).first();
    const content=name==='tasks'?view.locator('table').first():view.locator('.gridWrap:visible').first();
    await task('task-plan').click();
    const before=await content.boundingBox();
    await task('task-meeting').click({modifiers:['Control']});
    const after=await content.boundingBox();
    results.push({width,view:name,before,after});
    if(process.argv.includes('--measure'))continue;
    assert.deepEqual(after,before,`${name}/${width}: selecting two tasks must not move or resize content`);
    assert.equal(await view.locator('[data-task-selection-bar],[data-bulk-edit]').count(),0,'no inline selection toolbar');
    await task('task-plan').click({button:'right'});
    const menu=p.locator('.taskTagContextMenu');
    assert.equal(await menu.getByRole('button',{name:'選択解除',exact:true}).count(),0,'no clear-selection menu item');
    await menu.getByRole('button',{name:'一括変更',exact:true}).click();
    const dialog=p.locator('[data-bulk-dialog]');await dialog.waitFor({state:'visible'});
    await dialog.locator('[data-bulk-cancel]').click();await dialog.waitFor({state:'detached'});
    assert.deepEqual(await content.boundingBox(),before,'cancel leaves geometry unchanged');
    const focused=await p.evaluate(()=>document.activeElement?.closest('[data-task-id]')?.dataset.taskId);
    assert.ok(['task-plan','task-meeting'].includes(focused),'focus returns to a selected task');
    await p.keyboard.press('Escape');
    assert.equal(await view.locator('[data-task-id][aria-selected="true"]:visible').count(),0);
    assert.deepEqual(await content.boundingBox(),before,'clearing selection leaves geometry unchanged');
  }
  if(process.argv.includes('--measure')){
    fs.mkdirSync('out/selection-layout-20261008',{recursive:true});
    fs.writeFileSync('out/selection-layout-20261008/before.json',JSON.stringify(results,null,2));
  }
  assert.deepEqual(h.pageErrors,[]);
  console.log(JSON.stringify({conditions:results.length,results}));
}finally{await h.close();}
