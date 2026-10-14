import { t } from './i18n.js';

export function clockMinutes(value) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$|^24:00(?::00)?$/.test(String(value))) return NaN;
  const [h, m, s = 0] = value.split(':').map(Number);
  return h * 60 + m + s / 60;
}
const dayNumber = value => Date.parse(`${value}T00:00:00Z`) / 86400000;
export const shiftEventDate = (value, days) => new Date((dayNumber(value) + days) * 86400000).toISOString().slice(0, 10);

export function validateEventRange(task) {
  const start = dayNumber(task.date), end = dayNumber(task.endDate || task.date);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 'event.invalidRange';
  if (task.isAllDay) return '';
  const s = clockMinutes(task.startTime), e = clockMinutes(task.endTime);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s >= 1440) return 'event.invalidTime';
  return (end - start) * 1440 + e > s ? '' : 'event.invalidRange';
}

/** All-day endDate is inclusive; timed endDate carries the end clock (exclusive). */
export function eventDaySegment(task, dateKey) {
  if (dateKey < task.date || dateKey > (task.endDate || task.date)) return null;
  if (task.isAllDay) return { ...task, date: dateKey, endDate: dateKey };
  const startTime = dateKey === task.date ? task.startTime : '00:00';
  const endTime = dateKey === (task.endDate || task.date) ? task.endTime : '24:00';
  return clockMinutes(endTime) > clockMinutes(startTime)
    ? { ...task, date: dateKey, endDate: dateKey, startTime, endTime } : null;
}

export function eventDateKeys(task) {
  const days = [];
  const end = task.endDate || task.date;
  if (!Number.isFinite(dayNumber(task.date)) || !Number.isFinite(dayNumber(end))) return days;
  for (let date = task.date; date <= end; date = shiftEventDate(date, 1)) {
    if (eventDaySegment(task, date)) days.push(date);
  }
  return days;
}

function clockText(minutes, seconds = false) {
  const total = Math.round(minutes * 60);
  return `${String(Math.floor(total / 3600)).padStart(2,'0')}:${String(Math.floor(total / 60) % 60).padStart(2,'0')}${seconds ? `:${String(total % 60).padStart(2,'0')}` : ''}`;
}

export function moveEventRange(task, sourceDate, targetDate, segmentStartMinutes) {
  const segment = eventDaySegment(task, sourceDate);
  if (!segment) return null;
  const delta = (dayNumber(targetDate) - dayNumber(sourceDate)) * 1440 + segmentStartMinutes - Math.floor(clockMinutes(segment.startTime));
  const shift = (date, clock) => {
    const minutes = clockMinutes(clock) + delta;
    const days = Math.floor(minutes / 1440);
    return [shiftEventDate(date, days), clockText(minutes - days * 1440, clock.split(':').length === 3)];
  };
  const [date,startTime] = shift(task.date,task.startTime);
  const [endDate,endTime] = shift(task.endDate || task.date,task.endTime);
  return {date,endDate,startTime,endTime};
}

export function resizeEventRange(task, dateKey, edge, minutes) {
  const dates = eventDateKeys(task);
  if (edge === 'start' && dates[0] !== dateKey || edge === 'end' && dates.at(-1) !== dateKey) return null;
  const time = clockText(Math.min(1440,Math.max(0,minutes)));
  const patch = edge === 'start' ? {startTime:time} : {endDate:dateKey,endTime:time};
  return validateEventRange({...task,...patch}) ? null : patch;
}

const defaults = {location:'',busyStatus:2,sensitivity:0,importance:1,categories:'',reminderSet:false,reminderMinutesBeforeStart:15,startTimeZone:'',endTimeZone:''};
const fields = Object.keys(defaults);
const fieldName = key => `event${key[0].toUpperCase()}${key.slice(1)}`;
export function populateEventFields(dialog, task = {}) {
  const error = dialog.querySelector("[data-event-error]");
  if (error) { error.textContent = ""; error.hidden = true; }
  dialog._eventDetails = structuredClone(task.outlookDetails || {});
  dialog._eventOriginal = task;
  const endDate = dialog.querySelector('[name="endDate"]');
  if (endDate) endDate.value = task.endDate || task.date || dialog.querySelector('[name="date"]')?.value || '';
  for (const key of fields) {
    const input = dialog.querySelector(`[name="${fieldName(key)}"]`);
    if (!input) continue;
    const value = task.outlookDetails?.[key] ?? defaults[key];
    if (key === 'reminderSet') input.checked = value;
    else input.value = value;
  }
  for (const key of ['organizer','attendees','attachments']) {
    const el = dialog.querySelector(`[data-event-${key}]`);
    if (!el) continue;
    const value = task.outlookDetails?.[key];
    el.textContent = Array.isArray(value) ? value.map(item => key === 'attendees'
      ? [item.name, item.address, item.type != null ? `(${t(`event.attendee${item.type}`)}; ${t(`event.response${item.responseStatus ?? 0}`)})` : ''].filter(Boolean).join(' ')
      : `${item.name || ''}${item.size != null ? ` (${item.size} B)` : ''}`).join('\n') : String(value || '—');
  }
  const meeting = dialog.querySelector('[data-editor-meeting]');
  if (meeting) meeting.hidden = !['organizer','attendees','attachments'].some(key => {
    const value = task.outlookDetails?.[key];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });
}

export function readEventFields(dialog) {
  const details = { ...dialog._eventDetails };
  for (const key of fields) {
    const input = dialog.querySelector(`[name="${fieldName(key)}"]`);
    if (!input) continue;
    const value = key === 'reminderSet' ? input.checked : typeof defaults[key] === 'number' ? Number(input.value) : input.value;
    // An unedited empty/default field must not replace metadata absent from old rows.
    if (key in details || value !== defaults[key]) details[key] = value;
  }
  return {endDate:dialog.querySelector('[name="endDate"]')?.value || dialog.querySelector('[name="date"]')?.value, ...(Object.keys(details).length ? {outlookDetails:details} : {})};
}

export function validateEventForm(dialog, form) {
  let error = validateEventRange(form);
  const mins = form.outlookDetails?.reminderMinutesBeforeStart;
  if (form.outlookDetails?.reminderSet && (!Number.isInteger(mins ?? 15) || mins < 0)) error = 'event.invalidReminder';
  const el = dialog.querySelector('[data-event-error]');
  if (el) { el.textContent = error ? t(error) : ''; el.hidden = !error; }
  if (error) dialog.querySelector(error === 'event.invalidReminder' ? '[name="eventReminderMinutesBeforeStart"]' : '[name="endDate"]')?.focus();
  return !error;
}
