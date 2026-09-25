import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { pathToFileURL } from 'node:url';

globalThis.crypto ??= webcrypto;
globalThis.document = { addEventListener() {} };
const timers = [];
globalThis.setInterval = (fn) => { timers.push(fn); return timers.length; };
const clone = (value) => JSON.parse(JSON.stringify(value));
const db = { tasks: [], tags: [{ id: 'tag', name: 'Work', color: '#123456' }, { id: 'other', name: 'Other', color: '#abcdef' }], settings: {} };
let revision = 0;
let rejectNextBatch = false;
const calls = [];
const reply = (value, status = 200) => ({ ok: status < 400, status, text: async () => value == null ? '' : JSON.stringify(value) });
globalThis.fetch = async (url, options = {}) => {
  const method = options.method || 'GET';
  const path = url.replace(/^\/api/, '');
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ method, path, body });
  if (path === '/runtime') return reply({});
  if (path.startsWith('/ai-memory/') && method === 'GET') return reply([]);
  if (path === '/tasks' && method === 'GET') return reply(db.tasks);
  if (path === '/tags' && method === 'GET') return reply(db.tags);
  if (path === '/settings' && method === 'GET') return reply(db.settings);
  if (path === '/settings' && method === 'PUT') { db.settings = clone(body); return reply(db.settings); }
  if (path === '/tasks' && method === 'POST') {
    if (db.tasks.some((row) => row.id === body.id)) return reply({ error: 'duplicate' }, 409);
    const saved = { ...body, updatedAt: `rev-${++revision}` };
    db.tasks.push(saved); return reply(saved);
  }
  if (path === '/tasks/batch' && method === 'POST') {
    if (rejectNextBatch) { rejectNextBatch = false; return reply({ error: 'injected failure' }, 409); }
    const existingIds = new Set(db.tasks.map((row) => row.id));
    const expected = new Map(body.expected.map((row) => [row.id, row.updatedAt]));
    const mutations = [...body.upserts.filter((row) => existingIds.has(row.id)).map((row) => row.id), ...body.deleteIds];
    if (mutations.some((id) => db.tasks.find((row) => row.id === id)?.updatedAt !== expected.get(id))
      || body.upserts.some((row) => !expected.has(row.id) && existingIds.has(row.id))) {
      return reply({ error: 'conflict' }, 409);
    }
    const next = db.tasks.filter((row) => !body.deleteIds.includes(row.id) && !body.upserts.some((item) => item.id === row.id));
    next.push(...body.upserts.map((row) => ({ ...row, updatedAt: `rev-${++revision}` })));
    db.tasks = clone(next);
    return reply(db.tasks);
  }
  const taskMatch = path.match(/^\/tasks\/([^/?]+)(?:\?(.*))?$/);
  if (taskMatch) {
    const id = decodeURIComponent(taskMatch[1]);
    const row = db.tasks.find((task) => task.id === id);
    if (!row) return reply({ error: 'missing' }, 404);
    if (method === 'PUT') {
      if (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== row.updatedAt) return reply({ error: 'conflict' }, 409);
      const saved = { ...body, updatedAt: `rev-${++revision}` };
      delete saved.expectedUpdatedAt;
      db.tasks = db.tasks.map((task) => task.id === id ? saved : task);
      return reply(saved);
    }
    if (method === 'DELETE') {
      const expected = new URLSearchParams(taskMatch[2] ?? '').get('expectedUpdatedAt');
      if (expected !== null && expected !== row.updatedAt) return reply({ error: 'conflict' }, 409);
      db.tasks = db.tasks.filter((task) => task.id !== id);
      return reply(null, 204);
    }
  }
  return reply({ error: `unhandled ${method} ${path}` }, 404);
};

const root = process.cwd();
const Store = await import(pathToFileURL(`${root}/src-tauri/renderer/src/store.js`));
const UI = await import(pathToFileURL(`${root}/src-tauri/renderer/src/ui-utils.js`));
await Store.init();
const base = { title: 'Audit', date: '2026-09-01', isAllDay: false, startTime: '09:00', endTime: '10:00', tagId: 'tag', memo: 'original' };
async function reset() { db.tasks = []; await Store.refreshTasks(); }
const dates = () => Store.getAllTasks().map((task) => task.date).sort();

await reset();
const first = await Store.createTask({ ...base, recurrence: { type: 'daily', until: '2026-09-03' } });
const originalId = first.id;
await Store.updateTaskWithMode(first.id, { recurrence: { type: 'daily', until: '2026-09-05' } }, 'series');
assert.deepEqual(dates(), ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']);
assert.equal(Store.getAllTasks().find((task) => task.date === '2026-09-01').id, originalId);
await Store.updateTaskWithMode(first.id, { recurrence: { type: 'weekly', until: '2026-09-30' } }, 'series');
assert.deepEqual(dates(), ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29']);
assert.equal(Store.getAllTasks().find((task) => task.date === '2026-09-01').id, originalId);
assert.equal(new Set(Store.getAllTasks().map((task) => task.recurrence.groupId)).size, 1);

await reset();
const lone = await Store.createTask({ ...base, recurrence: { type: 'daily', until: '2026-09-03' } });
for (const row of Store.getAllTasks().filter((row) => row.id !== lone.id)) await Store.deleteTask(row.id);
await Store.updateTaskWithMode(lone.id, { recurrence: { type: 'weekly', until: '2026-09-22' } }, 'series');
assert.deepEqual(dates(), ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22']);

await reset();
const futureBase = await Store.createTask({ ...base, recurrence: { type: 'daily', until: '2026-09-05' } });
const third = Store.getAllTasks().find((task) => task.date === '2026-09-03');
await Store.updateTaskWithMode(third.id, { recurrence: { type: 'weekly', until: '2026-09-24' } }, 'future');
assert.deepEqual(dates(), ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-10', '2026-09-17', '2026-09-24']);
assert.equal(Store.getAllTasks().find((task) => task.date === '2026-09-03').id, third.id);
assert.notEqual(Store.getAllTasks().find((task) => task.date === '2026-09-01').recurrence.groupId,
  Store.getAllTasks().find((task) => task.date === '2026-09-03').recurrence.groupId);
await Store.updateTaskWithMode(Store.getAllTasks().find((task) => task.date === '2026-09-24').id,
  { recurrence: { type: 'weekly', until: '2026-10-08' } }, 'future');
assert.ok(dates().includes('2026-10-08'));

await reset();
await Store.createTask({ ...base, date: '2026-01-31', recurrence: { type: 'monthly', until: '2026-03-31' } });
const february = Store.getAllTasks().find((task) => task.date === '2026-02-28');
await Store.updateTaskWithMode(february.id, { recurrence: { type: 'monthly', until: '2026-04-30' } }, 'future');
assert.deepEqual(dates(), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
const splitFebruary = Store.getAllTasks().find((task) => task.id === february.id);
assert.equal(splitFebruary.recurrence.originDate, '2026-01-31');
assert.equal(splitFebruary.recurrence.seriesStartDate, '2026-02-28');
await Store.updateTaskWithMode(february.id, { recurrence: { type: 'monthly', until: '2026-05-31' } }, 'series');
assert.deepEqual(dates(), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
assert.equal(Store.getAllTasks().find((task) => task.id === february.id)?.recurrence.originDate, '2026-01-31');
assert.equal(Store.getAllTasks().find((task) => task.id === february.id)?.recurrence.seriesStartDate, '2026-02-28');
await Store.updateTaskWithMode(february.id, { recurrence: { type: 'weekly', until: '2026-04-30' } }, 'series');
assert.deepEqual(dates(), [
  '2026-01-31', '2026-02-28', '2026-03-07', '2026-03-14', '2026-03-21',
  '2026-03-28', '2026-04-04', '2026-04-11', '2026-04-18', '2026-04-25',
]);
assert.notEqual(Store.getAllTasks().find((task) => task.date === '2026-01-31').recurrence.groupId,
  Store.getAllTasks().find((task) => task.date === '2026-02-28').recurrence.groupId);

await reset();
const movedBase = await Store.createTask({ ...base, recurrence: { type: 'daily', until: '2026-09-03' } });
const beforeInvalidEnd = clone(Store.getAllTasks());
await assert.rejects(Store.updateTaskWithMode(movedBase.id,
  { recurrence: { type: 'daily', until: '2026-08-31' } }, 'series'), /終了日/);
assert.deepEqual(Store.getAllTasks(), beforeInvalidEnd);
assert.deepEqual(db.tasks, beforeInvalidEnd);
const moved = Store.getAllTasks().find((task) => task.date === '2026-09-02');
await Store.updateTask(moved.id, { date: '2026-09-10', memo: 'moved exception' });
await Store.updateTaskWithMode(movedBase.id, { recurrence: { type: 'weekly', until: '2026-09-30' } }, 'series');
assert.equal(Store.getAllTasks().find((task) => task.id === moved.id)?.date, '2026-09-10');
assert.equal(Store.getAllTasks().find((task) => task.id === moved.id)?.memo, 'moved exception');

await reset();
const duplicateBase = await Store.createTask({ ...base, recurrence: { type: 'daily', until: '2026-09-03' } });
const duplicateMoved = Store.getAllTasks().find((task) => task.date === '2026-09-02');
const originalThird = Store.getAllTasks().find((task) => task.date === '2026-09-03');
await Store.updateTask(duplicateMoved.id, { date: '2026-09-03', memo: 'specific moved note' });
await Store.updateTaskWithMode(duplicateBase.id, { recurrence: { type: 'weekly', until: '2026-09-29' } }, 'series');
assert.equal(Store.getAllTasks().filter((task) => task.id === duplicateMoved.id).length, 1);
assert.equal(Store.getAllTasks().find((task) => task.id === duplicateMoved.id)?.recurrence.type, 'weekly');
assert.equal(Store.getAllTasks().find((task) => task.id === duplicateMoved.id)?.memo, 'specific moved note');
assert.equal(Store.getAllTasks().some((task) => task.id === originalThird.id), false);
assert.deepEqual(dates(), ['2026-09-01', '2026-09-03', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29']);

await reset();
const collisionBase = await Store.createTask({ ...base, recurrence: { type: 'daily', until: '2026-09-03' } });
const collisionMoved = Store.getAllTasks().find((task) => task.date === '2026-09-02');
await Store.updateTask(collisionMoved.id, { date: '2026-09-08', memo: 'moved to new rule date' });
const unrelated = await Store.createTask({ ...base, title: 'Unrelated', date: '2026-09-08', recurrence: { type: 'none' } });
await Store.updateTaskWithMode(collisionBase.id, { recurrence: { type: 'weekly', until: '2026-09-29' } }, 'series');
const onSeptemberEighth = Store.getAllTasks().filter((task) => task.date === '2026-09-08');
assert.equal(onSeptemberEighth.length, 3);
assert.equal(onSeptemberEighth.find((task) => task.id === collisionMoved.id)?.memo, 'moved to new rule date');
assert.equal(onSeptemberEighth.filter((task) => task.recurrence.groupId === collisionBase.recurrence.groupId).length, 2);
assert.equal(onSeptemberEighth.find((task) => task.id === unrelated.id)?.title, 'Unrelated');

await reset();
await Store.createTask({ ...base, recurrence: { type: 'daily', until: '2026-09-03' } });
const selectedToRemove = Store.getAllTasks().find((task) => task.date === '2026-09-02');
assert.equal(await UI.updateTaskByChoice(Store, selectedToRemove.id,
  { recurrence: { type: 'weekly', until: '2026-09-29' } }, 'series'), true);
assert.equal(Store.getAllTasks().some((task) => task.id === selectedToRemove.id), false);
assert.deepEqual(dates(), ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29']);

await reset();
const guarded = await Store.createTask({ ...base, recurrence: { type: 'daily', until: '2026-09-03' } });
const before = clone(Store.getAllTasks());
rejectNextBatch = true;
await assert.rejects(Store.updateTaskWithMode(guarded.id, { recurrence: { type: 'weekly', until: '2026-09-30' } }, 'series'));
assert.deepEqual(Store.getAllTasks(), before);
assert.deepEqual(db.tasks, before);
await Store.updateTaskWithMode(guarded.id, { recurrence: { type: 'weekly', until: '2026-09-30' } }, 'series');
const staleRevision = guarded.updatedAt;
await assert.rejects(Store.updateTask(guarded.id, { title: 'stale' }, { expectedUpdatedAt: staleRevision }));
await assert.rejects(Store.deleteTaskWithMode(guarded.id, 'single', { expectedUpdatedAt: staleRevision }));
assert.notEqual(Store.getAllTasks().find((task) => task.id === guarded.id)?.title, 'stale');

const calendarSource = fs.readFileSync(`${root}/src-tauri/renderer/src/calendar.js`, 'utf8');
const undoSource = calendarSource.slice(calendarSource.indexOf('const _UNDO_LIMIT'), calendarSource.indexOf('let _taskTimePreviewEl'));
const context = vm.createContext({ Store });
vm.runInContext(undoSource, context);
const run = (code) => vm.runInContext(code, context);
await reset();
const task = await Store.createTask({ ...base, recurrence: { type: 'none' } });
context.task = task;
run('_recordAction({type:"create",taskId:task.id,task})');
run('_recordAction({type:"update",taskId:task.id,before:{title:"Audit"},after:{title:"Edited"}})');
await Store.updateTask(task.id, { title: 'Edited' });
context.deleted = Store.getAllTasks()[0];
run('_recordAction({type:"delete",taskId:task.id,task:deleted})');
await Store.deleteTaskWithMode(task.id, 'single');
rejectNextBatch = true;
await assert.rejects(run('_undo()'));
assert.equal(Store.getAllTasks().length, 0);
await run('_undo()');
assert.equal(Store.getAllTasks()[0].id, task.id);
await run('_undo()');
assert.equal(Store.getAllTasks()[0].title, 'Audit');
await run('_undo()');
assert.equal(Store.getAllTasks().length, 0);
await run('_redo()');
assert.equal(Store.getAllTasks()[0].id, task.id);

await reset();
const recurring = await Store.createTask({ ...base, recurrence: { type: 'daily', until: '2026-09-03' } });
context.recurring = recurring;
run('_undoStack=[];_redoStack=[];_recordAction({type:"delete",taskId:recurring.id,task:recurring})');
await Store.deleteTaskWithMode(recurring.id, 'single');
await run('_undo()');
assert.equal(Store.getTaskSeriesCount(Store.getAllTasks().find((row) => row.id === recurring.id)), 3);
assert.equal(Store.getAllTasks().find((row) => row.id === recurring.id).recurrence.type, 'daily');

await Store.updateSettings({ breaks: [{ start: '12:00', end: '13:00' }, { start: '12:30', end: '13:30' }] });
await reset();
const lunch = await Store.createTask({ ...base, startTime: '11:00', endTime: '14:00' });
assert.equal(Store.taskDurationMinutes(lunch), 90);
assert.equal(Store.calcDaySummary(base.date).byTag.get('tag'), 90);
assert.equal(Store.calcDaySummary(base.date).total, 90);

const tagOptions = UI.getDialogTagsForDateKey({
  getTagsForMonth: () => [db.tags[1]], getAllTags: () => db.tags,
}, '2026-09-01', 'tag', () => new Date(2026, 8, 1));
assert.deepEqual(tagOptions.map((tag) => tag.id), ['other', 'tag']);
assert.match(fs.readFileSync(`${root}/src-tauri/renderer/src/tasks.js`, 'utf8'),
  /data-edit[^\n]+_getDialogTagsForDateKey\(task\.date, task\.tagId\)/);

const weekSource = calendarSource.slice(calendarSource.indexOf('const DAY_META'), calendarSource.indexOf('function _renderWeekColumns'));
const weekContext = vm.createContext({ mondayOfWeek: UI.mondayOfWeek, addDays: UI.addDays,
  _viewDate: new Date(2026, 8, 27), _businessOnly: false, formatDateKey: UI.formatDateKey });
vm.runInContext(weekSource, weekContext);
assert.equal(vm.runInContext('formatDateKey(addDays(_weekMonday(), -1))', weekContext), '2026-09-27');

let currentEnd = '18:00';
let clockTick;
const nowEl = { textContent: '' }, remainingEl = { textContent: '' };
const originalDocument = globalThis.document;
globalThis.document = { querySelector: (selector) => selector === '[data-now]' ? nowEl : selector === '[data-remaining]' ? remainingEl : null };
const priorTimerCount = timers.length;
UI.startHeaderClock({ getWorkEnd: () => currentEnd });
clockTick = timers[priorTimerCount];
const previous = remainingEl.textContent;
currentEnd = '20:00'; clockTick();
assert.notEqual(remainingEl.textContent, previous);
globalThis.document = originalDocument;

assert.ok(calls.some((call) => call.path === '/tasks/batch' && call.method === 'POST'));
console.log('calendar integrity: recurrence, exceptions, CAS, Undo, tags, breaks, week, clock OK');
