// Real renderer in isolated Chromium; API, native bridge and weather are synthetic.
// This test never starts Tauri, Edge or WebView2, or uses live Outlook/user data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openHarness } from './refactor-20261008-harness.mjs';

const output = process.env.TCPLUS_SUMMARY_READABLE_EVIDENCE;
if (output) fs.mkdirSync(output, { recursive: true });
const h = await openHarness();
h.page.setDefaultTimeout(5000);
const root = h.page.locator('[data-view="summary"]');
const nav = view => h.page.locator(`nav.nav [data-nav-target="${view}"]`);
const total = text => h.page.waitForFunction(expected => document.querySelector(
  '[data-view="summary"] [data-summary-metric="total"] [data-metric-value]',
)?.textContent.replace(/\s/g, '') === expected, text);

async function go(view) {
  await nav(view).click();
  await h.page.locator(`[data-view="${view}"]:not([hidden])`).waitFor();
  await h.page.evaluate(() => document.fonts.ready);
}

// Catch Summary sizing that leaks into the shared header or other view toolbars.
async function viewGeometry(view) {
  return h.page.evaluate(view => {
    const selectors = ['.header', '.header h1', '.header .nav', ...['calendar', 'tasks', 'ai', 'summary'].map(
      id => `.header nav.nav [data-nav-target="${id}"]`,
    ), `[data-view="${view}"] > .toolbar`, ...['outlook-open', 'update-open', 'settings-btn', 'sidebar-toggle'].map(
      id => `[data-view="${view}"] [data-${id}]`,
    )];
    return selectors.map(selector => {
      const el = document.querySelector(selector), r = el.getBoundingClientRect();
      return { selector, font: parseFloat(getComputedStyle(el).fontSize),
        x: r.x, y: r.y, width: r.width, height: r.height };
    });
  }, view);
}

function sameGeometry(actual, expected, label) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) for (const key of ['font', 'x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(actual[i][key] - expected[i][key]) <= 1,
      `${label}: ${actual[i].selector} ${key} changed from ${expected[i][key]} to ${actual[i][key]}`);
  }
}

// Shared chrome keeps the existing app's rendered scale while Summary is active.
async function sharedChromeGeometry(view) {
  return h.page.evaluate(view => {
    const screen = document.querySelector(`[data-view="${view}"]`);
    const entries = [...['.header', '.header h1', '.header .nav', '.header .clock'].map(selector => [selector, document.querySelector(selector)]),
      ...['calendar', 'tasks', 'ai', 'summary'].map(id => [`tab:${id}`, document.querySelector(`nav.nav [data-nav-target="${id}"]`)]),
      ['toolbar', screen.querySelector('.toolbar')], ['toolbar actions', screen.querySelector('.toolbarActions')],
      ...['outlook-open', 'update-open', 'settings-btn'].map(id => [id, screen.querySelector(`[data-${id}]`)])];
    return entries.map(([name, node]) => {
      const r = node.getBoundingClientRect(), style = getComputedStyle(node);
      return { name, width: r.width, height: r.height, font: parseFloat(style.fontSize),
        paddingTop: parseFloat(style.paddingTop), paddingRight: parseFloat(style.paddingRight),
        paddingBottom: parseFloat(style.paddingBottom), paddingLeft: parseFloat(style.paddingLeft),
        labelFonts: [...node.querySelectorAll('span[data-i18n]')].map(label => parseFloat(getComputedStyle(label).fontSize)) };
    });
  }, view);
}

function sameChrome(actual, expected, label) {
  const differences = [];
  for (let i = 0; i < actual.length; i++) {
    assert.equal(actual[i].name, expected[i].name);
    for (const key of ['width', 'height', 'font', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
      if (Math.abs(actual[i][key] - expected[i][key]) > 1) differences.push(
        `${actual[i].name} ${key}: Summary ${actual[i][key]}, reference ${expected[i][key]}`);
    }
    // Toolbar contents differ by view; compare shared action labels and each navigation tab.
    if (actual[i].name.startsWith('tab:') || ['outlook-open', 'update-open', 'settings-btn'].includes(actual[i].name)) {
      if (JSON.stringify(actual[i].labelFonts) !== JSON.stringify(expected[i].labelFonts)) differences.push(`${actual[i].name} label fonts differ`);
    }
  }
  assert.deepEqual(differences, [], label);
}

// Catch tiny inherited text, reduced hit targets, clipped values and offscreen panels.
// These assertions use computed fonts, text ranges and actual rectangles, not CSS source strings.
async function inspectLayout(label, columns, dayCount) {
  const result = await root.evaluate((el, columns) => {
    const failures = [];
    const visible = node => {
      if (node.closest('.srOnly')) return false;
      const r = node.getBoundingClientRect(), style = getComputedStyle(node);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const name = node => node.getAttribute('data-summary-tag') || node.getAttribute('data-summary-day')
      || node.getAttribute('data-summary-panel') || node.className || node.tagName;
    const fail = message => failures.push(message);
    const floor = (node, size) => {
      const actual = parseFloat(getComputedStyle(node).fontSize);
      if (actual < size) fail(`${name(node)} font ${actual}px < ${size}px`);
    };
    for (const node of el.querySelectorAll('.summaryTagName')) if (visible(node)) floor(node, 16);
    const metricCards = [...el.querySelectorAll('[data-summary-metric]')];
    const valueBoxes = metricCards.map(node => node.querySelector('[data-metric-value]').getBoundingClientRect());
    for (const node of el.querySelectorAll('[data-metric-value]')) floor(node, 30);
    if (metricCards.length !== 6 || metricCards.some(node => Math.abs(node.getBoundingClientRect().top - metricCards[0].getBoundingClientRect().top) > 1)) {
      fail('all six metrics must be present in the desktop metric row');
    }
    if (valueBoxes.some(box => Math.abs(box.top - valueBoxes[0].top) > 1)) fail('metric values must share a baseline when labels wrap');
    const actions = [...el.querySelectorAll('button:not([data-summary-bar]):not([data-summary-day])')]
      .filter(node => !node.closest('dialog') && visible(node));
    for (const node of actions) {
      if (!node.closest('.summaryScreen, .summaryOptionsBody')) continue;
      floor(node, 16);
      if (node.getBoundingClientRect().height < 39.5) fail(`${name(node)} target height ${node.getBoundingClientRect().height}px < 40px`);
    }
    const toolbarActions = actions.filter(node => node.closest('.summaryToolbar'));
    for (let i = 0; i < toolbarActions.length; i++) for (let j = i + 1; j < toolbarActions.length; j++) {
      const a = toolbarActions[i].getBoundingClientRect(), b = toolbarActions[j].getBoundingClientRect();
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
        && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) {
        const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        fail(`toolbar actions overlap by ${overlap.toFixed(1)}px: ${toolbarActions[i].textContent.trim()} / ${toolbarActions[j].textContent.trim()}`);
      }
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) {
      const node = textNode.parentElement;
      if (!textNode.textContent.trim() || !visible(node) || node.closest('dialog, svg, [aria-hidden="true"].summaryTagCheck, .summaryInsightIcon')) continue;
      const summaryContent = node.closest('.summaryScreen, .summaryOptionsBody');
      if (summaryContent) floor(node, 14);
      const action = node.closest('button:not([data-summary-bar]):not([data-summary-day]):not([data-summary-tag])');
      if (summaryContent && action && !node.closest('small')) floor(node, 16);
      const range = document.createRange(); range.selectNodeContents(textNode);
      for (const r of range.getClientRects()) {
        if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) {
          fail(`${name(node)} text outside viewport: ${textNode.textContent.trim()}`);
        }
        // Detect hidden content even when its outer panel still fits the viewport.
        for (let ancestor = node; ancestor && ancestor !== el.parentElement; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor), box = ancestor.getBoundingClientRect();
          // Supplementary metric text intentionally uses the app's ellipsis + full-title pattern.
          // Only its own horizontal clipping is allowed; numeric values and parent clipping still fail.
          const titledDetail = ancestor === node && node.classList.contains('summaryMetricDetail')
            && style.textOverflow === 'ellipsis' && node.title === node.textContent;
          if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX)
            && (r.left < box.left - 2 || r.right > box.right + 2) && !titledDetail) fail(`${name(node)} text clipped horizontally by ${name(ancestor)}`);
          if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY)
            && (r.top < box.top - 2 || r.bottom > box.bottom + 2)) fail(`${name(node)} text clipped vertically by ${name(ancestor)}`);
        }
      }
    }
    const panels = [...el.querySelectorAll('[data-summary-panel]')].filter(visible);
    for (const node of [...panels, ...el.querySelectorAll('[data-summary-metric], [data-summary-chart], [data-summary-numbers], [data-summary-tag], [data-summary-day]')]) {
      const r = node.getBoundingClientRect();
      if (!visible(node) || r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) fail(`${name(node)} outside viewport`);
      if (node.scrollHeight > node.clientHeight + 2 || node.scrollWidth > node.clientWidth + 2) {
        fail(`${name(node)} content clips or scrolls (width ${node.scrollWidth}/${node.clientWidth}, height ${node.scrollHeight}/${node.clientHeight})`);
      }
    }
    for (let i = 0; i < panels.length; i++) for (let j = i + 1; j < panels.length; j++) {
      if (panels[i].contains(panels[j]) || panels[j].contains(panels[i])) continue;
      const a = panels[i].getBoundingClientRect(), b = panels[j].getBoundingClientRect();
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
        && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) fail(`${name(panels[i])} overlaps ${name(panels[j])}`);
    }
    // User correction: keep chart then numbers together on the left, tags then insights on the right.
    const left = el.querySelector('.summaryTrend'), chart = el.querySelector('[data-summary-chart]');
    const numbers = el.querySelector('[data-summary-numbers]'), side = el.querySelector('.summarySide');
    const tags = el.querySelector('[data-summary-panel="tags"]'), insights = el.querySelector('[data-summary-panel="insights"]');
    const leftBox = left.getBoundingClientRect(), chartBox = chart.getBoundingClientRect();
    const numbersBox = numbers.getBoundingClientRect(), tagsBox = tags.getBoundingClientRect(), insightsBox = insights.getBoundingClientRect();
    if (!left.contains(chart) || !left.contains(numbers)) fail('chart and numbers must share the original left panel');
    if (!side?.contains(tags) || !side?.contains(insights)) fail('tags and insights must share the original right column');
    if (numbersBox.top < chartBox.bottom - 1 || numbersBox.left < leftBox.left - 1 || numbersBox.right > leftBox.right + 1) {
      fail('numeric area must stay below the chart inside the left panel');
    }
    if (tagsBox.left < leftBox.right - 1 || insightsBox.left < leftBox.right - 1) fail('tags and insights must stay right of the left panel');
    if (insightsBox.top < tagsBox.bottom - 1) fail('insights must stay below tags');
    const days = [...el.querySelectorAll('[data-summary-day]')].map(node => ({ key: node.dataset.summaryDay, ...node.getBoundingClientRect().toJSON() }));
    const rows = [];
    for (const day of days) {
      let row = rows.find(row => Math.abs(row[0].top - day.top) < 1);
      if (!row) rows.push(row = []);
      row.push(day);
    }
    const expectedRows = Math.ceil(days.length / columns);
    if (rows.length !== expectedRows || rows.some((row, index) => row.length !== (index === rows.length - 1 ? days.length - columns * index : columns))) {
      fail(`numeric grid rows ${rows.map(row => row.length).join(',')} must present ${columns} columns`);
    }
    const page = document.scrollingElement;
    if (page.scrollHeight > innerHeight + 1 || page.scrollWidth > innerWidth + 1 || page.scrollTop || page.scrollLeft) fail('page scrolls');
    return { failures: [...new Set(failures)], dayCount: days.length };
  }, columns);
  if (output) await h.page.screenshot({ path: path.join(output, label + '.png'), animations: 'disabled' });
  assert.deepEqual(result.failures, [], label);
  assert.equal(result.dayCount, dayCount, `${label}: every date/month remains visible`);
  const links = await h.page.locator('nav.nav [data-nav-target]').evaluateAll(nodes => nodes.map(el => {
    const r = el.getBoundingClientRect();
    return { view: el.dataset.navTarget, font: Math.min(...[el, ...el.querySelectorAll('span')].map(node => parseFloat(getComputedStyle(node).fontSize))),
      visible: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
  }));
  assert.deepEqual(links.map(link => link.view), ['calendar', 'tasks', 'ai', 'summary']);
  assert.ok(links.every(link => link.visible), `${label}: all four shared page tabs must remain visible`);
}

try {
  for (let i = 0; i < 8; i++) await h.page.request.post(h.origin + '/api/tags', {
    data: { id: 'readable-' + i, name: 'タグ ' + (i + 1), color: '#658f79' },
  });
  // A near-24-hour day exercises the longest valid daily value, including both units.
  // Thirty 90-minute days + 1,439 minutes = 4,139 minutes = 68 hours 59 minutes.
  await h.page.request.put(h.origin + '/api/settings', { data: {
    ...h.state().settings, breaks: [{ start: '12:00', end: '13:00', countAsWork: true }],
  } });
  const tagIds = h.state().tags.map(tag => tag.id);
  h.setTasks(Array.from({ length: 31 }, (_, index) => ({
    id: 'readable-day-' + (index + 1), title: '表示確認 ' + (index + 1),
    date: `2026-10-${String(index + 1).padStart(2, '0')}`, tagId: tagIds[index % tagIds.length],
    startTime: index === 5 ? '00:00' : '09:00', endTime: index === 5 ? '23:59' : '10:30',
    isAllDay: false, recurrence: { type: 'none' },
  })));
  await h.boot();
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1280, height: 800 }, { width: 1000, height: 800 }]) {
    await h.page.setViewportSize(viewport);
    const reference = {};
    for (const view of ['calendar', 'tasks', 'ai']) { await go(view); reference[view] = await sharedChromeGeometry(view); }
    await go('summary');
    const summary = await sharedChromeGeometry('summary');
    for (const view of ['calendar', 'tasks', 'ai']) sameChrome(summary, reference[view],
      `${viewport.width}×${viewport.height}: Summary must use the same header/navigation/toolbar scale as ${view}`);
  }
  console.log('PASS: unchanged shared header, navigation, toolbar and action dimensions at 1366, 1280 and 1000 widths');
  await h.page.setViewportSize({ width: 1366, height: 768 });
  const before = {};
  for (const view of ['calendar', 'tasks', 'ai']) { await go(view); before[view] = await viewGeometry(view); }
  await go('summary');
  await root.locator('[data-summary-tag]').first().waitFor();
  await root.locator('.uiToggle:has([data-summary-future])').click();
  assert.equal(await root.locator('[data-summary-future]').isChecked(), true);
  await total('68時間59分');

  // Catch missing/duplicate shared actions and a no-op sidebar action on Summary.
  for (const selector of ['[data-outlook-open]', '[data-update-open]', '[data-settings-btn]']) {
    assert.equal(await root.locator(selector).count(), 1, `Summary must have exactly one ${selector}`);
    assert.equal(await root.locator(selector).isVisible(), true, `${selector} must be visible`);
  }
  assert.equal(await root.locator('[data-sidebar-toggle]:visible').count(), 0, 'Summary must not expose a sidebar toggle');
  assert.equal(await root.locator('[data-summary-tag]').count(), 10);
  assert.equal(await root.locator('[data-summary-metric]').count(), 6);

  for (const viewport of [{ width: 1280, height: 800 }, { width: 1366, height: 768 }]) {
    await h.page.setViewportSize(viewport);
    await root.locator('[data-summary-period="month"]').click();
    await inspectLayout(`summary-readable-month-${viewport.width}`, 12, 31);
    const day = root.locator('[data-summary-day="2026-10-06"]');
    const visibleText = (await day.innerText()).replace(/\s/g, '');
    assert.ok(visibleText.includes('23時間59分'), `Long daily value must retain exact visible units: ${visibleText}`);
    await day.focus(); await h.page.keyboard.press('Enter');
    assert.equal(await day.getAttribute('aria-pressed'), 'true');
    assert.equal(await root.locator('[data-summary-bar="2026-10-06"]').getAttribute('aria-pressed'), 'true');
    const selectedTick = root.locator('[data-summary-bar="2026-10-06"] .summaryBarLabel');
    assert.equal(await selectedTick.isVisible(), true, 'Selecting a numeric day must reveal its graph tick between the default spaced ticks');
    assert.equal(await selectedTick.innerText(), '6');
    assert.ok((await root.locator('[data-summary-selected]').innerText()).replace(/\s/g, '').includes('23時間59分'));
    await root.locator('[data-summary-period="year"]').click();
    await inspectLayout(`summary-readable-year-${viewport.width}`, 6, 12);
    assert.ok((await root.locator('[data-summary-day="2026-10"]').innerText()).replace(/\s/g, '').includes('68時間59分'));
    await root.locator('[data-summary-day="2026-10"]').click();
    assert.equal(await root.locator('[data-summary-day]').count(), 31, 'Selecting an annual cell must open that month');
  }
  console.log('PASS: Summary content uses 16px primary text, 14px supporting text and 40px actions, with 10 tags and exact long durations at both desktop sizes');

  // Translated labels must satisfy the same visible-text and geometry rules.
  // Include the narrower desktop width for three locales with long toolbar labels.
  const localeFailures = [];
  for (const locale of ['en', 'ko', 'zh-CN', 'zh-TW', 'es', 'fr', 'de', 'pt']) {
    await h.page.evaluate(async locale => {
      await (await import('/src/store.js')).updateSettings({ uiLanguage: locale });
    }, locale);
    await h.page.waitForFunction(locale => document.documentElement.lang === locale, locale);
    const viewports = [{ width: 1366, height: 768 }];
    if (['de', 'fr', 'pt'].includes(locale)) viewports.push({ width: 1280, height: 800 });
    for (const viewport of viewports) {
      await h.page.setViewportSize(viewport);
      for (const [period, columns, dayCount] of [['month', 12, 31], ['year', 6, 12]]) {
        await root.locator(`[data-summary-period="${period}"]`).click();
        try { await inspectLayout(`summary-readable-${locale}-${period}-${viewport.width}`, columns, dayCount); }
        catch (error) { localeFailures.push(error.message); }
      }
    }
  }
  await h.page.evaluate(async () => { await (await import('/src/store.js')).updateSettings({ uiLanguage: 'ja' }); });
  await h.page.waitForFunction(() => document.documentElement.lang === 'ja');
  await h.page.setViewportSize({ width: 1366, height: 768 });
  await root.locator('[data-summary-period="month"]').click();
  assert.deepEqual(localeFailures, [], 'Translated Summary layouts must retain readability and fit');
  console.log('PASS: eight additional locales in month/year at 1366×768, plus German/French/Portuguese at 1280×800');

  // Six cards must retain complete hour/minute values even for a full year of near-24h days.
  const originalTasks = h.state().tasks;
  h.setTasks(Array.from({length:365}, (_,index) => ({id:'annual-'+index,title:'年間の桁数確認',
    date:new Date(Date.UTC(2026,0,index+1)).toISOString().slice(0,10),tagId:tagIds[index%tagIds.length],
    startTime:'00:00',endTime:'23:59',isAllDay:false,recurrence:{type:'none'}})));
  await h.page.evaluate(async()=>{await(await import('/src/store.js')).refreshTasks();});
  await root.locator('[data-summary-period="year"]').click();
  await total('8,753時間55分');
  await h.page.setViewportSize({width:1280,height:800});
  for(const locale of ['ja','de']) {
    await h.page.evaluate(async locale=>{await(await import('/src/store.js')).updateSettings({uiLanguage:locale});},locale);
    await inspectLayout('summary-six-large-year-'+locale,6,12);
  }
  h.setTasks(originalTasks);
  await h.page.evaluate(async()=>{const S=await import('/src/store.js');await S.refreshTasks();await S.updateSettings({uiLanguage:'ja'});});
  await root.locator('[data-summary-period="month"]').click();
  await h.page.setViewportSize({width:1366,height:768});
  await total('68時間59分');
  console.log('PASS: six cards preserve 8,753 hours 55 minutes at the narrow desktop width');

  // Exercise the mounted shared handlers, without requesting native Outlook/update work.
  const settings = h.page.locator('[data-settings-dialog]');
  for (let attempt = 0; attempt < 2; attempt++) {
    await root.locator('[data-settings-btn]').click();
    await settings.waitFor({ state: 'visible' });
    assert.equal(await settings.evaluate(el => el.open), true);
    await h.page.keyboard.press('Escape');
    await settings.waitFor({ state: 'hidden' });
  }
  await root.locator('[data-outlook-open]').click();
  await settings.waitFor({ state: 'visible' });
  assert.equal(await settings.locator('[data-settings-tab="outlook"]').getAttribute('aria-selected'), 'true');
  assert.equal(await settings.locator('[data-settings-tab-panel="outlook"]').isVisible(), true);
  await h.page.keyboard.press('Escape'); await settings.waitFor({ state: 'hidden' });
  await root.locator('[data-update-open]').click();
  const update = h.page.locator('[data-update-dialog]');
  await update.waitFor({ state: 'visible' });
  assert.equal(await update.evaluate(el => el.open), true);
  await update.locator('[data-update-close]').click(); await update.waitFor({ state: 'hidden' });

  await h.page.waitForLoadState('networkidle');
  h.failNext('GET', '/api/tasks', 500);
  await go('calendar'); await go('summary');
  await root.locator('[data-summary-retry]').waitFor({ state: 'visible' });
  const errorLayout = await root.evaluate(el => {
    const panel = el.querySelector('[data-summary-numbers]').getBoundingClientRect();
    return [...el.querySelectorAll('[data-summary-day]')].every(day => {
      const r = day.getBoundingClientRect(); return r.top >= panel.top && r.bottom <= panel.bottom;
    });
  });
  assert.equal(errorLayout, true, 'Refresh errors must keep date cells inside their own panel, clear of insights');
  await root.locator('[data-summary-day="2026-10-31"]').scrollIntoViewIfNeeded();
  await root.locator('[data-summary-day="2026-10-31"]').click();
  assert.equal(await root.locator('[data-summary-bar="2026-10-31"]').getAttribute('aria-pressed'), 'true');
  await root.locator('[data-summary-retry]').click();
  await root.locator('[data-summary-retry]').waitFor({ state: 'hidden' });
  await inspectLayout('summary-readable-after-retry', 12, 31);

  for (const viewport of [{ width: 1024, height: 640 }, { width: 1000, height: 800 }, { width: 800, height: 600 }]) {
    await h.page.setViewportSize(viewport);
    const collisions = await root.evaluate(el => {
      const panels = [...el.querySelectorAll('[data-summary-panel]')].map(node => ({ node, name: node.dataset.summaryPanel, r: node.getBoundingClientRect() }));
      const overlaps = [];
      for (let i=0;i<panels.length;i++) for (let j=i+1;j<panels.length;j++) {
        const a=panels[i],b=panels[j];
        if (a.node.contains(b.node) || b.node.contains(a.node)) continue;
        if (Math.min(a.r.right,b.r.right)-Math.max(a.r.left,b.r.left)>1 && Math.min(a.r.bottom,b.r.bottom)-Math.max(a.r.top,b.r.top)>1) overlaps.push(`${a.name}/${b.name}`);
      }
      return overlaps;
    });
    assert.deepEqual(collisions, [], `${viewport.width}×${viewport.height}: stacked panels must never cover each other`);
    const lastDay = root.locator('[data-summary-day="2026-10-31"]');
    await lastDay.scrollIntoViewIfNeeded(); await lastDay.click();
    assert.equal(await lastDay.getAttribute('aria-pressed'), 'true');
    const firstTag = root.locator('[data-summary-tag]').first();
    await firstTag.scrollIntoViewIfNeeded(); await firstTag.click();
    assert.equal(await firstTag.getAttribute('aria-pressed'), 'true');
    await root.locator('[data-summary-all-tags]').click();
    assert.equal(await h.page.evaluate(() => {
      const container = document.querySelector('.container');
      return document.scrollingElement.scrollWidth <= innerWidth + 1 && container.scrollWidth <= container.clientWidth + 1;
    }), true, 'A smaller CSS viewport must stay usable without horizontal overflow');
    assert.ok(await lastDay.locator('small').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 14);
  }
  await h.page.setViewportSize({ width: 1366, height: 768 });
  await inspectLayout('summary-readable-restored-desktop', 12, 31);
  console.log('PASS: readable error recovery and smaller-window scrolling without obscured dates');

  await h.page.evaluate(async () => {
    await (await import('/src/store.js')).updateSettings({quickLinks:[1,2,3].map(i=>({label:'プロジェクト資料'+i,url:'https://example.com/docs/'+i}))});
  });
  assert.equal(await root.evaluate(el => {
    const panel=el.querySelector('[data-summary-numbers]').getBoundingClientRect();
    return [...el.querySelectorAll('[data-summary-day]')].every(day=>day.getBoundingClientRect().bottom<=panel.bottom);
  }),true,'A taller header with quick links must not compress date rows into insights');
  await root.locator('[data-summary-day="2026-10-31"]').scrollIntoViewIfNeeded();
  await root.locator('[data-summary-day="2026-10-31"]').click();
  await h.page.evaluate(async()=>{await(await import('/src/store.js')).updateSettings({quickLinks:[]});});
  await inspectLayout('summary-readable-after-quick-links',12,31);
  console.log('PASS: custom quick links can grow the header without covering dates');

  // Summary-specific styling must be reversible when each existing view is reopened.
  for (const view of ['calendar', 'tasks', 'ai']) {
    await go(view);
    sameGeometry(await viewGeometry(view), before[view], `Leaving Summary for ${view}`);
    assert.equal(await h.page.locator(`[data-view="${view}"] [data-sidebar-toggle]`).isVisible(), true,
      `${view} must retain its existing sidebar action`);
    if (view !== 'ai') await go('summary');
  }
  assert.deepEqual(h.pageErrors, []);
  assert.deepEqual(h.unexpectedRequests, []);
  assert.deepEqual(h.nativeCalls.filter(call => !['get_api_token', 'get_ui_preferences', 'get_autostart_enabled',
    'get_update_info', 'set_ui_theme', 'set_ui_zoom', 'set_ui_language', 'set_tray_enabled'].includes(call.command)), [],
  'Opening shared actions must not start Outlook acquisition, update installation, or other excluded native operations');
  console.log('PASS: working shared settings/Outlook/update actions, original header and toolbar geometry restored in all three existing views');
} finally { await h.close(); }
