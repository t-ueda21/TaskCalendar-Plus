import assert from 'node:assert/strict';
import {openHarness} from './refactor-20261008-harness.mjs';
const h=await openHarness();const p=h.page;p.setDefaultTimeout(7000);
const source='outlook-folder:'+JSON.stringify({entryId:'folder',storeId:'store',label:'Work / Calendar'});
const candidates=[{id:'old-a',title:'Old meeting <b>not HTML</b>',date:'2026-10-07',updatedAt:'r1'},{id:'old-b',title:'Another calendar',date:'2026-10-06',updatedAt:'r2'}];
const writes=[];let fail=false;
await p.route('**/api/outlook/fetch',r=>r.fulfill({json:{success:true,added:0,updated:0,deleted:0,legacyCandidates:candidates,calendarRef:source}}));
await p.route('**/api/outlook/legacy-source',r=>{writes.push(r.request().postDataJSON());return r.fulfill(fail?{status:409,json:{error:'Task changed; refresh first'}}:{json:{updated:1}});});
try{
 await h.boot();await p.locator('[data-view="calendar"] [data-settings-btn]').click();
 await p.locator('[data-settings-tab="outlook"]').click();await p.locator('[data-sync-outlook-btn]').click();
 await p.waitForFunction(()=>!document.querySelector('[data-sync-outlook-btn]').disabled);
 assert.equal(await p.locator('[data-legacy-source-open]:visible').count(),1,'unresolved legacy imports must have a source-confirmation action');
 await p.locator('[data-legacy-source-open]').click();
 assert.equal(await p.locator('[data-app-dialog-item]:checked').count(),0,'never preselect unknown calendars');
 assert.equal(await p.locator('[data-app-dialog-confirm]').isEnabled(),false);
 assert.equal(await p.locator('[data-app-dialog] b').count(),0,'task titles are text');
 assert.match(await p.locator('[data-app-dialog-message]').innerText(),/Work \/ Calendar/);
 await p.keyboard.press('Escape');assert.equal(writes.length,0,'cancel must not bind or delete anything');
 await p.locator('[data-legacy-source-open]').click();await p.locator('[data-app-dialog-item="old-a"]').check();
 fail=true;await p.locator('[data-app-dialog-confirm]').click();await p.locator('[data-app-dialog-error]:not([hidden])').waitFor();
 assert.match(await p.locator('[data-app-dialog-error]').innerText(),/Task changed/);
 assert.equal(await p.locator('[data-app-dialog-item="old-a"]').isChecked(),true);
 fail=false;await p.locator('[data-app-dialog-confirm]').click();await p.locator('[data-app-dialog]').waitFor({state:'hidden'});
 assert.deepEqual(writes.at(-1),{calendar:source,tasks:[{id:'old-a',updatedAt:'r1'}]});
 assert.equal(h.state().tasks.length,6,'source confirmation does not itself remove tasks');
 assert.deepEqual(h.pageErrors,[]);
 console.log('PASS: source recovery, explicit selection, cancellation, text safety, failed retry and exact task scope');
}finally{await h.close();}
