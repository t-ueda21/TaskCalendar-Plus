import { createMiniCalendarState, advancePicker, pickYear, pickMonth, movePicker, yearChoices } from './mini-calendar-state.js';
import { t as translate, getLocale } from './i18n.js';

export function setupPicker({ containerEl,monthLabelEl,prevBtn,nextBtn,onDateSelect,initialDate,getHolidaysInMonth,buildCells,formatDateKey,expanded,expand }) {
  let state = createMiniCalendarState(initialDate ?? new Date());
  let selected = formatDateKey(initialDate ?? new Date());
  const highlight = () => containerEl.querySelectorAll('[data-date]').forEach(node=>{node.classList.toggle('selected',node.dataset.date===selected);node.setAttribute('aria-pressed',String(node.dataset.date===selected));});
  function render() {
    const choosing = state.mode !== 'days';
    if (choosing && !containerEl.classList.contains('monthPicker')) { const height=containerEl.getBoundingClientRect().height; if(height>0)containerEl.style.setProperty('--mini-calendar-grid-height',`${height}px`); }
    containerEl.classList.toggle('monthPicker',choosing); containerEl.dataset.pickerMode=state.mode;
    containerEl.setAttribute('aria-label',translate(choosing ? state.mode==='years'?'calendar.chooseYear':'calendar.chooseMonth' : 'calendar.mini'));
    if (!choosing) { buildCells(containerEl,state.year,state.month,getHolidaysInMonth?.(state.year,state.month)??new Map(),onDateSelect); highlight(); }
    else {
      containerEl.replaceChildren();
      const values=state.mode==='years'?yearChoices(state):Array.from({length:12},(_,i)=>i);
      for(const [index,value] of values.entries()) {
        const button=document.createElement('button'); button.type='button'; button.className='miniMonth'; button.dataset.pickerIndex=String(index);
        if(state.mode==='years') { button.dataset.miniYear=String(value); button.textContent=String(value);button.setAttribute('aria-pressed',String(value===state.year)); }
        else {button.dataset.miniMonth=String(value);const date=new Date(2000,value,1);button.textContent=new Intl.DateTimeFormat(getLocale(),{month:'short'}).format(date);button.setAttribute('aria-pressed',String(value===state.month&&state.pickerYear===state.year));}
        button.addEventListener('click',()=>{state=state.mode==='years'?pickYear(state,value):pickMonth(state,value);render();monthLabelEl?.focus({preventScroll:true});});
        containerEl.appendChild(button);
      }
    }
    if(monthLabelEl) {
      monthLabelEl.textContent=state.mode==='years'?`${yearChoices(state)[0]}–${yearChoices(state).at(-1)}`:state.mode==='months'?String(state.pickerYear):new Intl.DateTimeFormat(getLocale(),{year:'numeric',month:'long'}).format(new Date(state.year,state.month,1));
      monthLabelEl.dataset.yearmonth=`${state.year}-${String(state.month+1).padStart(2,'0')}`;
      monthLabelEl.setAttribute('aria-expanded',String(choosing));monthLabelEl.title=translate(state.mode==='days'?'calendar.chooseMonth':state.mode==='months'?'calendar.chooseYear':'calendar.backToDates');
    }
    for(const [button,direction] of [[prevBtn,'previous'],[nextBtn,'next']]) {
      const label=translate(`calendar.${direction}.${state.mode}`);button?.setAttribute('aria-label',label);if(button)button.title=label;
      const text=button?.querySelector('[data-nav-label]');if(text)text.textContent=label;
    }
  }
  prevBtn?.addEventListener('click',()=>{state=movePicker(state,-1);render();});nextBtn?.addEventListener('click',()=>{state=movePicker(state,1);render();});
  let wheelDelta = 0, lastWheelAt = 0, lastWheelMoveAt = -Infinity;
  (containerEl.closest('.miniCalSticky') ?? containerEl).addEventListener('wheel', event => {
    if (event.ctrlKey || event.metaKey || !expanded()) return;
    event.preventDefault();
    const now = performance.now();
    if (now - lastWheelAt > 250) wheelDelta = 0;
    lastWheelAt = now;
    const delta = event.deltaY || event.deltaX;
    wheelDelta += delta * (event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? 120 : 1);
    if (Math.abs(wheelDelta) < 60 || now - lastWheelMoveAt < 160) return;
    state = movePicker(state, Math.sign(wheelDelta));
    wheelDelta = 0;
    lastWheelMoveAt = now;
    render();
  }, { passive: false });
  monthLabelEl?.addEventListener('click',()=>{state=expanded()?advancePicker(state):{...state,mode:'months'};expand(true);render();containerEl.querySelector('[aria-pressed="true"]')?.focus({preventScroll:true});});
  (containerEl.closest('.miniCalSticky')??containerEl).addEventListener('keydown',event=>{
    if(state.mode==='days') {
      const day=event.target.closest?.('[data-date]');if(!day)return;
      if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();day.click();return;}
      const [year,month,date]=day.dataset.date.split('-').map(Number);const next=new Date(0);next.setFullYear(year,month-1,date);next.setHours(0,0,0,0);
      const offsets={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7};
      if(event.key in offsets)next.setDate(next.getDate()+offsets[event.key]);
      else if(event.key==='Home')next.setDate(1);
      else if(event.key==='End')next.setMonth(next.getMonth()+1,0);
      else return;
      event.preventDefault();event.stopPropagation();
      if(next.getFullYear()!==state.year||next.getMonth()!==state.month){state=createMiniCalendarState(next);render();}
      containerEl.querySelector(`[data-date="${formatDateKey(next)}"]`)?.focus({preventScroll:true});
      return;
    }
    if(event.key==='Escape'){event.preventDefault();state={...state,mode:state.mode==='years'?'months':'days'};render();monthLabelEl?.focus({preventScroll:true});return;}
    const item=event.target.closest?.('[data-picker-index]');if(!item)return;
    if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();item.click();return;}
    const index=Number(item.dataset.pickerIndex),length=containerEl.querySelectorAll('[data-picker-index]').length;
    const next={ArrowLeft:index-1,ArrowRight:index+1,ArrowUp:index-4,ArrowDown:index+4,Home:0,End:length-1}[event.key];if(next===undefined)return;
    event.preventDefault();containerEl.querySelector(`[data-picker-index="${Math.max(0,Math.min(length-1,next))}"]`)?.focus({preventScroll:true});
  });
  render();
  return {highlightDate(dateKey){selected=dateKey;highlight();},navigateToMonth(year,month){state={...state,mode:'days',year,month,pickerYear:year};render();},refresh:render};
}
