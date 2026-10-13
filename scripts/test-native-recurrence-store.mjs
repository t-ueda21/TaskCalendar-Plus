import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
globalThis.document={addEventListener(){}};
globalThis.setInterval=()=>0;
const base={recurrenceType:0,interval:1,dayOfWeekMask:0,dayOfMonth:0,monthOfYear:0,instance:0,patternStartDate:'2026-10-05',patternEndDate:null,occurrences:3,noEndDate:false};
let rows=[],calls=[],rev=1,holdNextTaskRead=null;
const reply=data=>({ok:true,text:async()=>JSON.stringify(data)});
globalThis.fetch=async(url,options={})=>{
  const method=options.method||'GET',body=options.body?JSON.parse(options.body):null;
  calls.push({url,method,body});
  if(url==='/api/runtime')return reply({});
  if(url.startsWith('/api/ai-memory/'))return reply([]);
  if(url==='/api/tags')return reply([{id:'tag',name:'Tag',color:'#123456'}]);
  if(url==='/api/settings')return reply({outlookAutoSync:true,outlookWriteDefault:true});
  if(url==='/api/tasks'&&method==='GET'){const snapshot=structuredClone(rows);if(holdNextTaskRead){const wait=holdNextTaskRead;holdNextTaskRead=null;await wait;}return reply(snapshot);}
  if(url==='/api/tasks'&&method==='POST'){const row={...body,updatedAt:String(rev++)};rows.push(row);return reply(row);}
  if(url.startsWith('/api/tasks/')&&method==='PUT'){const id=url.slice('/api/tasks/'.length);rows=rows.map(row=>row.id===id?{...body,updatedAt:String(rev++)}:row);return reply(rows.find(row=>row.id===id));}
  if(url.startsWith('/api/outlook/series/')&&method==='POST'){
    const id=url.slice('/api/outlook/series/'.length),target=rows.find(row=>row.id===id);
    rows=rows.map(row=>row.recurrence.groupId===target.recurrence.groupId&&(body.scope==='all'||row.date>=target.date)?{...row,title:body.payload.title,recurrence:{...row.recurrence,native:body.rule},updatedAt:String(rev++)}:row);
    return reply(rows);
  }
  throw new Error(`Unexpected ${method} ${url}`);
};
const S=await import('../src-tauri/renderer/src/store.js');
await S.init();
const first=await S.createTask({title:'Native',date:'2026-10-05',endDate:'2026-10-06',startTime:'23:00',endTime:'01:00',isAllDay:false,tagId:'tag',outlookEnabled:true,recurrence:{type:'native',native:base}});
assert.deepEqual(S.getAllTasks().map(row=>[row.date,row.endDate]),[['2026-10-05','2026-10-06'],['2026-10-06','2026-10-07'],['2026-10-07','2026-10-08']],'native creation expands local occurrences with relative ends');
assert.equal(new Set(rows.map(row=>row.recurrence.groupId)).size,1);
assert.deepEqual(first.recurrence.native,base);
assert.equal(first.recurrence.template?.startTime,'23:00','native master stores stable base clock before instance edits');
assert.equal(first.recurrence.template.date,'2026-10-05');
assert.deepEqual(rows.map(row=>row.recurrence.occurrenceDate),['2026-10-05','2026-10-06','2026-10-07']);
rows=rows.map(row=>({...row,outlookSeriesId:'remote-series',outlookOccurrenceKey:'occ:'+row.date}));
await S.refreshTasks();
const changed={...base,interval:2};
const before=calls.length;
await assert.rejects(S.updateTaskWithMode(first.id,{recurrence:{type:'native',native:changed}},'single'),/series|future|繰り返し|以降|ruleScopeRequired/i);
assert.equal(calls.length,before,'single rule change cannot touch API');
await S.updateTaskWithMode(first.id,{title:'One instance',recurrence:{...first.recurrence,native:Object.fromEntries(Object.entries(base).reverse())}},'single');
assert.ok(calls.some(call=>call.method==='PUT'&&call.url==='/api/tasks/'+first.id));
assert.deepEqual(S.getAllTasks()[0].recurrence.native,base,'unmodified native rule survives instance edit');
const target=S.getAllTasks()[1];
let release;holdNextTaskRead=new Promise(resolve=>{release=resolve;});
const staleRefresh=S.refreshTasks();
const seriesWrite=S.updateTaskWithMode(target.id,{title:'Future',recurrence:{type:'native',native:changed}},'future');
await new Promise(resolve=>setImmediate(resolve));release();
await Promise.all([staleRefresh,seriesWrite]);
const request=calls.find(call=>call.url==='/api/outlook/series/'+target.id);
assert.equal(request.body.scope,'future');
assert.equal(request.body.expectedUpdatedAt,target.updatedAt);
assert.equal(request.body.payload.id,target.id);
assert.equal(request.body.payload.date,target.date);
assert.deepEqual(request.body.rule,changed);
assert.deepEqual(S.getAllTasks().map(row=>row.title),['One instance','Future','Future']);
assert.equal(calls.some(call=>call.url==='/api/tasks/batch'),false,'native rule changes use one series operation');
await assert.rejects(S.updateTaskWithMode(target.id,{recurrence:{type:'none'}},'single'));
await S.updateTaskWithMode(target.id,{recurrence:{type:'none'}},'series');
const removal=calls.filter(call=>call.url==='/api/outlook/series/'+target.id).at(-1);
assert.equal(removal.body.rule,null,'series removal explicitly sends null rule');
assert.deepEqual(removal.body.payload.recurrence,{type:'none'});
console.log('PASS native creation, metadata preservation, single-rule guard and queued series routing');
