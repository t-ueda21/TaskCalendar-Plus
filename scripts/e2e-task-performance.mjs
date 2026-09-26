// 実際のアプリ(Tauri + WebView2)を起動して、画面が正しく立ち上がるかを確かめるスモークテスト。
// WebView2 のリモートデバッグ(Chrome DevTools Protocol)で画面を操作する。
// 普段のデータを汚さないよう、一時フォルダをデータ保存先(TCPLUS_DATA_DIR)にして起動する。
//
// 使い方(リポジトリ直下、Windows): node scripts/e2e-smoke.mjs
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PORT = 9351;
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
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.exception?.value ?? r.result.exceptionDetails.text ?? 'evaluate failed');
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


  const seeded=await evaluate(`(async()=>{
    const S=await import('/src/store.js');const U=await import('/src/ui-utils.js');
    const tag=await S.createTag({name:'性能検証',color:'#0072bc'});await S.setMonthTagOrder('2026-09',[tag.id]);
    U.syncViewDate('2026-09-25');window.performanceTag=tag.id;
    const task=await S.createTask({title:'既存の予定',date:'2026-09-25',startTime:'09:00',endTime:'10:00',tagId:tag.id});return task.id;
  })()`);
  for(const view of ['tasks','ai','calendar']){await evaluate('document.querySelector(\'[data-nav-target="'+view+'"]\').click()');await sleep(200);}
  await evaluate("(()=>{const select=document.querySelector('[data-viewmode]');select.value='day';select.dispatchEvent(new Event('change'));})()");
  const refreshed=await evaluate(`(async()=>{
    const S=await import('/src/store.js');await S.refreshTasks();
    let notifications=0;const off=S.subscribe('tasks',()=>notifications++);
    let hidden=0,week=0;const observer=new MutationObserver(rows=>hidden+=rows.length),weekObserver=new MutationObserver(rows=>week+=rows.length);
    for(const el of document.querySelectorAll('#viewRoot>.view[hidden]'))observer.observe(el,{subtree:true,childList:true,characterData:true});
    weekObserver.observe(document.querySelector('[data-view=calendar] [data-view=week]'),{subtree:true,childList:true,characterData:true});
    await S.refreshTasks();const unchanged=notifications===0;
    const response=await fetch('/api/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'performance-remote',title:'同期で追加',date:'2026-09-25',startTime:'10:00',endTime:'11:00',tagId:window.performanceTag,isAllDay:false,recurrence:{type:'none'}})});
    if(!response.ok)throw Error(await response.text());await S.refreshTasks();await new Promise(r=>setTimeout(r,100));
    observer.disconnect();weekObserver.disconnect();off();
    return {unchanged,changed:notifications===1,hidden,week,visible:!!document.querySelector('[data-view=day] [data-task-id="performance-remote"]')};
  })()`);
  check('未変更の再取得は通知・再描画せず、同期変更は反映する',refreshed.unchanged&&refreshed.changed&&refreshed.visible,JSON.stringify(refreshed));
  check('非表示タブと非表示の週は描き直さない',refreshed.hidden===0&&refreshed.week===0,JSON.stringify(refreshed));
  await evaluate("(()=>{const select=document.querySelector('[data-viewmode]');select.value='week';select.dispatchEvent(new Event('change'));})()");
  check('週へ切り替えると最新の予定が表示される',await evaluate("!!document.querySelector('[data-view=week] [data-task-id=\"performance-remote\"]')"));
  await evaluate("document.querySelector('[data-nav-target=tasks]').click()");await sleep(200);
  check('タスク一覧を開くと最新の予定へ追いつく',await evaluate("document.querySelector('[data-task-tbody]').textContent.includes('同期で追加')"));
  await evaluate("(async()=>{const S=await import('/src/store.js');await S.updateSettings({granularity:60,showBusinessDaysOnly:false});})()");
  await evaluate("document.querySelector('[data-nav-target=calendar]').click()");await sleep(200);
  check('非表示中の設定変更も再表示時に反映する',await evaluate("document.querySelector('[data-granularity]').value==='60' && !document.querySelector('[data-businessdays-only]').checked && !document.querySelector('[data-weekcol][data-weekday=Sun]').hidden"));

  await evaluate("(()=>{const select=document.querySelector('[data-granularity]');select.value='15';select.dispatchEvent(new Event('change'));const business=document.querySelector('[data-businessdays-only]');business.checked=true;business.dispatchEvent(new Event('change'));document.querySelector('[data-nav-target=tasks]').click()})()");await sleep(150);
  await evaluate("document.querySelector('[data-nav-target=calendar]').click()");await sleep(150);
  check('タブ往復で一時的な粒度・営業日表示を保持する',await evaluate("document.querySelector('[data-granularity]').value==='15'&&document.querySelector('[data-businessdays-only]').checked"));
  await evaluate("(()=>{const mode=document.querySelector('[data-viewmode]');mode.value='day';mode.dispatchEvent(new Event('change'));document.querySelector('[data-view=day] [data-task-id=\"performance-remote\"]').click();mode.value='week';mode.dispatchEvent(new Event('change'));document.querySelector('[data-shift-next]').click();document.activeElement?.blur();})()");
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'x',code:'KeyX',modifiers:2,windowsVirtualKeyCode:88});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'x',code:'KeyX',modifiers:2,windowsVirtualKeyCode:88});await sleep(150);
  check('日・週や日付を変えた後に隠れた予定を切り取らない',await evaluate("(async()=>{const S=await import('/src/store.js');return S.getAllTasks().some(t=>t.id==='performance-remote')})()"));
  await evaluate("document.querySelector('[data-shift-prev]').click()");

  const removed=await evaluate("(async()=>{const S=await import('/src/store.js');await fetch('/api/tasks/performance-remote',{method:'DELETE'});await S.refreshTasks();return !S.getAllTasks().some(t=>t.id==='performance-remote')&&!document.querySelector('[data-view=week] [data-task-id=\"performance-remote\"]')})()");
  check('同期による削除も変更番号を通じて反映する',removed);
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
