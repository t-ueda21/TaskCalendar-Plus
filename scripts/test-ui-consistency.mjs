// Actual renderer with synthetic API/native/weather; no native app or live integrations.
import assert from 'node:assert/strict';
import { openHarness } from './refactor-20261008-harness.mjs';

const h = await openHarness();
const page = h.page;
page.setDefaultTimeout(5000);
const view = name => page.locator(`[data-view="${name}"]`);
async function go(name) {
  await page.locator(`nav.nav [data-nav-target="${name}"]`).click();
  await view(name).filter({ visible: true }).waitFor();
}
async function style(locator) {
  return locator.evaluate(el => {
    const computed = getComputedStyle(el), box = el.getBoundingClientRect();
    return { width: box.width, height: box.height, fontSize: computed.fontSize,
      paddingLeft: computed.paddingLeft, paddingRight: computed.paddingRight,
      borderRadius: computed.borderRadius, background: computed.backgroundColor };
  });
}

try {
  await h.boot();
  // Four pages must stay in one consistent navigation row below the old three-tab breakpoint.
  await page.setViewportSize({ width: 720, height: 800 });
  for (const name of ['calendar', 'tasks', 'ai', 'summary']) {
    await go(name);
    const tabs = await page.locator('nav.nav [data-nav-target]').evaluateAll(nodes => nodes.map(node => {
      const r = node.getBoundingClientRect();
      return { name: node.dataset.navTarget, x: r.x, y: r.y, width: r.width, right: r.right };
    }));
    assert.equal(tabs.length, 4);
    assert.ok(tabs.every(tab => Math.abs(tab.y - tabs[0].y) <= 1),
      `${name}: all four navigation tabs must stay in one row at 720px: ${JSON.stringify(tabs)}`);
    assert.ok(tabs.every(tab => tab.x >= 0 && tab.right <= 720), `${name}: navigation stays within viewport`);
    const active = page.locator(`nav.nav [data-nav-target="${name}"]`);
    assert.equal(await active.getAttribute('aria-current'), 'page');
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await go('calendar');
  const calendarToggle = view('calendar').locator('.uiToggle').filter({ has: page.locator('[data-businessdays-only]') });
  const referenceTrack = await style(calendarToggle.locator('.themeToggleTrack'));
  const referenceThumb = await style(calendarToggle.locator('.themeToggleThumb'));
  const referencePeriodButton = await style(view('calendar').locator('[data-shift-prev]'));
  await go('summary');
  const futureInput = view('summary').locator('[data-summary-future]');
  assert.equal(await futureInput.getAttribute('role'), 'switch', 'future filtering uses the shared switch semantics');
  const futureToggle = view('summary').locator('.uiToggle').filter({ has: page.locator('[data-summary-future]') });
  const futureTrack = await style(futureToggle.locator('.themeToggleTrack'));
  const futureThumb = await style(futureToggle.locator('.themeToggleThumb'));
  for (const key of ['width', 'height', 'borderRadius']) {
    assert.equal(futureTrack[key], referenceTrack[key], `future switch track ${key} matches calendar switch`);
    assert.equal(futureThumb[key], referenceThumb[key], `future switch thumb ${key} matches calendar switch`);
  }
  const futureBefore = await futureInput.isChecked();
  await futureToggle.click();
  assert.equal(await futureInput.isChecked(), !futureBefore, 'shared switch label toggles the filter');
  await futureInput.focus();
  await page.keyboard.press('Space');
  assert.equal(await futureInput.isChecked(), futureBefore, 'shared switch supports keyboard toggling');
  assert.ok(await futureInput.evaluate(el => el.matches(':focus-visible')), 'keyboard switch focus remains visible');

  assert.equal(await view('summary').locator('[data-summary-config],[data-summary-options]').count(), 0,
    'removed metric configuration must not leave a button or dialog');
  assert.equal(await view('summary').locator('[data-summary-metric]').count(), 6, 'all six metrics are shown');
  for (const period of ['month', 'year']) {
    await view('summary').locator(`[data-summary-period="${period}"]`).click();
    const labels = period === 'month' ? ['前月', '翌月'] : ['前年', '翌年'];
    for (const [index, shift] of [-1, 1].entries()) {
      const button = view('summary').locator(`[data-summary-shift="${shift}"]`);
      assert.ok(await button.evaluate(el => el.classList.contains('titleNavBtn')), 'period navigation uses shared titleNavBtn');
      const current = await style(button);
      for (const key of ['width', 'height', 'fontSize', 'paddingLeft', 'paddingRight', 'borderRadius']) {
        assert.equal(current[key], referencePeriodButton[key], `Summary ${period} shift ${shift} ${key} matches existing date navigation`);
      }
      assert.equal(await button.locator('[data-nav-label]').innerText(), labels[index], 'action is visibly described');
      assert.equal(await button.locator('[aria-hidden="true"]').innerText(), shift < 0 ? '◀' : '▶', 'same decorative direction icon');
    }
  }
  assert.deepEqual(h.pageErrors, [], 'no renderer runtime errors');
  assert.deepEqual(h.unexpectedRequests, [], 'no unexpected synthetic API calls');
  console.log('PASS UI consistency: four navigation tabs, shared filter switch, six fixed metrics, shared period icons/text/dimensions');
} finally {
  await h.close();
}
