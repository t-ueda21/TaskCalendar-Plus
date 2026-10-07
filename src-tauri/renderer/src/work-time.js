function minutes(value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(String(value))) return null;
  const [h, m] = value.split(':').map(Number); return h * 60 + m;
}
export function mergeIntervals(intervals) {
  const sorted = intervals.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s).map(pair => [...pair]).sort((a, b) => a[0] - b[0]);
  const result = [];
  for (const [s, e] of sorted) {
    const previous = result.at(-1);
    if (previous && s <= previous[1]) previous[1] = Math.max(previous[1], e);
    else result.push([s, e]);
  }
  return result;
}
export function summarizeWork(tasks, settings) {
  let segments = mergeIntervals(tasks.filter(task => !task.isAllDay && String(task.tagId ?? '').trim()).map(task => [minutes(task.startTime), minutes(task.endTime)]));
  const excluded = mergeIntervals((settings.breaks ?? []).filter(row => !row.countAsWork).map(row => [minutes(row.start), minutes(row.end)]));
  for (const [bs, be] of excluded) {
    segments = segments.flatMap(([s, e]) => be <= s || bs >= e ? [[s, e]] : [...(bs > s ? [[s, bs]] : []), ...(be < e ? [[be, e]] : [])]);
  }
  const start = minutes(settings.workStart) ?? 540;
  const end = minutes(settings.workEnd) ?? 1080;
  return segments.reduce((result, [s, e]) => ({
    total: result.total + e - s,
    overtime: result.overtime + Math.max(0, Math.min(e, start) - s) + Math.max(0, e - Math.max(s, end)),
  }), { total: 0, overtime: 0 });
}
