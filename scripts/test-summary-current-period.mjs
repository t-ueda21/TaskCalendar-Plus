// Actual renderer in isolated Chromium. All data and native/API responses are synthetic.
// This never launches Tauri/WebView2 or reads the user's calendar or settings.
import assert from 'node:assert/strict';
import { openHarness } from './refactor-20261008-harness.mjs';

const h = await openHarness();
h.page.setDefaultTimeout(5000);
const root = h.page.locator('[data-view="summary"]');
const PERIOD = '[data-summary-period-label]';

async function go(view) {
  await h.page.locator(`nav.nav [data-nav-target="${view}"]`).click();
  await h.page.locator(`[data-view="${view}"]:not([hidden])`).waitFor();
  await h.page.evaluate(() => document.fonts.ready);
}

async function chrome(view) {
  return h.page.evaluate(view => {
    const active = document.querySelector(`[data-view="${view}"]`);
    const nodes = [...['.header', '.header .nav', '.header h1'].map(s => [s, document.querySelector(s)]),
      ...['calendar', 'tasks', 'ai', 'summary'].map(id => [id, document.querySelector(`nav.nav [data-nav-target="${id}"]`)]),
      ['toolbar', active.querySelector('.toolbar')],
      ...['outlook-open', 'update-open', 'settings-btn'].map(id => [id, active.querySelector(`[data-${id}]`)])];
    return nodes.map(([name, node]) => {
      const r = node.getBoundingClientRect(), s = getComputedStyle(node);
      return { name, x:r.x, y:r.y, width:r.width, height:r.height, font:parseFloat(s.fontSize) };
    });
  }, view);
}

function sameChrome(actual, reference, label) {
  assert.equal(actual.length, reference.length);
  for (let i = 0; i < actual.length; i++) for (const key of ['x', 'y', 'width', 'height', 'font']) {
    assert.ok(Math.abs(actual[i][key] - reference[i][key]) <= 1,
      `${label}: shared ${actual[i].name} ${key} changed (${reference[i][key]} -> ${actual[i][key]})`);
  }
}

async function noOverflow(label) {
  const issues = await h.page.evaluate(() => {
    const selectors = ['.container', '.summaryScreen', '.summaryToolbar', '.summaryToolbar .left',
      '.summaryMetrics', '.summaryContent', '.summaryTrend', '.summaryChart', '.summaryNumbers',
      '.summaryNumberGrid', '.summarySide', '.summaryTags', '.summaryInsights'];
    return selectors.flatMap(selector => {
      const el = document.querySelector(selector), r = el.getBoundingClientRect(), style = getComputedStyle(el);
      if (!r.width || !r.height) return [`${selector} is not visible`];
      const issues = [];
      const toleranceY = ['auto','scroll'].includes(style.overflowY) ? 0 : 1;
      const toleranceX = ['auto','scroll'].includes(style.overflowX) ? 0 : 1;
      if (el.scrollHeight > el.clientHeight + toleranceY) issues.push(`${selector} vertical overflow: ${el.scrollHeight}/${el.clientHeight}`);
      if (el.scrollWidth > el.clientWidth + toleranceX) issues.push(`${selector} horizontal overflow: ${el.scrollWidth}/${el.clientWidth}`);
      if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) {
        issues.push(`${selector} extends outside viewport`);
      }
      return issues;
    });
  });
  assert.deepEqual(issues, [], label);
}

async function periodDisplay(expected) {
  const caption = root.locator('[data-i18n="summary.viewingPeriod"]');
  assert.equal(await caption.innerText(), '表示中');
  assert.equal(await caption.isVisible(), true);
  assert.equal(await root.locator(PERIOD).innerText(), expected);
  const display = await root.locator(PERIOD).evaluate(node => {
    const s = getComputedStyle(node), r = node.getBoundingClientRect();
    return { font:parseFloat(s.fontSize), weight:Number(s.fontWeight), visible:r.width > 0 && r.height > 0 };
  });
  assert.ok(display.font >= 18 && display.weight >= 600 && display.visible,
    `Displayed period ${expected} must be visibly emphasized at 18px or larger`);
}

async function returnCurrent(period, expected, label) {
  await root.locator(`[data-summary-period="${period}"]`).click();
  await root.locator('[data-summary-current]').click();
  await root.locator('[data-summary-shift="-1"]').click();
  assert.equal(await root.locator(PERIOD).innerText(), period === 'month' ? '2026年9月' : '2025年');
  await noOverflow(label + ' previous empty period');
  await root.locator('[data-summary-current]').click();
  assert.equal(await root.locator(PERIOD).innerText(), expected);
  // This must catch an internal canvas scrollbar, even when the document itself does not scroll.
  await noOverflow(label + ' returning to current period');
  await periodDisplay(expected);
  assert.equal(await root.locator('[data-summary-day]').count(), period === 'month' ? 31 : 12);
}

try {
  for (let index = 0; index < 8; index++) await h.page.request.post(h.origin + '/api/tags', {
    data:{ id:'period-tag-' + index, name:'タグ ' + (index + 1), color:'#658f79' },
  });
  const tags = h.state().tags;
  h.setTasks(Array.from({length:31}, (_, index) => ({
    id:'period-day-' + (index + 1), title:'月切り替えの表示確認',
    date:`2026-10-${String(index + 1).padStart(2, '0')}`, tagId:tags[index % tags.length].id,
    startTime:index % 4 === 0 ? '08:00' : '09:00', endTime:index % 4 === 0 ? '20:30' : '17:30',
    isAllDay:false, recurrence:{type:'none'},
  })));
  await h.boot();
  for (const viewport of [{width:1366,height:768}, {width:1264,height:761}, {width:1280,height:800}]) {
    await h.page.setViewportSize(viewport);
    const references = {};
    for (const view of ['calendar', 'tasks', 'ai']) { await go(view); references[view] = await chrome(view); }
    await go('summary');
    await root.locator('[data-summary-tag]').first().waitFor();
    const label = `${viewport.width}x${viewport.height}`;
    // Ten tags plus the longest-day insight wrapping onto two lines triggered the original failure.
    await returnCurrent('month', '2026年10月', label + ' all tags/month');
    assert.equal(await root.locator('[data-summary-tag]').count(), 10);
    const longest = root.locator('.summaryInsight').nth(1);
    assert.ok((await longest.innerText()).includes('11時間30分'), 'Fixture must retain the long maximum-day duration');
    assert.ok((await longest.innerText()).includes('3時間30分'), 'Fixture must retain the long outside-hours duration');
    await returnCurrent('year', '2026年', label + ' all tags/year');
    await root.locator('[data-summary-tag]').first().click();
    await root.locator('[data-summary-tag]').nth(1).click();
    assert.equal(await root.locator('[data-summary-tag][aria-pressed="true"]').count(), 2);
    await returnCurrent('month', '2026年10月', label + ' filtered/month');
    await returnCurrent('year', '2026年', label + ' filtered/year');
    await root.locator('[data-summary-all-tags]').click();
    await returnCurrent('month', '2026年10月', label + ' restored all tags/month');
    const actual = await chrome('summary');
    for (const view of ['calendar', 'tasks', 'ai']) sameChrome(actual, references[view], label + ' vs ' + view);
  }
  // Short windows intentionally scroll; keep their controls accessible without hiding overflow.
  await h.page.setViewportSize({width:1280,height:720});
  await root.locator('[data-summary-shift="-1"]').click();
  await root.locator('[data-summary-current]').click();
  await periodDisplay('2026年10月');
  await root.locator('[data-summary-day="2026-10-08"]').click();
  assert.equal(await root.locator('[data-summary-day="2026-10-08"]').getAttribute('aria-pressed'), 'true');
  await root.locator('[data-summary-tag]').last().click();
  assert.equal(await root.locator('[data-summary-tag]').last().getAttribute('aria-pressed'), 'true');
  const shortWindowHorizontalOverflow = await h.page.evaluate(() => ['.container', '.summaryScreen', '.summaryToolbar .left']
    .filter(selector => { const e = document.querySelector(selector); return e.scrollWidth > e.clientWidth + 1; }));
  assert.deepEqual(shortWindowHorizontalOverflow, [], 'Short-window fallback must remain horizontally usable');
  assert.deepEqual(h.pageErrors, []);
  assert.deepEqual(h.unexpectedRequests, []);
  console.log('PASS: current month/year transitions, filtered and full 10-tag views, visible period label and shared chrome at 1366x768, 1264x761 and 1280x800');
} finally {
  await h.close();
}
