// Deterministic renderer/store measurements; excludes native process startup and live services.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openHarness, FIXED_NOW } from './refactor-20261008-harness.mjs';

const root=path.resolve(process.argv[2]||'.');
const output=path.resolve(process.argv[3]||'out/refactor-20261008/benchmark-probe');
if(fs.existsSync(output))throw Error('Evidence output already exists: '+output);
const h=await openHarness({root,output});
const raw=[],metrics=[];
const seed=count=>Array.from({length:count},(_,i)=>{
  const slot=i%10, start=slot<6?9*60+slot*30:13*60+(slot-6)*30;
  const time=minutes=>String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');
  return {id:'bench-'+i,title:'合成タスク '+i,date:new Date(Date.UTC(2026,9,1+Math.floor(i/10))).toISOString().slice(0,10),startTime:time(start),endTime:time(start+30),tagId:i%5===0?'':i%2?'tag-design':'tag-meeting',isAllDay:false,recurrence:{type:'none'},memo:'',createdAt:FIXED_NOW,updatedAt:FIXED_NOW};
});
try{
  // Import includes dependency graph parsing; every sample has a fresh browser page/module map.
  const importSamples=[];
  for(let index=0;index<9;index++){
    const page=await h.context.newPage();await page.goto(h.origin+'/harness-empty.html');
    const value=await page.evaluate(async()=>{const start=performance.now();await import('/src/store.js');return performance.now()-start;});
    if(index>=2)importSamples.push(value);await page.close();
  }
  metrics.push({id:'renderer.store-module-import',unit:'ms',direction:'lower',samples:importSamples,tolerance_percent:35,tolerance_absolute:10,context:{warmup:2,samples:7,cache:'fresh page/module map; loopback static responses; no native bootstrap'}});
  for(const count of [100,1000,10000]){
    h.setTasks(seed(count));const page=await h.context.newPage();await page.goto(h.origin+'/harness-empty.html');
    await page.evaluate(async()=>{window.benchStore=await import('/src/store.js');await window.benchStore.init();});
    const samples=[];
    for(let index=0;index<9;index++){
      h.bump();await page.evaluate(async()=>window.benchStore.refreshTasks());
      const sample=await page.evaluate(async()=>{
        const S=window.benchStore;
        let start=performance.now();const cold=S.calcMonthSummary('2026-10');const coldIndexMonthMs=performance.now()-start;
        await S.updateSettings({granularity:S.getSettings().granularity});
        start=performance.now();const uncached=S.calcMonthSummary('2026-10');const uncachedMonthMs=performance.now()-start;
        S.getTasksByDate('2026-10-08');
        start=performance.now();for(let i=0;i<100;i++)S.getTasksByDate('2026-10-08');const lookup100Ms=performance.now()-start;
        start=performance.now();for(let i=0;i<100;i++)S.calcMonthSummary('2026-10');const summary100Ms=performance.now()-start;
        start=performance.now();await S.refreshTasks();const unchangedRefreshMs=performance.now()-start;
        return {coldIndexMonthMs,uncachedMonthMs,lookup100Ms,summary100Ms,unchangedRefreshMs,taskCount:S.getAllTasks().length,dayTasks:S.getTasksByDate('2026-10-08').length,monthTotal:cold.total,monthOvertime:cold.overtime,uncachedTotal:uncached.total,byTag:[...cold.byTag.entries()],jsHeapBytes:performance.memory?.usedJSHeapSize??null};
      });
      assert.equal(sample.taskCount,count);assert.equal(sample.dayTasks,10);assert.equal(sample.monthTotal,sample.uncachedTotal);
      const monthDays=Math.min(31,count/10);assert.equal(sample.monthTotal,monthDays*240);assert.equal(sample.monthOvertime,0);
      assert.deepEqual([...sample.byTag].sort(),[['tag-design',monthDays*120],['tag-meeting',monthDays*120]]);
      if(index>=2)samples.push(sample);
    }
    raw.push({count,samples});
    for(const field of ['coldIndexMonthMs','uncachedMonthMs','lookup100Ms','summary100Ms','unchangedRefreshMs'])metrics.push({id:'tasks.'+count+'.'+field,unit:'ms',direction:'lower',samples:samples.map(row=>row[field]),tolerance_percent:35,tolerance_absolute:3,context:{rows:count,warmup:2,samples:7,date:'2026-10-08',month:'2026-10',workload:'10 half-hour rows/day; every fifth row tagless; no overlaps; two tags',cache:field.startsWith('cold')?'invalidated indexes and summaries':field.startsWith('uncached')?'warm indexes; invalidated summaries':'warm'}});
    await page.close();
  }
  fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'raw.json'),JSON.stringify(raw,null,2));
  fs.writeFileSync(path.join(output,'metrics.json'),JSON.stringify({context:{...h.meta,workload:'synthetic-half-hour-v1',mode:'Chromium renderer/store with synthetic loopback API'},metrics},null,2));
  console.log(JSON.stringify({metrics:metrics.length,samplesPerMetric:7,rows:[100,1000,10000],output}));
}finally{await h.close();}
