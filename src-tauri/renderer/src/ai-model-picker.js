import { t as translate, th as translateHtml } from './i18n.js';
// 設定画面共通のモデル選択。候補の再取得でも、編集中・保存済みの値を保持する。
const states = new WeakMap();
export const MANUAL_MODEL = '__manual_model__';
const MANUAL = MANUAL_MODEL;

function picker(dialog, provider) {
  let providers = states.get(dialog);
  if (!providers) { providers = new Map(); states.set(dialog, providers); }
  if (providers.has(provider)) return providers.get(provider);
  const panel = dialog.querySelector(`[data-ai-provider-panel="${provider}"]`);
  if (!panel) return null;
  const select = panel.querySelector('[data-ai-model-select]');
  const manual = panel.querySelector('[data-ai-model-manual]');
  const refresh = panel.querySelector('[data-ai-model-refresh]');
  const status = panel.querySelector('[data-ai-model-status]');
  const state = { select, manual, refresh, status, models: [], loading: false, loaded: false };
  providers.set(provider, state);
  select.addEventListener('change', () => { manual.hidden = select.value !== MANUAL; });
  refresh.addEventListener('click', () => load(dialog, provider, true));
  return state;
}

function render(state, current, manualMode = false) {
  renderModelChoices(state.select, state.manual, state.models, current, manualMode);
}

export function renderModelChoices(select, manual, models, current, manualMode = false, placeholder = translate('ui.eefb4763d5')) {
  const options = [new Option(placeholder, '')];
  for (const model of models) {
    const label = model.label === model.id ? model.label : `${model.label}（${model.id}）`;
    options.push(new Option(label, model.id));
  }
  if (current && !models.some(m => m.id === current)) options.push(new Option(translate('ui.c8460b00f6', { p0: (current) }), current));
  options.push(new Option(translate('ui.bf899282fe'), MANUAL));
  select.replaceChildren(...options);
  select.value = manualMode ? MANUAL : current;
  manual.value = current;
  manual.hidden = !manualMode;
}

export function readModelSelection(dialog, provider) {
  const state = picker(dialog, provider);
  return String(state?.select.value === MANUAL ? state.manual.value : state?.select.value ?? '').trim();
}

export function populateModelSelection(dialog, provider, current) {
  const state = picker(dialog, provider);
  if (state) render(state, String(current ?? '').trim());
}

async function load(dialog, provider, force = false) {
  const state = picker(dialog, provider);
  if (!state || state.loading || (state.loaded && !force)) return;
  state.loading = true;
  state.refresh.disabled = true;
  state.status.textContent = translate('ui.80b28e7645');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 32000);
  try {
    const response = await fetch(`/api/ai/models/${provider}`, { signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || translate('ui.0b8f881f33'));
    if (!Array.isArray(data.models) || !data.models.length) throw new Error(translate('ui.fc6eb36c41'));
    state.models = data.models.filter(m => typeof m.id === 'string' && m.id && typeof m.label === 'string');
    if (!state.models.length) throw new Error(translate('ui.83556c4da8'));
    // リクエスト開始後に選び直した値も保持する。
    render(state, readModelSelection(dialog, provider), state.select.value === MANUAL);
    state.loaded = true;
    state.status.textContent = translate('ui.40e5147e1b', { p0: (state.models.length) });
  } catch (error) {
    state.status.textContent = translate('ui.e1242fb0ff', { p0: (error?.name === 'AbortError' ? 'モデル候補の取得がタイムアウトしました' : String(error?.message ?? error)) });
  } finally {
    clearTimeout(timer);
    state.loading = false;
    state.refresh.disabled = false;
  }
}

export function loadSelectedModels(dialog) {
  if (!dialog.querySelector('[data-ai-cli-enabled]')?.checked) return;
  const provider = dialog.querySelector('[data-ai-provider-select]')?.value;
  if (provider === 'claude-code' || provider === 'codex') void load(dialog, provider);
}
