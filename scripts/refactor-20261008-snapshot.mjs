// Role A: allowlisted working-tree evidence; never collects AppData or attachments.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { rustTestSections } from './refactor-20261008-rust-test-sections.mjs';

const root = path.resolve(process.argv[2] || '.');
const destination = path.resolve(process.argv[3] || 'out/refactor-20261008/initial');
if (fs.existsSync(destination)) throw new Error('Evidence destination already exists: ' + destination);
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const paths = [...new Set(execFileSync('git', ['ls-files','--cached','--others','--exclude-standard','-z'], {cwd:root, encoding:'utf8'}).split('\0').filter(Boolean))].sort();
const allow = file => /^(src-tauri\/(src|renderer|icons|capabilities)\/|src-tauri\/(Cargo\.(toml|lock)|build\.rs|tauri\.conf\.json)$|scripts\/|docs\/|\.github\/|\.gitignore$|README\.md$|CHANGELOG\.md$|LICENSE$)/.test(file)
  && !/(^|\/)(target|out|node_modules|\.codex-remote-attachments)(\/|$)/.test(file)
  && !/\.(db|sqlite|sqlite3|pem|key|env)$/i.test(file);
function classify(file, data) {
  if (/^scripts\//.test(file)) return 'tests-and-harnesses';
  if (/^docs\//.test(file) || /^(README|CHANGELOG|LICENSE)/.test(file)) return 'documentation-and-doc-images';
  if (/^src-tauri\/(icons|renderer\/assets\/app-icon)\//.test(file)) return 'assets';
  if (/^src-tauri\/(src\/.*\.rs|renderer\/src\/.*\.(js|json)|renderer\/assets\/.*\.(html|css))$/.test(file)) return 'application';
  return 'configuration';
}
fs.mkdirSync(path.join(destination,'source'), {recursive:true});
const files = [];
const totals = {};
const inlineRustTests={sourceFiles:0,bytes:0,lines:0,nonblankLines:0};
for (const file of paths.filter(allow)) {
  const full = path.join(root,file);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
  const data = fs.readFileSync(full);
  const group = classify(file,data);
  const textFile = !/\.(png|webp|ico|jpg|jpeg|gif|zip)$/i.test(file);
  const lines = textFile ? data.toString('utf8').split(/\r?\n/).slice(0, data.toString('utf8').endsWith('\n') ? -1 : undefined) : [];
  const record = {path:file, group, bytes:data.length, lines:lines.length, nonblankLines:lines.filter(line=>line.trim()).length, sha256:sha(data)};
  const dest = path.join(destination,'source',file); fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.writeFileSync(dest,data,{flag:'wx'});
  files.push(record);
  const sum = totals[group] ||= {files:0,bytes:0,lines:0,nonblankLines:0};
  sum.files++; for (const name of ['bytes','lines','nonblankLines']) sum[name]+=record[name];
  if(group==='application'&&file.endsWith('.rs')){
    const sections=rustTestSections(data.toString('utf8'));
    if(sections.length){inlineRustTests.sourceFiles++;record.inlineTestSections=sections.map(({start,end,text})=>({start,end,sha256:sha(text)}));}
    for(const section of sections){const sectionLines=section.text.split(/\r?\n/).slice(0,section.text.endsWith('\n')?-1:undefined);const size={bytes:Buffer.byteLength(section.text),lines:sectionLines.length,nonblankLines:sectionLines.filter(line=>line.trim()).length};for(const name of Object.keys(size)){inlineRustTests[name]+=size[name];sum[name]-=size[name];}}
  }
}
const manifest = {schema_version:1, createdAt:new Date().toISOString(), root, sourceKind:'working-tree-including-dirty-and-untracked-allowlisted-files', head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(), gitStatus:execFileSync('git',['status','--short'],{cwd:root,encoding:'utf8'}).split(/\r?\n/).filter(line=>line&&!line.includes('.codex-remote-attachments')), exclusions:['.git','.codex-remote-attachments','out','target','node_modules','AppData','database files','credential file extensions'], totals, inlineRustTests, countNotes:'Application totals subtract cfg(test) and test items. Inline Rust tests are counted separately. Lines are physical/nonblank lines including comments, not SLOC. Tests, documentation, assets, configuration and generated evidence are excluded from application totals.', files};
fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({destination,files:files.length,totals}));
