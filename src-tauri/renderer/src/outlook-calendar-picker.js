import {t as translate} from './i18n.js';
const MANUAL='__manual_calendar__';
const states=new WeakMap();
export function calendarSelectionLabel(value) {
  if(!value.startsWith('outlook-folder:'))return value;
  try {return JSON.parse(value.slice('outlook-folder:'.length)).label || translate('outlook.savedCalendar');}
  catch{return translate('outlook.savedCalendar');}
}
function render(panel,calendars,manualMode=false) {
  const current=panel.input.value.trim()||'Calendar';
  const options=[new Option(translate('outlook.defaultCalendar'),'Calendar')];
  for(const calendar of calendars)options.push(new Option(calendar.label,calendar.id));
  if(current!=='Calendar'&&!calendars.some(row=>row.id===current))options.push(new Option(translate('ui.c8460b00f6',{p0:calendarSelectionLabel(current)}),current));
  options.push(new Option(translate('ui.bf899282fe'),MANUAL));
  panel.select.replaceChildren(...options);panel.select.value=manualMode?MANUAL:current;
  panel.input.hidden=!manualMode;
}
function stateFor(dialog) {
  if(states.has(dialog))return states.get(dialog);
  const state={panels:[],calendars:[],loaded:false,active:null};
  for(const element of dialog.querySelectorAll('[data-outlook-calendar-picker]')) {
    const panel={select:element.querySelector('select'),input:element.querySelector('input'),refresh:element.querySelector('[data-calendar-refresh]'),status:element.querySelector('[data-calendar-status]')};
    panel.select.addEventListener('change',()=>{
      const manual=panel.select.value===MANUAL;
      if(manual&&panel.input.value.startsWith('outlook-folder:'))panel.input.value='';
      if(!manual)panel.input.value=panel.select.value;
      panel.input.hidden=!manual;
      if(manual)panel.input.focus();
    });
    panel.refresh.addEventListener('click',()=>{void loadOutlookCalendars(dialog,true);});
    state.panels.push(panel);
  }
  dialog.addEventListener('close',()=>invalidate(state));
  states.set(dialog,state);return state;
}
function invalidate(state) {
  state.active?.abort();state.active=null;
  state.panels.forEach(panel=>{panel.refresh.disabled=false;panel.status.textContent='';});
}
export function populateOutlookCalendars(dialog) {
  const state=stateFor(dialog);invalidate(state);
  state.panels.forEach(panel=>render(panel,state.calendars));
}
export async function loadOutlookCalendars(dialog,force=false) {
  const state=stateFor(dialog);
  if(!state.panels.length||state.active||(state.loaded&&!force))return;
  const controller=new AbortController();state.active=controller;
  state.panels.forEach(panel=>{panel.refresh.disabled=true;panel.status.textContent=translate('ui.80b28e7645');});
  const timer=setTimeout(()=>controller.abort(),32000);
  try {
    const response=await fetch('/api/outlook/calendars',{signal:controller.signal});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||translate('outlook.failed'));
    if(!Array.isArray(data.calendars))throw new Error(translate('outlook.invalidCalendars'));
    if(state.active!==controller||controller.signal.aborted)return;
    state.calendars=data.calendars.filter(row=>typeof row.id==='string'&&row.id&&typeof row.label==='string'&&row.label);
    state.loaded=true;
    for(const panel of state.panels) {
      render(panel,state.calendars,panel.select.value===MANUAL);
      panel.status.textContent=state.calendars.length?translate('outlook.calendarCount',{count:state.calendars.length}):translate('outlook.noCalendars');
      if(data.warnings?.length)panel.status.textContent+=' '+translate('outlook.partialCalendars')+' '+data.warnings.slice(0,3).join(' / ');
    }
  }catch(error) {
    if(state.active!==controller)return;
    const message=controller.signal.aborted?translate('outlook.calendarTimeout'):String(error.message??error);
    state.panels.forEach(panel=>{panel.status.textContent=message;});
  }finally {
    clearTimeout(timer);
    if(state.active===controller){state.active=null;state.panels.forEach(panel=>{panel.refresh.disabled=false;});}
  }
}
