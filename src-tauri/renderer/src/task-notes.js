export function hasOutlookReference(task) {
  return Boolean(task?.outlookOccurrenceKey || task?.outlookSeriesId);
}
export function personalMemo(task) {
  if (task?.localMemo != null) return String(task.localMemo);
  const imported = hasOutlookReference(task) && !String(task.outlookOccurrenceKey || '').startsWith('tcplus:');
  return imported ? '' : String(task?.memo || '');
}
export function memoPatch(task, value) {
  const localMemo = String(value || '').trim();
  return {localMemo, memo:String(task?.memo || '')};
}
