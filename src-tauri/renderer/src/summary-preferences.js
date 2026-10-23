export const SUMMARY_METRICS = Object.freeze(['total','average','overtime','days','overtimeDays','longest']);
const DEFAULT_METRICS = Object.freeze(['total','average','overtime','days']);

/** Only portable display choices are persisted; tasks and tag filters stay in Store/view state. */
export function normalizeSummaryPreferences(value = {}) {
  const selected = Array.isArray(value?.metrics)
    ? [...new Set(value.metrics.filter(id => SUMMARY_METRICS.includes(id)))].slice(0, 4) : [];
  return { metrics:selected.length ? selected : [...DEFAULT_METRICS], averageBase:value?.averageBase === 'business' ? 'business' : 'recorded' };
}
