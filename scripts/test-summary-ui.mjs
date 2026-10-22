import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openHarness } from './refactor-20261008-harness.mjs';

const output=process.env.TCPLUS_SUMMARY_EVIDENCE;
if(output)fs.mkdirSync(output,{recursive:true});
const h=await openHarness();
try {
  for(let index=0;index<8;index++) await h.page.request.post(h.origin+'/api/tags',{data:{id:'extra-'+index,
    name:index===0?'<img src=x onerror="window.summaryUnsafe=true">':index===1?'とても長い名前のタグでも選択した対象を確認できること'.repeat(2):'追加タグ '+index,
    color:'#4e8a72'}});
  h.setTasks([...h.state().tasks,
    {id:'summary-past',title:'past',date:'2026-09-08',startTime:'09:00',endTime:'10:00',tagId:'tag-design',isAllDay:false,recurrence:{type:'none'}},
    {id:'summary-future',title:'future',date:'2026-10-09',startTime:'09:00',endTime:'11:00',tagId:'tag-meeting',isAllDay:false,recurrence:{type:'none'}},
  ]);
  await h.boot();
  assert.equal(await h.page.locator('nav [data-nav-target="summary"]').count(),1,'Summary navigation must follow AI mode');
  await h.page.locator('nav [data-nav-target="summary"]').click();
  const root=h.page.locator('[data-view="summary"]');
  const value=id=>root.locator(`[data-summary-metric="${id}"] [data-metric-value]`).innerText();
  const expectTotal=async expected=>{await h.page.waitForFunction(text=>document.querySelector('[data-view="summary"] [data-summary-metric="total"] [data-metric-value]')?.textContent.replace(/\s/g,'')===text,expected);};
  await expectTotal('4時間30分');
  assert.equal((await value('overtime')).replace(/\s/g,''),'1時間0分');
  assert.equal(await root.locator('[data-summary-chart]').isVisible(),true);
  assert.equal(await root.locator('[data-summary-numbers]').isVisible(),true);
  assert.equal(await root.locator('[data-summary-bar]').count(),31);
  assert.equal(await root.locator('[data-summary-day]').count(),31);
  assert.equal(await root.locator('[data-summary-tag]').count(),10);
  assert.equal(await root.locator('img').count(),0,'tag markup must stay text');
  assert.equal(await h.page.evaluate(()=>window.summaryUnsafe),undefined);
  assert.equal(await root.locator('[data-summary-period]').count(),2);
  assert.ok(!(await root.innerText()).includes('これまで'));
  assert.ok(!(await root.innerText()).includes('集計の見方'));

  async function layout(label,width,height) {
    await h.page.setViewportSize({width,height});
    const bounds=await root.evaluate(el=>({viewport:[innerWidth,innerHeight],
      items:[...el.querySelectorAll('[data-summary-panel],[data-summary-tag],[data-summary-day]')].filter(n=>n.getBoundingClientRect().width>0).map(n=>{
        const r=n.getBoundingClientRect();return {name:n.getAttribute('data-summary-panel')||n.getAttribute('data-summary-tag')||n.getAttribute('data-summary-day'),x:r.x,y:r.y,right:r.right,bottom:r.bottom,scroll:n.scrollHeight,client:n.clientHeight};
      })}));
    for(const item of bounds.items){assert.ok(item.x>=0&&item.y>=0&&item.right<=width&&item.bottom<=height-8,`${label}: ${item.name} outside viewport`);assert.ok(item.scroll<=item.client+2,`${label}: ${item.name} clips content (${item.scroll}/${item.client})`);}
    if(output)await h.page.screenshot({path:path.join(output,label+'.png'),animations:'disabled'});
  }
  await layout('summary-ja-1280',1280,800);
  await layout('summary-ja-1366',1366,768);
  console.log('PASS: simultaneous chart and numbers, 10 tags, safe names and no-scroll desktop layout');

  await root.locator('[data-summary-tag="tag-design"]').click();await expectTotal('3時間30分');
  await root.locator('[data-summary-tag="tag-meeting"]').click();await expectTotal('4時間30分');
  assert.equal(await root.locator('[data-summary-tag][aria-pressed="true"]').count(),2);
  await root.locator('[data-summary-period="year"]').click();await expectTotal('5時間30分');
  assert.equal(await root.locator('[data-summary-day]').count(),12);
  assert.equal(await root.locator('[data-summary-axis] > span').first().evaluate(el=>{
    const range=document.createRange();range.selectNodeContents(el);return range.getClientRects().length;
  }),1,'yearly hours axis label must remain on one line');
  assert.equal(await root.locator('[data-summary-tag][aria-pressed="true"]').count(),2);
  await root.locator('[data-summary-day="2026-10"]').click();await expectTotal('4時間30分');
  await root.locator('[data-summary-all-tags]').click();
  await root.locator('[data-summary-future]').check();await expectTotal('6時間30分');
  await root.locator('[data-summary-future]').uncheck();await expectTotal('4時間30分');
  console.log('PASS: single/multiple tags, year drilldown, preserved selection and future inclusion');

  await h.page.evaluate(async()=>{const S=await import('/src/store.js');await S.createTask({id:'summary-new',date:'2026-10-08',title:'new',tagId:'tag-design',startTime:'18:30',endTime:'19:00',recurrence:{type:'none'}});});
  await expectTotal('5時間0分');
  await h.page.evaluate(async()=>{await (await import('/src/store.js')).updateTask('summary-new',{endTime:'19:30'});});
  await expectTotal('5時間30分');
  await h.page.evaluate(async()=>{await (await import('/src/store.js')).updateSettings({workEnd:'17:00'});});
  await h.page.waitForFunction(()=>document.querySelector('[data-summary-metric="overtime"] [data-metric-value]').textContent.replace(/\s/g,'')==='2時間30分');
  await h.page.evaluate(async()=>{await (await import('/src/store.js')).deleteTask('summary-new');});await expectTotal('4時間30分');
  await root.locator('[data-summary-tag="extra-0"]').click();await expectTotal('0時間0分');
  await h.page.evaluate(async()=>{await (await import('/src/store.js')).deleteTag('extra-0');});
  await expectTotal('0時間0分');assert.equal(await root.locator('[data-summary-all-tags]').getAttribute('aria-pressed'),'false','deleted selection must not silently become All');
  await root.locator('[data-summary-all-tags]').click();await expectTotal('4時間30分');
  console.log('PASS: task/settings changes and deleted selections keep data and scope correct');

  await root.locator('[data-summary-config]').click();
  const modal=root.locator('[data-summary-options]');
  await modal.locator('[value="overtimeDays"]').check();assert.equal(await modal.locator('[data-summary-apply]').isEnabled(),false);
  await modal.locator('[data-summary-cancel]').click();assert.equal(await root.locator('[data-summary-metric]').count(),4);
  await root.locator('[data-summary-config]').click();
  await modal.locator('[data-summary-average-base]').selectOption('business');await modal.locator('[data-summary-apply]').click();
  await h.page.waitForFunction(()=>document.querySelector('[data-summary-metric="average"] [data-metric-value]').textContent.replace(/\s/g,'')==='0時間45分');
  console.log('PASS: metric limit, cancel and configured average denominator');

  await root.locator('[data-summary-config]').click();
  await modal.locator('[data-summary-average-base]').selectOption('recorded');
  h.failNext('PUT','/api/settings',500);
  await modal.locator('[data-summary-apply]').click();await modal.locator('[data-summary-save-error]').waitFor({state:'visible'});
  assert.equal(await modal.evaluate(el=>el.open),true);
  assert.equal((await value('average')).replace(/\s/g,''),'0時間45分','failed save must not apply the pending choice');
  await modal.locator('[data-summary-apply]').click();await modal.waitFor({state:'hidden'});
  assert.equal(h.state().settings.summaryPreferences.averageBase,'recorded');

  await h.page.waitForLoadState('networkidle');h.failNext('GET','/api/tasks',500);
  await h.page.locator('nav [data-nav-target="calendar"]').click();
  await h.page.locator('nav [data-nav-target="summary"]').click();
  await root.locator('[data-summary-retry]').waitFor({state:'visible'});await expectTotal('4時間30分');
  await root.locator('[data-summary-retry]').click();await root.locator('[data-summary-retry]').waitFor({state:'hidden'});
  console.log('PASS: failed preference save and data refresh preserve state and support retry');

  await h.page.evaluate(async()=>{const S=await import('/src/store.js');for(let i=0;i<3;i++)await S.createTag({id:'page-'+i,name:'ページ用タグ '+i,color:'#528b70'});});
  await root.locator('[data-summary-tag-page="1"]').click();
  assert.ok(await root.locator('[data-summary-tag]').count()<=10);
  const pageTag=await root.locator('[data-summary-tag]').first().getAttribute('data-summary-tag');
  await root.locator('[data-summary-tag]').first().focus();await h.page.keyboard.press('Enter');await expectTotal('0時間0分');
  assert.equal(await h.page.evaluate(()=>document.activeElement?.getAttribute('data-summary-tag')),pageTag,'tag filtering must preserve keyboard focus');
  await root.locator('[data-summary-tag-page="-1"]').click();
  await root.locator('[data-summary-tag="tag-design"]').click();await expectTotal('3時間30分');
  await root.locator('[data-summary-tag-page="1"]').click();
  assert.equal(await root.locator(`[data-summary-tag="${pageTag}"]`).getAttribute('aria-pressed'),'true');
  await root.locator('[data-summary-all-tags]').click();await root.locator('[data-summary-tag-page="-1"]').click();
  console.log('PASS: more than ten tags remain reachable, with selection across pages');

  for(const locale of ['en','ko','zh-CN','zh-TW','es','fr','de','pt','ja']) {
    await h.page.evaluate(async locale=>{await (await import('/src/store.js')).updateSettings({uiLanguage:locale});},locale);
    await h.page.waitForFunction(locale=>document.documentElement.lang===locale,locale);
    if(locale==='en')assert.deepEqual(await root.evaluate(el=>({
      period:el.querySelector('.summarySegment').getAttribute('aria-label'),
      previous:el.querySelector('[data-summary-tag-page="-1"]').getAttribute('aria-label'),
      next:el.querySelector('[data-summary-tag-page="1"]').getAttribute('aria-label'),
    })),{period:'Period',previous:'Previous tags',next:'Next tags'},'period and tag pagination must have localized accessible names');
    await layout('summary-'+locale,1280,800);
  }
  await h.page.evaluate(async()=>{document.documentElement.dataset.theme='dark';const S=await import('/src/store.js');(await import('/src/ui-color-picker.js')).applyUiColor(S.getSettings().uiAccentColor);});
  await layout('summary-dark',1366,768);
  await root.locator('[data-summary-config]').click();
  await modal.locator('[value="days"]').uncheck();await modal.locator('[value="overtimeDays"]').check();
  await modal.locator('[data-summary-average-base]').selectOption('business');await modal.locator('[data-summary-apply]').click();await modal.waitFor({state:'hidden'});
  await h.page.reload();await h.page.locator('[data-view="calendar"]:not([hidden])').waitFor();
  await h.page.locator('nav [data-nav-target="summary"]').click();await expectTotal('4時間30分');
  assert.equal(await root.locator('[data-summary-metric="overtimeDays"]').count(),1);
  assert.equal((await value('average')).replace(/\s/g,''),'0時間45分','saved metrics and denominator must survive reloading');
  h.setTasks([]);await h.page.evaluate(async()=>{await (await import('/src/store.js')).refreshTasks();});await expectTotal('0時間0分');
  assert.equal(await root.locator('[data-summary-empty]').isVisible(),true);
  assert.equal(await root.locator('[data-summary-day]').count(),31);
  assert.deepEqual(h.pageErrors,[]);
  assert.deepEqual(h.unexpectedRequests,[]);
  console.log('PASS: nine languages, dark theme, persisted preferences, empty state and no unexpected renderer errors');
} finally { await h.close(); }
