/**
 * weather.js
 *
 * Open-Meteo (free API) から日次天気を取得し、
 * Rust側の組み込みHTTP API(SQLite)にキャッシュする。
 */

import { formatDateKey, parseLocalDate, _isDateKey } from "./ui-utils.js";
import * as Store from "./store.js";

const DEFAULT_LOCATION_KEY = "tokyo";
// 都道府県庁所在地(北から都道府県コード順)。keyは設定に保存されるため変えない。
const LOCATION_OPTIONS = [
  { key: "sapporo", name: "北海道（札幌市）", latitude: 43.0642, longitude: 141.3469, timezone: "Asia/Tokyo" },
  { key: "aomori", name: "青森県（青森市）", latitude: 40.8246, longitude: 140.7406, timezone: "Asia/Tokyo" },
  { key: "morioka", name: "岩手県（盛岡市）", latitude: 39.7036, longitude: 141.1527, timezone: "Asia/Tokyo" },
  { key: "sendai", name: "宮城県（仙台市）", latitude: 38.2688, longitude: 140.8721, timezone: "Asia/Tokyo" },
  { key: "akita", name: "秋田県（秋田市）", latitude: 39.7186, longitude: 140.1024, timezone: "Asia/Tokyo" },
  { key: "yamagata", name: "山形県（山形市）", latitude: 38.2404, longitude: 140.3633, timezone: "Asia/Tokyo" },
  { key: "fukushima", name: "福島県（福島市）", latitude: 37.7503, longitude: 140.4676, timezone: "Asia/Tokyo" },
  { key: "mito", name: "茨城県（水戸市）", latitude: 36.3418, longitude: 140.4468, timezone: "Asia/Tokyo" },
  { key: "utsunomiya", name: "栃木県（宇都宮市）", latitude: 36.5657, longitude: 139.8836, timezone: "Asia/Tokyo" },
  { key: "maebashi", name: "群馬県（前橋市）", latitude: 36.3911, longitude: 139.0608, timezone: "Asia/Tokyo" },
  { key: "saitama", name: "埼玉県（さいたま市）", latitude: 35.8569, longitude: 139.6489, timezone: "Asia/Tokyo" },
  { key: "chiba", name: "千葉県（千葉市）", latitude: 35.6051, longitude: 140.1233, timezone: "Asia/Tokyo" },
  { key: "tokyo", name: "東京都（新宿区）", latitude: 35.6895, longitude: 139.6917, timezone: "Asia/Tokyo" },
  { key: "yokohama", name: "神奈川県（横浜市）", latitude: 35.4478, longitude: 139.6425, timezone: "Asia/Tokyo" },
  { key: "niigata", name: "新潟県（新潟市）", latitude: 37.9026, longitude: 139.0236, timezone: "Asia/Tokyo" },
  { key: "toyama", name: "富山県（富山市）", latitude: 36.6953, longitude: 137.2113, timezone: "Asia/Tokyo" },
  { key: "kanazawa", name: "石川県（金沢市）", latitude: 36.5947, longitude: 136.6256, timezone: "Asia/Tokyo" },
  { key: "fukui", name: "福井県（福井市）", latitude: 36.0652, longitude: 136.2216, timezone: "Asia/Tokyo" },
  { key: "kofu", name: "山梨県（甲府市）", latitude: 35.6642, longitude: 138.5684, timezone: "Asia/Tokyo" },
  { key: "nagano", name: "長野県（長野市）", latitude: 36.6513, longitude: 138.1810, timezone: "Asia/Tokyo" },
  { key: "gifu", name: "岐阜県（岐阜市）", latitude: 35.3912, longitude: 136.7223, timezone: "Asia/Tokyo" },
  { key: "shizuoka", name: "静岡県（静岡市）", latitude: 34.9769, longitude: 138.3831, timezone: "Asia/Tokyo" },
  { key: "nagoya", name: "愛知県（名古屋市）", latitude: 35.1815, longitude: 136.9066, timezone: "Asia/Tokyo" },
  { key: "tsu", name: "三重県（津市）", latitude: 34.7303, longitude: 136.5086, timezone: "Asia/Tokyo" },
  { key: "otsu", name: "滋賀県（大津市）", latitude: 35.0045, longitude: 135.8686, timezone: "Asia/Tokyo" },
  { key: "kyoto", name: "京都府（京都市）", latitude: 35.0214, longitude: 135.7556, timezone: "Asia/Tokyo" },
  { key: "osaka", name: "大阪府（大阪市）", latitude: 34.6937, longitude: 135.5023, timezone: "Asia/Tokyo" },
  { key: "kobe", name: "兵庫県（神戸市）", latitude: 34.6913, longitude: 135.1830, timezone: "Asia/Tokyo" },
  { key: "nara", name: "奈良県（奈良市）", latitude: 34.6851, longitude: 135.8048, timezone: "Asia/Tokyo" },
  { key: "wakayama", name: "和歌山県（和歌山市）", latitude: 34.2261, longitude: 135.1675, timezone: "Asia/Tokyo" },
  { key: "tottori", name: "鳥取県（鳥取市）", latitude: 35.5039, longitude: 134.2383, timezone: "Asia/Tokyo" },
  { key: "matsue", name: "島根県（松江市）", latitude: 35.4723, longitude: 133.0505, timezone: "Asia/Tokyo" },
  { key: "okayama", name: "岡山県（岡山市）", latitude: 34.6618, longitude: 133.9344, timezone: "Asia/Tokyo" },
  { key: "hiroshima", name: "広島県（広島市）", latitude: 34.3853, longitude: 132.4553, timezone: "Asia/Tokyo" },
  { key: "yamaguchi", name: "山口県（山口市）", latitude: 34.1859, longitude: 131.4714, timezone: "Asia/Tokyo" },
  { key: "tokushima", name: "徳島県（徳島市）", latitude: 34.0658, longitude: 134.5593, timezone: "Asia/Tokyo" },
  { key: "takamatsu", name: "香川県（高松市）", latitude: 34.3401, longitude: 134.0434, timezone: "Asia/Tokyo" },
  { key: "matsuyama", name: "愛媛県（松山市）", latitude: 33.8416, longitude: 132.7657, timezone: "Asia/Tokyo" },
  { key: "kochi", name: "高知県（高知市）", latitude: 33.5597, longitude: 133.5311, timezone: "Asia/Tokyo" },
  { key: "fukuoka", name: "福岡県（福岡市）", latitude: 33.6064, longitude: 130.4181, timezone: "Asia/Tokyo" },
  { key: "saga", name: "佐賀県（佐賀市）", latitude: 33.2494, longitude: 130.2988, timezone: "Asia/Tokyo" },
  { key: "nagasaki", name: "長崎県（長崎市）", latitude: 32.7448, longitude: 129.8737, timezone: "Asia/Tokyo" },
  { key: "kumamoto", name: "熊本県（熊本市）", latitude: 32.8031, longitude: 130.7079, timezone: "Asia/Tokyo" },
  { key: "oita", name: "大分県（大分市）", latitude: 33.2382, longitude: 131.6126, timezone: "Asia/Tokyo" },
  { key: "miyazaki", name: "宮崎県（宮崎市）", latitude: 31.9111, longitude: 131.4239, timezone: "Asia/Tokyo" },
  { key: "kagoshima", name: "鹿児島県（鹿児島市）", latitude: 31.5602, longitude: 130.5581, timezone: "Asia/Tokyo" },
  { key: "naha", name: "沖縄県（那覇市）", latitude: 26.2124, longitude: 127.6809, timezone: "Asia/Tokyo" },
];
const LOCATION_MAP = new Map(LOCATION_OPTIONS.map((v) => [v.key, v]));

const REFRESH_MS_FUTURE = 6 * 60 * 60 * 1000;

let _cache = {};
const _loadedLocations = new Set();

function _resolveLocation(locationKey) {
  const key = String(locationKey ?? "").trim();
  return LOCATION_MAP.get(key) ?? LOCATION_MAP.get(DEFAULT_LOCATION_KEY);
}

function _currentLocation() {
  const settings = Store.getSettings();
  const key = String(settings.weatherLocationKey ?? DEFAULT_LOCATION_KEY);
  return _resolveLocation(key);
}

function _cacheBucket(locationKey) {
  const key = String(locationKey ?? DEFAULT_LOCATION_KEY);
  if (!_cache[key] || typeof _cache[key] !== "object" || Array.isArray(_cache[key])) {
    _cache[key] = {};
  }
  return _cache[key];
}

function _normalizeDateKey(value) {
  const raw = String(value ?? "").trim();
  return _isDateKey(raw) ? raw : "";
}

function _todayKey() {
  return formatDateKey(new Date());
}

function _isPastOrToday(dateKey) {
  return dateKey <= _todayKey();
}

async function _ensureLocationLoaded(locationKey) {
  const key = String(locationKey ?? DEFAULT_LOCATION_KEY);
  if (_loadedLocations.has(key)) return;
  _loadedLocations.add(key);
  try {
    const remote = await Store.getWeatherCache(key);
    if (remote && typeof remote === "object" && !Array.isArray(remote)) {
      _cache[key] = { ..._cacheBucket(key), ...remote };
    }
  } catch (e) {
    console.warn("[weather] キャッシュの読み込みに失敗しました:", e);
  }
}

function _saveCache(locationKey) {
  const key = String(locationKey ?? DEFAULT_LOCATION_KEY);
  Store.putWeatherCache(key, _cacheBucket(key))
    .catch((e) => console.warn("[weather] キャッシュの保存に失敗しました:", e));
}

function _weatherInfoByCode(code) {
  const n = Number(code);
  if (n === 0) return { icon: "☀", text: "快晴" };
  if (n === 1) return { icon: "🌤", text: "晴れ" };
  if (n === 2) return { icon: "⛅", text: "晴れ時々曇り" };
  if (n === 3) return { icon: "☁", text: "曇り" };
  if (n === 45 || n === 48) return { icon: "🌫", text: "霧" };
  if (n >= 51 && n <= 57) return { icon: "🌦", text: "霧雨" };
  if (n >= 61 && n <= 67) return { icon: "🌧", text: "雨" };
  if (n >= 71 && n <= 77) return { icon: "❄", text: "雪" };
  if (n >= 80 && n <= 82) return { icon: "🌦", text: "にわか雨" };
  if (n >= 85 && n <= 86) return { icon: "🌨", text: "にわか雪" };
  if (n >= 95 && n <= 99) return { icon: "⛈", text: "雷雨" };
  return { icon: "🌡", text: "不明" };
}

function _toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function _buildRecord(dateKey, weatherCode, tempMaxC, tempMinC) {
  const location = _currentLocation();
  const info = _weatherInfoByCode(weatherCode);
  const max = _toNumberOrNull(tempMaxC);
  const min = _toNumberOrNull(tempMinC);

  return {
    date: dateKey,
    weatherCode: Number.isFinite(Number(weatherCode)) ? Number(weatherCode) : null,
    weatherText: info.text,
    icon: info.icon,
    tempMaxC: max,
    tempMinC: min,
    location: location.name,
    locationKey: location.key,
    updatedAt: new Date().toISOString(),
  };
}

function _recordNeedsRefresh(record, dateKey) {
  if (!record || typeof record !== "object") return true;
  if (_isPastOrToday(dateKey) && dateKey < _todayKey()) return false;

  const updatedAt = Date.parse(String(record.updatedAt ?? ""));
  if (!Number.isFinite(updatedAt)) return true;
  return (Date.now() - updatedAt) > REFRESH_MS_FUTURE;
}

function _buildDateKeys(startDateKey, endDateKey) {
  const start = parseLocalDate(startDateKey);
  const end = parseLocalDate(endDateKey);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];

  const keys = [];
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    keys.push(formatDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

function _segmentBounds(keys, predicate) {
  const hit = keys.filter((dateKey) => predicate(dateKey));
  if (hit.length === 0) return null;
  return { start: hit[0], end: hit[hit.length - 1] };
}

async function _fetchDailyRange(startDateKey, endDateKey, { useArchive }) {
  const location = _currentLocation();
  const endpoint = useArchive
    ? "https://archive-api.open-meteo.com/v1/archive"
    : "https://api.open-meteo.com/v1/forecast";

  const url = new URL(endpoint);
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set("start_date", startDateKey);
  url.searchParams.set("end_date", endDateKey);
  url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min");
  url.searchParams.set("timezone", String(location.timezone));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`weather API error: ${res.status}`);

  const body = await res.json();
  const daily = body?.daily;
  const dates = Array.isArray(daily?.time) ? daily.time : [];
  const codes = Array.isArray(daily?.weather_code) ? daily.weather_code : [];
  const maxs = Array.isArray(daily?.temperature_2m_max) ? daily.temperature_2m_max : [];
  const mins = Array.isArray(daily?.temperature_2m_min) ? daily.temperature_2m_min : [];

  const rows = {};
  for (let i = 0; i < dates.length; i += 1) {
    const key = _normalizeDateKey(dates[i]);
    if (!key) continue;
    rows[key] = _buildRecord(key, codes[i], maxs[i], mins[i]);
  }
  return rows;
}

async function _fillMissingRange(startDateKey, endDateKey, { force = false } = {}) {
  const start = _normalizeDateKey(startDateKey);
  const end = _normalizeDateKey(endDateKey);
  if (!start || !end) return {};

  const location = _currentLocation();
  const locationKey = String(location.key ?? DEFAULT_LOCATION_KEY);

  const left = start <= end ? start : end;
  const right = start <= end ? end : start;

  await _ensureLocationLoaded(locationKey);
  const cache = _cacheBucket(locationKey);
  const keys = _buildDateKeys(left, right);
  if (keys.length === 0) return {};

  const needs = keys.filter((dateKey) => force || _recordNeedsRefresh(cache[dateKey], dateKey));
  if (needs.length === 0) {
    return Object.fromEntries(keys.map((k) => [k, cache[k] ?? null]));
  }

  const pastBounds = _segmentBounds(needs, (dateKey) => _isPastOrToday(dateKey));
  const futureBounds = _segmentBounds(needs, (dateKey) => !_isPastOrToday(dateKey));

  try {
    if (pastBounds) {
      const rows = await _fetchDailyRange(pastBounds.start, pastBounds.end, { useArchive: true });
      Object.entries(rows).forEach(([dateKey, record]) => {
        cache[dateKey] = record;
      });
    }
  } catch (e) {
    console.warn("[weather] archive fetch failed:", e);
  }

  try {
    if (futureBounds) {
      const rows = await _fetchDailyRange(futureBounds.start, futureBounds.end, { useArchive: false });
      Object.entries(rows).forEach(([dateKey, record]) => {
        cache[dateKey] = record;
      });
    }
  } catch (e) {
    console.warn("[weather] forecast fetch failed:", e);
  }

  _saveCache(locationKey);
  return Object.fromEntries(keys.map((k) => [k, cache[k] ?? null]));
}

export function getWeatherLocationOptions() {
  return LOCATION_OPTIONS.map((row) => ({ key: row.key, name: row.name }));
}

export function formatWeatherForDisplay(record, { withTemp = true } = {}) {
  if (!record) return "天気情報なし";

  const icon = String(record.icon ?? "🌡");
  const text = String(record.weatherText ?? "不明");
  if (!withTemp) return `${icon} ${text}`;

  const max = Number(record.tempMaxC);
  const min = Number(record.tempMinC);
  if (Number.isFinite(max) && Number.isFinite(min)) {
    return `${icon} ${text} ${max.toFixed(1)}℃/${min.toFixed(1)}℃`;
  }
  return `${icon} ${text}`;
}

export async function getWeatherByDate(dateKey, { force = false } = {}) {
  const key = _normalizeDateKey(dateKey);
  if (!key) return null;
  const rows = await _fillMissingRange(key, key, { force });
  return rows[key] ?? null;
}

export async function getWeatherRange(startDateKey, endDateKey, { force = false } = {}) {
  return _fillMissingRange(startDateKey, endDateKey, { force });
}
