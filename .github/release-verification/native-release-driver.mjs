import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {nativeApp as launch,delay} from '../../app-source/scripts/native-test-driver.mjs';
export {delay};
export async function nativeApp(options={}) {
  const exe=options.exe||process.env.VERIFY_EXE;
  if(!exe)throw Error('Packaged executable is required');
  const snapshot=path.join(process.env.RUNNER_TEMP,`taskcalendar-webview-${randomUUID()}.json`);
  const args=['-NoProfile','-NonInteractive','-File',path.resolve('.github/release-verification/configure-webview.ps1')];
  const call=extra=>execFileSync('powershell.exe',[...args,...extra],{timeout:20000,encoding:'utf8'});
  const restore=()=>{call(['-Action','restore','-Snapshot',snapshot]);fs.rmSync(snapshot,{force:true});};
  call(['-Action','apply','-Snapshot',snapshot,'-ExecutableName',path.basename(exe),'-DataDir',path.join(options.dataDir,'webview2'),'-Port',String(options.port)]);
  let app;
  try {app=await launch({...options,exe});} catch(error){restore();throw error;}
  const close=app.close;
  app.close=async()=>{try{await close();}finally{restore();}};
  return app;
}
