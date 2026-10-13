import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// Every native action is scoped to a child this test launched. Never locate or kill
// an application by image name: the user's installed app may also be running.
const data = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tcplus-single-')));
const sourceExe = path.resolve(process.env.TCPLUS_E2E_EXE || 'src-tauri/target/debug/taskcalendar-plus.exe');
const exe = path.join(data, 'taskcalendar-plus.exe');
fs.copyFileSync(sourceExe,exe);
console.log(`Test-owned profile: ${data}`);
const env = {...process.env, TCPLUS_DATA_DIR: data, TCPLUS_ALLOW_EXTERNAL_SYNC: '0',
  TCPLUS_RUN_LIVE_OUTLOOK_TESTS: '0', WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'webview2')};
const db = new DatabaseSync(path.join(data, 'tasks.db'));
db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
db.prepare('INSERT INTO settings VALUES (?, ?)').run('main', JSON.stringify({
  uiLanguage: 'en', outlookWriteEnabled:false, outlookAutoSync: false, outlookUrl: '', checkUpdatesOnStartup: false, trayEnabled: true,
}));
db.close();
const children = [];
const launch = () => {
  const child = spawn(exe, [], {env, stdio: 'ignore', windowsHide: true});
  child.on('error', error => {child.launchError = error;});
  children.push(child);
  return child;
};
const run = promisify(execFile);
const native = async (child, action = 'state') => {
  assert(children.includes(child), 'native target must belong to this test');
  assert.equal(child.exitCode, null, 'native target must still be running');
  const {stdout} = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    path.resolve('scripts/single-instance-native.ps1'), '-ProcessId', String(child.pid), '-Action', action]);
  return JSON.parse(stdout);
};
const wait = async (description, condition, timeout = 45000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out: ${description}`);
};
const exited = child => wait(`process ${child.pid} exits`, () => {
  if (child.launchError) throw child.launchError;
  return child.exitCode !== null || child.signalCode !== null;
});
const ready = child => wait(`window and HTTP listener for ${child.pid}`, async () => {
  if (child.launchError) throw child.launchError;
  const state = await native(child);
  return state.found && state.ports.length === 1;
});
const secondLaunch = async original => {
  const child = launch();
  await exited(child);
  assert.equal(child.exitCode, 0, 'secondary exits successfully');
  await wait('original window restored', async () => {
    const state = await native(original);
    assert.equal(state.ports.length, 1, 'exactly one original HTTP server');
    return state.visible && !state.minimized;
  });
};
const stop = async child => {
  if(child.restarted) {
    await run('powershell.exe',['-NoProfile','-NonInteractive','-File',path.resolve('scripts/single-instance-native.ps1'),'-ProcessId',String(child.pid),'-Action','terminate','-ExpectedExe',exe,'-ExpectedParent',String(child.parentPid)]);
    child.exitCode=0;
  } else if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited(child); }
};
try {
  let original = launch();
  await ready(original);
  await secondLaunch(original);
  console.log('PASS normal second launch: original window and one HTTP listener');
  await native(original, 'minimize');
  await wait('original minimized', async () => (await native(original)).minimized);
  await secondLaunch(original);
  console.log('PASS minimized second launch: original restored');
  await native(original, 'close');
  await wait('close to tray hides original', async () => !(await native(original)).visible);
  await secondLaunch(original);
  console.log('PASS tray second launch: original restored');
  const burst = Array.from({length: 6}, launch);
  await Promise.all(burst.map(exited));
  for (const child of burst) assert.equal(child.exitCode, 0);
  assert.equal((await native(original)).ports.length, 1);
  console.log('PASS six-launch burst: no independent process or HTTP server survives');
  const restarting=original;
  await native(restarting,'restart');
  await exited(restarting);
  assert.equal(restarting.exitCode,0,'tray restart exits old app cleanly');
  let replacementPid;
  await wait('restart creates replacement child',async()=>{
    const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-File',path.resolve('scripts/single-instance-native.ps1'),'-ProcessId',String(restarting.pid),'-Action','replacement','-ExpectedExe',exe]);
    const ids=JSON.parse(stdout).pids;assert(ids.length<=1,'restart has only one replacement');replacementPid=ids[0];return Boolean(replacementPid);
  });
  original={pid:replacementPid,parentPid:restarting.pid,exitCode:null,signalCode:null,restarted:true};children.push(original);
  await ready(original);await secondLaunch(original);
  console.log('PASS actual tray restart: replacement becomes sole primary with one HTTP server');
  await stop(original);
  fs.copyFileSync(sourceExe,exe); // Replace only this test's executable, never the installed app.
  original = launch();
  await ready(original);
  await secondLaunch(original);
  console.log('PASS installer-style exit, executable replacement, relaunch: lock released and new primary works (no installer run)');
  await native(original,'quit');await exited(original);assert.equal(original.exitCode,0,'tray Quit exits normally');
  const pair = [launch(), launch()];
  await wait('simultaneous launch elects one primary', () => pair.filter(c => c.exitCode === 0).length === 1);
  const survivor = pair.find(c => c.exitCode === null);
  assert(survivor);
  await ready(survivor);
  await secondLaunch(survivor);
  console.log('PASS simultaneous startup: one primary and one HTTP listener');
  console.log(`Evidence profile: ${data}`);
} finally {
  await Promise.all(children.map(stop));
}
