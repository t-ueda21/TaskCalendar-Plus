// Exercise the real renderer with v0.2.1 cache data; no native app or live weather.
import assert from 'node:assert/strict';
import { openHarness } from './refactor-20261008-harness.mjs';

const h = await openHarness();
try {
  await h.page.route('**/api/weather-cache/*', route => route.request().method() === 'GET'
    ? route.fulfill({json:Object.fromEntries(Array.from({length:7},(_,index)=>{
      const date=`2026-10-${String(index+5).padStart(2,'0')}`;
      return [date,{date,weatherCode:61,weatherText:'雨',icon:'cloud-rain',tempMaxC:24,tempMinC:18,updatedAt:'2026-10-08T01:15:00.000Z'}];
    }))}) : route.continue());
  await h.boot();
  const page=h.page;
  page.setDefaultTimeout(10000);
  await page.waitForFunction(()=>document.querySelector('[data-calendar-day-weather]')?.textContent.includes('雨'));
  assert.equal(await page.locator('[data-calendar-day-weather] svg[data-weather-icon="cloud-rain"]').count(),1,'v0.2.1 cache must produce an SVG rather than literal cloud-rain text');
  assert.doesNotMatch(await page.locator('[data-calendar-day-weather]').innerText(),/cloud-rain/);
  await page.locator('nav.nav [data-nav-target="tasks"]').click();
  await page.locator('[data-view="tasks"] svg[data-weather-icon="cloud-rain"]').waitFor();
  const cases=await page.evaluate(async()=>{
    const W=await import('/src/weather.js'),I=await import('/src/i18n.js');
    const el=document.createElement('div');
    const result=[];
    for(const locale of ['ja','en','ko']) {
      I.setLocale(locale);
      for(const [code,icon] of [[0,'sun'],[1,'sun-medium'],[2,'cloud-sun'],[3,'cloud'],[45,'cloud-fog'],[51,'cloud-drizzle'],[61,'cloud-rain'],[71,'snowflake'],[80,'cloud-sun-rain'],[85,'cloud-snow'],[95,'cloud-lightning'],[null,'thermometer']]) {
        W.renderWeatherInto(el,{weatherCode:code,icon:'☀',weatherText:'古い天気',tempMaxC:null,tempMinC:null});
        result.push({locale,icon,actual:el.querySelector('svg')?.dataset.weatherIcon,text:el.textContent});
      }
    }
    W.renderWeatherInto(el,null);
    return {result,emptyIcons:el.querySelectorAll('svg').length,emptyText:el.textContent};
  });
  for(const row of cases.result){assert.equal(row.actual,row.icon);assert.doesNotMatch(row.text,/☀|古い天気|0\.0/);}
  assert.equal(cases.emptyIcons,0);
  assert.ok(cases.emptyText);
  assert.deepEqual(h.pageErrors,[]);
  console.log('PASS: old SVG-name/emoji caches, calendar/tasks icons, all weather codes, missing values and Japanese/English/Korean');
} finally { await h.close(); }
