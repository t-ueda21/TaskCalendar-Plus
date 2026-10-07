import { t as translate } from './i18n.js';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function parseBackupFile(text) {
  let data; try { data = JSON.parse(text); } catch { throw new Error(translate('transfer.invalidJson')); }
  if (!object(data) || data.format !== 'taskcalendar-plus-backup') throw new Error(translate('transfer.invalidBackup'));
  if (data.version !== 1) throw new Error(translate('transfer.invalidVersion'));
  if (!Array.isArray(data.tasks) || !Array.isArray(data.tags) || !object(data.settings) || !object(data.aiMemory)
      || !['summary','notes','chat'].every(key=>object(data.aiMemory[key]))
      || Object.keys(data.aiMemory).some(key=>!['summary','notes','chat'].includes(key))) throw new Error(translate('transfer.invalidBackup'));
  if (data.tasks.some(row=>!object(row)||!row.id||!row.date||!row.createdAt||!row.updatedAt)
      || data.tags.some(row=>!object(row)||!row.id||!row.name)) throw new Error(translate('transfer.invalidBackup'));
  return data;
}

export function bindValidatedFile(dialog, { input, button, name, status, parse, preview }) {
  let current = null, generation = 0;
  button.disabled = true;
  const reset = () => { generation++; current = null; button.disabled = true; };
  input.addEventListener('change', async () => {
    reset(); const token = generation, file = input.files?.[0];
    name.textContent = file?.name ?? translate('transfer.noFile'); status.textContent = '';
    if (!file) return;
    status.textContent = translate('transfer.checking');
    try {
      const parsed = parse(await file.text());
      if (generation !== token) return;
      current = parsed; status.textContent = preview(parsed); button.disabled = false;
    } catch (error) { if(generation===token)status.textContent=String(error.message??error); }
  });
  dialog.addEventListener('close', () => { reset(); input.value = ''; name.textContent = translate('transfer.noFile'); status.textContent = ''; });
  return { get: ()=>current, clear: ()=>{reset();input.value='';name.textContent=translate('transfer.noFile');}, busy: value=>{input.disabled=value;button.disabled=value||!current;} };
}
