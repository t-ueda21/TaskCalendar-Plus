import fs from 'node:fs';
import path from 'node:path';

const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const locked = fs.readFileSync('src-tauri/Cargo.lock', 'utf8').match(/name = "taskcalendar-plus"\r?\nversion = "([^"]+)"/)?.[1];
const version = config.version;
const tag = process.env.RELEASE_TAG || `v${version}`;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const parsed = versionPattern.exec(version);
if (!parsed || cargo !== version || locked !== version || tag !== `v${version}`) {
  throw new Error('Tag, Tauri, Cargo and lock versions must match x.y.z or x.y.z-prerelease');
}
const prerelease = Boolean(parsed[4]);
const notes = fs.readFileSync(`docs/releases/${tag}.md`, 'utf8').trim();
if (!notes) throw new Error('Release notes must not be empty');
if (process.argv.includes('--check')) {
  console.log(`Release version verified: ${tag} (${prerelease ? 'prerelease; no stable feed' : 'stable'})`);
} else if (prerelease && !process.argv.includes('--assets')) {
  // Do not create or replace latest.json, including stale files in a reused build directory.
  console.log(`Prerelease ${tag}: no automatic-update feed will be generated`);
} else {
  const dir = path.resolve('src-tauri/target/release/bundle/nsis');
  const files = fs.readdirSync(dir).filter(name => name.endsWith(`_${version}_x64-setup.exe`));
  if (files.length !== 1) throw new Error('Expected exactly one Windows x64 installer for this version');
  const name = files[0];
  const signature = fs.readFileSync(path.join(dir, name + '.sig'), 'utf8').trim();
  if (!signature) throw new Error('Updater signature is missing');
  if (process.argv.includes('--assets')) {
    const assets = [path.join(dir, name), path.join(dir, name + '.sig')];
    if (!prerelease) {
      const feed = path.join(dir, 'latest.json');
      if (JSON.parse(fs.readFileSync(feed, 'utf8')).version !== version) throw new Error('Stable feed version mismatch');
      assets.push(feed);
    }
    console.log(JSON.stringify(assets));
    process.exit(0);
  }
  const repo = process.env.GITHUB_REPOSITORY || 't-ueda21/TaskCalendar-Plus';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid repository');
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify({
    version, notes, pub_date: new Date().toISOString(),
    platforms: { 'windows-x86_64': { signature, url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}` } },
  }, null, 2) + '\n');
  console.log(`Created latest.json for ${name}`);
}
