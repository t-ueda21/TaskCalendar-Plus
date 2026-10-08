// Actual repository renderer in isolated Chromium; API/native/remote responses are synthetic.
// Never imports native-test-driver or launches the Tauri application/Edge/WebView2.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const runtimePackages = process.env.TCPLUS_TEST_NODE_MODULES || path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
export const {chromium} = require(path.join(runtimePackages,'playwright'));
export const playwrightVersion = require(path.join(runtimePackages,'playwright/package.json')).version;
export const FIXED_NOW = '2026-10-08T01:15:00.000Z';
export const VIEWPORT = {width:1440,height:1000};
export function rendererFingerprint(root){
  const base=path.resolve(root,'src-tauri/renderer');
  const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):[path.join(dir,entry.name)]);
  const files=Object.fromEntries(walk(base).sort().map(file=>[path.relative(base,file).replaceAll('\\','/'),crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
  return {sha256:crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex'),files};
}
export const fixture = () => ({
  tags:[{id:'tag-design',name:'設計',color:'#4f7edc',budgetMinMinutes:600,budgetMaxMinutes:1200},{id:'tag-meeting',name:'打ち合わせ',color:'#e19541',budgetMinMinutes:null,budgetMaxMinutes:600}],
  settings:{uiLanguage:'ja',workStart:'09:00',workEnd:'18:00',breaks:[{start:'12:00',end:'13:00',countAsWork:false}],workWeekDays:['Mon','Tue','Wed','Thu','Fri'],showBusinessDaysOnly:true,granularity:30,aiProvider:'none',aiCliEnabled:false,aiEnterToSend:false,checkUpdatesOnStartup:false,outlookAutoSync:false,outlookWriteDefault:false,urlAutoOpenEnabled:false,quickLinks:[],trayEnabled:false,startMinimizedToTray:false,weatherLocationKey:'tokyo',monthTagOrders:{'2026-10':['tag-design','tag-meeting']}},
  tasks:[
    ['task-early','朝の設計レビュー','08:30','09:30','tag-design'],
    ['task-plan','計画を整理','10:00','11:30','tag-design'],
    ['task-meeting','進捗の打ち合わせ','13:00','14:00','tag-meeting'],
    ['task-personal','個人の予定','15:00','16:00',''],
    ['task-late','夕方の作業','17:30','18:30','tag-design'],
    ['task-tagless-late','タグなしの夜の予定','19:00','20:00',''],
  ].map(([id,title,startTime,endTime,tagId])=>({id,title,startTime,endTime,tagId,date:'2026-10-08',isAllDay:false,memo:'検証用の合成データ',recurrence:{type:'none'},createdAt:FIXED_NOW,updatedAt:FIXED_NOW})),
});

export async function openHarness({root=process.cwd(),output=null}={}) {
  const renderer = path.resolve(root,'src-tauri/renderer');
  if (!fs.existsSync(path.join(renderer,'assets/app.html'))) throw Error('Renderer missing: '+renderer);
  let state=fixture(), revision=1, failure=null;
  const apiLog=[], unexpectedRequests=[], externalRequests=[], nativeCalls=[], pageErrors=[];
  const weather={};
  const memories={summary:{},notes:{},chat:{}};
  const clone=value=>structuredClone(value);
  const server=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://127.0.0.1');
      if(url.pathname==='/harness-empty.html'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><html><body></body></html>');return;}
      if(url.pathname.startsWith('/api/')) {
        const method=req.method; let text='';for await(const chunk of req)text+=chunk;
        const body=text?JSON.parse(text):null;const route=url.pathname;
        apiLog.push({method,route,body});
        const json=(data,status=200,headers={})=>{res.writeHead(status,{'Content-Type':'application/json',...headers});res.end(status===204||status===304?'':JSON.stringify(data));};
        if(failure&&failure.method===method&&failure.route===route){const status=failure.status;failure=null;return json({error:'Injected synthetic API failure'},status);}
        if(route==='/api/runtime')return json({appVersion:'3.0.0',osLocale:'ja-JP',testHarness:true});
        if(route==='/api/outlook/jobs'&&method==='GET')return json({jobs:[],counts:{pending:0,working:0,failed:0}});
        if(route==='/api/settings'){if(method==='PUT')state.settings=clone(body);return json(state.settings);}
        if(route==='/api/tasks'&&method==='GET'){const etag='"synthetic-'+revision+'"';return json(state.tasks,req.headers['if-none-match']===etag?304:200,{ETag:etag});}
        if(route==='/api/tasks'&&method==='POST'){const saved={...body,updatedAt:FIXED_NOW};state.tasks.push(saved);revision++;return json(saved,201);}
        if(route==='/api/tasks/batch'&&method==='POST'){
          if(!Array.isArray(body.upserts)||!Array.isArray(body.deleteIds)||!Array.isArray(body.expected))return json({error:'Invalid synthetic batch shape'},400);
          const existing=new Map(state.tasks.map(row=>[row.id,row]));const expected=new Map(body.expected.map(row=>[row.id,row.updatedAt]));
          const mutated=[...body.upserts.filter(row=>existing.has(row.id)).map(row=>row.id),...body.deleteIds];
          if(mutated.some(id=>existing.get(id)?.updatedAt!==expected.get(id))||body.upserts.some(row=>existing.has(row.id)&&!expected.has(row.id)))return json({error:'Synthetic conflict'},409);
          revision++;
          const ids=new Set([...body.deleteIds,...body.upserts.map(row=>row.id)]);
          state.tasks=state.tasks.filter(row=>!ids.has(row.id)).concat(body.upserts.map(row=>({...clone(row),updatedAt:new Date(Date.parse(FIXED_NOW)+revision).toISOString()})));
          return json(state.tasks);
        }
        if(route.startsWith('/api/tasks/')){
          const id=decodeURIComponent(route.slice('/api/tasks/'.length));const index=state.tasks.findIndex(row=>row.id===id);
          if(index<0)return json({error:'Synthetic task not found'},404);
          if(method==='PUT'){state.tasks[index]={...state.tasks[index],...body,updatedAt:FIXED_NOW};revision++;return json(state.tasks[index]);}
          if(method==='DELETE'){state.tasks.splice(index,1);revision++;return json(null,204);}
        }
        if(route==='/api/tags'){if(method==='POST'){state.tags.push(clone(body));return json(body,201);}return json(state.tags);}
        if(route.startsWith('/api/tags/')){const id=decodeURIComponent(route.slice(10));if(method==='DELETE'){state.tags=state.tags.filter(row=>row.id!==id);state.tasks=state.tasks.map(row=>row.tagId===id?{...row,tagId:''}:row);revision++;return json(null,204);}const index=state.tags.findIndex(row=>row.id===id);if(index>=0&&method==='PUT'){state.tags[index]={...state.tags[index],...body};return json(state.tags[index]);}}
        if(route.startsWith('/api/weather-cache/')){const key=route.slice(19);if(method==='PUT')weather[key]=clone(body);return json(weather[key]??{});}
        if(route.startsWith('/api/ai-memory/')){const [,category,date]=route.slice('/api/ai-memory'.length).split('/');const map=memories[category];if(map){if(date){if(method==='PUT')map[date]=clone(body);if(method==='DELETE')delete map[date];}return json(date?map[date]??null:map);}}
        unexpectedRequests.push({method,route});return json({error:'Unimplemented synthetic API route'},501);
      }
      const relative=decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file=path.resolve(renderer,relative);
      if(!file.startsWith(renderer+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
      const type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.ico':'image/x-icon'}[path.extname(file)]||'application/octet-stream';
      res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(fs.readFileSync(file));
    } catch(error){res.writeHead(500);res.end(String(error));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const launch={headless:true,args:['--disable-background-networking','--disable-component-update','--disable-default-apps','--no-first-run']};
  if(process.env.TCPLUS_TEST_CHROMIUM)launch.executablePath=process.env.TCPLUS_TEST_CHROMIUM;
  let browser;
  try{browser=await chromium.launch(launch);}catch(error){server.close();throw error;}
  const context=await browser.newContext({viewport:VIEWPORT,deviceScaleFactor:1,locale:'ja-JP',timezoneId:'Asia/Tokyo',colorScheme:'light',reducedMotion:'reduce',serviceWorkers:'block'});
  await context.exposeBinding('__recordNative',(_source,command,args)=>nativeCalls.push({command,args}));
  await context.addInitScript(({fixedNow})=>{
    const NativeDate=Date;const fixed=new NativeDate(fixedNow).valueOf();
    globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};
    let prefs={theme:'light',zoom:1};
    window.__TAURI__={core:{async invoke(command,args){
      await window.__recordNative(command,args);
      if(command==='get_api_token')return 'synthetic-token';
      if(command==='get_ui_preferences')return {...prefs};
      if(command==='set_ui_theme'){prefs.theme=args.theme;return;}
      if(command==='set_ui_zoom'){prefs.zoom=args.level;return;}
      if(command==='set_ui_language'||command==='set_tray_enabled')return;
      if(command==='get_autostart_enabled')return false;
      if(command==='get_update_info')return {currentVersion:'3.0.0',installSupported:false};
      throw new Error('Native operation excluded by synthetic harness: '+command);
    },Channel:class{}},shell:{open:async(url)=>window.__recordNative('shell.open',{url})}};
  },{fixedNow:FIXED_NOW});
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin===origin)return route.continue();
    externalRequests.push({url:url.href,method:route.request().method()});
    if((url.hostname==='api.open-meteo.com'||url.hostname==='archive-api.open-meteo.com')&&route.request().method()==='GET'){
      const days=[];const cursor=new Date(url.searchParams.get('start_date')+'T12:00:00Z');const last=url.searchParams.get('end_date');
      while(cursor.toISOString().slice(0,10)<=last&&days.length<400){days.push(cursor.toISOString().slice(0,10));cursor.setUTCDate(cursor.getUTCDate()+1);}
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({daily:{time:days,weather_code:days.map(()=>1),temperature_2m_max:days.map(()=>24),temperature_2m_min:days.map(()=>17)}})});
    }
    return route.abort('blockedbyclient');
  });
  context.on('page',page=>page.on('pageerror',error=>pageErrors.push(error.message)));
  const page=await context.newPage();
  const meta={scope:'real renderer with synthetic HTTP API, synthetic native bridge and synthetic weather; not native application E2E',sourceRoot:path.resolve(root),source:rendererFingerprint(root),browser:browser.version(),playwright:playwrightVersion,node:process.version,nodeExecutableSha256:crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),viewport:VIEWPORT,deviceScaleFactor:1,locale:'ja-JP',timezone:'Asia/Tokyo',fixedNow:FIXED_NOW,os:os.release(),cpu:os.cpus()[0]?.model,memoryBytes:os.totalmem()};
  return {page,context,origin,meta,apiLog,unexpectedRequests,nativeCalls,pageErrors,externalRequests,
    state:()=>clone(state),setTasks(tasks){state.tasks=clone(tasks);revision++;},reset(){state=fixture();revision++;failure=null;},bump(){revision++;},failNext(method,route,status=409){failure={method,route,status};},
    async boot(target=page){await target.goto(origin+'/assets/app.html');await target.waitForFunction(()=>document.body.style.opacity==='1');await target.locator('[data-view="calendar"]:not([hidden])').waitFor();await target.evaluate(()=>document.fonts.ready);},
    async close(){const sourceChangedDuringRun=rendererFingerprint(root).sha256!==meta.source.sha256;if(output){fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'harness-environment.json'),JSON.stringify({...meta,sourceChangedDuringRun,unexpectedRequests,nativeCalls,pageErrors,externalRequests},null,2));}await browser.close();await new Promise(resolve=>server.close(resolve));if(sourceChangedDuringRun)throw Error('Renderer source changed during evidence run; do not freeze this run');},
  };
}

export async function captureGallery(h,output) {
  fs.mkdirSync(output,{recursive:true});const page=h.page;const captured=[],states={};
  const shot=async(name)=>{await page.waitForLoadState('networkidle');await page.evaluate(()=>document.fonts.ready);const target=path.join(output,name+'.png');if(fs.existsSync(target))throw Error('Screenshot evidence already exists: '+target);states[name]=await page.evaluate(async()=>{const S=await import('/src/store.js'),C=await import('/src/ui-colors.js');const root=document.documentElement;const expected=C.buildUiPalette(S.getSettings().uiAccentColor,root.dataset.theme==='dark');const actual=Object.fromEntries(Object.keys(expected).map(key=>[key,root.style.getPropertyValue(key)]));return {theme:root.dataset.theme,actual,expected,paletteMatches:JSON.stringify(actual)===JSON.stringify(expected)};});if(!states[name].paletteMatches)throw Error('Theme palette is inconsistent before screenshot: '+name);await page.screenshot({path:target,animations:'disabled'});captured.push(name);};
  await h.boot();await page.locator('[data-view="calendar"] [data-viewmode]').selectOption('day');await shot('calendar-day');
  await page.locator('[data-view="calendar"] [data-viewmode]').selectOption('week');await shot('calendar-week');
  await page.locator('[data-view="calendar"] [data-viewmode]').selectOption('day');
  await page.locator('[data-view="calendar"] [data-mini-month-label]').click();await shot('mini-month');
  await page.locator('[data-view="calendar"] [data-mini-month-label]').click();await shot('mini-year');
  await page.locator('[data-view="calendar"] [data-mini-month-label]').click();
  await page.locator('nav.nav [data-nav-target="tasks"]').click();await page.locator('[data-view="tasks"]:not([hidden])').waitFor();await shot('tasks');
  await page.locator('[data-view="tasks"] [data-task-id="task-plan"] [data-edit]').click();await shot('task-edit');await page.locator('[data-view="tasks"] [data-task-dialog] [data-cancel]').click();
  {
    await page.locator('[data-view="tasks"] [data-task-id="task-plan"] .taskTitleCell').click();
    await page.locator('[data-view="tasks"] [data-task-id="task-meeting"] .taskTitleCell').click({modifiers:['Control']});await shot('tasks-selection');
    await page.locator('[data-view="tasks"] [data-task-id="task-plan"]').click({button:'right'});
    await page.locator('.taskTagContextMenu [data-bulk-edit]').click();await shot('task-bulk-edit');await page.locator('[data-bulk-cancel]').click();
    await page.keyboard.press('Escape');
    await page.locator('[data-view="tasks"] [data-task-id="task-personal"] [data-del]').click();await page.locator('[data-app-dialog]').waitFor();await shot('task-delete-confirm');await page.locator('[data-app-dialog-cancel]').click();
  }
  await page.locator('[data-view="tasks"] [data-settings-btn]').click();await page.locator('[data-settings-dialog][open]').waitFor();
  const tabs=await page.locator('[data-settings-tab]').evaluateAll(nodes=>nodes.map(node=>node.dataset.settingsTab));
  for(const tab of tabs){await page.locator('[data-settings-tab="'+tab+'"]').click();await shot('settings-'+tab);}
  await page.setViewportSize({width:600,height:900});
  for(const tab of tabs){await page.locator('[data-settings-tab="'+tab+'"]').click();await shot('settings-'+tab+'-narrow');}
  await page.setViewportSize(VIEWPORT);
  // Exercise the real theme control; direct data-theme mutation bypasses palette updates
  // and raced with the settings close callback in the preserved v2 capture.
  await page.locator('[data-settings-tab="display"]').click();
  await page.locator('[data-theme-toggle]').click();
  await page.locator('[data-theme-toggle][aria-pressed="true"]:not([disabled])').waitFor();
  for(const tab of tabs){await page.locator('[data-settings-tab="'+tab+'"]').click();await shot('settings-'+tab+'-dark');}
  await page.keyboard.press('Escape');await page.locator('[data-settings-dialog]').waitFor({state:'hidden'});
  const expectedDarkPalette=await page.evaluate(async()=>{const S=await import('/src/store.js'),C=await import('/src/ui-colors.js');return C.buildUiPalette(S.getSettings().uiAccentColor,true);});
  await page.waitForFunction(expected=>{const root=document.documentElement;return root.dataset.theme==='dark'&&Object.entries(expected).every(([key,value])=>root.style.getPropertyValue(key)===value);},expectedDarkPalette);
  await shot('tasks-dark');
  await page.locator('[data-view="tasks"] [data-task-id="task-plan"]').click({button:'right'});
  await page.locator('.taskTagContextMenu').waitFor({state:'visible'});await shot('tasks-context-dark');await page.keyboard.press('Escape');
  await page.locator('nav.nav [data-nav-target="calendar"]').click();
  await page.locator('[data-view="calendar"] [data-viewmode]').selectOption('day');
  await page.locator('[data-view="calendar"] [data-task-id="task-plan"]:visible').click({button:'right'});
  await page.locator('.taskTagContextMenu').waitFor({state:'visible'});await shot('calendar-context-dark');await page.keyboard.press('Escape');
  fs.writeFileSync(path.join(output,'gallery.json'),JSON.stringify({...h.meta,captured,states},null,2));return captured;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const mode=process.argv[2]||'capture';const root=process.argv[3]||process.cwd();const output=path.resolve(process.argv[4]||'out/refactor-20261008/probe-ui');
  if(fs.existsSync(output))throw Error('Evidence output already exists: '+output);
  const h=await openHarness({root,output});
  try{if(mode==='capture')console.log(JSON.stringify({captured:await captureGallery(h,output),sourceSha256:h.meta.source.sha256,browser:h.meta.browser,output}));else if(mode==='probe'){await h.boot();console.log(JSON.stringify({text:(await h.page.locator('body').innerText()).slice(0,4000),sourceSha256:h.meta.source.sha256,browser:h.meta.browser}));}else throw Error('Unknown mode');}
  finally{await h.close();}
}
