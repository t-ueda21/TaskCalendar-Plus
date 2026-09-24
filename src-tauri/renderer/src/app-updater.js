// Update state is independent of the DOM so failure/retry paths can be tested.
export function createUpdateController(native, canInstall = () => true) {
  let state = { phase: 'idle', latest: null, error: '', percent: null };
  const listeners = new Set();
  const busy = () => ['checking', 'downloading', 'installing'].includes(state.phase);
  const set = patch => { state = { ...state, ...patch }; listeners.forEach(fn => fn(state)); };
  return {
    get state() { return state; },
    subscribe(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); },
    async check() {
      if (busy()) return;
      set({ phase: 'checking', error: '', latest: null, percent: null });
      try {
        const latest = await native.check();
        set({ phase: latest ? 'available' : 'current', latest });
      } catch (e) { set({ phase: 'error', error: String(e?.message ?? e) }); }
    },
    async install() {
      if (busy() || !state.latest) return;
      if (!canInstall()) {
        set({ phase: 'error', error: '開いている設定や予定を保存して閉じてから、もう一度更新してください。' });
        return;
      }
      set({ phase: 'downloading', error: '', percent: null });
      try {
        await native.install(state.latest.version, ({ downloaded, total, phase }) => {
          set({ phase: phase === 'installing' ? 'installing' : 'downloading', percent: total > 0 ? Math.min(100, Math.floor(downloaded * 100 / total)) : null });
        });
        set({ phase: 'installing' });
      } catch (e) { set({ phase: 'error', error: String(e?.message ?? e), percent: null }); }
    },
  };
}

export async function initAppUpdater(Store, root = document, bridge = window.__TAURI__) {
  const dialog = root.querySelector('[data-update-dialog]');
  if (!dialog) return;
  const invoke = (command, args) => bridge?.core?.invoke(command, args)
    ?? Promise.reject(new Error('デスクトップアプリから確認してください。'));
  let supported = false;
  let info;
  try { info = await invoke('get_update_info'); supported = info.installSupported; }
  catch { info = { currentVersion: Store.getRuntimeInfo().appVersion }; }
  root.querySelectorAll('[data-update-current]').forEach(el => { el.textContent = `v${info.currentVersion || '—'}`; });
  const controller = createUpdateController({
    check: () => invoke('check_app_update'),
    async install(version, onProgress) {
      const channel = new bridge.core.Channel();
      channel.onmessage = onProgress;
      await invoke('install_app_update', { version, onProgress: channel });
    },
  }, () => ![...root.querySelectorAll('dialog[open]')].some(el => el !== dialog));

  const open = () => { if (!dialog.open) dialog.showModal(); };
  controller.subscribe(s => {
    const busy = ['checking', 'downloading', 'installing'].includes(s.phase);
    const applying = ['downloading', 'installing'].includes(s.phase);
    const status = !supported ? 'インストール版で更新を利用できます。'
      : s.phase === 'checking' ? '更新を確認しています…'
      : s.phase === 'current' ? '最新版です。'
      : s.phase === 'available' ? `v${s.latest.version} に更新できます。`
      : s.phase === 'downloading' ? `ダウンロード中${s.percent == null ? '…' : `… ${s.percent}%`}`
      : s.phase === 'installing' ? '更新して再起動しています…'
      : s.phase === 'error' ? s.error : '「更新を確認」で最新版を確認できます。';
    root.querySelectorAll('[data-update-status]').forEach(el => { el.textContent = status; });
    root.querySelectorAll('[data-update-check]').forEach(el => { el.disabled = busy || !supported; });
    root.querySelectorAll('[data-update-open]').forEach(el => {
      el.hidden = !s.latest; el.textContent = `v${s.latest?.version ?? ''} に更新`; el.disabled = applying;
    });
    dialog.querySelector('[data-update-notes]').textContent = s.latest?.notes || '';
    const install = dialog.querySelector('[data-update-install]');
    install.disabled = !supported || !s.latest || busy;
    dialog.querySelector('[data-update-close]').disabled = applying;
    const progress = dialog.querySelector('progress');
    progress.hidden = !applying;
    if (s.percent == null) progress.removeAttribute('value'); else progress.value = s.percent;
  });
  root.querySelectorAll('[data-update-check]').forEach(el => el.addEventListener('click', () => { void controller.check(); }));
  root.querySelectorAll('[data-update-open]').forEach(el => el.addEventListener('click', open));
  dialog.querySelector('[data-update-install]').addEventListener('click', () => { void controller.install(); });
  dialog.querySelector('[data-update-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', e => {
    if (['downloading', 'installing'].includes(controller.state.phase)) e.preventDefault();
  });
  if (supported && Store.getSettings().checkUpdatesOnStartup) void controller.check();
}
