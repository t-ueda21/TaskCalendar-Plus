import {TaskSelection} from './task-selection.js';
import {t,th} from './i18n.js';

export function wireTaskBatch(root, Store, {orderedIds,onFocus}={}) {
  const selection=new TaskSelection();
  const panel=root.querySelector('[data-calendar-panel],[data-tasks-panel]');
  const bar=document.createElement('div');bar.className='taskSelectionBar';bar.hidden=true;bar.dataset.taskSelectionBar='';
  bar.innerHTML='<span data-selection-count></span><button type="button" class="btn primary" data-bulk-edit></button><button type="button" class="btn" data-selection-clear></button><span data-selection-status role="status"></span>';
  panel.querySelector('.calendarTitleBar').after(bar);
  const count=bar.querySelector('[data-selection-count]'),edit=bar.querySelector('[data-bulk-edit]'),clear=bar.querySelector('[data-selection-clear]'),status=bar.querySelector('[data-selection-status]');
  const visibleIds=()=>orderedIds?.()??[...new Set([...root.querySelectorAll('[data-task-id]')].filter(node=>node.getClientRects().length&&!node.closest('[hidden]')).map(node=>node.dataset.taskId))];
  function render() {
    if(root.hidden)return;
    selection.prune(visibleIds());
    root.querySelectorAll('[data-task-id]').forEach(node=>{
      const selected=selection.ids.has(node.dataset.taskId);
      node.classList.toggle('isTaskSelected',selected);
      node.setAttribute('aria-selected',String(selected));
    });
    count.textContent=t('batch.count',{count:selection.ids.size});
    edit.textContent=t('batch.edit');clear.textContent=t('batch.clear');
    edit.disabled=selection.ids.size<2;clear.disabled=!selection.ids.size;
    bar.hidden=selection.ids.size<2&&!status.textContent;
  }
  const reset=()=>{selection.clear();status.textContent='';render();};
  clear.addEventListener('click',reset);
  root.addEventListener('click',event=>{
    const node=event.target.closest('[data-task-id]');
    const control=event.target.closest('button,input,select,textarea,a');
    if(!node||(control&&control!==node)||event.button!==0)return;
    status.textContent='';
    selection.select(node.dataset.taskId,event,visibleIds());
    onFocus?.(selection.ids.has(node.dataset.taskId)?node.dataset.taskId:[...selection.ids].at(-1));
    render();
    if(event.ctrlKey||event.metaKey||event.shiftKey){event.preventDefault();event.stopImmediatePropagation();}
  },true);
  root.addEventListener('pointerdown',event=>{
    if(event.target.closest('.slots')&&!event.target.closest('[data-task-id]')&&!event.ctrlKey&&!event.shiftKey)reset();
  });
  document.addEventListener('keydown',event=>{
    if(root.hidden||document.querySelector('dialog[open]')||event.target.closest?.('input,textarea,select'))return;
    if(event.key==='Escape'){reset();return;}
    // Single-task clipboard/delete handlers must not silently target one item
    // while several tasks are highlighted. Batch editing is explicit in the bar.
    if(selection.ids.size>1&&(event.key==='Delete'||((event.ctrlKey||event.metaKey)&&['c','x','v'].includes(event.key.toLowerCase())))){
      event.preventDefault();event.stopImmediatePropagation();
    }
  },true);
  edit.addEventListener('click',()=>openEditor());
  let queued=false;
  new MutationObserver(records=>{
    if(queued||!records.some(record=>[record.target,...record.addedNodes,...record.removedNodes].some(node=>node.nodeType===1&&(node.matches('[data-task-id]')||node.querySelector('[data-task-id]')))))return;
    queued=true;queueMicrotask(()=>{queued=false;render();});
  }).observe(root,{childList:true,subtree:true});
  document.addEventListener('tcplus:language',render);
  panel.setAttribute('aria-description',t('batch.shortcuts'));

  function getContextTasks(taskId) {
    selection.prune(visibleIds());
    if(!selection.ids.has(taskId))selection.select(taskId);
    status.textContent='';render();
    // Freeze both the target IDs and revisions when the menu opens.
    return Store.getAllTasks().filter(task=>selection.ids.has(task.id)).map(task=>structuredClone(task));
  }
  let contextSaving=false;
  async function applyContextTag(snapshots,tagId) {
    if(contextSaving)return false;
    contextSaving=true;status.textContent=t('batch.saving');render();
    try {
      await Store.updateTasksBatch(snapshots,{tagId});
      status.textContent=t('batch.saved',{count:snapshots.length});
      return true;
    } catch(cause) {
      status.textContent=String(cause?.message??cause);
      return false;
    } finally {
      contextSaving=false;render();
    }
  }

  function openEditor() {
    const ids=new Set(selection.ids);
    const snapshots=Store.getAllTasks().filter(task=>ids.has(task.id)).map(task=>structuredClone(task));
    if(snapshots.length<2)return;
    const dialog=document.createElement('dialog');dialog.className='dialog bulkTaskDialog';dialog.dataset.bulkDialog='';dialog.setAttribute('aria-label',t('batch.edit'));
    dialog.innerHTML=`<header><h2>${th('batch.edit')}</h2><p>${th('batch.count',{count:snapshots.length})}</p></header><form novalidate><p class="bulkHint">${th('batch.hint')}</p><div class="bulkField"><label><input type="checkbox" data-bulk-enable="tag"/>${th('batch.tag')}</label><select data-bulk-tag aria-label="${th('batch.tag')}" disabled></select></div><div class="bulkField"><label><input type="checkbox" data-bulk-enable="date"/>${th('batch.date')}</label><input type="date" data-bulk-date aria-label="${th('batch.date')}" disabled/></div><div class="bulkField"><label><input type="checkbox" data-bulk-enable="memo"/>${th('batch.memo')}</label><textarea rows="3" data-bulk-memo aria-label="${th('batch.memo')}" disabled></textarea></div><p class="bulkHint">${th('batch.instances')}</p><p class="bulkError" data-bulk-error role="alert"></p></form><footer><button type="button" class="btn" data-bulk-cancel>${th('common.cancel')}</button><button type="button" class="btn primary" data-bulk-apply disabled>${th('batch.apply',{count:snapshots.length})}</button></footer>`;
    const tag=dialog.querySelector('[data-bulk-tag]'),date=dialog.querySelector('[data-bulk-date]'),memo=dialog.querySelector('[data-bulk-memo]'),apply=dialog.querySelector('[data-bulk-apply]'),cancel=dialog.querySelector('[data-bulk-cancel]'),error=dialog.querySelector('[data-bulk-error]');
    tag.append(new Option(t('ui.af1cc864e3'),''));
    Store.getAllTags().forEach(row=>tag.append(new Option(row.name,row.id)));
    const commonTag=snapshots.every(task=>task.tagId===snapshots[0].tagId)?snapshots[0].tagId:'';
    tag.value=commonTag;date.value=snapshots[0].date;
    let busy=false;
    const enabled=key=>dialog.querySelector(`[data-bulk-enable="${key}"]`).checked;
    const sync=()=>{
      tag.disabled=busy||!enabled('tag');date.disabled=busy||!enabled('date');memo.disabled=busy||!enabled('memo');
      dialog.querySelectorAll('[data-bulk-enable]').forEach(node=>{node.disabled=busy;});
      cancel.disabled=busy;apply.disabled=busy||!['tag','date','memo'].some(enabled);
      apply.textContent=busy?t('batch.saving'):t('batch.apply',{count:snapshots.length});
    };
    dialog.querySelectorAll('[data-bulk-enable]').forEach(node=>node.addEventListener('change',sync));
    cancel.addEventListener('click',()=>dialog.close());
    dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
    dialog.addEventListener('click',event=>{if(event.target===dialog&&!busy){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
    dialog.addEventListener('close',()=>{dialog.remove();if(!edit.disabled)edit.focus({preventScroll:true});},{once:true});
    const save=async()=>{
      if(busy)return;
      const patch={};if(enabled('tag'))patch.tagId=tag.value;if(enabled('date'))patch.date=date.value;if(enabled('memo'))patch.memo=memo.value;
      if(!Object.keys(patch).length||(enabled('date')&&(!date.value||!date.checkValidity()))){error.textContent=t('batch.invalid');return;}
      busy=true;error.textContent='';sync();
      try {await Store.updateTasksBatch(snapshots,patch);selection.clear();status.textContent=t('batch.saved',{count:snapshots.length});dialog.close();render();}
      catch(cause){error.textContent=String(cause?.message??cause);}
      finally{busy=false;sync();}
    };
    apply.addEventListener('click',save);
    dialog.querySelector('form').addEventListener('submit',event=>{event.preventDefault();void save();});
    document.body.append(dialog);dialog.showModal();sync();
  }
  return {clear:reset,refresh:render,selection,getContextTasks,applyContextTag};
}
