import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const bridge = readFileSync(new URL('../src-tauri/renderer/src/tauri-shell-bridge.js', import.meta.url), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function launch(origin, native, localValues = {}) {
  const attrs = new Map();
  const handlers = new Map();
  const storage = new Map(Object.entries(localValues));
  const calls = [];
  const document = {
    documentElement: { setAttribute: (name, value) => attrs.set(name, value) },
    addEventListener: (name, callback) => handlers.set(name, callback),
  };
  const window = {
    location: { href: origin + '/', origin },
    fetch: async () => ({}),
    open: () => null,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    __TAURI__: { core: { invoke: async (command, args) => {
      calls.push({ command, args });
      if (native.failOnce === command) {
        native.failOnce = null;
        throw new Error('simulated write failure');
      }
      if (command === 'get_api_token') return 'scratch-token';
      if (command === 'get_ui_preferences') {
        if (native.readGate) await native.readGate;
        return native.preferences && { ...native.preferences };
      }
      if (command === 'set_ui_theme') {
        native.preferences = { theme: args.theme, zoom: native.preferences?.zoom ?? 1 };
      }
      if (command === 'set_ui_zoom') {
        if (native.zoomGateOnce) {
          const gate = native.zoomGateOnce;
          native.zoomGateOnce = null;
          await gate;
        }
        native.preferences = { theme: native.preferences?.theme ?? 'light', zoom: args.level };
      }
    } } },
  };
  vm.runInNewContext(bridge, { window, document, URL, Headers, Request, Promise, console: { error() {} } });
  return { window, attrs, handlers, calls, storage };
}

async function pressZoom(page, key) {
  let prevented = false;
  page.handlers.get('keydown')({ key, ctrlKey: true, altKey: false, metaKey: false, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  await new Promise(resolve => setImmediate(resolve));
}

const native = { preferences: null };
const first = launch('http://127.0.0.1:22492', native, { tcplus_theme: 'dark', tcplus_ui_zoom: '1.5' });
await first.window.tcplusUiPreferences.ready;
assert.deepEqual(native.preferences, { theme: 'dark', zoom: 1.5 });
assert.equal(first.attrs.get('data-theme'), 'dark');

const second = launch('http://127.0.0.1:50226', native);
await second.window.tcplusUiPreferences.ready;
assert.equal(second.attrs.get('data-theme'), 'dark');
assert.equal(second.calls.some(call => call.command === 'set_ui_zoom'), false);
await pressZoom(second, '+');
assert.equal(native.preferences.zoom, 1.6);

native.failOnce = 'set_ui_theme';
await assert.rejects(second.window.tcplusUiPreferences.setTheme('light'));
assert.equal(native.preferences.theme, 'dark');
await second.window.tcplusUiPreferences.setTheme('light');
assert.equal(native.preferences.theme, 'light');

native.failOnce = 'set_ui_zoom';
await pressZoom(second, '+');
assert.equal(native.preferences.zoom, 1.6);
await pressZoom(second, '+');
assert.equal(native.preferences.zoom, 1.7);

const reading = deferred();
const earlyNative = { preferences: { theme: 'dark', zoom: 1.5 }, readGate: reading.promise };
const earlyPage = launch('http://127.0.0.1:30211', earlyNative);
await pressZoom(earlyPage, '+');
reading.resolve();
await earlyPage.window.tcplusUiPreferences.ready;
await new Promise(resolve => setImmediate(resolve));
assert.equal(earlyNative.preferences.zoom, 1.6, 'zoom key during preference load uses loaded zoom');

const writing = deferred();
const rapidNative = { preferences: { theme: 'light', zoom: 1.5 }, zoomGateOnce: writing.promise };
const rapidPage = launch('http://127.0.0.1:30212', rapidNative);
await rapidPage.window.tcplusUiPreferences.ready;
await pressZoom(rapidPage, '+');
await pressZoom(rapidPage, '+');
writing.resolve();
await new Promise(resolve => setImmediate(resolve));
assert.equal(rapidNative.preferences.zoom, 1.7, 'rapid zoom keys apply sequential relative changes');
console.log('Native UI preference bridge: port change, legacy import, failed-write retry, and queued zoom passed.');
