/**
 * ui-utils.js — 画面共通のユーティリティ
 *
 * 日付・時刻・書式の変換、ミニカレンダー、時刻ピッカー、予定ダイアログ、
 * ヘッダー時計、3画面で共通のサイドバー部品など。
 * タイムグリッドは time-grid.js、設定ダイアログは settings-dialog.js、
 * タグ管理と色の選択は tag-manager.js にある。
 * XSS 対策として escHtml を徹底し、innerHTML への文字列挿入は
 * 全て escHtml 済みの値のみ使用する。
 *
 * 注意: store.js が本ファイルをimportしているため、循環import防止のため
 * Store自体はimportしない(必要な関数は呼び出し側から引数として渡す)。
 */

import { getHolidaysInMonth } from "./holidays.js";
import { getCompanyHolidaysInMonthMap } from "./company-holidays.js";

// ── 文字列フォーマット ─────────────────────────────────
/** 新しいタグの既定の色。 */
export const DEFAULT_TAG_COLOR = "#2563eb";

export function pad2(n) {
  return String(n).padStart(2, "0");
}

export function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function formatYearMonth(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

export function formatDateJP(date) {
  return `${date.getFullYear()}年${pad2(date.getMonth() + 1)}月${pad2(date.getDate())}日`;
}

function formatNow(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

// 表の列などで桁数(2〜4桁)が変わっても右揃えの位置がずれないようにするHTML版。
// パディング文字をテキストに混ぜず、CSSの右揃えブロック(.durationNum)で桁を揃える。
export function formatDurationHtml(minutes) {
  const abs = Math.abs(Math.round(minutes));
  const hoursText = (abs / 60).toFixed(2);
  const minsText = String(abs);
  return `<span class="durationNum durationNumHours">${hoursText}</span>時間  （<span class="durationNum durationNumMins">${minsText}</span>分）`;
}

// 月次集計向けの「x時間y分」表記。月単位の合計は分の総量が
// 大きくなり「3175分」のような表記では直感的に把握できないため、
// 時間と分に分解して表示する。
function formatDurationHmHtml(minutes) {
  const abs = Math.abs(Math.round(minutes));
  const hours = Math.floor(abs / 60);
  const mins = abs % 60;
  return `<span class="durationNum durationNumHmHours">${hours}</span>時間<span class="durationNum durationNumHmMins">${mins}</span>分`;
}

// タグの月間予定工数(下限・上限)は時間単位で入力させているため、分は出さず
// 「X時間」のみにする(小数第2位までに丸めて統一する)。
function formatBudgetHours(minutes) {
  const hours = Math.round((minutes / 60) * 100) / 100;
  return `${hours}時間`;
}

// 残り/超過の表記(実績との差分)は「X時間Y分」で表示する。
function formatRemainHm(minutes) {
  const abs = Math.abs(Math.round(minutes));
  const hours = Math.floor(abs / 60);
  const mins = abs % 60;
  return `${hours}時間${mins}分`;
}

// サイドバー「月次集計（タグ別）」の行HTML。calendar/tasks/ai-modeで共用する。
// タグの月間予定工数は3パターン: 未設定/上限のみ/下限+上限(下限のみは無し)。
// 上限が設定されていれば進捗バー付きの行(下限もあれば線を1本重ねる)、
// 未設定ならシンプルな行になる。
// @param {Array<{id,name,color,budgetMinMinutes?,budgetMaxMinutes?}>} tags
// @param {Map<string, number>} byTag - タグID→当月実績(分)
export function renderTagBudgetRowsHtml(tags, byTag) {
  return tags
    .filter((t) => (byTag.get(t.id) ?? 0) > 0)
    .map((t) => {
      const mins = byTag.get(t.id) ?? 0;
      const nameHtml = `<span class="swatch" style="background:${escHtml(t.color)}"></span>${escHtml(t.name)}`;
      const max = Number.isFinite(t.budgetMaxMinutes) && t.budgetMaxMinutes > 0 ? t.budgetMaxMinutes : null;
      if (max == null) {
        return `<div class="tag" data-tag-id="${escHtml(t.id)}">
        <div class="name">${nameHtml}</div>
        <span class="small">${formatDurationHmHtml(mins)}</span>
      </div>`;
      }
      const min = Number.isFinite(t.budgetMinMinutes) && t.budgetMinMinutes > 0 && t.budgetMinMinutes < max
        ? t.budgetMinMinutes
        : null;
      const remain = max - mins;
      const isOver = remain < 0;
      const pct = Math.max(0, Math.min(100, Math.round((mins / max) * 100)));
      const barClass = isOver ? " over" : pct >= 80 ? " warn" : "";
      const remainText = isOver ? `超過 ${formatRemainHm(remain)}` : `残り ${formatRemainHm(remain)}`;
      const rangeText = min == null
        ? `上限: ${formatBudgetHours(max)}`
        : `下限: ${formatBudgetHours(min)}　上限: ${formatBudgetHours(max)}`;
      const minPct = min == null ? null : Math.max(0, Math.min(100, Math.round((min / max) * 100)));
      const minLineHtml = minPct == null ? "" : `<div class="tagBudgetMinLine" style="left:${minPct}%" title="下限: ${escHtml(formatBudgetHours(min))}"></div>`;
      return `<div class="tag tagBudgetRow" data-tag-id="${escHtml(t.id)}">
        <div class="tagBudgetHead">
          <div class="name">${nameHtml}</div>　<span class="tagBudgetUsed small">${formatDurationHmHtml(mins)}</span>
        </div>
        <div class="tagBudgetTrack">
          <div class="tagBudgetFill${barClass}" style="width:${pct}%"></div>
          ${minLineHtml}
        </div>
        <div class="tagBudgetFooter">
          <span class="tagBudgetRemain${barClass}">${escHtml(remainText)}</span>
          <span class="tagBudgetRange">${escHtml(rangeText)}</span>
        </div>
      </div>`;
    }).join("");
}

// サイドバー「日次集計(タグ別)」の行HTML。calendar/tasks/ai-modeで共用する
// (renderTagBudgetRowsHtmlの日次版)。
// @param {Array<{id,name,color}>} tags
// @param {Map<string, number>} byTag - タグID→当日実績(分)
export function renderDaySummaryRowsHtml(tags, byTag) {
  return tags
    .filter((t) => (byTag.get(t.id) ?? 0) > 0)
    .map((t) => {
      const mins = byTag.get(t.id) ?? 0;
      return `<div class="tag" data-tag-id="${escHtml(t.id)}">
        <div class="name"><span class="swatch" style="background:${escHtml(t.color)}"></span>${escHtml(t.name)}</div>
        <span class="small">${formatDurationHtml(mins)}</span>
      </div>`;
    }).join("");
}

function formatRemaining(minutes) {
  const abs = Math.abs(Math.round(minutes));
  const hoursDec = Math.round((abs / 60) * 100) / 100;
  const prefix = minutes < 0 ? "定時超過 +" : "";
  return `${prefix}${hoursDec.toFixed(2)}時間（${abs}分）`;
}

// ── 時刻変換 ───────────────────────────────────────────
export function timeToMinutes(hhmm) {
  if (!hhmm) return 0;
  if (hhmm === "24:00") return 1440;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function minutesToTime(minutes) {
  const clamped = Math.max(0, Math.min(1440, Math.round(minutes)));
  if (clamped === 1440) return "24:00";
  return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`;
}

// ── 日付ユーティリティ ────────────────────────────────
export function parseLocalDate(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function mondayOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - ((day + 6) % 7));
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

const VIEW_STATE_STORAGE_KEY = "tcplus_view_state";

function _normalizeViewDateKey(value) {
  const raw = String(value ?? "").trim();
  if (!_isDateKey(raw)) return "";
  const date = parseLocalDate(raw);
  if (Number.isNaN(date.getTime())) return "";
  return formatDateKey(date) === raw ? raw : "";
}

function _readStoredViewState() {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage?.getItem(VIEW_STATE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function _writeStoredViewState(nextState) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage?.setItem(VIEW_STATE_STORAGE_KEY, JSON.stringify(nextState));
  } catch {
    // ignore storage write errors
  }
}

function _updatePageDateQuery(dateKey) {
  if (typeof window === "undefined" || !_isDateKey(dateKey)) return;
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("date") === dateKey) return;
    url.searchParams.set("date", dateKey);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // ignore URL rewrite errors
  }
}

export function getInitialViewDate() {
  if (typeof window !== "undefined") {
    try {
      const params = new URLSearchParams(String(window.location?.search ?? ""));
      const queryDate = _normalizeViewDateKey(params.get("date"));
      if (queryDate) return parseLocalDate(queryDate);
    } catch {
      // ignore query parse errors
    }
  }

  const storedDate = _normalizeViewDateKey(_readStoredViewState().dateKey);
  if (storedDate) return parseLocalDate(storedDate);
  return new Date();
}

export function syncViewDate(dateLike) {
  const date = typeof dateLike === "string" ? parseLocalDate(dateLike) : new Date(dateLike);
  if (Number.isNaN(date.getTime())) return "";
  const dateKey = formatDateKey(date);
  _writeStoredViewState({ ..._readStoredViewState(), dateKey });
  _updatePageDateQuery(dateKey);
  return dateKey;
}

// ── ミニカレンダー ─────────────────────────────────────
const DOW_LABELS = ["日","月","火","水","木","金","土"];

/**
 * @param {HTMLElement} containerEl
 * @param {number} year
 * @param {number} month - 0始まり
 * @param {Map<string,string>} holidayMap
 * @param {(date: Date) => void} onDateSelect
 */
function buildMiniCalendarCells(containerEl, year, month, holidayMap, onDateSelect) {
  containerEl.innerHTML = "";
  const todayKey = formatDateKey(new Date());

  // 曜日ヘッダー
  DOW_LABELS.forEach((label, i) => {
    const el = document.createElement("div");
    el.className = "d dow" + (i === 0 ? " sun" : i === 6 ? " sat" : "");
    el.textContent = label;
    containerEl.appendChild(el);
  });

  const firstDow  = new Date(year, month, 1).getDay();
  const lastDate  = new Date(year, month + 1, 0).getDate();

  // 先頭の空白セル
  for (let i = 0; i < firstDow; i++) {
    const el = document.createElement("div");
    el.className = "d day" + (i === 0 ? " sun" : i === 6 ? " sat" : "");
    containerEl.appendChild(el);
  }

  // 日付セル
  for (let d = 1; d <= lastDate; d++) {
    const dateKey = `${year}-${pad2(month + 1)}-${pad2(d)}`;
    const dow = (firstDow + d - 1) % 7;
    const holidayName = holidayMap?.get(dateKey) ?? null;
    let cls = "d day";
    if (dow === 0) cls += " sun";
    if (dow === 6) cls += " sat";
    if (holidayName) cls += " holiday";
    if (dateKey === todayKey) cls += " today";

    const el = document.createElement("div");
    el.className = cls;
    el.setAttribute("data-date", dateKey);
    el.style.cursor = "pointer";
    if (holidayName) el.title = holidayName;
    el.textContent = String(d);
    el.addEventListener("click", () => onDateSelect(parseLocalDate(dateKey)));
    containerEl.appendChild(el);
  }

  // 末尾の空白セル
  const total = Math.ceil((firstDow + lastDate) / 7) * 7;
  for (let i = firstDow + lastDate; i < total; i++) {
    const dow = i % 7;
    const el = document.createElement("div");
    el.className = "d day" + (dow === 0 ? " sun" : dow === 6 ? " sat" : "");
    containerEl.appendChild(el);
  }
}

// 同じアプリ内の3タブで、ミニカレンダーの開閉状態を共有する。
let miniCalendarExpanded = true;
const miniCalendarDisclosures = new Map();

function setMiniCalendarExpanded(expanded) {
  miniCalendarExpanded = expanded;
  miniCalendarDisclosures.forEach(update => update());
}

function wireMiniCalendarDisclosure(containerEl, toggle) {
  const body = containerEl.closest('[data-mini-calendar-body]');
  if (!toggle || !body || miniCalendarDisclosures.has(toggle)) return;
  if (!body.id) body.id = `mini-calendar-body-${miniCalendarDisclosures.size + 1}`;
  toggle.setAttribute('aria-controls', body.id);
  const render = () => {
    body.hidden = !miniCalendarExpanded;
    toggle.textContent = miniCalendarExpanded ? '▼' : '▶';
    toggle.setAttribute('aria-expanded', String(miniCalendarExpanded));
    const label = miniCalendarExpanded ? 'ミニカレンダーを折りたたむ' : 'ミニカレンダーを表示';
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  };
  miniCalendarDisclosures.set(toggle, render);
  toggle.addEventListener('click', () => {
    setMiniCalendarExpanded(!miniCalendarExpanded);
  });
  render();
}

/**
 * ミニカレンダーを初期化し、操作オブジェクトを返す。
 */
export function setupMiniCalendar({ containerEl, monthLabelEl, prevBtn, nextBtn, collapseBtn, onDateSelect, initialDate, getHolidaysInMonth: getHols }) {
  if (!containerEl) return null;
  wireMiniCalendarDisclosure(containerEl, collapseBtn);
  const calendarBody = containerEl.closest('[data-mini-calendar-body]');
  if (calendarBody?.id) monthLabelEl?.setAttribute('aria-controls', calendarBody.id);
  const init = initialDate ?? new Date();
  let calYear  = init.getFullYear();
  let calMonth = init.getMonth();
  let selectedDateKey = formatDateKey(init);
  let choosingMonth = false;
  let pickerYear = calYear;

  function highlightSelectedDate() {
    containerEl.querySelectorAll('[data-date]').forEach(el => {
      el.classList.toggle('selected', el.dataset.date === selectedDateKey);
    });
  }

  function renderMonth() {
    // 日付一覧の高さを引き継ぎ、月の選択画面へ切り替えても集計欄を動かさない。
    if (choosingMonth && !containerEl.classList.contains('monthPicker')) {
      const height = containerEl.getBoundingClientRect().height;
      if (height > 0) containerEl.style.setProperty('--mini-calendar-grid-height', `${height}px`);
    }
    containerEl.classList.toggle('monthPicker', choosingMonth);
    containerEl.setAttribute('aria-label', choosingMonth ? `${pickerYear}年の月を選択` : 'ミニカレンダー');
    if (choosingMonth) {
      containerEl.replaceChildren();
      for (let month = 0; month < 12; month++) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'miniMonth';
        button.dataset.miniMonth = String(month);
        button.textContent = `${month + 1}月`;
        button.setAttribute('aria-label', `${pickerYear}年${month + 1}月`);
        button.setAttribute('aria-pressed', String(pickerYear === calYear && month === calMonth));
        button.addEventListener('click', () => {
          calYear = pickerYear;
          calMonth = month;
          choosingMonth = false;
          renderMonth();
          monthLabelEl?.focus({ preventScroll: true });
        });
        containerEl.appendChild(button);
      }
    } else {
      const hols = getHols ? getHols(calYear, calMonth) : new Map();
      buildMiniCalendarCells(containerEl, calYear, calMonth, hols, onDateSelect);
      highlightSelectedDate();
    }
    if (monthLabelEl) {
      monthLabelEl.textContent = choosingMonth ? `${pickerYear}年` : `${calYear}年${calMonth + 1}月`;
      monthLabelEl.dataset.yearmonth = `${calYear}-${pad2(calMonth + 1)}`;
      monthLabelEl.setAttribute('aria-expanded', String(choosingMonth));
      monthLabelEl.title = choosingMonth ? '日付表示に戻る' : '月を選択';
    }
    prevBtn?.setAttribute('aria-label', choosingMonth ? '前の年' : '前の月');
    nextBtn?.setAttribute('aria-label', choosingMonth ? '次の年' : '次の月');
  }

  prevBtn?.addEventListener("click", () => {
    if (choosingMonth) { pickerYear--; }
    else if (calMonth === 0) { calMonth = 11; calYear--; } else { calMonth--; }
    renderMonth();
  });
  nextBtn?.addEventListener("click", () => {
    if (choosingMonth) { pickerYear++; }
    else if (calMonth === 11) { calMonth = 0; calYear++; } else { calMonth++; }
    renderMonth();
  });

  monthLabelEl?.addEventListener('click', () => {
    choosingMonth = miniCalendarExpanded ? !choosingMonth : true;
    pickerYear = calYear;
    setMiniCalendarExpanded(true);
    renderMonth();
    if (choosingMonth) containerEl.querySelector(`[data-mini-month="${calMonth}"]`)?.focus({ preventScroll: true });
  });

  (containerEl.closest('.miniCalSticky') ?? containerEl).addEventListener('keydown', event => {
    if (!choosingMonth) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      choosingMonth = false;
      renderMonth();
      monthLabelEl?.focus({ preventScroll: true });
      return;
    }
    const month = event.target.closest?.('[data-mini-month]');
    if (!month) return;
    const index = Number(month.dataset.miniMonth);
    const target = { ArrowLeft: index - 1, ArrowRight: index + 1, ArrowUp: index - 4, ArrowDown: index + 4, Home: 0, End: 11 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    containerEl.querySelector(`[data-mini-month="${Math.max(0, Math.min(11, target))}"]`)?.focus({ preventScroll: true });
  });

  renderMonth();

  return {
    highlightDate(dateKey) {
      selectedDateKey = dateKey;
      if (!choosingMonth) highlightSelectedDate();
    },
    navigateToMonth(year, month) {
      if (calYear === year && calMonth === month && !choosingMonth) return;
      choosingMonth = false;
      calYear = year; calMonth = month;
      renderMonth();
    },
    refresh() { renderMonth(); },
  };
}

// ── カスタム時刻ピッカー ──────────────────────────────
// ダイアログ内で使うシングルトンのドロップダウンパネル
let _tpPopup = null;
let _tpActiveInput = null;
const TIME_PICKER_STEP_MINUTES = 15;

function _buildTpPopup() {
  const pop = document.createElement("div");
  pop.className = "timePicker";
  for (let m = 0; m <= 1440; m += TIME_PICKER_STEP_MINUTES) {
    const label = m === 1440 ? "24:00"
      : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "timePickerItem";
    btn.textContent = label;
    btn.dataset.value = label;
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault(); // blur を防いで値をセット
      if (_tpActiveInput) {
        _tpActiveInput.value = label;
        _tpActiveInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      _hideTp();
    });
    pop.appendChild(btn);
  }
  return pop;
}

function _hideTp() {
  if (!_tpPopup) return;
  _tpPopup.style.display = "none";
  _tpActiveInput = null;
}

function _showTp(input) {
  if (!_tpPopup) _tpPopup = _buildTpPopup();
  _tpActiveInput = input;

  // ダイアログ内に append（top-layer 対応）
  const container = input.closest("dialog") ?? document.body;
  container.appendChild(_tpPopup);

  // 位置決め（コンテナ相対）
  const cRect = container.getBoundingClientRect();
  const iRect = input.getBoundingClientRect();
  _tpPopup.style.left  = `${iRect.left - cRect.left}px`;
  _tpPopup.style.top   = `${iRect.bottom - cRect.top + 3}px`;
  _tpPopup.style.width = `${Math.max(iRect.width, 88)}px`;
  _tpPopup.style.display = "flex";

  // 現在値をハイライトして中央付近にスクロール
  const cur = input.value.trim();
  let hitEl = null;
  _tpPopup.querySelectorAll(".timePickerItem").forEach((btn) => {
    const hit = btn.dataset.value === cur;
    btn.classList.toggle("active", hit);
    if (hit) hitEl = btn;
  });
  requestAnimationFrame(() => {
    if (hitEl) hitEl.scrollIntoView({ block: "center" });
    else _tpPopup.scrollTop = 0;
  });
}

// ドキュメント全体の mousedown でパネル外クリックを閉じる
document.addEventListener("mousedown", (e) => {
  if (_tpPopup && _tpPopup.style.display !== "none" &&
      !_tpPopup.contains(e.target) && e.target !== _tpActiveInput) {
    _hideTp();
  }
});

// 開始/終了時刻を1分単位で微調整できるようにする
// (キーボードの上下矢印、および入力欄右端に重ねた小さな上下ボタン)。
function _stepTimeInput(input, deltaMinutes) {
  const cur = timeToMinutes(input.value.trim());
  const next = minutesToTime(cur + deltaMinutes);
  input.value = next;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function _wireTimeStepper(input) {
  const wrap = document.createElement("span");
  wrap.className = "timeStepperWrap";
  input.replaceWith(wrap);
  wrap.appendChild(input);

  const btns = document.createElement("span");
  btns.className = "timeStepperBtns";

  const upBtn = document.createElement("button");
  upBtn.type = "button";
  upBtn.className = "timeStepperBtn";
  upBtn.textContent = "▲";
  upBtn.tabIndex = -1;
  upBtn.setAttribute("aria-label", "1分進める");
  upBtn.addEventListener("mousedown", (e) => e.preventDefault()); // input の blur を防ぐ
  upBtn.addEventListener("click", () => _stepTimeInput(input, 1));

  const downBtn = document.createElement("button");
  downBtn.type = "button";
  downBtn.className = "timeStepperBtn";
  downBtn.textContent = "▼";
  downBtn.tabIndex = -1;
  downBtn.setAttribute("aria-label", "1分戻す");
  downBtn.addEventListener("mousedown", (e) => e.preventDefault());
  downBtn.addEventListener("click", () => _stepTimeInput(input, -1));

  btns.append(upBtn, downBtn);
  wrap.appendChild(btns);

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") { e.preventDefault(); _stepTimeInput(input, 1); }
    else if (e.key === "ArrowDown") { e.preventDefault(); _stepTimeInput(input, -1); }
  });
}

/**
 * 時刻入力欄にカスタムピッカーをアタッチする。
 * HTML 側で input[data-time-picker] に付与し、_wireDialog() から呼ぶ。
 */
export function setupTimePicker(input) {
  if (input._tpBound) return;
  input._tpBound = true;
  input.removeAttribute("list");         // datalist を無効化
  input.setAttribute("autocomplete", "off");
  input.addEventListener("focus", () => _showTp(input));
  input.addEventListener("blur",  () => setTimeout(() => {
    if (_tpActiveInput === input) _hideTp();
  }, 160));
  _wireTimeStepper(input);
}

// ── タスクダイアログ ──────────────────────────────────
/**
 * ダイアログのタグボタングループにボタンを設定する。
 * containerEl は [data-btn-group="tag"] の div。
 */
function populateTagOptions(containerEl, tags, selectedTagId) {
  if (!containerEl) return;
  const hiddenInput = containerEl.parentElement?.querySelector("[name='tag']");
  const selected = String(selectedTagId ?? "");
  containerEl.innerHTML = "";

  const _activate = (btn) => {
    containerEl.querySelectorAll(".btnGroupItem").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    if (hiddenInput) hiddenInput.value = btn.dataset.value;
  };

  // 「タグなし」ボタン
  const noneBtn = document.createElement("button");
  noneBtn.type = "button";
  noneBtn.className = "btnGroupItem" + (!selected ? " active" : "");
  noneBtn.dataset.value = "";
  noneBtn.textContent = "タグなし";
  noneBtn.addEventListener("click", () => _activate(noneBtn));
  containerEl.appendChild(noneBtn);

  (tags ?? []).forEach((t) => {
    const val = String(t.id ?? "");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btnGroupItem" + (val === selected ? " active" : "");
    btn.dataset.value = val;
    if (t.color) {
      const swatch = document.createElement("span");
      swatch.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${t.color};flex-shrink:0;`;
      btn.appendChild(swatch);
    }
    btn.appendChild(document.createTextNode(String(t.name ?? "")));
    btn.addEventListener("click", () => _activate(btn));
    containerEl.appendChild(btn);
  });

  // 初期値を hidden input にも反映
  if (hiddenInput) {
    const valid = selected && (tags ?? []).some((t) => String(t.id ?? "") === selected);
    hiddenInput.value = valid ? selected : "";
  }
}

function _syncApplySeriesControl(dialog, { isEdit = false, recurrenceType = "none" } = {}) {
  const row = dialog.querySelector("[data-edit-scope-row]");
  const sel = dialog.querySelector("[name='editScope']");
  if (!row || !sel) return;
  const canApplySeries = isEdit && recurrenceType !== "none";
  row.hidden = !canApplySeries;
  sel.disabled = !canApplySeries;
  if (!canApplySeries) sel.value = "single";
}

export function _isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""));
}

export function _normalizeDateKey(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  let y;
  let m;
  let d;
  let hit = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (hit) {
    y = Number(hit[1]);
    m = Number(hit[2]);
    d = Number(hit[3]);
  } else {
    hit = raw.match(/^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})$/);
    if (!hit) return "";
    y = Number(hit[1]);
    m = Number(hit[2]);
    d = Number(hit[3]);
  }

  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return "";
  if (m < 1 || m > 12 || d < 1 || d > 31) return "";
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return "";

  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function _nextRecurrenceDateKey(dateKey, recurrenceType) {
  const normalizedDateKey = _normalizeDateKey(dateKey);
  if (!_isDateKey(normalizedDateKey)) return formatDateKey(new Date());
  const base = parseLocalDate(normalizedDateKey);
  if (Number.isNaN(base.getTime())) return dateKey;

  const next = new Date(base);
  if (recurrenceType === "daily") {
    next.setDate(next.getDate() + 1);
    return formatDateKey(next);
  }
  if (recurrenceType === "weekly") {
    next.setDate(next.getDate() + 7);
    return formatDateKey(next);
  }
  if (recurrenceType === "monthly") {
    const day = next.getDate();
    next.setDate(1);
    next.setMonth(next.getMonth() + 1);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, lastDay));
    return formatDateKey(next);
  }
  return dateKey;
}

function _normalizeRepeatUntilValue({ dateKey, recurrenceType, untilValue }) {
  if (recurrenceType === "none") return "";
  const normalizedDateKey = _normalizeDateKey(dateKey) || formatDateKey(new Date());
  const minUntil = _nextRecurrenceDateKey(normalizedDateKey, recurrenceType);
  const normalizedUntil = _normalizeDateKey(untilValue);
  if (!_isDateKey(normalizedUntil)) return minUntil;
  return normalizedUntil < minUntil ? minUntil : normalizedUntil;
}

function _setRecurrenceBtn(dialog, value) {
  const container = dialog.querySelector("[data-btn-group='repeat']");
  const hidden = dialog.querySelector("[name='repeat']");
  if (container) {
    container.querySelectorAll(".btnGroupItem").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.value === value);
    });
  }
  if (hidden) hidden.value = value ?? "none";
}

function _wireRecurrenceControls(dialog) {
  const recContainer = dialog.querySelector("[data-btn-group='repeat']");
  if (!recContainer || recContainer.dataset.boundRecurrence === "1") return;
  recContainer.dataset.boundRecurrence = "1";

  recContainer.querySelectorAll(".btnGroupItem").forEach((btn) => {
    btn.addEventListener("click", () => {
      _setRecurrenceBtn(dialog, btn.dataset.value);
      _syncRecurrenceControls(dialog);
      _syncApplySeriesControl(dialog, {
        isEdit: dialog.hasAttribute("data-edit-id"),
        recurrenceType: btn.dataset.value,
      });
    });
  });

  const dateEl = dialog.querySelector("[name='date']");
  if (dateEl && dateEl.dataset.boundRecurrenceDate !== "1") {
    dateEl.dataset.boundRecurrenceDate = "1";
    dateEl.addEventListener("change", () => {
      const val = dialog.querySelector("[name='repeat']")?.value ?? "none";
      if (val !== "none") _syncRecurrenceControls(dialog);
    });
  }
}

function _syncRecurrenceControls(dialog) {
  const recSel = dialog.querySelector("[name='repeat']");
  const periodRow = dialog.querySelector("[data-repeat-period-row]");
  const untilEl = dialog.querySelector("[name='repeatUntil']");
  if (!recSel || !periodRow || !untilEl) return;

  const enabled = recSel.value !== "none";
  periodRow.hidden = !enabled;
  untilEl.disabled = !enabled;
  if (!enabled) {
    untilEl.removeAttribute("min");
    return;
  }

  const dateKey = _normalizeDateKey(dialog.querySelector("[name='date']")?.value) || formatDateKey(new Date());
  const minUntil = _nextRecurrenceDateKey(dateKey, recSel.value);
  untilEl.min = minUntil;
  untilEl.value = _normalizeRepeatUntilValue({
    dateKey,
    recurrenceType: recSel.value,
    untilValue: untilEl.value,
  });
}

// タスク編集ダイアログのタグ選択肢。月ごとにタグを明示設定する前提のため、その月に
// 設定がなければ空になる。ただし既存タスクの現在のタグが月設定から外れていても、編集時に
// 見えなくなって保存時に消えてしまわないよう、currentTagIdは常に候補へ残す。
// calendar.js/tasks.jsで共用する。getFallbackDateは
// dateKeyが空のときの基準日を返すコールバック(calendar=_viewDate、tasks=_selectedDate)。
export async function updateTaskByChoice(Store, taskId, patch, mode = "single") {
  const updated = await Store.updateTaskWithMode(taskId, patch, mode);
  return Boolean(updated);
}

export function getDialogTagsForDateKey(Store, dateKey, currentTagId, getFallbackDate) {
  const date = parseLocalDate(dateKey || formatDateKey(getFallbackDate()));
  const tags = Store.getTagsForMonth(formatYearMonth(date));
  const tagId = String(currentTagId ?? "");
  if (tagId && !tags.some((t) => t.id === tagId)) {
    const existing = Store.getAllTags().find((t) => t.id === tagId);
    if (existing) return [...tags, existing];
  }
  return tags;
}

/**
 * ダイアログを「新規作成」モードで開く。
 * @param {HTMLDialogElement} dialog
 * @param {{ startTime?: string, endTime?: string, date?: string, tags: Array }} opts
 */
export function openCreateDialog(dialog, opts = {}) {
  const titleEl = dialog.querySelector("[data-dialog-title]");
  if (titleEl) titleEl.textContent = opts.dialogTitle ?? "新しいタスクを追加";

  dialog.querySelector("[name='title']").value     = "";
  dialog.querySelector("[name='startTime']").value = opts.startTime ?? "09:00";
  dialog.querySelector("[name='endTime']").value   = opts.endTime   ?? "10:00";
  dialog.querySelector("[name='allDay']").checked  = Boolean(opts.isAllDay);
  dialog.querySelector("[name='memo']").value      = "";
  if (dialog.querySelector("[name='date']")) {
    dialog.querySelector("[name='date']").value = opts.date ?? formatDateKey(new Date());
  }
  const tagContainer = dialog.querySelector("[data-btn-group='tag']");
  if (tagContainer) {
    populateTagOptions(tagContainer, opts.tags ?? [], "");
  }
  _setRecurrenceBtn(dialog, "none");
  const untilEl = dialog.querySelector("[name='repeatUntil']");
  if (untilEl) untilEl.value = opts.repeatUntil ?? (opts.date ?? formatDateKey(new Date()));

  dialog.removeAttribute("data-edit-id");
  _wireRecurrenceControls(dialog);
  _syncRecurrenceControls(dialog);
  _syncApplySeriesControl(dialog, { isEdit: false, recurrenceType: "none" });

  dialog.showModal();
  if (opts.focusTitle) {
    requestAnimationFrame(() => dialog.querySelector("[name='title']")?.focus());
  }
}

/**
 * ダイアログを「編集」モードで開く。
 */
export function openEditDialog(dialog, task, tags) {
  const titleEl = dialog.querySelector("[data-dialog-title]");
  if (titleEl) titleEl.textContent = "タスクを編集";

  dialog.querySelector("[name='title']").value     = task.title     ?? "";
  dialog.querySelector("[name='startTime']").value = task.startTime ?? "09:00";
  dialog.querySelector("[name='endTime']").value   = task.endTime   ?? "10:00";
  dialog.querySelector("[name='allDay']").checked  = Boolean(task.isAllDay);
  dialog.querySelector("[name='memo']").value      = task.memo      ?? "";
  if (dialog.querySelector("[name='date']")) {
    dialog.querySelector("[name='date']").value = task.date ?? formatDateKey(new Date());
  }
  const tagContainer = dialog.querySelector("[data-btn-group='tag']");
  if (tagContainer) {
    populateTagOptions(tagContainer, tags ?? [], task.tagId);
  }
  _setRecurrenceBtn(dialog, task.recurrence?.type ?? "none");
  const untilEl = dialog.querySelector("[name='repeatUntil']");
  if (untilEl) untilEl.value = task.recurrence?.until ?? task.date ?? formatDateKey(new Date());

  _wireRecurrenceControls(dialog);
  _syncRecurrenceControls(dialog);
  _syncApplySeriesControl(dialog, {
    isEdit: true,
    recurrenceType: task.recurrence?.type ?? "none",
  });

  dialog.setAttribute("data-edit-id", task.id);
  dialog.showModal();
  requestAnimationFrame(() => dialog.querySelector("[name='title']")?.focus());
}

/**
 * ダイアログのフォーム値を読み出す。
 */
export function readDialogForm(dialog) {
  const recurrenceType = dialog.querySelector("[name='repeat']")?.value ?? "none";
  const date = _normalizeDateKey(dialog.querySelector("[name='date']")?.value) || formatDateKey(new Date());
  const recurrence = recurrenceType === "none"
    ? { type: "none" }
    : {
      type: recurrenceType,
      until: _normalizeRepeatUntilValue({
        dateKey: date,
        recurrenceType,
        untilValue: dialog.querySelector("[name='repeatUntil']")?.value || "",
      }),
    };

  return {
    title:    (dialog.querySelector("[name='title']")?.value     ?? "").trim(),
    startTime: dialog.querySelector("[name='startTime']")?.value ?? "09:00",
    endTime:   dialog.querySelector("[name='endTime']")?.value   ?? "10:00",
    isAllDay:  dialog.querySelector("[name='allDay']")?.checked  ?? false,
    tagId:     dialog.querySelector("[name='tag']")?.value       ?? "",
    recurrence,
    // 編集範囲(この予定のみ/今日以降すべて/繰り返し予定すべて)。
    editScope: dialog.querySelector("[name='editScope']")?.value || "single",
    memo:      (dialog.querySelector("[name='memo']")?.value     ?? "").trim(),
    date,
  };
}

// ── ヘッダー時計 ──────────────────────────────────────
export function startHeaderClock({ workEnd = "18:00" } = {}) {
  const nowEl    = document.querySelector("[data-now]");
  const remEl    = document.querySelector("[data-remaining]");
  const dateEl   = document.querySelector("[data-today-date]");
  if (!nowEl || !remEl) return;

  let lastMinKey = "";

  function tick() {
    const now = new Date();
    nowEl.textContent = formatNow(now);
    if (dateEl) dateEl.textContent = formatDateJP(now);

    const minKey = `${formatDateKey(now)}-${now.getHours()}-${now.getMinutes()}`;
    if (minKey !== lastMinKey) {
      const endMinutes = timeToMinutes(workEnd);
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const diff = Math.round(endMinutes - nowMinutes);
      remEl.textContent = formatRemaining(diff);
      lastMinKey = minKey;
    }
  }

  tick();
  setInterval(tick, 1000);
}

export function normalizeUrlAutoOpenTimes(value) {
  const rawList = Array.isArray(value)
    ? value
    : String(value ?? "").split(/[\s,、]+/);
  const seen = new Set();
  const normalized = [];

  rawList.forEach((raw) => {
    const token = String(raw ?? "").trim();
    if (!token) return;
    const hit = token.match(/^(\d{1,2}):(\d{1,2})$/);
    if (!hit) return;
    const hh = Number(hit[1]);
    const mm = Number(hit[2]);
    if (!Number.isInteger(hh) || !Number.isInteger(mm)) return;
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return;
    const hhmm = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    if (seen.has(hhmm)) return;
    seen.add(hhmm);
    normalized.push(hhmm);
  });

  normalized.sort((a, b) => timeToMinutes(a) - timeToMinutes(b));
  return normalized;
}

function mergeHolidayName(primary, secondary) {
  const base = String(primary ?? "").trim();
  const extra = String(secondary ?? "").trim();
  if (!base) return extra;
  if (!extra || base === extra) return base;
  if (base.includes(extra)) return base;
  return `${base} / ${extra}`;
}

/**
 * 祝日(算出方式)と会社休日(settings.companyHolidayEntries等)をマージして返す。
 */
export function getCombinedHolidaysInMonth(year, month, settings) {
  const merged = new Map(getHolidaysInMonth(year, month));
  const companyMap = getCompanyHolidaysInMonthMap(
    year,
    month,
    settings?.companyHolidayEntries,
  );
  companyMap.forEach((name, dateKey) => {
    merged.set(dateKey, mergeHolidayName(merged.get(dateKey), name));
  });
  return merged;
}

// ── 休憩時間帯(複数対応、F-WORK-BREAKS) ─────────────────
/**
 * 保存済み設定値からbreaksの配列を正規化する。開始<終了でないものは除外する。
 */
export function normalizeBreaks(value) {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((b) => ({
      start: String(b?.start ?? "").trim(),
      end: String(b?.end ?? "").trim(),
      // 工数計算に含めるか(既定false=工数計算から除外する)。
      countAsWork: Boolean(b?.countAsWork),
    }))
    .filter((b) => b.start && b.end && timeToMinutes(b.end) > timeToMinutes(b.start));
}

export function normalizeHexColor(value, fallback = DEFAULT_TAG_COLOR) {
  const raw = String(value ?? "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase();
  }
  return fallback.toLowerCase();
}

// ── 3画面(カレンダー・タスク一覧・AIモード)で共通の部品 ─────────────

/** サイドバーの開閉ボタン(「◀ サイド」「▶ サイド」)。 */
export function wireSidebarToggle(root) {
  root.querySelector("[data-sidebar-toggle]")?.addEventListener("click", (e) => {
    const layout = root.querySelector(".layout");
    const btn = e.currentTarget;
    if (!layout || !(btn instanceof HTMLButtonElement)) return;
    const collapsed = layout.classList.toggle("sidebar-collapsed");
    btn.textContent = collapsed ? "▶ サイド" : "◀ サイド";
    btn.title = collapsed ? "サイドバーを開く" : "サイドバーを折りたたむ";
  });
}

/**
 * サイドバーの月次・日次のタグ別集計を描画する。その月のタグ順が未設定だと
 * getTagsForMonth は空配列を返すため、そのときは全タグで集計する。
 * @param {{monthEl?: Element, dayEl?: Element, Store: object, dateKey: string, emptyText?: {month: string, day: string}}} opts
 */
export function renderSideSummaries({ monthEl, dayEl, Store, dateKey, emptyText = {
  month: "この月の集計データはまだありません。",
  day: "この日の集計データはまだありません。",
} }) {
  const yearMonth = String(dateKey).slice(0, 7);
  const monthTags = Store.getTagsForMonth(yearMonth);
  const tags = monthTags.length > 0 ? monthTags : Store.getAllTags();
  if (monthEl) {
    const html = renderTagBudgetRowsHtml(tags, Store.calcMonthSummary(yearMonth).byTag);
    monthEl.innerHTML = html || (emptyText ? `<div class="small">${escHtml(emptyText.month)}</div>` : "");
  }
  if (dayEl) {
    const html = renderDaySummaryRowsHtml(tags, Store.calcDaySummary(dateKey).byTag);
    dayEl.innerHTML = html || (emptyText ? `<div class="small">${escHtml(emptyText.day)}</div>` : "");
  }
}

let _monthTagPopupEl = null;

function _hideMonthTagPopup() {
  if (_monthTagPopupEl) _monthTagPopupEl.hidden = true;
}

function _openMonthTagPopup(Store, yearMonth, clientX, clientY) {
  if (!_monthTagPopupEl) {
    const pop = document.createElement("div");
    pop.className = "taskTagContextMenu";
    pop.hidden = true;
    document.body.appendChild(pop);
    _monthTagPopupEl = pop;
    document.addEventListener("pointerdown", (e) => {
      if (!_monthTagPopupEl || _monthTagPopupEl.hidden) return;
      if (_monthTagPopupEl.contains(e.target)) return;
      _hideMonthTagPopup();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") _hideMonthTagPopup(); });
  }
  const tags = Store.getTagsForMonth(yearMonth);
  const popup = _monthTagPopupEl;
  popup.innerHTML = "";

  const title = document.createElement("div");
  title.className = "taskTagContextTitle";
  const [y, m] = yearMonth.split("-");
  title.textContent = `${y}年${Number(m)}月のタグ`;
  popup.appendChild(title);

  const sep = document.createElement("div");
  sep.className = "taskTagContextSeparator";
  popup.appendChild(sep);

  if (tags.length === 0) {
    const empty = document.createElement("div");
    empty.className = "taskTagContextTitle";
    empty.style.paddingTop = "6px";
    empty.textContent = "この月にタグはありません";
    popup.appendChild(empty);
  } else {
    tags.forEach((tag) => {
      const item = document.createElement("div");
      item.className = "taskTagContextItem";
      item.style.cssText = "display:flex;align-items:center;gap:8px;cursor:default;";
      const swatch = document.createElement("span");
      swatch.style.cssText = `display:inline-block;width:10px;height:10px;border-radius:50%;background:${tag.color ?? "#888"};flex-shrink:0;`;
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(tag.name ?? ""));
      popup.appendChild(item);
    });
  }

  popup.hidden = false;
  const pw = popup.offsetWidth || 200;
  const ph = popup.offsetHeight || 100;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = clientX;
  let top = clientY;
  if (left + pw > vw - 8) left = vw - pw - 8;
  if (top + ph > vh - 8) top = vh - ph - 8;
  popup.style.left = `${Math.max(8, left)}px`;
  popup.style.top = `${Math.max(8, top)}px`;
}

/** ミニカレンダーの月見出しを右クリックすると、その月のタグ一覧を表示する。 */
export function wireMonthTagPopup(monthLabelEl, Store) {
  if (!monthLabelEl) return;
  monthLabelEl.style.cursor = "context-menu";
  monthLabelEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const yearMonth = monthLabelEl.dataset.yearmonth;
    if (yearMonth) _openMonthTagPopup(Store, yearMonth, e.clientX, e.clientY);
  });
}

let _taskTagMenuEl = null;

/** 予定のタグ変更メニュー(右クリック)を閉じる。 */
export function hideTaskTagMenu() {
  if (_taskTagMenuEl) _taskTagMenuEl.hidden = true;
}

/** 予定のタグ変更メニューの要素(画面共通の1つ)を返す。初回だけ作成し、外側クリック・スクロール・Escで閉じる。 */
export function ensureTaskTagMenu() {
  if (_taskTagMenuEl) return _taskTagMenuEl;
  const menu = document.createElement("div");
  menu.className = "taskTagContextMenu";
  menu.hidden = true;
  document.body.appendChild(menu);
  _taskTagMenuEl = menu;

  document.addEventListener("pointerdown", (e) => {
    if (!_taskTagMenuEl || _taskTagMenuEl.hidden) return;
    if (_taskTagMenuEl.contains(e.target)) return;
    hideTaskTagMenu();
  });
  document.addEventListener("scroll", hideTaskTagMenu, true);
  window.addEventListener("resize", hideTaskTagMenu);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTaskTagMenu();
  });

  return menu;
}
