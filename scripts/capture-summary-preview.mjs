// Actual renderer, synthetic schedules/API/native bridge; no installed app or Outlook.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openHarness } from './refactor-20261008-harness.mjs';

const output = path.resolve(process.argv[2] || 'out/summary-preview');
if (fs.existsSync(output)) throw new Error('Choose a fresh screenshot output directory');
fs.mkdirSync(output, { recursive:true });
const h = await openHarness({output});
try {
  const tags = [
    ['tag-design','開発','#55856d'], ['tag-meeting','会議','#d49448'],
    ['research','調査','#6b84b6'], ['review','レビュー','#a37aab'],
    ['docs','資料作成','#6b9eaa'], ['planning','計画','#b69763'],
    ['support','問い合わせ','#ba7888'], ['testing','テスト','#8d9b57'],
    ['operations','運用','#748e9c'], ['learning','学習','#b57f57'],
  ];
  for (const [index,[id,name,color]] of tags.entries()) {
    const url = h.origin+'/api/tags'+(index < 2 ? '/'+id : '');
    const response = await h.page.request[index < 2 ? 'put' : 'post'](url,{data:{id,name,color}});
    assert.ok(response.ok());
  }
  const tasks = [];
  for (let month=1; month<=10; month++) {
    const end = month===9 ? 30 : month===10 ? 8 : 20;
    for (let day=1; day<=end; day++) {
      const date = `2026-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      if ([0,6].includes(new Date(date+'T00:00:00Z').getUTCDay())) continue;
      const intervals = [['09:00','11:45'],['13:00',day%3===0?'16:15':'15:30'],['16:30',day%4===0?'19:15':'17:30']];
      for (const [part,[startTime,endTime]] of intervals.entries()) {
        const tag = tags[(day+part+month)%tags.length];
        tasks.push({id:`sample-${month}-${day}-${part}`,title:tag[1]+'のサンプル予定',date,startTime,endTime,
          tagId:tag[0],isAllDay:false,recurrence:{type:'none'},memo:'架空の検証用データ'});
      }
    }
  }
  tasks.push({id:'sample-overlap',title:'同時刻のサンプル予定',date:'2026-09-17',startTime:'10:00',endTime:'11:00',tagId:'tag-design',recurrence:{type:'none'}});
  h.setTasks(tasks);
  await h.boot();
  await h.page.locator('[data-nav-target="summary"]').click();
  const root = h.page.locator('[data-view="summary"]');
  await root.locator('[data-summary-shift="-1"]').click();
  const captures = [];
  async function capture(name,width,height) {
    await h.page.setViewportSize({width,height});
    await h.page.evaluate(()=>document.fonts.ready);
    const layout = await root.evaluate(el=>({
      viewport:[innerWidth,innerHeight],document:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],
      chartVisible:el.querySelector('[data-summary-chart]').getBoundingClientRect().height>0,
      numbersVisible:el.querySelector('[data-summary-numbers]').getBoundingClientRect().height>0,
      panels:[...el.querySelectorAll('[data-summary-panel]')].map(node=>{
        const r=node.getBoundingClientRect(); return {name:node.dataset.summaryPanel,bottom:r.bottom,right:r.right,client:node.clientHeight,scroll:node.scrollHeight};
      }),
    }));
    assert.ok(layout.chartVisible && layout.numbersVisible);
    assert.ok(layout.document[0]<=width && layout.document[1]<=height);
    for (const panel of layout.panels) assert.ok(panel.bottom<=height-8 && panel.right<=width && panel.scroll<=panel.client+2);
    await h.page.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});
    captures.push({name,...layout});
  }
  await capture('month-10-tags',1280,800);
  await root.locator('[data-summary-tag="tag-design"]').click();
  await root.locator('[data-summary-tag="tag-meeting"]').click();
  assert.equal(await root.locator('[data-summary-tag][aria-pressed="true"]').count(),2);
  await capture('month-selected-tags',1366,768);
  await root.locator('[data-summary-all-tags]').click();
  await root.locator('[data-summary-period="year"]').click();
  await capture('year',1280,800);
  await root.locator('[data-summary-period="month"]').click();
  await h.page.evaluate(async()=>{document.documentElement.dataset.theme='dark'; const S=await import('/src/store.js');(await import('/src/ui-color-picker.js')).applyUiColor(S.getSettings().uiAccentColor);});
  await capture('month-dark',1280,800);
  assert.deepEqual(h.pageErrors,[]);
  assert.deepEqual(h.unexpectedRequests,[]);
  fs.writeFileSync(path.join(output,'gallery.json'),JSON.stringify({scope:h.meta.scope,fixedNow:h.meta.fixedNow,sourceSha256:h.meta.source.sha256,tasks:tasks.length,tags:tags.length,captures},null,2));
  console.log(JSON.stringify({output,captures:captures.map(row=>row.name),scope:h.meta.scope}));
} finally { await h.close(); }
