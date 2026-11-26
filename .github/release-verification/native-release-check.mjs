import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {nativeApp,delay} from './native-release-driver.mjs';

const [mode,exe,dataDir,reportDir]=process.argv.slice(2);
assert.ok(['seed','package','updates-old','updates-new','fresh'].includes(mode));
fs.mkdirSync(reportDir,{recursive:true});
const app=await nativeApp({exe,dataDir,diagnosticsDir:reportDir,port:{seed:9481,package:9482,fresh:9483,'updates-old':9484,'updates-new':9485}[mode]});
try {
  const runtime=await app.evaluate("fetch('/api/runtime').then(r=>r.json())");
  const expectedVersion=['seed','updates-old'].includes(mode)?'4.0.4':'4.0.5';
  assert.equal(runtime.appVersion,expectedVersion);
  const updateInfo=await app.evaluate("window.__TAURI__.core.invoke('get_update_info')");
  assert.equal(updateInfo.currentVersion,expectedVersion);
  assert.equal(updateInfo.installSupported,true);
  await app.evaluate("(async()=>{const S=await import('/src/store.js');await S.updateSettings({uiLanguage:'ja',checkUpdatesOnStartup:false,outlookAutoSync:false,urlAutoOpenEnabled:false,aiProvider:'none',aiCliEnabled:false});})()");
  if(mode==='seed') {
    const seeded=await app.evaluate("(async()=>{const S=await import('/src/store.js');const {todayInJst}=await import('/src/summary-model.js');const date=todayInJst();const tag=await S.createTag({name:'Release verification',color:'#0072bc'});const task=await S.createTask({title:'Upgrade compatibility fixture',date,startTime:'09:00',endTime:'10:00',tagId:tag.id,memo:'isolated release test',recurrence:{type:'none'}});return {tag,task,date};})()");
    assert.ok(seeded.tag.id&&seeded.task.id);
    fs.writeFileSync(path.join(reportDir,'seed.json'),JSON.stringify(seeded,null,2));
  } else if(mode==='fresh') {
    const tasks=await app.evaluate("fetch('/api/tasks').then(r=>r.json())");
    assert.equal(tasks.length,0);
  } else if(mode==='package') {
    const seed=JSON.parse(fs.readFileSync(path.join(reportDir,'seed.json'),'utf8'));
    const rows=await app.evaluate("fetch('/api/tasks').then(r=>r.json())");
    const task=rows.find(row=>row.id===seed.task.id);
    assert.ok(task,'previous-version task persists after installer upgrade');
    for(const key of ['title','date','startTime','endTime','tagId','memo'])assert.equal(task[key],seed.task[key]);
    const lifecycle=await app.evaluate(`(async()=>{
      const S=await import('/src/store.js');
      const original=S.getAllTasks().find(task=>task.title==='Upgrade compatibility fixture');
      const temporary=await S.createTask({title:'Disposable release check',date:original.date,startTime:'10:00',endTime:'11:00',tagId:original.tagId,recurrence:{type:'none'}});
      const created=(await(await fetch('/api/tasks')).json()).find(row=>row.id===temporary.id);
      await S.updateTask(temporary.id,{title:'Updated disposable release check'});
      const updated=(await(await fetch('/api/tasks')).json()).find(row=>row.id===temporary.id);
      await S.deleteTask(temporary.id);
      const deleted=!(await(await fetch('/api/tasks')).json()).some(row=>row.id===temporary.id);
      return {created:created?.title,updated:updated?.title,deleted};
    })()`);
    assert.deepEqual(lifecycle,{created:'Disposable release check',updated:'Updated disposable release check',deleted:true});
    const api=await app.evaluate("(async()=>({authorized:(await fetch('/api/tasks')).status,unauthorized:await new Promise(resolve=>{const x=new XMLHttpRequest();x.open('GET','/api/tasks');x.onload=()=>resolve(x.status);x.send();})}))()");
    assert.deepEqual(api,{authorized:200,unauthorized:401});
    await app.evaluate("document.querySelector('nav [data-nav-target=summary]').click()");
    await delay(700);
    const total=await app.evaluate("document.querySelector('[data-view=summary] [data-summary-metric=total] [data-metric-value]').textContent.replace(/\\s/g,'')");
    assert.equal(total,'1時間0分');
    await app.screenshot(path.join(reportDir,'native-current-month.png'));
    const offset=await app.evaluate("(async()=>{const {todayInJst}=await import('/src/summary-model.js');const today=todayInJst();return (2026-Number(today.slice(0,4)))*12+10-Number(today.slice(5,7));})()");
    assert.ok(Math.abs(offset)<=24,'release verification clock is in expected range');
    for(let i=0;i<Math.abs(offset);i++)await app.evaluate(`document.querySelector('[data-summary-shift="${Math.sign(offset)}"]').click()`);
    await delay(300);
    const layout=await app.evaluate(`(()=>{
      const root=document.querySelector('[data-view=summary]');const rows=[];
      for(const node of root.querySelectorAll('[data-summary-day]')){const top=node.getBoundingClientRect().top;let row=rows.find(row=>Math.abs(row.top-top)<1);if(!row)rows.push(row={top,days:[]});row.days.push(Number(node.dataset.summaryDay.slice(8)));}
      const selectors=['[data-summary-period-label]','[data-summary-shift="-1"]','[data-summary-shift="1"]','[data-summary-current]','[data-summary-period="month"]','[data-summary-period="year"]','.uiToggle:has([data-summary-future])'];
      return {rows:rows.map(row=>[row.days[0],row.days.at(-1),row.days.length]),controls:selectors.map(selector=>{const r=root.querySelector(selector).getBoundingClientRect();return {left:r.left,right:r.right};}),label:root.querySelector('[data-summary-period-label]').textContent};
    })()`);
    assert.deepEqual(layout.rows,[[1,10,10],[11,20,10],[21,31,11]]);
    for(let i=1;i<layout.controls.length;i++)assert.ok(layout.controls[i-1].right<=layout.controls[i].left);
    await app.evaluate("(()=>{const button=document.querySelector('[data-summary-day=\"2026-10-10\"]');button.click();button.focus();})()");
    for(const [key,day]of[['ArrowDown','20'],['ArrowDown','30'],['ArrowRight','31'],['ArrowUp','20']]){
      await app.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'${key}',bubbles:true,cancelable:true}))`);
      assert.equal(await app.evaluate("document.activeElement.dataset.summaryDay"),`2026-10-${day}`);
    }
    await app.screenshot(path.join(reportDir,'native-october-rows.png'));
    await app.evaluate("document.querySelector('[data-summary-period=year]').click()");
    assert.equal(await app.evaluate("document.querySelectorAll('[data-view=summary] [data-summary-day]').length"),12);
    assert.equal(await app.evaluate("document.querySelector('[data-summary-current]').textContent"),'今年');
    await app.screenshot(path.join(reportDir,'native-year.png'));
    fs.writeFileSync(path.join(reportDir,'native-layout.json'),JSON.stringify({runtime,updateInfo,layout,api,taskPreserved:true},null,2));
  } else {
    const update=await app.evaluate("window.__TAURI__.core.invoke('check_app_update')");
    if(mode==='updates-old')assert.equal(update?.version,'4.0.5');
    else assert.equal(update,null);
    fs.writeFileSync(path.join(reportDir,`${mode}.json`),JSON.stringify({runtime,updateInfo,update},null,2));
  }
  assert.deepEqual(app.errors,[],'no native renderer errors');
  console.log(`PASS ${mode}: native installed version ${expectedVersion}`);
} finally {await app.close();}
