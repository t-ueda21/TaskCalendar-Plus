// Real renderer in isolated Chromium; API, native bridge and data are synthetic.
// This test never starts Tauri/WebView2 or touches live Outlook/user data.
import assert from 'node:assert/strict';
import { openHarness } from './refactor-20261008-harness.mjs';

const h = await openHarness();
h.page.setDefaultTimeout(5000);
const failures = [];
const checked = [];
async function check(name, verify) {
  try { await verify(); checked.push(name); }
  catch (error) { failures.push({ name, message: error.message }); }
}

try {
  h.setTasks([...h.state().tasks, {
    id: 'summary-keyboard-september', title: '検証用の9月の予定',
    date: '2026-09-08', startTime: '09:00', endTime: '10:00',
    tagId: 'tag-design', isAllDay: false, recurrence: { type: 'none' },
  }]);
  await h.boot();
  await h.page.locator('nav [data-nav-target="summary"]').click();
  const root = h.page.locator('[data-view="summary"]');
  const total = () => root.locator('[data-summary-metric="total"] [data-metric-value]')
    .textContent().then(value => value.replace(/\s/g, ''));
  const allTags = root.locator('[data-summary-all-tags]');

  await root.locator('[data-summary-tag="tag-design"]').click();
  await check('first tag narrows to that tag', async () => {
    assert.equal(await total(), '3時間30分');
    assert.equal(await root.locator('[data-summary-tag][aria-pressed="true"]').count(), 1);
  });
  await root.locator('[data-summary-tag="tag-meeting"]').click();
  await check('selecting every tag preserves explicit selection and tag legends', async () => {
    const actual = await root.evaluate(el => ({
      selected: [...el.querySelectorAll('[data-summary-tag][aria-pressed="true"]')]
        .map(node => node.dataset.summaryTag),
      all: el.querySelector('[data-summary-all-tags]').getAttribute('aria-pressed'),
      legends: [...el.querySelectorAll('[data-summary-legend] span')]
        .filter(node => ['設計', '打ち合わせ'].includes(node.textContent.trim()))
        .map(node => ({ name: node.textContent.trim(), color: getComputedStyle(node.querySelector('i')).backgroundColor })),
    }));
    assert.deepEqual(actual, {
      selected: ['tag-design', 'tag-meeting'], all: 'false',
      legends: [
        { name: '設計', color: 'rgb(79, 126, 220)' },
        { name: '打ち合わせ', color: 'rgb(225, 149, 65)' },
      ],
    });
    assert.equal(await total(), '4時間30分', 'selection must not change the summed time');
  });
  await allTags.click();
  await check('explicit reset restores All', async () => {
    assert.equal(await allTags.getAttribute('aria-pressed'), 'true');
    assert.equal(await root.locator('[data-summary-tag][aria-pressed="true"]').count(), 0);
    assert.equal(await total(), '4時間30分');
  });
  await root.locator('[data-summary-tag="tag-design"]').click();
  await root.locator('[data-summary-tag="tag-design"]').click();
  await check('deselecting the last tag retains the existing reset behavior', async () => {
    assert.equal(await allTags.getAttribute('aria-pressed'), 'true');
    assert.equal(await total(), '4時間30分');
  });

  await root.locator('[data-summary-period="year"]').click();
  await root.locator('[data-summary-day="2026-09"]').focus();
  await h.page.keyboard.press('Enter');
  await check('keyboard month drilldown moves focus to the selected day', async () => {
    assert.match(await root.locator('[data-summary-period-label]').textContent(), /2026.*9/);
    const selection = await root.evaluate(el => ({
      selected: el.querySelector('[data-summary-day][aria-pressed="true"]')?.dataset.summaryDay,
      focused: document.activeElement?.getAttribute('data-summary-day'),
      pressed: document.activeElement?.getAttribute('aria-pressed'),
    }));
    assert.deepEqual(selection, {
      selected: '2026-09-08', focused: '2026-09-08', pressed: 'true',
    });
    assert.equal(await total(), '1時間0分');
  });

  const selection = () => root.evaluate(el => ({
    selected: el.querySelector('[data-summary-day][aria-pressed="true"]')?.dataset.summaryDay,
    graph: el.querySelector('[data-summary-bar][aria-pressed="true"]')?.dataset.summaryBar,
    focused: document.activeElement?.getAttribute('data-summary-day'),
  }));
  async function expectSelection(key) {
    assert.deepEqual(await selection(), { selected: key, graph: key, focused: key });
  }
  await check('one date-grid Tab stop replaces duplicated chart and date stops', async () => {
    const stops = await root.evaluate(el => ({
      chart: [...el.querySelectorAll('[data-summary-bar]')].filter(node => !node.disabled && node.tabIndex >= 0).length,
      days: [...el.querySelectorAll('[data-summary-day]')].filter(node => !node.disabled && node.tabIndex >= 0)
        .map(node => node.dataset.summaryDay),
    }));
    assert.deepEqual(stops, { chart: 0, days: ['2026-09-08'] });
  });
  await check('monthly arrows move across the 11-column grid and synchronize the graph', async () => {
    await root.locator('[data-summary-day="2026-09-08"]').click();
    for (const [key, day] of [
      ['ArrowRight', '09'], ['ArrowDown', '20'], ['ArrowUp', '09'], ['ArrowLeft', '08'],
      ['Home', '01'], ['End', '30'], ['ArrowRight', '30'],
    ]) {
      await h.page.keyboard.press(key);
      await expectSelection(`2026-09-${day}`);
    }
  });
  await check('Tab leaves the date grid for the tag controls in one step', async () => {
    await root.locator('[data-summary-day="2026-09-08"]').click();
    await h.page.keyboard.press('Tab');
    assert.equal(await allTags.evaluate(node => document.activeElement === node), true);
  });
  await check('modified arrows do not change the selected day', async () => {
    await root.locator('[data-summary-day="2026-09-08"]').click();
    await h.page.keyboard.press('Control+ArrowRight');
    await expectSelection('2026-09-08');
  });
  await check('year arrows use six columns and Enter alone opens the selected month', async () => {
    await root.locator('[data-summary-period="year"]').click();
    await root.locator('[data-summary-day="2026-10"]').focus();
    for (const [key, month] of [
      ['Home', '01'], ['ArrowRight', '02'], ['ArrowDown', '08'], ['ArrowUp', '02'],
      ['End', '10'], ['ArrowRight', '10'],
    ]) {
      await h.page.keyboard.press(key);
      assert.equal(await root.locator('[data-summary-period="year"]').getAttribute('aria-pressed'), 'true');
      await expectSelection(`2026-${month}`);
    }
    await h.page.keyboard.press('Enter');
    assert.equal(await root.locator('[data-summary-period="month"]').getAttribute('aria-pressed'), 'true');
    await expectSelection('2026-10-08');
  });
  await check('keyboard navigation stops before excluded future days', async () => {
    await root.locator('[data-summary-period="month"]').click();
    await root.locator('[data-summary-current]').click();
    await root.locator('[data-summary-day="2026-10-08"]').click();
    assert.equal(await root.locator('[data-summary-day="2026-10-09"]').isDisabled(), true);
    await h.page.keyboard.press('ArrowRight');
    await expectSelection('2026-10-08');
    await h.page.keyboard.press('Home');
    await expectSelection('2026-10-01');
    await h.page.keyboard.press('End');
    await expectSelection('2026-10-08');
    assert.equal(await root.locator('[data-summary-day]:disabled').evaluateAll(nodes => nodes.some(node => node.tabIndex >= 0)), false);
  });
  await check('excluding a selected future day restores an active keyboard entry point', async () => {
    const futureToggle = root.locator('.uiToggle:has([data-summary-future])');
    await futureToggle.click();
    await root.locator('[data-summary-day="2026-10-08"]').focus();
    await h.page.keyboard.press('End');
    await expectSelection('2026-10-31');
    await futureToggle.click();
    assert.deepEqual(await root.locator('[data-summary-day]').evaluateAll(nodes => nodes.filter(node => node.tabIndex === 0).map(node => node.dataset.summaryDay)), ['2026-10-08']);
    assert.equal(await root.locator('[data-summary-day="2026-10-08"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await root.locator('[data-summary-day="2026-10-31"]').isDisabled(), true);
  });
  await check('vertical movement follows the responsive ten-column grid', async () => {
    await root.locator('[data-summary-shift="-1"]').click();
    await h.page.setViewportSize({ width: 1000, height: 800 });
    assert.equal(await root.locator('[data-summary-number-grid]').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length), 10);
    await root.locator('[data-summary-day="2026-09-01"]').click();
    await h.page.keyboard.press('ArrowDown');
    await expectSelection('2026-09-11');
    await h.page.keyboard.press('ArrowUp');
    await expectSelection('2026-09-01');
  });
  assert.deepEqual(h.pageErrors, [], 'no renderer errors');
  assert.deepEqual(h.unexpectedRequests, [], 'no unexpected synthetic API requests');
  assert.deepEqual(failures, [], 'Summary interaction regression failures');
  console.log(JSON.stringify({ passed: checked, scope: h.meta.scope }));
} finally { await h.close(); }
