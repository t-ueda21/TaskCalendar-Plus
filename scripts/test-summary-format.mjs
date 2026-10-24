import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// No app/UI imports, DOM, subprocesses or dependencies: run with plain Node 22+.
const formatterSource = await readFile(new URL('../src-tauri/renderer/src/summary-format.js', import.meta.url), 'utf8');
const { createSummaryFormatting } = await import(`data:text/javascript;base64,${Buffer.from(formatterSource).toString('base64')}`);

// Independent, uncached oracle copied from summary-renderer.js at
// 2490445db427457148f57325d1e6d14473eaa25f (before formatter extraction).
// Keep this algorithm independent of the production helper and its cache keys.
function originalFormatting(getLocale, th) {
  const number = (value, digits = 0) => new Intl.NumberFormat(getLocale(), { maximumFractionDigits:digits }).format(value);
  const dateObject = key => new Date(`${key.length === 7 ? key + '-01' : key}T00:00:00Z`);
  const dateText = (key, options) => new Intl.DateTimeFormat(getLocale(), { timeZone:'Asia/Tokyo', ...options }).format(dateObject(key));
  const groupLabel = (group, period) => dateText(group.key, period === 'year'
    ? {year:'numeric',month:'long'} : {month:'numeric',day:'numeric',weekday:'short'});
  function timeParts(minutes) {
    const rounded = Math.max(0, Math.round(minutes || 0));
    return { hours:number(Math.floor(rounded / 60)), minutes:number(rounded % 60) };
  }
  function timeMarkup(minutes) {
    const parts = timeParts(minutes);
    return `${parts.hours}<small>${th('summary.hours')}</small>${parts.minutes}<small>${th('summary.minutes')}</small>`;
  }
  return { number, dateText, groupLabel, timeParts, timeMarkup };
}

const locales = ['ja', 'en', 'ko', 'zh-CN', 'zh-TW', 'es', 'fr', 'de', 'pt'];
assert.deepEqual(Intl.NumberFormat.supportedLocalesOf(locales), locales, 'runtime must support all nine UI locales');
assert.deepEqual(Intl.DateTimeFormat.supportedLocalesOf(locales), locales, 'runtime must support all nine date locales');
let locale = 'ja';
let translationRevision = 0;
// A controlled HTML translator makes stale locale/translation capture observable.
const translateHtml = key => `${locale}:${key}:${translationRevision}&amp;`;
const actual = createSummaryFormatting(() => locale, translateHtml);
const original = originalFormatting(() => locale, translateHtml);
let comparisons = 0;
function same(method, args, label) {
  assert.deepEqual(actual[method](...args), original[method](...args), `${locale}: ${method}: ${label}`);
  comparisons++;
}
function sameError(method, args, label) {
  let expected;
  try { original[method](...args); } catch (error) { expected = error; }
  assert.ok(expected instanceof Error, `${label}: oracle must reject the input`);
  assert.throws(() => actual[method](...args), { name:expected.name }, `${method}: ${label}`);
  comparisons++;
}

const numberValues = [0, -0, 0.04, 0.05, 0.49, 0.5, 1.25, -1.25, 99.95, 1234.56789,
  -1234567.89, 999999999.95, NaN, Infinity, -Infinity, null, undefined, '1234.56', 1234567890123456789n];
const durations = [undefined, null, false, '', NaN, -Infinity, -60, -0.5, 0, 0.49, 0.5,
  1.5, 59.49, 59.5, 59.99, 60, 60.5, 119.49, 119.5, 1439.5, 60000.5, '59.5', Infinity];
const dates = ['0001-01-01', '2024-02-29', '2026-01-01', '2026-10-24', '2026-12-31', '9999-12-31', '2024-02', '2026-12'];
const dateOptions = [undefined, null, {}, { year:'numeric' }, { year:'numeric', month:'short' },
  { month:'short' }, { weekday:'short' }, { year:'numeric', month:'long' },
  { month:'numeric', day:'numeric', weekday:'short' },
  { year:'numeric', month:'numeric', day:'numeric', timeZone:'America/Los_Angeles' },
  { hour:'numeric', minute:'2-digit' }, { timeZone:'UTC', hour:'numeric', hour12:false },
  { timeZone:undefined, year:'numeric', month:'long', day:'numeric' },
  { year:undefined, month:'short' }];

for (locale of [...locales, ...locales.toReversed(), 'ja']) {
  for (const value of numberValues) {
    same('number', [value], 'default precision');
    for (const digits of [0, 1, 2, 3, 20]) same('number', [value, digits], `precision ${digits}`);
  }
  for (const minutes of durations) {
    same('timeParts', [minutes], `minutes ${String(minutes)}`);
    same('timeMarkup', [minutes], `minutes ${String(minutes)}`);
  }
  for (const key of dates) {
    for (const options of dateOptions) same('dateText', [key, options], key);
    for (const period of ['month', 'year']) same('groupLabel', [{ key }, period], `${key}, ${period}`);
  }
}
// Pin the hour carry, clamping and absent-value rules independently of the oracle.
assert.deepEqual(actual.timeParts(59.5), { hours:'1', minutes:'0' });
assert.deepEqual(actual.timeParts(119.49), { hours:'1', minutes:'59' });
assert.deepEqual(actual.timeParts(-60), { hours:'0', minutes:'0' });
assert.deepEqual(actual.timeParts(undefined), { hours:'0', minutes:'0' });
translationRevision++;
same('timeMarkup', [61], 'translation callback is evaluated again without a locale change');
console.log('PASS: nine locales, numeric precision, duration rounding, dates and month/year labels');

const mutableOptions = { year:'numeric', month:'short' };
same('dateText', ['2026-10-24', mutableOptions], 'initial options');
mutableOptions.month = 'long';
same('dateText', ['2026-10-24', mutableOptions], 'mutated month');
mutableOptions.timeZone = 'America/Los_Angeles';
same('dateText', ['2026-10-24', mutableOptions], 'mutated time zone');
mutableOptions.timeZone = undefined;
same('dateText', ['2026-10-24', mutableOptions], 'explicit undefined time zone');
delete mutableOptions.timeZone;
same('dateText', ['2026-10-24', mutableOptions], 'deleted time zone restores JST');
assert.deepEqual(mutableOptions, { year:'numeric', month:'long' }, 'formatting must not mutate the supplied options');

let monthStyle = 'short';
const coercibleOptions = { year:'numeric', month:{ toString:() => monthStyle } };
same('dateText', ['2026-10-24', coercibleOptions], 'object option before coercion changes');
monthStyle = 'long';
same('dateText', ['2026-10-24', coercibleOptions], 'object option after coercion changes');
const getterOptions = { get month() { return monthStyle; } };
same('dateText', ['2026-10-24', getterOptions], 'getter option');
monthStyle = 'numeric';
same('dateText', ['2026-10-24', getterOptions], 'changed getter option');

// JSON cache keys must not collapse distinct boolean coercions to the same null.
locale = 'en';
for (const values of [[NaN, Infinity], [Infinity, NaN], [NaN, -Infinity], [-Infinity, NaN]]) {
  const fresh = createSummaryFormatting(() => locale, translateHtml);
  const options = value => ({ hour:'numeric', hour12:value });
  assert.deepEqual(values.map(value => fresh.dateText('2026-10-24', options(value))),
    values.map(value => original.dateText('2026-10-24', options(value))),
    `non-finite hour12 coercions must remain distinct in order ${values.map(String).join(' -> ')}`);
  comparisons += values.length;
}

let precision = 0;
const coercibleDigits = { valueOf:() => precision };
same('number', [1234.567, coercibleDigits], 'object precision before mutation');
precision = 2;
same('number', [1234.567, coercibleDigits], 'object precision after mutation');
for (const digits of [undefined, null, '1', false, true]) same('number', [1234.567, digits], `coerced precision ${String(digits)}`);

locale = ['en'];
same('number', [1234.5, 1], 'mutable locale list');
same('dateText', ['2026-10-24', { month:'long' }], 'mutable date locale list');
locale[0] = 'de';
same('number', [1234.5, 1], 'locale list changed');
same('dateText', ['2026-10-24', { month:'long' }], 'date locale list changed');
locale = 'fr';
same('number', [1234.5, 1], 'return from locale list to a string');
same('dateText', ['2026-10-24', { month:'long' }], 'return to string date locale');
for (const digits of [-1, 101, NaN]) sameError('number', [1.2, digits], `invalid precision ${digits}`);
sameError('dateText', ['not-a-date', {}], 'invalid date');
sameError('dateText', ['2026-10-24', { month:'invalid' }], 'invalid date option');
sameError('dateText', ['2026-10-24', { timeZone:'invalid' }], 'invalid time zone');
// An unsuccessful constructor must not poison the next valid call.
same('number', [1234.5, 1], 'number after rejected options');
same('dateText', ['2026-10-24', { month:'long' }], 'date after rejected options');
console.log('PASS: live locale/translation changes, mutable/coercible/undefined options and rejected inputs');

// Count real Intl constructor calls in a separate realm, without timing claims or
// changing global Intl. This observes reuse/eviction through the public API.
function instrumentedFormatting() {
  const counts = { number:0, date:0 };
  const trackedIntl = {
    NumberFormat:class extends Intl.NumberFormat {
      constructor(...args) { super(...args); counts.number++; }
    },
    DateTimeFormat:class extends Intl.DateTimeFormat {
      constructor(...args) { super(...args); counts.date++; }
    },
  };
  const script = formatterSource.replace(/^export (?=function createSummaryFormatting\b)/m, '');
  assert.notEqual(script, formatterSource, 'isolated helper must expose createSummaryFormatting');
  const create = vm.runInNewContext(`${script}\ncreateSummaryFormatting;`, { Intl:trackedIntl });
  return { counts, format:create(() => locale, translateHtml) };
}

locale = 'en';
const { counts, format } = instrumentedFormatting();
for (let repeat = 0; repeat < 10; repeat++) {
  format.number(1234.5);
  format.number(1234.5, 1);
  format.dateText('2026-10-24', { month:'short' });
  format.dateText('2026-12', { year:'numeric', month:'long' });
}
assert.deepEqual(counts, { number:2, date:2 }, 'repeated values and fresh equivalent option objects must reuse Intl instances');
locale = 'de';
assert.equal(format.number(1234.5, 1), original.number(1234.5, 1));
assert.equal(format.dateText('2026-10-24', { month:'short' }), original.dateText('2026-10-24', { month:'short' }));
assert.deepEqual(counts, { number:3, date:3 }, 'a locale change must refresh both caches');
locale = 'en';
format.number(1234.5, 1);
format.dateText('2026-10-24', { month:'short' });
assert.deepEqual(counts, { number:4, date:4 }, 'returning to an old locale must not retain its earlier cache');

const boundedNumbers = instrumentedFormatting();
for (let digits = 0; digits <= 16; digits++) {
  assert.equal(boundedNumbers.format.number(1234.567, digits), original.number(1234.567, digits));
}
assert.equal(boundedNumbers.counts.number, 17);
boundedNumbers.format.number(1234.567, 0);
assert.equal(boundedNumbers.counts.number, 18, 'the oldest entry must be evicted after exceeding the 16-formatter bound');
boundedNumbers.format.number(1234.567, 0);
assert.equal(boundedNumbers.counts.number, 18, 'the cache must still reuse entries after eviction');

const boundedDates = instrumentedFormatting();
const variants = [];
for (const year of ['numeric', '2-digit']) {
  for (const month of ['numeric', '2-digit', 'short', 'long', 'narrow']) {
    for (const day of ['numeric', '2-digit']) variants.push({ year, month, day });
  }
}
for (const options of variants.slice(0, 17)) {
  assert.equal(boundedDates.format.dateText('2026-10-24', options), original.dateText('2026-10-24', options));
}
assert.equal(boundedDates.counts.date, 17);
boundedDates.format.dateText('2026-10-24', variants[0]);
assert.equal(boundedDates.counts.date, 18, 'date formatters must also evict after exceeding the 16-formatter bound');
boundedDates.format.dateText('2026-10-24', { ...variants[0] });
assert.equal(boundedDates.counts.date, 18, 'date reuse must survive eviction and a fresh options object');
console.log('PASS: deterministic Intl reuse, locale invalidation and bounded number/date caches');
console.log(`PASS: Summary formatting regression (${comparisons} original-algorithm comparisons; ${process.version})`);
