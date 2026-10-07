// Whole-UI inspection of the native app with isolated, synthetic data.
// Does not contact Outlook, an AI provider, or the update installer.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {nativeApp, delay} from './native-test-driver.mjs';

const output=process.env.TCPLUS_UI_AUDIT_OUT || 'out/ui-audit/before';
fs.mkdirSync(output,{recursive:true});
const app=await nativeApp({exe:process.env.TCPLUS_E2E_EXE || 'out/v3.0.0/app/TaskCalendar-Plus.exe',port:9385});
const observations=[];
const inspect=async(name,screenshot=true)=>{
  await delay(100);
  const observation=await app.evaluate(`(()=>{
    const shown=e=>!!(e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&!e.closest('[hidden],[inert]')&&!function(){for(let node=e;node;node=node.parentElement)if(getComputedStyle(node).opacity==='0')return true;return false;}());
    const dialog=document.querySelector('dialog[open]');
    const roots=dialog?[dialog]:[document.querySelector('.header'),document.querySelector('#viewRoot>.view:not([hidden])')];
    const describe=e=>({tag:e.tagName,id:e.id,name:e.name,selector:[...e.attributes].filter(a=>a.name.startsWith('data-')).map(a=>a.name).join(' '),text:(e.innerText||e.getAttribute('aria-label')||e.title||'').trim().slice(0,100)});
    const controls=roots.flatMap(root=>[...root.querySelectorAll('button,input:not([type="hidden"]),textarea,select,a')]).filter(shown);
    const name=e=>e.getAttribute('aria-label')||e.getAttribute('aria-labelledby')||e.labels?.[0]?.innerText||e.innerText||e.title;
    const clipped=controls.filter(e=>e.tagName==='BUTTON'&&e.scrollWidth>e.clientWidth+3).map(e=>({...describe(e),width:e.clientWidth,content:e.scrollWidth}));
    const outsideNodes=controls.filter(e=>{const r=e.getBoundingClientRect();return r.left < -2||r.right>innerWidth+2;});
    const scrollable=e=>{for(let node=e.parentElement;node;node=node.parentElement)if(['auto','scroll'].includes(getComputedStyle(node).overflowX)&&node.scrollWidth>node.clientWidth+2)return true;return false;};
    const outside=outsideNodes.filter(e=>!scrollable(e)).map(describe);
    const scrollableOutside=outsideNodes.filter(scrollable).map(describe);
    const unlabeled=controls.filter(e=>!String(name(e)||'').trim()).map(describe);
    const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);const duplicateIds=[...new Set(ids.filter((id,i)=>ids.indexOf(id)!==i))];
    const misboundLabels=roots.flatMap(root=>[...root.querySelectorAll('label[for]')]).filter(shown).filter(label=>label.control&&!label.closest('dialog')?.contains(label.control)).map(describe);
    const body=document.documentElement;
    return {viewport:{width:innerWidth,height:innerHeight},lang:document.documentElement.lang,theme:document.documentElement.dataset.theme,rootOverflow:Math.max(0,body.scrollWidth-body.clientWidth),dialogOverflow:dialog?Math.max(0,dialog.scrollWidth-dialog.clientWidth):0,clipped,outside,scrollableOutside,unlabeled,duplicateIds,misboundLabels,controls:controls.map(describe)};
  })()`);
  observations.push({name,...observation});
  if(screenshot)await app.screenshot(`${output}/${name}.png`);
  console.log(`${name}: overflow=${observation.rootOverflow}/${observation.dialogOverflow}; clipped=${observation.clipped.length}; outside=${observation.outside.length}; unlabeled=${observation.unlabeled.length}; misbound=${observation.misboundLabels.length}`);
};
const close=()=>app.evaluate(`document.querySelector('dialog[open]')?.close();`);
const nav=view=>app.evaluate(`document.querySelector('[data-nav-target="${view}"]').click();`);
try{
  await app.send('Emulation.setDeviceMetricsOverride',{width:1680,height:1000,deviceScaleFactor:1,mobile:false});
  await app.evaluate(`(async()=>{const S=await import('/src/store.js');await S.updateSettings({uiLanguage:'ja',aiProvider:'none',outlookAutoSync:false,checkUpdatesOnStartup:false,trayEnabled:false});await window.__TAURI__.core.invoke('set_tray_enabled',{enabled:false});})()`);
  for(const view of ['calendar','tasks','ai']){await nav(view);await inspect(`empty-${view}`);}
  await app.evaluate(`(async()=>{
    const S=await import('/src/store.js'),U=await import('/src/ui-utils.js');const date=U.formatDateKey(new Date());
    const tags=[];for(let i=0;i<8;i++)tags.push(await S.createTag({name:i===0?'顧客ポータル改善・長い案件名の表示確認':'案件 '+(i+1),color:['#182333','#fef08a','#86efac'][i%3]}));
    await S.setMonthTagOrder(date.slice(0,7),tags.map(t=>t.id));
    for(let i=0;i<6;i++)await S.createTask({title:i===0?'非常に長い予定タイトル：仕様確認と画面全体の読みやすさを確認するための架空データ':'設計・確認 '+(i+1),date,startTime:String(8+i*2).padStart(2,'0')+':00',endTime:String(9+i*2).padStart(2,'0')+':30',tagId:tags[i%tags.length].id,memo:'一行目のメモ\\n二行目：追加の確認内容'});
    await S.createTask({title:'終日予定',date,isAllDay:true,tagId:''});U.syncViewDate(date);
  })()`);
  for(const condition of [
    {id:'ja-wide',lang:'ja',theme:'light',width:1680,height:1000},
    {id:'en-laptop',lang:'en',theme:'light',width:1280,height:800},
    {id:'ko-dark',lang:'ko',theme:'dark',width:1280,height:800},
    {id:'de-compact',lang:'de',theme:'dark',width:960,height:720},
    {id:'ja-narrow',lang:'ja',theme:'light',width:720,height:900}
  ]){
    await close();
    await app.send('Emulation.setDeviceMetricsOverride',{width:condition.width,height:condition.height,deviceScaleFactor:1,mobile:false});
    await app.evaluate(`(async()=>{await (await import('/src/store.js')).updateSettings({uiLanguage:${JSON.stringify(condition.lang)}});document.documentElement.dataset.theme=${JSON.stringify(condition.theme)};})()`);
    for(const view of ['calendar','tasks','ai']){await nav(view);await inspect(`${condition.id}-${view}`);}
    await nav('calendar');
    await app.evaluate(`document.querySelector('[data-view="calendar"] [data-new-task]').click();`);await inspect(`${condition.id}-create`);await close();
    await app.evaluate(`(async()=>{const S=await import('/src/store.js'),U=await import('/src/ui-utils.js');const task=S.getAllTasks().find(t=>!t.isAllDay);U.openEditDialog(document.querySelector('[data-view="calendar"] [data-task-dialog]'),task,S.getAllTags());})()`);await inspect(`${condition.id}-edit`);await close();
    await app.evaluate(`document.querySelector('[data-view="calendar"] [data-settings-btn]').click();`);
    for(const tab of ['general','advanced','tags','outlook','about','shortcuts']){
      await app.evaluate(`document.querySelector('[data-settings-tab="${tab}"]').click();document.querySelector('.settingsDialogBody').scrollTop=0;`);
      await inspect(`${condition.id}-settings-${tab}`,condition.id==='ja-wide'||condition.id==='de-compact');
      if(condition.id==='ja-wide'){
        await app.evaluate(`(()=>{const body=document.querySelector('.settingsDialogBody');body.scrollTop=body.scrollHeight;})()`);
        await inspect(`${condition.id}-settings-${tab}-bottom`);
      }
    }
    await close();
  }
  await app.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  for(const lang of ['zh-CN','zh-TW','es','fr','pt']){
    await app.evaluate(`(async()=>{await(await import('/src/store.js')).updateSettings({uiLanguage:${JSON.stringify(lang)}});})()`);
    for(const view of ['calendar','tasks','ai']){await nav(view);await inspect(`${lang}-${view}`,false);}
  }
  await app.evaluate(`(async()=>{await(await import('/src/store.js')).updateSettings({uiLanguage:'ja'});document.documentElement.dataset.theme='light';})()`);
  await nav('calendar');
  await app.evaluate(`document.querySelector('[data-view="calendar"] [data-new-task]').click();document.querySelector('[data-view="calendar"] [data-value="daily"]').click();`);
  await inspect('task-recurrence');
  await app.evaluate(`document.querySelector('[data-view="calendar"] [name="allDay"]').click();`);await inspect('task-all-day');await close();
  await app.evaluate(`document.querySelector('[data-view="calendar"] [data-settings-btn]').click();document.querySelector('[data-settings-tab="tags"]').click();document.querySelector('[data-tag-row] .hslTrigger').click();`);
  await inspect('tag-color-palette');
  await app.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await close();
  await app.evaluate(`document.querySelector('[data-view="calendar"] [data-settings-btn]').click();`);
  for(const provider of ['ollama','lmstudio']){
    await app.evaluate(`(()=>{const select=document.querySelector('[data-ai-provider-select]');select.value='${provider}';select.dispatchEvent(new Event('change'));document.querySelector('[data-ai-provider-panel="${provider}"]').scrollIntoView({block:'center'});})()`);
    await inspect(`ai-provider-${provider}`);
  }
  await close();
  await app.evaluate(`(async()=>{const S=await import('/src/store.js'),U=await import('/src/ui-utils.js'),date=U.formatDateKey(new Date());S.addAiChatMessage(date,{role:'assistant',text:'検証用の提案です。実際のAI応答ではありません。',proposals:[{id:'ui-audit-create',action:'create',task:{title:'提案の架空タスク',date,startTime:'15:00',endTime:'16:00',memo:'長いメモの折り返し確認'}}]});})()`);
  await nav('ai');await inspect('ai-proposal');
  await nav('calendar');
  await app.evaluate(`(async()=>{const old=document.querySelector('[data-update-dialog]'),dialog=old.cloneNode(true),host=document.createElement('section'),button=document.createElement('button');old.remove();button.dataset.updateOpen='';button.dataset.updateEntry='';button.textContent='検証用の更新表示';host.append(button,dialog);document.body.append(host);window.auditUpdateHost=host;const bridge={core:{invoke:async command=>{if(command==='get_update_info')return {currentVersion:'3.0.0',installSupported:true};if(command==='check_app_update')return {version:'99.0.0',notes:'検証用の更新情報です。公開リリースではありません。'+('長い変更説明の折り返し確認。'.repeat(30))};throw new Error('Audit must not invoke installer');}}};await(await import('/src/app-updater.js')).initAppUpdater({getSettings:()=>({checkUpdatesOnStartup:false}),getRuntimeInfo:()=>({appVersion:'3.0.0'})},host,bridge);button.click();for(let i=0;i<100&&!dialog.querySelector('[data-update-notes]').textContent;i++)await new Promise(r=>setTimeout(r,10));})()`);
  assert.equal(await app.evaluate(`document.querySelector('[data-update-dialog] [data-update-latest]').textContent`),'v99.0.0');
  await inspect('update-available-mock');await close();
  await app.evaluate(`window.auditUpdateHost.remove();`);
  await app.evaluate(`window.__TAURI__.core.invoke('set_ui_zoom',{level:1.3});`);await delay(100);
  for(const view of ['calendar','tasks','ai']){await nav(view);await inspect(`zoom130-${view}`);}
  await app.evaluate(`document.querySelector('[data-view="ai"] [data-settings-btn]').click();document.querySelector('[data-settings-tab="advanced"]').click();`);
  await inspect('zoom130-settings-advanced');await close();
  await app.evaluate(`window.__TAURI__.core.invoke('set_ui_zoom',{level:1});`);
}finally{
  fs.writeFileSync(`${output}/observations.json`,JSON.stringify({observations,runtimeErrors:app.errors,liveOutlook:false,liveAi:false,liveUpdateChecks:false,mocks:['AI proposal stored directly, no inference','Update available response, no network/installer'],weather:'may use live read-only forecast API'},null,2));
  await app.close();
}
assert.ok(observations.every(row=>!row.rootOverflow&&!row.dialogOverflow&&!row.clipped.length&&!row.outside.length&&!row.unlabeled.length&&!row.duplicateIds.length&&!row.misboundLabels.length),'UI layout/accessibility problems remain; inspect observations.json');
assert.deepEqual(app.errors,[]);
console.log(`PASS: ${observations.length} UI states; no measured layout or accessible-name errors`);
