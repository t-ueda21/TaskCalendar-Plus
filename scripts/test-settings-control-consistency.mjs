// Real renderer with synthetic settings, API and native bridge only.
import assert from 'node:assert/strict';
import { openHarness } from './refactor-20261008-harness.mjs';
const h = await openHarness();
const p = h.page;
p.setDefaultTimeout(5000);
try {
  await h.boot();
  await p.locator('[data-view="calendar"] [data-settings-btn]').click();
  const dialog = p.locator('[data-settings-dialog]');
  await dialog.waitFor({ state: 'visible' });
  for (const [tab, setting] of [['updates', 'checkUpdatesOnStartup'], ['outlook', 'outlookAutoSync']]) {
    await dialog.locator(`[data-settings-tab="${tab}"]`).click();
    const toggle = dialog.locator(`[data-setting-toggle="${setting}"]`);
    await toggle.scrollIntoViewIfNeeded();
    const geometry = await toggle.evaluate(el => {
      const label = el.querySelector('.themeToggleLabel').getBoundingClientRect();
      const track = el.querySelector('.themeToggleTrack').getBoundingClientRect();
      const container = el.getBoundingClientRect();
      return { labelRight: label.right, trackLeft: track.left, trackRight: track.right, containerRight: container.right };
    });
    assert.ok(geometry.labelRight < geometry.trackLeft,
      `${setting}: label stays left of shared switch track: ${JSON.stringify(geometry)}`);
    const input = toggle.locator('input');
    const checked = await input.isChecked();
    await toggle.click();
    assert.equal(await input.isChecked(), !checked, `${setting}: label toggles state`);
    await input.focus();
    await p.keyboard.press('Space');
    assert.equal(await input.isChecked(), checked, `${setting}: keyboard toggles state back`);
  }
  await p.setViewportSize({ width: 600, height: 900 });
  await dialog.locator('[data-settings-tab="tags"]').click();
  const fields = dialog.locator('.settingsTagRow .settingsTagBudgetInput');
  const measured = await fields.evaluateAll(nodes => nodes.map(el => {
    const style = getComputedStyle(el), box = el.getBoundingClientRect();
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const innerWidth = box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
    return { value: el.value, width: box.width, innerWidth, textWidth: context.measureText(el.value || '—').width };
  }));
  assert.ok(measured.length > 0);
  for (const field of measured) {
    assert.ok(field.width >= 62, `narrow budget fields retain the desktop minimum readable width: ${JSON.stringify(field)}`);
    assert.ok(field.innerWidth >= field.textWidth + 2, `budget value is not clipped: ${JSON.stringify(field)}`);
  }
  const rows = await dialog.locator('.settingsTagRow').evaluateAll(nodes => nodes.map(row => {
    const box = row.getBoundingClientRect();
    const children = [...row.children].map(el => el.getBoundingClientRect());
    return children.every(r => r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom);
  }));
  assert.ok(rows.every(Boolean), 'narrow tag controls stay in their rows');
  assert.deepEqual(h.pageErrors, []);
  console.log('PASS settings consistency: label/track order, pointer/keyboard toggle, readable narrow tag limits');
} finally { await h.close(); }
