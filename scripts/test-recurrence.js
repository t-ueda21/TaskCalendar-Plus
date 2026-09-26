'use strict';
// Public Store API characterization. Production recurrence logic is imported, never copied.
const assert = require('node:assert/strict');
globalThis.crypto ??= require('node:crypto').webcrypto;
globalThis.document = { addEventListener() {} };
globalThis.setInterval = () => 0;
let rows = [];
globalThis.fetch = async (url, options = {}) => {
  if (url === '/api/tasks') {
    if (options.method === 'POST') {
      const task = JSON.parse(options.body);
      rows.push(task);
      return new Response(JSON.stringify(task));
    }
    return new Response(JSON.stringify(rows));
  }
  if (url === '/api/runtime' || url === '/api/settings') return new Response('{}');
  if (url === '/api/tags' || url.startsWith('/api/ai-memory/')) return new Response('[]');
  throw new Error('Unexpected request: ' + url);
};
(async () => {
  const Store = await import('../src-tauri/renderer/src/store.js');
  const cases = [
    ['daily: inclusive range', '2026-07-01', '2026-07-05', 'daily', ['2026-07-01','2026-07-02','2026-07-03','2026-07-04','2026-07-05']],
    ['weekly: seven-day interval', '2026-07-01', '2026-07-22', 'weekly', ['2026-07-01','2026-07-08','2026-07-15','2026-07-22']],
    ['monthly: restore day 31 after February', '2026-01-31', '2026-04-30', 'monthly', ['2026-01-31','2026-02-28','2026-03-31','2026-04-30']],
    ['monthly: restore day 29 after February', '2026-01-29', '2026-03-29', 'monthly', ['2026-01-29','2026-02-28','2026-03-29']],
    ['monthly: ordinary day stays unchanged', '2026-07-15', '2026-09-15', 'monthly', ['2026-07-15','2026-08-15','2026-09-15']],
    ['monthly: leap year and year boundary', '2027-12-31', '2028-03-31', 'monthly', ['2027-12-31','2028-01-31','2028-02-29','2028-03-31']],
  ];
  for (const [name, date, until, type, expected] of cases) {
    rows = [];
    await Store.init();
    const created = await Store.createTask({ title: name, date, startTime: '09:00', endTime: '10:00', recurrence: { type, until } });
    assert.ok(created);
    assert.deepEqual(Store.getAllTasks().map(task => task.date), expected);
    assert.deepEqual(rows.map(task => task.date), expected, 'persisted dates must match visible dates');
    assert.equal(new Set(rows.map(task => task.id)).size, expected.length);
    assert.ok(rows.every(task => task.recurrence.groupId === created.recurrence.groupId));
    console.log('PASS: ' + name);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
