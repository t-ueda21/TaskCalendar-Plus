import { formatDateKey } from './ui-utils.js';
import { t as translate } from './i18n.js';

export function rangePreset(kind, selected = new Date(), now = new Date()) {
  const date = kind === 'view' ? new Date(selected) : new Date(now);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  let end;
  if (kind === 'month') { start.setDate(1); end = new Date(start.getFullYear(), start.getMonth() + 1, 0); }
  else { start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); end = new Date(start); end.setDate(start.getDate() + 6); }
  return { startDate: formatDateKey(start), endDate: formatDateKey(end) };
}

export function wireOutlookSync(dialog, Store, { getTagMgrMonth, getSelectedDate } = {}) {
  const find = selector => dialog.querySelector(selector);
  const button = find('[data-sync-outlook-btn]'), status = find('[data-outlook-sync-status]');
  if (!button || !status) return;
  const mode = find('[data-outlook-fetch-mode]'), start = find('[data-outlook-start]'), end = find('[data-outlook-end]');
  const days = find('[name="outlookDays"]'), tag = find('[data-outlook-tag-select]'), calendar = find('[name="outlookCalendarName"]');
  const syncMode = () => { find('[data-outlook-date-range]').hidden = mode.value !== 'range'; days.disabled = mode.value === 'range'; };
  mode.addEventListener('change', syncMode); syncMode();
  const preset = kind => { const range = rangePreset(kind, getSelectedDate?.() ?? new Date()); start.value = range.startDate; end.value = range.endDate; };
  preset('week');
  dialog.querySelectorAll('[data-outlook-preset]').forEach(node => node.addEventListener('click', () => preset(node.dataset.outlookPreset)));
  const updateTagOptions = () => {
    const current = tag.value, month = getTagMgrMonth();
    tag.querySelectorAll('option').forEach(option => { if (option.value) option.remove(); });
    const tags = Store.hasMonthTagOrder(month) ? Store.getTagsForMonth(month) : [];
    for (const row of tags) { const option = document.createElement('option'); option.value = row.id; option.textContent = row.name; tag.appendChild(option); }
    tag.value = tags.some(row => row.id === current) ? current : '';
  };
  dialog.__refreshOutlookTagOptions = updateTagOptions;
  updateTagOptions(); Store.subscribe('tags', updateTagOptions);
  let active = null;
  dialog.addEventListener('close', () => { active?.abort(); active = null; });
  button.addEventListener('click', async () => {
    if (active) return;
    const controller = new AbortController(); active = controller;
    button.disabled = true; status.textContent = translate('outlook.loading'); status.className = 'settingsOutlookStatus';
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      if (mode.value === 'range' && (!start.value || !end.value || end.value < start.value)) throw new Error(translate('outlook.invalidRange'));
      await Store.updateSettings({ outlookSyncCalendarName: calendar.value.trim() || 'Calendar', outlookSyncTagId: tag.value, outlookSyncDaysAhead: Math.max(1, Math.min(Number(days.value) || 90, 365)) });
      const response = await fetch('/api/outlook/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: mode.value, startDate: start.value, endDate: end.value }), signal: controller.signal });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || translate('outlook.failed'));
      await Store.refreshTasks();
      if (active !== controller) return;
      status.textContent = translate('outlook.result', { added: data.added ?? 0, updated: data.updated ?? 0, deleted: data.deleted ?? 0, skipped: data.skipped ?? 0 });
      if (Number(data.conflicts) > 0) status.textContent += ' ' + translate('outlook.conflicts', { count: data.conflicts });
      if (Array.isArray(data.warnings) && data.warnings.length) status.textContent += '\n' + data.warnings.join(' / ');
      status.className = 'settingsOutlookStatus ' + (data.conflicts || data.warnings?.length ? 'error' : 'success');
    } catch (error) {
      if (active !== controller) return;
      status.textContent = error.name === 'AbortError' ? translate('outlook.timeout') : String(error.message ?? error);
      status.className = 'settingsOutlookStatus error';
    } finally { clearTimeout(timeout); if (active === controller) active = null; if (!active) button.disabled = false; }
  });
}
