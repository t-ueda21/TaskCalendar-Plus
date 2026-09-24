import assert from 'node:assert/strict';
import { createUpdateController, initAppUpdater } from '../src-tauri/renderer/src/app-updater.js';

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

// Exercise the UI wiring with only the native bridge and DOM boundary replaced.
class Element extends EventTarget {
  open = false; hidden = false; disabled = false; textContent = '';
  showModal() { this.open = true; }
  close() { this.open = false; }
  removeAttribute() {}
  closest() { return this.settings || null; }
  click() { this.dispatchEvent(new Event('click')); }
}
const elements = new Map();
const el = selector => elements.get(selector) || elements.set(selector, new Element()).get(selector);
const dialog = el('[data-update-dialog]');
const settings = new Element();
const root = new Element();
root.querySelector = el;
root.querySelectorAll = selector => selector === 'dialog[open]'
  ? [dialog, settings].filter(e => e.open) : [el(selector)];
dialog.querySelector = el;
let saveOK = true, saved = 0, nativeInstalls = 0;
settings._wsdCore = { async saveSettings() { saved++; if (saveOK) settings.close(); return saveOK; } };
const bridge = { core: {
  Channel: class {},
  async invoke(command) {
    if (command === 'get_update_info') return { installSupported: true, currentVersion: '0.1.1' };
    if (command === 'check_app_update') return { version: '0.1.2', notes: '更新内容' };
    if (command === 'install_app_update') nativeInstalls++;
  },
} };
await initAppUpdater({ getSettings: () => ({ checkUpdatesOnStartup: true }) }, root, bridge);
await new Promise(r => setImmediate(r));
assert.equal(dialog.open, true, 'startup update must open the notice');
dialog.close(); settings.showModal();
el('[data-update-open]').settings = settings;
saveOK = false;
el('[data-update-open]').click();
await new Promise(r => setImmediate(r));
assert.equal(dialog.open, false, 'failed/cancelled settings save must keep the editor');
assert.equal(settings.open, true);
saveOK = true;
el('[data-update-open]').click();
await new Promise(r => setImmediate(r));
assert.equal(saved, 2);
assert.equal(settings.open, false);
assert.equal(dialog.open, true);
el('[data-update-install]').click();
await new Promise(r => setImmediate(r));
assert.equal(nativeInstalls, 1, 'update from settings must reach installation');
console.log('PASS: startup notice; settings save/cancel and install handoff');
