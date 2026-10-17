import { t } from './i18n.js';
import { chooseAppItems } from './app-dialogs.js';
import { calendarSelectionLabel } from './outlook-calendar-picker.js';

export function wireLegacySourceReview(dialog, Store, status) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'btn'; button.hidden = true;
  button.dataset.legacySourceOpen = ''; button.textContent = t('outlook.legacyOpen');
  status.after(button);
  let pending = null;
  let running = false;
  dialog.addEventListener('close', () => { pending = null; button.hidden = true; });
  button.addEventListener('click', async () => {
    if (!pending || running) return;
    const { calendar, candidates } = pending;
    running = true; button.disabled = true;
    try {
      const selected = await chooseAppItems(t('outlook.legacyMessage', { calendar: calendarSelectionLabel(calendar) }), {
        title: t('outlook.legacyOpen'), confirmLabel: t('outlook.legacyConfirm'),
        items: candidates.map(row => ({ id: row.id, label: row.title, description: row.date })),
        onConfirm: async ids => {
          const chosen = new Set(ids);
          const response = await fetch('/api/outlook/legacy-source', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ calendar, tasks: candidates.filter(row => chosen.has(row.id)).map(({id, updatedAt}) => ({id, updatedAt})) }) });
          const result = await response.json();
          if (!response.ok) throw Error(result.error || t('outlook.failed'));
        },
      });
      if (!selected || !dialog.open) return;
      pending = null; button.hidden = true;
      await Store.refreshTasks();
      status.textContent = t('outlook.legacyConfirmed'); status.className = 'settingsOutlookStatus success';
    } catch (error) { status.textContent = String(error.message ?? error); status.className = 'settingsOutlookStatus error'; }
    finally { running = false; button.disabled = false; }
  });
  return { update(data) {
    const candidates = Array.isArray(data.legacyCandidates) ? data.legacyCandidates : [];
    pending = candidates.length && String(data.calendarRef).startsWith('outlook-folder:') ? {calendar:data.calendarRef, candidates} : null;
    button.hidden = !pending; button.textContent = t('outlook.legacyOpen');
    if (pending) status.textContent += '\n' + t('outlook.legacyRemaining', {count:candidates.length});
  }};
}
