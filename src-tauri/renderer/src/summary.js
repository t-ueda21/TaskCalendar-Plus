import * as Store from './store.js';
import { buildSummary, todayInJst } from './summary-model.js';
import { normalizeSummaryPreferences } from './summary-preferences.js';
import { renderSummary, renderSelection } from './summary-renderer.js';
import { wireSettingsDialog } from './settings-dialog.js';
import { getWeatherLocationOptions } from './weather.js';
import { t } from './i18n.js';

let root, state, cachedModel, cacheKey = '', pendingRefresh = null;
const query = key => root.querySelector(`[data-summary-${key}]`);

function invalidate() { cachedModel = null; cacheKey = ''; }

function setStatus(key = '') {
  const status = query('status');
  status.removeAttribute('data-i18n');
  status.textContent = t(key || 'summary.subtitle');
  status.classList.toggle('summaryError', Boolean(key));
  query('notice').hidden = !key;
  query('retry').hidden = !key;
}

function model() {
  const tags = Store.getAllTags();
  if (state.selectedTagIds !== null) {
    const known = new Set(tags.map(tag => tag.id));
    // An externally deleted selection stays empty; only a user action returns to All.
    state.selectedTagIds = state.selectedTagIds.filter(id => known.has(id));
  }
  const today = todayInJst();
  const key = JSON.stringify([state.period,state.year,state.month,today,state.includeFuture,state.selectedTagIds]);
  if (!cachedModel || key !== cacheKey) {
    cachedModel = buildSummary({ ...state, today, tags, settings:Store.getSettings(), getTasksByDate:Store.getTasksByDate });
    cacheKey = key;
  }
  return cachedModel;
}

function render() {
  if (!root || root.hidden) return;
  try {
    renderSummary(root, model(), state);
    setStatus(state.refreshError ? 'summary.refreshError' : '');
  } catch (error) {
    console.error('[summary] Unable to aggregate', error);
    setStatus('summary.calculateError');
  }
}

async function refresh() {
  if (pendingRefresh) return pendingRefresh;
  pendingRefresh = (async () => {
    try { await Store.refreshTasks(); state.refreshError = false; }
    catch { state.refreshError = true; }
    finally { pendingRefresh = null; render(); }
  })();
  return pendingRefresh;
}

function changePeriod(period) {
  state.period = period;
  state.selectedKey = null;
  render();
}

function shiftPeriod(amount) {
  if (state.period === 'year') state.year = Math.max(1, Math.min(9999, state.year + amount));
  else {
    const index = (state.year - 1) * 12 + state.month - 1;
    const next = Math.max(0, Math.min(9999 * 12 - 1, index + amount));
    state.year = Math.floor(next / 12) + 1;
    state.month = next % 12 + 1;
  }
  state.selectedKey = null;
  render();
}

function selectTag(id) {
  if (!Store.getAllTags().some(tag => tag.id === id)) return;
  if (state.selectedTagIds === null) state.selectedTagIds = [id];
  else if (state.selectedTagIds.includes(id)) state.selectedTagIds = state.selectedTagIds.filter(value => value !== id);
  else state.selectedTagIds = [...state.selectedTagIds, id];
  if (!state.selectedTagIds.length || state.selectedTagIds.length === Store.getAllTags().length) state.selectedTagIds = null;
  render();
}

function handleClick(event) {
  const button = event.target.closest('button');
  if (!button || !root.contains(button) || button.disabled) return;
  if (button.hasAttribute('data-summary-period')) changePeriod(button.dataset.summaryPeriod);
  else if (button.hasAttribute('data-summary-shift')) shiftPeriod(Number(button.dataset.summaryShift));
  else if (button.hasAttribute('data-summary-current')) {
    const today = todayInJst();
    state.year = Number(today.slice(0,4)); state.month = Number(today.slice(5,7));
    state.selectedKey = null; render();
  } else if (button.hasAttribute('data-summary-tag')) selectTag(button.dataset.summaryTag);
  else if (button.hasAttribute('data-summary-all-tags')) { state.selectedTagIds = null; render(); }
  else if (button.hasAttribute('data-summary-tag-page')) { state.tagPage += Number(button.dataset.summaryTagPage); render(); }
  else if (button.hasAttribute('data-summary-day') && state.period === 'year') {
    const key = button.dataset.summaryDay;
    state.year = Number(key.slice(0,4)); state.month = Number(key.slice(5,7));
    changePeriod('month');
  } else if (button.hasAttribute('data-summary-day') || button.hasAttribute('data-summary-bar')) {
    state.selectedKey = button.dataset.summaryDay || button.dataset.summaryBar;
    renderSelection(root, model(), state);
  } else if (button.hasAttribute('data-summary-retry')) { render(); void refresh(); }
}

export function init(rootElement) {
  if (root) return;
  root = rootElement;
  const today = todayInJst();
  state = { period:'month',year:Number(today.slice(0,4)),month:Number(today.slice(5,7)),
    includeFuture:false,selectedTagIds:null,selectedKey:null,tagPage:0,refreshError:false,
    preferences:normalizeSummaryPreferences(Store.getSettings().summaryPreferences) };
  root.addEventListener('click', handleClick);
  query('future').addEventListener('change', event => { state.includeFuture = event.target.checked; render(); });
  for (const channel of ['tasks','tags']) Store.subscribe(channel, () => { invalidate(); render(); });
  Store.subscribe('settings', () => {
    state.preferences = normalizeSummaryPreferences(Store.getSettings().summaryPreferences);
    invalidate(); render();
  });
  wireSettingsDialog(document.querySelector('[data-settings-dialog]'), Store, {
    triggerRoot:root,
    getTagMgrSeedDate:() => new Date(`${String(state.year).padStart(4,'0')}-${String(state.month).padStart(2,'0')}-01T12:00:00`),
    getWeatherLocationOptions,
    onAfterSave:() => { invalidate(); render(); },
  });
  // A single lifetime timer handles JST midnight without changing a user-selected period.
  let lastToday = today;
  setInterval(() => {
    const current = todayInJst();
    if (current !== lastToday) { lastToday = current; invalidate(); render(); }
  }, 60000);
}

export function activate() {
  if (!root || root.hidden) return;
  state.preferences = normalizeSummaryPreferences(Store.getSettings().summaryPreferences);
  render();
  void refresh();
}
