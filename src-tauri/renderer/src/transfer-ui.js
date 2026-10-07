import { buildSettingsExport,parseSettingsImport } from './settings-transfer.js';
import { bindValidatedFile,parseBackupFile } from './transfer-file.js';
import { describeLocalAiImport,validateLocalAiImport } from './local-ai-settings.js';
import { formatDateKey } from './ui-utils.js';
import { t as translate } from './i18n.js';
import { showAppAlert, showAppConfirm } from './app-dialogs.js';

export function wireTransferUi(dialog,Store,{downloadJsonFile,describeSensitiveImportSettings}) {
  const find=selector=>dialog.querySelector(selector);
  dialog.addEventListener('cancel',event=>{if(dialog.dataset.transferBusy==='true')event.preventDefault();});
  const busyDialog=value=>{
    dialog.dataset.transferBusy=String(value);
    for(const node of dialog.querySelectorAll('button,input,select,textarea')) {
      if(value){node.dataset.transferDisabledBefore=String(node.disabled);node.disabled=true;}
      else if(node.dataset.transferDisabledBefore!==undefined){node.disabled=node.dataset.transferDisabledBefore==='true';delete node.dataset.transferDisabledBefore;}
    }
  };
  for(const type of ['settings','backup']) {
    const settings=type==='settings';
    const input=find(settings?'[data-settings-import-file]':'[data-backup-file]');
    const button=find(settings?'[data-settings-import-btn]':'[data-backup-restore-btn]');
    const name=find(settings?'[data-settings-import-file-name]':'[data-backup-file-name]');
    const status=find(`[data-transfer-status="${type}"]`);
    const parse=settings?text=>{const parsed=parseSettingsImport(text,{allowedSettingKeys:Object.keys(Store.getSettings())});validateLocalAiImport(parsed.settings,Store.getSettings());return parsed;}:parseBackupFile;
    const files=bindValidatedFile(dialog,{input,button,name,status,parse,preview:data=>translate(settings?'transfer.settingsPreview':'transfer.backupPreview',{settings:Object.keys(data.settings).length,tags:data.tags.length,tasks:data.tasks?.length??0})});
    let running=false;
    button.addEventListener('click',async()=>{
      const data=files.get();if(running||!data)return;
      running=true;
      const details=[...describeSensitiveImportSettings(data.settings,Store.AI_PROVIDER_LABELS??{}),...describeLocalAiImport(data.settings,Store.getSettings())];
      const message=translate(settings?'transfer.confirmSettings':'transfer.confirmRestore')+(details.length?`\n\n${details.join('\n')}`:'');
      if(!await showAppConfirm(message,{danger:!settings,confirmLabel:translate(settings?'ui.f13f3cc089':'ui.d0ce767bc4')})){running=false;return;}
      files.busy(true);busyDialog(true);status.textContent=translate('transfer.importing');
      try {
        if(settings) {
          const result=await Store.applySettingsImport(data);files.clear();dialog.close();
          await showAppAlert(translate('transfer.settingsDone',{settings:result.settingKeys,created:result.createdTags,existing:result.existingTags}));
        } else {
          const response=await fetch('/api/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
          const result=await response.json();if(!response.ok)throw Error(result.error||translate('transfer.failed'));
          await showAppAlert(translate('transfer.restored'));window.location.reload();
        }
      } catch(error) {status.textContent=String(error.message??error);}
      finally {running=false;busyDialog(false);files.busy(false);}
    });
    const exportButton=find(settings?'[data-settings-export-btn]':'[data-backup-export-btn]');
    const exportStatus=find(`[data-export-status="${type}"]`);
    exportButton.addEventListener('click',async()=>{
      exportButton.disabled=true;exportStatus.textContent=translate('transfer.exporting');
      try {
        let data;
        if(settings)data=buildSettingsExport(Store.getSettings(),Store.getAllTags());
        else {const response=await fetch('/api/backup');if(!response.ok)throw Error(translate('transfer.failed'));data=await response.json();}
        downloadJsonFile(data,`taskcalendar-plus-${type}-${formatDateKey(new Date())}.json`);exportStatus.textContent=translate('transfer.downloadStarted');
      } catch(error){exportStatus.textContent=String(error.message??error);}finally{exportButton.disabled=false;}
    });
  }
}
