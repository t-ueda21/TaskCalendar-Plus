import assert from 'node:assert/strict';
import { createUpdateController } from '../src-tauri/renderer/src/app-updater.js';

let checks = 0, installs = 0, fail = false, blocked = false, resolveCheck;
const native = {
  check: async () => { checks++; if (fail) throw new Error('offline'); return { version: '0.2.0', notes: '<script>unsafe</script>' }; },
  install: async (version, progress) => { installs++; assert.equal(version, '0.2.0'); progress({ downloaded: 25, total: 100 }); if (fail) throw new Error('signature invalid'); },
};
const c = createUpdateController(native, () => !blocked);
await c.install(); assert.equal(installs, 0);
fail = true; await c.check(); assert.equal(c.state.phase, 'error'); assert.equal(c.state.latest, null);
fail = false; await c.check(); assert.equal(c.state.phase, 'available');
blocked = true; await c.install(); assert.equal(installs, 0); assert.equal(c.state.latest.version, '0.2.0');
blocked = false; fail = true; await c.install(); assert.equal(c.state.phase, 'error'); assert.equal(c.state.latest.version, '0.2.0');
fail = false; await c.install(); assert.equal(c.state.phase, 'installing'); assert.equal(installs, 2);
await c.install(); assert.equal(installs, 2);
console.log('PASS: check failure, pending editor, signature failure, retry, duplicate install');

const slow = createUpdateController({ ...native, check: () => new Promise(r => { checks++; resolveCheck = r; }) });
const pending = slow.check(); const count = checks;
await slow.check(); await slow.install(); assert.equal(checks, count); assert.equal(installs, 2);
resolveCheck(null); await pending; assert.equal(slow.state.phase, 'current');
console.log('PASS: concurrent checks and installs are suppressed; no update is current');

const stages = [];
const progress = createUpdateController(native);
progress.subscribe(s => stages.push({ ...s }));
await progress.check(); await progress.install();
assert.ok(stages.some(s => s.phase === 'downloading' && s.percent === 25));
console.log('PASS: download progress reaches subscribers');
