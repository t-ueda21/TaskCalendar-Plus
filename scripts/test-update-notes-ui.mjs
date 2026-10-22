// Actual update dialog and controller in isolated Chromium; the native updater is synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openHarness } from './refactor-20261008-harness.mjs';

const output = process.env.TCPLUS_UPDATE_EVIDENCE;
if (output) fs.mkdirSync(output, { recursive: true });
const html = fs.readFileSync('src-tauri/renderer/assets/app.html', 'utf8');
const dialog = html.match(/<dialog class="dialog updateDialog"[\s\S]*?<\/dialog>/)[0];
const notes = [
  '更新内容を読みやすくし、アプリ内部の処理を整理しました。', '',
  '## 使いやすさの改善', '',
  '- **更新内容が読みやすく**：見出しと箇条書きを整えました。',
  '- 長い説明はスクロールでき、更新ボタンは画面内に表示されます。', '',
  '## 安心して更新するために', '',
  '1. 開いている編集画面を保存してください。',
  '2. 更新が終わるとアプリが再起動します。', '',
  '[リリースの詳細](https://github.com/t-ueda21/TaskCalendar-Plus/releases)',
].join('\n');
const h = await openHarness();
try {
  await h.page.goto(h.origin + '/harness-empty.html');
  await h.page.setContent('<link rel="stylesheet" href="/assets/styles.css">' + dialog);
  await h.page.evaluate(async notes => {
    window.updateFixture = { notes, current: false, error: false, installs: 0 };
    const bridge = { core: { Channel: class {}, async invoke(command, args) {
      if (command === 'get_update_info') return { currentVersion: '3.0.3', installSupported: true };
      if (command === 'check_app_update') {
        if (updateFixture.error) throw Error('offline');
        return updateFixture.current ? null : { version: '3.0.4', notes: updateFixture.notes };
      }
      if (command === 'install_app_update') {
        updateFixture.installs++;
        args.onProgress.onmessage({ downloaded: 50, total: 100 });
        throw Error('synthetic signature failure');
      }
    } } };
    await (await import('/src/app-updater.js')).initAppUpdater({
      getSettings: () => ({ checkUpdatesOnStartup: true }),
    }, document, bridge);
    await document.fonts.ready;
  }, notes);
  const d = h.page.locator('[data-update-dialog]');
  const content = d.locator('[data-update-notes]');
  const check = async () => {
    await d.locator('[data-update-check]').click();
    await h.page.waitForFunction(() => !document.querySelector('[data-update-check]').disabled);
  };
  // Screenshots also capture the unformatted baseline when the semantic assertion fails.
  for (const [name, width, height, theme, locale] of [
    ['light', 1280, 800, 'light', 'ja'], ['dark', 1280, 800, 'dark', 'ja'],
    ['narrow', 390, 700, 'light', 'de'],
  ]) {
    await h.page.setViewportSize({ width, height });
    await h.page.evaluate(async ({ theme, locale }) => {
      document.documentElement.dataset.theme = theme;
      const i18n = await import('/src/i18n.js'); i18n.setLocale(locale); i18n.applyTranslations();
    }, { theme, locale });
    if (output) await h.page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' });
  }
  assert.equal(await content.locator('.mdHeading').count(), 2, 'release headings must be formatted, not raw ## text');
  assert.equal(await content.locator('ul > li').count(), 2);
  assert.equal(await content.locator('ol > li').count(), 2);
  assert.equal(await content.locator('strong').innerText(), '更新内容が読みやすく');
  assert.equal(await content.locator('a').getAttribute('href'), 'https://github.com/t-ueda21/TaskCalendar-Plus/releases');
  const bounds = await d.evaluate(el => {
    const r = el.getBoundingClientRect(), button = el.querySelector('[data-update-install]').getBoundingClientRect();
    return { x: r.x, right: r.right, bottom: r.bottom, top: r.top, buttonBottom: button.bottom, buttonRight: button.right, width: innerWidth, height: innerHeight };
  });
  assert.ok(bounds.x >= 12 && bounds.right <= bounds.width - 12 && bounds.top >= 12 && bounds.bottom <= bounds.height - 12, 'dialog must retain a viewport gutter');
  assert.ok(bounds.buttonBottom <= bounds.height - 12 && bounds.buttonRight <= bounds.width - 12, 'install action must remain reachable');
  await h.page.evaluate(() => { updateFixture.notes = '<script>window.unsafe = true</script>\n<img src=x onerror="window.unsafe=true">\n[x](javascript:alert(1))\n[quoted](https://example.com/\"onmouseover=bad)'; });
  await check();
  assert.equal(await content.locator('script,img,[onmouseover]').count(), 0, 'release HTML must not create executable elements or handlers');
  assert.equal(await h.page.evaluate(() => window.unsafe), undefined);
  assert.equal(await content.locator('a[href^="javascript:"]').count(), 0);
  await h.page.evaluate(() => { updateFixture.notes = '   '; });
  await check();
  assert.equal(await content.isVisible(), false, 'blank release notes must not leave an empty panel');
  assert.equal(await d.locator('.updateNotesHeading').isVisible(), false);
  await h.page.evaluate(() => { updateFixture.notes = Array(40).fill('## セクション\n- ' + '長い説明'.repeat(30)).join('\n\n'); });
  await check();
  assert.ok(await content.evaluate(el => el.scrollHeight > el.clientHeight), 'long notes must scroll');
  await content.focus(); await h.page.keyboard.press('End');
  await h.page.waitForFunction(() => document.querySelector('[data-update-notes]').scrollTop > 0);
  await d.locator('[data-update-install]').click();
  await h.page.waitForFunction(() => document.querySelector('[data-update-status]').textContent === 'synthetic signature failure');
  assert.equal(await d.locator('[data-update-install]').isEnabled(), true, 'install failure remains retryable');
  assert.equal(await content.locator('.mdHeading').count(), 40, 'notes remain after install failure');
  await h.page.evaluate(() => { updateFixture.current = true; }); await check();
  assert.equal(await content.isVisible(), false, 'current version must clear stale release notes');
  assert.equal(await d.locator('[data-update-install]').isVisible(), false);
  assert.deepEqual(h.pageErrors, []);
  console.log('PASS: readable release notes, light/dark/narrow layout, safe markup, empty/long content, keyboard scrolling, retry/current states');
} finally { await h.close(); }
