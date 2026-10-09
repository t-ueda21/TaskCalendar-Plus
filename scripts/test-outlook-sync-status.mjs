import assert from 'node:assert/strict';
import {openHarness} from './refactor-20261008-harness.mjs';
const h=await openHarness();const page=h.page;
let failed=false;
await page.route('**/api/outlook/fetch',r=>r.fulfill(failed?{status:503,json:{error:'Outlook offline'}}:{json:{success:true,added:0,updated:1,deleted:2,skipped:0,conflicts:1,warnings:['確認できない予定は保持しました <b>test</b>']}}));
try {
 await h.boot();await page.locator('[data-view="calendar"] [data-settings-btn]').click();
 const d=page.locator('[data-settings-dialog]');await d.locator('[data-settings-tab="outlook"]').click();
 await d.locator('[data-sync-outlook-btn]').click();
 const status=d.locator('[data-outlook-sync-status]');await page.waitForFunction(()=>document.querySelector('[data-outlook-sync-status]').textContent.includes('保持しました'));
 assert.match(await status.innerText(),/1件を保留/);assert.match(await status.innerText(),/<b>test<\/b>/);assert.equal(await status.locator('b').count(),0);assert.match(await status.getAttribute('class'),/error/);
 failed=true;await d.locator('[data-sync-outlook-btn]').click();await page.waitForFunction(()=>document.querySelector('[data-outlook-sync-status]').textContent==='Outlook offline');
 assert.equal(h.state().tasks.length,6);assert.deepEqual(h.pageErrors,[]);
 console.log('PASS: conflicts and partial-read warnings are visible, rendered as text; fetch failure preserves tasks');
}finally{await h.close();}
