// 実際のアプリ(Tauri + WebView2)を起動して、画面が正しく立ち上がるかを確かめるスモークテスト。
// WebView2 のリモートデバッグ(Chrome DevTools Protocol)で画面を操作する。
// 普段のデータを汚さないよう、一時フォルダをデータ保存先(TCPLUS_DATA_DIR)にして起動する。
//
// 使い方(リポジトリ直下、Windows): node scripts/e2e-smoke.mjs
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PORT = 9350;
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


  const results=[];let seeded=0;
  await evaluate("(async()=>{const S=await import('/src/store.js');window.perfTag=await S.createTag({name:'Work',color:'#0072bc'});})()");
  for(const count of [1000,10000,50000]) {
    for(let offset=seeded;offset<count;offset+=5000) {
      const n=Math.min(5000,count-offset);
      await evaluate('(async()=>{const rows=[];let date=new Date(2026,8,25);for(let d=0;d<Math.floor('+offset+'/10);d++){date.setDate(date.getDate()+1);while([0,6].includes(date.getDay()))date.setDate(date.getDate()+1);}for(let i='+offset+';i<'+(offset+n)+';i++){if(i>'+offset+'&&i%10===0){date.setDate(date.getDate()+1);while([0,6].includes(date.getDay()))date.setDate(date.getDate()+1);}const dateKey=[date.getFullYear(),String(date.getMonth()+1).padStart(2,"0"),String(date.getDate()).padStart(2,"0")].join("-");const mins=540+(i%10)*30;const clock=m=>String(Math.floor(m/60)).padStart(2,"0")+":"+String(m%60).padStart(2,"0");rows.push({id:"perf-"+i,title:"作業 "+i,date:dateKey,startTime:clock(mins),endTime:clock(mins+30),tagId:window.perfTag.id,isAllDay:false,recurrence:{type:"none"},memo:"",createdAt:"2026-09-25T00:00:00Z",updatedAt:"2026-09-25T00:00:00Z"});}const r=await fetch("/api/tasks/batch",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({expected:[],upserts:rows,deleteIds:[]})});if(!r.ok)throw Error(await r.text());await r.arrayBuffer();})()');
    }
    seeded=count;
    await evaluate("(async()=>{const S=await import('/src/store.js');await S.refreshTasks();(await import('/src/ui-utils.js')).syncViewDate('2026-09-25');})()");
    for(const view of ['tasks','ai','calendar']) {await evaluate('document.querySelector(\'[data-nav-target="'+view+'"]\').click()');await sleep(100);}
    const result=await evaluate(`(async()=>{
      const S=await import('/src/store.js');
      const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
      const lookup=[],summary=[],refresh=[],bytes=[],heap=[];let hiddenMutations=0;
      const observer=new MutationObserver(records=>{hiddenMutations+=records.length});
      for(const el of document.querySelectorAll('.view[hidden]'))observer.observe(el,{subtree:true,childList:true,characterData:true});
      for(let sample=0;sample<10;sample++) {
        let start=performance.now();for(let i=0;i<100;i++)S.getTasksByDate('2026-09-25');lookup.push(performance.now()-start);
        start=performance.now();for(let i=0;i<100;i++)S.calcMonthSummary('2026-09');summary.push(performance.now()-start);
        performance.clearResourceTimings();start=performance.now();await S.refreshTasks();refresh.push(performance.now()-start);
        heap.push(performance.memory?.usedJSHeapSize ?? null);
        bytes.push(performance.getEntriesByType('resource').filter(e=>e.name.endsWith('/api/tasks')).reduce((sum,e)=>sum+e.encodedBodySize,0));
      }
      await new Promise(r=>setTimeout(r,50));observer.disconnect();
      return {browser:navigator.userAgent,count:S.getAllTasks().length,dayTasks:S.getTasksByDate('2026-09-25').length,monthMinutes:S.calcMonthSummary('2026-09').total,lookup100Ms:median(lookup),summary100Ms:median(summary),unchangedRefreshMs:median(refresh),unchangedBodyBytes:median(bytes),hiddenMutations,rawSamples:{lookup100Ms:lookup,summary100Ms:summary,unchangedRefreshMs:refresh,unchangedBodyBytes:bytes,jsHeapBytes:heap}};
    })()`);
    results.push(result);console.log(JSON.stringify(result));
  }
  fs.mkdirSync('out/performance',{recursive:true});fs.writeFileSync('out/performance/'+(process.env.PERF_LABEL||'current')+'.json',JSON.stringify(results,null,2));
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
