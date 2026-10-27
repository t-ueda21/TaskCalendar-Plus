import assert from 'node:assert/strict';
import {TaskSelection,prepareBulkTasks} from '../src-tauri/renderer/src/task-selection.js';
import {personalMemo} from '../src-tauri/renderer/src/task-notes.js';
const selection=new TaskSelection(),order=['a','b','c','d'];
assert.deepEqual(selection.select('b',{},order),['b']);
assert.deepEqual(selection.select('d',{ctrlKey:true},order),['b','d']);
assert.deepEqual(selection.select('b',{ctrlKey:true},order),['d']);
assert.deepEqual(selection.select('d',{shiftKey:true},order),['b','c','d']);
selection.select('a',{ctrlKey:true},order);
assert.deepEqual(selection.select('b',{ctrlKey:true,shiftKey:true},order),['b','c','d','a']);
selection.prune(['b','c']);assert.deepEqual([...selection.ids],['b','c']);
assert.equal(selection.anchor,null);selection.clear();assert.equal(selection.ids.size,0);
const original=[{id:'a',title:'first',date:'2026-10-08',tagId:'old',memo:'keep',outlookEnabled:true,updatedAt:'v1',recurrence:{type:'weekly',groupId:'g'}},{id:'b',title:'second',date:'2026-10-09',tagId:'old',memo:'keep',updatedAt:'v2',recurrence:{type:'none'}}];
const tagged=prepareBulkTasks(original,{tagId:''});
assert.deepEqual(tagged.map(t=>t.tagId),['','']);assert.equal(tagged[0].memo,'keep');assert.equal(tagged[0].outlookEnabled,true);assert.equal(original[0].tagId,'old');
const moved=prepareBulkTasks(original,{date:'2026-10-12',memo:''});
assert.equal(moved[0].recurrence.occurrenceDate,'2026-10-08');assert.equal(moved[0].recurrence.groupId,'g');assert.equal(moved[1].recurrence.type,'none');
assert.throws(()=>prepareBulkTasks(original,{date:'2026-02-30'}));
assert.throws(()=>prepareBulkTasks(original,{outlookEnabled:false}));
assert.throws(()=>prepareBulkTasks(original,{}));
assert.throws(()=>prepareBulkTasks([original[0],original[0]],{tagId:'tag'}));
const notes = [
  {id:'external',memo:'Outlook body',localMemo:'Old note',outlookOccurrenceKey:'remote-id',outlookDetails:{location:'Room A'},recurrence:{type:'none'}},
  {id:'legacy',memo:'Legacy local note',recurrence:{type:'weekly',groupId:'series'}},
  {id:'cleared',memo:'Unchanged body',localMemo:'',outlookSeriesId:'remote-series',recurrence:{type:'none'}},
];
const beforeNotes=structuredClone(notes);
const bulkNotes=prepareBulkTasks(notes,{memo:'  New personal note  ',tagId:'work'});
assert.deepEqual(bulkNotes.map(row=>row.memo),notes.map(row=>row.memo),'bulk memo must not overwrite the existing memo/body');
assert.deepEqual(bulkNotes.map(row=>row.localMemo),['New personal note','New personal note','New personal note']);
assert.deepEqual(bulkNotes.map(personalMemo),['New personal note','New personal note','New personal note']);
assert.deepEqual(bulkNotes[0].outlookDetails,{location:'Room A'});
assert.equal(bulkNotes[0].outlookOccurrenceKey,'remote-id');
assert.deepEqual(bulkNotes[1].recurrence,{type:'weekly',groupId:'series'});
assert.deepEqual(notes,beforeNotes,'bulk preparation must not mutate source tasks');
const clearedNotes=prepareBulkTasks(notes,{memo:''});
assert.deepEqual(clearedNotes.map(personalMemo),['','',''],'clearing a personal memo must not fall back to an old body');
assert.deepEqual(clearedNotes.map(row=>row.memo),notes.map(row=>row.memo));
const tagOnly=prepareBulkTasks(notes,{tagId:'other'});
assert.deepEqual(tagOnly.map(row=>[row.memo,row.localMemo]),notes.map(row=>[row.memo,row.localMemo]),'unselected memo fields remain untouched');
console.log('PASS: Ctrl toggle, Shift range, filtered selection, explicit bulk fields, recurrence identity and input validation');
