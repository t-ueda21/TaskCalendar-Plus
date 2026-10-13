// Reviewed, side-effect-bounded checks only. No native app or native E2E command is accepted.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { prepareCompilerEnvironment } from './refactor-20261008-msvc.mjs';

const root=path.resolve(process.argv[2]||'.');
const output=path.resolve(process.argv[3]||'out/refactor-20261008/checks-probe');
const mode=process.argv[4]||'all';
if(!['all','node'].includes(mode))throw Error('Mode must be all or node');
if(fs.existsSync(output))throw Error('Evidence output already exists: '+output);
fs.mkdirSync(output,{recursive:true});
const contractPath=process.argv[5]?path.resolve(process.argv[5]):null;
const contract=contractPath&&fs.existsSync(contractPath)?JSON.parse(fs.readFileSync(contractPath,'utf8')):null;
const scripts=contract?.nodeTests??fs.readdirSync(path.join(root,'scripts')).filter(name=>/^test-.*\.(mjs|js)$/.test(name)).sort();
const results=[],cases=[];
const compiler=mode==='all'?prepareCompilerEnvironment(output):{env:{...process.env},metadata:null};
const fingerprint=()=>{
  const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):[path.join(dir,entry.name)]);
  const files=[...walk(path.join(root,'src-tauri/src')),...walk(path.join(root,'src-tauri/renderer')),...scripts.map(file=>path.join(root,'scripts',file))];
  return crypto.createHash('sha256').update(JSON.stringify(files.sort().map(file=>[path.relative(root,file).replaceAll('\\','/'),crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]))).digest('hex');
};
const sourceSha256=fingerprint();
const version=program=>spawnSync(program,['--version'],{encoding:'utf8',windowsHide:true}).stdout.trim();
const versions={node:process.version,cargo:version('cargo'),rustc:version('rustc')};
const nodeRuntime={path:process.execPath,realPath:fs.realpathSync(process.execPath),version:process.version,sha256:crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),bytes:fs.statSync(process.execPath).size};
const write=()=>fs.writeFileSync(path.join(output,'checks.json'),JSON.stringify({sourceRoot:root,sourceSha256,versions,nodeRuntime,compiler:compiler.metadata,mode,contract:contract?contractPath:null,results,cases},null,2));
function run(id,program,args,input){
  const started=performance.now();const result=spawnSync(program,args,{cwd:root,encoding:'utf8',input,windowsHide:true,timeout:240000,maxBuffer:32*1024*1024,env:{...compiler.env,CARGO_NET_OFFLINE:'true'}});
  const log=String(result.stdout||'')+String(result.stderr||'')+(result.error?'\n'+result.error.stack:'');
  fs.writeFileSync(path.join(output,id+'.log'),log);
  const row={id,program,args,...(program===process.execPath?{programIdentity:{kind:'node',sha256:nodeRuntime.sha256,version:nodeRuntime.version}}:{}),status:result.status===0&&!result.error?'passed':'failed',exitCode:result.status,elapsedMs:performance.now()-started,log:id+'.log'};
  results.push(row);
  if(id==='rust'){
    for(const line of log.split(/\r?\n/)){
      const match=/^test (\S+) \.\.\. (ok|ignored|FAILED)/.exec(line);
      if(match)cases.push({id:'rust:'+match[1],required:match[2]!=='ignored',status:match[2]==='ok'?'passed':match[2]==='ignored'?'not-run':'failed',evidence:row.log,reason:match[2]==='ignored'?'Live Outlook integration is intentionally excluded':undefined});
    }
  }else cases.push({id,required:true,status:row.status,evidence:row.log});
  write();console.log((row.status==='passed'?'PASS':'FAIL')+': '+id);
  if(row.status!=='passed'){console.log(log.slice(-12000));process.exitCode=1;return false;}return true;
}
let proceed=true;
for(const name of scripts){if(!/^test-[\w-]+\.(mjs|js)$/.test(name))throw Error('Unsafe test filename');if(!(proceed=run('node-'+name,process.execPath,['scripts/'+name])))break;}
if(proceed){
  const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):entry.name.endsWith('.js')?[path.join(dir,entry.name)]:[]);
  let errors='';let count=0;const started=performance.now();
  for(const file of walk(path.join(root,'src-tauri/renderer/src'))){const checked=spawnSync(process.execPath,['--input-type=module','--check'],{cwd:root,encoding:'utf8',input:fs.readFileSync(file,'utf8'),windowsHide:true,timeout:10000});count++;if(checked.status!==0)errors+=path.relative(root,file)+'\n'+checked.stderr;}
  fs.writeFileSync(path.join(output,'javascript-syntax.log'),errors||`${count} JavaScript files parsed successfully\n`);
  const row={id:'javascript-syntax',status:errors?'failed':'passed',files:count,elapsedMs:performance.now()-started,log:'javascript-syntax.log'};results.push(row);cases.push({id:row.id,required:true,status:row.status,evidence:row.log});proceed=!errors;write();console.log((proceed?'PASS':'FAIL')+': javascript-syntax ('+count+' files)');
}
if(proceed&&mode==='all')proceed=run('rust','cargo',['test','--offline','--manifest-path','src-tauri/Cargo.toml','--','--test-threads=1']);
if(proceed&&mode==='all')proceed=run('clippy','cargo',['clippy','--offline','--manifest-path','src-tauri/Cargo.toml','--all-targets','--','-D','warnings']);
if(!proceed)process.exitCode=1;
if(fingerprint()!==sourceSha256){cases.push({id:'source-stability',required:true,status:'failed',evidence:'Source or tests changed during check run'});process.exitCode=1;}
write();
console.log(JSON.stringify({commands:results.length,passedCommands:results.filter(row=>row.status==='passed').length,requiredCases:cases.filter(row=>row.required).length,passedCases:cases.filter(row=>row.required&&row.status==='passed').length,notRun:cases.filter(row=>row.status==='not-run').length,output}));
