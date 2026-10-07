// Capture the portable native app with an isolated profile and synthetic records.
// No live Outlook operations or AI responses are used for this gallery.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { nativeApp, delay } from './native-test-driver.mjs';

const output = 'docs/images/v3.0.0';
const app = await nativeApp({ exe: process.env.TCPLUS_E2E_EXE || 'out/v3.0.0/app/TaskCalendar-Plus.exe', port: 9384 });
const captures = [];
const capture = async name => {
  await delay(180);
  await app.evaluate(`(()=>{const labels={ja:'天気：撮影用表示',en:'Weather: screenshot placeholder',ko:'날씨: 촬영용 표시'};document.querySelectorAll('[data-calendar-day-weather],[data-calendar-week-weather],[data-task-day-weather],.weekDayWeather').forEach(node=>node.textContent=labels[document.documentElement.lang]||labels.ja);})();`);
  await app.screenshot(`${output}/${name}.png`);
  captures.push(name);
  console.log(`Captured ${name}`);
};
const settings = async tab => {
  await app.evaluate(`document.querySelector('[data-view="calendar"] [data-settings-btn]').click();document.querySelector('[data-settings-tab="${tab}"]').click();`);
};
const cancel = async () => app.evaluate(`document.querySelector('[data-settings-cancel]').click();`);
try {
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1100, deviceScaleFactor: 1, mobile: false });
  await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const OriginalDate=Date;window.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:['2026-10-07T14:00:00+09:00']));}static now(){return new OriginalDate('2026-10-07T14:00:00+09:00').getTime();}};})();` });
  await app.send('Page.reload');
  await delay(750);
  const version = await app.evaluate(`(async()=>{
    const S=await import('/src/store.js'),U=await import('/src/ui-utils.js');
    await S.updateSettings({uiLanguage:'ja',workStart:'09:00',workEnd:'18:00',aiProvider:'none',outlookAutoSync:false,outlookWriteDefault:false,checkUpdatesOnStartup:false,trayEnabled:false,breaks:[{start:'12:00',end:'13:00',countAsWork:false}]});
    await window.__TAURI__.core.invoke('set_tray_enabled',{enabled:false});
    const a=await S.createTag({name:'顧客ポータル改善',color:'#182333'}),b=await S.createTag({name:'打ち合わせ',color:'#fef08a'}),c=await S.createTag({name:'調査・学習',color:'#86efac'});
    await S.setMonthTagOrder('2026-10',[a.id,b.id,c.id]);
    for(const [date,title,startTime,endTime,tagId] of [
      ['2026-10-05','画面の設計','09:00','11:00',a.id],['2026-10-06','仕様の確認','13:00','15:00',b.id],
      ['2026-10-07','朝の調査と設計','08:00','10:00',a.id],['2026-10-07','チームレビュー','10:30','12:00',b.id],
      ['2026-10-07','実装と動作確認','13:00','16:00',a.id],['2026-10-07','夕方の振り返り','17:00','19:00',c.id],
      ['2026-10-07','翌日の準備（タグなし）','19:00','19:30',''],['2026-10-08','改善案の検討','13:00','15:00',a.id],
      ['2026-10-09','週次ミーティング','10:00','11:00',b.id]
    ])await S.createTask({title,date,startTime,endTime,tagId,memo:'スクリーンショット用の架空データです。',recurrence:{type:'none'}});
    U.syncViewDate('2026-10-07');(await import('/src/calendar.js')).activate();
    document.querySelectorAll('[data-view="calendar"] .gridWrap').forEach(grid=>grid.scrollTop=Math.max(0,grid.scrollTop-80));
    return S.getRuntimeInfo().appVersion;
  })()`);
  assert.equal(version, '3.0.0');
  // The weather placeholder is explicit rather than a fabricated live forecast.
  await app.evaluate(`document.querySelectorAll('[data-calendar-day-weather],[data-calendar-week-weather],[data-day-weather]').forEach(node=>node.textContent='天気：撮影用表示');`);
  await capture('calendar-week');
  await app.evaluate(`const select=document.querySelector('[data-viewmode]');select.value='day';select.dispatchEvent(new Event('change',{bubbles:true}));`);
  await app.evaluate(`document.querySelectorAll('[data-view="calendar"] .gridWrap').forEach(grid=>grid.scrollTop=Math.max(0,grid.scrollTop-80));`);
  await capture('calendar-day');
  await app.evaluate(`document.querySelector('[data-view="calendar"] [data-new-task]').click();const d=document.querySelector('[data-view="calendar"] [data-task-dialog]');d.querySelector('[name="title"]').value='新しい予定の登録';`);
  assert.equal(await app.evaluate(`document.querySelector('[data-view="calendar"] [name="outlookEnabled"]').checked`), false);
  await capture('task-create');
  await app.evaluate(`document.querySelector('[data-view="calendar"] [data-task-dialog]').close();document.querySelector('[data-view="calendar"] [data-mini-month-label]').click();`);
  await capture('mini-month');
  await app.evaluate(`document.querySelector('[data-view="calendar"] [data-mini-month-label]').click();`);
  await capture('mini-year');
  await app.evaluate(`document.querySelector('[data-view="calendar"] [data-go-today]').click();`);
  await app.evaluate(`(async()=>{const S=await import('/src/store.js');const task=S.getAllTasks().find(row=>row.title==='実装と動作確認');document.querySelector('[data-view="calendar"] [data-task-id="'+task.id+'"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:850,clientY:400}));})()`);
  await capture('tag-menu');
  await app.evaluate(`(async()=>{(await import('/src/ui-utils.js')).hideTaskTagMenu();document.querySelector('[data-nav-target="tasks"]').click();})()`);
  await capture('tasks');
  await app.evaluate(`document.querySelector('[data-nav-target="calendar"]').click();`);
  await settings('outlook');
  await app.evaluate(`const mode=document.querySelector('[data-outlook-fetch-mode]');mode.value='range';mode.dispatchEvent(new Event('change'));document.querySelector('[data-outlook-preset="view"]').click();`);
  await capture('outlook-range');
  await cancel();
  await settings('general');
  await capture('language-settings');
  await app.evaluate(`document.querySelector('[data-ai-personality="customInstructions"]').value='相棒のように親しみやすく、結論から簡潔に答えてください。';document.querySelector('[data-ai-personality="warmth"]').value='warm';document.querySelector('[data-ai-personality="customInstructions"]').scrollIntoView({block:'center'});`);
  await capture('ai-personality');
  await cancel();
  await settings('about');
  const fixture = path.resolve('out/v3.0.0/gallery-settings.json');
  fs.writeFileSync(fixture, JSON.stringify({format:'taskcalendar-plus-settings',version:1,settings:{uiLanguage:'ja',workStart:'09:00',workEnd:'18:00'},tags:[]}));
  const document = await app.send('DOM.getDocument');
  const input = await app.send('DOM.querySelector', { nodeId: document.result.root.nodeId, selector:'[data-settings-import-file]' });
  await app.send('DOM.setFileInputFiles', {nodeId:input.result.nodeId, files:[fixture]});
  await delay(200);
  await app.evaluate(`document.querySelector('[data-settings-import-file]').closest('.settingsSection').scrollIntoView({block:'start'});`);
  assert.equal(await app.evaluate(`document.querySelector('[data-settings-import-btn]').disabled`), false);
  await capture('transfer');
  await cancel();
  await settings('general');
  await app.evaluate(`document.querySelector('[data-theme-toggle]').click();`);
  await app.evaluate(`document.querySelector('[data-ai-personality="customInstructions"]').scrollIntoView({block:'center'});`);
  await capture('appearance-dark');
  await cancel();
  await app.evaluate(`(async()=>{await (await import('/src/store.js')).updateSettings({uiLanguage:'en',theme:'light'});document.documentElement.dataset.theme='light';const select=document.querySelector('[data-viewmode]');select.value='week';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await app.evaluate(`document.querySelectorAll('[data-view="calendar"] .gridWrap').forEach(grid=>grid.scrollTop=Math.max(0,grid.scrollTop-80));`);
  await capture('calendar-en');
  await app.evaluate(`(async()=>{await (await import('/src/store.js')).updateSettings({uiLanguage:'ko'});})()`);
  await app.evaluate(`document.querySelectorAll('[data-view="calendar"] .gridWrap').forEach(grid=>grid.scrollTop=Math.max(0,grid.scrollTop-80));`);
  await capture('calendar-ko');
  assert.deepEqual(app.errors, []);
  fs.writeFileSync(`${output}/capture.json`, JSON.stringify({version,viewport:'1680x1100 CSS pixels, scale 1',clock:'2026-10-07 14:00 JST (fixed for screenshots)',weather:'explicit shooting placeholder',data:'synthetic Japanese task and tag records in isolated profile',liveOutlook:false,liveAi:false,captures,runtimeErrors:app.errors},null,2)+'\n');
  console.log(`Captured ${captures.length} native screenshots; no runtime errors.`);
} finally {
  await app.close();
}
