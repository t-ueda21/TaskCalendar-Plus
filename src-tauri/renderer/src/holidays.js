/**
 * holidays.js — 日本の祝日
 *
 * 祝日法の規則から算出する(春分・秋分の日、ハッピーマンデー、国民の休日、振替休日を含む)。
 * Rust側(src-tauri/src/calendar.rs)も同じ規則で算出している。
 */

function pad2(n) { return String(n).padStart(2, "0"); }
function dateKey(y, m, d) { return `${y}-${pad2(m)}-${pad2(d)}`; }

function vernalEquinoxDay(year) {
  return Math.floor(20.8431 + 0.242194 * (year - 1980)) - Math.floor((year - 1980) / 4);
}
function autumnalEquinoxDay(year) {
  return Math.floor(23.2488 + 0.242194 * (year - 1980)) - Math.floor((year - 1980) / 4);
}

function nthMonday(year, month, nth) {
  const first = new Date(year, month - 1, 1);
  const firstMondayDate = 1 + ((8 - first.getDay()) % 7);
  return firstMondayDate + (nth - 1) * 7;
}

function baseHolidaysForYear(year) {
  const map = new Map();
  const set = (m, d, name) => map.set(dateKey(year, m, d), name);

  set(1, 1, "元日");
  set(1, nthMonday(year, 1, 2), "成人の日");
  set(2, 11, "建国記念の日");
  if (year >= 2020) set(2, 23, "天皇誕生日");
  set(3, vernalEquinoxDay(year), "春分の日");
  set(4, 29, "昭和の日");
  set(5, 3, "憲法記念日");
  set(5, 4, "みどりの日");
  set(5, 5, "こどもの日");
  set(7, nthMonday(year, 7, 3), "海の日");
  set(8, 11, "山の日");
  set(9, nthMonday(year, 9, 3), "敬老の日");
  set(9, autumnalEquinoxDay(year), "秋分の日");
  set(10, nthMonday(year, 10, 2), "スポーツの日");
  set(11, 3, "文化の日");
  set(11, 23, "勤労感謝の日");

  return map;
}

// 祝日法第3条第3項の「国民の休日」。前日と翌日がともに国民の祝日である日を休日とする
// (日曜日と振替休日にあたる日は除くため、本来の祝日だけを並べた時点で判定する)。
// 例: 敬老の日と秋分の日に挟まれる2026-09-22(火)。
function withNationalHolidays(map) {
  const result = new Map(map);
  Array.from(map.keys()).sort().forEach((key) => {
    const [y, m, d] = key.split("-").map(Number);
    const middle = new Date(y, m - 1, d + 1);
    const next = new Date(y, m - 1, d + 2);
    const middleKey = dateKey(middle.getFullYear(), middle.getMonth() + 1, middle.getDate());
    const nextKey = dateKey(next.getFullYear(), next.getMonth() + 1, next.getDate());
    if (map.has(middleKey) || !map.has(nextKey)) return;
    if (middle.getDay() === 0) return;
    result.set(middleKey, "国民の休日");
  });
  return result;
}

function withSubstituteHolidays(map) {
  const result = new Map(map);
  const isHoliday = (key) => result.has(key);
  const sortedKeys = Array.from(map.keys()).sort();
  sortedKeys.forEach((key) => {
    const [y, m, d] = key.split("-").map(Number);
    const dow = new Date(y, m - 1, d).getDay();
    if (dow !== 0) return;
    const cursor = new Date(y, m - 1, d);
    do {
      cursor.setDate(cursor.getDate() + 1);
    } while (isHoliday(dateKey(cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate())));
    result.set(dateKey(cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate()), "振替休日");
  });
  return result;
}

const _yearCache = new Map();
function holidaysForYear(year) {
  if (!_yearCache.has(year)) {
    _yearCache.set(year, withSubstituteHolidays(withNationalHolidays(baseHolidaysForYear(year))));
  }
  return _yearCache.get(year);
}

/**
 * 指定日が祝日かどうかを返す。
 * @param {string} dateKey - "YYYY-MM-DD"
 * @returns {string|null} 祝日名 or null
 */
function getHolidayName(dateKeyStr) {
  const year = parseInt(String(dateKeyStr).slice(0, 4), 10);
  if (!Number.isFinite(year)) return null;
  return holidaysForYear(year).get(dateKeyStr) ?? null;
}

/**
 * 指定月の祝日マップを返す。
 * @param {number} year
 * @param {number} month - 0始まり
 * @returns {Map<string, string>} dateKey → 祝日名
 */
function getHolidaysInMonth(year, month) {
  const prefix = `${year}-${pad2(month + 1)}`;
  const map = new Map();
  for (const [key, name] of holidaysForYear(year).entries()) {
    if (key.startsWith(prefix)) map.set(key, name);
  }
  return map;
}

export { getHolidayName, getHolidaysInMonth };
