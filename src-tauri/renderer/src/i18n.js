import { catalogs } from './locales/catalogs.js';
export { catalogs };
export const LANGUAGES = Object.freeze([
  { code: 'ja', name: '日本語' }, { code: 'en', name: 'English' }, { code: 'ko', name: '한국어' },
  { code: 'zh-CN', name: '简体中文' }, { code: 'zh-TW', name: '繁體中文' },
  { code: 'es', name: 'Español' }, { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' }, { code: 'pt', name: 'Português' },
]);
let currentLocale = 'ja';
export function normalizeLocale(value) {
  const code = String(value ?? '').trim().replaceAll('_', '-').toLowerCase();
  if (code.startsWith('zh')) return /(?:hant|tw|hk|mo)(?:-|$)/.test(code) ? 'zh-TW' : 'zh-CN';
  const base = code.split('-')[0];
  return LANGUAGES.some(row => row.code === base) ? base : 'ja';
}
export function resolveLocale(setting, osLocale = globalThis.navigator?.language ?? 'ja') {
  return normalizeLocale(setting === 'auto' ? osLocale : setting);
}
export function getLocale() { return currentLocale; }
export function setLocale(locale) {
  const next = normalizeLocale(locale);
  const changed = next !== currentLocale;
  currentLocale = next;
  if (globalThis.document?.documentElement) document.documentElement.lang = currentLocale;
  if (changed && globalThis.document?.dispatchEvent) document.dispatchEvent(new Event('tcplus:language'));
  return currentLocale;
}
export function t(key, params = {}) {
  const template = catalogs[currentLocale]?.[key] ?? catalogs.ja[key] ?? key;
  return String(template).replace(/\{([\w]+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
}
export function th(key, params = {}) { return t(key,params).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'); }
export function formatDuration(minutes) {
  const value = Math.abs(Math.round(Number(minutes) || 0));
  return t('work.duration', { hours: Math.floor(value / 60), minutes: value % 60 });
}
export function formatDate(date, options = {}) {
  return new Intl.DateTimeFormat(currentLocale, { year: 'numeric', month: 'short', day: 'numeric', ...options }).format(date);
}
export function weekdayLabels() {
  return new Proxy(Array(7).fill(''), { get(target, key, receiver) {
    if (typeof key === 'string' && /^[0-6]$/.test(key)) return new Intl.DateTimeFormat(currentLocale,{weekday:'short'}).format(new Date(2023,0,1+Number(key)));
    return Reflect.get(target,key,receiver);
  } });
}
// Only explicitly marked application text is translated; titles, notes and tag names are untouched.
const translatedAttributes = new WeakMap();
export function applyTranslations(root = globalThis.document) {
  if (!root?.querySelectorAll) return;
  const nodes = [...(root.matches?.('[data-i18n],[data-i18n-attrs]') ? [root] : []), ...root.querySelectorAll('[data-i18n],[data-i18n-attrs]')];
  for (const node of nodes) {
    if (node.dataset.i18n) node.textContent = t(node.dataset.i18n);
    let applied = translatedAttributes.get(node);
    if (!applied) { applied = new Map(); translatedAttributes.set(node,applied); }
    for (const entry of (node.dataset.i18nAttrs ?? '').split(';')) {
      const [attribute, key] = entry.split('=');
      if (attribute && key) {
        const current = node.getAttribute(attribute), next = t(key);
        // A calendar/picker/controller may own this attribute after rendering.
        // Do not replace state-dependent labels with the HTML template's initial label.
        if (current !== catalogs.ja[key] && current !== applied.get(attribute) && current !== next) continue;
        node.setAttribute(attribute,next); applied.set(attribute,next);
      }
    }
  }
}
