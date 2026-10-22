import assert from 'node:assert/strict';
const module = await import('../src-tauri/renderer/src/summary-model.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
assert.equal(typeof module.buildSummary, 'function', 'summary aggregation must be available');
const { buildSummary, periodDates, todayInJst } = module;
const settings = { workStart:'09:00', workEnd:'18:00', breaks:[{start:'12:00',end:'13:00',countAsWork:false}], workWeekDays:['Mon','Tue','Wed','Thu','Fri'], companyHolidayEntries:[] };
const tags = [{id:'a',name:'設計',color:'#0072bc'},{id:'b',name:'会議',color:'#8259aa'}];
const task = (id,startTime,endTime,extra={}) => ({id,date:'2026-10-08',tagId:'a',startTime,endTime,isAllDay:false,...extra});
function build(tasks=[],extra={}) {
  const calls=[];
  const options={period:'month',year:2026,month:10,today:'2026-10-08',includeFuture:false,selectedTagIds:null,tags,settings,
    getTasksByDate:day=>{calls.push(day);return tasks.filter(row=>row.date<=day&&(row.endDate||row.date)>=day)},...extra};
  const input=JSON.stringify({tasks,settings:options.settings,tags:options.tags});
  const result=buildSummary(options);
  assert.equal(JSON.stringify({tasks,settings:options.settings,tags:options.tags}),input,'aggregation must not mutate source data');
  for(const group of [...result.days,...result.groups]) {
    const stack=[...group.normalByTag.values()].reduce((a,b)=>a+b,0)+group.overlap+group.overtime;
    assert.ok(Math.abs(stack-group.total)<1e-8,`stack must equal total for ${group.key}`);
  }
  assert.equal(new Set(calls).size,calls.length,'each date is loaded once per aggregation');
  return result;
}
const core = value => ({total:value.total,overtime:value.overtime,count:value.count});

let result=build();
assert.deepEqual(core(result),{total:0,overtime:0,count:0});
assert.equal(result.registeredDays,0);assert.equal(result.businessDays,6);
assert.equal(result.days.length,31);assert.equal(result.groups.length,31);assert.equal(result.comparison,null);
assert.equal(result.days.find(d=>d.key==='2026-10-09').active,false);
console.log('PASS: empty periods, calendar-day display, cutoff and zero averages');

result=build([task('work','08:00','19:00'),task('tagless','00:00','24:00',{tagId:''}),task('orphan','00:00','24:00',{tagId:'removed'}),task('all-day',null,null,{isAllDay:true}),task('invalid','broken','10:00'),task('break-only','12:00','13:00')]);
assert.deepEqual(core(result),{total:600,overtime:120,count:1});
assert.equal(result.registeredDays,1);assert.equal(result.overtimeDays,1);assert.equal(result.longestDay.key,'2026-10-08');
assert.deepEqual(core(result.tags.find(t=>t.id==='a')),{total:600,overtime:120,count:1});
console.log('PASS: work-window boundaries, unpaid breaks and excluded rows');

const overlapping=[task('a1','09:00','11:00'),task('a2','09:30','10:30'),task('b1','10:00','12:00',{tagId:'b'})];
result=build(overlapping,{selectedTagIds:['a','b']});
assert.deepEqual(core(result),{total:180,overtime:0,count:3});
const day=result.days.find(d=>d.key==='2026-10-08');
assert.equal(day.overlap,60);assert.equal(day.normalByTag.get('a'),60);assert.equal(day.normalByTag.get('b'),60);
assert.equal(result.tags.find(t=>t.id==='a').total,120);assert.equal(result.tags.find(t=>t.id==='b').total,120);
assert.deepEqual(core(build(overlapping,{selectedTagIds:['a']})),{total:120,overtime:0,count:2});
assert.deepEqual(core(build(overlapping,{selectedTagIds:[]})),{total:0,overtime:0,count:0});
assert.deepEqual(core(build(overlapping,{selectedTagIds:['removed']})),{total:0,overtime:0,count:0});
console.log('PASS: selected-tag union, same-tag deduplication, cross-tag overlap and empty selection');

result=build([task('a','08:00','10:00'),task('b','08:30','09:30',{tagId:'b'})],{selectedTagIds:['a','b']});
assert.deepEqual(core(result),{total:120,overtime:60,count:2});
assert.equal(result.days.find(d=>d.total).overlap,30,'overtime overlaps must not also be counted as normal overlap');
assert.equal(build([task('long','08:00','19:00')],{settings:{...settings,breaks:[{start:'18:00',end:'18:30',countAsWork:false}]}}).overtime,90);
assert.equal(build([task('long','08:00','19:00')],{settings:{...settings,breaks:[{start:'12:00',end:'13:00',countAsWork:true}]}}).total,660);

const overnight=[task('overnight','23:00','01:00',{date:'2026-01-31',endDate:'2026-02-01'})];
assert.deepEqual(core(build(overnight,{year:2026,month:1,today:'2026-02-02'})),{total:60,overtime:60,count:1});
assert.deepEqual(core(build(overnight,{year:2026,month:2,today:'2026-02-02'})),{total:60,overtime:60,count:1});
result=build(overnight,{period:'year',year:2026,today:'2026-02-02'});
assert.deepEqual(core(result),{total:120,overtime:120,count:1});assert.equal(result.registeredDays,2);assert.equal(result.groups.length,12);
assert.equal(result.groups[0].count,1);assert.equal(result.groups[1].count,1);
assert.equal(build([task('midnight','23:00','00:00',{date:'2026-01-31',endDate:'2026-02-01'})],{month:2,today:'2026-02-02'}).total,0);
console.log('PASS: midnight splitting, month/year boundaries and unique work-event counts');

assert.equal(periodDates('month',2024,2).length,29);assert.equal(periodDates('year',2024,1).length,366);
assert.equal(periodDates('month',2025,2).length,28);
assert.equal(todayInJst(new Date('2026-10-08T15:00:00Z')),'2026-10-09');
assert.equal(todayInJst(new Date('2026-10-08T14:59:59Z')),'2026-10-08');
assert.throws(()=>periodDates('all',2026,10));assert.throws(()=>periodDates('month',2026,13));
assert.equal(build([],{includeFuture:true}).businessDays,21,'Japanese public holiday must be excluded');
assert.equal(build([],{includeFuture:true,settings:{...settings,companyHolidayEntries:[{dateKey:'--10-02',name:'会社休日'}]}}).businessDays,20);
assert.equal(build([],{includeFuture:true,settings:{...settings,workWeekDays:['Sat']}}).businessDays,5);
assert.equal(build([task('holiday','08:00','10:00',{date:'2026-10-12'})],{includeFuture:true}).overtime,60);
console.log('PASS: leap years, JST rollover, Japanese/company holidays and configured workweek');

const future=[task('now','09:00','10:00'),task('future','09:00','11:00',{date:'2026-10-09'})];
assert.equal(build(future).total,60);assert.equal(build(future,{includeFuture:true}).total,180);
assert.equal(build(future,{month:11}).total,0);
const compareRows=[task('now','09:00','11:00'),task('before','09:00','10:00',{date:'2026-09-08'}),task('too-late','09:00','18:00',{date:'2026-09-09'})];
result=build(compareRows);
assert.equal(result.comparison.kind,'businessDays');assert.equal(result.comparison.end,'2026-09-08');assert.equal(result.comparison.businessDays,6);assert.equal(result.comparison.delta,60);
assert.equal(build(compareRows,{includeFuture:true}).comparison.end,'2026-09-30');
const leapCompare=build([task('old','09:00','10:00',{date:'2023-02-28'}),task('new','09:00','11:00',{date:'2024-02-29'})],{period:'year',year:2024,today:'2024-02-29'});
assert.equal(leapCompare.comparison.end,'2023-02-28');assert.equal(leapCompare.comparison.delta,60);
console.log('PASS: future inclusion and fair previous-period cutoffs');

result=build([task('s1','09:00:30','09:01:00'),task('s2','09:00:45','09:01:30',{tagId:'b'})]);
assert.equal(result.total,1);assert.equal(result.days.find(d=>d.total).overlap,.25);
const abutting=build([task('a','09:00','10:00'),task('b','10:00','11:00',{tagId:'b'})]);
assert.equal(abutting.total,120);assert.equal(abutting.overlap,0);
assert.throws(()=>build([],{settings:{...settings,workStart:'18:00',workEnd:'09:00'}}),/work window/);
const many=Array.from({length:1000},(_,i)=>task('large-'+i,'09:00','10:00',{tagId:i%2?'a':'b'}));
assert.deepEqual(core(build(many,{period:'year'})),{total:60,overtime:0,count:1000});
console.log('PASS: fractional minutes, larger overlaps and immutable input');
