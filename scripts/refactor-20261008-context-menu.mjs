// Pass 2 characterization of observable task context-menu behavior.
// Exercises real event handlers against the existing isolated synthetic API harness.
import assert from 'node:assert/strict';

export async function runContextMenuContracts(h, run) {
  const page = h.page;
  const menu = page.locator('.taskTagContextMenu');
  const view = name => page.locator(`[data-view="${name}"]`);
  const task = (name, id = 'task-plan') => view(name).locator(`[data-task-id="${id}"]:visible`).first();
  const state = () => h.state().tasks;
  const waitForTag = (id, tagId) => page.waitForFunction(async ({id, tagId}) =>
    (await import('/src/store.js')).getAllTasks().find(row => row.id === id)?.tagId === tagId, {id, tagId});
  const waitForAbsent = id => page.waitForFunction(async id =>
    !(await import('/src/store.js')).getAllTasks().some(row => row.id === id), id);
  const open = async (name, id = 'task-plan') => {
    await task(name, id).click({button:'right'});
    await menu.waitFor({state:'visible'});
  };
  const navigate = async name => {
    if (name === 'calendar') await view(name).locator('[data-viewmode]').selectOption('day');
    else await page.locator(`nav.nav [data-nav-target="${name}"]`).click();
    await view(name).waitFor({state:'visible'});
  };
  const labels = () => menu.locator('button').allTextContents();
  const choose = text => menu.getByRole('button', {name:text, exact:true}).click();
  const canonical = rows => rows.map(row => ({...row, updatedAt:'<revision>'})).sort((a,b) => a.id.localeCompare(b.id));
  const assertOnlyTagChanged = (before, id, tagId) => assert.deepEqual(canonical(state()),
    canonical(before.map(row => row.id === id ? {...row, tagId} : row)));

  for (const name of ['calendar','tasks']) {
    const prefix = 'UI-CONTEXT-' + name.toUpperCase();
    await run(prefix + '-CONTENT', `${name}: exact menu order, styles, selection, swatches and focus`, async () => {
      await navigate(name); const before = state(); await open(name);
      assert.deepEqual(await labels(), ['編集','削除（この予定）','タグなし','設計','打ち合わせ']);
      assert.equal(await menu.locator('.taskTagContextTitle').innerText(), 'タグを選択');
      assert.equal(await menu.locator('.taskTagContextSeparator').count(), 1);
      assert.equal(await menu.locator('button.danger').innerText(), '削除（この予定）');
      assert.equal(await menu.locator('button.active').innerText(), '設計');
      assert.equal(await task(name).evaluate(node => node.classList.contains('focused')), true);
      assert.deepEqual(await menu.locator('button').evaluateAll(nodes => nodes.map(node => ({
        type:node.type, pressed:node.getAttribute('aria-pressed'), swatch:node.querySelector('.contextTagSwatch')?.style.background ?? null,
        swatchHidden:node.querySelector('.contextTagSwatch')?.getAttribute('aria-hidden') ?? null,
      }))), [
        {type:'button',pressed:null,swatch:null,swatchHidden:null},
        {type:'button',pressed:null,swatch:null,swatchHidden:null},
        {type:'button',pressed:null,swatch:null,swatchHidden:null},
        {type:'button',pressed:'true',swatch:'rgb(79, 126, 220)',swatchHidden:'true'},
        {type:'button',pressed:'false',swatch:'rgb(225, 149, 65)',swatchHidden:'true'},
      ]);
      await page.keyboard.press('Escape'); await open(name, 'task-personal');
      assert.equal(await menu.locator('button.active').innerText(), 'タグなし');
      assert.deepEqual(await menu.locator('[aria-pressed]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-pressed'))), ['false','false']);
      assert.deepEqual(state(), before);
    });

    await run(prefix + '-TAG-OPTIONS', `${name}: month order, current tag retention and empty tag state`, async () => {
      await navigate(name); const before = state();
      await page.evaluate(async () => (await import('/src/store.js')).updateSettings({monthTagOrders:{'2026-10':['tag-meeting']}}));
      await open(name);
      assert.deepEqual(await labels(), ['編集','削除（この予定）','タグなし','打ち合わせ','設計']);
      assert.equal(await menu.locator('button.active').innerText(), '設計');
      await page.keyboard.press('Escape');
      await page.evaluate(async () => (await import('/src/store.js')).updateSettings({monthTagOrders:{'2026-10':[]}}));
      await open(name, 'task-personal');
      assert.deepEqual(await labels(), ['編集','削除（この予定）','タグなし']);
      assert.equal(await menu.locator('.taskTagContextEmpty').innerText(), 'この月に利用できるタグがありません。');
      assert.equal(await menu.locator('button.active').innerText(), 'タグなし');
      assert.deepEqual(state(), before);
    });

    await run(prefix + '-EDIT', `${name}: context editing selects the correct task and cancel preserves all data`, async () => {
      await navigate(name); const before = state(); await open(name, 'task-meeting'); await choose('編集');
      const editor = view(name).locator('[data-task-dialog]'); await editor.waitFor({state:'visible'});
      await menu.waitFor({state:'hidden'});
      assert.equal(await editor.locator('[name="title"]').inputValue(), '進捗の打ち合わせ');
      assert.equal(await editor.locator('[name="memo"]').inputValue(), '検証用の合成データ');
      await editor.locator('[name="title"]').fill('キャンセルされる変更');
      await editor.locator('[data-cancel]').click(); assert.deepEqual(state(), before);
    });

    await run(prefix + '-DELETE', `${name}: context deletion cancellation and single-task confirmation preserve unrelated IDs`, async () => {
      await navigate(name); const before = state(); await open(name, 'task-personal'); await choose('削除（この予定）');
      const dialog = page.locator('[data-app-dialog]'); await dialog.waitFor({state:'visible'});
      assert.match(await dialog.innerText(), /個人の予定/);
      await dialog.locator('[data-app-dialog-cancel]').click(); await menu.waitFor({state:'hidden'});
      assert.deepEqual(state(), before);
      await open(name, 'task-personal'); await choose('削除（この予定）');
      await dialog.locator('[data-app-dialog-confirm]').click(); await waitForAbsent('task-personal');
      await menu.waitFor({state:'hidden'});
      assert.deepEqual(state(), before.filter(row => row.id !== 'task-personal'));
    });

    await run(prefix + '-SERIES', `${name}: series action reflects count and deletes only its confirmed recurrence group`, async () => {
      const rows = state();
      const recurring = {...rows.find(row => row.id === 'task-plan'), recurrence:{type:'daily', groupId:'menu-series', originDate:'2026-10-08', until:'2026-10-09'}};
      const next = {...recurring, id:'task-plan-next', date:'2026-10-09'};
      h.setTasks(rows.map(row => row.id === recurring.id ? recurring : row).concat(next));
      await page.evaluate(async () => (await import('/src/store.js')).refreshTasks());
      await navigate(name); const before = state(); await open(name);
      assert.deepEqual(await labels(), ['編集','削除（この予定）','削除（繰り返し全体: 2件）','タグなし','設計','打ち合わせ']);
      const series = '削除（繰り返し全体: 2件）';
      assert.equal(await menu.getByRole('button',{name:series,exact:true}).evaluate(node => node.classList.contains('danger')), true);
      await choose(series); const dialog = page.locator('[data-app-dialog]');
      await dialog.locator('[data-app-dialog-cancel]').click(); await menu.waitFor({state:'hidden'}); assert.deepEqual(state(), before);
      await open(name); await choose(series); await dialog.locator('[data-app-dialog-confirm]').click();
      await waitForAbsent('task-plan'); await menu.waitFor({state:'hidden'});
      assert.deepEqual(state(), before.filter(row => row.recurrence?.groupId !== 'menu-series'));
    });

    await run(prefix + '-TAG-TIMING', `${name}: tag update persists only the selected field and preserves its existing close timing`, async () => {
      await navigate(name); const before = state(); await open(name);
      let release, received;
      const gate = new Promise(resolve => { release = resolve; });
      const requestStarted = new Promise(resolve => { received = resolve; });
      const matcher = '**/api/tasks/task-plan';
      const handler = async route => {
        if (route.request().method() === 'PUT') { received(); await gate; }
        await route.continue();
      };
      await page.route(matcher, handler);
      try {
        await choose('打ち合わせ'); await requestStarted;
        assert.equal(await menu.isVisible(), name === 'tasks', 'calendar closes immediately; task list waits for the update');
        assert.deepEqual(state(), before, 'the held request has not reached the synthetic API');
        release(); await waitForTag('task-plan', 'tag-meeting'); await menu.waitFor({state:'hidden'});
      } finally { release(); await page.unroute(matcher, handler); }
      assertOnlyTagChanged(before, 'task-plan', 'tag-meeting');
      if (name === 'calendar') {
        await page.keyboard.press('Control+z'); await waitForTag('task-plan','tag-design');
        assert.deepEqual(canonical(state()), canonical(before));
        await page.keyboard.press('Control+y'); await waitForTag('task-plan','tag-meeting');
        assertOnlyTagChanged(before, 'task-plan', 'tag-meeting');
      }
      await open(name); await choose('タグなし'); await waitForTag('task-plan',''); await menu.waitFor({state:'hidden'});
      assertOnlyTagChanged(before, 'task-plan', '');
    });

    await run(prefix + '-DISMISS', `${name}: Escape, outside click, scroll and resize close without mutation`, async () => {
      await navigate(name); const before = state();
      await open(name); await page.keyboard.press('Escape'); await menu.waitFor({state:'hidden'});
      await open(name); await page.mouse.click(2,2); await menu.waitFor({state:'hidden'});
      await open(name); await task(name).dispatchEvent('scroll'); await menu.waitFor({state:'hidden'});
      await open(name); await page.setViewportSize({width:1439,height:1000}); await menu.waitFor({state:'hidden'});
      await page.setViewportSize({width:1440,height:1000});
      assert.deepEqual(state(), before);
    });

    await run(prefix + '-POSITION', `${name}: context-menu placement honors pointer coordinates and 8 px viewport margins`, async () => {
      await navigate(name); const before = state();
      for (const point of [{x:600,y:300},{x:1439,y:999},{x:-1,y:-1}]) {
        // Match a real right-click's actionability checks before injecting boundary coordinates.
        // In particular, the calendar's scheduled view-change scroll must settle first.
        await task(name).click({button:'right',trial:true});
        // Playwright dispatchEvent creates a generic Event for contextmenu, which has no pointer coordinates.
        await task(name).evaluate((node, point) => node.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles:true, cancelable:true, button:2, clientX:point.x, clientY:point.y,
        })), point);
        await menu.waitFor({state:'visible'}); const bounds = await menu.boundingBox();
        assert.ok(bounds, 'context menu remains visible after opening on an actionable task');
        assert.ok(bounds.x >= 8 && bounds.y >= 8, JSON.stringify(bounds));
        assert.ok(bounds.x + bounds.width <= 1432 && bounds.y + bounds.height <= 992, JSON.stringify(bounds));
        if (point.x === 600) { assert.equal(bounds.x,600); assert.equal(bounds.y,300); }
        if (point.x < 0) { assert.equal(bounds.x,8); assert.equal(bounds.y,8); }
        await page.keyboard.press('Escape');
      }
      assert.deepEqual(state(), before);
    });
  }
}
