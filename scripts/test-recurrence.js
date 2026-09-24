'use strict';

// src-tauri/renderer/src/store.js の _advanceRecurrenceDate / _expandRecurrenceDateKeys
// (Issue #8で修正した月次繰り返しクランプ挙動)の回帰テスト。
//
// store.jsはブラウザ専用API(document等、ui-utils.js経由で発生)にモジュール
// 読み込み時点で依存しているためNodeから直接importできず、ここでは対象の
// 2関数をそのまま複製して検証する。store.js側の実装を変更した場合は、この
// ファイルも合わせて更新すること。

const assert = require('assert');

function _dateKeyToDate(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  return new Date(y, m - 1, d);
}
function _dateToDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function _advanceRecurrenceDate(date, type, originDay) {
  const next = new Date(date);
  if (type === 'daily') {
    next.setDate(next.getDate() + 1);
    return next;
  }
  if (type === 'weekly') {
    next.setDate(next.getDate() + 7);
    return next;
  }
  if (type === 'monthly') {
    const y = next.getFullYear();
    const m = next.getMonth();
    const day = originDay ?? next.getDate();
    const firstOfNext = new Date(y, m + 1, 1);
    const lastDay = new Date(y, m + 2, 0).getDate();
    firstOfNext.setDate(Math.min(day, lastDay));
    return firstOfNext;
  }
  return null;
}
function _expandRecurrenceDateKeys(startDateKey, untilKey, type) {
  const startDate = _dateKeyToDate(startDateKey);
  const originDay = startDate.getDate();
  const result = [];
  let cursor = new Date(startDate);
  for (let i = 0; i < 5000; i++) {
    const key = _dateToDateKey(cursor);
    if (key > untilKey) break;
    result.push(key);
    const next = _advanceRecurrenceDate(cursor, type, originDay);
    if (!next) break;
    cursor = next;
  }
  return result;
}

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

test('daily展開: 開始日から終了日まで1日ごと', () => {
  const dates = _expandRecurrenceDateKeys('2026-07-01', '2026-07-05', 'daily');
  assert.deepStrictEqual(dates, ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05']);
});

test('weekly展開: 7日ごと', () => {
  const dates = _expandRecurrenceDateKeys('2026-07-01', '2026-07-22', 'weekly');
  assert.deepStrictEqual(dates, ['2026-07-01', '2026-07-08', '2026-07-15', '2026-07-22']);
});

test('monthly展開: 月末クランプは元の開始日を基準に毎月再クランプする(Issue #8の仕様変更)', () => {
  const dates = _expandRecurrenceDateKeys('2026-01-31', '2026-04-30', 'monthly');
  // 修正前(既存Electron版の実挙動)は 1/31 -> 2/28 -> 3/28 -> 4/28 (28に固定されたまま戻らない)。
  // 修正後は毎月31日を基準に再クランプするため、3月は31日まであるので31へ戻る。
  assert.deepStrictEqual(dates, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
});

test('monthly展開: 29日開始でも同様に元の開始日を基準に再クランプする', () => {
  const dates = _expandRecurrenceDateKeys('2026-01-29', '2026-03-29', 'monthly');
  assert.deepStrictEqual(dates, ['2026-01-29', '2026-02-28', '2026-03-29']);
});

test('monthly展開: 月末超過しない通常の日付では挙動が変わらない', () => {
  const dates = _expandRecurrenceDateKeys('2026-07-15', '2026-09-15', 'monthly');
  assert.deepStrictEqual(dates, ['2026-07-15', '2026-08-15', '2026-09-15']);
});

if (process.exitCode) {
  console.error('\n一部のテストが失敗しました。');
} else {
  console.log('\n全テスト成功。');
}
