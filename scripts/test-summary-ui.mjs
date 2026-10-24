import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openHarness } from './refactor-20261008-harness.mjs';

const output=process.env.TCPLUS_SUMMARY_EVIDENCE;
if(output)fs.mkdirSync(output,{recursive:true});
const h=await openHarness();
h.page.setDefaultTimeout(5000);
const allMetrics=['total','average','overtime','days','overtimeDays','longest'];
try {
  await h.page.request.put(h.origin+'/api/settings',{data:{...h.state().settings,summaryPreferences:{version:2,metrics:['longest','total'],averageBase:'recorded'}}});
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
  assert.deepEqual(await root.locator('[data-summary-metric]').evaluateAll(nodes=>nodes.map(node=>node.dataset.summaryMetric)),allMetrics,'stored custom subset must show all six metrics on opening Summary');
  assert.equal(await root.locator('[data-summary-config],[data-summary-options]').count(),0,'metric configuration button and dialog are removed');
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

  async function periodActions(previous,next) {
    for(const [shift,label,icon] of [[-1,previous,'◀'],[1,next,'▶']]) {
      const button=root.locator(`[data-summary-shift="${shift}"]`);
      assert.equal((await button.innerText()).replace(/\s/g,''),shift<0?icon+label:label+icon,'period navigation exposes its action and shared directional icon');
      assert.equal(await button.locator('[aria-hidden="true"]').innerText(),icon,'decorative arrow must be hidden from assistive technology');
      assert.ok((await button.getAttribute('aria-label'))?.includes(label),`period button accessible name includes ${label}`);
    }
  }
  await periodActions('前月','翌月');
  await root.locator('[data-summary-shift="-1"]').focus();await h.page.keyboard.press('Enter');
  assert.match(await root.locator('[data-summary-period-label]').innerText(),/2026.*9/);await expectTotal('1時間0分');
  assert.equal(await h.page.evaluate(()=>document.activeElement?.getAttribute('data-summary-shift')),'-1','period navigation preserves keyboard focus');
  await root.locator('[data-summary-shift="1"]').focus();await h.page.keyboard.press('Space');await expectTotal('4時間30分');
  for(let i=0;i<3;i++)await root.locator('[data-summary-shift="1"]').click();
  assert.match(await root.locator('[data-summary-period-label]').innerText(),/2027.*1/,'month navigation crosses the year boundary');
  await root.locator('[data-summary-shift="-1"]').click();
  assert.match(await root.locator('[data-summary-period-label]').innerText(),/2026.*12/,'previous month crosses back over the year boundary');
  await root.locator('[data-summary-current]').click();await expectTotal('4時間30分');
  const boundaryControls=await root.evaluate(async el=>{
    const {buildSummary}=await import('/src/summary-model.js');
    const {renderSummary}=await import('/src/summary-renderer.js');
    const {getSettings}=await import('/src/store.js');
    return [['month',1,1],['month',9999,12],['year',1,1],['year',9999,12]].map(([period,year,month])=>{
      const copy=el.cloneNode(true),state={period,year,month,includeFuture:false,selectedTagIds:null,selectedKey:null,tagPage:0,preferences:{averageBase:'recorded'}};
      const model=buildSummary({...state,today:'2026-10-08',tags:[],settings:getSettings(),getTasksByDate:()=>[]});
      renderSummary(copy,model,state);
      return {period,year,previous:copy.querySelector('[data-summary-shift="-1"]').disabled,next:copy.querySelector('[data-summary-shift="1"]').disabled};
    });
  });
  assert.deepEqual(boundaryControls,[
    {period:'month',year:1,previous:true,next:false},{period:'month',year:9999,previous:false,next:true},
    {period:'year',year:1,previous:true,next:false},{period:'year',year:9999,previous:false,next:true},
  ],'period controls retain supported year boundaries');

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
  await periodActions('前年','翌年');
  await root.locator('[data-summary-shift="-1"]').focus();await h.page.keyboard.press('Enter');
  assert.match(await root.locator('[data-summary-period-label]').innerText(),/2025/);
  await root.locator('[data-summary-shift="1"]').focus();await h.page.keyboard.press('Space');await expectTotal('5時間30分');
  assert.equal(await root.locator('[data-summary-day]').count(),12);
  assert.equal(await root.locator('[data-summary-axis] > span').first().evaluate(el=>{
    const range=document.createRange();range.selectNodeContents(el);return range.getClientRects().length;
  }),1,'yearly hours axis label must remain on one line');
  assert.equal(await root.locator('[data-summary-tag][aria-pressed="true"]').count(),2);
  await root.locator('[data-summary-day="2026-10"]').click();await expectTotal('4時間30分');
  await periodActions('前月','翌月');
  await root.locator('[data-summary-all-tags]').click();
  await root.locator('.uiToggle:has([data-summary-future])').click();await expectTotal('6時間30分');
  await root.locator('.uiToggle:has([data-summary-future])').click();await expectTotal('4時間30分');
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

  await h.page.evaluate(async()=>{await(await import('/src/store.js')).updateSettings({summaryPreferences:{version:2,metrics:['average'],averageBase:'business'}});});
  await h.page.waitForFunction(()=>document.querySelector('[data-summary-metric="average"] [data-metric-value]').textContent.replace(/\s/g,'')==='0時間45分');
  assert.deepEqual(await root.locator('[data-summary-metric]').evaluateAll(nodes=>nodes.map(node=>node.dataset.summaryMetric)),allMetrics,'stored custom subset must not hide fixed six metrics');
  console.log('PASS: six fixed metrics with no configuration UI and existing average denominator preserved');

  await h.page.waitForLoadState('networkidle');h.failNext('GET','/api/tasks',500);
  await h.page.locator('nav [data-nav-target="calendar"]').click();
  await h.page.locator('nav [data-nav-target="summary"]').click();
  await root.locator('[data-summary-retry]').waitFor({state:'visible'});await expectTotal('4時間30分');
  await root.locator('[data-summary-retry]').click();await root.locator('[data-summary-retry]').waitFor({state:'hidden'});
  console.log('PASS: failed data refresh preserves state and supports retry');

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
  await h.page.reload();await h.page.locator('[data-view="calendar"]:not([hidden])').waitFor();
  await h.page.locator('nav [data-nav-target="summary"]').click();await expectTotal('4時間30分');
  assert.deepEqual(await root.locator('[data-summary-metric]').evaluateAll(nodes=>nodes.map(node=>node.dataset.summaryMetric)),allMetrics,'stored subset still renders all six after reload');
  assert.equal((await value('average')).replace(/\s/g,''),'0時間45分','saved denominator must survive reloading');
  const customOrder=['longest','total','average'];
  await h.page.evaluate(async metrics=>{await(await import('/src/store.js')).updateSettings({summaryPreferences:{version:2,metrics,averageBase:'recorded'}});},customOrder);
  await h.page.reload();await h.page.locator('[data-view="calendar"]:not([hidden])').waitFor();
  await h.page.locator('nav [data-nav-target="summary"]').click();await expectTotal('4時間30分');
  assert.deepEqual(await root.locator('[data-summary-metric]').evaluateAll(nodes=>nodes.map(node=>node.dataset.summaryMetric)),allMetrics,'imported subset/order does not change six-card presentation');
  assert.equal((await value('average')).replace(/\s/g,''),'4時間30分','recorded-days denominator remains supported');
  h.setTasks([]);await h.page.evaluate(async()=>{await (await import('/src/store.js')).refreshTasks();});await expectTotal('0時間0分');
  assert.equal(await root.locator('[data-summary-empty]').isVisible(),true);
  assert.equal(await root.locator('[data-summary-day]').count(),31);
  assert.deepEqual(h.pageErrors,[]);
  assert.deepEqual(h.unexpectedRequests,[]);
  console.log('PASS: nine languages, dark theme, six fixed metrics, persisted average, empty state and no unexpected renderer errors');
} finally { await h.close(); }
