import {getLocale} from './i18n.js';
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
const label=(ja,en)=>getLocale()==='ja'?ja:en;
const field=(dialog,name)=>dialog.querySelector(`[name="native${name}"]`);
function panel(dialog) {
  let node=dialog.querySelector('[data-native-recurrence]');if(node)return node;
  const anchor=dialog.querySelector('[data-btn-group="repeat"]');if(!anchor)return null;
  node=document.createElement('details');node.dataset.nativeRecurrence='';
  node.innerHTML=`<summary>${label('繰り返しを詳しく設定','Advanced recurrence')}</summary>
    <label><input type="checkbox" name="nativeEnabled"> ${label('Outlook の定期予定として管理','Manage as an Outlook recurring series')}</label>
    <div data-native-fields style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:8px">
      <label>${label('種類','Pattern')} <select name="nativeType">${[[0,'日ごと','Daily'],[1,'週ごと','Weekly'],[2,'月ごと（日付）','Monthly by date'],[3,'月ごと（曜日）','Monthly nth day'],[5,'年ごと（日付）','Yearly by date'],[6,'年ごと（曜日）','Yearly nth day']].map(([n,ja,en])=>`<option value="${n}">${label(ja,en)}</option>`).join('')}</select></label>
      <label>${label('間隔（日／週／月／年）','Interval (days/weeks/months/years)')} <input name="nativeInterval" type="number" min="1" max="999" value="1"></label>
      <fieldset data-native-weekdays style="grid-column:1/-1"><legend>${label('曜日','Weekdays')}</legend>${['日','月','火','水','木','金','土'].map((ja,i)=>`<label><input type="checkbox" name="nativeWeekday" value="${1<<i}"> ${label(ja,['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][i])}</label>`).join('')}</fieldset>
      <label data-native-nth-days>${label('曜日の種類','Day group')} <select name="nativeNthDays">${[[1,'日曜日','Sunday'],[2,'月曜日','Monday'],[4,'火曜日','Tuesday'],[8,'水曜日','Wednesday'],[16,'木曜日','Thursday'],[32,'金曜日','Friday'],[64,'土曜日','Saturday'],[62,'平日','Weekday'],[65,'週末','Weekend day'],[127,'日','Day']].map(([n,ja,en])=>`<option value="${n}">${label(ja,en)}</option>`).join('')}</select></label>
      <label data-native-day>${label('日','Day')} <input name="nativeDay" type="number" min="1" max="31" value="1"></label>
      <label data-native-month>${label('月','Month')} <input name="nativeMonth" type="number" min="1" max="12" value="1"></label>
      <label data-native-instance>${label('順序','Instance')} <select name="nativeInstance">${[1,2,3,4,5].map(n=>`<option value="${n}">${n===5?label('最終','Last'):n}</option>`).join('')}</select></label>
      <label>${label('開始日','Pattern start')} <input name="nativeStart" type="date"></label>
      <label>${label('終了条件','End condition')} <select name="nativeEndMode"><option value="none">${label('終了なし','No end')}</option><option value="date">${label('日付まで','End date')}</option><option value="count">${label('回数','Occurrences')}</option></select></label>
      <label data-native-end-date>${label('終了日','End date')} <input name="nativeEnd" type="date"></label>
      <label data-native-end-count>${label('回数','Occurrences')} <input name="nativeCount" type="number" min="1" max="999" value="10"></label>
    </div><p data-native-rule-note>${label('変更する予定の範囲は、保存するときに選びます。','Choose which occurrences to change when saving.')}</p>`;
  const host=dialog.querySelector('[data-editor-advanced-rule]');
  if(host)host.append(node);else anchor.insertAdjacentElement('afterend',node);return node;
}
function sync(dialog){const enabled=field(dialog,'Enabled').checked;const kind=Number(field(dialog,'Type').value);const end=field(dialog,'EndMode').value;const node=panel(dialog);
  node.querySelector('[data-native-fields]').style.display=enabled?'grid':'none';
  for(const control of node.querySelectorAll('[data-native-fields] input,[data-native-fields] select'))control.disabled=!enabled;
  for(const [selector,show] of [['weekdays',kind===1],['nth-days',[3,6].includes(kind)],['day',[2,5].includes(kind)],['month',[5,6].includes(kind)],['instance',[3,6].includes(kind)],['end-date',end==='date'],['end-count',end==='count']]){const group=node.querySelector(`[data-native-${selector}]`);group.hidden=!show;for(const control of group.querySelectorAll('input,select'))control.disabled=!enabled||!show;}
}
export function wireNativeRecurrence(dialog){const node=panel(dialog);if(!node||node.dataset.wired)return;node.dataset.wired='true';node.addEventListener('change',()=>{dialog._recurrenceChanged=true;dialog._nativeRecurrenceChanged=true;sync(dialog);});}
export function populateNativeRecurrence(dialog,task={}){
  wireNativeRecurrence(dialog);if(!panel(dialog))return;
  const start=task.recurrence?.native?.patternStartDate||task.date||new Date().toISOString().slice(0,10);const d=new Date(`${start}T00:00:00Z`);
  const r=task.recurrence?.native||{recurrenceType:0,interval:1,dayOfWeekMask:1<<d.getUTCDay(),dayOfMonth:d.getUTCDate(),monthOfYear:d.getUTCMonth()+1,instance:1,patternStartDate:start,noEndDate:true};
  field(dialog,'Enabled').checked=Boolean(task.recurrence?.native);for(const [name,key] of [['Type','recurrenceType'],['Interval','interval'],['Day','dayOfMonth'],['Month','monthOfYear'],['Instance','instance'],['Start','patternStartDate'],['End','patternEndDate'],['Count','occurrences']])field(dialog,name).value=['Day','Month','Instance'].includes(name)?r[key]||1:r[key]??(name==='Count'?10:'');
  field(dialog,'EndMode').value=r.noEndDate?'none':r.occurrences!=null?'count':'date';
  if([5,6].includes(r.recurrenceType))field(dialog,'Interval').value=r.interval/12;
  field(dialog,'NthDays').value=[1,2,4,8,16,32,64,62,65,127].includes(r.dayOfWeekMask)?r.dayOfWeekMask:2;
  for(const input of dialog.querySelectorAll('[name="nativeWeekday"]'))input.checked=Boolean(r.dayOfWeekMask&Number(input.value));
  panel(dialog).open=Boolean(task.recurrence?.native);dialog._nativeRecurrenceChanged=false;sync(dialog);
}
export function readNativeRecurrence(dialog){
  if(!field(dialog,'Enabled')?.checked)return null;
  if(!dialog._nativeRecurrenceChanged&&dialog._originalRecurrence?.native)return structuredClone(dialog._originalRecurrence);
  const number=name=>Number(field(dialog,name).value);const mode=field(dialog,'EndMode').value;
  const native=normalizeNativeRule({recurrenceType:number('Type'),interval:number('Interval')*([5,6].includes(number('Type'))?12:1),dayOfWeekMask:[3,6].includes(number('Type'))?number('NthDays'):[...dialog.querySelectorAll('[name="nativeWeekday"]:checked')].reduce((mask,input)=>mask|Number(input.value),0),dayOfMonth:number('Day'),monthOfYear:number('Month'),instance:number('Instance'),patternStartDate:field(dialog,'Start').value,patternEndDate:mode==='date'?field(dialog,'End').value:null,occurrences:mode==='count'?number('Count'):null,noEndDate:mode==='none'});
  return {type:'native',native};
}
