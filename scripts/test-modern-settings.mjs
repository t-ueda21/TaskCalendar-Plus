import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openHarness } from './refactor-20261008-harness.mjs';
import { assertSettingsArchitecture } from './refactor-20261008-settings-contract.mjs';

const h = await openHarness();
const page = h.page;
try {
  await h.boot();
  await page.evaluate(async () => { window.dialogs = await import('/src/app-dialogs.js'); });
  const opener = page.locator('[data-view="calendar"] [data-settings-btn]');
  await opener.click();
  const settings = page.locator('[data-settings-dialog]');
  const fields = await page.evaluate(html => {
    const original = new DOMParser().parseFromString(html,'text/html').querySelector('[data-settings-dialog]');
    const names = root => [...root.querySelectorAll('[name]')].map(node => node.name).sort();
    return {before:names(original),after:names(document.querySelector('[data-settings-dialog]'))};
  },fs.readFileSync('src-tauri/renderer/assets/app.html','utf8'));
  assert.deepEqual(fields.after, fields.before, 'every existing named setting is retained exactly once');
  await assertSettingsArchitecture(settings);
  await settings.locator('[data-settings-tab="shortcuts"]').click();
  await settings.locator('.settingsDialogBody').evaluate(node => { node.scrollTop = 250; });
  await settings.locator('[data-settings-tab="display"]').click();
  assert.equal(await settings.locator('.settingsDialogBody').evaluate(node => node.scrollTop), 0);
  await settings.locator('[data-settings-tab="display"]').focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.settingsTab), 'work');
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.settingsTab), 'info');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.settingsTab), 'display');
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.settingsTab), 'info');
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.settingsTab), 'display');

  await settings.locator('[data-settings-save]').focus();
  await page.evaluate(() => { window.result = undefined; window.dialogs.showAppConfirm('Keep settings open?').then(value => { window.result = value; }); });
  await page.locator('[data-app-dialog][open]').waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.result === false);
  assert.equal(await settings.evaluate(node => node.open), true);
  assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-settings-save')), true);

  await page.evaluate(() => { window.result = undefined; window.dialogs.showAppConfirm('Backdrop cancel').then(value => { window.result = value; }); });
  await page.locator('[data-app-dialog][open]').waitFor();
  await page.mouse.click(2,2);
  await page.waitForFunction(() => window.result === false);
  assert.equal(await settings.evaluate(node => node.open), true);
  assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-settings-save')), true);
  await page.keyboard.press('Escape');

  await page.evaluate(() => {
    window.results = [];
    window.dialogs.showAppConfirm('First').then(value => window.results.push(value));
    window.dialogs.showAppConfirm('Second').then(value => window.results.push(value));
  });
  await page.locator('[data-app-dialog-message]').filter({hasText:'First'}).waitFor();
  await page.locator('[data-app-dialog-cancel]').click();
  await page.locator('[data-app-dialog-message]').filter({hasText:'Second'}).waitFor();
  await page.locator('[data-app-dialog-confirm]').click();
  await page.waitForFunction(() => window.results.length === 2);
  assert.deepEqual(await page.evaluate(() => window.results), [false,true]);

  await opener.click();
  await settings.locator('[data-settings-tab="display"]').click();
  await settings.locator('[name="granularity"]').selectOption('15');
  await settings.locator('[data-settings-cancel]').click();
  assert.equal(h.state().settings.granularity,30,'cancel does not save form changes');
  await opener.click();
  await settings.locator('[name="granularity"]').selectOption('15');
  await settings.locator('[data-settings-save]').click();
  await settings.waitFor({state:'hidden'});
  assert.equal(h.state().settings.granularity,15,'reorganized controls save through the existing settings path');

  await opener.click();
  await settings.locator('[name="granularity"]').selectOption('60');
  await page.route('**/api/settings', route => route.request().method() === 'PUT'
    ? route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Synthetic save failure'})})
    : route.continue());
  await settings.locator('[data-settings-save]').click();
  await page.locator('[data-app-dialog][data-tone="error"]').waitFor();
  assert.equal(await settings.evaluate(node => node.open),true,'save failure keeps the settings dialog open');
  assert.equal(await settings.locator('[name="granularity"]').inputValue(),'60','save failure keeps the edited values');
  await page.locator('[data-app-dialog-confirm]').click();
  await page.locator('[data-settings-save]:not([disabled])').waitFor();
  await page.unroute('**/api/settings');
  await settings.locator('[data-settings-cancel]').click();
  assert.equal(h.state().settings.granularity,15);

  await page.evaluate(() => { window.scope = undefined; window.dialogs.chooseRecurrenceScope({operation:'delete',count:3}).then(value => { window.scope = value; }); });
  await page.locator('[data-app-dialog-scope="future"]').check();
  await page.locator('[data-app-dialog-scope="future"]').focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-app-dialog-confirm')),true,'scope focus wraps from the checked radio to the last action');
  await page.locator('[data-app-dialog-confirm]').click();
  await page.waitForFunction(() => window.scope === 'future');

  await page.evaluate(() => {
    window.calls = 0; window.result = undefined;
    window.dialogs.showAppConfirm('Run once', {onConfirm:async () => {
      window.calls++;
      await new Promise(resolve => { window.releaseAction = resolve; });
      if (window.calls === 1) throw new Error('Try again');
    }}).then(value => { window.result = value; });
  });
  await page.locator('[data-app-dialog-confirm]').click();
  assert.equal(await page.locator('[data-app-dialog-confirm]').isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-app-dialog]').evaluate(node => node.open), true);
  await page.evaluate(() => window.releaseAction());
  await page.locator('[data-app-dialog-error]').filter({hasText:'Try again'}).waitFor();
  await page.locator('[data-app-dialog-confirm]').click();
  await page.evaluate(() => window.releaseAction());
  await page.waitForFunction(() => window.result === true);
  assert.equal(await page.evaluate(() => window.calls), 2);

  await page.evaluate(() => { window.dialogs.showAppAlert('<img src=x onerror=alert(1)>', {tone:'error'}); });
  assert.equal(await page.locator('[data-app-dialog-message]').innerText(), '<img src=x onerror=alert(1)>');
  assert.equal(await page.locator('[data-app-dialog-message] img').count(), 0);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('[data-app-dialog]')), true);
  await page.keyboard.press('Escape');

  await opener.click();
  await settings.locator('[data-settings-tab="tags"]').click();
  await settings.locator('[data-tag-row="tag-design"] .settingsDeleteBtn').click();
  await page.locator('[data-app-dialog-cancel]').click();
  assert.ok(h.state().settings.monthTagOrders['2026-10'].includes('tag-design'));
  await settings.locator('[data-tag-row="tag-design"] .settingsDeleteBtn').click();
  await page.locator('[data-app-dialog-confirm]').click();
  await page.locator('[data-app-dialog]').waitFor({state:'detached'});
  assert.ok(!h.state().settings.monthTagOrders['2026-10'].includes('tag-design'));
  assert.ok(h.state().tags.some(tag => tag.id === 'tag-design'),'month removal preserves the tag and its task references');
  assert.ok(h.state().tasks.some(task => task.tagId === 'tag-design'));
  await page.keyboard.press('Escape');

  await opener.click();
  await settings.locator('[data-settings-tab="data"]').click();
  await settings.locator('[data-settings-import-file]').setInputFiles({name:'synthetic-settings.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({format:'taskcalendar-plus-settings',version:1,settings:{granularity:60},tags:[]}))});
  await page.locator('[data-settings-import-btn]:not([disabled])').waitFor();
  await settings.locator('[data-settings-import-btn]').click();
  await page.locator('[data-app-dialog-cancel]').click();
  assert.equal(h.state().settings.granularity,15,'cancelled import does not replace settings');
  assert.equal(await settings.evaluate(node => node.open),true);
  await page.keyboard.press('Escape');
  assert.deepEqual(h.pageErrors, []);
  console.log('PASS: eleven setting pages, complete control ownership, ARIA navigation, nested modal cancellation, queue, scope, busy retry and text safety');
} finally { await h.close(); }
