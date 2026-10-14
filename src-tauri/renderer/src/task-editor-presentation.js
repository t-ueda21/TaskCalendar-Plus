import { t, formatDate } from './i18n.js';

export function refreshTaskEditor(dialog) {
  const field = name => dialog.querySelector(`[name="${name}"]`);
  const allDay = field('allDay')?.checked;
  dialog.querySelectorAll('[data-editor-time]').forEach(row => { row.hidden = Boolean(allDay); });
  const enabled = field('outlookEnabled')?.checked;
  const status = dialog.querySelector('[data-editor-sync-status]');
  if (status) status.textContent = t(!enabled ? 'editor.sendOff' : dialog.dataset.outlookWriteEnabled === 'true' ? 'editor.sendReady' : 'editor.sendPaused');
  const summary = dialog.querySelector('[data-editor-repeat-summary]');
  if (summary) summary.textContent = t('editor.repeatSummary', { start: field('date')?.value || '', end: field('repeatUntil')?.value || '' });
  const isEdit = dialog.hasAttribute('data-edit-id');
  const context = dialog.querySelector('[data-editor-context]');
  const originalDate = dialog._eventOriginal?.date;
  if (context) context.textContent = t(isEdit && originalDate ? 'editor.editContext' : 'editor.newContext', {date:originalDate ? formatDate(new Date(`${originalDate}T12:00:00`)) : ''});
  const recurring = dialog._originalRecurrence?.type && dialog._originalRecurrence.type !== 'none';
  const save = dialog.querySelector('[data-save]');
  if (save && !save.disabled) save.textContent = t(!isEdit ? 'editor.register' : recurring ? 'editor.chooseRange' : 'editor.saveChanges');
}

export function prepareTaskEditor(dialog) {
  if (!dialog.dataset.editorPresentationWired) {
    dialog.dataset.editorPresentationWired = 'true';
    const refresh = () => queueMicrotask(() => refreshTaskEditor(dialog));
    dialog.addEventListener('change', refresh);
    dialog.addEventListener('click', event => { if (event.target.closest('[data-btn-group="repeat"]')) refresh(); });
  }
  refreshTaskEditor(dialog);
}
