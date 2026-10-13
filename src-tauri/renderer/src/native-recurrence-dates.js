import { normalizeNativeRule } from './native-recurrence.js';

const key = date => date.toISOString().slice(0,10);
const parse = value => new Date(`${value}T00:00:00Z`);
const day = date => date.getTime() / 86400000;

/** Local previews are finite; Outlook remains the authority for the native series. */
export function expandNativeDates(value, {from = value.patternStartDate, horizonDays = 365} = {}) {
  const rule = normalizeNativeRule(value);
  const start = parse(rule.patternStartDate);
  const cutoff = parse(from);
  cutoff.setUTCDate(cutoff.getUTCDate() + Math.min(365,Math.max(0,horizonDays)));
  const until = rule.patternEndDate && !rule.noEndDate ? parse(rule.patternEndDate) : cutoff;
  const end = new Date(Math.min(cutoff.getTime(),until.getTime()));
  const matchesDay = date => Boolean(rule.dayOfWeekMask & (1 << date.getUTCDay()));
  const monthCandidates = new Map();
  const nthDay = date => {
    const month = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
    if (!monthCandidates.has(month)) {
      const dates=[];
      for (let d=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1)); d.getUTCMonth()===date.getUTCMonth(); d.setUTCDate(d.getUTCDate()+1)) if(matchesDay(d)) dates.push(d.getUTCDate());
      monthCandidates.set(month,rule.instance===5?dates.at(-1):dates[rule.instance-1]);
    }
    return date.getUTCDate() === monthCandidates.get(month);
  };
  const dates=[];
  let count=0;
  for (let date=new Date(start);date<=end;date.setUTCDate(date.getUTCDate()+1)) {
    const months=(date.getUTCFullYear()-start.getUTCFullYear())*12 + date.getUTCMonth()-start.getUTCMonth();
    const years=date.getUTCFullYear()-start.getUTCFullYear();
    const lastDay=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();
    let matches=false;
    switch(rule.recurrenceType){
      case 0: matches=(day(date)-day(start))%rule.interval===0;break;
      case 1: matches=Math.floor((day(date)-day(start)+start.getUTCDay())/7)%rule.interval===0&&matchesDay(date);break;
      case 2: matches=months%rule.interval===0&&date.getUTCDate()===Math.min(rule.dayOfMonth,lastDay);break;
      case 3: matches=months%rule.interval===0&&nthDay(date);break;
      case 5: matches=years%(rule.interval/12)===0&&date.getUTCMonth()+1===rule.monthOfYear&&date.getUTCDate()===Math.min(rule.dayOfMonth,lastDay);break;
      case 6: matches=years%(rule.interval/12)===0&&date.getUTCMonth()+1===rule.monthOfYear&&nthDay(date);break;
    }
    if(!matches)continue;
    count++;
    if(key(date)>=from)dates.push(key(date));
    if(!rule.noEndDate&&rule.occurrences!=null&&count>=rule.occurrences)break;
  }
  return dates;
}
