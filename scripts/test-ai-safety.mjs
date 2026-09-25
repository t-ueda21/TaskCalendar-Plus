import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Execute the private production functions with deterministic data/transport adapters.
const source = fs.readFileSync('src-tauri/renderer/src/ai-mode.js', 'utf8');
const proposalStart = source.includes('function _proposalTaskSnapshot(') ? 'function _proposalTaskSnapshot(' : 'async function _applyProposal(';
const proposalCode = source.slice(source.indexOf(proposalStart), source.indexOf('// ── チャット'));
const snapshot = {title:'会議', date:'2026-09-26', startTime:'09:00', endTime:'10:00', memo:'旧メモ', tagName:'作業', allDay:false};
function proposalContext(current) {
  const operations=[];
  const ctx=vm.createContext({Store:{
    refreshTasks:async()=>{},getAllTasks:()=>current?[current]:[],getAllTags:()=>[{id:'work',name:'作業'}],
    updateTask:async(id,patch,options)=>{operations.push({kind:'update',id,patch,options});return {...current,...patch};},
    deleteTaskWithMode:async(id,mode,options)=>{operations.push({kind:'delete',id,mode,options});},
  },_ensureTagId:async()=> 'work'});
  vm.runInContext(proposalCode,ctx);return {ctx,operations};
}
const current={id:'t1',...snapshot,isAllDay:false,tagId:'work',updatedAt:'rev-2'};
for(const action of ['update','delete']) {
  const {ctx,operations}=proposalContext({...current,memo:'手動編集したメモ'});
  const p={action,taskId:'t1',before:snapshot,task:action==='update'?{...snapshot,title:'変更後'}:snapshot};
  await assert.rejects(ctx._applyProposal(p),/変更|最新/);
  assert.equal(operations.length,0);
}
console.log('PASS: stale update/delete proposals preserve intervening edits');
for(const action of ['update','delete']) {
  const {ctx,operations}=proposalContext(current);
  const p={action,taskId:'t1',before:snapshot,task:action==='update'?{...snapshot,title:'変更後'}:snapshot,expectedUpdatedAt:'rev-1'};
  await assert.rejects(ctx._applyProposal(p),/変更|最新/);
  assert.equal(operations.length,0);
}
const {ctx,operations}=proposalContext(current);
await ctx._applyProposal({action:'update',taskId:'t1',before:snapshot,task:{...snapshot,title:'変更後'},expectedUpdatedAt:'rev-2'});
assert.equal(operations[0].options.expectedUpdatedAt,'rev-2');
await ctx._applyProposal({action:'delete',taskId:'t1',task:snapshot});
assert.equal(operations[1].options.expectedUpdatedAt,'rev-2');
console.log('PASS: valid and legacy proposals send atomic revision guards');

function sendContext() {
  let release;const gate=new Promise(r=>release=r);const messages=[];let calls=0;
  const c=vm.createContext({_busy:false,_sendCancelled:false,$:{input:{value:'予定を確認'}},_activeDateKey:'2026-09-26',HISTORY_TURNS:12,
    isAiConfigured:()=>true,console,cancelAi:()=>{},_showLoading:()=>{},_appendMessage:()=>{},_renderModelStatus:()=>{},
    Store:{refreshTasks:()=>gate,getAiChatHistory:()=>messages,addAiChatMessage:(day,m)=>{messages.push(m);return m;}},
    chatWithAgent:async()=>{calls++;return {content:'回答',proposals:[]};}});
  c._setBusy=v=>{c._busy=v;};
  const start=source.includes('function _cancelSend(')?'function _cancelSend(':'async function _send()';
  vm.runInContext(source.slice(source.indexOf(start),source.indexOf('// ── サイドバー')),c);
  return {c,release,messages,calls:()=>calls};
}
const first=sendContext();const a=first.c._send(),b=first.c._send();first.release();await Promise.all([a,b]);
assert.equal(first.calls(),1);assert.equal(first.messages.filter(m=>m.role==='user').length,1);assert.equal(first.c._busy,false);
console.log('PASS: send is reserved before asynchronous task refresh');
const stopped=sendContext();const pending=stopped.c._send();stopped.c._cancelSend();stopped.release();await pending;
assert.equal(stopped.calls(),0);assert.equal(stopped.messages.length,0);assert.equal(stopped.c._busy,false);
assert.equal(stopped.c.$.input.value,'予定を確認');
console.log('PASS: stopping during refresh preserves input and does not start AI');
