import assert from 'node:assert/strict';
import { parseBackupFile } from '../src-tauri/renderer/src/transfer-file.js';
const valid={format:'taskcalendar-plus-backup',version:1,tasks:[],tags:[],settings:{},aiMemory:{summary:{},notes:{},chat:{}}};
assert.deepEqual(parseBackupFile(JSON.stringify(valid)),valid);
for(const input of ['bad',JSON.stringify({...valid,format:'other'}),JSON.stringify({...valid,version:2}),JSON.stringify({...valid,tasks:{}}),JSON.stringify({...valid,aiMemory:{}})])assert.throws(()=>parseBackupFile(input));
console.log('PASS: backup file format/version/structure is checked before enabling restore');
