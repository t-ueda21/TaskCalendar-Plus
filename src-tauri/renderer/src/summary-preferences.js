export const SUMMARY_METRICS = Object.freeze(['total','average','overtime','days','overtimeDays','longest']);
export const SUMMARY_PREFERENCES_VERSION = 2;
const LEGACY_DEFAULT_METRICS = Object.freeze(['total','average','overtime','days']);

/** Only portable display choices are persisted; tasks and tag filters stay in Store/view state. */
export function normalizeSummaryPreferences(value = {}) {
  const selected = Array.isArray(value?.metrics)
    ? [...new Set(value.metrics.filter(id => SUMMARY_METRICS.includes(id)))] : [];
  // Expand only the former default. A saved version 2 subset is an explicit user choice.
  const legacyDefault = (value?.version === undefined || value?.version === 1)
    && Array.isArray(value?.metrics)
    && value.metrics.length === LEGACY_DEFAULT_METRICS.length
    && value.metrics.every((id,index) => id === LEGACY_DEFAULT_METRICS[index]);
  return { version:SUMMARY_PREFERENCES_VERSION,
    metrics:!selected.length || legacyDefault ? [...SUMMARY_METRICS] : selected,
    averageBase:value?.averageBase === 'business' ? 'business' : 'recorded' };
}
