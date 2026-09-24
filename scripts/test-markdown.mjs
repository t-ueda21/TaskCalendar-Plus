// src-tauri/renderer/src/markdown.js(AIの回答のMarkdown表示)のテスト。
import assert from 'assert';
import { renderMarkdown } from '../src-tauri/renderer/src/markdown.js';

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

test('HTMLはエスケープされ、実行されない', () => {
  const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)> **太字**');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<strong>太字</strong>'));
});

test('実際の回答例(太字と箇条書き)', () => {
  const html = renderMarkdown([
    '今月の空き工数は **30時間30分** です。残りの稼働可能時間40時間のうち、9時間30分は予定が登録されています。',
    '',
    'タグ予算では：',
    '- **会議**：あと9時間30分使えます。',
    '- **開発**：上限40時間に対して実績90時間で、50時間超過しています。',
  ].join('\n'));
  assert.strictEqual(html, '<p>今月の空き工数は <strong>30時間30分</strong> です。残りの稼働可能時間40時間のうち、9時間30分は予定が登録されています。</p>'
    + '<p>タグ予算では：</p>'
    + '<ul><li><strong>会議</strong>：あと9時間30分使えます。</li><li><strong>開発</strong>：上限40時間に対して実績90時間で、50時間超過しています。</li></ul>');
});

test('入れ子の箇条書き・「・」の箇条書き・番号付きリスト', () => {
  const nested = renderMarkdown('- 9月24日(木)\n  - 09:30 定例\n  - 10:00 API実装\n- 9月25日(金)');
  assert.strictEqual(nested, '<ul><li>9月24日(木)<ul><li>09:30 定例</li><li>10:00 API実装</li></ul></li><li>9月25日(金)</li></ul>');
  assert.strictEqual(renderMarkdown('・会議\n・開発'), '<ul><li>会議</li><li>開発</li></ul>');
  assert.strictEqual(renderMarkdown('1. 一つ目\n2. 二つ目'), '<ol><li>一つ目</li><li>二つ目</li></ol>');
});

test('見出し・段落内の改行・区切り線・引用', () => {
  assert.strictEqual(renderMarkdown('## まとめ\n一行目\n二行目'), '<div class="mdHeading mdH2">まとめ</div><p>一行目<br>二行目</p>');
  assert.strictEqual(renderMarkdown('---'), '<hr>');
  assert.strictEqual(renderMarkdown('> 注意\n> 二行目'), '<blockquote>注意<br>二行目</blockquote>');
});

test('コード(インライン・ブロック)の中は記法を変換しない', () => {
  assert.strictEqual(renderMarkdown('`**a**` と *斜体*'), '<p><code>**a**</code> と <em>斜体</em></p>');
  assert.strictEqual(renderMarkdown('```\n**x** <b>\n```'), '<pre><code>**x** &lt;b&gt;</code></pre>');
});

test('表', () => {
  const html = renderMarkdown('| タグ | 実績 |\n|---|---|\n| 会議 | 10時間30分 |\n| 開発 | **90時間** |');
  assert.strictEqual(html, '<table><thead><tr><th>タグ</th><th>実績</th></tr></thead>'
    + '<tbody><tr><td>会議</td><td>10時間30分</td></tr><tr><td>開発</td><td><strong>90時間</strong></td></tr></tbody></table>');
});

test('リンクは http/https だけ', () => {
  assert.strictEqual(renderMarkdown('[公式](https://example.com/a)'), '<p><a href="https://example.com/a">公式</a></p>');
  assert.ok(!renderMarkdown('[x](javascript:alert(1))').includes('<a '));
});

test('記法の無い文章はそのまま段落になる', () => {
  assert.strictEqual(renderMarkdown('9月の設計レビューは、2件で合計4時間です。'), '<p>9月の設計レビューは、2件で合計4時間です。</p>');
  assert.strictEqual(renderMarkdown(''), '');
});

if (failed) {
  console.log(`\n${failed}件失敗。`);
  process.exit(1);
}
console.log('\n全テスト成功。');
