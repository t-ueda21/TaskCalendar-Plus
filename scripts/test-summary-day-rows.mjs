// Real renderer and layout; the existing harness supplies synthetic API/native data.
import assert from 'node:assert/strict';
import { openHarness } from './refactor-20261008-harness.mjs';

const h = await openHarness();
h.page.setDefaultTimeout(5000);
try {
  await h.boot();
  await h.page.locator('nav [data-nav-target="summary"]').click();
  const root = h.page.locator('[data-view="summary"]');
  let displayedYear = 2026;
  async function openMonth(year, month) {
    await root.locator('[data-summary-period="year"]').click();
    while (displayedYear !== year) {
      const direction = year > displayedYear ? 1 : -1;
      await root.locator(`[data-summary-shift="${direction}"]`).click();
      displayedYear += direction;
    }
    await root.locator(`[data-summary-day="${year}-${month}"]`).click();
  }
  async function dateRows() {
    return root.locator('[data-summary-day]').evaluateAll(nodes => {
      const rows = [];
      for (const node of nodes) {
        const top = node.getBoundingClientRect().top;
        let row = rows.find(row => Math.abs(row.top - top) < 1);
        if (!row) rows.push(row = { top, days: [] });
        row.days.push(Number(node.dataset.summaryDay.slice(8)));
      }
      return rows.map(row => row.days);
    });
  }
  for (const [year, month, lastDay] of [[2026, '10', 31], [2026, '09', 30], [2026, '02', 28], [2024, '02', 29]]) {
    await openMonth(year, month);
    for (const width of [1280, 1366, 1920, 1000, 800]) {
      await h.page.setViewportSize({ width, height: 800 });
      const rows = await dateRows();
      assert.deepEqual(rows.map(row => [row[0], row.at(-1), row.length]),
        [[1, 10, 10], [11, 20, 10], [21, lastDay, lastDay - 20]], `${year}-${month} at ${width}px`);
      assert.deepEqual(rows.flat(), Array.from({ length: lastDay }, (_, index) => index + 1), 'every date appears once in order');
    }
  }
  await openMonth(2026, '10');
  await root.locator('.uiToggle:has([data-summary-future])').click();
  await h.page.setViewportSize({ width: 1280, height: 800 });
  await root.locator('[data-summary-day="2026-10-10"]').click();
  for (const [key, day] of [['ArrowDown', '20'], ['ArrowDown', '30'], ['ArrowRight', '31'],
    ['ArrowUp', '20'], ['ArrowUp', '10'], ['ArrowUp', '10']]) {
    await h.page.keyboard.press(key);
    assert.equal(await h.page.evaluate(() => document.activeElement?.dataset.summaryDay), `2026-10-${day}`);
    assert.equal(await root.locator('[data-summary-bar][aria-pressed="true"]').getAttribute('data-summary-bar'), `2026-10-${day}`);
  }
  for (const locale of ['en', 'fr', 'pt', 'ja']) {
    await h.page.evaluate(async locale => { await (await import('/src/store.js')).updateSettings({ uiLanguage: locale }); }, locale);
    for (const width of [500, 601, 650, 767]) {
      await h.page.setViewportSize({ width, height: 800 });
      const overhangingLabels = await root.locator('[data-summary-day]').evaluateAll(nodes => nodes.flatMap(node => {
        const box = node.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(node.querySelector('.summaryDayLabel'));
        const text = range.getBoundingClientRect();
        return text.left < box.left || text.right > box.right ? [node.dataset.summaryDay] : [];
      }));
      assert.deepEqual(overhangingLabels, [], `${locale} at ${width}px: date labels stay inside their cells`);
      const compactRows = await dateRows();
      assert.ok(compactRows.every(row => row.length <= 4), 'small screens keep readable cells');
      assert.ok(compactRows.some(row => row[0] === 11) && compactRows.some(row => row[0] === 21), 'each ten-day group starts on a new row on small screens too');
    }
  }
  await h.page.setViewportSize({ width: 768, height: 800 });
  assert.deepEqual((await dateRows()).map(row => row.length), [10, 10, 11], 'three groups fit above the compact breakpoint');
  await h.page.setViewportSize({ width: 500, height: 800 });
  await root.locator('[data-summary-day="2026-10-11"]').click();
  await h.page.keyboard.press('ArrowDown');
  assert.equal(await h.page.evaluate(() => document.activeElement?.dataset.summaryDay), '2026-10-15');
  assert.deepEqual(h.pageErrors, []);
  assert.deepEqual(h.unexpectedRequests, []);
  console.log('PASS: 1–10 / 11–20 / 21–month end for 28–31 day months, responsive layout and keyboard row navigation');
} finally { await h.close(); }
