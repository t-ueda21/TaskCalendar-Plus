import { t, th, getLocale, formatDuration } from './i18n.js';
import { escHtml, normalizeHexColor } from './ui-utils.js';
import { SUMMARY_METRICS } from './summary-preferences.js';

export const TAGS_PER_PAGE = 10;
const metricKeys = Object.freeze({ total:'summary.metric.total', average:'summary.metric.average', overtime:'summary.metric.overtime',
  days:'summary.metric.days', overtimeDays:'summary.metric.overtimeDays', longest:'summary.metric.longest' });
const comparisonKeys = Object.freeze({ month:'summary.comparison.month', year:'summary.comparison.year', businessDays:'summary.comparison.businessDays' });
const query = (root, key) => root.querySelector(`[data-summary-${key}]`);
const number = (value, digits = 0) => new Intl.NumberFormat(getLocale(), { maximumFractionDigits:digits }).format(value);
const dateObject = key => new Date(`${key.length === 7 ? key + '-01' : key}T00:00:00Z`);
const dateText = (key, options) => new Intl.DateTimeFormat(getLocale(), { timeZone:'Asia/Tokyo', ...options }).format(dateObject(key));
const groupLabel = (group, period) => dateText(group.key, period === 'year'
  ? {year:'numeric',month:'long'} : {month:'numeric',day:'numeric',weekday:'short'});
const color = tag => normalizeHexColor(tag.color);

function timeParts(minutes) {
  const rounded = Math.max(0, Math.round(minutes || 0));
  return { hours:number(Math.floor(rounded / 60)), minutes:number(rounded % 60) };
}
function timeMarkup(minutes) {
  const parts = timeParts(minutes);
  return `${parts.hours}<small>${th('summary.hours')}</small>${parts.minutes}<small>${th('summary.minutes')}</small>`;
}
function metricDetails(model, preferences) {
  const denominator = preferences.averageBase === 'business' ? model.businessDays : model.registeredDays;
  let comparison = t('summary.noComparison');
  if (model.comparison) comparison = `${t(comparisonKeys[model.comparison.kind], {days:number(model.comparison.businessDays)})} ${model.comparison.delta >= 0 ? '+' : '−'}${formatDuration(Math.abs(model.comparison.delta))}`;
  return {
    total: { value:timeMarkup(model.total), detail:comparison },
    average: { value:timeMarkup(denominator ? model.total / denominator : 0), detail:t(preferences.averageBase === 'business' ? 'summary.businessBase' : 'summary.recordedBase', {days:number(denominator)}) },
    overtime: { value:timeMarkup(model.overtime), detail:t('summary.outsideWindow') },
    days: { value:`${number(model.registeredDays)}<small>${th('summary.daysUnit')}</small>`, detail:t('summary.businessBase', {days:number(model.businessDays)}) },
    overtimeDays: { value:`${number(model.overtimeDays)}<small>${th('summary.daysUnit')}</small>`, detail:t('summary.outsideWindow') },
    longest: { value:timeMarkup(model.longestDay?.total), detail:model.longestDay ? groupLabel(model.longestDay, 'month') : '—' },
  };
}

function renderMetrics(root, model, preferences) {
  const details = metricDetails(model, preferences);
  query(root, 'metrics').innerHTML = SUMMARY_METRICS.map(id => {
    const metric = details[id];
    return `<article class="summaryMetric" data-summary-metric="${id}"><div class="summaryMetricLabel">${th(metricKeys[id])}</div><div class="summaryMetricValue" data-metric-value>${metric.value}</div><div class="summaryMetricDetail" title="${escHtml(metric.detail)}">${escHtml(metric.detail)}</div></article>`;
  }).join('');
}

function graphSegments(model, group) {
  if (!model.selectedTagIds) return [{minutes:group.total - group.overtime,color:'var(--accent)'},{minutes:group.overtime,color:'var(--warn)'}];
  const result = model.tags.filter(tag => model.selectedTagIds.includes(tag.id))
    .map(tag => ({minutes:group.normalByTag.get(tag.id) || 0,color:color(tag)}));
  result.push({minutes:group.overlap,color:'var(--muted)'},{minutes:group.overtime,color:'var(--warn)'});
  return result;
}

function renderChart(root, model) {
  const monthly = model.period === 'month';
  query(root, 'chart-title').textContent = t(monthly ? 'summary.dailyChart' : 'summary.monthlyChart');
  const selected = model.selectedTagIds ? model.tags.filter(tag => model.selectedTagIds.includes(tag.id)) : [];
  const legend = model.selectedTagIds ? selected.slice(0, 3).map(tag => `<span title="${escHtml(tag.name)}"><i style="background:${color(tag)}"></i><b>${escHtml(tag.name)}</b></span>`)
    : [`<span><i style="background:var(--accent)"></i><b>${th('summary.normal')}</b></span>`];
  if (selected.length > 3) legend.push(`<span title="${escHtml(selected.slice(3).map(tag => tag.name).join(' / '))}">+${number(selected.length - 3)}</span>`);
  if (model.selectedTagIds && model.overlap > 0) legend.push(`<span title="${th('summary.overlapHint')}"><i style="background:var(--muted)"></i><b>${th('summary.overlap')}</b></span>`);
  legend.push(`<span><i style="background:var(--warn)"></i><b>${th('summary.outside')}</b></span>`);
  query(root, 'legend').innerHTML = legend.join('');
  const unit = monthly ? 120 : 1200;
  const scale = Math.max(unit * 5, Math.ceil(Math.max(...model.groups.map(group => group.total), 0) / (unit * 5)) * unit * 5);
  query(root, 'axis').innerHTML = [5,4,3,2,1,0].map(index => `<span style="top:${(5 - index) * 20}%">${number(scale / 60 * index / 5)}${index === 5 ? escHtml(t('summary.hours')) : ''}</span>`).join('');
  query(root, 'bars').style.setProperty('--summary-columns', model.groups.length);
  query(root, 'bars').innerHTML = model.groups.map(group => {
    const label = monthly ? number(Number(group.key.slice(8))) : dateText(group.key,{month:'short'});
    const day = Number(group.key.slice(8));
    const tick = !monthly || day === 1 || day === model.groups.length || (day % 5 === 0 && day < model.groups.length - 1);
    const future = monthly ? group.key > model.today : group.key >= model.today.slice(0,7) && model.includeFuture;
    const description = group.active ? t('summary.timeLabel', {date:groupLabel(group,model.period),total:formatDuration(group.total),overtime:formatDuration(group.overtime)}) : `${groupLabel(group,model.period)} · ${t('summary.outOfScope')}`;
    const segments = graphSegments(model,group).filter(row => row.minutes > 0).map(row => `<span style="height:${row.minutes / group.total * 100}%;background:${row.color}"></span>`).join('');
    return `<button type="button" class="summaryBar ${future ? 'future' : ''}" data-summary-bar="${group.key}" data-summary-tick="${tick}" aria-pressed="false" aria-label="${escHtml(description)}" title="${escHtml(description)}" ${group.active ? '' : 'disabled'}><span class="summaryBarStack" style="height:${group.total / scale * 100}%">${segments}</span><span class="summaryBarLabel" ${tick ? '' : 'hidden'}>${escHtml(label)}</span></button>`;
  }).join('');
  query(root, 'empty').hidden = model.total > 0;
}

function renderNumbers(root, model) {
  const monthly = model.period === 'month';
  query(root, 'numbers-title').textContent = t(monthly ? 'summary.dailyNumbers' : 'summary.monthlyNumbers');
  query(root, 'numbers-hint').textContent = t(monthly ? 'summary.pickDay' : 'summary.pickMonth');
  query(root, 'number-grid').classList.toggle('year', !monthly);
  query(root, 'number-grid').innerHTML = model.groups.map(group => {
    const parts = timeParts(group.total);
    const description = `${groupLabel(group,model.period)} · ${group.active ? formatDuration(group.total) : t('summary.outOfScope')}`;
    const label = monthly ? `${number(Number(group.key.slice(8)))}<em>${escHtml(dateText(group.key,{weekday:'short'}))}</em>` : escHtml(dateText(group.key,{month:'short'}));
    const duration = group.active ? `<span class="summaryDayHours">${parts.hours}<small>${th('summary.hours')}</small></span><span class="summaryDayMinutes">${parts.minutes}<small>${th('summary.minutes')}</small></span>` : '<span class="summaryDayHours">—</span>';
    return `<button type="button" class="summaryDay ${group.total ? '' : 'no-time'} ${group.key === model.today ? 'today' : ''}" data-summary-day="${group.key}" aria-pressed="false" aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home End" aria-label="${escHtml(description)}" title="${escHtml(description)}" ${group.active ? '' : 'disabled'}><span class="summaryDayLabel">${label}</span><span class="summaryDayTime">${duration}</span></button>`;
  }).join('');
}

function renderTags(root, model, state) {
  const pageCount = Math.max(1, Math.ceil(model.tags.length / TAGS_PER_PAGE));
  state.tagPage = Math.max(0, Math.min(state.tagPage, pageCount - 1));
  const tags = model.tags.slice(state.tagPage * TAGS_PER_PAGE, (state.tagPage + 1) * TAGS_PER_PAGE);
  query(root, 'tags').style.setProperty('--summary-tag-rows',Math.max(1,Math.ceil(tags.length / 2)));
  query(root, 'tags').style.setProperty('--summary-tag-count',Math.max(1,tags.length));
  query(root, 'tags').classList.toggle('many', model.tags.length > 4);
  const totalTagTime = model.tags.reduce((sum, tag) => sum + tag.total, 0);
  query(root, 'tags').innerHTML = tags.length ? tags.map(tag => {
    const selected = Boolean(model.selectedTagIds?.includes(tag.id));
    const share = totalTagTime ? tag.total / totalTagTime * 100 : 0;
    return `<button type="button" class="summaryTag ${model.selectedTagIds && !selected ? 'muted' : ''}" data-summary-tag="${escHtml(tag.id)}" aria-pressed="${selected}" aria-label="${th(selected ? 'summary.unselectTag' : 'summary.selectTag',{tag:tag.name})}" title="${escHtml(tag.name)}"><span class="summaryTagHead"><span class="summaryTagCheck" aria-hidden="true">${selected ? '✓' : ''}</span><span class="summaryTagDot" style="background:${color(tag)}"></span><span class="summaryTagName">${escHtml(tag.name)}</span><strong title="${escHtml(formatDuration(tag.total))} (${number(share,1)}%)">${escHtml(formatDuration(tag.total))}</strong></span><span class="summaryTagTrack"><i style="width:${share}%;background:${color(tag)}"></i></span><span class="summaryTagShare">${number(share,1)}%</span></button>`;
  }).join('') : `<span class="summaryNoTags">${th('summary.noTags')}</span>`;
  query(root, 'all-tags').setAttribute('aria-pressed', String(model.selectedTagIds === null));
  query(root, 'tag-pager').hidden = pageCount <= 1;
  query(root, 'tag-page-label').textContent = `${number(state.tagPage + 1)} / ${number(pageCount)}`;
  root.querySelector('[data-summary-tag-page="-1"]').disabled = state.tagPage === 0;
  root.querySelector('[data-summary-tag-page="1"]').disabled = state.tagPage === pageCount - 1;
  const names = model.selectedTagIds === null ? t('summary.allTags') : model.tags.filter(tag => model.selectedTagIds.includes(tag.id)).map(tag => tag.name).join(' / ') || t('summary.noSelection');
  query(root, 'tag-status').textContent = names;
  query(root, 'tag-status').title = names;
}

function renderInsights(root, model) {
  const longest = model.longestDay;
  const rows = [
    {icon:'<path d="M5 16 10 11 14 14 20 5M14 5h6v6"/>',title:t('summary.insightOutsideCompact',{days:number(model.overtimeDays),percent:number(model.total ? model.overtime / model.total * 100 : 0,1)})},
    {icon:'<path d="M5 20V12M12 20V4M19 20V8"/>',title:longest ? t('summary.insightLongestCompact',{date:groupLabel(longest,'month'),total:formatDuration(longest.total),overtime:formatDuration(longest.overtime)}) : t('summary.metric.longest') + '：—'},
    {icon:'<path d="M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1"/>',title:t('summary.insightCount',{count:number(model.count)}),hint:t('summary.countHint')},
  ];
  query(root, 'insights').innerHTML = rows.map(row => `<div class="summaryInsight" ${row.hint ? `title="${escHtml(row.hint)}"` : ''}><span class="summaryInsightIcon" aria-hidden="true"><svg viewBox="0 0 24 24">${row.icon}</svg></span><p>${escHtml(row.title)}</p></div>`).join('');
}

export function renderSelection(root, model, state) {
  if (!model.groups.some(group => group.key === state.selectedKey && group.active)) {
    const currentKey = model.period === 'year' ? model.today.slice(0,7) : model.today;
    state.selectedKey = model.groups.find(group => group.key === currentKey && group.active)?.key
      || model.groups.findLast(group => group.total > 0 && group.active)?.key
      || model.groups.find(group => group.active)?.key || model.groups[0].key;
  }
  root.querySelectorAll('[data-summary-bar],[data-summary-day]').forEach(node => {
    const selected = (node.dataset.summaryBar || node.dataset.summaryDay) === state.selectedKey;
    node.setAttribute('aria-pressed',String(selected));
    // The numeric grid is the keyboard entry point for the same chart selection.
    node.tabIndex = node.hasAttribute('data-summary-day') && selected && !node.disabled ? 0 : -1;
  });
  const bars = [...root.querySelectorAll('[data-summary-bar]')];
  const selectedIndex = bars.findIndex(node => node.dataset.summaryBar === state.selectedKey);
  bars.forEach((node, index) => {
    node.querySelector('.summaryBarLabel').hidden = model.period === 'month' && index !== selectedIndex
      && (node.dataset.summaryTick !== 'true' || Math.abs(index - selectedIndex) <= 1);
  });
  const group = model.groups.find(row => row.key === state.selectedKey);
  query(root, 'selected').innerHTML = `<strong>${escHtml(groupLabel(group,model.period))}${group.key === model.today ? ` · ${th('summary.today')}` : ''}</strong>${group.active ? `<span>${th('summary.metric.total')}<b>${escHtml(formatDuration(group.total))}</b></span><span>${th('summary.outside')}<b>${escHtml(formatDuration(group.overtime))}</b></span>` : `<span>${th('summary.outOfScope')}</span>`}`;
}

/** Only dynamic fragments are replaced; all event handlers live on the stable view root. */
export function renderSummary(root, model, state) {
  const focused = document.activeElement;
  const focusAttribute = ['data-summary-tag','data-summary-day','data-summary-bar'].find(attribute => focused?.hasAttribute(attribute));
  const focusValue = focusAttribute && focused.getAttribute(focusAttribute);
  root.querySelectorAll('[data-summary-period]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.summaryPeriod === model.period)));
  query(root, 'period-label').textContent = dateText(model.start, model.period === 'month' ? {year:'numeric',month:'short'} : {year:'numeric'});
  query(root, 'current').textContent = t(model.period === 'month' ? 'summary.thisMonth' : 'summary.thisYear');
  for (const [shift,direction] of [[-1,'previous'],[1,'next']]) {
    const button = root.querySelector(`[data-summary-shift="${shift}"]`);
    const label = t(`calendar.${direction}.${model.period === 'month' ? 'days' : 'months'}`);
    button.querySelector('[data-nav-label]').textContent = label;
    button.setAttribute('aria-label',label);
  }
  root.querySelector('[data-summary-shift="-1"]').disabled = model.year === 1 && (model.period === 'year' || model.month === 1);
  root.querySelector('[data-summary-shift="1"]').disabled = model.year === 9999 && (model.period === 'year' || model.month === 12);
  query(root, 'future').checked = state.includeFuture;
  query(root, 'range').textContent = model.start > model.cutoff ? t('summary.outOfScope') : `${model.start.replaceAll('-','/')} – ${model.cutoff.replaceAll('-','/')} · ${t(state.includeFuture ? 'summary.futureIncluded' : 'summary.futureExcluded')}`;
  renderMetrics(root, model, state.preferences);
  renderChart(root, model);
  renderNumbers(root, model);
  renderTags(root, model, state);
  renderInsights(root, model);
  renderSelection(root, model, state);
  if (focusAttribute && !focused.isConnected) [...root.querySelectorAll(`[${focusAttribute}]`)]
    .find(node => node.getAttribute(focusAttribute) === focusValue)?.focus({preventScroll:true});
}
