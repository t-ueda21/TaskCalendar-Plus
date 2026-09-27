import { MANUAL_MODEL, renderModelChoices } from './ai-model-picker.js';

// Local API settings and transient requests. Model files remain managed by Ollama / LM Studio.
export const LOCAL_AI_PROVIDERS = {
  ollama: { label: 'Ollama', endpoint: 'http://localhost:11434/v1', endpointKey: 'aiOllamaEndpoint', modelKey: 'aiOllamaModel' },
  lmstudio: { label: 'LM Studio', endpoint: 'http://localhost:1234/v1', endpointKey: 'aiLmStudioEndpoint', modelKey: 'aiLmStudioModel' },
};

export function localAiConfig(settings, provider = settings?.aiProvider) {
  if (!Object.hasOwn(LOCAL_AI_PROVIDERS, provider)) return null;
  const definition = LOCAL_AI_PROVIDERS[provider];
  return { provider, endpoint: String(settings?.[definition.endpointKey] ?? '').trim() || definition.endpoint,
    model: String(settings?.[definition.modelKey] ?? '').trim() };
}

export function validateLocalAi(config, requireModel = true) {
  if (!config || !Object.hasOwn(LOCAL_AI_PROVIDERS, config.provider)) return '接続先を選択してください。';
  try {
    const url = new URL(config.endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { return 'エンドポイントは認証情報・クエリを含まない http:// または https:// のURLを入力してください。'; }
  return requireModel && !config.model ? 'モデル名を入力するか、取得した候補から選んでください。' : '';
}

export async function requestLocalAi(action, config, signal) {
  const response = await fetch(`/api/ai/local/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config), signal,
  });
  const data = await response.json().catch(() => { throw new Error('サーバーの応答を読み取れませんでした。'); });
  if (!response.ok) throw new Error(data?.error || `接続できませんでした（${response.status}）。`);
  return data;
}

const dialogs = new WeakMap();
function stateFor(dialog) {
  if (dialogs.has(dialog)) return dialogs.get(dialog);
  const panels = new Map();
  for (const provider of Object.keys(LOCAL_AI_PROVIDERS)) {
    const panel = dialog.querySelector(`[data-ai-provider-panel="${provider}"]`);
    if (!panel) continue;
    const state = { panel, provider, controller: null,
      endpoint: panel.querySelector('[data-local-ai-endpoint]'), model: panel.querySelector('[data-local-ai-model]'),
      manual: panel.querySelector('[data-local-ai-manual]'), models: [], status: panel.querySelector('[data-local-ai-status]'),
      buttons: [...panel.querySelectorAll('[data-local-ai-action]')] };
    const invalidate = () => {
      state.controller?.abort(); state.controller = null;
      state.buttons.forEach(button => { button.disabled = false; }); state.status.textContent = '';
    };
    state.invalidate = invalidate;
    state.endpoint.addEventListener('input', () => {
      invalidate(); state.models = []; renderModels(state);
    });
    state.model.addEventListener('change', () => {
      invalidate(); state.manual.hidden = state.model.value !== MANUAL_MODEL;
    });
    state.manual.addEventListener('input', invalidate);
    state.buttons.forEach(button => button.addEventListener('click', () => { void run(state, button.dataset.localAiAction); }));
    panels.set(provider, state);
  }
  dialog.querySelector('[data-ai-provider-select]')?.addEventListener('change', () => panels.forEach(state => state.invalidate()));
  dialog.addEventListener('close', () => panels.forEach(state => state.invalidate()));
  dialogs.set(dialog, panels);
  return panels;
}

function readPanel(state) {
  return {provider: state.provider, endpoint: state.endpoint.value.trim() || LOCAL_AI_PROVIDERS[state.provider].endpoint,
    model: (state.model.value === MANUAL_MODEL ? state.manual.value : state.model.value).trim()};
}

function renderModels(state, current = readPanel(state).model, manualMode = state.model.value === MANUAL_MODEL) {
  renderModelChoices(state.model, state.manual, state.models, current, manualMode, 'モデルを選択してください');
}

async function run(state, action) {
  state.invalidate();
  const config = readPanel(state);
  const error = validateLocalAi(config, action === 'test');
  if (error) { state.status.textContent = error; return; }
  const controller = new AbortController(); state.controller = controller;
  state.buttons.forEach(button => { button.disabled = true; });
  state.status.textContent = action === 'models' ? 'モデル候補を取得中…' : '接続と道具の呼び出しを確認中…';
  const timer = setTimeout(() => controller.abort(), action === 'models' ? 32000 : 180000);
  try {
    const data = await requestLocalAi(action, config, controller.signal);
    if (state.controller !== controller || controller.signal.aborted) return;
    if (action === 'models') {
      if (!Array.isArray(data.models)) throw new Error('モデル一覧の形式を読み取れませんでした。');
      const ids = [...new Set(data.models.map(row => row?.id).filter(id => typeof id === 'string' && id.trim()))];
      state.models = ids.map(id => ({id, label:id}));
      renderModels(state);
      state.status.textContent = ids.length ? `${ids.length}件取得しました。プルダウンから選択してください。一覧にない場合は「モデル名を手入力…」を選べます。`
        : 'モデルがありません。接続先でモデルを用意して再取得してください。';
    } else {
      if (data.ok !== true || typeof data.toolsSupported !== 'boolean') throw new Error('接続テストの応答を読み取れませんでした。');
      state.status.textContent = data.toolsSupported ? '接続と道具の呼び出しを確認できました。保存すると使用できます。'
        : '接続できましたが、道具の呼び出しは確認できませんでした。AIモードでは道具に対応したモデルを選んでください。';
    }
  } catch (error) {
    if (state.controller !== controller) return;
    state.status.textContent = controller.signal.aborted ? '応答が時間内に返りませんでした。サーバーとモデルの状態を確認してください。'
      : `${String(error?.message ?? error)} モデル名は手入力もできます。`;
  } finally {
    clearTimeout(timer);
    if (state.controller === controller) { state.controller = null; state.buttons.forEach(button => { button.disabled = false; }); }
  }
}

export function populateLocalAiSettings(dialog, settings) {
  for (const [provider, state] of stateFor(dialog)) {
    state.invalidate(); state.models = [];
    const config = localAiConfig(settings, provider);
    state.endpoint.value = config.endpoint; renderModels(state, config.model, false);
  }
}

export function readLocalAiSettings(dialog) {
  const result = {};
  for (const [provider, state] of stateFor(dialog)) {
    const definition = LOCAL_AI_PROVIDERS[provider], config = readPanel(state);
    result[definition.endpointKey] = config.endpoint; result[definition.modelKey] = config.model;
  }
  return result;
}

export function validateSelectedLocalAi(dialog) {
  const provider = dialog.querySelector('[data-ai-provider-select]')?.value;
  const state = stateFor(dialog).get(provider);
  if (!state) return true;
  const config = readPanel(state), error = validateLocalAi(config);
  if (!error) return true;
  state.status.textContent = error;
  (config.model ? state.endpoint : state.model.value === MANUAL_MODEL ? state.manual : state.model).focus();
  return false;
}

// Imports can change only the endpoint of an already-selected provider.
export function describeLocalAiImport(patch, current = {}) {
  const effective = { ...current, ...patch };
  const selected = String(patch.aiProvider ?? "").trim();
  effective.aiProvider = String(effective.aiProvider ?? "").trim();
  return Object.entries(LOCAL_AI_PROVIDERS).flatMap(([provider, definition]) => {
    if (!(definition.endpointKey in patch) && !(definition.modelKey in patch) && selected !== provider) return [];
    const config = localAiConfig(effective, provider);
    return [`・${definition.label}の送信先: ${config.endpoint}（モデル: ${config.model || '未設定'}）`];
  });
}

export function validateLocalAiImport(patch, current = {}) {
  const effective = { ...current, ...patch };
  const selected = String(patch.aiProvider ?? "").trim();
  effective.aiProvider = String(effective.aiProvider ?? "").trim();
  for (const [provider, definition] of Object.entries(LOCAL_AI_PROVIDERS)) {
    if (!(definition.endpointKey in patch) && !(definition.modelKey in patch) && selected !== provider) continue;
    const error = validateLocalAi(localAiConfig(effective, provider), effective.aiProvider === provider);
    if (error) throw new Error(`${definition.label}: ${error}`);
  }
}
