// src-tauri/renderer/src/holidays.js の移植確認用テスト(Issue #8)。
// この関数群は既存Electron版から無改修で移植したため(decisions.md参照)、
// 移植時の破損がないことのみを確認する。
import assert from 'assert';
import { getHolidayName, getHolidaysInMonth } from '../src-tauri/renderer/src/holidays.js';

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

test('2026年の元日・こどもの日が正しい', () => {
  assert.strictEqual(getHolidayName('2026-01-01'), '元日');
  assert.strictEqual(getHolidayName('2026-05-05'), 'こどもの日');
});

test('2026年8月の祝日一覧に山の日が含まれる(month引数は0始まり)', () => {
  const map = getHolidaysInMonth(2026, 7);
  assert.strictEqual(map.get('2026-08-11'), '山の日');
});

if (process.exitCode) {
  console.error('\n一部のテストが失敗しました。');
} else {
  console.log('\n全テスト成功。');
}
