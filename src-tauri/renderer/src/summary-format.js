const FORMATTER_CACHE_LIMIT = 16;

/** Pure Summary formatting. Caches are bounded and reset when the UI locale changes. */
export function createSummaryFormatting(getLocale, translateHtml) {
  let cachedLocale;
  const numbers = new Map();
  const dates = new Map();

  function cachedFormatter(cache, key, locale, create) {
    // Non-string locale values may be mutable; retain Intl's normal coercion.
    if (typeof locale !== 'string') return create();
    if (cachedLocale !== locale) {
      numbers.clear();
      dates.clear();
      cachedLocale = locale;
    }
    if (!cache.has(key)) {
      if (cache.size >= FORMATTER_CACHE_LIMIT) cache.clear();
      cache.set(key, create());
    }
    return cache.get(key);
  }

  function number(value, digits = 0) {
    const locale = getLocale();
    const create = () => new Intl.NumberFormat(locale, { maximumFractionDigits: digits });
    const formatter = typeof digits === 'number'
      ? cachedFormatter(numbers, digits, locale, create) : create();
    return formatter.format(value);
  }

  function dateText(key, options) {
    const locale = getLocale();
    const resolvedOptions = { timeZone: 'Asia/Tokyo', ...options };
    const create = () => new Intl.DateTimeFormat(locale, resolvedOptions);
    // Cache primitive option snapshots, not caller-owned mutable objects or coercions.
    const cacheable = Object.values(resolvedOptions).every(value =>
      value === undefined || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value)));
    const formatter = cacheable
      ? cachedFormatter(dates, JSON.stringify(resolvedOptions), locale, create) : create();
    return formatter.format(new Date(`${key.length === 7 ? key + '-01' : key}T00:00:00Z`));
  }

  const groupLabel = (group, period) => dateText(group.key, period === 'year'
    ? { year: 'numeric', month: 'long' } : { month: 'numeric', day: 'numeric', weekday: 'short' });

  function timeParts(minutes) {
    const rounded = Math.max(0, Math.round(minutes || 0));
    return { hours: number(Math.floor(rounded / 60)), minutes: number(rounded % 60) };
  }

  function timeMarkup(minutes) {
    const parts = timeParts(minutes);
    return `${parts.hours}<small>${translateHtml('summary.hours')}</small>${parts.minutes}<small>${translateHtml('summary.minutes')}</small>`;
  }

  return { number, dateText, groupLabel, timeParts, timeMarkup };
}
