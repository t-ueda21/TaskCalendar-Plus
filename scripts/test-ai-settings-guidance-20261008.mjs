import assert from 'node:assert/strict';
import fs from 'node:fs';
import { catalogs } from '../src-tauri/renderer/src/locales/catalogs.js';
import {setLocale,t} from '../src-tauri/renderer/src/i18n.js';
const fixture=JSON.parse(fs.readFileSync(new URL('./refactor-20261008-guidance-values.json',import.meta.url),'utf8'));
const native=JSON.parse(fs.readFileSync(new URL('../src-tauri/renderer/src/locales/catalogs.json',import.meta.url),'utf8'));
assert.equal(fixture.changes.length,36);assert.equal(new Set(fixture.changes.map(row=>row.locale)).size,9);
for(const row of fixture.changes){
  setLocale(row.locale);
  assert.equal(catalogs[row.locale][row.key],row.after,'Renderer guidance '+row.locale+' '+row.key);
  assert.equal(native[row.locale][row.key],row.after,'Native guidance '+row.locale+' '+row.key);
  assert.equal(t(row.key),row.after,'Resolved guidance '+row.locale+' '+row.key);
  assert.notEqual(row.after,row.before);
}
console.log('PASS: 36 guidance values in nine locales point to the existing Settings AI page in renderer, native catalog and resolved translation');
