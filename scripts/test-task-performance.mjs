import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
globalThis.crypto ??= webcrypto;
globalThis.document = { addEventListener() {} };
globalThis.setInterval = () => 0;
const clone = value => structuredClone(value);
const task = (id,date='2026-09-25') => ({id,title:id,date,startTime:'09:00',endTime:'10:00',tagId:'tag',isAllDay:false,recurrence:{type:'none'},memo:'',createdAt:'a',updatedAt:'a'});
let rows = [task('a'),task('b','2026-09-26')], revision=0, gets=0, hold=null, writeHold=null, fail=false;
let settings={}, tags=[{id:'tag',name:'Work',color:'#0072bc'}];
const reply=(data,status=200,headers={})=>new Response(status===304||status===204?null:JSON.stringify(data),{status,headers});
globalThis.fetch=async(url,options={})=>{
  const method=options.method||'GET';
  if(url==='/api/tasks'&&method==='GET') {
    gets++;const etag='"tasks-'+revision+'"', snapshot=clone(rows), unchanged=new Headers(options.headers).get('If-None-Match')===etag;
    if(hold){const gate=hold;hold=null;await gate;}
    if(fail)throw Error('offline');
    return reply(snapshot,unchanged?304:200,{ETag:etag});
  }
  if(url==='/api/runtime')return reply({});
  if(url.startsWith('/api/ai-memory/'))return reply([]);
  if(url==='/api/tags')return reply(tags);
  if(url==='/api/settings') {if(method==='PUT')settings=JSON.parse(options.body);return reply(settings);}
  if(url==='/api/tasks'&&method==='POST'){const saved={...JSON.parse(options.body),updatedAt:String(++revision)};rows.push(saved);if(writeHold){const gate=writeHold;writeHold=null;await gate;}return reply(saved);}
  if(url.startsWith('/api/tasks/')&&method==='PUT') {
    const id=url.split('/').pop(), saved={...rows.find(t=>t.id===id),...JSON.parse(options.body),updatedAt:String(++revision)};
    rows=rows.map(t=>t.id===id?saved:t).sort((a,b)=>a.date.localeCompare(b.date));
    if(writeHold){const gate=writeHold;writeHold=null;await gate;}return reply(saved);
  }
  if(url.startsWith('/api/tasks/')&&method==='DELETE') {
    const id=url.split('/').pop().split('?')[0];rows=rows.filter(t=>t.id!==id);revision++;
    if(writeHold){const gate=writeHold;writeHold=null;await gate;}return reply(null,204);
  }
  if(url==='/api/tags/tag'&&method==='DELETE'){tags=[];return reply(null,204);}
  throw Error('Unhandled '+method+' '+url);
};
const S=await import('../src-tauri/renderer/src/store.js');
await S.init();
let notifications=0;S.subscribe('tasks',()=>notifications++);
await S.refreshTasks();
assert.equal(notifications,0,'unchanged refresh must not publish tasks');
const day=S.getTasksByDate('2026-09-25');day.length=0;assert.equal(S.getTasksByDate('2026-09-25').length,1);
const first=S.calcMonthSummary('2026-09');assert.equal(first.total,120);first.byTag.clear();assert.equal(S.calcMonthSummary('2026-09').byTag.get('tag'),120);
let dateReads=0,timeReads=0;
for(const row of S.getAllTasks()) {
  const date=row.date,time=row.startTime;
  Object.defineProperty(row,'date',{configurable:true,get(){dateReads++;return date;}});
  Object.defineProperty(row,'startTime',{configurable:true,get(){timeReads++;return time;}});
}
for(let i=0;i<100;i++){S.getTasksByDate('2026-09-25');S.calcMonthSummary('2026-09');}
assert.equal(dateReads,0,'warm lookups must not rescan all tasks');assert.equal(timeReads,0,'warm summaries must reuse results');
await S.updateSettings({breaks:[{start:'09:00',end:'09:30',countAsWork:false}]});
assert.equal(S.calcMonthSummary('2026-09').total,60,'break changes invalidate summary cache');
rows.push(task('remote'));revision++;
await S.refreshTasks();assert.equal(S.getTasksByDate('2026-09-25').length,2);assert.equal(notifications,1);
let release;hold=new Promise(r=>{release=r});const before=gets;const a=S.refreshTasks();let bDone=false;const b=S.refreshTasks().then(()=>{bDone=true});await tick();assert.equal(bDone,false,'parallel callers must await the same refresh');release();await Promise.all([a,b]);assert.equal(gets,before+1);
hold=new Promise(r=>{release=r});const pending=S.refreshTasks();await tick();await S.createTask({title:'local',date:'2026-09-25',startTime:'11:00',endTime:'12:00',tagId:'tag'});release();await pending;assert.ok(S.getAllTasks().some(row=>row.title==='local'),'in-flight old snapshot must not overwrite a local edit');
writeHold=new Promise(r=>{release=r});const creating=S.createTask({title:'response-race',date:'2026-09-25',startTime:'13:00',endTime:'14:00',tagId:'tag'});await tick();await S.refreshTasks();release();await creating;await S.refreshTasks();assert.equal(S.getAllTasks().filter(row=>row.title==='response-race').length,1,'refresh before create response must not duplicate the committed task');
writeHold=new Promise(r=>{release=r});const updating=S.updateTask('a',{date:'2026-10-01'});await tick();await S.refreshTasks();release();await updating;await S.refreshTasks();assert.deepEqual(S.getAllTasks().map(t=>t.id).sort(),rows.map(t=>t.id).sort(),'reordered refresh must not make a delayed update overwrite the wrong row');
writeHold=new Promise(r=>{release=r});const deleting=S.deleteTask('a');await tick();rows.push(task('another-remote'));revision++;await S.refreshTasks();release();await deleting;assert.ok(S.getAllTasks().some(t=>t.id==='another-remote'),'delayed deletion must preserve concurrently fetched additions');
fail=true;await assert.rejects(S.refreshTasks(),/offline/);fail=false;await S.refreshTasks();
await S.deleteTag('tag');assert.equal(S.calcMonthSummary('2026-09').total,0,'untagged tasks are excluded after a tag is removed');assert.equal(S.calcMonthSummary('2026-09').byTag.size,0,'deleted tags invalidate tag summary cache');
console.log('PASS: indexed lookups, cached totals, conditional refresh, shared waits, concurrent edits, failure retry');
