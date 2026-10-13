import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openHarness } from './refactor-20261008-harness.mjs';
const h = await openHarness();
try {
  await h.boot();
  const result = await h.page.evaluate(async () => {
    const S = await import('/src/store.js');
    const row = await S.createTask({title:'Overnight',date:'2026-10-31',endDate:'2026-11-02',startTime:'23:30:15',endTime:'00:00',isAllDay:false,tagId:'tag-design',recurrence:{type:'none'},outlookDetails:{location:'Room A',organizer:'Owner',attachments:[{name:'note.txt',size:42,index:1}]}});
    const allDay = await S.createTask({title:'Away',date:'2026-10-30',endDate:'2026-11-02',isAllDay:true,tagId:'',recurrence:{type:'none'}});
    return {row,allDay,on31:S.getTasksByDate('2026-10-31').map(t=>t.title),on1:S.getTasksByDate('2026-11-01').map(t=>t.title),on2:S.getTasksByDate('2026-11-02').map(t=>t.title),oct:S.calcMonthSummary('2026-10').byTag.get('tag-design'),nov:S.calcMonthSummary('2026-11').byTag.get('tag-design'),day:S.calcDaySummary('2026-11-01').total};
  });
  assert.equal(result.row?.endDate,'2026-11-02','creation must retain end date and seconds');
  assert.equal(result.row.startTime,'23:30:15');
  assert.equal(result.row.outlookDetails.location,'Room A');
  assert.deepEqual(result.on1,['Overnight','Away']);
  assert.deepEqual(result.on2,['Away'],'midnight end is exclusive, all-day final date is inclusive');
  assert.equal(result.nov,1380,'daily breaks apply to each covered date');
  assert.equal(result.day,1380);
  const series = await h.page.evaluate(async () => {
    const S = await import('/src/store.js');
    const first = await S.createTask({title:'Daily span',date:'2026-11-05',endDate:'2026-11-06',startTime:'23:00',endTime:'01:00',isAllDay:false,tagId:'tag-design',recurrence:{type:'daily',until:'2026-11-07'}});
    await S.updateTaskWithMode(first.id,{title:'Changed span',date:first.date,endDate:'2026-11-07'},'series');
    return S.getAllTasks().filter(t=>t.title==='Changed span').map(t=>[t.date,t.endDate]);
  });
  assert.deepEqual(series,[['2026-11-05','2026-11-07'],['2026-11-06','2026-11-08'],['2026-11-07','2026-11-09']],'series range changes are relative to each occurrence');
  const calendar=h.page.locator('[data-view="calendar"]');
  await calendar.locator('[data-new-task]').click();
  const dialog=calendar.locator('[data-task-dialog]');
  await dialog.locator('[name="title"]').fill('Editor overnight');
  await dialog.locator('[name="date"]').fill('2026-10-08');
  await dialog.locator('[name="endDate"]').fill('2026-10-09');
  await dialog.locator('[name="startTime"]').fill('23:30:15');
  await dialog.locator('[name="endTime"]').fill('01:15:45');
  await dialog.locator('summary[data-event-details-title]').click();
  await dialog.locator('[name="eventLocation"]').fill('A & <B>');
  await dialog.locator('[data-save]').click();
  await dialog.waitFor({state:'hidden'});
  await calendar.locator('[data-viewmode]').selectOption('week');
  const saved=h.state().tasks.find(t=>t.title==='Editor overnight');
  assert.equal(saved.endDate,'2026-10-09');
  assert.equal(saved.endTime,'01:15:45');
  assert.equal(saved.outlookDetails.location,'A & <B>');
  assert.equal(await calendar.locator(`[data-weekcol][data-date="2026-10-08"] [data-task-id="${saved.id}"]`).count(),1);
  assert.equal(await calendar.locator(`[data-weekcol][data-date="2026-10-09"] [data-task-id="${saved.id}"]`).count(),1);
  assert.equal(await calendar.locator(`[data-weekcol][data-date="2026-10-09"] [data-task-id="${saved.id}"]`).getAttribute('data-start'),'00:00');
  assert.equal(await calendar.locator(`[data-weekcol][data-date="2026-10-08"] [data-task-id="${saved.id}"] [data-resize-edge="end"]`).count(),0,'continuation edge cannot resize the real end');
  assert.equal(await calendar.locator(`[data-weekcol][data-date="2026-10-09"] [data-task-id="${saved.id}"] [data-resize-edge="end"]`).count(),1);

  // Open an imported row with the actual shared editor, then save a title-only edit.
  await h.page.evaluate(async id => {
    const S=await import('/src/store.js'), U=await import('/src/ui-utils.js');
    U.openEditDialog(document.querySelector('[data-view="calendar"] [data-task-dialog]'),S.getAllTasks().find(t=>t.id===id),S.getAllTags());
  },result.row.id);
  await dialog.locator('summary[data-event-details-title]').click();
  assert.equal(await dialog.locator('[data-event-organizer]').textContent(),'Owner');
  assert.ok((await dialog.locator('[data-event-attachments]').textContent()).includes('note.txt'));
  await dialog.locator('[name="title"]').fill('Metadata preserved');
  await dialog.locator('[name="endDate"]').fill('2026-10-30');
  await dialog.locator('[data-save]').click();
  assert.equal(await dialog.locator('[data-event-error]').isVisible(),true,'invalid dates keep form open');
  assert.equal(h.state().tasks.find(t=>t.id===result.row.id).title,'Overnight','invalid edit never writes');
  await dialog.locator('[name="endDate"]').fill('2026-11-02');
  await dialog.locator('[name="eventReminderSet"]').check();
  await dialog.locator('[name="eventReminderMinutesBeforeStart"]').fill('-1');
  await dialog.locator('[data-save]').click();
  assert.equal(await dialog.locator('[data-event-error]').isVisible(),true);
  await dialog.locator('[name="eventReminderMinutesBeforeStart"]').fill('25');
  await h.page.setViewportSize({width:800,height:900});
  const footerBox=await dialog.locator('footer').boundingBox();
  assert.ok(footerBox.y+footerBox.height <= h.page.viewportSize().height,'Save and cancel stay visible with expanded event details');
  if(process.env.TCPLUS_EVENT_SCREENSHOTS){
    fs.mkdirSync(process.env.TCPLUS_EVENT_SCREENSHOTS,{recursive:true});
    await h.page.screenshot({path:path.join(process.env.TCPLUS_EVENT_SCREENSHOTS,'event-details-light.png')});
    await h.page.setViewportSize({width:800,height:900});
    await h.page.evaluate(()=>document.documentElement.dataset.theme='dark');
    await h.page.screenshot({path:path.join(process.env.TCPLUS_EVENT_SCREENSHOTS,'event-details-dark.png')});
    fs.writeFileSync(path.join(process.env.TCPLUS_EVENT_SCREENSHOTS,'layout.json'), JSON.stringify(await dialog.evaluate(d=>Object.fromEntries([['dialog',d],['form',d.querySelector('form')],['header',d.querySelector('header')],['footer',d.querySelector('footer')]].map(([name,e])=>[name,{rect:e.getBoundingClientRect().toJSON(),height:getComputedStyle(e).height,overflow:getComputedStyle(e).overflow,scrollTop:e.scrollTop,display:getComputedStyle(e).display,flex:getComputedStyle(e).flex,scrollHeight:e.scrollHeight}]))),null,2));
  }
  await dialog.locator('[data-save]').click();
  await dialog.waitFor({state:'hidden'});
  const edited=h.state().tasks.find(t=>t.id===result.row.id);
  assert.equal(edited.startTime,'23:30:15');
  assert.equal(edited.outlookDetails.organizer,'Owner');
  assert.deepEqual(edited.outlookDetails.attachments,[{name:'note.txt',size:42,index:1}]);
  assert.equal(edited.outlookDetails.reminderMinutesBeforeStart,25);
  assert.deepEqual(h.pageErrors,[]);
  console.log('PASS: multi-day ranges, midnight boundary, daily totals, seconds and event editor');
} finally { await h.close(); }
