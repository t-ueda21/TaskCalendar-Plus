import assert from 'node:assert/strict';
globalThis.document={addEventListener(){}};
globalThis.setInterval=()=>0;
const {formatDateJP}=await import('../src-tauri/renderer/src/ui-utils.js');
const {setLocale,formatDuration}=await import('../src-tauri/renderer/src/i18n.js');
const date=new Date(2026,9,8);
for(const [locale,weekday] of [['ja','木'],['en','Thu'],['ko','목']]){
 setLocale(locale);
 assert.ok(formatDateJP(date,{withWeekday:true}).includes(weekday),locale+' date navigation retains weekday');
}
setLocale('ja');
for(const [minutes,text] of [[0,'0時間0分'],[60,'1時間0分'],[270,'4時間30分']])assert.equal(formatDuration(minutes),text);
console.log('PASS: localized date navigation and hours/minutes including zero minutes');
