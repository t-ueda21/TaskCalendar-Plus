import fs from 'node:fs';
import path from 'node:path';

const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const version = config.version;
const tag = process.env.RELEASE_TAG || `v${version}`;
if (!/^\d+\.\d+\.\d+$/.test(version) || cargo !== version || tag !== `v${version}`) {
  throw new Error('Tag, Tauri version, and Cargo version must match a stable x.y.z version');
}
const notes = fs.readFileSync(`docs/releases/${tag}.md`, 'utf8').trim();
if (!notes) throw new Error('Release notes must not be empty');
if (process.argv.includes('--check')) {
  console.log(`Release version verified: ${tag}`);
} else {
  const dir = path.resolve('src-tauri/target/release/bundle/nsis');
  const files = fs.readdirSync(dir).filter(name => name.endsWith(`_${version}_x64-setup.exe`));
  if (files.length !== 1) throw new Error('Expected exactly one Windows x64 installer for this version');
  const name = files[0];
  const signature = fs.readFileSync(path.join(dir, name + '.sig'), 'utf8').trim();
  if (!signature) throw new Error('Updater signature is missing');
  const repo = process.env.GITHUB_REPOSITORY || 't-ueda21/TaskCalendar-Plus';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid repository');
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify({
    version, notes, pub_date: new Date().toISOString(),
    platforms: { 'windows-x86_64': { signature, url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}` } },
  }, null, 2) + '\n');
  console.log(`Created latest.json for ${name}`);
}
