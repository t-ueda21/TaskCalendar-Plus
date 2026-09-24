// 実際のアプリ(Tauri + WebView2)を起動して、画面が正しく立ち上がるかを確かめるスモークテスト。
// WebView2 のリモートデバッグ(Chrome DevTools Protocol)で画面を操作する。
// 普段のデータを汚さないよう、一時フォルダをデータ保存先(TCPLUS_DATA_DIR)にして起動する。
//
// 使い方(リポジトリ直下、Windows): node scripts/e2e-smoke.mjs
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PORT = 9339;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcplus-e2e-'));
const exe = path.resolve(process.env.TCPLUS_E2E_EXE || 'src-tauri/target/debug/taskcalendar-plus.exe');

// 古い実行ファイルで検査しないよう毎回ビルドする(変更が無ければすぐ終わる)。
// 起動中のexeを上書きできない場合は、別の場所でビルドしたexeを明示指定できる。
if (!process.env.TCPLUS_E2E_EXE) execFileSync('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml'], { stdio: 'inherit' });

const app = spawn(exe, [], {
  env: {
    ...process.env,
    TCPLUS_DATA_DIR: dataDir,
    WEBVIEW2_USER_DATA_FOLDER: path.join(dataDir, 'webview2'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  },
  stdio: 'ignore',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
  if (!ok) failed += 1;
}

async function connect() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('/assets/app.html'));
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* 起動待ち */ }
    await sleep(1000);
  }
  throw new Error('アプリの画面に接続できませんでした');
}

try {
  const ws = new WebSocket(await connect());
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed');
    return r.result?.result?.value;
  };
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable');

  // 画面の初期化完了(body の opacity が 1 になる)を待つ。
  let booted = false;
  for (let i = 0; i < 30 && !booted; i += 1) {
    booted = await evaluate('document.body.style.opacity === "1"');
    if (!booted) await sleep(500);
  }
  check('画面の初期化が完了する', booted);

  const modules = await evaluate(`(async () => {
    const names = ['store', 'ui-utils', 'time-grid', 'settings-dialog', 'tag-manager', 'main', 'calendar', 'tasks', 'ai-mode',
      'ai-memory', 'ai-client', 'markdown', 'weather', 'settings-transfer'];
    const result = {};
    for (const n of names) result[n] = await import('/src/' + n + '.js').then(() => 'ok', (e) => String(e));
    return result;
  })()`);
  const broken = Object.entries(modules).filter(([, v]) => v !== 'ok');
  check('すべての画面モジュールを読み込める', broken.length === 0, JSON.stringify(broken));

  const shown = await evaluate(`[...document.querySelectorAll('#viewRoot > .view')].filter((v) => !v.hidden).map((v) => v.dataset.view)`);
  check('起動時にカレンダー画面が表示される', JSON.stringify(shown) === '["calendar"]', JSON.stringify(shown));

  const api = await evaluate(`(async () => {
    const withToken = (await fetch('/api/tasks')).status;
    const withoutToken = await new Promise((res) => { const x = new XMLHttpRequest(); x.open('GET', '/api/tasks'); x.onload = () => res(x.status); x.send(); });
    return { withToken, withoutToken };
  })()`);
  check('画面からのAPI呼び出しは合言葉付きで成功する', api.withToken === 200, JSON.stringify(api));
  check('合言葉なしのAPI呼び出しは拒否される', api.withoutToken === 401, JSON.stringify(api));

  const defaults = await evaluate(`fetch('/api/tags').then((r) => r.json()).then((tags) => tags.length)`);
  check('新規データではタグが0件', defaults === 0, String(defaults));

  const ai = await evaluate(`(async () => {
    document.querySelector('[data-view="calendar"] [data-settings-btn]').click();
    await new Promise((r) => setTimeout(r, 300));
    const dialog = document.querySelector('dialog[open]');
    const cliEnabled = dialog.querySelector('[data-ai-cli-enabled]').checked;
    const disabled = [...dialog.querySelectorAll('[data-ai-provider-select] option')].filter((o) => o.disabled).map((o) => o.value);
    dialog.querySelector('[data-settings-cancel]').click();
    const chat = await fetch('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [] }) });
    return { cliEnabled, disabled, chatStatus: chat.status };
  })()`);
  check('Claude Code / Codex 連携は既定でオフ(選択肢も無効)', ai.cliEnabled === false && ai.disabled.join(',') === 'claude-code,codex', JSON.stringify(ai));
  check('AI未設定ではAIを呼び出さない', ai.chatStatus === 503, JSON.stringify(ai));

  const setupShown = await evaluate(`(async () => {
    document.querySelector('[data-nav-target="ai"]').click();
    await new Promise((r) => setTimeout(r, 400));
    return document.querySelector('[data-view="ai"] [data-ai-chat-log]').innerText.includes('AIの接続先の設定が必要');
  })()`);
  check('AI未設定のとき、AIモードに設定方法が表示される', setupShown);

  for (const view of ['tasks', 'ai', 'calendar']) {
    const ok = await evaluate(`(async () => {
      document.querySelector('[data-nav-target="${view}"]').click();
      await new Promise((r) => setTimeout(r, 400));
      return !document.querySelector('#viewRoot > .view[data-view="${view}"]').hidden;
    })()`);
    check(`「${view}」タブに切り替えられる`, ok);
  }

  const saved = await evaluate(`(async () => {
    document.querySelector('[data-view="calendar"] [data-settings-btn]').click();
    await new Promise((r) => setTimeout(r, 300));
    const dialog = document.querySelector('dialog[open]');
    if (!dialog) return 'dialog not open';
    dialog.querySelector('[data-quick-links-input]').value = 'E2E-A,https://example.com/\\nE2E-B,https://example.com/\\nE2E-C,https://example.com/';
    dialog.querySelector('[data-settings-save]').click();
    await new Promise((r) => setTimeout(r, 800));
    return [...document.querySelectorAll('[data-quick-links] a')].map((a) => a.textContent).join(',');
  })()`);
  check('同じURL・違う名前のクイックリンク3件を保存して表示できる', saved === 'E2E-A,E2E-B,E2E-C', String(saved));

  const savedLinks = await evaluate(`(async () => {
    document.querySelector('[data-view="calendar"] [data-settings-btn]').click();
    await new Promise(r => setTimeout(r, 200));
    const dialog = document.querySelector('dialog[open]');
    const text = dialog.querySelector('[data-quick-links-input]').value;
    dialog.querySelector('[data-settings-cancel]').click();
    const settings = await (await fetch('/api/settings')).json();
    return {lines:text.split('\\n').length, count:settings.quickLinks.length};
  })()`);
  check('クイックリンク3件が設定の再表示と保存データにも残る', savedLinks.lines === 3 && savedLinks.count === 3, JSON.stringify(savedLinks));

  // ── タグと今日の予定を1件作り、3画面で共通の部品(サイドバー・タグ一覧・タグ変更メニュー)を確かめる
  const seeded = await evaluate(`(async () => {
    const Store = await import('/src/store.js');
    const { formatDateKey, formatYearMonth } = await import('/src/ui-utils.js');
    const today = new Date();
    const meeting = await Store.createTag({ name: 'E2E会議', color: '#2563eb' });
    const dev = await Store.createTag({ name: 'E2E開発', color: '#16a34a' });
    await Store.setMonthTagOrder(formatYearMonth(today), [meeting.id, dev.id]);
    const created = await Store.createTask({
      title: 'E2E予定', date: formatDateKey(today), startTime: '10:00', endTime: '11:00', tagId: meeting.id,
    });
    await new Promise((r) => setTimeout(r, 300));
    return { taskId: created?.id ?? null, devId: dev.id };
  })()`);
  check('タグと予定を作成できる', Boolean(seeded?.taskId), JSON.stringify(seeded));

  for (const view of ['calendar', 'tasks', 'ai']) {
    const side = await evaluate(`(async () => {
      document.querySelector('[data-nav-target="${view}"]').click();
      await new Promise((r) => setTimeout(r, 400));
      const root = document.querySelector('#viewRoot > .view[data-view="${view}"]');
      const month = root.querySelector('[data-side-month-summary]')?.innerText ?? '';
      const day = root.querySelector('[data-side-day-summary]')?.innerText ?? '';

      const btn = root.querySelector('[data-sidebar-toggle]');
      const layout = root.querySelector('.layout');
      btn.click();
      const collapsed = layout.classList.contains('sidebar-collapsed') && btn.textContent.includes('▶');
      btn.click();
      const reopened = !layout.classList.contains('sidebar-collapsed') && btn.textContent.includes('◀');

      const label = root.querySelector('[data-mini-month-label]');
      label.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
      const popup = [...document.querySelectorAll('.taskTagContextMenu')].find((p) => !p.hidden);
      const popupText = popup?.innerText ?? '';
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      const popupClosed = ![...document.querySelectorAll('.taskTagContextMenu')].some((p) => !p.hidden);
      return { month, day, collapsed, reopened, popupText, popupClosed };
    })()`);
    check(`「${view}」サイドバーの月次・日次集計に予定のタグが出る`,
      side.month.includes('E2E会議') && side.day.includes('E2E会議'), JSON.stringify(side));
    check(`「${view}」サイドバーを折りたたみ・再表示できる`, side.collapsed && side.reopened, JSON.stringify(side));
    if (view !== 'ai') { // AIモードの月見出しにはタグ一覧を付けていない
      check(`「${view}」月見出しの右クリックでその月のタグ一覧が出て、Escで閉じる`,
        side.popupText.includes('E2E会議') && side.popupText.includes('E2E開発') && side.popupClosed, JSON.stringify(side));
    }
  }

  const grid = await evaluate(`(async () => {
    const root = document.querySelector('#viewRoot > .view[data-view="calendar"]');
    const slots = root.querySelectorAll('[data-slots="day"] [data-index]').length;
    const block = root.querySelector('[data-view="day"] [data-task-id="${seeded?.taskId}"]');
    return { slots, top: block?.style.top ?? '', height: block?.style.height ?? '' };
  })()`);
  check('カレンダーの日表示に時間枠と予定ブロックが描画される',
    grid.slots > 0 && parseFloat(grid.top) > 0 && parseFloat(grid.height) > 0, JSON.stringify(grid));

  const retag = await evaluate(`(async () => {
    const Store = await import('/src/store.js');
    const root = document.querySelector('#viewRoot > .view[data-view="calendar"]');
    const block = root.querySelector('[data-view="day"] [data-task-id="${seeded?.taskId}"]');
    if (!block) return 'no block';
    block.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
    const menu = [...document.querySelectorAll('.taskTagContextMenu')].find((p) => !p.hidden);
    const item = [...(menu?.querySelectorAll('.taskTagContextItem') ?? [])].find((b) => b.textContent === 'E2E開発');
    if (!item) return 'no menu item: ' + (menu?.innerText ?? 'no menu');
    item.click();
    await new Promise((r) => setTimeout(r, 400));
    const menuClosed = ![...document.querySelectorAll('.taskTagContextMenu')].some((p) => !p.hidden);
    const { formatDateKey } = await import('/src/ui-utils.js');
    const task = Store.getTasksByDate(formatDateKey(new Date())).find((t) => t.id === '${seeded?.taskId}');
    return { tagId: task?.tagId ?? null, menuClosed };
  })()`);
  check('予定の右クリックメニューでタグを変更できる',
    retag?.tagId === seeded?.devId && retag?.menuClosed === true, JSON.stringify(retag));

  const tagMgr = await evaluate(`(async () => {
    const root = document.querySelector('#viewRoot > .view[data-view="calendar"]');
    root.querySelector('[data-side-month-summary] [data-tag-id]').click();
    await new Promise((r) => setTimeout(r, 400));
    const dialog = document.querySelector('dialog[open]');
    if (!dialog) return 'dialog not open';
    const activeTab = dialog.querySelector('[data-settings-tab].isActive')?.dataset.settingsTab;
    const names = [...dialog.querySelectorAll('[data-tag-list] .settingsTagInput')].map((i) => i.value);
    const pickers = dialog.querySelectorAll('[data-tag-list] .hslPicker').length;
    dialog.querySelector('[data-settings-cancel]').click();
    return { activeTab, names, pickers };
  })()`);
  check('サイドバーのタグ行から設定のタグ管理が開き、タグと色の選択が並ぶ',
    tagMgr?.activeTab === 'tags' && tagMgr.names.includes('E2E会議') && tagMgr.names.includes('E2E開発') && tagMgr.pickers >= 2,
    JSON.stringify(tagMgr));

  for (const view of ['calendar', 'tasks', 'ai']) {
    const monthPicker = await evaluate(`(async () => {
      const pause=()=>new Promise(r=>setTimeout(r,200));
      document.querySelector('[data-nav-target="${view}"]').click();await pause();
      const root=document.querySelector('.view[data-view="${view}"]');
      const label=root.querySelector('[data-mini-month-label]');
      const selectedBefore=new URL(location.href).searchParams.get('date');
      label.click();
      const count=root.querySelectorAll('[data-mini-month]').length;
      if(count!==12)return {count};
      const prev=root.querySelector('[data-mini-month-prev]');
      const next=root.querySelector('[data-mini-month-next]');
      const yearLabels=prev.getAttribute('aria-label')==='前の年'&&next.getAttribute('aria-label')==='次の年';
      const year=Number(label.textContent.replace(/[^0-9]/g,''));
      next.click();const movedYear=Number(label.textContent.replace(/[^0-9]/g,''))===year+1;prev.click();
      root.querySelector('[data-mini-month="1"]').click();
      const expected=String(year)+'-02';
      const chosenMonth=label.dataset.yearmonth===expected && root.querySelectorAll('[data-mini-month]').length===0;
      const dateUnchanged=selectedBefore===new URL(location.href).searchParams.get('date');
      const last=[...root.querySelectorAll('[data-mini-cal] [data-date]')].at(-1);
      const picked=last.dataset.date;last.click();
      const selected=root.querySelector('[data-mini-cal] .selected')?.dataset.date;
      return {count,yearLabels,movedYear,chosenMonth,dateUnchanged,selectedDate:new URL(location.href).searchParams.get('date')===picked&&selected===picked};
    })()`);
    check(`「${view}」月名から12か月を選び、年の移動と日付選択ができる`, monthPicker.count===12&&monthPicker.yearLabels&&monthPicker.movedYear&&monthPicker.chosenMonth&&monthPicker.dateUnchanged&&monthPicker.selectedDate, JSON.stringify(monthPicker));
  }
  await evaluate(`document.querySelector('[data-nav-target="calendar"]').click(); document.querySelector('[data-go-today]').click();`);

  const miniCollapse = await evaluate(`(async () => {
    const pause=()=>new Promise(r=>setTimeout(r,200));
    document.querySelector('[data-nav-target="calendar"]').click();await pause();
    const calendar=document.querySelector('.view[data-view="calendar"]');
    const toggle=calendar.querySelector('[data-mini-calendar-toggle]');
    if(!toggle)return {missing:true};
    const selectedDate=new URL(location.href).searchParams.get('date');
    const before=calendar.querySelector('[data-side-month-summary]').getBoundingClientRect().top;
    toggle.click();
    const closed=toggle.getAttribute('aria-expanded')==='false'&&calendar.querySelector('[data-mini-calendar-body]').hidden;
    const freedSpace=calendar.querySelector('[data-side-month-summary]').getBoundingClientRect().top<before;
    const shared=[];
    for(const view of ['tasks','ai']){
      document.querySelector('[data-nav-target="'+view+'"]').click();await pause();
      const root=document.querySelector('.view[data-view="'+view+'"]');
      shared.push(root.querySelector('[data-mini-calendar-body]').hidden);
    }
    document.querySelector('.view[data-view="ai"] [data-mini-calendar-toggle]').click();
    document.querySelector('[data-nav-target="calendar"]').click();await pause();
    return {closed,freedSpace,shared,reopened:!calendar.querySelector('[data-mini-calendar-body]').hidden&&toggle.getAttribute('aria-expanded')==='true',datePreserved:selectedDate===new URL(location.href).searchParams.get('date')};
  })()`);
  check('ミニカレンダーを折りたたむと集計が上に詰まり、3タブの開閉状態が揃う', miniCollapse.closed && miniCollapse.freedSpace && miniCollapse.shared?.every(Boolean), JSON.stringify(miniCollapse));
  check('ミニカレンダーを再表示でき、選択日は変わらない', miniCollapse.reopened && miniCollapse.datePreserved, JSON.stringify(miniCollapse));

  const colors = await evaluate(`(async () => {
    const Store = await import('/src/store.js');
    const pause = () => new Promise(r => setTimeout(r, 250));
    const open = async () => {document.querySelector('[data-view="calendar"] [data-settings-btn]').click();await pause();return document.querySelector('dialog[open]');};
    const dialog = await open();
    const initial = Store.getSettings().uiAccentColor;
    const count = dialog.querySelectorAll('[data-ui-color]').length;
    dialog.querySelector('[data-ui-color="#7c3aed"]').click();
    const preview = document.documentElement.dataset.uiAccentColor;
    const notSaved = (await (await fetch('/api/settings')).json()).uiAccentColor !== '#7c3aed';
    dialog.querySelector('[data-settings-cancel]').click(); await pause();
    const cancelled = document.documentElement.dataset.uiAccentColor === initial;
    await open();
    dialog.querySelector('[data-ui-color="#facc15"]').click();
    await pause();
    const style = getComputedStyle(dialog.querySelector('[data-settings-save]'));
    const yellowReadable = style.backgroundColor === 'rgb(250, 204, 21)' && style.color === 'rgb(0, 0, 0)';
    dialog.querySelector('[data-theme-toggle]').click();
    const darkKeepsColor = document.documentElement.dataset.uiAccentColor === '#facc15' && document.documentElement.dataset.theme === 'dark';
    dialog.querySelector('[data-theme-toggle]').click();
    const custom = dialog.querySelector('[data-ui-color-custom]');
    custom.value = '#123456'; custom.dispatchEvent(new Event('input', {bubbles:true}));
    const originalFetch = window.fetch;
    window.fetch = (url, init) => String(url) === '/api/settings' && init?.method === 'PUT'
      ? Promise.resolve(new Response(JSON.stringify({error:'test save failure'}), {status:503}))
      : originalFetch(url, init);
    dialog.querySelector('[data-settings-save]').click(); await pause();
    const failedSaveRetainsDraft = dialog.open && document.documentElement.dataset.uiAccentColor === '#123456' && !dialog.querySelector('[data-settings-save]').disabled;
    window.fetch = originalFetch;
    if (!dialog.open) await open();
    custom.value = '#123456'; custom.dispatchEvent(new Event('input', {bubbles:true}));
    dialog.querySelector('[data-settings-save]').click(); await pause();
    const saved = (await (await fetch('/api/settings')).json()).uiAccentColor;
    await open();
    let completeSave;
    window.fetch = (url, init) => String(url) === '/api/settings' && init?.method === 'PUT'
      ? new Promise(resolve => {completeSave=()=>resolve(originalFetch(url, init));})
      : originalFetch(url, init);
    dialog.querySelector('[data-settings-save]').click();
    dialog.querySelector('[data-settings-cancel]').click(); await pause();
    await open();
    dialog.querySelector('[data-ui-color="#7c3aed"]').click();
    completeSave(); await pause();
    window.fetch = originalFetch;
    const reopenedDraftPreserved = dialog.open && document.documentElement.dataset.uiAccentColor === '#7c3aed';
    dialog.querySelector('[data-settings-cancel]').click(); await pause();
    return {count,preview,notSaved,cancelled,yellowReadable,darkKeepsColor,failedSaveRetainsDraft,reopenedDraftPreserved,saved};
  })()`);
  check('UIカラー7色を選んで即時プレビューでき、キャンセルで元に戻る', colors.count === 7 && colors.preview === '#7c3aed' && colors.notSaved && colors.cancelled, JSON.stringify(colors));
  check('黄色のボタン文字が読みやすく、ダークモードでも選択色を保つ', colors.yellowReadable && colors.darkKeepsColor, JSON.stringify(colors));
  check('自由に指定したUIカラーが設定データに保存される', colors.saved === '#123456', JSON.stringify(colors));
  check('色の保存失敗時は設定を閉じず、選択色を保って再試行できる', colors.failedSaveRetainsDraft, JSON.stringify(colors));
  check('遅い保存の完了が、開き直した設定と新しいプレビューを閉じない', colors.reopenedDraftPreserved, JSON.stringify(colors));
  await send('Page.reload');
  await sleep(800);
  const restoredColor = await evaluate(`document.documentElement.dataset.uiAccentColor`);
  check('再読み込み後も保存したUIカラーで起動する', restoredColor === '#123456', String(restoredColor));

  const models = await evaluate(`(async () => {
    const { readModelSelection, populateModelSelection } = await import('/src/ai-model-picker.js');
    const originalFetch = window.fetch;
    let releaseRefresh;
    let mode = 'success';
    let requests = 0;
    window.fetch = async (url, init) => {
      if (String(url).startsWith('/api/ai/models/')) {
        requests += 1;
        if (mode === 'delayed') await new Promise(resolve => { releaseRefresh = resolve; });
        if (mode === 'error') return new Response(JSON.stringify({error:'CLI unavailable'}), {status:503});
        return new Response(JSON.stringify({models:[{id:'test-alpha',label:'Alpha'},{id:'test-beta',label:'Beta'}]}));
      }
      return originalFetch(url, init);
    };
    const pause = () => new Promise(r => setTimeout(r, 300));
    const open = async () => {
      document.querySelector('[data-view="calendar"] [data-settings-btn]').click();
      await pause();
      return document.querySelector('dialog[open]');
    };
    try {
      const dialog = await open();
      const panel = dialog.querySelector('[data-ai-provider-panel="codex"]');
      const select = panel.querySelector('[data-ai-model-select]');
      const defaultLabel = select.selectedOptions[0].textContent;
      const noRequestsWhileDisabled = requests === 0;
      dialog.querySelector('[data-ai-cli-enabled]').checked = true;
      dialog.querySelector('[data-ai-cli-enabled]').dispatchEvent(new Event('change'));
      const provider = dialog.querySelector('[data-ai-provider-select]');
      provider.value = 'codex'; provider.dispatchEvent(new Event('change'));
      await pause();
      const choices = [...select.options].map(o => o.value);
      select.value = 'test-beta'; select.dispatchEvent(new Event('change'));
      dialog.querySelector('[data-settings-save]').click();
      await pause();
      const saved = (await (await originalFetch('/api/settings')).json()).aiCodexModel;
      await open();
      const restored = select.value;
      mode = 'delayed';
      panel.querySelector('[data-ai-model-refresh]').click();
      select.value = '__manual_model__'; select.dispatchEvent(new Event('change'));
      panel.querySelector('[data-ai-model-manual]').value = 'my-custom-model';
      releaseRefresh(); await pause();
      const draftPreserved = readModelSelection(dialog, 'codex') === 'my-custom-model' && !panel.querySelector('[data-ai-model-manual]').hidden;
      mode = 'error';
      provider.value = 'claude-code'; provider.dispatchEvent(new Event('change'));
      await pause();
      const claude = dialog.querySelector('[data-ai-provider-panel="claude-code"]');
      const errorVisible = claude.querySelector('[data-ai-model-status]').textContent.includes('CLI unavailable');
      populateModelSelection(dialog, 'claude-code', 'saved-legacy-model');
      const legacyPreserved = readModelSelection(dialog, 'claude-code') === 'saved-legacy-model';
      claude.querySelector('[data-ai-model-refresh]').click(); await pause();
      const failedRefreshPreserved = readModelSelection(dialog, 'claude-code') === 'saved-legacy-model' && !claude.querySelector('[data-ai-model-refresh]').disabled;
      dialog.querySelector('[data-settings-cancel]').click();
      const Store = await import('/src/store.js');
      await Store.updateSettings({aiCliEnabled:false,aiProvider:'none'});
      return {defaultLabel,noRequestsWhileDisabled,choices,saved,restored,draftPreserved,errorVisible,legacyPreserved,failedRefreshPreserved};
    } finally { window.fetch = originalFetch; }
  })()`);
  check('モデル欄に空欄ではなく既定の選択肢を表示し、連携オフでは取得しない', models.defaultLabel.includes('既定を使用') && models.noRequestsWhileDisabled, JSON.stringify(models));
  check('取得したモデルを選択して保存し、設定を開き直しても保持する', models.choices.includes('test-alpha') && models.saved === 'test-beta' && models.restored === 'test-beta', JSON.stringify(models));
  check('モデル再取得中に手入力した値を上書きしない', models.draftPreserved, JSON.stringify(models));
  check('モデル取得失敗を表示し、保存済みのモデルを保持して再取得できる', models.errorVisible && models.legacyPreserved && models.failedRefreshPreserved, JSON.stringify(models));

  const enterMode = await evaluate(`(async () => {
    document.querySelector('[data-nav-target="ai"]').click();
    const pause=()=>new Promise(r=>setTimeout(r,250));await pause();
    const root=document.querySelector('.view[data-view="ai"]');
    const toggle=root.querySelector('[data-ai-enter-toggle]');
    if(!toggle)return {missing:true};
    const input=root.querySelector('[data-ai-input]');
    const initialOff=toggle.getAttribute('aria-checked')==='false';
    const originalFetch=window.fetch;let sends=0;
    window.fetch=(url,init)=>{
      if(String(url)==='/api/ai/chat'){sends++;return Promise.resolve(new Response(JSON.stringify({provider:'codex',model:'mock',message:{content:'送信確認'},proposals:[]})));}
      return originalFetch(url,init);
    };
    const Store=await import('/src/store.js');
    const press=async extra=>{input.value='送信テスト';const e=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...extra});input.dispatchEvent(e);await pause();return e.defaultPrevented;};
    try {
      await Store.updateSettings({aiCliEnabled:true,aiProvider:'codex'});
      const offEnter=await press({});const offDoesNotSend=sends===0&&!offEnter;
      await press({ctrlKey:true});const shortcutWorks=sends===1;
      toggle.click();await pause();const on=toggle.getAttribute('aria-checked')==='true';
      const before=sends;
      const shift=await press({shiftKey:true});await press({isComposing:true});await press({keyCode:229});await press({repeat:true});
      const safe=sends===before&&!shift;
      await press({});const onSends=sends===before+1;
      const saved=(await(await originalFetch('/api/settings')).json()).aiEnterToSend===true;
      await Store.updateSettings({aiCliEnabled:false,aiProvider:'none'});
      input.value='';
      return {initialOff,offDoesNotSend,shortcutWorks,on,safe,onSends,saved};
    } finally {window.fetch=originalFetch;}
  })()`);
  check('Enter送信は既定OFFで、Ctrl+Enterは従来どおり送信できる',enterMode.initialOff&&enterMode.offDoesNotSend&&enterMode.shortcutWorks,JSON.stringify(enterMode));
  check('ONではEnter送信、Shift+Enter・日本語変換中・キー長押しでは誤送信しない',enterMode.on&&enterMode.safe&&enterMode.onSends,JSON.stringify(enterMode));
  check('Enter送信の選択を保存する',enterMode.saved,JSON.stringify(enterMode));
  await send('Page.reload');await sleep(800);
  const restoredEnter=await evaluate(`(async()=>{document.querySelector('[data-nav-target="ai"]').click();await new Promise(r=>setTimeout(r,250));const toggle=document.querySelector('[data-ai-enter-toggle]');const restored=toggle?.getAttribute('aria-checked')==='true';toggle?.click();await new Promise(r=>setTimeout(r,250));return restored&&toggle?.getAttribute('aria-checked')==='false';})()`);
  check('再読み込み後もEnter送信設定を復元し、OFFへ戻せる',restoredEnter);

  const recurringAllDay = await evaluate(`(async () => {
    const Store=await import('/src/store.js');
    const {openCreateDialog,openEditDialog}=await import('/src/ui-utils.js');
    document.querySelector('[data-nav-target="calendar"]').click();
    await new Promise(r=>setTimeout(r,200));
    const dialog=document.querySelector('.view[data-view="calendar"] [data-task-dialog]');
    openCreateDialog(dialog,{date:'2026-09-14',isAllDay:true,tags:[]});
    dialog.querySelector('[name="title"]').value='終日繰り返し確認';
    dialog.querySelector('[data-save]').click();
    for(let i=0;i<40&&dialog.open;i++)await new Promise(r=>setTimeout(r,50));
    const task=Store.getAllTasks().find(t=>t.title==='終日繰り返し確認');
    openEditDialog(dialog,task,[]);
    dialog.querySelector('[data-btn-group="repeat"] [data-value="daily"]').click();
    dialog.querySelector('[name="repeatUntil"]').value='2026-09-17';
    dialog.querySelector('[data-save]').click();
    for(let i=0;i<40&&dialog.open;i++)await new Promise(r=>setTimeout(r,50));
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,250));
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,250));
    const rows=(await(await fetch('/api/tasks')).json()).filter(t=>t.title==='終日繰り返し確認');
    const base=rows.find(t=>t.id===task.id);
    await Store.updateTask(task.id,{memo:'追記',recurrence:base.recurrence});
    const repeatSaveCount=Store.getAllTasks().filter(t=>t.recurrence?.groupId===base.recurrence.groupId).length;
    for(const row of rows.filter(t=>t.id!==task.id))await Store.deleteTaskWithMode(row.id,'single');
    await Store.updateTask(task.id,{title:'残した終日予定',recurrence:base.recurrence});
    const deletedStayDeleted=Store.getAllTasks().filter(t=>t.recurrence?.groupId===base.recurrence.groupId).length===1;
    const alternatives=[];
    for(const [type,date,until,expected] of [
      ['weekly','2026-09-14','2026-09-28',['2026-09-14','2026-09-21','2026-09-28']],
      ['monthly','2026-01-31','2026-03-31',['2026-01-31','2026-02-28','2026-03-31']],
    ]){
      const single=await Store.createTask({title:'終日 '+type,date,isAllDay:true,tagId:''});
      const updated=await Store.updateTaskWithMode(single.id,{recurrence:{type,until}},'single');
      const dates=Store.getAllTasks().filter(t=>t.recurrence?.groupId===updated.recurrence.groupId).map(t=>t.date).sort();
      alternatives.push(JSON.stringify(dates)===JSON.stringify(expected));
    }
    return {dates:rows.map(t=>t.date).sort(),allDay:rows.every(t=>t.isAllDay),groupIds:[...new Set(rows.map(t=>t.recurrence.groupId))],repeatSaveCount,deletedStayDeleted,alternatives};
  })()`);
  check('保存済みの終日予定を毎日繰り返しに変更すると終了日まで保存される',JSON.stringify(recurringAllDay.dates)==='["2026-09-14","2026-09-15","2026-09-16","2026-09-17"]'&&recurringAllDay.allDay&&recurringAllDay.groupIds.length===1,JSON.stringify(recurringAllDay));
  check('終日予定の毎週・月末の毎月への変更も反映される',recurringAllDay.alternatives.every(Boolean),JSON.stringify(recurringAllDay));
  check('繰り返しの再保存で重複せず、削除した回をタイトル編集で復活させない',recurringAllDay.repeatSaveCount===4&&recurringAllDay.deletedStayDeleted,JSON.stringify(recurringAllDay));

  const updaterUi = await evaluate(`(async () => {
    const Store=await import('/src/store.js');
    const nativeInfo=await window.__TAURI__.core.invoke('get_update_info');
    document.querySelector('[data-view="calendar"] [data-settings-btn]').click();
    const settings=document.querySelector('[data-settings-dialog]');
    const preference=settings.querySelector('[name="checkUpdatesOnStartup"]');
    const defaultOn=preference.checked;
    preference.checked=false; settings.querySelector('[data-settings-save]').click();
    await new Promise(r=>setTimeout(r,350));
    document.querySelector('[data-view="calendar"] [data-settings-btn]').click();
    const persistedOff=!preference.checked && Store.getSettings().checkUpdatesOnStartup===false;
    settings.querySelector('[data-settings-cancel]').click();
    const container=document.createElement('div');
    container.innerHTML='<button data-update-check></button><button data-update-open hidden></button><span data-update-current></span><p data-update-status></p>';
    container.append(document.querySelector('[data-update-dialog]').cloneNode(true));
    document.body.append(container);
    const originalInvoke=window.__TAURI__.core.invoke;
    let offline=true, installations=0;
    const invoke=async (cmd,args)=>{
      if(cmd==='get_update_info') return {currentVersion:'0.1.0',installSupported:true};
      if(cmd==='check_app_update') { if(offline) throw '通信できません'; return {version:'0.2.0',notes:'<img src=x onerror=alert(1)>'}; }
      if(cmd==='install_app_update') { installations++; args.onProgress.onmessage({downloaded:50,total:100}); throw '署名の検証に失敗しました'; }
      return originalInvoke(cmd,args);
    };
    try {
      const {initAppUpdater}=await import('/src/app-updater.js');
      await initAppUpdater(Store,container,{core:{invoke,Channel:window.__TAURI__.core.Channel}});
      const wait=()=>new Promise(r=>setTimeout(r,50));
      container.querySelector('[data-update-check]').click(); await wait();
      const failure=container.querySelector('[data-update-status]').textContent==='通信できません';
      offline=false; container.querySelector('[data-update-check]').click(); await wait();
      const available=!container.querySelector('[data-update-open]').hidden;
      container.querySelector('[data-update-open]').click();
      const modal=container.querySelector('dialog');
      const escaped=!modal.querySelector('[data-update-notes] img') && modal.querySelector('[data-update-notes]').textContent.startsWith('<img');
      const editor=document.createElement('dialog'); container.append(editor); editor.show();
      modal.querySelector('[data-update-install]').click(); await wait();
      const guarded=installations===0 && modal.querySelector('[data-update-status]').textContent.includes('保存');
      editor.close(); editor.remove();
      modal.querySelector('[data-update-install]').click(); await wait();
      const retry=installations===1 && !modal.querySelector('[data-update-install]').disabled && modal.querySelector('[data-update-status]').textContent.includes('署名');
      modal.close();
      return {nativeInfo,defaultOn,persistedOff,failure,available,escaped,guarded,retry};
    } finally {container.remove();}
  })()`);
  check('更新用のネイティブコマンドと設定の既定ON・OFF保存が動作する',Boolean(updaterUi.nativeInfo.currentVersion)&&updaterUi.defaultOn&&updaterUi.persistedOff,JSON.stringify(updaterUi));
  check('更新UIは通信失敗・新版・安全なリリースノートを表示する',updaterUi.failure&&updaterUi.available&&updaterUi.escaped,JSON.stringify(updaterUi));
  check('更新UIは編集中のインストールを防ぎ、検証失敗後に再試行できる',updaterUi.guarded&&updaterUi.retry,JSON.stringify(updaterUi));

  // 実CLIの認証状態に依存するため明示指定時のみ。会話や推論は行わない。
  if (process.env.TCPLUS_E2E_LIVE_MODELS === '1') {
    const live = await evaluate(`fetch('/api/ai/models/codex').then(async r => ({status:r.status,body:await r.json()}))`);
    check('実際のCodexからモデル一覧を取得できる', live.status === 200 && live.body.models?.length > 0, JSON.stringify(live));
    console.log('Codex models: ' + JSON.stringify(live.body.models?.map(m => m.id)));
  }
  ws.close();
} catch (e) {
  check('スモークテストを実行できる', false, String(e?.message ?? e));
} finally {
  app.kill();
  await sleep(1000);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* WebView2のファイルが残っている場合は無視 */ }
}

if (failed) {
  console.log(`\n${failed}件失敗。`);
  process.exit(1);
}
console.log('\n全テスト成功。');
