import fs from 'node:fs';import {nativeApp,delay} from './native-test-driver.mjs';
const output='out/v3.0.0';fs.mkdirSync(output,{recursive:true});
const fixtureScript=`(()=>{const OriginalDate=Date;window.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:['2026-10-07T14:00:00+09:00']));}static now(){return new OriginalDate('2026-10-07T14:00:00+09:00').getTime();}};})();`;
for(const [label,exe,port] of [['before','src-tauri/target/release/taskcalendar-plus.exe',9382],['after',process.env.TCPLUS_E2E_EXE||'src-tauri/target/debug/taskcalendar-plus.exe',9383]]) {
 const app=await nativeApp({exe,port});
 try {
  await app.send('Page.addScriptToEvaluateOnNewDocument',{source:fixtureScript});await app.send('Page.reload');await delay(650);
  const version=await app.evaluate(`(async()=>{const S=await import('/src/store.js'),U=await import('/src/ui-utils.js');await S.updateSettings({uiLanguage:'ja',workStart:'09:00',workEnd:'18:00',aiProvider:'none',outlookAutoSync:false,outlookWriteDefault:false,checkUpdatesOnStartup:false,trayEnabled:false});await window.__TAURI__.core.invoke('set_tray_enabled',{enabled:false});const a=await S.createTag({name:'顧客ポータル改善',color:'#182333'}),b=await S.createTag({name:'打ち合わせ',color:'#fef08a'});await S.setMonthTagOrder('2026-10',[a.id,b.id]);for(const [title,startTime,endTime,tagId]of[['調査と設計','08:00','10:00',a.id],['レビュー','13:00','15:00',b.id],['夕方のまとめ','17:00','19:00',a.id],['タグなしの記録','19:00','20:00','']])await S.createTask({title,date:'2026-10-07',startTime,endTime,tagId,memo:'比較用の架空データ'});U.syncViewDate('2026-10-07');(await import('/src/calendar.js')).activate();document.querySelectorAll('[data-calendar-day-weather],[data-calendar-week-weather],[data-day-weather]').forEach(node=>node.textContent='撮影用に固定');return S.getRuntimeInfo().appVersion;})()`);
  await delay(150);await app.screenshot(output+'/comparison-'+label+'-calendar.png');
  await app.evaluate(`document.querySelector('[data-view="calendar"] [data-settings-btn]').click();document.querySelector('[data-settings-tab="about"]').click();document.querySelector('[data-settings-import-file]').scrollIntoView({block:'center'});`);await delay(80);await app.screenshot(output+'/comparison-'+label+'-transfer.png');
  fs.writeFileSync(output+'/comparison-'+label+'.json',JSON.stringify({version,clock:'JS Date fixed at 2026-10-07 14:00 JST',viewport:'native default',data:'synthetic matching tasks and tags',theme:'light',liveOutlook:false},null,2));
  console.log(`Captured ${label} v${version}`);
 } finally {await app.close();}
}
