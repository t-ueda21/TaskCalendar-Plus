// Capture the actual renderer with synthetic data and a mocked native bridge.
// This does not launch the installed app or connect to Outlook/AI services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openHarness,FIXED_NOW} from './refactor-20261008-harness.mjs';

const output=path.resolve(process.argv[2]||'out/readme-capture');
if(fs.existsSync(output))throw Error('Choose a new output directory');
fs.mkdirSync(output,{recursive:true});
const version=JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json','utf8')).version;
const captured=[];
const stamp=FIXED_NOW;
const row=(id,date,title,startTime,endTime,tagId)=>({id,date,title,startTime,endTime,tagId,
  isAllDay:false,recurrence:{type:'none'},memo:'撮影用の架空データ',createdAt:stamp,updatedAt:stamp});
const extras=[
  ['research','調査','#6b84b6'],['review','レビュー','#a37aab'],['docs','資料作成','#6b9eaa'],
  ['planning','計画','#b69763'],['support','問い合わせ','#ba7888'],['testing','テスト','#8d9b57'],
  ['operations','運用','#748e9c'],['learning','学習','#b57f57'],
];

async function shot(h,name,locator=null) {
  const file=path.join(output,`${name}.png`);
  if(fs.existsSync(file))throw Error(`Refusing to overwrite ${file}`);
  await h.page.waitForLoadState('networkidle');
  await h.page.evaluate(()=>document.fonts.ready);
  if(locator) await locator.screenshot({path:file,animations:'disabled'});
  else await h.page.screenshot({path:file,animations:'disabled'});
  captured.push(name);
  console.log(`Captured ${name}`);
}
async function mockRuntime(h) {
  await h.page.route('**/api/runtime',route=>route.fulfill({json:{appVersion:version,osLocale:'ja-JP',testHarness:true}}));
}
function assertNoLiveActions(h) {
  assert.deepEqual(h.pageErrors,[]);
  assert.deepEqual(h.unexpectedRequests,[]);
  assert.ok(!h.apiLog.some(item=>['/api/outlook/fetch','/api/outlook/auto-sync','/api/ai/chat'].includes(item.route)),
    'Capture must not request Outlook synchronization or AI chat');
  assert.ok(h.externalRequests.every(item=>['api.open-meteo.com','archive-api.open-meteo.com'].includes(new URL(item.url).hostname)),
    'Unexpected external request was blocked');
}

const main=await openHarness({output:path.join(output,'main-evidence')});
try {
  await mockRuntime(main);
  for(const [id,name,color] of extras) {
    const response=await main.page.request.post(`${main.origin}/api/tags`,{data:{id,name,color}});
    assert.equal(response.status(),201);
  }
  const tags=['tag-design','tag-meeting',...extras.map(row=>row[0])];
  const settings={...main.state().settings,monthTagOrders:{'2026-09':tags,'2026-10':tags},
    outlookAutoSync:false,outlookWriteEnabled:false,outlookWriteDefault:false,
    checkUpdatesOnStartup:false,urlAutoOpenEnabled:false,aiProvider:'none',aiCliEnabled:false};
  assert.equal((await main.page.request.put(`${main.origin}/api/settings`,{data:settings})).status(),200);
  const tasks=[...main.state().tasks.map(task=>task.id==='task-tagless-late'
    ? {...task,title:'タグなしの予定',startTime:'16:00',endTime:'17:00'} : task),
    row('week-1','2026-10-05','画面の仕様整理','09:00','11:00','tag-design'),
    row('week-2','2026-10-06','週の進捗確認','10:00','11:00','tag-meeting'),
    row('week-3','2026-10-07','資料の調査','13:00','15:00','research'),
    row('week-4','2026-10-09','レビュー','10:00','11:00','review'),
  ];
  for(let month=1;month<=9;month++) {
    for(let day=1;day<=(month===9?30:20);day++) {
      const date=`2026-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      if([0,6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()))continue;
      for(const [part,[start,end]] of [['09:00','11:45'],['13:00',day%3===0?'16:15':'15:30'],['16:30',day%4===0?'19:15':'17:30']].entries()) {
        const id=tags[(day+part+month)%tags.length];
        tasks.push(row(`summary-${month}-${day}-${part}`,date,`サンプル予定 ${part+1}`,start,end,id));
      }
    }
  }
  main.setTasks(tasks);
  await main.boot();
  const p=main.page,calendar=p.locator('[data-view="calendar"]');
  await calendar.locator('[data-viewmode]').selectOption('week');
  await calendar.locator('.gridWrap:visible').evaluate(node=>{node.scrollTop=Math.max(0,node.scrollTop-35);});
  const weekScroll=await calendar.locator('.gridWrap:visible').evaluate(node=>node.scrollTop);
  await shot(main,'calendar-week');
  await calendar.locator('[data-viewmode]').selectOption('day');
  await calendar.locator('.gridWrap:visible').evaluate(node=>{node.scrollTop=Math.max(0,node.scrollTop-35);});
  await shot(main,'calendar-day');
  await calendar.locator('[data-mini-month-label]').click();await shot(main,'mini-month');
  await calendar.locator('[data-mini-month-label]').click();await shot(main,'mini-year');
  await calendar.locator('[data-go-today]').click();
  await calendar.locator('.taskBlock[data-task-id="task-plan"]:visible').click({button:'right'});
  await p.locator('.taskTagContextMenu').waitFor({state:'visible'});await shot(main,'tag-menu');await p.keyboard.press('Escape');

  await p.locator('nav [data-nav-target="tasks"]').click();
  const list=p.locator('[data-view="tasks"]');
  await list.locator('[data-task-id="task-plan"] [data-edit]').waitFor();
  assert.equal(await list.locator('tr[data-task-id]').count(),6);
  await shot(main,'tasks');
  await list.locator('[data-task-id="task-plan"] [data-edit]').click();
  await list.locator('[data-task-dialog]').waitFor({state:'visible'});await shot(main,'task-edit');
  await list.locator('[data-task-dialog] [data-cancel]').click();
  await list.locator('[data-task-id="task-plan"] .taskTitleCell').click();
  await list.locator('[data-task-id="task-meeting"] .taskTitleCell').click({modifiers:['Control']});
  await list.locator('[data-task-id="task-plan"]').click({button:'right'});
  await p.locator('.taskTagContextMenu [data-bulk-edit]').click();
  await p.locator('[data-bulk-dialog]').waitFor({state:'visible'});
  await p.locator('[data-bulk-dialog] [data-bulk-enable="memo"]').check();
  await p.locator('[data-bulk-dialog] [data-bulk-memo]').fill('次の打ち合わせで確認する');
  await shot(main,'task-bulk-edit');
  await p.locator('[data-bulk-dialog] [data-bulk-cancel]').click();
  await p.keyboard.press('Escape');

  await p.evaluate(async()=>{
    const S=await import('/src/store.js');
    await S.updateSettings({aiProvider:'ollama',aiOllamaModel:'sample-model'});
    S.addAiChatMessage('2026-10-08',{role:'user',text:'今日の予定を簡単にまとめて'});
    S.addAiChatMessage('2026-10-08',{role:'assistant',text:'今日の例では、設計と打ち合わせを中心に予定が登録されています。'});
  });
  await p.locator('nav [data-nav-target="ai"]').click();
  await p.locator('[data-view="ai"] [data-ai-chat-log]').getByText('今日の予定を簡単にまとめて').waitFor();
  await shot(main,'ai-mode');
  await p.evaluate(async()=>{await(await import('/src/store.js')).updateSettings({aiProvider:'none'});});

  await p.setViewportSize({width:1280,height:800});
  await p.locator('nav [data-nav-target="summary"]').click();
  const summary=p.locator('[data-view="summary"]');
  await summary.locator('[data-summary-shift="-1"]').click();
  assert.equal(await summary.locator('[data-summary-tag]').count(),10);
  assert.match(await summary.locator('[data-summary-period-label]').innerText(),/2026.*9/);
  const noScroll=await p.evaluate(()=>({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}));
  assert.ok(noScroll.width<=1280&&noScroll.height<=800,'Summary screenshot should fit the viewport');
  await shot(main,'summary-month');
  await summary.locator('[data-summary-tag="tag-design"]').click();
  await summary.locator('[data-summary-tag="tag-meeting"]').click();
  assert.equal(await summary.locator('[data-summary-tag][aria-pressed="true"]').count(),2);
  await shot(main,'summary-selected-tags');
  await summary.locator('[data-summary-all-tags]').click();
  await summary.locator('[data-summary-period="year"]').click();await shot(main,'summary-year');
  await summary.locator('[data-summary-period="month"]').click();
  await summary.locator('[data-settings-btn]').click();
  const summarySettings=p.locator('[data-settings-dialog]');
  await summarySettings.locator('[data-settings-tab="display"]').click();
  await summarySettings.locator('[data-theme-toggle]').click();
  await summarySettings.locator('[data-theme-toggle][aria-pressed="true"]:not([disabled])').waitFor();
  await summarySettings.locator('[data-settings-cancel]').click();
  await shot(main,'summary-dark');
  await summary.locator('[data-settings-btn]').click();
  await summarySettings.locator('[data-settings-tab="display"]').click();
  await summarySettings.locator('[data-theme-toggle]').click();
  await summarySettings.locator('[data-theme-toggle][aria-pressed="false"]:not([disabled])').waitFor();
  await summarySettings.locator('[data-settings-cancel]').click();
  await p.setViewportSize({width:1440,height:1000});
  await p.locator('nav [data-nav-target="calendar"]').click();
  await calendar.locator('[data-viewmode]').selectOption('week');

  await calendar.locator('[data-settings-btn]').click();
  const dialog=p.locator('[data-settings-dialog]');await dialog.waitFor({state:'visible'});
  await dialog.locator('[data-settings-tab="display"]').click();
  await dialog.locator('[data-language-select]').scrollIntoViewIfNeeded();await shot(main,'settings-display');
  await dialog.locator('[data-theme-toggle]').click();
  await dialog.locator('[data-theme-toggle][aria-pressed="true"]:not([disabled])').waitFor();
  await dialog.locator('[data-settings-tab="work"]').click();await shot(main,'settings-work-dark');
  await dialog.locator('[data-settings-tab="display"]').click();
  await dialog.locator('[data-theme-toggle]').click();
  await dialog.locator('[data-theme-toggle][aria-pressed="false"]:not([disabled])').waitFor();

  await dialog.locator('[data-settings-tab="outlook"]').click();
  await dialog.locator('[data-outlook-fetch-mode]').selectOption('range');
  await dialog.locator('[data-outlook-preset="month"]').click();
  await dialog.locator('[data-outlook-date-range]').waitFor({state:'visible'});await shot(main,'settings-outlook');
  await dialog.locator('[data-settings-tab="ai"]').click();
  await dialog.locator('[data-ai-personality="warmth"]').selectOption('warm');
  await dialog.locator('[data-ai-personality="customInstructions"]').fill('結論から、親しみやすい言葉で説明してください。');
  await dialog.locator('[data-ai-personalization]').evaluate(element=>{
    const scroller=element.closest('.settingsDialogBody'),section=element.closest('.settingsSection');
    scroller.scrollTop+=section.getBoundingClientRect().top-scroller.getBoundingClientRect().top-12;
  });
  await shot(main,'settings-ai',dialog.locator('[data-ai-personalization]').locator('xpath=..'));
  await dialog.locator('[data-settings-tab="data"]').click();
  const file={format:'taskcalendar-plus-settings',version:1,settings:{uiLanguage:'ja',workStart:'09:00'},tags:[]};
  await dialog.locator('[data-settings-import-file]').setInputFiles({name:'sample-settings.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(file))});
  await dialog.locator('[data-settings-import-btn]:not([disabled])').waitFor();
  await dialog.locator('.transferRead').first().scrollIntoViewIfNeeded();
  await shot(main,'settings-data',dialog.locator('[data-settings-tab-panel="data"] > .settingsSection').first());
  await dialog.locator('[data-settings-cancel]').click();

  for(const locale of ['en','ko']) {
    await p.evaluate(async locale=>{await(await import('/src/store.js')).updateSettings({uiLanguage:locale});},locale);
    await p.waitForFunction(locale=>document.documentElement.lang===locale,locale);
    await calendar.locator('.gridWrap:visible').evaluate((node,scrollTop)=>{node.scrollTop=scrollTop;},weekScroll);
    await shot(main,`calendar-${locale}`);
  }
  assertNoLiveActions(main);
} finally {await main.close();}

const sample=JSON.parse(fs.readFileSync('docs/examples/sample-backup.json','utf8'));
const budgets=await openHarness({output:path.join(output,'budgets-evidence')});
try {
  await mockRuntime(budgets);
  const display=await budgets.context.newCDPSession(budgets.page);
  await display.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:2,mobile:false});
  assert.equal(await budgets.page.evaluate(()=>window.devicePixelRatio),2);
  async function budgetShot(name,box) {
    await budgets.page.waitForLoadState('networkidle');
    const result=await display.send('Page.captureScreenshot',{format:'png',
      clip:{x:box.x,y:box.y,width:box.width,height:box.height,scale:1}});
    const bytes=Buffer.from(result.data,'base64');
    assert.ok(Math.abs(bytes.readUInt32BE(16)-box.width*2)<=2,'Expected a 2x screenshot');
    fs.writeFileSync(path.join(output,`${name}.png`),bytes,{flag:'wx'});
    captured.push(name);console.log(`Captured ${name}`);
  }
  for(const tag of budgets.state().tags) assert.equal((await budgets.page.request.delete(`${budgets.origin}/api/tags/${tag.id}`)).status(),204);
  for(const tag of sample.tags) assert.equal((await budgets.page.request.post(`${budgets.origin}/api/tags`,{data:tag})).status(),201);
  const settings={...budgets.state().settings,...sample.settings,outlookAutoSync:false,outlookWriteEnabled:false,
    outlookWriteDefault:false,checkUpdatesOnStartup:false,urlAutoOpenEnabled:false,aiProvider:'none',aiCliEnabled:false};
  assert.equal((await budgets.page.request.put(`${budgets.origin}/api/settings`,{data:settings})).status(),200);
  budgets.setTasks(sample.tasks);await budgets.boot();
  const p=budgets.page,calendar=p.locator('[data-view="calendar"]');
  await calendar.locator('[data-viewmode]').selectOption('day');
  const totals=await p.evaluate(async()=>{
    const S=await import('/src/store.js'),U=await import('/src/ui-utils.js');
    U.syncViewDate('2026-09-16');(await import('/src/calendar.js')).activate();
    const summary=S.calcMonthSummary('2026-09');return {total:summary.total,byTag:[...summary.byTag]};
  });
  assert.equal(totals.total,6300,'Sample month must contain 105 hours');
  assert.deepEqual(sample.tags.map(tag=>totals.byTag.find(([id])=>id===tag.id)?.[1]),[2910,840,990,1110,450]);
  const month=calendar.locator('[data-side-month-summary]');
  await month.locator('[data-tag-id]').first().waitFor();assert.equal(await month.locator('[data-tag-id]').count(),5);
  const heading=month.locator('xpath=preceding-sibling::h2[1]');
  const titleBox=await heading.boundingBox(),monthBox=await month.boundingBox();
  assert.ok(titleBox&&monthBox,'Monthly summary and heading must be visible');
  const left=Math.min(titleBox.x,monthBox.x),top=Math.min(titleBox.y,monthBox.y);
  const right=Math.max(titleBox.x+titleBox.width,monthBox.x+monthBox.width);
  const bottom=Math.max(titleBox.y+titleBox.height,monthBox.y+monthBox.height);
  assert.ok(left>=0&&top>=0&&right<=1440&&bottom<=1000,'Monthly summary must fit the viewport');
  await budgetShot('monthly-budgets',{x:left,y:top,width:right-left,height:bottom-top});
  await calendar.locator('[data-settings-btn]').click();
  const dialog=p.locator('[data-settings-dialog]');await dialog.locator('[data-settings-tab="tags"]').click();
  assert.equal(await dialog.locator('[data-tag-row]').count(),5);
  const tagSection=dialog.locator('[data-settings-tab-panel="tags"] .settingsTagSection');
  await tagSection.scrollIntoViewIfNeeded();
  const tagBox=await tagSection.boundingBox();assert.ok(tagBox,'Tag settings must be visible');
  await budgetShot('tag-budgets',tagBox);
  assertNoLiveActions(budgets);
} finally {await budgets.close();}

fs.writeFileSync(path.join(output,'capture.json'),JSON.stringify({version,fixedNow:FIXED_NOW,
  scope:'Current renderer in isolated Chromium; synthetic API, native bridge, weather and AI conversation; no installed app, live Outlook or AI.',
  captures:captured,sampleBackup:'docs/examples/sample-backup.json',sampleCaptureDeviceScaleFactor:2},null,2)+'\n');
console.log(JSON.stringify({version,count:captured.length,captures:captured,output}));
