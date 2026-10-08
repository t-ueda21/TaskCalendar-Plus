// Role A: user-approved settings information architecture, independent of implementation arrays.
import assert from 'node:assert/strict';

export const settingsPageIds = ['display','work','tags','ai','outlook','links','startup','data','updates','shortcuts','info'];
export const settingsPageLabelsJa = ['表示','勤務時間と休日','タグ管理','AI','Outlook','リンク','起動・常駐','データ','アップデート','ショートカット','説明'];
export const settingsFieldPages = {
  uiLanguage:'display', granularity:'display', showBusinessDaysOnly:'display', weatherLocationKey:'display',
  workStart:'work', workEnd:'work', companyHolidaysText:'work',
  aiCliEnabled:'ai', aiProvider:'ai', aiClaudeModel:'ai', aiClaudeEffort:'ai', aiCodexModel:'ai', aiCodexEffort:'ai',
  aiOllamaEndpoint:'ai', aiOllamaModel:'ai', aiLmStudioEndpoint:'ai', aiLmStudioModel:'ai',
  outlookCalendarName:'outlook', outlookDays:'outlook', outlookTagId:'outlook', outlookWriteDefault:'outlook',
  outlookWriteCalendarName:'outlook', outlookAutoSync:'outlook', outlookAutoSyncIntervalMin:'outlook',
  quickLinksText:'links', urlAutoOpenEnabled:'links', urlAutoOpenUrl:'links', urlAutoOpenTimesText:'links',
  launchAtLogin:'startup', trayEnabled:'startup', startMinimizedToTray:'startup', checkUpdatesOnStartup:'updates',
};
export const settingsControlPages = {
  '[data-theme-toggle]':'display', '[data-ui-color-picker]':'display', '[data-breaks-list]':'work',
  '[data-tag-list]':'tags', '[data-ai-personalization]':'ai',
  '[data-settings-export-btn]':'data', '[data-settings-import-file]':'data', '[data-settings-import-btn]':'data',
  '[data-backup-export-btn]':'data', '[data-backup-file]':'data', '[data-backup-restore-btn]':'data',
  '[data-update-current]':'updates', '[data-update-check]':'updates', '[data-update-open]':'updates',
  '[data-project-github]':'info', '.settingsFeatureGrid':'info',
};

export async function assertSettingsArchitecture(dialog) {
  assert.deepEqual(await dialog.locator('[data-settings-tab]').evaluateAll(nodes=>nodes.map(node=>node.dataset.settingsTab)),settingsPageIds);
  const names=await dialog.locator('[name]').evaluateAll(nodes=>nodes.map(node=>node.name).sort());
  assert.deepEqual(names,Object.keys(settingsFieldPages).sort(),'all original named settings remain exactly once');
  for(const [selector,page] of Object.entries({...Object.fromEntries(Object.entries(settingsFieldPages).map(([name,page])=>[`[name="${name}"]`,page])),...settingsControlPages})){
    assert.equal(await dialog.locator(selector).count(),1,selector+' occurs exactly once');
    assert.equal(await dialog.locator(selector).evaluate(node=>node.closest('[data-settings-tab-panel]')?.dataset.settingsTabPanel),page,selector);
  }
  for(const id of settingsPageIds){
    const button=dialog.locator(`[data-settings-tab="${id}"]`),panel=dialog.locator(`[data-settings-tab-panel="${id}"]`);
    assert.equal(await button.getAttribute('role'),'tab');assert.equal(await panel.getAttribute('role'),'tabpanel');
    assert.equal(await button.getAttribute('aria-controls'),await panel.getAttribute('id'));
    assert.equal(await panel.getAttribute('aria-labelledby'),await button.getAttribute('id'));
  }
}
