// 実際のアプリ(Tauri + WebView2)を起動して、画面が正しく立ち上がるかを確かめるスモークテスト。
// WebView2 のリモートデバッグ(Chrome DevTools Protocol)で画面を操作する。
// 普段のデータを汚さないよう、一時フォルダをデータ保存先(TCPLUS_DATA_DIR)にして起動する。
//
// 使い方(リポジトリ直下、Windows): node scripts/e2e-smoke.mjs
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'node:http';

const PORT = 9368;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcplus-e2e-'));
const exe = path.resolve(process.env.TCPLUS_E2E_EXE || 'src-tauri/target/debug/taskcalendar-plus.exe');

// 古い実行ファイルで検査しないよう毎回ビルドする(変更が無ければすぐ終わる)。
// 起動中のexeを上書きできない場合は、別の場所でビルドしたexeを明示指定できる。
if (!process.env.TCPLUS_E2E_EXE) execFileSync('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml'], { stdio: 'inherit' });


const requests=[];
const mock=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const payload=raw?JSON.parse(raw):null;requests.push({path:req.url,body:payload});
  res.setHeader('Content-Type','application/json');
  if(req.url==='/bad/v1/models'){res.statusCode=401;res.end(JSON.stringify({error:{message:'Authentication required'}}));return;}
  if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'local-test'},{id:'manual-alternative'}]}));return;}
  const messages=payload.messages, last=messages.at(-1);
  const answer=(content)=>res.end(JSON.stringify({model:payload.model,choices:[{finish_reason:'stop',message:{role:'assistant',content}}]}));
  const call=(name,args)=>res.end(JSON.stringify({model:payload.model,choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'call-'+messages.length,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]}));
  if(payload.tools?.some(t=>t.function.name==='local_connection_probe')){
    if(last.role==='tool'){answer('TCPLUS_LOCAL_OK');return;}
    call('local_connection_probe',{nonce:'tcplus-check'});return;
  }
  if(payload.response_format){answer(JSON.stringify({summary:'ローカルのテスト要約',highlights:['作業を確認']}));return;}
  if(!payload.tools){answer('local plain response');return;}
  const called=messages.filter(m=>m.role==='assistant').flatMap(m=>m.tool_calls??[]).map(t=>t.function.name);
  if(!called.includes('search_tasks')){call('search_tasks',{dateFrom:'2026-09-28',dateTo:'2026-09-28'});return;}
  if(!called.includes('propose_create_task')){call('propose_create_task',{date:'2026-09-28',startTime:'10:00',endTime:'11:00',title:'ローカルAIの提案'});return;}
  answer('予定を確認しました。追加する予定を確認してください。');
});
await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
const endpoint='http://127.0.0.1:'+mock.address().port+'/v1';

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
    if (m.method === 'Runtime.exceptionThrown') console.log('PAGE ERROR:',JSON.stringify(m.params.exceptionDetails));
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
  await send('Runtime.enable');

  // 画面の初期化完了(body の opacity が 1 になる)を待つ。
  let booted = false;
  for (let i = 0; i < 30 && !booted; i += 1) {
    booted = await evaluate('document.body.style.opacity === "1"');
    if (!booted) await sleep(500);
  }
  check('画面の初期化が完了する', booted);

  const waitFor = async expression => { for(let i=0;i<100;i++){if(await evaluate(expression))return true;await sleep(50);}return false; };
  await evaluate("(async()=>{window.localStore = await import('/src/store.js')})()");
  for(const [provider,key] of [['ollama','aiOllama'],['lmstudio','aiLmStudio']]) {
    await evaluate(`document.querySelector('[data-view=calendar] [data-settings-btn]').click()`);
    await evaluate(`(()=>{const s=document.querySelector('[data-ai-provider-select]');s.value='${provider}';s.dispatchEvent(new Event('change'));const p=document.querySelector('[data-ai-provider-panel=${provider}]');p.querySelector('[data-local-ai-endpoint]').value='${endpoint}';p.querySelector('[data-local-ai-endpoint]').dispatchEvent(new Event('input'));p.querySelector('[data-local-ai-action=models]').click();})()`);
    check(provider+' CLI同意なしでモデル候補を取得',await waitFor(`document.querySelector('[data-ai-provider-panel=${provider}] [data-local-ai-model]')?.tagName==='SELECT' && [...document.querySelector('[data-ai-provider-panel=${provider}] [data-local-ai-model]').options].some(o=>o.value==='local-test')`));
    await evaluate(`(()=>{const p=document.querySelector('[data-ai-provider-panel=${provider}]'),m=p.querySelector('[data-local-ai-model]');m.value='__manual_model__';m.dispatchEvent(new Event('change'));p.querySelector('[data-local-ai-manual]').value='manual-test';p.querySelector('[data-local-ai-manual]').dispatchEvent(new Event('input'));p.querySelector('[data-local-ai-action=models]').click();})()`);
    check(provider+' 再取得しても手入力のモデル名を保持',await waitFor(`(()=>{const p=document.querySelector('[data-ai-provider-panel=${provider}]');return !p.querySelector('[data-local-ai-action=models]').disabled&&!p.querySelector('[data-local-ai-manual]').hidden&&p.querySelector('[data-local-ai-manual]').value==='manual-test';})()`));
    await evaluate(`(()=>{const p=document.querySelector('[data-ai-provider-panel=${provider}]');p.querySelector('[data-local-ai-model]').value='local-test';p.querySelector('[data-local-ai-model]').dispatchEvent(new Event('change'));p.querySelector('[data-local-ai-action=test]').click();})()`);
    check(provider+' 接続テストの道具往復',await waitFor(`document.querySelector('[data-ai-provider-panel=${provider}] [data-local-ai-status]').textContent.includes('確認できました')`));
    await evaluate("document.querySelector('[data-settings-save]').click()");
    check(provider+' 保存してダイアログを閉じる',await waitFor("!document.querySelector('dialog[open]')"));
    const configured=await evaluate(`(async()=>{const s=localStore.getSettings();return{s,configured:(await import('/src/ai-client.js')).isAiConfigured()};})()`);
    check(provider+' 設定値を保存しAIを使用可',configured.configured&&configured.s.aiProvider===provider&&configured.s[key+'Model']==='local-test'&&!configured.s.aiCliEnabled);
    const reply=await evaluate(`(async()=>{const before=localStore.getAllTasks().length;const reply=await(await fetch('/api/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agent:true,messages:[{role:'user',content:'予定を確認して新しい予定を提案して'}]})})).json();await localStore.refreshTasks();return{reply,before,after:localStore.getAllTasks().length};})()`);
    check(provider+' 検索と提案は可能・確認前にDB変更なし',reply.reply.provider===provider&&reply.reply.proposals?.length===1&&reply.before===reply.after,JSON.stringify(reply));
    const summary=await evaluate(`(async()=>{const c=await import('/src/ai-client.js');return JSON.parse(await c.callAi([{role:'user',content:'要約してください'}],{format:{type:'object',properties:{summary:{type:'string'}},required:['summary']}}));})()`);
    check(provider+' 日次サマリー用JSON応答',summary.summary==='ローカルのテスト要約');
  }
  const persisted=await evaluate('localStore.getSettings()');
  check('接続先を切り替えても両方の設定を保持',persisted.aiOllamaModel==='local-test'&&persisted.aiLmStudioModel==='local-test');
  await evaluate("document.querySelector('[data-nav-target=ai]').click()");
  check('AIタブの初期化完了',await waitFor("!document.querySelector('[data-view=ai]').hidden"));
  const chip=await evaluate("document.querySelector('[data-ai-model-current]').textContent");
  check('AI画面にローカル接続先とモデル名を表示',chip.includes('LM Studio')&&chip.includes('local-test')&&!chip.includes('effort'),chip);
  const taskCount=await evaluate('localStore.getAllTasks().length');
  await evaluate("document.querySelector('[data-ai-input]').value='予定を調べて追加を提案して';document.querySelector('[data-ai-ask]').click()");
  check('既存AI画面にローカルモデルの確認カードを表示',await waitFor("document.querySelectorAll('.aiProposalActions .primary').length===1"));
  check('カード表示だけでは予定を保存しない',await evaluate('localStore.getAllTasks().length')===taskCount);
  await evaluate("document.querySelector('.aiProposalActions .primary').click()");
  check('確定後にだけ予定を作成する',await waitFor('localStore.getAllTasks().length === '+(taskCount+1)));
  await evaluate("document.querySelector('[data-view=ai] [data-settings-btn]').click()");
  for(const theme of ['light','dark']) for(const width of [1280,1024,700]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.documentElement.dataset.theme='${theme}';document.querySelector('[data-ai-provider-panel=lmstudio]').scrollIntoView({block:'center'})`);await sleep(200);
    const layout=await evaluate(`(()=>{const p=document.querySelector('[data-ai-provider-panel=lmstudio]'), b=document.querySelector('.settingsDialogBody');return{overflow:b.scrollWidth>b.clientWidth+1,inputs:[...p.querySelectorAll('input,select')].filter(e=>!e.hidden).map(e=>e.getBoundingClientRect().width),hidden:p.hidden};})()`);
    check(theme+' '+width+'px 接続設定が欠けない',!layout.overflow&&!layout.hidden&&layout.inputs.every(w=>w>100),JSON.stringify(layout));
    if(width===1280){fs.mkdirSync('out/local-llm',{recursive:true});const clip=await evaluate("(()=>{const r=document.querySelector('dialog[open]').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1};})()");const shot=await send('Page.captureScreenshot',{format:'png',clip});fs.writeFileSync('out/local-llm/settings-'+theme+'.png',Buffer.from(shot.result.data,'base64'));}
  }
  await evaluate(`(()=>{const p=document.querySelector('[data-ai-provider-panel=lmstudio]');p.querySelector('[data-local-ai-endpoint]').value='${endpoint.replace('/v1','/bad/v1')}';p.querySelector('[data-local-ai-endpoint]').dispatchEvent(new Event('input'));p.querySelector('[data-local-ai-action=models]').click();})()`);
  check('接続失敗を表示してボタンを復帰',await waitFor("(()=>{const p=document.querySelector('[data-ai-provider-panel=lmstudio]');return !p.querySelector('[data-local-ai-action=models]').disabled && p.querySelector('[data-local-ai-status]').textContent.length>0;})()"));
  await evaluate("document.querySelector('[data-settings-cancel]').click()");
  check('キャンセルで接続設定を変更しない',await evaluate(`localStore.getSettings().aiLmStudioEndpoint==='${endpoint}'`));
  await evaluate("document.querySelector('[data-view=ai] [data-settings-btn]').click()");
  await evaluate("window.originalLocalFetch=window.fetch;window.fetch=(url,options)=>url==='/api/ai/local/models'?new Promise(resolve=>{window.resolveLocalModels=resolve}):window.originalLocalFetch(url,options);document.querySelector('[data-ai-provider-panel=lmstudio] [data-local-ai-action=models]').click()");
  await evaluate("(()=>{const p=document.querySelector('[data-ai-provider-panel=lmstudio]');p.querySelector('[data-local-ai-endpoint]').value='http://localhost:1234/v1';p.querySelector('[data-local-ai-endpoint]').dispatchEvent(new Event('input'));window.resolveLocalModels({ok:true,json:async()=>({models:[{id:'stale-model'}]})});window.fetch=window.originalLocalFetch;})()");
  await sleep(100);
  check('接続URL変更後に古いモデル候補を表示しない',await evaluate("![...document.querySelector('[data-ai-provider-panel=lmstudio] [data-local-ai-model]').options].some(o=>o.value==='stale-model')"));
  await evaluate("document.querySelector('[data-ai-provider-panel=lmstudio] [data-local-ai-model]').value='';document.querySelector('[data-settings-save]').click()");
  check('モデル名が空なら保存せず入力を案内',await evaluate("Boolean(document.querySelector('dialog[open]')) && document.querySelector('[data-ai-provider-panel=lmstudio] [data-local-ai-status]').textContent.includes('モデル名')"));
  await evaluate("document.querySelector('[data-settings-cancel]').click()");
  await send('Page.reload');await sleep(1200);
  check('再読み込み後も両接続先とモデル名を保持',await evaluate("(async()=>{const s=(await import('/src/store.js')).getSettings();return s.aiOllamaModel==='local-test'&&s.aiLmStudioModel==='local-test'&&s.aiProvider==='lmstudio';})()"));
  const probeRequests=requests.filter(r=>r.body?.tools?.some(t=>t.function.name==='local_connection_probe'));
  check('接続テストに予定データを含めない',probeRequests.every(r=>!JSON.stringify(r.body).includes('ローカルAIの提案')));
  ws.close();
} catch(error) {
  check('ローカルAIの結合試験を実行できる',false,String(error?.stack??error));
} finally {
  app.kill(); mock.closeAllConnections(); await new Promise(resolve=>mock.close(resolve));
}
if(failed)process.exit(1);
console.log('PASS: local provider native UI and tool integration');
