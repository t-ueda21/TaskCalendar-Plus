import assert from 'node:assert/strict';

// Only the DOM operations used by the renderer; no network or app database.
class Element {
  constructor(tagName) { this.tagName = tagName; this.attributes = {}; this.children = []; }
  setAttribute(name, value) { this.attributes[name] = value; }
  appendChild(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
}
globalThis.document = {
  addEventListener() {},
  createElementNS(namespace, tag) {
    assert.equal(namespace, 'http://www.w3.org/2000/svg');
    return new Element(tag);
  },
  createTextNode(text) { return { textContent: text }; },
};
globalThis.setInterval = () => 0;
const Weather = await import('../src-tauri/renderer/src/weather.js');
assert.equal(typeof Weather.renderWeatherInto, 'function', 'weather views need the SVG renderer');

const cases = [
  [0, 'sun', '快晴'], [1, 'sun-medium', '晴れ'], [2, 'cloud-sun', '晴れ時々曇り'],
  [3, 'cloud', '曇り'], [45, 'cloud-fog', '霧'], [51, 'cloud-drizzle', '霧雨'],
  [61, 'cloud-rain', '雨'], [71, 'snowflake', '雪'], [80, 'cloud-sun-rain', 'にわか雨'],
  [85, 'cloud-snow', 'にわか雪'], [95, 'cloud-lightning', '雷雨'], [999, 'thermometer', '不明'],
];
const target = new Element('div');
target.ownerDocument = document;
for (const [weatherCode, icon, weatherText] of cases) {
  // Historical cache rows contain an emoji; display must derive the new icon from the code.
  const record = { weatherCode, weatherText, icon: '⛅', tempMaxC: 24, tempMinC: 18 };
  Weather.renderWeatherInto(target, record);
  assert.equal(target.children.length, 2, 'refresh replaces old content');
  const [svg, text] = target.children;
  assert.equal(svg.tagName, 'svg');
  assert.equal(svg.attributes['data-weather-icon'], icon);
  assert.equal(svg.attributes.stroke, 'currentColor');
  assert.equal(svg.attributes.fill, 'none');
  assert.equal(svg.attributes['aria-hidden'], 'true');
  assert.ok(svg.children.length > 0, 'all icons include visible shapes');
  assert.equal(text.textContent, `${weatherText} 24.0℃/18.0℃`);
  assert.equal(Weather.formatWeatherForDisplay(record, { withTemp: false }), weatherText);
}
Weather.renderWeatherInto(target, { weatherCode: 2, weatherText: '晴れ時々曇り' }, { withTemp: false });
assert.equal(target.children[1].textContent, '晴れ時々曇り');
Weather.renderWeatherInto(target, { weatherCode: null, icon: '<img src=x onerror=alert(1)>', weatherText: '<b>未取得</b>' });
assert.equal(target.children[0].attributes['data-weather-icon'], 'thermometer', 'missing code must not become clear skies');
assert.equal(target.children[1].textContent, '<b>未取得</b>', 'untrusted cache text remains literal text');
Weather.renderWeatherInto(target, null);
assert.equal(target.children.length, 1, 'no stale icon when data is unavailable');
assert.equal(target.children[0].textContent, '天気情報なし');
console.log('PASS: all 12 SVG weather icons, old cache, text-only output, safe rendering and no-data reset');
