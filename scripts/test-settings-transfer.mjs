// src-tauri/renderer/src/settings-transfer.js(クイックリンク正規化、設定のエクスポート/インポート)のテスト。
import assert from 'assert';
import {
  normalizeQuickLinks,
  formatQuickLinksText,
  buildSettingsExport,
  parseSettingsImport,
  SETTINGS_EXPORT_FORMAT,
  MAX_QUICK_LINKS,
} from '../src-tauri/renderer/src/settings-transfer.js';

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL: ${name}\n  ${e.message}`);
  }
}

test('クイックリンク: テキストを1行1件で解析し、http/https以外と名前・URLが両方同じ行を捨てる', () => {
  const links = normalizeQuickLinks([
    'ポータル,https://example.com/',
    '勤怠, https://example.com/a?x=1,2 ',
    'https://example.com/nolabel',
    '危険,javascript:alert(1)',
    'ファイル,file:///C:/x',
    'ポータル,https://example.com/',
    '',
  ].join('\n'));
  assert.deepStrictEqual(links, [
    { label: 'ポータル', url: 'https://example.com/' },
    { label: '勤怠', url: 'https://example.com/a?x=1,2' },
    { label: 'https://example.com/nolabel', url: 'https://example.com/nolabel' },
  ]);
});

test('クイックリンク: 同じURLでも名前の違う3件を保存・再表示できる', () => {
  const input = '業務A,https://example.com/\n業務B,https://example.com/\n業務C,https://example.com/';
  const links = normalizeQuickLinks(input);
  assert.strictEqual(links.length, 3);
  assert.deepStrictEqual(links.map(row => row.label), ['業務A', '業務B', '業務C']);
  assert.deepStrictEqual(normalizeQuickLinks(formatQuickLinksText(links)), links);
});

test('クイックリンク: 配列入力も受け付け、最大件数で打ち切る', () => {
  const many = Array.from({ length: MAX_QUICK_LINKS + 3 }, (_, i) => ({ label: `L${i}`, url: `https://example.com/${i}` }));
  assert.strictEqual(normalizeQuickLinks(many).length, MAX_QUICK_LINKS);
  assert.deepStrictEqual(normalizeQuickLinks(null), []);
});

test('クイックリンク: 書式化したテキストを再解析すると元に戻る', () => {
  const links = [{ label: 'A', url: 'https://a.example/' }, { label: 'B', url: 'http://b.example/x' }];
  assert.deepStrictEqual(normalizeQuickLinks(formatQuickLinksText(links)), links);
});

test('エクスポート: このDB固有のタグID参照(monthTagOrders/outlookSyncTagId)を含めず、タグはIDなしで出す', () => {
  const data = buildSettingsExport(
    { workStart: '09:00', monthTagOrders: { '2026-09': ['t1'] }, outlookSyncTagId: 't1' },
    [{ id: 't1', name: '会議', color: '#2563eb', budgetMinMinutes: 60, budgetMaxMinutes: null }],
    { exportedAt: '2026-09-24T00:00:00.000Z' },
  );
  assert.deepStrictEqual(data, {
    format: SETTINGS_EXPORT_FORMAT,
    version: 1,
    exportedAt: '2026-09-24T00:00:00.000Z',
    settings: { workStart: '09:00' },
    tags: [{ name: '会議', color: '#2563eb', budgetMinMinutes: 60 }],
  });
});

test('インポート: 許可されたキーだけを取り込み、不正なタグと重複名を捨てる', () => {
  const text = JSON.stringify({
    format: SETTINGS_EXPORT_FORMAT,
    version: 1,
    settings: { workStart: '10:00', unknownKey: 1, monthTagOrders: {}, quickLinks: [] },
    tags: [
      { name: '会議', color: '#2563eb', budgetMinMinutes: '30' },
      { name: '会議', color: '#000000' },
      { name: '', color: '#000000' },
      { name: '色不正', color: 'red' },
      { name: '予算不正', color: '#111', budgetMaxMinutes: -5 },
    ],
  });
  const result = parseSettingsImport(text, { allowedSettingKeys: ['workStart', 'quickLinks', 'monthTagOrders'] });
  assert.deepStrictEqual(result.settings, { workStart: '10:00', quickLinks: [] });
  assert.deepStrictEqual(result.tags, [
    { name: '会議', color: '#2563eb', budgetMinMinutes: 30 },
    { name: '予算不正', color: '#111' },
  ]);
});

test('インポート: 形式・バージョン違いやJSON以外は例外にする', () => {
  assert.throws(() => parseSettingsImport('not json'), /JSON/);
  assert.throws(() => parseSettingsImport(JSON.stringify({ format: 'other', version: 1 })), /設定ファイルではありません/);
  assert.throws(() => parseSettingsImport(JSON.stringify({ format: SETTINGS_EXPORT_FORMAT, version: 2 })), /バージョン/);
});

test('エクスポート→インポートの往復で設定とタグが保たれる', () => {
  const settings = { workStart: '09:00', quickLinks: [{ label: 'A', url: 'https://a.example/' }] };
  const tags = [{ id: 'x', name: '作業', color: '#16a34a' }];
  const text = JSON.stringify(buildSettingsExport(settings, tags));
  const result = parseSettingsImport(text, { allowedSettingKeys: Object.keys(settings) });
  assert.deepStrictEqual(result.settings, settings);
  assert.deepStrictEqual(result.tags, [{ name: '作業', color: '#16a34a' }]);
});

if (failed) {
  console.log(`\n${failed}件失敗。`);
  process.exit(1);
}
console.log('\n全テスト成功。');
