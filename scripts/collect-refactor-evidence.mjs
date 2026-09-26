// Convert successful runner output to stable case IDs and before/after evidence.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const phase = process.argv[2];
if (!['before', 'after'].includes(phase)) throw new Error('Usage: node scripts/collect-refactor-evidence.mjs before|after');
const run = 'out/refactor-20260927';
const config = JSON.parse(fs.readFileSync(run + '/config.json', 'utf8'));
const checksPath = process.argv[3] || run + '/' + phase + '-checks.json';
const checks = JSON.parse(fs.readFileSync(checksPath, 'utf8'));
if (checks.results.length !== config.commands.length || checks.results.some(row => row.status !== 'passed')) {
  throw new Error('Required commands did not all pass; do not seal a successful baseline');
}
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const cases = [];
const definitions = [];
for (const result of checks.results) {
  if (!(result.id === 'rust' || result.id.startsWith('js-') || result.id.startsWith('e2e-'))) continue;
  const command = config.commands.find(row => row.id === result.id);
  const logPath = path.join(run, result.log);
  const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
  const found = [];
  lines.forEach((line, index) => {
    const rust = result.id === 'rust' && /^test (\S+) \.\.\. (ok|ignored|FAILED)(?:.*)$/.exec(line);
    const passed = /^PASS: (.+)$/.exec(line);
    if (rust) found.push({name: rust[1], status: rust[2] === 'ok' ? 'passed' : rust[2] === 'ignored' ? 'not-run' : 'failed', line: index + 1});
    else if (passed) found.push({name: passed[1], status: 'passed', line: index + 1});
  });
  if (!found.length) found.push({name: result.id + ': all assertions', status: 'passed', line: 1});
  for (const item of found) {
    const id = result.id + '-' + sha(item.name).slice(0, 12);
    const required = item.status !== 'not-run';
    const source = result.id === 'rust' ? 'src-tauri/src/' + item.name.split('::')[0] + '.rs' : command.argv.at(-1);
    cases.push({id, required, status: item.status, evidence: result.log + '#L' + item.line, name: item.name, source});
    definitions.push({id, feature: item.name, source, required,
      preconditions: result.id.startsWith('e2e-') ? '新規の隔離DB・WebView2プロファイル／合成データ' : '当該試験で生成する固定入力・モック／一時DB',
      steps: command.argv.join(' ') + ' → ' + item.name,
      expected: '指定した試験の表示・データ・例外条件のassertをすべて満たす',
      notes: required ? '詳細な入出力・手順は試験ソースと機能契約表に対応' : '実Outlook接続が必要なため未実施。成功率に含めない'});
  }
}
for (const [id, reason] of [
  ['LIVE-AI', '実AI契約への送信は未実施。偽CLI・モデル応答とUIの契約を検査する'],
  ['LIVE-INSTALLER', '公開更新のインストールは未実施。更新状態・保存・署名失敗の契約を検査する'],
  ['LIVE-AUTOSTART', 'Windowsログイン時の実登録変更は未実施。設定・ブリッジの契約を検査する'],
]) cases.push({id, required:false, status:'not-run', evidence:reason});
cases.sort((a,b) => a.id.localeCompare(b.id));
if (new Set(cases.map(row => row.id)).size !== cases.length) throw new Error('Duplicate case IDs');
fs.writeFileSync(run + '/' + phase + '-cases.json', JSON.stringify({cases}, null, 2), {flag:'wx'});

const raw = JSON.parse(fs.readFileSync('out/performance/refactor-current.json', 'utf8'));
const metrics = [];
for (const row of raw) {
  if (row.dayTasks !== 10 || row.monthMinutes !== 960 || row.hiddenMutations !== 0 || row.unchangedBodyBytes !== 0) {
    throw new Error('Benchmark data/result invariants failed');
  }
  for (const [field, unit] of [['lookup100Ms','ms'], ['summary100Ms','ms'], ['unchangedRefreshMs','ms'], ['unchangedBodyBytes','bytes'], ['jsHeapBytes','bytes']]) {
    const samples = row.rawSamples[field];
    if (!Array.isArray(samples) || samples.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('Raw numeric samples are required: ' + field);
    }
    metrics.push({id:'tasks.'+row.count+'.'+field, unit, direction:'lower', samples,
      tolerance_percent: field === 'unchangedBodyBytes' ? 0 : field === 'jsHeapBytes' ? 20 : 30,
      tolerance_absolute: field === 'unchangedBodyBytes' ? 0 : field === 'jsHeapBytes' ? 2*1024*1024 : 2,
      context:{tasks:row.count,cache:'warm',queries:field.includes('100')?100:1}});
  }
}
const measurements = {context:{environment:sha(os.hostname()).slice(0,12),os:os.release(),cpu:os.cpus()[0]?.model,
  memoryBytes:os.totalmem(),runtime:process.version,browser:raw[0].browser,mode:'native-debug-warm',workload:'weekday10-half-hour-v1-date20260925'},metrics};
fs.writeFileSync(run + '/' + phase + '-metrics.json', JSON.stringify(measurements, null, 2), {flag:'wx'});
fs.copyFileSync('out/performance/refactor-current.json', run + '/' + phase + '-benchmark-raw.json', fs.constants.COPYFILE_EXCL);
fs.cpSync(run + '/ui-current', run + '/' + phase + '-ui', {recursive:true,errorOnExist:true,force:false});
const exe = 'src-tauri/target/model-picker/debug/taskcalendar-plus.exe';
const executable = fs.readFileSync(exe);
fs.writeFileSync(run + '/' + phase + '-build.json', JSON.stringify({path:exe,sha256:sha(executable),bytes:executable.length,builtAt:fs.statSync(exe).mtime.toISOString()},null,2), {flag:'wx'});

if (phase === 'before') {
  const quote = value => '"' + String(value ?? '').replaceAll('"','""') + '"';
  const columns = ['id','feature','source','required','preconditions','steps','expected','notes'];
  const csv = [columns.join(','), ...definitions.sort((a,b)=>a.id.localeCompare(b.id)).map(row=>columns.map(column=>quote(row[column])).join(','))].join('\n')+'\n';
  fs.writeFileSync('docs/refactor/2026-09-27-case-matrix.csv', csv, {flag:'wx'});
}
console.log(JSON.stringify({phase,required:cases.filter(row=>row.required).length,passed:cases.filter(row=>row.required&&row.status==='passed').length,notRun:cases.filter(row=>row.status==='not-run').length,metrics:metrics.length}));
