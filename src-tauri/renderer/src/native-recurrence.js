const integer=(value,name,min,max)=>{if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${name}: ${min}–${max}`);return value;};
const date=(value,name)=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number(value.slice(0,4))<1601||Number(value.slice(0,4))>4500||new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value)throw new Error(`${name}: YYYY-MM-DD`);return value;};
export function normalizeNativeRule(value) {
  const r=structuredClone(value?.native||value);
  if(!r||![0,1,2,3,5,6].includes(r.recurrenceType))throw new Error('Invalid recurrence type');
  integer(r.interval,'Interval',1,999);
  if([5,6].includes(r.recurrenceType)&&r.interval%12!==0)throw new Error('Native yearly interval must be a multiple of 12 months');
  integer(r.dayOfWeekMask,'Day of week',0,127);integer(r.dayOfMonth,'Day of month',0,31);integer(r.monthOfYear,'Month',0,12);integer(r.instance,'Instance',0,5);
  if([1,3,6].includes(r.recurrenceType)&&r.dayOfWeekMask===0)throw new Error('Select weekdays');
  if([3,6].includes(r.recurrenceType)&&![1,2,4,8,16,32,64,62,65,127].includes(r.dayOfWeekMask))throw new Error('Select one weekday, weekdays, weekends or all days');
  if([2,5].includes(r.recurrenceType)&&r.dayOfMonth===0)throw new Error('Select day of month');
  if([3,6].includes(r.recurrenceType)&&r.instance===0)throw new Error('Select instance');
  if([5,6].includes(r.recurrenceType)&&r.monthOfYear===0)throw new Error('Select month');
  date(r.patternStartDate,'Start date');
  if(typeof r.noEndDate!=='boolean')throw new Error('Select end condition');
  if(r.patternEndDate!=null&&date(r.patternEndDate,'End date')<r.patternStartDate)throw new Error('End date precedes start');
  if(r.occurrences!=null)integer(r.occurrences,'Occurrences',1,999);
  if(r.noEndDate&&(r.occurrences!=null||r.patternEndDate!=null))throw new Error('No end cannot include an end condition');
  if(!r.noEndDate&&r.occurrences==null&&r.patternEndDate==null)throw new Error('Select end date or occurrences');
  return r;
}
