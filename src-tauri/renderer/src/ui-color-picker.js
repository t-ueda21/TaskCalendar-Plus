import { normalizeUiColor, buildUiPalette, UI_COLOR_PRESETS } from './ui-colors.js';

const drafts = new WeakMap();

export function applyUiColor(value) {
  const root = document.documentElement;
  const color = normalizeUiColor(value);
  const palette = buildUiPalette(color, root.dataset.theme === 'dark');
  for (const [key, val] of Object.entries(palette)) root.style.setProperty(key, val);
  root.dataset.uiAccentColor = color;
}

export function readUiColor(dialog) {
  return normalizeUiColor(drafts.get(dialog));
}

export function populateUiColor(dialog, value) {
  const color = normalizeUiColor(value);
  drafts.set(dialog, color);
  applyUiColor(color);
  const picker = dialog.querySelector('[data-ui-color-picker]');
  if (!picker) return;
  picker.querySelectorAll('[data-ui-color]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.uiColor === color));
  });
  const custom = picker.querySelector('[data-ui-color-custom]');
  if (custom) custom.value = color;
  const label = picker.querySelector('.uiColorCustom');
  if (label) label.dataset.selected = String(!UI_COLOR_PRESETS.some(preset => preset.color === color));
}

export function wireUiColorPicker(dialog, Store) {
  const picker = dialog.querySelector('[data-ui-color-picker]');
  if (!picker || picker.dataset.bound) return;
  picker.dataset.bound = '1';
  const presets = picker.querySelector('[data-ui-color-presets]');
  for (const preset of UI_COLOR_PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'uiColorSwatch';
    button.dataset.uiColor = preset.color;
    button.style.setProperty('--swatch-color', preset.color);
    button.style.setProperty('--swatch-text', buildUiPalette(preset.color)['--on-accent']);
    button.setAttribute('aria-label', `UIカラー：${preset.name}`);
    button.setAttribute('aria-pressed', 'false');
    button.title = preset.name;
    button.addEventListener('click', () => populateUiColor(dialog, preset.color));
    presets.appendChild(button);
  }
  picker.querySelector('[data-ui-color-custom]')?.addEventListener('input', event => {
    populateUiColor(dialog, event.target.value);
  });
  // Esc・キャンセル・保存のどの閉じ方でも、確定済みの設定を反映する。
  dialog.addEventListener('close', () => {
    if (!dialog.open) applyUiColor(Store.getSettings().uiAccentColor);
  });
}
