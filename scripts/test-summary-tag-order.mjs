// Isolated Chromium with synthetic data, API and native bridge; never starts Tauri or Outlook.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openHarness } from './refactor-20261008-harness.mjs';

const sourceRoot = process.env.TCPLUS_SUMMARY_ORDER_SOURCE || process.cwd();
const evidence = process.env.TCPLUS_SUMMARY_ORDER_EVIDENCE;
if (evidence) fs.mkdirSync(evidence, {recursive:true});
const h = await openHarness({root:sourceRoot, output:evidence});
h.page.setDefaultTimeout(8000);
try {
  for (const id of [...Array.from({length:9}, (_, i) => `extra-${i}`), 'unlisted']) {
    const response = await h.page.request.post(h.origin + '/api/tags', {
      data:{id,name:`検証 ${id}`,color:'#558877'},
    });
    assert.equal(response.status(),201);
  }
  const extras = Array.from({length:9}, (_, i) => `extra-${8-i}`);
  const october = ['tag-meeting','tag-design',...extras];
  const response = await h.page.request.put(h.origin + '/api/settings', {data:{
    ...h.state().settings,
    monthTagOrders:{'2026-10':october,'2026-09':['tag-meeting','tag-design'],
      '2025-09':['tag-design','tag-meeting']},
  }});
  assert.equal(response.status(),200);
  await h.boot();
  await h.page.locator('nav [data-nav-target="summary"]').click();
  const root = h.page.locator('[data-view="summary"]');
  await root.locator('[data-summary-tag]').first().waitFor();
  const visibleTags = () => root.locator('[data-summary-tag]').evaluateAll(nodes=>nodes.map(node=>node.dataset.summaryTag));
  const total = () => root.locator('[data-summary-metric="total"] [data-metric-value]').textContent().then(text=>text.replace(/\s/g,''));
  if (evidence) await h.page.screenshot({path:path.join(evidence,'initial.png'),animations:'disabled'});
  assert.deepEqual(await visibleTags(),october.slice(0,10),'monthly summary follows settings order');
  assert.equal(await total(),'4時間30分');

  await root.locator('[data-summary-tag="tag-meeting"]').click();
  await root.locator('[data-summary-tag="tag-design"]').click();
  assert.equal(await total(),'4時間30分');
  await root.locator('[data-settings-btn]').click();
  const settings = h.page.locator('[data-settings-dialog]');
  await settings.locator('[data-settings-tab="tags"]').click();
  const rows = () => settings.locator('[data-tag-row]').evaluateAll(nodes=>nodes.map(node=>node.dataset.tagRow));
  assert.deepEqual(await rows(),october,'settings displays the same configured order');
  await settings.locator('[data-tag-row="tag-meeting"] .settingsTagDragHandle').focus();
  await h.page.keyboard.press('ArrowDown');
  const rearranged = ['tag-design','tag-meeting',...extras];
  await h.page.waitForFunction(expected=>{
    const rows=[...document.querySelectorAll('[data-settings-dialog] [data-tag-row]')].map(row=>row.dataset.tagRow);
    const tags=[...document.querySelectorAll('[data-view="summary"] [data-summary-tag]')].map(tag=>tag.dataset.summaryTag);
    return JSON.stringify(rows)===JSON.stringify(expected) && JSON.stringify(tags)===JSON.stringify(expected.slice(0,10));
  },rearranged);
  await settings.locator('[data-settings-cancel]').click();
  assert.deepEqual(await visibleTags(),rearranged.slice(0,10),'saved reorder updates the visible summary');
  assert.equal(await root.locator('[data-summary-tag="tag-design"]').getAttribute('aria-pressed'),'true');
  assert.equal(await root.locator('[data-summary-tag="tag-meeting"]').getAttribute('aria-pressed'),'true');
  assert.equal(await total(),'4時間30分','reordering preserves the selected union');
  await root.locator('[data-summary-tag-page="1"]').click();
  assert.deepEqual(await visibleTags(),['extra-0','unlisted'],'pagination keeps unconfigured tags accessible');
  await root.locator('[data-summary-tag-page="-1"]').click();

  await root.locator('[data-summary-shift="-1"]').click();
  assert.deepEqual((await visibleTags()).slice(0,2),['tag-meeting','tag-design'],'previous month uses its own order');
  await root.locator('[data-summary-period="year"]').click();
  assert.deepEqual((await visibleTags()).slice(0,2),['tag-meeting','tag-design'],'annual view uses its settings seed month');
  await root.locator('[data-settings-btn]').click();
  await settings.locator('[data-settings-tab="tags"]').click();
  assert.match(await settings.locator('[data-tagmgr-month]').innerText(),/2026.*9/);
  assert.deepEqual((await rows()).slice(0,2),['tag-meeting','tag-design']);
  await settings.locator('[data-settings-cancel]').click();
  await root.locator('[data-summary-shift="-1"]').click();
  assert.deepEqual((await visibleTags()).slice(0,2),['tag-design','tag-meeting'],'annual navigation uses the displayed year');

  await h.page.reload();
  await h.page.locator('[data-view="calendar"]:not([hidden])').waitFor();
  await h.page.locator('nav [data-nav-target="summary"]').click();
  await root.locator('[data-summary-tag]').first().waitFor();
  assert.deepEqual(await visibleTags(),rearranged.slice(0,10),'reordering remains after reload');
  assert.deepEqual(h.pageErrors,[]);
  assert.deepEqual(h.unexpectedRequests,[]);
  console.log('PASS: settings reorder, month/year selection, paging, selected totals and reload');
} finally {
  await h.close();
}
