export const isUpdateApplying = phase => ['downloading', 'installing'].includes(phase);
export const isUpdateBusy = phase => phase === 'checking' || isUpdateApplying(phase);

// Update state is independent of the DOM so failure/retry paths can be tested.
export function createUpdateController(native, canInstall = () => true) {
  let state = { phase: 'idle', latest: null, error: '', percent: null };
  const listeners = new Set();
  const busy = () => isUpdateBusy(state.phase);
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

