import assert from 'node:assert/strict';
import { openHarness } from './refactor-20261008-harness.mjs';

const h=await openHarness();
try {
  for(let i=0;i<8;i++)await h.page.request.post(h.origin+'/api/tags',{data:{id:'alignment-'+i,name:'タグ '+i,color:'#658f79'}});
  await h.boot();await h.page.setViewportSize({width:1280,height:800});
  await h.page.locator('[data-nav-target="summary"]').click();
  const root=h.page.locator('[data-view="summary"]');
  await root.locator('[data-summary-metric="total"]').waitFor({state:'visible'});

  async function inspect(label) {
    const problems=await root.evaluate(el=>{
      const errors=[];
      const rect=selector=>el.querySelector(selector).getBoundingClientRect();
      const same=(values,message,tolerance=1)=>{if(Math.max(...values)-Math.min(...values)>tolerance)errors.push({message,values});};
      const controls=[...el.querySelectorAll('.summarySegment,[data-summary-config],.summaryToolbar .right .btn')].map(n=>n.getBoundingClientRect());
      same(controls.map(r=>r.top),'heading control tops');same(controls.map(r=>r.bottom),'heading control bottoms');
      const grid=[...el.querySelectorAll('.summaryGridlines > i')].map(n=>n.getBoundingClientRect());
      const ticks=[...el.querySelectorAll('.summaryAxis > span')];
      if(grid.length!==ticks.length)errors.push({message:'each tick needs a matching gridline',ticks:ticks.length,lines:grid.length});
      ticks.forEach((node,i)=>{if(!grid[i])return;const r=node.getBoundingClientRect();same([r.y+r.height/2,grid[i].y+grid[i].height/2],'axis tick '+node.textContent);});
      // The readable redesign places tags below the chart and numbers in the right column.
      same([rect('.summaryTrend h2').x,rect('.summaryRange').x,rect('.summarySelected > strong').x,rect('.summaryTags h2').x],'left column content edges');
      same([rect('.summaryNumbersHeading h2').x,rect('.summaryNumberGrid > button').x,rect('.summaryInsights h2').x],'right column content edges');
      const headings=['.summaryTrend h2','.summaryNumbersHeading h2'].map(selector=>rect(selector));
      same(headings.map(r=>r.y+r.height/2),'panel heading centers');
      const panels=[...el.querySelectorAll('[data-summary-panel]')].map(n=>n.getBoundingClientRect());
      for(const r of panels)if(r.right>innerWidth||r.bottom>innerHeight-8)errors.push({message:'panel outside viewport'});
      if(document.documentElement.scrollHeight>innerHeight||document.documentElement.scrollWidth>innerWidth)errors.push({message:'page scrolls'});
      return errors;
    });
    assert.deepEqual(problems,[],label);
  }
  await inspect('month, ten tags, 1280 x 800');
  await h.page.setViewportSize({width:1366,height:768});
  await root.locator('[data-summary-period="year"]').click();await inspect('year, ten tags, 1366 x 768');
  await h.page.evaluate(async()=>{const S=await import('/src/store.js');await S.updateSettings({uiLanguage:'de'});document.documentElement.dataset.theme='dark';(await import('/src/ui-color-picker.js')).applyUiColor(S.getSettings().uiAccentColor);});
  await inspect('year, German, dark');
  for(const metrics of [['total'],['total','average'],['total','average','days'],['total','average','overtime','days']]){
    await h.page.evaluate(async metrics=>{await(await import('/src/store.js')).updateSettings({summaryPreferences:{metrics,averageBase:'recorded'}});},metrics);
    const gap=await root.locator('[data-summary-metrics]').evaluate(el=>el.getBoundingClientRect().right-el.lastElementChild.getBoundingClientRect().right);
    assert.ok(Math.abs(gap)<=1,`${metrics.length} metric cards must use the available row width (${gap}px unused)`);
  }
  assert.deepEqual(h.pageErrors,[]);
  console.log('PASS: axis/grid alignment, controls, panel insets, metric widths and desktop fit');
}finally{await h.close();}
