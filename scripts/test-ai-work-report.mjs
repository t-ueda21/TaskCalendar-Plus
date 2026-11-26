import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildSummary} from '../src-tauri/renderer/src/summary-model.js';
for(const fixture of JSON.parse(fs.readFileSync('scripts/fixtures/ai-work-reports.json','utf8'))){
 const tasks=fixture.tasks.map(task=>({...task,isAllDay:task.isAllDay===true}));
 const report=buildSummary({...fixture,today:fixture.dateTo,includeFuture:true,getTasksByDate:day=>tasks.filter(task=>task.date<=day&&(task.endDate||task.date)>=day)});
 assert.equal(Math.round(report.total),fixture.expected.totalMinutes,fixture.name);
 assert.equal(Math.round(report.overtime),fixture.expected.overtimeMinutes,fixture.name);
 assert.equal(Math.round(report.total*60),fixture.expected.totalSeconds,fixture.name);
 assert.equal(Math.round(report.overtime*60),fixture.expected.overtimeSeconds,fixture.name);
}
console.log('PASS: renderer and AI share hand-checked work-report fixtures');
