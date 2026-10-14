import { t } from './i18n.js';
import { showAppAlert, showAppConfirm, chooseRecurrenceScope } from './app-dialogs.js';
import { chooseSaveScope } from './save-scope.js';
import { validateEventForm } from './event-fields.js';
import { readDialogForm, setupTimePicker, updateTaskByChoice, formatDateKey } from './ui-utils.js';

async function chooseDeleteMode(Store, task) {
  const message = task.title + '\n' + task.date;
  if (Store.getTaskSeriesCount(task) > 1) {
    return chooseRecurrenceScope({title:t('ui.e9653dc3ed'),message,operation:'delete'});
  }
  return await showAppConfirm(message, {title:t('ui.e9653dc3ed'),confirmLabel:t('ui.e9653dc3ed'),danger:true}) ? 'single' : null;
}

export async function deleteTaskByChoice(Store, taskId, preferredMode, onDeleted) {
  const task = Store.getAllTasks().find(task => task.id === taskId);
  if (!task) return;
  const mode = preferredMode ?? await chooseDeleteMode(Store, task);
  if (!mode) return false;
  if (preferredMode && !await showAppConfirm(task.title + '\n' + task.date, {title:t('ui.e9653dc3ed'),confirmLabel:t('ui.e9653dc3ed'),danger:true})) return false;
  try { await Store.deleteTaskWithMode(taskId, mode); }
  catch (error) { await showAppAlert(String(error?.message ?? error), {tone:'error'}); return false; }
  onDeleted?.(task, mode);
  return true;
}

/** Shared editor lifecycle; each view keeps its own history and selection effects. */
export function wireTaskEditor(dialog, {Store, getDate, deleteTask, beforeUpdate, onUpdated, onCreated}) {
  if (!dialog) return;
  let saving = false;
  const saveTask = async () => {
    if (saving) return;
    let taskPatch;
    try { taskPatch = readDialogForm(dialog); }
    catch (error) { await showAppAlert(String(error.message || error), {tone:'error'}); return; }
    if (!validateEventForm(dialog, taskPatch)) return;
    if (!taskPatch.title) { await showAppAlert(t('ui.f611575d37'), {tone:'error'}); return; }
    const saveButton = dialog.querySelector('[data-save]');
    saving = true;
    if (saveButton) {
      saveButton.disabled = true;
      saveButton.dataset.origText = saveButton.textContent;
      saveButton.textContent = t('ui.ff509c9ba0');
    }
    try {
      const editId = dialog.getAttribute('data-edit-id');
      if (editId) {
        const mode = await chooseSaveScope(dialog, taskPatch);
        if (!mode || !dialog.open) return;
        const context = beforeUpdate?.(editId, taskPatch, mode);
        const updated = await updateTaskByChoice(Store, editId, taskPatch, mode);
        if (!updated) return;
        onUpdated?.(editId, taskPatch, mode, context);
      } else {
        const created = await Store.createTask({...taskPatch, date:taskPatch.date || formatDateKey(getDate())});
        onCreated?.(created);
      }
      dialog.close();
    } catch (error) {
      await showAppAlert(t('ui.20817f47e9', {p0:String(error?.message ?? error)}), {tone:'error'});
    } finally {
      saving = false;
      if (saveButton) { saveButton.disabled = false; saveButton.textContent = saveButton.dataset.origText || t('ui.a3030bf8f1'); }
    }
  };
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    saving = false;
    const button = dialog.querySelector('[data-save]');
    if (button) { button.disabled = false; if (button.dataset.origText) button.textContent = button.dataset.origText; }
  });
  dialog.querySelector('[data-cancel]')?.addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-save]')?.addEventListener('click', () => { void saveTask(); });
  dialog.querySelector('[data-delete]')?.addEventListener('click', async () => {
    const id = dialog.getAttribute('data-edit-id');
    if (id && await deleteTask(id)) dialog.close();
  });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
    if (event.target.closest('button') || event.target instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    void saveTask();
  });
  dialog.querySelectorAll('[data-time-picker]').forEach(setupTimePicker);
}
