// 添付された元画像を描き直さず、Windows用アイコンを再生成する。
// Usage: node scripts/make-icon.mjs [source.png]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] || path.join(root, 'src-tauri/icons/source.png'));
const bytes = fs.readFileSync(source);
if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
  throw new Error('Source must be a PNG image');
}
const width = bytes.readUInt32BE(16);
const height = bytes.readUInt32BE(20);
const size = Math.max(width, height);
const npx = [
  process.env.npm_execpath && path.join(path.dirname(process.env.npm_execpath), 'npx-cli.js'),
  path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npx-cli.js'),
].find(candidate => candidate && fs.existsSync(candidate));
if (!npx) throw new Error('Node.js with npm is required to regenerate icons');

const tempRoot = path.resolve(os.tmpdir());
const temp = fs.mkdtempSync(path.join(tempRoot, 'tcplus-icons-'));
try {
  // 正方形の透明な領域に配置し、元画像の縦横比を保持する。
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><image x="${(size - width) / 2}" y="${(size - height) / 2}" width="${width}" height="${height}" xlink:href="data:image/png;base64,${bytes.toString('base64')}"/></svg>`;
  const input = path.join(temp, 'source.svg');
  const output = path.join(temp, 'icons');
  fs.writeFileSync(input, svg);
  execFileSync(process.execPath, [npx, '--yes', '@tauri-apps/cli@2.11.5', 'icon', input, '--output', output], {
    stdio: 'inherit', windowsHide: true,
  });
  const icons = path.join(root, 'src-tauri/icons');
  const runtime = path.join(root, 'src-tauri/renderer/assets/app-icon');
  fs.mkdirSync(icons, { recursive: true });
  fs.mkdirSync(runtime, { recursive: true });
  for (const name of ['32x32.png', '64x64.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.ico']) {
    fs.copyFileSync(path.join(output, name), path.join(icons, name));
  }
  fs.copyFileSync(path.join(output, 'icon.ico'), path.join(runtime, 'icon.ico'));
  console.log('Windows app, taskbar, and tray icons updated.');
} finally {
  if (path.dirname(temp) !== tempRoot || !path.basename(temp).startsWith('tcplus-icons-')) {
    throw new Error('Unexpected temporary directory; cleanup cancelled');
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
