import { t as translate } from './i18n.js';
import { createUpdateController, isUpdateApplying, isUpdateBusy } from './app-update-controller.js';
import { renderMarkdown } from './markdown.js';

// Preserve the existing module API for callers of the standalone controller.
export { createUpdateController } from './app-update-controller.js';

function createNativeUpdater(bridge) {
  const invoke = (command, args) => bridge?.core?.invoke(command, args)
    ?? Promise.reject(new Error(translate('ui.d71fe06e63')));
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
  if (!supported) return translate('ui.d3a8a5b1ae');
  switch (state.phase) {
    case 'checking': return translate('ui.a134f8e299');
    case 'current': return translate('ui.c2e7d35cca');
    case 'available': return translate('ui.d0904a76f9', { p0: (state.latest.version) });
    case 'downloading': return translate('ui.1553ebcc89', { p0: (state.percent == null ? '…' : `… ${state.percent}%`) });
    case 'installing': return translate('ui.729931a79b');
    case 'error': return state.error;
    default: return translate('ui.a70855b644');
  }
}

// Toolbar entries keep their icons; other open buttons display translated text.
function renderUpdateOpenButtons(view, latest, { hasUpdate, busy, applying }) {
  const title = hasUpdate ? translate('ui.728be0b322', { p0: latest.version }) : translate('ui.916ee83f1b');
  view.openButtons.forEach(el => {
    const entry = view.entries.includes(el);
    el.hidden = !entry && !hasUpdate;
    if (!entry) {
      el.textContent = el.closest('[data-settings-dialog]') ? translate('ui.1c0e325f78')
        : hasUpdate ? translate('ui.c5837a6813') : busy ? translate('ui.0064397763') : translate('ui.d0e7d03d32');
    }
    el.title = title;
    if (entry) {
      el.classList.toggle('hasUpdate', hasUpdate);
      el.setAttribute('aria-label', hasUpdate ? translate('ui.439ecd40e6', { p0: el.title }) : busy ? translate('ui.7ad2329c15') : el.title);
    }
    el.disabled = applying;
  });
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
    entries: all('[data-update-entry]'),
    title: dialog.querySelector('#update-title'),
    intro: dialog.querySelector('.updateIntro'),
    notesHeading: dialog.querySelector('.updateNotesHeading'),
    availableDetails: ['.updateSafetyNote', '.updateLatestVersion'].map(selector => dialog.querySelector(selector)),
    versionArrow: dialog.querySelector('.updateVersionComparison [aria-hidden]'),
    notes: dialog.querySelector('[data-update-notes]'),
    install: dialog.querySelector('[data-update-install]'),
    close: dialog.querySelector('[data-update-close]'),
    progress: dialog.querySelector('progress'),
    show() { if (!dialog.open) dialog.showModal(); },
    render(state) {
      const flags = {
        hasUpdate: Boolean(state.latest),
        busy: isUpdateBusy(state.phase),
        applying: isUpdateApplying(state.phase),
      };
      const { hasUpdate, busy, applying } = flags;
      const status = updateStatus(state, supported);
      view.statuses.forEach(el => { el.textContent = status; });
      view.checkButtons.forEach(el => { el.disabled = busy || !supported; });
      renderUpdateOpenButtons(view, state.latest, flags);
      view.title.textContent = hasUpdate ? translate('ui.08ba844851') : translate('ui.f156c3dde4');
      view.intro.textContent = hasUpdate
        ? translate('ui.83b81c3e1c') : translate('ui.ad25ca5044');
      view.availableDetails.forEach(el => { el.hidden = !hasUpdate; });
      if (view.versionArrow) view.versionArrow.hidden = !hasUpdate;
      view.install.hidden = !hasUpdate;
      view.close.textContent = hasUpdate ? translate('ui.c829aa2489') : translate('ui.f6c244f988');
      view.latest.forEach(el => { el.textContent = hasUpdate ? `v${state.latest.version}` : '—'; });
      const notes = state.latest?.notes?.trim() || '';
      // Release text is untrusted. renderMarkdown escapes HTML before formatting it.
      view.notes.innerHTML = renderMarkdown(notes);
      view.notes.hidden = !notes;
      view.notesHeading.hidden = !notes;
      view.install.disabled = !supported || !hasUpdate || busy;
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
  root.addEventListener('tcplus:language', () => view.render(controller.state));
  const notifyAtStartup = createStartupNotice(root, controller, view, hasOpenEditor);

  view.checkButtons.forEach(el => el.addEventListener('click', () => { void controller.check(); }));
  view.openButtons.forEach(el => el.addEventListener('click', async () => {
    const settings = el.closest('[data-settings-dialog]');
    if (settings?.open && !await settings._wsdCore?.saveSettings()) return;
    view.show();
    if (view.entries.includes(el) && supported && !controller.state.latest) await controller.check();
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
