// Offline evidence runner: filesystem, read-only git metadata, VM and CPU clock only.
// No application process, server, browser, native bridge or network is imported.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createEnvironment,FakeRoot,FakeNode,serialize,outcome} from './vm-harness.mjs';
import {numericValues,minuteValues,dateValues,dateOptions,renderScenarios,renderFixture} from './fixtures.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../..');
const contract=JSON.parse(fs.readFileSync(path.join(here,'contract.json'),'utf8'));
const out=path.join(root,contract.output_root);
const args=process.argv.slice(2),mode=args[0]??'check',label=args[1]??'after';
const sourceRoot=args[2]?path.resolve(args[2]):root;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const readJson=name=>JSON.parse(fs.readFileSync(path.join(out,name),'utf8'));
function write(name,value){const target=path.join(out,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});}
function git(...argv){const result=spawnSync('git',argv,{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return result.stdout.trim();}
function sourceFiles(){return git('ls-files','--','src-tauri','scripts/test-summary-model.mjs','scripts/test-summary-preferences.mjs').split('\n').filter(Boolean).filter(file=>!/(^|\/)(target|gen|node_modules|vendor|out|dist|build)(\/|$)/.test(file)&&!file.includes('.codex-remote-attachments'));}
function fingerprint(file,base=root){const data=fs.readFileSync(path.join(base,file)),text=data.toString('utf8'),lines=text.replace(/\r\n/g,'\n').split('\n');if(lines.at(-1)==='')lines.pop();return {path:file,sha256:sha(data),bytes:data.length,physical_lines:lines.length,nonblank_lines:lines.filter(line=>line.trim()).length};}
function classify(file){if(file.startsWith('scripts/')||/(?:^|\/)(?:[^/]*_tests|tests|live_tests)\.rs$/.test(file))return 'tests';if(/\.(js|rs)$/.test(file)&&!file.includes('/build.rs'))return 'application_source';if(/\.(html|css)$/.test(file))return 'ui_source';if(/\.(md|txt)$/.test(file))return 'documents';if(/(Cargo\.(toml|lock)|\.json|build\.rs)$/.test(file))return 'configuration';return 'assets';}
function codeMetrics(base){const files=[...readJson('source-manifest.json').files.map(row=>row.path)];const added='src-tauri/renderer/src/summary-format.js';if(fs.existsSync(path.join(base,added))&&!files.includes(added))files.push(added);const records=files.map(file=>({...fingerprint(file,base),group:classify(file)}));const total=rows=>rows.reduce((sum,row)=>({files:sum.files+1,bytes:sum.bytes+row.bytes,physical_lines:sum.physical_lines+row.physical_lines,nonblank_lines:sum.nonblank_lines+row.nonblank_lines}),{files:0,bytes:0,physical_lines:0,nonblank_lines:0});return {groups:Object.fromEntries([...new Set(records.map(row=>row.group))].map(group=>[group,total(records.filter(row=>row.group===group))])),formatter_feature:total(records.filter(row=>contract.allowed_product_changes.includes(row.path))),files:records,note:'Physical/nonblank lines include comments; Rust runtime files may include embedded test modules. Separate test files are excluded from application_source. UI source, configuration, assets, documentation, harness and generated evidence are separate.'};}

async function collect(options={}){
  const env=await createEnvironment(sourceRoot,contract,options),{renderer:r,i18n}=env;const cases=[];
  const add=(id,feature,value)=>cases.push({id,feature,required:true,value:serialize(value)});
  for(const locale of contract.locales){
    assert.equal(i18n.setLocale(locale),locale);
    add(`FMT-NUM-${locale}`,'localized numeric values, grouping, fractions and coercion',[0,1,2].map(digits=>numericValues.map(value=>outcome(()=>r.number(value,digits)))));
    add(`FMT-TIME-${locale}`,'hour/minute split, units, rounding, negatives, zero and non-finite inputs',minuteValues.map(value=>({parts:outcome(()=>r.timeParts(value)),markup:outcome(()=>r.timeMarkup(value))})));
    add(`FMT-DATE-${locale}`,'date/year limits, leap dates, month keys and option/timezone identity',dateValues.map(key=>({key,formats:dateOptions.map(options=>outcome(()=>r.dateText(key,options))),monthGroup:outcome(()=>r.groupLabel({key},'month')),yearGroup:outcome(()=>r.groupLabel({key},'year'))})));
    add(`FMT-ERROR-${locale}`,'existing invalid-input outcomes and recovery',[
      ...['','bad','2026-13-01',null,undefined,42].map(key=>outcome(()=>r.dateText(key,{month:'short'}))),
      ...[-1,101,NaN].map(digits=>outcome(()=>r.number(12.5,digits))),
      outcome(()=>r.dateText('2026-10-08',{month:'invalid'})),outcome(()=>r.dateText('2026-10-08',{timeZone:'bad'})),
      outcome(()=>r.timeParts(Symbol('bad'))),outcome(()=>r.number(12.5,1)),outcome(()=>r.dateText('2026-10-08',{month:'short'}))]);
    const mutable={month:'short'},mutableResults=[r.dateText('2026-10-08',mutable)];mutable.month='long';mutableResults.push(r.dateText('2026-10-08',mutable));
    let conversions=0;const objectDigits={valueOf(){conversions++;return 1;}};
    const optionResults=[outcome(()=>r.number(12.56,objectDigits)),outcome(()=>r.number(12.56,objectDigits)),outcome(()=>r.number(12.56,'1')),outcome(()=>r.number(12.56,null)),outcome(()=>r.number(12.56,1n)),outcome(()=>r.dateText('2026-10-08',{timeZone:undefined,month:'short'})),outcome(()=>r.dateText('2026-10-08',{month:'short',timeZone:'Asia/Tokyo'})),outcome(()=>r.dateText('2026-10-08',{timeZone:'Asia/Tokyo',month:'short'}))];
    add(`FMT-OPTIONS-${locale}`,'mutable options, equivalent key order, explicit undefined timezone and option coercion',{mutableResults,optionResults,conversions});
    for(const spec of renderScenarios){
      const {model,state}=renderFixture(spec),before=serialize(model),fake=new FakeRoot(env.document);env.document.activeElement=null;
      if(spec.focusKey){const old=new FakeNode(fake,{'data-summary-day':spec.focusKey});fake.querySelector('[data-summary-number-grid]').children.push(old);env.document.activeElement=old;}
      r.renderSummary(fake,model,state);
      assert.deepEqual(serialize(model),before,'renderer must not mutate aggregate model');
      const selectedNodes=fake.querySelectorAll('[data-summary-day]').filter(node=>node.tabIndex===0);
      assert.equal(selectedNodes.length,1,'one enabled numeric grid entry point');
      assert.equal(selectedNodes[0].dataset.summaryDay,state.selectedKey);
      if(spec.focusKey)assert.equal(fake.focusEvents.length,1,'focus restoration is captured by fake DOM');
      add(`RENDER-${locale}-${spec.id}`,'generated HTML/text/attributes/style properties, selection, focus, pagination and state',{render:fake.snapshot(),state});
    }
  }
  const switches=[];
  for(const locale of [...contract.locales,...contract.locales.toReversed(),'ja','en','ja']){i18n.setLocale(locale);switches.push({locale,number:r.number(1234567.89,1),date:r.dateText('2026-12-31',{month:'long',day:'numeric'}),time:r.timeMarkup(125.5)});}
  add('FMT-LOCALE-SWITCH','same loaded module follows repeated live locale changes',switches);
  // Explicit independent anchors complement the captured original-output fixtures.
  i18n.setLocale('en');assert.deepEqual(serialize(r.timeParts(59.5)),{hours:'1',minutes:'0'});assert.deepEqual(serialize(r.timeParts(-1)),{hours:'0',minutes:'0'});assert.equal(r.number(1234.5,1),'1,234.5');
  add('FMT-ANCHORS','independent numeric and rounding anchors',{round:r.timeParts(59.5),negative:r.timeParts(-1),grouping:r.number(1234.5,1)});
  const pref=await env.load('summary-preferences.js');
  const inputs=[undefined,null,{}, {metrics:['total','average','overtime','days'],averageBase:'business'}, {version:1,metrics:['total','average','overtime','days']}, {version:2,metrics:['total','average','overtime','days']}, {metrics:['longest','total','total','unknown','average','days','overtimeDays'],averageBase:'business'}, {metrics:['longest']}, {metrics:['days','overtime','average','total']}, {metrics:[],averageBase:'bad',tasks:['synthetic']}, {metrics:'total',averageBase:null}];
  const values=inputs.map(value=>{const prior=JSON.stringify(value),result=pref.normalizeSummaryPreferences(value);assert.equal(JSON.stringify(value),prior);assert.deepEqual(serialize(pref.normalizeSummaryPreferences(result)),serialize(result));return result;});
  assert.deepEqual(serialize(values[0]),{version:2,metrics:['total','average','overtime','days','overtimeDays','longest'],averageBase:'recorded'});
  add('PREF-PURE','pure defaults, migration, explicit subsets, order, invalid inputs and idempotence',values);
  await env.load('@test-summary-model.mjs');
  assert.equal(env.logs.filter(line=>line.startsWith('PASS:')).length,7);
  add('MODEL-EXISTING','unmodified existing aggregation test executed inside allowlisted VM',env.logs);
  return {cases,environment:{node:process.version,v8:process.versions.v8,icu:process.versions.icu,tz:Intl.DateTimeFormat().resolvedOptions().timeZone},constructor_counts:env.counts};
}
function verifyGuards(){
  const manifest=readJson('source-manifest.json'),allowed=new Set(contract.allowed_product_changes),results=[];
  for(const entry of manifest.files)assert.equal(fingerprint(entry.path,path.join(out,'before-source')).sha256,entry.sha256,`Original snapshot guard: ${entry.path}`);
  for(const entry of manifest.files){if(allowed.has(entry.path))continue;assert.equal(fingerprint(entry.path,sourceRoot).sha256,entry.sha256,`Source guard: ${entry.path}`);}
  const renderer=fs.readFileSync(path.join(sourceRoot,'src-tauri/renderer/src/summary-renderer.js'),'utf8').replaceAll('\r\n','\n');
  assert.equal(sha(renderer.slice(renderer.indexOf(contract.renderer_invariant_suffix))),manifest.renderer_suffix_sha256,'Nonformatter renderer suffix unchanged');
  for(const invariant of manifest.renderer_prefix_lines)assert.ok(renderer.includes(invariant),`Renderer prefix invariant: ${invariant}`);
  if(fs.existsSync(path.join(out,'baseline-lock.json')))for(const entry of readJson('baseline-lock.json').guards)assert.equal(fingerprint(entry.path).sha256,entry.sha256,`Frozen contract guard: ${entry.path}`);
  if(sourceRoot===root){const untracked=git('ls-files','--others','--exclude-standard','--','src-tauri').split('\n').filter(Boolean),current=[...sourceFiles(),...untracked],initial=new Set(manifest.files.map(row=>row.path));for(const file of current)assert.ok(initial.has(file)||allowed.has(file),`Unapproved product source: ${file}`);}
  results.push({id:'GUARD-CONTRACT-SOURCE',required:true,status:'passed',evidence:'All frozen harness/fixture/expected hashes plus original source hashes outside two allowed product paths and renderer suffix/prefix invariants.'});return results;
}
async function check(){
  const guards=verifyGuards(),actual=await collect(),expected=readJson('expected.json');
  assert.deepEqual(actual.environment,expected.environment,'Same runtime, ICU and system timezone are required');
  assert.equal(actual.cases.length,expected.cases.length);
  const cases=actual.cases.map((row,index)=>{assert.equal(row.id,expected.cases[index].id);assert.deepEqual(row.value,expected.cases[index].value,row.id);return {id:row.id,required:true,status:'passed',evidence:`${label}-checks.json`,feature:row.feature};});
  const result={schema_version:1,label,source_root:sourceRoot,created_at:new Date().toISOString(),environment:actual.environment,cases:[...guards,...cases,...contract.not_run],summary:{required:cases.length+guards.length,passed:cases.length+guards.length,failed:0,not_run:contract.not_run.length},constructor_counts:actual.constructor_counts};
  write(`${label}-checks.json`,result);write(`${label}-outputs.json`,actual);console.log(JSON.stringify(result.summary));
}
async function measurements(){
  verifyGuards();const env=await createEnvironment(sourceRoot,contract,{instrument:false}),r=env.renderer;env.i18n.setLocale('ja');
  const {iterations,warmup,samples,tolerance_percent,tolerance_absolute_ms}=contract.measurement;
  function work(target){let digest=0;for(let i=0;i<iterations;i++){digest+=target.number(1234567.89+i,1).length;digest+=target.timeMarkup(59.5+i).length;digest+=target.dateText('2026-10-08',{month:'numeric',day:'numeric',weekday:'short'}).length;digest+=target.groupLabel({key:'2026-10'},'year').length;}return digest;}
  for(let i=0;i<warmup;i++)work(r);const raw=[];const digests=[];
  for(let i=0;i<samples;i++){const start=performance.now();digests.push(work(r));raw.push(performance.now()-start);}
  assert.equal(new Set(digests).size,1);
  const counted=await createEnvironment(sourceRoot,contract);counted.i18n.setLocale('ja');work(counted.renderer);const cold={...counted.counts};counted.resetCounts();work(counted.renderer);const warm={...counted.counts};
  const sorted=raw.toSorted((a,b)=>a-b),median=sorted[Math.floor(sorted.length/2)],p95=sorted[Math.ceil(sorted.length*.95)-1];
  const context={node:process.version,v8:process.versions.v8,icu:process.versions.icu,platform:process.platform,os_release:os.release(),arch:process.arch,cpu_model:os.cpus()[0]?.model,cpu_count:os.cpus().length,total_memory_bytes:os.totalmem(),locale:'ja',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,iterations,warmup,samples,workload:'Synthetic pure formatter calls: 3 number constructions and 2 date constructions per iteration in original implementation',build:'interpreted exact source loaded in isolated VM; no native/application/UI runtime',concurrent_load:'Uncontrolled other system processes; no other intentional benchmark run in this harness',seed:contract.seed};
  write(`${label}-metrics.json`,{context,metrics:[{id:'formatter.microbenchmark',unit:'ms',direction:'lower',samples:raw,median,p95,min:sorted[0],max:sorted.at(-1),tolerance_percent,tolerance_absolute:tolerance_absolute_ms},{id:'formatter.constructors.cold',unit:'constructors',direction:'lower',samples:[cold.number+cold.date],number:cold.number,date:cold.date,tolerance_percent:0,tolerance_absolute:0},{id:'formatter.constructors.warm',unit:'constructors',direction:'lower',samples:[warm.number+warm.date],number:warm.number,date:warm.date,tolerance_percent:0,tolerance_absolute:0}],digests,code:codeMetrics(sourceRoot),limitations:['Pure formatter timing does not measure complete rendering, startup, responsiveness, CPU usage, process memory or live UI.','No pixel comparison has been performed.']});
  console.log(JSON.stringify({median,p95,cold,warm,samples:raw}));
}
async function prepare(){
  assert.equal(sourceRoot,root);assert.ok(fs.existsSync(path.join(out,'roles.json')),'Roles must exist before baseline execution');
  const roles=readJson('roles.json');assert.equal(new Set([roles.design.agent_id,roles.implementation.agent_id,roles.verification.agent_id]).size,3);
  const files=sourceFiles().map(file=>fingerprint(file));const renderer=fs.readFileSync(path.join(root,'src-tauri/renderer/src/summary-renderer.js'),'utf8').replaceAll('\r\n','\n');
  const prefix=renderer.slice(0,renderer.indexOf('const number ='));
  const renderer_prefix_lines=prefix.split('\n').filter(line=>line.trim()&&!line.startsWith('import '));renderer_prefix_lines.push('const color = tag => normalizeHexColor(tag.color);');
  const manifest={head:git('rev-parse','HEAD'),branch:git('branch','--show-current'),working_tree:git('status','--porcelain=v1','--untracked-files=normal'),archive_scope:'Current working-tree bytes for tracked src-tauri files (excluding generated/dependency directories) plus two existing summary tests. Snapshot is a directory, not a complete repository backup.',excluded_untracked:['.codex-remote-attachments/ (private; only directory presence from git status; contents never read)','out/ (generated evidence)','scripts/refactor-summary-offline/ (new harness separately frozen)'],files,renderer_suffix_sha256:sha(renderer.slice(renderer.indexOf(contract.renderer_invariant_suffix))),renderer_prefix_lines};
  if(fs.existsSync(path.join(out,'source-manifest.json')))assert.deepEqual(readJson('source-manifest.json').files,manifest.files,'Resuming preparation requires the identical original sources');else write('source-manifest.json',manifest);
  for(const entry of files){const target=path.join(out,'before-source',entry.path);fs.mkdirSync(path.dirname(target),{recursive:true});if(fs.existsSync(target))assert.equal(sha(fs.readFileSync(target)),entry.sha256,'Preserved snapshot must be identical');else fs.copyFileSync(path.join(root,entry.path),target,fs.constants.COPYFILE_EXCL);}
  const actual=await collect();write('expected.json',actual);
  const matrix=[...actual.cases.map(row=>({id:row.id,feature:row.feature,required:true,source:row.id.startsWith('MODEL')?'scripts/test-summary-model.mjs':'src-tauri/renderer/src/summary-renderer.js and summary-preferences.js',precondition:'Fixed synthetic fixtures, actual 9 locale catalogs, isolated VM; no application/browser/network',operation:'See fixtures.mjs and collect() in run.mjs',expected:'Exact captured original value in expected.json, plus explicit independent anchors and mutation guard',evidence:'before-checks.json'})),{id:'GUARD-CONTRACT-SOURCE',feature:'unchanged source and immutable contract',required:true,expected:'Hashes equal; only renderer formatting prefix and new helper may change'},...contract.not_run];
  write('case-matrix.json',{cases:matrix});
  write('source-audit.json',{audited_by:roles.design.agent_id,created_at:new Date().toISOString(),product_modules:contract.safety.vm_modules,executed_existing_tests:['scripts/test-summary-model.mjs inside VM'],not_executed:['scripts/test-summary-preferences.mjs: settings-model dependency', 'all browser/native tests'],audit_findings:['Renderer module contains synchronous helpers and exported render methods; no network or native calls.','i18n module imports catalog object literals; setLocale receives inert document without dispatchEvent/documentElement.','summary-model, work-time, holidays and company-holidays execute pure transformations. event-fields UI functions exist but are not invoked by model tests.','ui-utils module is not imported: only two exact audited pure functions are extracted.','VM linker accepts only listed paths; product modules receive no Node I/O, process, timers or network globals.','Source snapshot and code metrics read tracked source/config/assets only; private untracked attachment directory and user data excluded.'],limits:'A constrained VM and source audit reduce unintended execution scope; they are not a security boundary or a claim about external Windows lockout causes.'});
  console.log(`Prepared ${actual.cases.length} behavioral cases and ${files.length} source snapshots.`);
}
function freeze(){
  const items=fs.readdirSync(here).filter(name=>/\.(mjs|json|md)$/.test(name)).map(name=>path.relative(root,path.join(here,name)).replaceAll('\\','/'));
  for(const name of ['expected.json','case-matrix.json','source-manifest.json','source-audit.json','source-audit-addendum.json','runtime.json','before-checks.json','before-outputs.json','before-final-checks.json','before-final-outputs.json','before-metrics.json','mutation-probes.json','preparation-notes.md'])items.push(`${contract.output_root}/${name}`);
  const guards=items.map(file=>fingerprint(file));write('baseline-lock.json',{schema_version:1,created_at:new Date().toISOString(),guards,combined_sha256:sha(guards.map(row=>`${row.path}\0${row.sha256}`).join('\n'))});console.log('Frozen '+guards.length+' contract/evidence files.');
}
async function probes(){
  const expected=readJson('expected.json'),results=[];
  for(const [id,from,to] of [['rounding','Math.round(minutes || 0)','Math.floor(minutes || 0)'],['locale','new Intl.NumberFormat(getLocale(),','new Intl.NumberFormat("ja",'],['precision','maximumFractionDigits:digits','maximumFractionDigits:0']]){
    let error=null;
    try{const actual=await collect({transformRenderer:source=>{assert.ok(source.includes(from),`Probe location ${id}`);return source.replace(from,to)}});for(let i=0;i<actual.cases.length;i++)assert.deepEqual(actual.cases[i].value,expected.cases[i].value,actual.cases[i].id);}catch(caught){error={name:caught.name,message:caught.message.slice(0,600)};}
    assert.ok(error,`Mutation must be detected: ${id}`);results.push({id,detected:true,mutation:{from,to},error,scope:'In-memory original renderer clone only; no source file edited'});
  }
  write('mutation-probes.json',{results});console.log(JSON.stringify(results.map(row=>({id:row.id,detected:row.detected}))));
}
if(mode==='prepare')await prepare();else if(mode==='check')await check();else if(mode==='metrics')await measurements();else if(mode==='freeze')freeze();else if(mode==='probe')await probes();else throw Error('Allowed modes: prepare, check LABEL [SOURCE_ROOT], metrics LABEL [SOURCE_ROOT], freeze, probe');
