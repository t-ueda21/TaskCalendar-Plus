export function createMiniCalendarState(date) { return { mode: 'days', year: date.getFullYear(), month: date.getMonth(), pickerYear: date.getFullYear() }; }
export function advancePicker(state) { return { ...state, mode: state.mode === 'days' ? 'months' : state.mode === 'months' ? 'years' : 'days', pickerYear: state.mode === 'days' ? state.year : state.pickerYear }; }
export function pickYear(state, year) { return { ...state, mode: 'months', pickerYear: Math.max(1,Math.min(9999,year)) }; }
export function pickMonth(state, month) { return { ...state, mode: 'days', year: state.pickerYear, month: Math.max(0,Math.min(11,month)) }; }
export function movePicker(state, direction) {
  if (state.mode !== 'days') return { ...state, pickerYear: Math.max(1,Math.min(9999,state.pickerYear + direction * (state.mode === 'years' ? 12 : 1))) };
  const date = new Date(0); date.setFullYear(state.year, state.month + direction, 1);
  return { ...state, year: date.getFullYear(), month: date.getMonth(), pickerYear: date.getFullYear() };
}
export function yearChoices(state) { const start = Math.max(1,Math.floor(state.pickerYear/12)*12); return Array.from({length:12},(_,index)=>start+index).filter(year=>year<=9999); }
