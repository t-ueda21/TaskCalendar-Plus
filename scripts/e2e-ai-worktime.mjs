// Real WebView2 + Rust API, using only an isolated synthetic profile and no model account.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {nativeApp,delay} from './native-test-driver.mjs';
const dataDir=process.env.TCPLUS_AI_NATIVE_DATA;
assert.ok(dataDir,'Set TCPLUS_AI_NATIVE_DATA to an isolated test profile');
const output=path.resolve('out/ai-worktime-native');fs.mkdirSync(output,{recursive:true});
const app=await nativeApp({port:9491,dataDir});
async function waitFor(expression){for(let i=0;i<120;i++){const value=await app.evaluate(expression);if(value)return value;await delay(100);}throw Error('Native AI condition timed out: '+expression);}
try {
 const fixture=await app.evaluate(`(async()=>{
   const S=await import('/src/store.js');const {todayInJst}=await import('/src/summary-model.js');const today=todayInJst();
   await S.updateSettings({uiLanguage:'ja',aiProvider:'none',aiCliEnabled:false,workStart:'09:00',workEnd:'18:00',breaks:[{start:'12:00',end:'13:00',countAsWork:false}]});
   const tag=await S.createTag({name:'Native work verification',color:'#0072bc'});
   let late;
   for(const [title,startTime,endTime,tagId] of [['Early','08:00','10:00',tag.id],['Overlap','09:00','11:00',tag.id],['Late','18:00','19:00',tag.id],['Untagged','20:00','21:00','']]) {
     const task=await S.createTask({title,date:today,startTime,endTime,tagId,recurrence:{type:'none'}});if(title==='Late')late=task.id;
   }
   (await import('/src/ui-utils.js')).syncViewDate(today);
   return {today,late,summary:S.calcDaySummary(today)};
 })()`);
 assert.equal(fixture.summary.total,240);assert.equal(fixture.summary.overtime,120);
 await app.evaluate(`(()=>{window.__workChecks=[];window.__taskReloads=0;const original=window.fetch;window.fetch=async(input,options)=>{const url=String(input);if(url==='/api/tasks'&&(!options?.method||options.method==='GET'))window.__taskReloads++;const response=await original(input,options);if(url==='/api/ai/chat')window.__workChecks.push({body:JSON.parse(options.body),reply:await response.clone().json()});return response;};document.querySelector('nav [data-nav-target="ai"]').click();})()`);
 await waitFor(`document.querySelector('[data-ai-input]')&&!document.querySelector('[data-view="ai"]').hidden`);
 async function ask(expectedCount){
   await app.evaluate(`(()=>{const input=document.querySelector('[data-ai-input]');input.value='今日の残業時間は？';document.querySelector('[data-ai-ask]').click();})()`);
   await waitFor(`window.__workChecks.length===${expectedCount}&&!document.querySelector('[data-ai-input]').disabled`);
   return app.evaluate(`window.__workChecks[${expectedCount-1}]`);
 }
 const first=await ask(1);
 assert.equal(first.reply.source,'application');assert.equal(first.reply.report.overtimeMinutes,120);
 assert.equal(first.reply.report.totalMinutes,240);assert.equal(first.body.viewDate,fixture.today);
 assert.ok(first.reply.elapsedMs<1000,'small local report should not wait for a model');
 const visible=await app.evaluate(`document.querySelector('[data-ai-chat-log]').textContent`);assert.ok(visible.includes('2時間'));
 await app.evaluate(`(async()=>{const S=await import('/src/store.js');await S.deleteTask(${JSON.stringify(fixture.late)});})()`);
 const second=await ask(2);
 assert.equal(second.reply.source,'application');assert.equal(second.reply.report.overtimeMinutes,60);
 assert.ok(second.body.messages.some(m=>m.role==='assistant'&&m.source==='application'),'local-answer provenance survives history persistence');
 assert.equal(await app.evaluate('window.__taskReloads'),0,'asking questions must not fetch the complete renderer snapshot');
 const results={fixture,first:first.reply,second:second.reply,taskReloads:0,modelRequired:false};
 fs.writeFileSync(path.join(output,'native-results.json'),JSON.stringify(results,null,2));
 await app.screenshot(path.join(output,'native-ai-worktime.png'));
 assert.deepEqual(app.errors,[],'no native renderer errors');
 console.log('PASS: native UI answers overtime without AI setup, matches screen totals and sees edits immediately');
 console.log(JSON.stringify({firstMs:first.reply.elapsedMs,secondMs:second.reply.elapsedMs}));
} finally {await app.close();}
