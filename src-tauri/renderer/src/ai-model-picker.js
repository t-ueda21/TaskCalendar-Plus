// 設定画面共通のモデル選択。候補の再取得でも、編集中・保存済みの値を保持する。
const states = new WeakMap();
const MANUAL = '__manual_model__';

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
  const { select, manual } = state;
  const options = [new Option('既定を使用（CLIにおまかせ）', '')];
  for (const model of state.models) {
    const label = model.label === model.id ? model.label : `${model.label}（${model.id}）`;
    options.push(new Option(label, model.id));
  }
  if (current && !state.models.some(m => m.id === current)) options.push(new Option(`${current}（現在の設定）`, current));
  options.push(new Option('モデル名を手入力…', MANUAL));
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
  state.status.textContent = 'モデル候補を取得中…';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 32000);
  try {
    const response = await fetch(`/api/ai/models/${provider}`, { signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'モデル一覧を取得できませんでした');
    if (!Array.isArray(data.models) || !data.models.length) throw new Error('モデル候補がありません');
    state.models = data.models.filter(m => typeof m.id === 'string' && m.id && typeof m.label === 'string');
    if (!state.models.length) throw new Error('モデル候補を読み取れませんでした');
    // リクエスト開始後に選び直した値も保持する。
    render(state, readModelSelection(dialog, provider), state.select.value === MANUAL);
    state.loaded = true;
    state.status.textContent = `${state.models.length}件のモデル候補を取得しました。`;
  } catch (error) {
    state.status.textContent = `${error?.name === 'AbortError' ? 'モデル候補の取得がタイムアウトしました' : String(error?.message ?? error)}。既定・現在の設定・手入力も使用できます。`;
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
