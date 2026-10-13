import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const script=path.resolve('scripts/release-manifest.mjs');
const base=fs.mkdtempSync(path.join(os.tmpdir(),'tcplus-release-test-'));
const nsis=path.join(base,'src-tauri/target/release/bundle/nsis');
fs.mkdirSync(nsis,{recursive:true});fs.mkdirSync(path.join(base,'docs/releases'),{recursive:true});
const write=(file,text)=>fs.writeFileSync(path.join(base,file),text);
function fixture(version){
  write('src-tauri/tauri.conf.json',JSON.stringify({version}));
  write('src-tauri/Cargo.toml',`[package]\nname = "taskcalendar-plus"\nversion = "${version}"\n`);
  write('src-tauri/Cargo.lock',`[[package]]\nname = "taskcalendar-plus"\nversion = "${version}"\n`);
  write(`docs/releases/v${version}.md`,'Fixture release notes');
  const file=`TaskCalendar+_${version}_x64-setup.exe`;
  fs.writeFileSync(path.join(nsis,file),'fixture installer');fs.writeFileSync(path.join(nsis,file+'.sig'),'fixture-signature');
  return file;
}
function run(version,...args){
  return spawnSync(process.execPath,[script,...args],{cwd:base,encoding:'utf8',windowsHide:true,env:{...process.env,RELEASE_TAG:`v${version}`,GITHUB_REPOSITORY:'owner/project'}});
}
try{
  const pre=fixture('3.0.0-pre.1');
  const stale='unchanged stable feed';fs.writeFileSync(path.join(nsis,'latest.json'),stale);
  const checked=run('3.0.0-pre.1','--check');assert.equal(checked.status,0,checked.stderr);
  const generated=run('3.0.0-pre.1');assert.equal(generated.status,0,generated.stderr);
  assert.equal(fs.readFileSync(path.join(nsis,'latest.json'),'utf8'),stale,'a prerelease must not overwrite a stable feed');
  const assets=run('3.0.0-pre.1','--assets');assert.equal(assets.status,0,assets.stderr);
  assert.deepEqual(JSON.parse(assets.stdout).map(p=>path.basename(p)),[pre,pre+'.sig'],'prerelease asset allowlist must exclude latest.json');
  const stable=fixture('3.0.0');const stableRun=run('3.0.0');assert.equal(stableRun.status,0,stableRun.stderr);
  const feed=JSON.parse(fs.readFileSync(path.join(nsis,'latest.json'),'utf8'));
  assert.equal(feed.version,'3.0.0');assert.equal(feed.platforms['windows-x86_64'].signature,'fixture-signature');
  assert.equal(feed.platforms['windows-x86_64'].url,'https://github.com/owner/project/releases/download/v3.0.0/'+encodeURIComponent(stable));
  assert.deepEqual(JSON.parse(run('3.0.0','--assets').stdout).map(p=>path.basename(p)),[stable,stable+'.sig','latest.json']);
  for(const invalid of ['03.0.0','3.0','3.0.0-pre.01','3.0.0-','3.0.0-foo..bar']){
    fixture(invalid);assert.notEqual(run(invalid,'--check').status,0,invalid);
  }
  fixture('3.0.0-pre.1');assert.notEqual(run('0.3.0-pre.1','--check').status,0,'tag mismatch');
  write('src-tauri/Cargo.lock','[[package]]\nname = "taskcalendar-plus"\nversion = "3.0.0"\n');
  assert.notEqual(run('3.0.0-pre.1','--check').status,0,'lock version mismatch');
  console.log('PASS: prerelease isolation, asset allowlist, stable feed, SemVer and version consistency');
}finally{
  const resolved=path.resolve(base),tmp=path.resolve(os.tmpdir())+path.sep;
  if(!resolved.startsWith(tmp)||!path.basename(resolved).startsWith('tcplus-release-test-'))throw Error('Unsafe fixture cleanup path');
  fs.rmSync(resolved,{recursive:true,force:true});
}
