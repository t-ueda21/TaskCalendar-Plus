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
      // Preserve the user's original arrangement at the larger readable scale.
      same([rect('.summaryTrend h2').x,rect('.summaryRange').x,rect('.summaryNumbersHeading h2').x,rect('.summaryNumberGrid > button').x,rect('.summarySelected > strong').x],'left column content edges');
      same([rect('.summaryTags h2').x,rect('.summaryInsights h2').x],'right column content edges');
      const headings=['.summaryTrend h2','.summaryTags h2'].map(selector=>rect(selector));
      same(headings.map(r=>r.y+r.height/2),'panel heading centers');
      const left=el.querySelector('.summaryTrend'),chart=el.querySelector('[data-summary-chart]'),numbers=el.querySelector('[data-summary-numbers]');
      const side=el.querySelector('.summarySide'),tags=el.querySelector('[data-summary-panel="tags"]'),insights=el.querySelector('[data-summary-panel="insights"]');
      if(!left.contains(chart)||!left.contains(numbers))errors.push({message:'chart and numbers must share the left panel'});
      if(!side?.contains(tags)||!side?.contains(insights))errors.push({message:'tags and insights must share the right column'});
      if(numbers.getBoundingClientRect().top<chart.getBoundingClientRect().bottom-1)errors.push({message:'numbers must be below chart'});
      if(tags.getBoundingClientRect().left<left.getBoundingClientRect().right-1)errors.push({message:'tags must be right of chart and numbers'});
      if(insights.getBoundingClientRect().top<tags.getBoundingClientRect().bottom-1)errors.push({message:'insights must be below tags'});
      const panels=[...el.querySelectorAll('[data-summary-panel]')];
      for(const panel of panels){const r=panel.getBoundingClientRect();if(r.right>innerWidth||r.bottom>innerHeight-8)errors.push({message:'panel outside viewport'});}
      for(let i=0;i<panels.length;i++)for(let j=i+1;j<panels.length;j++){
        if(panels[i].contains(panels[j])||panels[j].contains(panels[i]))continue;
        const a=panels[i].getBoundingClientRect(),b=panels[j].getBoundingClientRect();
        if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1)errors.push({message:'sibling panels overlap'});
      }
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
