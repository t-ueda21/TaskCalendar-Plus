// 実際のアプリ(Tauri + WebView2)を起動して、画面が正しく立ち上がるかを確かめるスモークテスト。
// WebView2 のリモートデバッグ(Chrome DevTools Protocol)で画面を操作する。
// 普段のデータを汚さないよう、一時フォルダをデータ保存先(TCPLUS_DATA_DIR)にして起動する。
//
// 使い方(リポジトリ直下、Windows): node scripts/e2e-smoke.mjs
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PORT = 9354;
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
    if (m.method === 'Page.loadEventFired') globalThis.refactorPageLoaded=true;
    if (m.method === 'Input.dragIntercepted') globalThis.cdpDragData=m.params.data;
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
    booted = await evaluate('document.body?.style.opacity === "1"');
    if (!booted) await sleep(500);
  }
  check('画面の初期化が完了する', booted);


  const inPage = (fn, ...args) => evaluate('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
  const outputDir = path.resolve('out/refactor-20260927/ui-current');
  fs.mkdirSync(outputDir, {recursive:true});
  await send('Page.addScriptToEvaluateOnNewDocument', {source:'('+(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const raw = typeof input === 'string' ? input : input.url;
      if (/^https:\/\/(?:archive-api\.|api\.)open-meteo\.com\//.test(raw)) {
        const url = new URL(raw), days = [], cursor = new Date(url.searchParams.get('start_date')+'T12:00:00Z');
        const end = url.searchParams.get('end_date');
        while(cursor.toISOString().slice(0,10)<=end) { days.push(cursor.toISOString().slice(0,10)); cursor.setUTCDate(cursor.getUTCDate()+1); }
        return Promise.resolve(new Response(JSON.stringify({daily:{time:days,weather_code:days.map(()=>1),temperature_2m_max:days.map(()=>25),temperature_2m_min:days.map(()=>18)}}),{status:200,headers:{'Content-Type':'application/json'}}));
      }
      return original(input, options);
    };
  }).toString()+')()'});
  globalThis.refactorPageLoaded=false;
  await send('Page.reload');
  let reloadReady=false;
  for(let i=0;i<60&&!reloadReady;i++){reloadReady=globalThis.refactorPageLoaded&&await evaluate('document.body?.style.opacity === "1"');if(!reloadReady)await sleep(150);}
  if(!reloadReady)throw Error('Reload did not finish initialization');
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:860,deviceScaleFactor:1,mobile:false});
  await inPage(async()=>{
    const S=await import('/src/store.js'), U=await import('/src/ui-utils.js');
    const work=await S.createTag({name:'開発作業',color:'#0072bc'}), meeting=await S.createTag({name:'打ち合わせ',color:'#7c5cd6'});
    await S.setMonthTagOrder('2026-09',[work.id,meeting.id]);
    await S.createTask({id:'baseline-timed',title:'設計レビュー',date:'2026-09-25',startTime:'14:00',endTime:'15:00',tagId:work.id,memo:'検証用の合成データ'});
    await S.createTask({id:'baseline-all-day',title:'資料提出',date:'2026-09-25',isAllDay:true,tagId:meeting.id});
    U.syncViewDate('2026-09-25');(await import('/src/calendar.js')).activate();
    const mode=document.querySelector('[data-viewmode]');mode.value='day';mode.dispatchEvent(new Event('change'));
    const style=document.createElement('style');style.textContent='*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}[data-now],[data-today-date],[data-remaining]{visibility:hidden!important}';document.head.appendChild(style);
    await document.fonts.ready;
  });
  await sleep(300);
  const semantic=[];
  async function capture(name) {
    await sleep(160);
    const info=await inPage(()=>{
      const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
      const buttons=[...document.querySelectorAll('.view:not([hidden]) .toolbar .right button')].map(e=>{
        const r=e.getBoundingClientRect(),c=getComputedStyle(e);return {text:e.textContent.trim(),x:r.x,y:r.y,width:r.width,height:r.height,font:c.fontSize,radius:c.borderRadius,icon:e.querySelector('svg')?.getBoundingClientRect().width};
      });
      const switches=[...document.querySelectorAll('.uiToggle')].filter(visible).map(e=>{const r=e.querySelector('.themeToggleTrack')?.getBoundingClientRect();return {label:e.textContent.trim(),width:r?.width,height:r?.height};});
      return {buttons,switches};
    });
    semantic.push({name,...info});
    const image=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(outputDir,name+'.png'),Buffer.from(image.result.data,'base64'));
  }
  const title='UI <作成> & 確認';
  const created=await inPage(async title=>{
    const S=await import('/src/store.js');document.querySelector('[data-view=calendar] [data-new-task]').click();const d=document.querySelector('[data-view=calendar] [data-task-dialog]');
    d.querySelector('[name=title]').value=title;d.querySelector('[name=date]').value='2026-09-25';d.querySelector('[name=startTime]').value='10:00';d.querySelector('[name=endTime]').value='11:00';d.querySelector('[name=memo]').value='保存して再表示';
    d.querySelector('[data-save]').click();for(let i=0;i<40&&d.open;i++)await new Promise(r=>setTimeout(r,25));
    const t=S.getTasksByDate('2026-09-25').find(t=>t.title===title);return {id:t?.id,closed:!d.open,memo:t?.memo,start:t?.startTime};
  },title);
  check('UIで予定作成: タイトル・時刻・メモを保存する',created.id&&created.closed&&created.memo==='保存して再表示'&&created.start==='10:00',JSON.stringify(created));
  const cancel=await inPage(async()=>{const S=await import('/src/store.js'),before=S.getAllTasks().length;document.querySelector('[data-view=calendar] [data-new-task]').click();const d=document.querySelector('[data-view=calendar] [data-task-dialog]');d.querySelector('[name=title]').value='破棄される予定';d.querySelector('[data-cancel]').click();return !d.open&&S.getAllTasks().length===before;});
  check('予定作成のキャンセルはデータを増やさない',cancel);
  const edit=await inPage(async(id)=>{const S=await import('/src/store.js');const block=document.querySelector('[data-view=day] [data-task-id="'+id+'"]');block.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));const d=document.querySelector('[data-view=calendar] [data-task-dialog]');const restored=d.querySelector('[name=memo]').value==='保存して再表示';d.querySelector('[name=title]').value='UI 編集済み';d.querySelector('[data-save]').click();for(let i=0;i<40&&d.open;i++)await new Promise(r=>setTimeout(r,25));return restored&&S.getAllTasks().find(t=>t.id===id)?.title==='UI 編集済み';},created.id);
  check('UIで再編集: IDを保ち、保存済みメモとタイトルを扱える',edit);
  const emptyTitle=await inPage(async()=>{const S=await import('/src/store.js'),before=S.getAllTasks().length;document.querySelector('[data-view=calendar] [data-new-task]').click();const d=document.querySelector('[data-view=calendar] [data-task-dialog]');d.querySelector('[data-save]').click();await new Promise(r=>setTimeout(r,50));const ok=d.open&&S.getAllTasks().length===before;d.querySelector('[data-cancel]').click();return ok;});
  check('空タイトルでは保存せず編集画面を維持する',emptyTitle);
  await inPage(async(id)=>{const S=await import('/src/store.js');await S.deleteTask(id);},created.id);
  // Drag a real time block by one 30-minute slot; use native pointer events.
  await inPage(()=>document.querySelector('[data-view=day] [data-task-id=baseline-timed]').scrollIntoView({block:'center'}));await sleep(100);
  const drag=await inPage(()=>{const r=document.querySelector('[data-view=day] [data-task-id=baseline-timed]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
  await send('Input.setInterceptDrags',{enabled:true});
  globalThis.cdpDragData=null;
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:drag.x,y:drag.y,button:'left',buttons:1,clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:drag.x+8,y:drag.y,button:'left',buttons:1});await sleep(70);
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:drag.x+8,y:drag.y+34,button:'left',buttons:1});await sleep(70);
  for(let i=0;i<20&&!globalThis.cdpDragData;i++)await sleep(20);
  if(!globalThis.cdpDragData)throw Error('Native drag data was not intercepted');
  for(const type of ['dragEnter','dragOver','drop'])await send('Input.dispatchDragEvent',{type,x:drag.x+8,y:drag.y+34,data:globalThis.cdpDragData});
  await send('Input.setInterceptDrags',{enabled:false});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:drag.x+8,y:drag.y+34,button:'left',buttons:0,clickCount:1});await sleep(180);
  const moved=await inPage(async()=>{const S=await import('/src/store.js');return S.getAllTasks().find(t=>t.id==='baseline-timed');});
  check('ドラッグ移動は予定IDと所要時間を保持する',moved.id==='baseline-timed'&&moved.startTime!=='14:00'&&(Number(moved.endTime.slice(0,2))*60+Number(moved.endTime.slice(3)))-(Number(moved.startTime.slice(0,2))*60+Number(moved.startTime.slice(3)))===60,JSON.stringify(moved));
  await inPage(async()=>{const S=await import('/src/store.js');await S.updateTask('baseline-timed',{startTime:'14:00',endTime:'15:00'});});

  await inPage(()=>document.querySelector('[data-view=day] [data-task-id=baseline-timed]').scrollIntoView({block:'center'}));await sleep(80);
  const handle=await inPage(()=>{const handles=document.querySelector('[data-view=day] [data-task-id=baseline-timed]').querySelectorAll('.resizeHandle');const r=handles[handles.length-1].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:handle.x,y:handle.y,button:'left',buttons:1,clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:handle.x,y:handle.y+34,button:'left',buttons:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:handle.x,y:handle.y+34,button:'left',buttons:0,clickCount:1});await sleep(180);
  check('下端のリサイズは開始時刻を保って終了時刻を変える',await inPage(async()=>{const S=await import('/src/store.js');const t=S.getAllTasks().find(t=>t.id==='baseline-timed');return t.startTime==='14:00'&&t.endTime==='15:30';}));
  async function shortcut(key,code) {await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,modifiers:2,windowsVirtualKeyCode:key.toUpperCase().charCodeAt(0)});await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers:2,windowsVirtualKeyCode:key.toUpperCase().charCodeAt(0)});await sleep(160);}
  await inPage(()=>document.activeElement?.blur());await shortcut('z','KeyZ');
  check('リサイズをUndoすると同じ予定の元の時刻へ戻る',await inPage(async()=>{const S=await import('/src/store.js');const t=S.getAllTasks().find(t=>t.id==='baseline-timed');return t.startTime==='14:00'&&t.endTime==='15:00';}));
  await inPage(()=>{document.querySelector('[data-view=day] [data-task-id=baseline-timed]').click();document.activeElement?.blur();});
  await shortcut('c','KeyC');await shortcut('v','KeyV');
  check('コピーと貼り付けは別IDで内容を複製する',await inPage(async()=>{const S=await import('/src/store.js');const tasks=S.getAllTasks().filter(t=>t.title==='設計レビュー');return tasks.length===2&&new Set(tasks.map(t=>t.id)).size===2&&tasks.every(t=>t.memo==='検証用の合成データ');}));
  await shortcut('z','KeyZ');
  check('貼り付けのUndoは元の予定を残す',await inPage(async()=>{const S=await import('/src/store.js');const tasks=S.getAllTasks();return tasks.length===2&&tasks.some(t=>t.id==='baseline-timed');}));
  for(const view of ['calendar','tasks','ai']) {
    await inPage(view=>document.querySelector('[data-nav-target="'+view+'"]').click(),view);await sleep(180);
    const ok=await inPage(view=>{const root=document.querySelector('#viewRoot>.view[data-view="'+view+'"]');return !root.hidden&&root.querySelectorAll('[data-sidebar-toggle]').length===1&&root.querySelectorAll('[data-mini-cal]').length===1&&root.querySelectorAll('[data-settings-btn]').length===1;},view);
    check(view+' 共通部品が1組だけ配置され、表示できる',ok);
    const toggle=await inPage(view=>{const button=document.querySelector('.view[data-view="'+view+'"] [data-sidebar-toggle]');button.click();const off=button.getAttribute('aria-expanded')==='false';button.click();return off&&button.getAttribute('aria-expanded')==='true'&&!!button.querySelector('svg+span');},view);
    check(view+' サイド開閉後もアイコンと文字・表示状態を維持する',toggle);
    await capture(view+'-light-wide');
  }
  await inPage(()=>document.querySelector('[data-nav-target=calendar]').click());await sleep(100);
  await inPage(()=>document.querySelector('[data-view=calendar] [data-settings-btn]').click());
  for(const tab of ['general','advanced','tags','outlook','about']) {
    await inPage(tab=>document.querySelector('[data-settings-tab="'+tab+'"]').click(),tab);
    check('設定 '+tab+' タブを表示できる',await inPage(tab=>!document.querySelector('[data-settings-tab-panel="'+tab+'"]').hidden,tab));
    await capture('settings-'+tab+'-light');
  }
  const switchState=await inPage(()=>{document.querySelector('[data-settings-tab=outlook]').click();const s=document.querySelector('[name=outlookAutoSync]');const before=s.checked;s.closest('label').click();const changed=s.checked!==before&&!document.querySelector('[name=outlookAutoSyncIntervalMin]').disabled;s.closest('label').click();return changed&&s.checked===before;});
  check('共通トグル: クリックと間隔選択の無効状態が連動する',switchState);
  await inPage(()=>document.querySelector('[data-theme-toggle]').click());await sleep(160);
  await capture('settings-outlook-dark');
  await inPage(()=>document.querySelector('[data-settings-cancel]').click());
  await capture('calendar-dark-wide');
  await send('Emulation.setDeviceMetricsOverride',{width:1024,height:800,deviceScaleFactor:1,mobile:false});
  await capture('calendar-dark-narrow');
  await inPage(()=>document.querySelector('[data-view=calendar] [data-settings-btn]').click());
  await inPage(()=>document.querySelector('[data-theme-toggle]').click());await sleep(120);
  await inPage(()=>document.querySelector('[data-settings-cancel]').click());
  await capture('calendar-light-narrow');
  const validSwitches=semantic.flatMap(s=>s.switches).every(s=>s.width===38&&s.height===21);
  check('トグル本体は全画面・両テーマで38×21px',validSwitches);
  const final=await inPage(async()=>{const S=await import('/src/store.js');return {tasks:S.getAllTasks().map(t=>({id:t.id,title:t.title,date:t.date,isAllDay:t.isAllDay,startTime:t.startTime,endTime:t.endTime,memo:t.memo})).sort((a,b)=>a.id.localeCompare(b.id)),day:S.calcDaySummary('2026-09-25').total,month:S.calcMonthSummary('2026-09').total};});
  check('画面・設定操作後も予定と集計を保持する',final.tasks.length===2&&final.day===60&&final.month===60,JSON.stringify(final));
  fs.writeFileSync(path.join(outputDir,'semantic.json'),JSON.stringify({views:semantic,data:final},null,2));
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
