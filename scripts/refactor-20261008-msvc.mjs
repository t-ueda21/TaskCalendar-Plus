// Read the installed Visual Studio developer environment into this test process only.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function prepareCompilerEnvironment(output){
  output=path.resolve(output);
  if(process.platform!=='win32')return {env:{...process.env},metadata:{platform:process.platform,setup:'not-needed'}};
  const vswhere=path.join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft Visual Studio/Installer/vswhere.exe');
  if(!fs.existsSync(vswhere))throw Error('Visual Studio locator is missing; cannot initialize MSVC environment');
  const found=spawnSync(vswhere,['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath'],{encoding:'utf8',windowsHide:true});
  const installation=found.stdout.trim();if(!installation||found.status!==0)throw Error('Visual Studio C++ Build Tools installation is unavailable');
  const setup=path.join(installation,'VC/Auxiliary/Build/vcvars64.bat');if(!fs.existsSync(setup))throw Error('MSVC environment setup is missing: '+setup);
  const names=['PATH','INCLUDE','LIB','LIBPATH','VCINSTALLDIR','VCToolsInstallDir','VCToolsVersion','WindowsSdkDir','WindowsSDKVersion','UniversalCRTSdkDir','UCRTVersion','VSCMD_ARG_TGT_ARCH','VSCMD_ARG_HOST_ARCH'];
  const script=path.join(output,'msvc-environment.cmd');fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(script,['@echo off',`call "${setup}" >nul`,'if errorlevel 1 exit /b 1',...names.map(name=>'set '+name),'exit /b 0'].join('\r\n')+'\r\n',{flag:'wx'});
  const result=spawnSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c',`""${script}""`],{encoding:'utf8',windowsHide:true,windowsVerbatimArguments:true,timeout:30000});
  if(result.status!==0)throw Error('MSVC environment initialization failed: '+result.stderr);
  const env={...process.env};const allowed=new Set(names.map(name=>name.toLowerCase()));
  for(const line of result.stdout.split(/\r?\n/)){const index=line.indexOf('=');if(index<1)continue;const key=line.slice(0,index);if(!allowed.has(key.toLowerCase()))continue;for(const existing of Object.keys(env))if(existing.toLowerCase()===key.toLowerCase())delete env[existing];env[key]=line.slice(index+1);}
  const get=name=>Object.entries(env).find(([key])=>key.toLowerCase()===name.toLowerCase())?.[1];
  const compiler=path.join(get('VCToolsInstallDir')||'','bin/Hostx64/x64/cl.exe');if(!fs.existsSync(compiler)||!get('INCLUDE')||!get('LIB'))throw Error('MSVC setup did not provide compiler/includes/libraries');
  const metadata={platform:process.platform,setup,compiler,vcToolsVersion:get('VCToolsVersion'),windowsSdkVersion:get('WindowsSDKVersion'),scope:'child test process environment only; no Windows settings changed'};
  fs.writeFileSync(path.join(output,'compiler-environment.json'),JSON.stringify(metadata,null,2)+'\n');
  return {env,metadata};
}
