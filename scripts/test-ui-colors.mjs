import assert from 'node:assert/strict';
import { normalizeUiColor, buildUiPalette, contrastRatio, UI_COLOR_PRESETS } from '../src-tauri/renderer/src/ui-colors.js';

assert.equal(normalizeUiColor('#AbC123'), '#abc123');
for (const bad of ['', '#fff', 'red', 'url(x)', null, {}]) assert.equal(normalizeUiColor(bad), '#0072bc');
for (const dark of [false, true]) {
  for (const color of [...UI_COLOR_PRESETS.map(p => p.color), '#000000', '#ffffff', '#ffff00', '#123456']) {
    const palette = buildUiPalette(color, dark);
    assert.equal(palette['--accent'], color);
    assert.ok(contrastRatio(color, palette['--on-accent']) >= 4.5, color);
    assert.ok(contrastRatio(palette['--accent-hover'], palette['--on-accent-hover']) >= 4.5, color);
    assert.ok(contrastRatio(palette['--accent-strong'], dark ? '#1a2130' : '#ffffff') >= 4.5, color);
  }
}
console.log('PASS: UI color validation, light/dark text contrast, and hover contrast');
