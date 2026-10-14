import assert from 'node:assert/strict';
import fs from 'node:fs';
import {openHarness} from './refactor-20261008-harness.mjs';
const h=await openHarness({root:process.argv[2]||process.cwd()});
async function setOutboundWriteEnabled(enabled) {
 // Keep the operation reachable in the page. CDP must not own the only handle
 // to an async evaluate promise while the synthetic settings request settles.
 await h.page.evaluate(enabled=>{
  const test=window.__taskEditorMock;
  test.settingsDone=false;test.settingsError=null;
  test.settingsPromise=test.Store.updateSettings({outlookWriteEnabled:enabled}).then(
   ()=>{test.settingsDone=true;},
   error=>{test.settingsError=String(error?.stack||error);test.settingsDone=true;},
  );
 },enabled);
 await h.page.waitForFunction(()=>window.__taskEditorMock.settingsDone);
 assert.equal(await h.page.evaluate(()=>window.__taskEditorMock.settingsError),null);
}
try {
 await h.boot();
 await h.page.evaluate(()=>{
  const test=window.__taskEditorMock={ready:false,error:null};
  test.importsPromise=Promise.all([import('/src/store.js'),import('/src/ui-utils.js')]).then(
   ([Store,UI])=>{test.Store=Store;test.UI=UI;test.ready=true;},
   error=>{test.error=String(error?.stack||error);test.ready=true;},
  );
 });
 await h.page.waitForFunction(()=>window.__taskEditorMock.ready);
 assert.equal(await h.page.evaluate(()=>window.__taskEditorMock.error),null);
 for (const view of ['calendar','tasks']) {
  await h.page.locator(`nav [data-nav-target="${view}"]`).click();
  await h.page.evaluate(view=>{const {UI:U,Store:S}=window.__taskEditorMock;U.openCreateDialog(document.querySelector(`[data-view="${view}"] [data-task-dialog]`),{date:'2026-10-14',startTime:'09:30',endTime:'10:30',tags:S.getAllTags(),focusTitle:true});},view);
  const d=h.page.locator(`[data-view="${view}"] [data-task-dialog]`);
  await d.locator('[name=title]').fill('定例ミーティング');
  const layout=await d.evaluate(d=>{const rect=s=>d.querySelector(s).getBoundingClientRect().toJSON();return {title:rect('[name=title]'),date:rect('[name=date]'),end:rect('[name=endDate]'),start:rect('[name=startTime]'),memo:rect('[name=memo]'),labels:[...d.querySelectorAll('.formRow>label')].map(e=>getComputedStyle(e).fontSize),inputSizes:['title','date','startTime','memo'].map(n=>getComputedStyle(d.querySelector(`[name=${n}]`)).fontSize),fields:[...d.querySelectorAll('input,textarea')].filter(e=>e.getBoundingClientRect().width>0).map(e=>e.name)};});
  assert.ok(layout.title.y<layout.date.y,'mock title is first');assert.equal(layout.date.y,layout.end.y,'date pair shares row');
  assert.ok(layout.start.y>layout.date.y);assert.deepEqual(layout.inputSizes,['14px','14px','14px','14px']);
  assert.ok(layout.labels.every(s=>s==='13px'));
  assert.equal(await d.locator('[data-event-details],[name=eventLocation],select[name=editScope]').count(),0);
  assert.equal(await d.locator('[name=memo]').isVisible(),true);
  assert.equal(await d.locator('[data-editor-meeting]').isVisible(),false,'empty native metadata not shown');
  await d.locator('[name=allDay]').check();assert.equal(await d.locator('[name=startTime]').isVisible(),false);await d.locator('[name=allDay]').uncheck();
  await d.locator('[name=outlookEnabled]').check();assert.match(await d.locator('[data-editor-sync-status]').innerText(),/全体設定がOFF/);
  await setOutboundWriteEnabled(true);
  assert.match(await d.locator('[data-editor-sync-status]').innerText(),/ともにON/);
  await d.locator('[name=outlookEnabled]').uncheck();assert.match(await d.locator('[data-editor-sync-status]').innerText(),/送信しません/);
  await setOutboundWriteEnabled(false);
  if(process.env.TCPLUS_MOCK_SCREENSHOTS){fs.mkdirSync(process.env.TCPLUS_MOCK_SCREENSHOTS,{recursive:true});await d.screenshot({path:process.env.TCPLUS_MOCK_SCREENSHOTS+'/'+view+'-new-light.png',animations:'disabled'});}
  await d.locator('[data-cancel]').click();
 }
 assert.deepEqual(h.pageErrors,[]);console.log('PASS: full B mock field order, date pair, typography, visible memo, no detail panel, all-day hiding and outbound gates in both editors');
} finally {await h.close();}
