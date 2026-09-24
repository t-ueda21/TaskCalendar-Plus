import { createUpdateController, isUpdateApplying, isUpdateBusy } from './app-update-controller.js';

// Preserve the existing module API for callers of the standalone controller.
export { createUpdateController } from './app-update-controller.js';

function createNativeUpdater(bridge) {
  const invoke = (command, args) => bridge?.core?.invoke(command, args)
    ?? Promise.reject(new Error('デスクトップアプリから確認してください。'));
  return {
    info: () => invoke('get_update_info'),
    check: () => invoke('check_app_update'),
    async install(version, onProgress) {
      const channel = new bridge.core.Channel();
      channel.onmessage = onProgress;
      await invoke('install_app_update', { version, onProgress: channel });
    },
  };
}

function updateStatus(state, supported) {
  if (!supported) return 'インストール版で更新を利用できます。';
  switch (state.phase) {
    case 'checking': return '更新を確認しています…';
    case 'current': return '最新版です。';
    case 'available': return `v${state.latest.version} に更新できます。`;
    case 'downloading': return `ダウンロード中${state.percent == null ? '…' : `… ${state.percent}%`}`;
    case 'installing': return '更新して再起動しています…';
    case 'error': return state.error;
    default: return '「更新を確認」で最新版を確認できます。';
  }
}

// Collect stable elements once. Rendering only reflects controller state.
function createUpdateView(root, dialog, supported) {
  const all = selector => [...root.querySelectorAll(selector)];
  const view = {
    current: all('[data-update-current]'),
    latest: all('[data-update-latest]'),
    statuses: all('[data-update-status]'),
    checkButtons: all('[data-update-check]'),
    openButtons: all('[data-update-open]'),
    notes: dialog.querySelector('[data-update-notes]'),
    install: dialog.querySelector('[data-update-install]'),
    close: dialog.querySelector('[data-update-close]'),
    progress: dialog.querySelector('progress'),
    show() { if (!dialog.open) dialog.showModal(); },
    render(state) {
      const busy = isUpdateBusy(state.phase);
      const applying = isUpdateApplying(state.phase);
      const status = updateStatus(state, supported);
      view.statuses.forEach(el => { el.textContent = status; });
      view.checkButtons.forEach(el => { el.disabled = busy || !supported; });
      view.openButtons.forEach(el => {
        el.hidden = !state.latest;
        el.textContent = el.closest('[data-settings-dialog]') ? '設定を保存して更新' : '↑ アップデート';
        el.title = state.latest ? `v${state.latest.version} の更新内容を見る` : '';
        el.disabled = applying;
      });
      view.latest.forEach(el => { el.textContent = state.latest ? `v${state.latest.version}` : '—'; });
      view.notes.textContent = state.latest?.notes || '';
      view.install.disabled = !supported || !state.latest || busy;
      view.close.disabled = applying;
      view.progress.hidden = !applying;
      if (state.percent == null) view.progress.removeAttribute('value');
      else view.progress.value = state.percent;
    },
  };
  return view;
}

// A startup notice waits for an open editor to close, without discarding edits.
function createStartupNotice(root, controller, view, hasOpenEditor) {
  let pending = false;
  const showIfReady = () => {
    if (!pending || !controller.state.latest || hasOpenEditor()) return;
    pending = false;
    view.show();
  };
  root.addEventListener('close', showIfReady, true);
  return () => {
    pending = controller.state.phase === 'available';
    showIfReady();
  };
}

export async function initAppUpdater(Store, root = document, bridge = window.__TAURI__) {
  const dialog = root.querySelector('[data-update-dialog]');
  if (!dialog) return;
  const native = createNativeUpdater(bridge);
  let info;
  try { info = await native.info(); }
  catch { info = { currentVersion: Store.getRuntimeInfo().appVersion, installSupported: false }; }
  const supported = Boolean(info.installSupported);
  const hasOpenEditor = () => [...root.querySelectorAll('dialog[open]')].some(el => el !== dialog);
  const controller = createUpdateController(native, () => !hasOpenEditor());
  const view = createUpdateView(root, dialog, supported);
  view.current.forEach(el => { el.textContent = `v${info.currentVersion || '—'}`; });
  controller.subscribe(view.render);
  const notifyAtStartup = createStartupNotice(root, controller, view, hasOpenEditor);

  view.checkButtons.forEach(el => el.addEventListener('click', () => { void controller.check(); }));
  view.openButtons.forEach(el => el.addEventListener('click', async () => {
    const settings = el.closest('[data-settings-dialog]');
    if (settings?.open && !await settings._wsdCore?.saveSettings()) return;
    view.show();
  }));
  view.install.addEventListener('click', () => { void controller.install(); });
  view.close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', e => {
    if (isUpdateApplying(controller.state.phase)) e.preventDefault();
  });
  if (supported && Store.getSettings().checkUpdatesOnStartup) {
    await controller.check();
    notifyAtStartup();
  }
}
