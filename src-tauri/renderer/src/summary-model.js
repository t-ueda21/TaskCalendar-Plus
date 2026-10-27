import { clockMinutes, eventDaySegment } from './event-fields.js';
import { summarizeIntervals, summarizeWork, workIntervals } from './work-time.js';
import { getHolidayName } from './holidays.js';
import { getCompanyHolidayNameForDate } from './company-holidays.js';

const WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const pad = number => String(number).padStart(2, '0');
const dateKey = (year, month, day) => `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
const monthDays = (year, month) => [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31,30,31,30,31,31,30,31,30,31][month - 1];

export function todayInJst(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en', { timeZone:'Asia/Tokyo', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(now);
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function periodDates(period, year, month) {
  if (!['month','year'].includes(period) || !Number.isInteger(year) || year < 1 || year > 9999
      || !Number.isInteger(month) || month < 1 || month > 12) throw new RangeError('Invalid summary period');
  const months = period === 'year' ? Array.from({length:12}, (_, index) => index + 1) : [month];
  return months.flatMap(value => Array.from({length:monthDays(year, value)}, (_, index) => dateKey(year, value, index + 1)));
}

function combine(rows, key) {
  const result = { key, total:0, overtime:0, overlap:0, count:0, normalByTag:new Map(), ids:new Set(), active:false };
  for (const row of rows) {
    result.total += row.total;
    result.overtime += row.overtime;
    result.overlap += row.overlap;
    result.active ||= row.active;
    row.ids.forEach(id => result.ids.add(id));
    row.normalByTag.forEach((minutes, id) => result.normalByTag.set(id, (result.normalByTag.get(id) || 0) + minutes));
  }
  result.count = result.ids.size;
  return result;
}

// Exclusive tag slices + normal-time overlap + overtime = the selected union.
// Overlap is shown explicitly rather than assigning it to an arbitrary tag.
function chartParts(byTag, start, end) {
  const changes = new Map([[start,new Map()],[end,new Map()]]);
  const add = (at, id, delta) => {
    if (!changes.has(at)) changes.set(at, new Map());
    const row = changes.get(at);
    row.set(id, (row.get(id) || 0) + delta);
  };
  byTag.forEach((intervals,id) => intervals.forEach(([from,to]) => { add(from,id,1); add(to,id,-1); }));
  const ordered = [...changes.keys()].sort((a, b) => a - b);
  const normalByTag = new Map([...byTag.keys()].map(id => [id, 0]));
  const active = new Set();
  let overlap = 0;
  for (let index = 1; index < ordered.length; index++) {
    const from = ordered[index - 1], to = ordered[index];
    changes.get(from).forEach((delta,id) => { if (delta > 0) active.add(id); else if (delta < 0) active.delete(id); });
    if (to <= start || from >= end) continue;
    if (active.size === 1) {
      const id = active.values().next().value;
      normalByTag.set(id, normalByTag.get(id) + to - from);
    } else if (active.size > 1) overlap += to - from;
  }
  return { normalByTag, overlap };
}

/** Read-only aggregation over Store's materialized, indexed occurrences. */
export function buildSummary({ period, year, month, today = todayInJst(), includeFuture = false,
  selectedTagIds = null, tags, settings, getTasksByDate }) {
  const dates = periodDates(period, year, month);
  const start = dates[0], end = dates.at(-1), cutoff = includeFuture || end < today ? end : today;
  const known = new Set(tags.map(tag => String(tag.id)));
  const selected = selectedTagIds === null ? known : new Set(selectedTagIds.filter(id => known.has(id)));
  const workStart = Number.isFinite(clockMinutes(settings.workStart)) ? clockMinutes(settings.workStart) : 540;
  const workEnd = Number.isFinite(clockMinutes(settings.workEnd)) ? clockMinutes(settings.workEnd) : 1080;
  if (workEnd <= workStart) throw new RangeError('Invalid work window');
  const workweek = new Set(settings.workWeekDays?.length ? settings.workWeekDays : WEEKDAYS.slice(1, 6));
  const businessCache = new Map(), dayCache = new Map();
  const business = key => {
    if (!businessCache.has(key)) businessCache.set(key, workweek.has(WEEKDAYS[new Date(`${key}T00:00:00Z`).getUTCDay()])
      && !getHolidayName(key) && !getCompanyHolidayNameForDate(key, settings.companyHolidayEntries));
    return businessCache.get(key);
  };

  function loadDay(key) {
    if (dayCache.has(key)) return dayCache.get(key);
    const tasks = new Map();
    for (const task of getTasksByDate(key)) {
      const id = String(task.tagId ?? '').trim();
      if (!known.has(id) || task.isAllDay || !task.id) continue;
      const segment = eventDaySegment(task, key);
      if (!segment || !workIntervals([segment], settings).length) continue;
      if (!tasks.has(id)) tasks.set(id, []);
      tasks.get(id).push(segment);
    }
    const byTag = new Map([...tasks].map(([id, rows]) => {
      const intervals = workIntervals(rows, settings);
      return [id, { ...summarizeIntervals(intervals, settings), intervals, ids:new Set(rows.map(row => row.id)) }];
    }));
    const selectedRows = [...tasks].filter(([id]) => selected.has(id)).flatMap(([, rows]) => rows);
    const intervals = new Map([...byTag].filter(([id]) => selected.has(id)).map(([id, row]) => [id, row.intervals]));
    const ids = new Set(selectedRows.map(row => row.id));
    const result = { key, active:true, business:business(key), ...summarizeWork(selectedRows, settings),
      ...chartParts(intervals, workStart, workEnd), ids, count:ids.size, byTag };
    dayCache.set(key, result);
    return result;
  }

  const days = dates.map(key => key <= cutoff ? loadDay(key) : {
    ...combine([], key), active:false, business:business(key), byTag:new Map(),
  });
  const total = combine(days);
  const registeredDays = days.filter(day => day.total > 0).length;
  const businessDays = days.filter(day => day.active && day.business).length;
  const longestDay = days.reduce((longest, day) => day.total > (longest?.total || 0) ? day : longest, null);
  const groups = period === 'month' ? days : Array.from({length:12}, (_, index) => {
    const key = `${String(year).padStart(4, '0')}-${pad(index + 1)}`;
    return combine(days.filter(day => day.key.startsWith(key)), key);
  });
  const tagTotals = tags.map(tag => {
    let total = 0, overtime = 0;
    const ids = new Set();
    for (const day of days) {
      const value = day.byTag.get(tag.id);
      if (!value) continue;
      total += value.total; overtime += value.overtime;
      value.ids.forEach(id => ids.add(id));
    }
    return { ...tag, total, overtime, count:ids.size };
  });

  // Year view uses the same month that initially opens in its settings dialog.
  const orderMonth = `${String(year).padStart(4, '0')}-${pad(month)}`;
  const tagOrder = settings.monthTagOrders?.[orderMonth];
  if (Array.isArray(tagOrder) && tagOrder.length) {
    const ranks = new Map();
    tagOrder.forEach((id, index) => { if (!ranks.has(id)) ranks.set(id, index); });
    tagTotals.sort((a, b) => (ranks.get(a.id) ?? tagOrder.length) - (ranks.get(b.id) ?? tagOrder.length));
  }

  let comparison = null;
  if (start <= cutoff) {
    let previousYear = year, previousMonth = month, kind = 'month';
    if (period === 'month') {
      previousMonth--;
      if (previousMonth === 0) { previousMonth = 12; previousYear--; }
    } else { previousYear--; kind = 'year'; }
    if (previousYear >= 1) {
      const previousDates = periodDates(period, previousYear, previousMonth);
      let comparisonEnd = previousDates.at(-1);
      if (!includeFuture && year === Number(today.slice(0, 4))) {
        if (period === 'month' && month === Number(today.slice(5, 7))) {
          const previousBusinessDays = previousDates.filter(business);
          // A shorter previous month cannot provide the requested elapsed workday count.
          comparisonEnd = businessDays > 0 ? previousBusinessDays[businessDays - 1] : null;
          kind = 'businessDays';
        } else if (period === 'year') {
          const previousDay = Math.min(Number(today.slice(8)), monthDays(previousYear, Number(today.slice(5, 7))));
          comparisonEnd = dateKey(previousYear, Number(today.slice(5, 7)), previousDay);
        }
      }
      if (comparisonEnd) {
        const previous = combine(previousDates.filter(key => key <= comparisonEnd).map(loadDay));
        if (previous.count) comparison = { kind, start:previousDates[0], end:comparisonEnd,
          businessDays:kind === 'businessDays' ? businessDays : null, total:previous.total, delta:total.total - previous.total };
      }
    }
  }
  return { period, year, month, start, end, cutoff, today, includeFuture,
    days, groups, tags:tagTotals, total:total.total, overtime:total.overtime, count:total.count,
    overlap:total.overlap, registeredDays, businessDays, overtimeDays:days.filter(day => day.overtime > 0).length,
    longestDay, comparison, selectedTagIds:selectedTagIds === null ? null : [...selected] };
}
