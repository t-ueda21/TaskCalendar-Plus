import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const data=fs.mkdtempSync(path.join(os.tmpdir(),'tcplus-single-'));
const exe=path.resolve(process.env.TCPLUS_E2E_EXE||'src-tauri/target/debug/taskcalendar-plus.exe');
const env={...process.env,TCPLUS_DATA_DIR:data,WEBVIEW2_USER_DATA_FOLDER:path.join(data,'webview2')};
const launch=()=>spawn(exe,[],{env,stdio:'ignore',windowsHide:true});
const first=launch();let second,third;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  await sleep(3500);assert.equal(first.exitCode,null,'first instance stays running');
  second=launch();await sleep(3000);
  assert.equal(second.exitCode,0,'second instance exits instead of running a second app');
  assert.equal(first.exitCode,null,'original instance is retained');
  first.kill();await sleep(1500);third=launch();await sleep(3000);
  assert.equal(third.exitCode,null,'application can restart after original process exits');
  third.kill();await sleep(1500);
  const pair=[launch(),launch()];await sleep(3500);
  assert.equal(pair.filter(child=>child.exitCode===null).length,1,'simultaneous startup retains exactly one instance');
  for(const child of pair)if(child.exitCode===null)child.kill();
  console.log('PASS: second instance exits, original retained, lock released on exit');
} finally {
  for(const child of [first,second,third])if(child&&child.exitCode===null)child.kill();
}
