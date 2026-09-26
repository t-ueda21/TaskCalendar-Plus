import assert from 'node:assert/strict';

globalThis.document = { addEventListener() {} };
globalThis.setInterval = () => 0;

const key = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const today = new Date();
const yesterday = new Date(today);
yesterday.setDate(yesterday.getDate() - 1);
const tomorrow = new Date(today);
tomorrow.setDate(tomorrow.getDate() + 1);
const todayKey = key(today);
const yesterdayKey = key(yesterday);
const tomorrowKey = key(tomorrow);
const remoteRequests = [];

globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  if (url.startsWith('/api/weather-cache/')) {
    return new Response(JSON.stringify({}), { status: 200 });
  }
  const request = new URL(url);
  remoteRequests.push({ host: request.host, start: request.searchParams.get('start_date'), end: request.searchParams.get('end_date') });
  const archive = request.host === 'archive-api.open-meteo.com';
  // The historical endpoint rejects today; the forecast endpoint has today's weather.
  if (archive && request.searchParams.get('end_date') >= todayKey) {
    return new Response(JSON.stringify({ reason: 'date outside archive range' }), { status: 400 });
  }
  const days = archive ? [yesterdayKey] : [todayKey, tomorrowKey];
  return new Response(JSON.stringify({
    daily: {
      time: days,
      weather_code: days.map(() => 61),
      temperature_2m_max: days.map(() => 24),
      temperature_2m_min: days.map(() => 18),
    },
  }), { status: 200 });
};

const { getWeatherRange, getWeatherByDate, formatWeatherForDisplay } = await import('../src-tauri/renderer/src/weather.js');
const weather = await getWeatherRange(yesterdayKey, tomorrowKey);
assert.ok(weather[yesterdayKey]);
assert.ok(weather[todayKey], 'today must be fetched from forecast, not the archive');
assert.ok(weather[tomorrowKey]);
assert.notEqual(formatWeatherForDisplay(weather[todayKey]), '天気情報なし');
assert.deepEqual(remoteRequests, [
  { host: 'archive-api.open-meteo.com', start: yesterdayKey, end: yesterdayKey },
  { host: 'api.open-meteo.com', start: todayKey, end: tomorrowKey },
]);

const count = remoteRequests.length;
assert.ok(await getWeatherByDate(todayKey));
assert.equal(remoteRequests.length, count, 'today should use the saved weather until its refresh interval');
console.log('PASS: previous day archive, today and tomorrow forecast, cached today');
