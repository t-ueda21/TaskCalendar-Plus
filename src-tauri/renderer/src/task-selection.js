/** Selection order comes from the current visible/sorted view. */
export class TaskSelection {
  ids = new Set();
  anchor = null;
  select(id, {ctrlKey=false,metaKey=false,shiftKey=false}={}, ordered=[]) {
    const extend = ctrlKey || metaKey;
    const from = ordered.indexOf(this.anchor), to = ordered.indexOf(id);
    if (shiftKey && from >= 0 && to >= 0) {
      const range = ordered.slice(Math.min(from,to), Math.max(from,to)+1);
      this.ids = new Set(extend ? [...this.ids,...range] : range);
    } else if (extend) {
      this.ids.has(id) ? this.ids.delete(id) : this.ids.add(id);
      this.anchor = id;
    } else {
      this.ids = new Set([id]);
      this.anchor = id;
    }
    return [...this.ids];
  }
  clear() { this.ids.clear(); this.anchor=null; }
  prune(visible) {
    const allowed = new Set(visible);
    this.ids = new Set([...this.ids].filter(id=>allowed.has(id)));
    if (!allowed.has(this.anchor)) this.anchor=null;
  }
}

/** Only explicit fields change; recurring instances keep their series identity. */
export function prepareBulkTasks(tasks, patch) {
  if (!Array.isArray(tasks) || !tasks.length || new Set(tasks.map(t=>t.id)).size !== tasks.length) throw new Error('Invalid selection');
  const keys = Object.keys(patch);
  if (!keys.length || keys.some(key=>!['tagId','date','memo'].includes(key))) throw new Error('Invalid bulk fields');
  if (keys.some(key=>typeof patch[key] !== 'string')) throw new Error('Invalid bulk value');
  if ('date' in patch) {
    const parsed = new Date(patch.date+'T12:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.date) || !Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0,10)!==patch.date) throw new Error('Invalid date');
  }
  return tasks.map(task=>{
    const next = {...task,...patch,recurrence:{...(task.recurrence??{type:'none'})}};
    if ('date' in patch && patch.date!==task.date && next.recurrence.type!=='none') {
      next.recurrence.occurrenceDate = task.recurrence?.occurrenceDate ?? task.date;
      next.recurrence.exception = true;
    }
    return next;
  });
}
