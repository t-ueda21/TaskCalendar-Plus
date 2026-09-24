// UI配色の計算。予定のタグ色や休日・警告の意味を持つ色は変更しない。
export const DEFAULT_UI_COLOR = '#0072bc';
export const UI_COLOR_PRESETS = [
  { name: '青（既定）', color: DEFAULT_UI_COLOR },
  { name: '紫', color: '#7c3aed' },
  { name: 'オレンジ', color: '#f97316' },
  { name: 'ピンク', color: '#ec4899' },
  { name: '水色', color: '#38bdf8' },
  { name: '緑', color: '#22c55e' },
  { name: '黄色', color: '#facc15' },
];

export function normalizeUiColor(value) {
  const color = String(value ?? '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : DEFAULT_UI_COLOR;
}

function rgb(hex) {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}

function luminance(hex) {
  const linear = rgb(hex).map(v => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

export function contrastRatio(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function onColor(color) {
  return contrastRatio(color, '#ffffff') >= contrastRatio(color, '#000000') ? '#ffffff' : '#000000';
}

function mix(color, target, amount) {
  const a = rgb(color), b = rgb(target);
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * amount).toString(16).padStart(2, '0')).join('');
}

export function buildUiPalette(value, dark = false) {
  const color = normalizeUiColor(value);
  const target = dark ? '#ffffff' : '#000000';
  const surface = dark ? '#1a2130' : '#ffffff';
  let textColor = color;
  for (let step = 1; contrastRatio(textColor, surface) < 4.5 && step <= 25; step++) {
    textColor = mix(color, target, step / 25);
  }
  const hover = mix(color, target, 0.15);
  const channels = rgb(color).join(', ');
  return {
    '--accent': color,
    '--accent-rgb': channels,
    '--accent-soft': `rgba(${channels}, ${dark ? '0.16' : '0.10'})`,
    '--accent-strong': textColor,
    '--accent-hover': hover,
    '--on-accent': onColor(color),
    '--on-accent-hover': onColor(hover),
  };
}
