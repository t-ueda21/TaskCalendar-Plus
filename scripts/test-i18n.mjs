import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveLocale, t, setLocale, formatDuration, formatDate, LANGUAGES, catalogs } from '../src-tauri/renderer/src/i18n.js';

// A missing locale branch would silently show Japanese for a mandatory language.
for (const [setting, os, want] of [
  ['auto', 'ko-KR', 'ko'], ['auto', 'zh-Hant-HK', 'zh-TW'], ['auto', 'zh-Hans-CN', 'zh-CN'],
  ['auto', 'en-US', 'en'], ['auto', 'pt-BR', 'pt'], ['auto', 'ar-SA', 'ja'],
  ['de', 'ja-JP', 'de'], ['invalid', 'en-US', 'ja'],
]) assert.equal(resolveLocale(setting, os), want);
assert.equal(LANGUAGES.length, 9);
for (const language of LANGUAGES) assert.deepEqual(Object.keys(catalogs[language.code]).sort(), Object.keys(catalogs.ja).sort());
assert.deepEqual(JSON.parse(fs.readFileSync('src-tauri/renderer/src/locales/catalogs.json','utf8')),catalogs,'native and renderer catalogs match');
for (const file of fs.readdirSync('src-tauri/renderer/src').filter(name=>name.endsWith('.js'))) {
  const source=fs.readFileSync(`src-tauri/renderer/src/${file}`,'utf8');
  for(const match of source.matchAll(/\b(?:t|th|translate|translateHtml)\(['"]([a-zA-Z0-9_.]+)['"]/g)) assert.ok(Object.hasOwn(catalogs.ja,match[1]),`translation key ${match[1]} in ${file}`);
}
for(const [key,japanese] of Object.entries(catalogs.ja)) {
  const placeholders=text=>[...text.matchAll(/\{(\w+)\}/g)].map(match=>match[1]).sort();
  for(const language of LANGUAGES) assert.deepEqual(placeholders(catalogs[language.code][key]),placeholders(japanese),`${language.code}: ${key} placeholders`);
}
setLocale('en'); assert.equal(t('common.save'), 'Save'); assert.equal(t('work.duration', { hours: 2, minutes: 5 }), '2 h 5 min');
assert.equal(formatDuration(125), '2 h 5 min');
setLocale('ko'); assert.equal(t('common.save'), '저장');
setLocale('ja'); assert.equal(formatDuration(125), '2時間5分');
assert.match(formatDate(new Date(2026, 9, 7)), /2026/);
assert.equal(t('unknown.key'), 'unknown.key');
assert.equal(t('user.supplied.title'), 'user.supplied.title');
console.log('PASS: nine complete locale catalogs, OS matching, explicit settings, durations and dates');
