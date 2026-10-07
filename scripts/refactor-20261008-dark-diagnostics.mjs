// A-only capture diagnosis; records the unchanged v2 gallery and resolved theme tokens.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {openHarness,captureGallery}=await import(pathToFileURL(path.resolve('out/refactor-20261008/baseline-v2/before-source/source/scripts/refactor-20261008-harness.mjs')).href);
const root=path.resolve(process.argv[2]);const output=path.resolve(process.argv[3]);
if(fs.existsSync(output))throw Error('Diagnostic output exists');
const h=await openHarness({root,output});
try{
  await h.page.addInitScript(()=>{
    window.captureThemeEvents=[];
    const record=event=>window.captureThemeEvents.push({event,at:performance.now(),theme:document.documentElement.dataset.theme,accent:document.documentElement.style.getPropertyValue('--accent'),soft:document.documentElement.style.getPropertyValue('--accent-soft')});
    document.addEventListener('close',()=>record('dialog-close'),true);
    document.addEventListener('DOMContentLoaded',()=>new MutationObserver(records=>{if(records.some(item=>item.attributeName==='data-theme'))record('theme-attribute');}).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']}));
  });
  await captureGallery(h,output);
  const tokens=await h.page.evaluate(async()=>{
    const S=await import('/src/store.js'),C=await import('/src/ui-colors.js');const color=S.getSettings().uiAccentColor;
    const dark=C.buildUiPalette(color,true),light=C.buildUiPalette(color,false);const root=document.documentElement;
    const actual=Object.fromEntries(Object.keys(dark).map(key=>[key,root.style.getPropertyValue(key)]));
    return {theme:root.dataset.theme,color,actual,dark,light,events:window.captureThemeEvents,darkEqual:JSON.stringify(actual)===JSON.stringify(dark),lightEqual:JSON.stringify(actual)===JSON.stringify(light)};
  });
  fs.writeFileSync(path.join(output,'theme-tokens.json'),JSON.stringify(tokens,null,2));
  await h.page.evaluate(async()=>{
    const S=await import('/src/store.js'),C=await import('/src/ui-color-picker.js');
    document.documentElement.dataset.theme='light';C.applyUiColor(S.getSettings().uiAccentColor);
    document.documentElement.dataset.theme='dark';
  });
  await h.page.screenshot({path:path.join(output,'diagnostic-dark-with-light-palette.png'),animations:'disabled'});
  fs.writeFileSync(path.join(output,'diagnostic-state-note.json'),JSON.stringify({kind:'deliberately inconsistent diagnostic state, not acceptance evidence',reason:'Reproduce direct data-theme mutation after the light palette was already applied by settings close event'},null,2));
  console.log(JSON.stringify({output,theme:tokens.theme,darkEqual:tokens.darkEqual,lightEqual:tokens.lightEqual,events:tokens.events}));
}finally{await h.close();}
