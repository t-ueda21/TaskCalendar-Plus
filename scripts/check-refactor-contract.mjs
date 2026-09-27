import fs from 'node:fs';
import crypto from 'node:crypto';
const manifest='scripts/refactor-test-contract.json';
const current={};
for(const name of fs.readdirSync('src-tauri/src').filter(name=>name.endsWith('.rs')).sort()) {
  const file='src-tauri/src/'+name,text=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n');
  const index=text.indexOf('#[cfg(test)]');
  if(index>=0)current[file]=crypto.createHash('sha256').update(text.slice(index)).digest('hex');
}
if(process.argv.includes('--record')) {
  fs.writeFileSync(manifest,JSON.stringify(current,null,2)+'\n',{flag:'wx'});
  console.log('Rust test sections frozen.');
} else {
  const expected=JSON.parse(fs.readFileSync(manifest,'utf8'));
  if(Object.entries(expected).some(([file, hash]) => current[file] !== hash))throw Error('Frozen Rust test sections changed; investigate before comparing.');
  const added = Object.keys(current).filter(file => !(file in expected));
  console.log(`PASS: Original Rust test sections unchanged (${added.length} additional test modules)`);
}
