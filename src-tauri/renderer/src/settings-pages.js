import { applyTranslations } from './i18n.js';

const pages = [
  ['general','settings.page.general'], ['advanced','settings.page.advanced'],
  ['tags','ui.a93778fc94'], ['ai','settings.page.ai'], ['outlook',null],
  ['about','settings.page.about'], ['app','settings.page.app'], ['shortcuts','ui.8fd49ecbb2'],
];

function translated(tag, className, key) {
  const node = document.createElement(tag);
  node.className = className;
  node.dataset.i18n = key;
  return node;
}

// Move existing controls rather than recreate them, preserving IDs, values and handlers.
export function prepareSettingsPages(dialog) {
  if (dialog.classList.contains('settingsPages')) return;
  dialog.classList.add('settingsPages');
  const body = dialog.querySelector('.settingsDialogBody');
  const tabs = dialog.querySelector('.settingsTabs');
  const panels = new Map([...dialog.querySelectorAll('[data-settings-tab-panel]')].map(node => [node.dataset.settingsTabPanel,node]));
  for (const key of ['ai','app']) {
    const panel = document.createElement('section');
    panel.className = 'settingsTabPanel'; panel.dataset.settingsTabPanel = key; panel.hidden = true;
    body.append(panel); panels.set(key,panel);
  }
  const moveSection = (selector, destination) => {
    const section = dialog.querySelector(selector)?.closest('.settingsSection');
    if (section) panels.get(destination).append(section);
    return section;
  };
  moveSection('[data-company-holidays-input]', 'advanced');
  const calendarDisplay = moveSection('[name="granularity"]', 'general');
  const language = dialog.querySelector('[data-language-select]')?.closest('.settingsSection');
  language?.after(calendarDisplay);
  moveSection('[name="launchAtLogin"]', 'app');
  moveSection('[name="urlAutoOpenEnabled"]', 'app');
  moveSection('[data-update-check]', 'app');
  moveSection('[data-project-github]', 'app');
  const aiConnection = moveSection('[data-ai-provider-select]', 'ai');
  const personality = dialog.querySelector('[data-ai-personalization]');
  if (personality) {
    const section = document.createElement('section'); section.className = 'settingsSection';
    section.append(personality); panels.get('ai').append(section);
  }
  const aiTitle = aiConnection?.querySelector('.settingsSectionLabel');
  if (aiTitle) aiTitle.dataset.i18n = 'settings.aiConnection';

  const appearance = document.createElement('section'); appearance.className = 'settingsSection';
  const appearanceControls = document.createElement('div'); appearanceControls.className = 'settingsAppearanceControls';
  for (const selector of ['[data-theme-toggle]','[data-ui-color-picker]']) {
    const control = dialog.querySelector(selector); if (control) appearanceControls.append(control);
  }
  appearance.append(translated('h3','settingsSectionLabel','settings.appearance'), appearanceControls, translated('p','settingsTagHint','settings.appearanceHint'));
  panels.get('general').prepend(appearance);
  const sub = dialog.querySelector('.settingsDialogSub');
  sub.replaceChildren(translated('span','','settings.pagesHint'));
  const aboutHint = dialog.querySelector('.settingsAboutNote');
  if (aboutHint) aboutHint.replaceChildren(translated('span','','settings.aboutHint'));

  for (const [name,key] of pages) {
    let button = tabs.querySelector(`[data-settings-tab="${name}"]`);
    if (!button) {
      button = document.createElement('button'); button.type = 'button'; button.className = 'settingsTabBtn';
      button.dataset.settingsTab = name; button.setAttribute('role','tab');
    }
    button.replaceChildren(key ? translated('span','',key) : document.createTextNode('Outlook'));
    button.id = `settings-tab-${name}`; button.setAttribute('aria-controls',`settings-panel-${name}`);
    tabs.append(button);
    const panel = panels.get(name);
    panel.id = `settings-panel-${name}`; panel.setAttribute('role','tabpanel'); panel.setAttribute('aria-labelledby',button.id);
    const heading = document.createElement('div'); heading.className = 'settingsPageHeading';
    const title = key ? translated('h2','',key) : document.createElement('h2');
    if (!key) title.textContent = 'Outlook';
    heading.append(title,translated('p','',`settings.description.${name}`));
    panel.prepend(heading);
  }
  const narrow = window.matchMedia('(max-width: 620px)');
  const syncOrientation = () => tabs.setAttribute('aria-orientation', narrow.matches ? 'horizontal' : 'vertical');
  narrow.addEventListener('change',syncOrientation); syncOrientation();
  applyTranslations(dialog);
}
