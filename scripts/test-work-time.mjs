import assert from 'node:assert/strict';
import { summarizeWork } from '../src-tauri/renderer/src/work-time.js';
const settings = { workStart: '09:00', workEnd: '18:00', breaks: [{ start: '12:00', end: '13:00', countAsWork: false }] };
const task = (startTime, endTime, patch = {}) => ({ startTime, endTime, isAllDay: false, date: '2026-10-07', tagId: 'work', ...patch });
for (const [name, rows, cfg, want] of [
  ['early and late parts, not entire crossing tasks', [task('08:00','10:00'), task('17:00','19:00')], settings, {total:240,overtime:120}],
  ['merged overtime is not double counted', [task('08:00','10:00'), task('08:30','09:30')], settings, {total:120,overtime:60}],
  ['excluded breaks', [task('08:00','19:00')], settings, {total:600,overtime:120}],
  ['included break counts as work', [task('08:00','19:00')], {...settings,breaks:[{start:'12:00',end:'13:00',countAsWork:true}]}, {total:660,overtime:120}],
  ['break outside normal hours is removed from overtime', [task('08:00','19:00')], {...settings,breaks:[{start:'18:00',end:'18:30',countAsWork:false}]}, {total:630,overtime:90}],
  ['tagged holiday tasks use the same work window', [task('08:00','10:00',{date:'2026-10-12'})], settings, {total:120,overtime:60}],
  ['tagless tasks add neither total nor overtime', [task('08:00','19:00',{tagId:''})], settings, {total:0,overtime:0}],
  ['tagless overlap cannot expand tagged work', [task('09:00','10:00'),task('08:00','19:00',{tagId:''})], settings, {total:60,overtime:0}],
  ['all day and invalid times are zero', [task(null,null,{isAllDay:true}),task('invalid','19:00'),task('19:00','18:00')], settings, {total:0,overtime:0}],
  ['empty', [], settings, {total:0,overtime:0}],
]) assert.deepEqual(summarizeWork(rows,cfg), want, name);
console.log('PASS: early/late overtime, overlaps, breaks, tagless, holidays and all-day');
