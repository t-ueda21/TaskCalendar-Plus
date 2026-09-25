// Real native application, isolated DB/profile. Does not run Outlook, AI, or an installer.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';

const exe=path.resolve(process.env.TCPLUS_E2E_EXE || 'src-tauri/target/debug/taskcalendar-plus.exe');
const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'tcplus-integrity-'));
const port=9342;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function launch() {
  const processHandle=spawn(exe,[],{stdio:'ignore',windowsHide:true,env:{...process.env,TCPLUS_DATA_DIR:dataDir,WEBVIEW2_USER_DATA_FOLDER:path.join(dataDir,'webview2'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}});
  let ws;
  const close=async()=>{ws?.close();processHandle.kill();await delay(1000);};
  try {
    let page;
    for(let i=0;i<120&&!page;i++) {try{page=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(p=>p.url.includes('/assets/app.html'));}catch{}if(!page)await delay(250);}
    assert.ok(page,'native app starts');
    ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
    let sequence=0;const pending=new Map();
    ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
    const send=(method,params)=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);ws.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.result?.exceptionDetails)throw Error(r.result.exceptionDetails.exception?.description||JSON.stringify(r.result.exceptionDetails));return r.result?.result?.value;};
    for(let i=0;i<120;i++){if(await evaluate('document.body.style.opacity === "1"'))return {evaluate,close};await delay(100);}
    throw Error('native bootstrap timed out');
  }catch(error){await close();throw error;}
}
let app;
try {
  app=await launch();
  const result=await app.evaluate(`(async()=>{
    const Store=await import('/src/store.js');
    const t=await Store.createTask({title:'audit recurring',date:'2026-09-01',startTime:'09:00',endTime:'10:00',tagId:'',memo:'x'.repeat(800000),recurrence:{type:'daily',until:'2026-09-03'}});
    await Store.updateTaskWithMode(t.id,{recurrence:{type:'daily',until:'2026-09-05'}},'series');
    const series=Store.getAllTasks().filter(row=>row.recurrence?.groupId===t.recurrence.groupId);
    const saved=series[1];await Store.deleteTask(saved.id);await Store.restoreTask(saved);
    const restored=Store.getAllTasks().find(row=>row.id===saved.id);
    await Store.updateTask(saved.id,{memo:'latest'});
    let conflict=false;try{await Store.updateTask(saved.id,{memo:'stale'},{expectedUpdatedAt:saved.updatedAt});}catch{conflict=true;}
    const memo=Store.getAllTasks().find(row=>row.id===saved.id).memo;
    const proposed=await Store.createTask({title:'AI proposal target',date:'2026-09-26',startTime:'09:00',endTime:'10:00',tagId:'',memo:'old'});
    const before={title:proposed.title,date:proposed.date,startTime:proposed.startTime,endTime:proposed.endTime,allDay:false,tagName:'',memo:'old'};
    Store.addAiChatMessage(proposed.date,{role:'assistant',text:'タイトル変更の提案',proposals:[{id:'audit-proposal',action:'update',taskId:proposed.id,before,task:{...before,title:'AI title'},expectedUpdatedAt:proposed.updatedAt}]});
    await Store.updateTask(proposed.id,{memo:'manual edit'});
    (await import('/src/ui-utils.js')).syncViewDate(proposed.date);
    document.querySelector('[data-nav-target="ai"]').click();
    for(let i=0;i<60&&!document.querySelector('[data-view="ai"] .aiProposal-update button');i++)await new Promise(r=>setTimeout(r,20));
    document.querySelector('[data-view="ai"] .aiProposal-update button').click();
    for(let i=0;i<60&&!document.querySelector('[data-view="ai"] .aiProposalStatus');i++)await new Promise(r=>setTimeout(r,20));
    const proposalRejected=document.querySelector('[data-view="ai"] .aiProposalStatus')?.textContent.includes('提案後');
    const proposalPreserved=Store.getAllTasks().find(row=>row.id===proposed.id)?.memo==='manual edit';
    document.querySelector('[data-nav-target="calendar"]').click();
    const backup=await(await fetch('/api/backup')).json();
    const invalid=await fetch('/api/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({format:backup.format,version:backup.version})});
    const after=await(await fetch('/api/tasks')).json();
    for(const day of ['2026-09-25','2026-09-26']){const r=await fetch('/api/ai-memory/notes/'+day,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify([{id:'audit-note',text:'x'.repeat(1100000)}])});if(!r.ok)throw Error('note seed failed');}
    const large=await(await fetch('/api/backup')).json();const body=JSON.stringify(large);
    const restore=await fetch('/api/restore',{method:'POST',headers:{'Content-Type':'application/json'},body});
    const notes=await(await fetch('/api/ai-memory/notes')).json();
    await Store.updateSettings({trayEnabled:false,checkUpdatesOnStartup:false});
    await window.__TAURI__.core.invoke('set_tray_enabled',{enabled:false});
    document.querySelector('[data-view="calendar"] [data-settings-btn]').click();
    document.querySelector('[data-theme-toggle]').click();
    for(let i=0;i<60&&document.querySelector('[data-theme-toggle]').disabled;i++)await new Promise(r=>setTimeout(r,20));
    document.querySelector('[data-settings-cancel]').click();
    for(let i=0;i<5;i++)document.dispatchEvent(new KeyboardEvent('keydown',{key:'+',ctrlKey:true,bubbles:true}));
    let prefs;
    for(let i=0;i<60;i++){prefs=await window.__TAURI__.core.invoke('get_ui_preferences');if(prefs?.zoom===1.5)break;await new Promise(r=>setTimeout(r,20));}
    localStorage.clear();
    return {count:series.length,restoredId:restored.id,savedId:saved.id,restoredGroup:restored.recurrence.groupId,expectedGroup:saved.recurrence.groupId,conflict,memo,proposalRejected,proposalPreserved,invalidStatus:invalid.status,tasksAfterInvalid:after.length,backupTasks:backup.tasks.length,largeBytes:body.length,restoreStatus:restore.status,noteCount:Object.keys(notes).length,prefs,origin:location.origin};
  })()`);
  assert.equal(result.count,5);assert.equal(result.restoredId,result.savedId);assert.equal(result.restoredGroup,result.expectedGroup);
  assert.equal(result.conflict,true);assert.equal(result.memo,'latest');assert.equal(result.invalidStatus,400);assert.equal(result.tasksAfterInvalid,result.backupTasks);
  assert.equal(result.proposalRejected,true);assert.equal(result.proposalPreserved,true);
  assert.ok(result.largeBytes>2*1024*1024);assert.equal(result.restoreStatus,200);assert.equal(result.noteCount,2);
  assert.deepEqual(result.prefs,{theme:'dark',zoom:1.5});
  console.log('PASS: native batch recurrence/exact restore/revision conflict, stale AI card, backup validation/large restore');
  await app.close();app=null;
  app=await launch();
  const restarted=await app.evaluate(`(async()=>{
    const preferences=await window.__TAURI__.core.invoke('get_ui_preferences');
    // This process started with tray disabled; enabling must build a usable icon.
    await window.__TAURI__.core.invoke('set_tray_enabled',{enabled:true});
    await window.__TAURI__.core.invoke('set_tray_enabled',{enabled:false});
    return {preferences,theme:document.documentElement.getAttribute('data-theme'),origin:location.origin};
  })()`);
  assert.deepEqual(restarted.preferences,{theme:'dark',zoom:1.5});assert.equal(restarted.theme,'dark');
  console.log('PASS: native preferences survive restart without localStorage; tray enables after disabled startup');
}finally{
  await app?.close();
  const resolved=path.resolve(dataDir);
  if(path.dirname(resolved)===path.resolve(os.tmpdir())&&path.basename(resolved).startsWith('tcplus-integrity-')){
    try{fs.rmSync(resolved,{recursive:true,force:true});}catch{/* WebView may still be releasing the temporary profile. */}
  }
}
