// Drive the real Tauri WebView2 with an isolated DB/profile, never the user's app data.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
export const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function nativeApp({exe='src-tauri/target/debug/taskcalendar-plus.exe',port=9381,dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'tcplus-v3-'))}={}) {
  // Disable automatic background actions before bootstrap, not after ready.
  fs.mkdirSync(dataDir,{recursive:true});
  const fixtureDb=new DatabaseSync(path.join(dataDir,'tasks.db'));
  try {
    fixtureDb.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const saved=fixtureDb.prepare("SELECT value FROM settings WHERE key='main'").get();
    const settings={...(saved?JSON.parse(saved.value):{}),checkUpdatesOnStartup:false,outlookAutoSync:false,urlAutoOpenEnabled:false,trayEnabled:false,startMinimizedToTray:false};
    fixtureDb.prepare("INSERT INTO settings (key,value) VALUES ('main',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(settings));
  }finally{fixtureDb.close();}
  const child=spawn(path.resolve(exe),[],{windowsHide:true,stdio:'ignore',env:{...process.env,TCPLUS_DATA_DIR:dataDir,WEBVIEW2_USER_DATA_FOLDER:path.join(dataDir,'webview2'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}});
  let socket;const errors=[];let sequence=0;const pending=new Map();
  const close=async()=>{socket?.close();if(child.exitCode===null)child.kill();await delay(800);};
  try {
    let page;
    for(let i=0;i<120&&!page;i++){try{page=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(p=>p.type==='page'&&p.url.includes('/assets/app.html'));}catch{}if(!page)await delay(250);}
    if(!page)throw Error('Native page not available');
    socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise(resolve=>{socket.onopen=resolve;});
    socket.onmessage=event=>{const data=JSON.parse(event.data);if(data.method==='Runtime.exceptionThrown')errors.push(data.params.exceptionDetails.exception?.description??data.params.exceptionDetails.text);if(data.method==='Runtime.consoleAPICalled'&&data.params.type==='error')errors.push(data.params.args.map(argument=>argument.description??argument.value??'').join(' '));if(data.method==='Page.javascriptDialogOpening')void send('Page.handleJavaScriptDialog',{accept:true});if(data.id&&pending.has(data.id)){pending.get(data.id)(data);pending.delete(data.id);}};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timeout=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timeout: ${method}`));},30000);pending.set(id,data=>{clearTimeout(timeout);if(data.error)reject(Error(JSON.stringify(data.error)));else resolve(data);});socket.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const data=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(data.result?.exceptionDetails)throw Error(data.result.exceptionDetails.exception?.description??data.result.exceptionDetails.text);return data.result?.result?.value;};
    await send('Page.enable');await send('Runtime.enable');
    for(let i=0;i<120;i++){if(await evaluate('document.body.style.opacity === "1"'))return {child,dataDir,send,evaluate,close,errors,screenshot:async file=>{const data=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,Buffer.from(data.result.data,'base64'));}};await delay(100);}
    throw Error('Native bootstrap timed out');
  }catch(error){await close();throw error;}
}
