// Role A seals the successful feature-complete state before B starts pure refactoring.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { rustTestSections } from './refactor-20261008-rust-test-sections.mjs';
import { rendererFingerprint } from './refactor-20261008-harness.mjs';

const root=path.resolve(process.argv[2]||'.');
const run=path.resolve(process.argv[3]||'out/refactor-20261008');
const mode=process.argv[4]||'freeze';
const read=file=>JSON.parse(fs.readFileSync(path.join(run,file),'utf8'));
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const hashFile=file=>sha(fs.readFileSync(file));
const rustTests=()=>Object.fromEntries(fs.readdirSync(path.join(root,'src-tauri/src')).filter(file=>file.endsWith('.rs')).sort().map(file=>{
  const sections=rustTestSections(fs.readFileSync(path.join(root,'src-tauri/src',file),'utf8'));
  return ['src-tauri/src/'+file,sections.map(section=>sha(section.text))];
}).filter(([,sections])=>sections.length));

if(mode==='verify'){
  const guards=read('frozen-guards.json');const failures=[];
  for(const [file,hash]of Object.entries(guards.files)){if(!fs.existsSync(path.join(root,file))||hashFile(path.join(root,file))!==hash)failures.push(file);}
  if(JSON.stringify(rustTests())!==JSON.stringify(guards.rustTestSections))failures.push('Rust test item content');
  if(failures.length)throw Error('Frozen contract changed: '+failures.join(', '));
  console.log(JSON.stringify({verified:true,files:Object.keys(guards.files).length,rustFiles:Object.keys(guards.rustTestSections).length,guardSha256:hashFile(path.join(run,'frozen-guards.json'))}));
}else if(mode==='freeze'){
  if(fs.existsSync(path.join(run,'frozen-baseline.json')))throw Error('Baseline already frozen; preserve it and use another run for a revision');
  const checks=read('before-checks/checks.json');
  const ui=read('before-ui-tests/cases.json');
  const required=[...checks.cases,...ui.cases].filter(row=>row.required);
  if(checks.mode!=='all'||!checks.results.some(row=>row.id==='rust')||!checks.results.some(row=>row.id==='clippy'))throw Error('Full safe check suite has not run');
  if(checks.results.some(row=>row.status!=='passed')||!required.length||required.some(row=>row.status!=='passed'))throw Error('Required checks must all pass before freezing');
  const testedNodeFiles=checks.results.filter(row=>row.id.startsWith('node-test-')).map(row=>row.id.slice('node-'.length));
  const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):[path.join(dir,entry.name)]);
  const testedFiles=[...walk(path.join(root,'src-tauri/src')),...walk(path.join(root,'src-tauri/renderer')),...testedNodeFiles.map(file=>path.join(root,'scripts',file))];
  const testedSourceSha256=sha(JSON.stringify(testedFiles.sort().map(file=>[path.relative(root,file).replaceAll('\\','/'),hashFile(file)])));
  if(testedSourceSha256!==checks.sourceSha256)throw Error('Checks do not describe current application source and tests');
  for(const directory of ['before-ui','before-ui-tests','before-benchmark']){
    const environment=read(directory+'/harness-environment.json');
    if(environment.sourceChangedDuringRun||environment.pageErrors.length||environment.unexpectedRequests.length)throw Error('Unstable or failed renderer evidence in '+directory);
    if(environment.source.sha256!==rendererFingerprint(root).sha256)throw Error('Renderer evidence differs from current source: '+directory);
  }
  const gallery=read('before-ui/gallery.json');
  if(!gallery.states||gallery.captured.some(name=>gallery.states[name]?.paletteMatches!==true)||gallery.states['tasks-dark']?.theme!=='dark')throw Error('Every screenshot must record a consistent settled theme palette');
  const source=read('before-source/manifest.json');
  for(const file of source.files.filter(file=>file.group!=='documentation-and-doc-images')){if(!fs.existsSync(path.join(root,file.path))||hashFile(path.join(root,file.path))!==file.sha256)throw Error('Snapshot no longer matches working tree: '+file.path);}
  const measurements=read('before-benchmark/metrics.json');
  if(measurements.metrics.length!==16||measurements.metrics.some(row=>row.samples.length!==7||row.samples.some(value=>!Number.isFinite(value))))throw Error('Expected 16 metrics with 7 raw numeric samples each');
  const contract=read('contract-draft.json');contract.status='frozen';contract.frozenAt=new Date().toISOString();
  contract.nodeTests=testedNodeFiles;
  contract.allowedRefactorUiChanges=[];
  contract.requiredCases=required.map(row=>({id:row.id,description:row.description??row.id}));
  contract.rendererBaselineSha256=rendererFingerprint(root).sha256;
  fs.writeFileSync(path.join(run,'contract.json'),JSON.stringify(contract,null,2)+'\n',{flag:'wx'});
  const caseRows=[...checks.cases.map(row=>({...row,evidence:'before-checks/'+row.evidence})),...ui.cases.map(row=>({...row,evidence:'before-ui-tests/'+row.evidence})),...contract.not_run];
  fs.writeFileSync(path.join(run,'before-cases.json'),JSON.stringify({cases:caseRows},null,2)+'\n',{flag:'wx'});
  const columns=['id','required','status','description','evidence','reason'];const quote=value=>'"'+String(value??'').replaceAll('"','""')+'"';
  fs.writeFileSync(path.join(run,'case-matrix.csv'),[columns.join(','),...caseRows.map(row=>columns.map(key=>quote(row[key])).join(','))].join('\n')+'\n',{flag:'wx'});
  const guardPaths=fs.readdirSync(path.join(root,'scripts')).filter(file=>/^test-.*\.(mjs|js)$/.test(file)||/^refactor-20261008-.*\.(mjs|json)$/.test(file)).map(file=>'scripts/'+file);
  for(const file of ['contract.json','before-cases.json','case-matrix.csv'])guardPaths.push(path.relative(root,path.join(run,file)).replaceAll('\\','/'));
  for(const directory of ['before-checks','before-ui-tests','before-ui','before-benchmark','before-source']){
    guardPaths.push(...walk(path.join(run,directory)).map(file=>path.relative(root,file).replaceAll('\\','/')));
  }
  const guards={schema_version:1,createdAt:new Date().toISOString(),files:Object.fromEntries(guardPaths.sort().map(file=>[file,hashFile(path.join(root,file))])),rustTestSections:rustTests()};
  fs.writeFileSync(path.join(run,'frozen-guards.json'),JSON.stringify(guards,null,2)+'\n',{flag:'wx'});
  const baseline={schema_version:1,frozenAt:contract.frozenAt,designer:contract.design_agent,guardSha256:hashFile(path.join(run,'frozen-guards.json')),contractSha256:hashFile(path.join(run,'contract.json')),sourceManifestSha256:hashFile(path.join(run,'before-source/manifest.json')),rendererSha256:contract.rendererBaselineSha256,requiredCases:required.length,passedCases:required.length,notRun:caseRows.filter(row=>row.status==='not-run').length,metrics:16,samplesPerMetric:7,source:'before-source/source',checks:'before-checks/checks.json',uiTests:'before-ui-tests/cases.json',screenshots:'before-ui',measurements:'before-benchmark/metrics.json',originalRequests:contract.request_sources};
  fs.writeFileSync(path.join(run,'frozen-baseline.json'),JSON.stringify(baseline,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(baseline));
}else throw Error('Mode must be freeze or verify');
