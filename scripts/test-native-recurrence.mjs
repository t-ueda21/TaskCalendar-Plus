import assert from 'node:assert/strict';
import {normalizeNativeRule} from '../src-tauri/renderer/src/native-recurrence.js';
const base={recurrenceType:0,interval:1,dayOfWeekMask:2,dayOfMonth:31,monthOfYear:1,instance:5,patternStartDate:'2026-01-01',patternEndDate:null,occurrences:null,noEndDate:true};
for(const kind of [0,1,2,3,5,6]) {
  const rule={...base,recurrenceType:kind,interval:[5,6].includes(kind)?12:1};
  assert.deepEqual(normalizeNativeRule(rule),rule);
}
for(const patch of [{interval:0},{interval:1.5},{recurrenceType:4},{patternStartDate:'2026-02-30'},{recurrenceType:1,dayOfWeekMask:0},{recurrenceType:3,instance:6},{noEndDate:false},{noEndDate:false,patternEndDate:'2025-12-31'},{occurrences:0}]) assert.throws(()=>normalizeNativeRule({...base,...patch}));
assert.deepEqual(normalizeNativeRule({...base,noEndDate:false,occurrences:3,patternEndDate:'2026-01-03'}),{...base,noEndDate:false,occurrences:3,patternEndDate:'2026-01-03'});
assert.throws(()=>normalizeNativeRule({...base,recurrenceType:3,dayOfWeekMask:10}));
for(const mask of [1,2,4,8,16,32,64,62,65,127])assert.equal(normalizeNativeRule({...base,recurrenceType:3,dayOfWeekMask:mask}).dayOfWeekMask,mask);
console.log('PASS native recurrence types, dates, field ranges and termination');
