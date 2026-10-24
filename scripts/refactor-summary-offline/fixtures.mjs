// Synthetic-only inputs. This module does not import product or environment modules.
export const numericValues = [0, -0, 1, -1, 1.04, 1.05, 1.25, -1.25, 59.49, 59.5, 999.95, 1000, 1234567.89, NaN, Infinity, -Infinity, null, undefined, '12.5', 'bad'];
export const minuteValues = [undefined, null, false, '', 0, -0, -.6, -1, -60, .49, .5, 59.49, 59.5, 60, 60.5, 119.5, 1440, 9999999, NaN, Infinity, -Infinity, '60.5', 'bad'];
export const dateValues = ['0001-01-01', '0099-12-31', '1900-02-28', '2000-02-29', '2024-02-29', '2026-01-01', '2026-10-08', '2026-12-31', '9999-12-31', '2026-01', '2026-12'];
export const dateOptions = [undefined, {year:'numeric'}, {year:'numeric',month:'short'}, {year:'numeric',month:'long'}, {month:'numeric',day:'numeric',weekday:'short'}, {month:'short'}, {weekday:'short'}, {timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}];
export const renderScenarios = [
  {id:'month-recorded', period:'month', total:540.5, tagCount:4},
  {id:'month-business-selected', period:'month', total:540.5, tagCount:12, selected:['tag-0','tag-1','tag-2','tag-3','tag-4'], averageBase:'business', tagPage:1, selectedKey:'2026-10-05'},
  {id:'month-empty', period:'month', total:0, tagCount:0, selected:[], comparison:null},
  {id:'month-future', period:'month', total:59.5, tagCount:11, includeFuture:true, tagPage:999, selectedKey:'invalid', comparisonKind:'businessDays', delta:-60.5},
  {id:'year-recorded', period:'year', total:123456.5, tagCount:4, selectedKey:'2026-09'},
  {id:'year-future-selected', period:'year', total:1250.5, tagCount:12, selected:['tag-0'], includeFuture:true, tagPage:-4, averageBase:'business', comparisonKind:'year'},
  {id:'minimum-date', period:'month', year:1, month:1, today:'0001-01-01', total:0, tagCount:0},
  {id:'maximum-date', period:'year', year:9999, month:12, today:'9999-12-31', total:1440, tagCount:1},
  {id:'focus-restore', period:'month', total:61, tagCount:2, focusKey:'2026-10-05', selectedKey:'2026-10-05'},
];
export function renderFixture(spec) {
  const year=spec.year??2026, month=spec.month??10, yearText=String(year).padStart(4,'0');
  const prefix=`${yearText}-${String(month).padStart(2,'0')}`, today=spec.today??'2026-10-08';
  const monthly=spec.period==='month';
  const count=monthly ? [31,28,31,30,31,30,31,31,30,31,30,31][month-1] : 12;
  const groups=Array.from({length:count},(_,i)=>{
    const key=monthly ? `${prefix}-${String(i+1).padStart(2,'0')}` : `${yearText}-${String(i+1).padStart(2,'0')}`;
    const active=spec.includeFuture || key<=(monthly?today:today.slice(0,7));
    const total=active && (i===4 || i===7 || i===0) ? spec.total*(i===4?1:.5) : 0;
    return {key,active,total,overtime:total/6,overlap:total/12,normalByTag:new Map([['tag-0',total/2],['tag-1',total/4]])};
  });
  const tags=Array.from({length:spec.tagCount},(_,i)=>({id:`tag-${i}`,name:i===0?'設計 <&\"\'タグ>':`Tag ${i+1}`,color:i%2?'#825':'#0072BC',total:spec.total/(i+1),overtime:0,count:i+1}));
  const total=groups.reduce((sum,row)=>sum+row.total,0);
  const longestDay=groups.find(group=>group.total>0);
  const model={period:spec.period,year,month,today,includeFuture:!!spec.includeFuture,
    start:monthly?`${prefix}-01`:`${yearText}-01-01`,end:monthly?`${prefix}-${count}`:`${yearText}-12-31`,cutoff:spec.includeFuture?(monthly?`${prefix}-${count}`:`${yearText}-12-31`):today,
    groups,tags,total,overtime:total/6,overlap:total/12,registeredDays:groups.filter(row=>row.total>0).length,businessDays:total?6:0,overtimeDays:total?3:0,count:total?10:0,
    selectedTagIds:spec.selected??null,longestDay:longestDay?{...longestDay,key:monthly?longestDay.key:`${longestDay.key}-01`}:null,
    comparison:spec.comparison===null||!total?null:{kind:spec.comparisonKind??'month',businessDays:6,delta:spec.delta??60.5}};
  const state={selectedKey:spec.selectedKey??null,tagPage:spec.tagPage??0,includeFuture:!!spec.includeFuture,preferences:{metrics:['total','average','overtime','days','overtimeDays','longest'],averageBase:spec.averageBase??'recorded'}};
  return {model,state};
}
