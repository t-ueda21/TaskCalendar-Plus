/**
 * calendar.js — カレンダーページのロジック
 *
 * 要件カバー:
 *   F-CAL-001〜009, F-TASK-001〜010 (drag-selection / create / DnD-move / resize / double-click edit / copy-paste)
 *   F-EXT-001, F-EXT-002 (祝日表示)
 *   F-WH-001〜003 (日次/月次集計サイドバー表示)
 */

import * as Store from "./store.js";
import { buildUiPalette } from "./ui-colors.js";
import {
  pad2,
  escHtml,
  formatDateKey,
  formatYearMonth,
  formatDateJP,
  timeToMinutes,
  minutesToTime,
  mondayOfWeek,
  addDays,
  setupMiniCalendar,
  getInitialViewDate,
  syncViewDate,
  openCreateDialog,
  openEditDialog,
  readDialogForm,
  getDialogTagsForDateKey,
  updateTaskByChoice,
  setupTimePicker,
  normalizeBreaks,
  getCombinedHolidaysInMonth,
  normalizeHexColor,
  DEFAULT_TAG_COLOR,
  wireSidebarToggle,
  renderSideSummaries,
  wireMonthTagPopup,
  ensureTaskTagMenu,
  hideTaskTagMenu,
} from "./ui-utils.js";
import { renderTimeGrid, positionTaskBlock, ROW_HEIGHT, updateNowLine } from "./time-grid.js";
import { wireSettingsDialog, wireSideTagClickToSettings } from "./settings-dialog.js";
import {
  getWeatherByDate,
  getWeatherRange,
  formatWeatherForDisplay,
  getWeatherLocationOptions,
} from "./weather.js";

// ── 定数 ─────────────────────────────────────────────
const DEFAULT_TASK_COLOR = "#475569";
const DRAG_SELECTION_THRESHOLD_PX = 6;

function _hexToRgb(color) {
  const normalized = normalizeHexColor(color, DEFAULT_TASK_COLOR);
  const m = normalized.match(/^#([0-9a-f]{6})$/i);
  if (!m) return [71, 85, 105];
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function _mixWithWhite(value, ratio = 0.5) {
  return Math.round(value * (1 - ratio) + 255 * ratio);
}

function _readableTextColor(r, g, b) {
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? "#0f172a" : "#ffffff";
}

function _applyTagColorStyle(el, color, { allDay = false } = {}) {
  if (!el) return;
  const [r, g, b] = _hexToRgb(color);
  if (allDay) {
    const bgMix = 0.62;
    const bgR = _mixWithWhite(r, bgMix);
    const bgG = _mixWithWhite(g, bgMix);
    const bgB = _mixWithWhite(b, bgMix);
    el.style.background  = `rgb(${bgR}, ${bgG}, ${bgB})`;
    el.style.borderColor = `rgb(${r}, ${g}, ${b})`;
    el.style.color = _readableTextColor(bgR, bgG, bgB);
  } else {
    // 薄い色背景 + 左ボーダー（Outlook風）
    const bgR = _mixWithWhite(r, 0.80);
    const bgG = _mixWithWhite(g, 0.80);
    const bgB = _mixWithWhite(b, 0.80);
    el.style.background  = `rgb(${bgR}, ${bgG}, ${bgB})`;
    el.style.borderLeft  = `3px solid rgb(${r}, ${g}, ${b})`;
    el.style.color       = "#0f172a";
  }
}

// ── 状態 ─────────────────────────────────────────────
let _viewDate    = new Date();
let _viewMode    = "week";      // "day" | "week"
let _granularity = 30;
let _businessOnly = true;
let _miniCalInst  = null;
let _settings     = null;

// Copy-paste バッファ (F-TASK-005)
let _clipboard = null;
let _draggingTaskId = null;
let _dragCopyMode = false;
let _dragOffsetMins = 0; // ブロック内クリック位置の時間オフセット（分）
// WebView2では、ドラッグ中のdragover/dropイベントでe.ctrlKey/e.metaKeyが
// 常にfalseになる(修飾キー状態がDnD操作中は伝播しない)既知の挙動があり、
// Ctrl+D&Dによるコピーが常に「移動」として扱われてしまう。document全体の
// keydown/keyupで押下状態を別途追跡し、drag系イベントのe.ctrlKey/e.metaKeyが
// 効かない場合のフォールバックとして使う。
let _ctrlOrMetaPressed = false;
document.addEventListener("keydown", (e) => {
  if (e.key === "Control" || e.key === "Meta") _ctrlOrMetaPressed = true;
});
document.addEventListener("keyup", (e) => {
  if (e.key === "Control" || e.key === "Meta") _ctrlOrMetaPressed = false;
});

// ── Undo/Redo（タスク操作の取り消し・やり直し、F-TASK-006） ──────
// ドラッグ移動・リサイズ・タグ変更・貼り付け・削除・切り取りを対象とする。
// 繰り返し予定のダイアログ経由の一括作成・編集は対象外(複数行にまたがり
// 巻き戻しが複雑になるため)。
const _UNDO_LIMIT = 50;
let _undoStack = [];
let _redoStack = [];

function _recordAction(action) {
  _undoStack.push(action);
  if (_undoStack.length > _UNDO_LIMIT) _undoStack.shift();
  _redoStack = [];
}

function _forgetTaskHistory({ taskId }) {
  _undoStack = _undoStack.filter(action => action.taskId !== taskId);
  _redoStack = _redoStack.filter(action => action.taskId !== taskId);
}

async function _undoAction(action) {
  if (action.type === "create") {
    await Store.deleteTaskWithMode(action.taskId, "single");
  } else if (action.type === "delete") {
    const created = await Store.createTask({ ...action.task, id: undefined, recurrence: { type: "none" } });
    if (created) action.taskId = created.id;
  } else if (action.type === "update") {
    await Store.updateTask(action.taskId, action.before);
  }
}

async function _redoAction(action) {
  if (action.type === "create") {
    const created = await Store.createTask({ ...action.task, id: undefined, recurrence: { type: "none" } });
    if (created) action.taskId = created.id;
  } else if (action.type === "delete") {
    await Store.deleteTaskWithMode(action.taskId, "single");
  } else if (action.type === "update") {
    await Store.updateTask(action.taskId, action.after);
  }
}

async function _undo() {
  const action = _undoStack.pop();
  if (!action) return;
  await _undoAction(action);
  _redoStack.push(action);
}

async function _redo() {
  const action = _redoStack.pop();
  if (!action) return;
  await _redoAction(action);
  _undoStack.push(action);
}
let _taskTimePreviewEl = null;
let _focusedSlotEl = null;
let _focusedSlotSelectionEl = null;
let _weatherRenderToken = 0;

/**
 * 表示粒度グリッドの全点 + 業務時刻4点（始業・昼開始・昼終了・終業）をスナップ候補として返す。
 */
function _buildSnapCandidates() {
  const step = _granularity || 30;
  const candidates = new Set();
  for (let m = 0; m <= 1440; m += step) candidates.add(m);
  const boundaryTimes = [
    _settings?.workStart,
    _settings?.workEnd,
    ...normalizeBreaks(_settings?.breaks).flatMap((b) => [b.start, b.end]),
  ];
  boundaryTimes.forEach((t) => {
    const m = timeToMinutes(String(t ?? ""));
    if (Number.isFinite(m) && m >= 0 && m <= 1440) candidates.add(m);
  });
  return Array.from(candidates).sort((a, b) => a - b);
}

/**
 * 候補リストに対して最近傍スナップを行う。
 * mode="start": minutes 以下で最大の候補（切り捨て）
 * mode="end"  : minutes 以上で最小の候補（切り上げ）
 */
function _snapToNearest(minutes, candidates, mode) {
  if (!candidates.length) return minutes;
  if (mode === "start") {
    let best = candidates[0];
    for (const c of candidates) {
      if (c <= minutes) best = c; else break;
    }
    return best;
  }
  for (const c of candidates) {
    if (c >= minutes) return c;
  }
  return candidates[candidates.length - 1];
}

function _snapTaskMinutes(minutes, mode) {
  return _snapToNearest(minutes, _buildSnapCandidates(), mode);
}

function _minTaskDurationMinutes() {
  return _granularity || 30;
}

function _normalizeTaskDurationMinutes(minutes) {
  return Math.max(_minTaskDurationMinutes(), _snapTaskMinutes(minutes, "end"));
}

function _setFocusedSlotElement(slotEl) {
  if (_focusedSlotEl) _focusedSlotEl.classList.remove("focused");
  _focusedSlotSelectionEl?.remove();
  _focusedSlotSelectionEl = null;

  _focusedSlotEl = slotEl || null;
  if (_focusedSlotEl) {
    // 空スロット選択時は視覚ハイライトを表示しない。
    _root.querySelectorAll("[data-task-id].focused").forEach((el) => el.classList.remove("focused"));
  }
}

function _setFocusedTaskElement(block) {
  if (block) _setFocusedSlotElement(null);
  _root.querySelectorAll("[data-task-id].focused").forEach((el) => el.classList.remove("focused"));
  if (block) block.classList.add("focused");
}

// 月ごとにタグを明示設定する前提のため、その月に設定がなければ空になる。
// ただし既存タスクの現在のタグが月設定から外れていても、編集時に見えなくなって
// 保存時に消えてしまわないよう、currentTagIdは常に候補へ残す。
function _getDialogTagsForDateKey(dateKey, currentTagId = "") {
  return getDialogTagsForDateKey(Store, dateKey, currentTagId, () => _viewDate);
}

// 繰り返し予定の削除範囲を選ばせる(Outlookの「これ以降の予定」相当)。1=このみ/2=すべて/3=今日以降すべて。
function _chooseDeleteModeForTask(task) {
  const count = Store.getTaskSeriesCount(task);
  if (count <= 1) return "single";
  const answer = window.prompt("削除方法: 1=選択した予定のみ / 2=繰り返し予定をすべて / 3=今日以降すべて", "1");
  if (answer == null) return null; // キャンセル
  const token = String(answer).trim();
  if (token === "") return null; // 空入力は誤削除防止のため中止
  if (token === "2" || /すべて|全て|全部|series/i.test(token)) return "series";
  if (token === "3" || /今日以降|future/i.test(token)) return "future";
  if (token === "1" || /これ|のみ|単一|single/i.test(token)) return "single";
  return null; // 想定外の入力は安全側で中止
}

async function _deleteTaskByChoice(taskId, preferredMode = null) {
  const task = Store.getAllTasks().find((t) => t.id === taskId);
  if (!task) return;
  const mode = preferredMode ?? _chooseDeleteModeForTask(task);
  if (!mode) return;
  // 繰り返し全体(series)の削除はUndo対象外(複数行の巻き戻しが複雑なため)。
  // 単一予定の削除(single)のみUndo/Redoに対応する。
  if (mode === "single") {
    _recordAction({ type: "delete", taskId, task });
  }
  await Store.deleteTaskWithMode(taskId, mode);
}

function _ensureTaskTimePreview() {
  if (_taskTimePreviewEl) return _taskTimePreviewEl;
  const el = document.createElement("div");
  el.className = "taskDragPreview";
  el.hidden = true;
  document.body.appendChild(el);
  _taskTimePreviewEl = el;
  return el;
}

function _showTaskTimePreview(text, clientX, clientY) {
  const el = _ensureTaskTimePreview();
  const margin = 10;
  el.textContent = text;
  el.hidden = false;
  el.style.left = `${clientX + 12}px`;
  el.style.top = `${clientY + 12}px`;

  const rect = el.getBoundingClientRect();
  const left = Math.max(margin, Math.min(clientX + 12, window.innerWidth - rect.width - margin));
  const top = Math.max(margin, Math.min(clientY + 12, window.innerHeight - rect.height - margin));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function _hideTaskTimePreview() {
  if (_taskTimePreviewEl) _taskTimePreviewEl.hidden = true;
}

function _openTaskTagMenu(task, clientX, clientY, sourceEl = null) {
  const menu = ensureTaskTagMenu();
  if (!menu) return;

  _setFocusedTaskElement(sourceEl);

  const tags = _getDialogTagsForDateKey(task.date, task.tagId);
  const seriesCount = Store.getTaskSeriesCount(task);

  menu.innerHTML = "";

  const addActionItem = (label, onClick, { danger = false } = {}) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "taskTagContextItem";
    if (danger) btn.classList.add("danger");
    btn.textContent = label;
    btn.addEventListener("click", async () => {
      await onClick();
      hideTaskTagMenu();
    });
    menu.appendChild(btn);
  };

  addActionItem("編集", async () => {
    openEditDialog($dialog, task, _getDialogTagsForDateKey(task.date, task.tagId));
  });
  addActionItem("削除（この予定）", async () => {
    await _deleteTaskByChoice(task.id, "single");
  }, { danger: true });
  if (seriesCount > 1) {
    addActionItem(`削除（繰り返し全体: ${seriesCount}件）`, async () => {
      await _deleteTaskByChoice(task.id, "series");
    }, { danger: true });
  }

  const sep = document.createElement("div");
  sep.className = "taskTagContextSeparator";
  menu.appendChild(sep);

  const title = document.createElement("div");
  title.className = "taskTagContextTitle";
  title.textContent = "タグを選択";
  menu.appendChild(title);

  const addItem = (label, value, color = "", active = false) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "taskTagContextItem";
    if (active) btn.classList.add("active");
    btn.textContent = label;

    if (value) {
      const tagColor = normalizeHexColor(color, DEFAULT_TAG_COLOR);
      btn.style.background = tagColor;
      btn.style.border = `1px solid ${tagColor}`;
      btn.style.color = buildUiPalette(tagColor)["--on-accent"];
      if (active) {
        btn.style.outline = "2px solid rgba(255, 255, 255, 0.75)";
        btn.style.outlineOffset = "-2px";
        btn.style.fontWeight = "700";
      }
    }

    btn.addEventListener("click", () => {
      _recordAction({ type: "update", taskId: task.id, before: { tagId: task.tagId }, after: { tagId: value } });
      Store.updateTask(task.id, { tagId: value });
      hideTaskTagMenu();
    });
    menu.appendChild(btn);
  };

  addItem("タグなし", "", "", !task.tagId);
  tags.forEach((tag) => addItem(tag.name, tag.id, tag.color, tag.id === task.tagId));

  if (tags.length === 0) {
    const empty = document.createElement("div");
    empty.className = "taskTagContextEmpty";
    empty.textContent = "この月に利用できるタグがありません。";
    menu.appendChild(empty);
  }

  menu.hidden = false;
  menu.style.left = "0px";
  menu.style.top = "0px";

  const rect = menu.getBoundingClientRect();
  const margin = 8;
  const left = Math.max(margin, Math.min(clientX, window.innerWidth - rect.width - margin));
  const top = Math.max(margin, Math.min(clientY, window.innerHeight - rect.height - margin));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

// ── DOM refs（初期化後に取得） ─────────────────────────
let $viewModeSelect, $granularitySelect, $businessOnlyChk;
let $viewDateLabel;
let $shiftPrev, $shiftNext, $goToday;
let $dialog;
let $daycol, $daySlots, $dayTimes;
let $weekHeader, $weekAllDay, $weekBody, $weekTimes;
let $sideMonthSummary, $sideDaySummary;
let $calendarDayWeather;
let _settingsDialogControl;

// ── 初期化 ────────────────────────────────────────────
let _initialized = false;
let _root = null;
export function init(rootEl) {
  if (_initialized) return; // 二重初期化（購読・タイマー多重登録）を防ぐ
  _initialized = true;
  _root = rootEl;
  _settings     = Store.getSettings();
  _granularity  = _settings.granularity;
  _businessOnly = _settings.showBusinessDaysOnly;

  _cacheDOM();
  if ($granularitySelect) $granularitySelect.value = String(_granularity);
  if ($businessOnlyChk) $businessOnlyChk.checked = _businessOnly;
  ensureTaskTagMenu();
  _wireToolbar();
  _wireDialog();
  _wireSettingsButton();
  wireSideTagClickToSettings(_root, () => _settingsDialogControl);
  _wireMiniCalendar();
  _wireNewTaskButton();
  _wireCopyPaste();

  _renderTimeGrids();

  _wireCalendarSelection();
  _wireAllDayCreateTargets();
  _setViewDate(getInitialViewDate());
  _applyViewMode(_viewMode);

  // データ変更を購読してカレンダーを再描画
  Store.subscribe("task-series-expanded", _forgetTaskHistory);
  Store.subscribe("tasks", () => {
    _renderDayTasks();
    _renderWeekTasks();
    _renderSideSummary();
    _wireDragDropTargets();
  });
  Store.subscribe("tags", () => {
    _renderDayTasks();
    _renderWeekTasks();
  });
  Store.subscribe("settings", () => {
    _applySettingsSnapshot(Store.getSettings());
  });

  _wireDragDropTargets();
  setInterval(() => updateNowLine(_granularity, _viewMode), 30_000);
}

// SPAシェルでタブを再訪した際、他ビューでの日付選択をsessionStorage/URL
// クエリ経由で拾い直す(initは初回マウント時にしか呼ばれないため)。
export function activate() {
  _setViewDate(getInitialViewDate());
}

// ── DOM キャッシュ ─────────────────────────────────────
function _cacheDOM() {
  $viewModeSelect   = _root.querySelector("[data-viewmode]");
  $granularitySelect = _root.querySelector("[data-granularity]");
  $businessOnlyChk  = _root.querySelector("[data-businessdays-only]");
  $viewDateLabel    = _root.querySelector("[data-view-date]");
  $shiftPrev        = _root.querySelector("[data-shift-prev]");
  $shiftNext        = _root.querySelector("[data-shift-next]");
  $goToday          = _root.querySelector("[data-go-today]");
  $dialog           = _root.querySelector("[data-task-dialog]");
  $daycol           = _root.querySelector("[data-daycol]");
  $daySlots         = _root.querySelector("[data-slots='day']");
  $dayTimes         = _root.querySelector("[data-times='day']");
  $weekHeader       = _root.querySelector("[data-week-header]");
  $weekAllDay       = _root.querySelector("[data-week-allday]");
  $weekBody         = _root.querySelector("[data-week-body]");
  $weekTimes        = _root.querySelector("[data-times='week']");
  $sideMonthSummary = _root.querySelector("[data-side-month-summary]");
  $sideDaySummary   = _root.querySelector("[data-side-day-summary]");
  $calendarDayWeather = _root.querySelector("[data-calendar-day-weather]");
}

function _applySettingsSnapshot(nextSettings) {
  _settings = { ...nextSettings };
  _granularity = _settings.granularity;
  _businessOnly = _settings.showBusinessDaysOnly;

  if ($granularitySelect) $granularitySelect.value = String(_granularity);
  if ($businessOnlyChk) $businessOnlyChk.checked = _businessOnly;

  _renderTimeGrids();
  _renderWeekColumns();
  _renderDayTasks();
  _renderWeekTasks();
  _renderSideSummary();
  void _renderCalendarWeather();
  _wireDragDropTargets();
  updateNowLine(_granularity, _viewMode);
}

// ── 設定ダイアログ ────────────────────────────────────
function _wireSettingsButton() {
  const settingsDialog = document.querySelector("[data-settings-dialog]");
  if (!settingsDialog) return;
  _settingsDialogControl = wireSettingsDialog(settingsDialog, Store, {
    getTagMgrSeedDate: () => _viewDate,
    onAfterSave: (patch) => _applySettingsSnapshot({ ...Store.getSettings(), ...patch }),
    getWeatherLocationOptions,
    triggerRoot: _root,
  });
}

// ── ツールバー ─────────────────────────────────────────
function _wireToolbar() {
  $viewModeSelect?.addEventListener("change", () => {
    _viewMode = $viewModeSelect.value;
    _applyViewMode(_viewMode);
    _updateShiftLabels();
    updateNowLine(_granularity, _viewMode);
  });

  $granularitySelect?.addEventListener("change", () => {
    _granularity = Number($granularitySelect.value);
    _renderTimeGrids();
    _renderDayTasks();
    _renderWeekTasks();
    updateNowLine(_granularity, _viewMode);
  });

  $businessOnlyChk?.addEventListener("change", () => {
    _businessOnly = $businessOnlyChk.checked;
    _renderWeekColumns();
    _renderWeekTasks();
    void _renderCalendarWeather();
  });

  $shiftPrev?.addEventListener("click", () => _shiftView(-1));
  $shiftNext?.addEventListener("click", () => _shiftView(+1));
  $goToday?.addEventListener("click", () => {
    _setViewDate(new Date());
    _scrollToNow();
  });

  wireSidebarToggle(_root);
}

// ── ビュー管理 ─────────────────────────────────────────
function _applyViewMode(mode) {
  const dayView  = _root.querySelector("[data-view='day']");
  const weekView = _root.querySelector("[data-view='week']");
  if (dayView)  dayView.hidden  = (mode !== "day");
  if (weekView) weekView.hidden = (mode !== "week");
  if ($viewModeSelect) $viewModeSelect.value = mode;
  _updateDateLabel();
  setTimeout(_scrollToWorkStart, 0);
}

function _setViewDate(date) {
  _viewDate = new Date(date);
  _viewDate.setHours(0, 0, 0, 0);
  syncViewDate(_viewDate);
  _updateDateLabel();
  if ($daycol) {
    $daycol.setAttribute("data-date", formatDateKey(_viewDate));
  }
  _renderWeekColumns();
  _renderDayTasks();
  _renderWeekTasks();
  _renderSideSummary();
  void _renderCalendarWeather();

  const key = formatDateKey(_viewDate);
  _miniCalInst?.highlightDate(key);
  _miniCalInst?.navigateToMonth(_viewDate.getFullYear(), _viewDate.getMonth());
  updateNowLine(_granularity, _viewMode);
}

function _shiftView(direction) {
  const delta = _viewMode === "week" ? 7 : 1;
  _setViewDate(addDays(_viewDate, direction * delta));
}

function _updateDateLabel() {
  if (!$viewDateLabel) return;
  if (_viewMode === "week") {
    const mon = mondayOfWeek(_viewDate);
    const end = addDays(mon, _businessOnly ? 4 : 6);
    const start = _businessOnly ? mon : addDays(mon, -1);
    $viewDateLabel.textContent = `${formatDateJP(start)} - ${formatDateJP(end)}`;
  } else {
    $viewDateLabel.textContent = formatDateJP(_viewDate);
  }
}

function _updateShiftLabels() {
  const prev = _viewMode === "week" ? "前の週" : "前の日";
  const next = _viewMode === "week" ? "次の週" : "次の日";
  $shiftPrev?.setAttribute("aria-label", prev);
  $shiftPrev && ($shiftPrev.title = prev);
  $shiftNext?.setAttribute("aria-label", next);
  $shiftNext && ($shiftNext.title = next);
}

function _scrollToNow() {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const y = mins / (_granularity / ROW_HEIGHT);
  _root.querySelectorAll(".gridWrap").forEach((el) => {
    el.scrollTop = Math.max(0, y - 120);
  });
}

function _scrollToWorkStart() {
  const startMins = 10 * 60; // 10:00 固定
  const y = startMins / (_granularity / ROW_HEIGHT);
  // 日・週両方の gridWrap をまとめてスクロール（表示切替時にも反映される）
  _root.querySelectorAll(".gridWrap").forEach((el) => {
    el.scrollTop = Math.max(0, y - ROW_HEIGHT * 2);
  });
}

// ── 週カラム ───────────────────────────────────────────
const DAY_META = [
  { key: "Sun", offset: -1, label: "日", cls: "sun" },
  { key: "Mon", offset:  0, label: "月", cls: "" },
  { key: "Tue", offset:  1, label: "火", cls: "" },
  { key: "Wed", offset:  2, label: "水", cls: "" },
  { key: "Thu", offset:  3, label: "木", cls: "" },
  { key: "Fri", offset:  4, label: "金", cls: "" },
  { key: "Sat", offset:  5, label: "土", cls: "sat" },
];

function _renderWeekColumns() {
  const mon = mondayOfWeek(_viewDate);
  const showKeys = _businessOnly
    ? new Set(["Mon","Tue","Wed","Thu","Fri"])
    : new Set(["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]);
  const colCount = _businessOnly ? 5 : 7;
  const tpl = `72px repeat(${colCount}, minmax(0, 1fr))`;
  if ($weekHeader) $weekHeader.style.gridTemplateColumns = tpl;
  if ($weekAllDay) $weekAllDay.style.gridTemplateColumns = tpl;
  if ($weekBody)   $weekBody.style.gridTemplateColumns   = tpl;

  const viewDateKey = formatDateKey(_viewDate);

  // ヘッダーセル & 終日セル & 本体カラム
  DAY_META.forEach(({ key, offset, label }) => {
    const d = addDays(mon, offset);
    const dateKey = formatDateKey(d);
    const mmdd = `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
    const show = showKeys.has(key);

    const headerCell = _root.querySelector(`.weekDay[data-weekday="${key}"]`);
    if (headerCell) {
      headerCell.innerHTML = `<span class="weekDayMain">${escHtml(`${label} ${mmdd}`)}</span><span class="weekDayWeather">天気取得中...</span>`;
      headerCell.hidden = !show;
      headerCell.classList.toggle("today", dateKey === formatDateKey(new Date()));
    }

    const allDayCell = _root.querySelector(`.weekAllDayCell[data-weekday="${key}"]`);
    if (allDayCell) {
      allDayCell.hidden = !show;
      allDayCell.setAttribute("data-date", dateKey);
    }

    const col = _root.querySelector(`[data-weekcol][data-weekday="${key}"]`);
    if (col) {
      col.hidden = !show;
      col.setAttribute("data-date", dateKey);
    }
  });

  // 終日レーン更新
  _renderAllDayLane();
}

async function _renderCalendarWeather() {
  const token = ++_weatherRenderToken;
  const selectedDateKey = formatDateKey(_viewDate);
  if ($calendarDayWeather) {
    $calendarDayWeather.textContent = "天気取得中...";
    $calendarDayWeather.classList.add("loading");
  }

  const mon = mondayOfWeek(_viewDate);
  const rangeStart = formatDateKey(addDays(mon, -1));
  const rangeEnd = formatDateKey(addDays(mon, 5));

  try {
    const [selectedWeather, weeklyRows] = await Promise.all([
      getWeatherByDate(selectedDateKey),
      getWeatherRange(rangeStart, rangeEnd),
    ]);

    if (token !== _weatherRenderToken) return;

    if ($calendarDayWeather) {
      $calendarDayWeather.classList.remove("loading");
      $calendarDayWeather.textContent = formatWeatherForDisplay(selectedWeather);
    }

    DAY_META.forEach(({ key, offset }) => {
      const headerCell = _root.querySelector(`.weekDay[data-weekday="${key}"]`);
      if (!headerCell) return;
      const weatherEl = headerCell.querySelector(".weekDayWeather");
      if (!weatherEl) return;

      const dateKey = formatDateKey(addDays(mon, offset));
      const weather = weeklyRows?.[dateKey] ?? null;
      weatherEl.textContent = formatWeatherForDisplay(weather, { withTemp: false });
    });
  } catch (e) {
    console.warn("[calendar] weather rendering failed:", e);
    if (token !== _weatherRenderToken) return;
    if ($calendarDayWeather) {
      $calendarDayWeather.classList.remove("loading");
      $calendarDayWeather.textContent = "天気取得に失敗しました";
    }
    _root.querySelectorAll(".weekDayWeather").forEach((el) => {
      el.textContent = "取得失敗";
    });
  }
}

// ── TimeGrid(日・週) ─────────────────────────────────
function _renderTimeGrids() {
  const grid = {
    granularity: _granularity,
    workStart: _settings.workStart,
    workEnd: _settings.workEnd,
    breaks: normalizeBreaks(_settings.breaks),
  };
  renderTimeGrid({ timesEl: $dayTimes, slotEls: [$daySlots], ...grid });

  const weekCols = Array.from(_root.querySelectorAll("[data-weekcol]"));
  const slotEls  = weekCols.map((c) => c.querySelector("[data-slots='week']")).filter(Boolean);
  if ($weekTimes && slotEls.length > 0) renderTimeGrid({ timesEl: $weekTimes, slotEls, ...grid });
}

// ── タスクブロック描画 ────────────────────────────────
function _makeTaskBlock(task, tags) {
  const allTags = Store.getAllTags();
  const tag = tags.find((t) => t.id === task.tagId) || allTags.find((t) => t.id === task.tagId);
  const isRecurring = task?.recurrence?.type && task.recurrence.type !== "none";
  const durationMins = Math.max(0, timeToMinutes(task.endTime) - timeToMinutes(task.startTime));
  const isCompact = durationMins <= Math.max(_granularity, 30);
  const el = document.createElement("div");
  el.className = `taskBlock${isCompact ? " compact" : ""}`;
  _applyTagColorStyle(el, tag?.color || DEFAULT_TASK_COLOR);
  el.draggable = true;
  el.setAttribute("data-task-id", task.id);
  el.setAttribute("data-start", task.startTime);
  el.setAttribute("data-end",   task.endTime);
  if (isRecurring) el.setAttribute("data-recurring", "1");

  const titleText = escHtml(task.title || "無題");
  const tagName   = escHtml(tag?.name ?? "");
  const startStr  = escHtml(task.startTime ?? "");
  const endStr    = escHtml(task.endTime   ?? "");
  const durationH = durationMins > 0 ? `(${(durationMins / 60).toFixed(durationMins % 60 === 0 ? 0 : 1)}h)` : "";
  const timeRange = startStr && endStr ? `${startStr}〜${endStr} ${durationH}` : "";
  const subLine   = [timeRange, tagName].filter(Boolean).join(" / ");
  const teamsBtn  = task.meetingUrl
    ? `<button type="button" class="taskTeamsJoinBtn" title="Teams会議に参加">📹</button>`
    : "";
  el.innerHTML = `<span class="taskMain">${titleText}</span><small>${escHtml(subLine)}</small>${teamsBtn}`;
  const memoText = String(task.memo ?? "").trim();
  el.title = `${task.title || "無題"} (${task.startTime ?? ""}-${task.endTime ?? ""}${tag?.name ? ` / ${tag.name}` : ""})${memoText ? `\n${memoText}` : ""}`;

  if (task.meetingUrl) {
    el.querySelector(".taskTeamsJoinBtn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      window.open(task.meetingUrl, "_blank");
    });
  }

  positionTaskBlock(el, task.startTime, task.endTime, _granularity);

  // ダブルクリックで編集
  el.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    openEditDialog($dialog, task, _getDialogTagsForDateKey(task.date, task.tagId));
  });

  el.addEventListener("click", () => {
    _setFocusedTaskElement(el);
  });

  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    _openTaskTagMenu(task, e.clientX, e.clientY, el);
  });

  // DnD: 移動 (F-TASK-003)
  _wireDragMove(el, task);

  // リサイズ (F-TASK-004)
  _wireResize(el, task);

  return el;
}

function _clearTaskBlocks(scopeEl) {
  scopeEl.querySelectorAll("[data-task-id]").forEach((el) => el.remove());
}

function _computeOverlapLayout(tasks) {
  const timed = tasks
    .filter((t) => !t.isAllDay)
    .map((task) => {
      const start = timeToMinutes(task.startTime);
      const end = Math.max(start + 1, timeToMinutes(task.endTime));
      return { task, start, end, column: 0 };
    })
    .sort((a, b) => (a.start - b.start) || (a.end - b.end));

  const layoutById = new Map();
  let cluster = [];
  let clusterMaxEnd = -1;

  const flushCluster = () => {
    if (!cluster.length) return;

    const active = [];
    let maxColumns = 1;

    cluster.forEach((item) => {
      for (let i = active.length - 1; i >= 0; i--) {
        if (active[i].end <= item.start) active.splice(i, 1);
      }

      const used = new Set(active.map((x) => x.column));
      let column = 0;
      while (used.has(column)) column += 1;

      item.column = column;
      active.push({ column, end: item.end });
      maxColumns = Math.max(maxColumns, column + 1);
    });

    cluster.forEach((item) => {
      layoutById.set(item.task.id, {
        column: item.column,
        columns: maxColumns,
      });
    });

    cluster = [];
    clusterMaxEnd = -1;
  };

  timed.forEach((item) => {
    if (!cluster.length) {
      cluster.push(item);
      clusterMaxEnd = item.end;
      return;
    }

    if (item.start < clusterMaxEnd) {
      cluster.push(item);
      clusterMaxEnd = Math.max(clusterMaxEnd, item.end);
      return;
    }

    flushCluster();
    cluster.push(item);
    clusterMaxEnd = item.end;
  });

  flushCluster();
  return layoutById;
}

function _applyOverlapLayout(tasks, blocksById) {
  const layoutById = _computeOverlapLayout(tasks);
  const insetPx = 1;
  const gutterPx = 2;

  tasks.forEach((task) => {
    const block = blocksById.get(task.id);
    if (!block) return;

    const layout = layoutById.get(task.id) ?? { column: 0, columns: 1 };
    if (layout.columns <= 1) {
      block.style.left = `${insetPx}px`;
      block.style.right = `${insetPx}px`;
      block.style.width = "auto";
      return;
    }

    const widthPct = 100 / Math.max(1, layout.columns);
    const leftPct = widthPct * layout.column;

    block.style.left = `calc(${leftPct}% + ${insetPx}px)`;
    block.style.width = `calc(${widthPct}% - ${insetPx + gutterPx}px)`;
    block.style.right = "auto";
  });
}

function _renderDayTasks() {
  if (!$daycol) return;
  _clearTaskBlocks($daycol);
  const dateKey = formatDateKey(_viewDate);
  const tasks   = Store.getTasksByDate(dateKey);
  const tags    = Store.getTagsForMonth(formatYearMonth(_viewDate));

  // 終日タスク
  _renderAllDayLaneSingle(tasks);

  const timedTasks = tasks.filter((t) => !t.isAllDay);
  const blocksById = new Map();
  timedTasks.forEach((t) => {
    const block = _makeTaskBlock(t, tags);
    blocksById.set(t.id, block);
    $daycol.appendChild(block);
  });
  _applyOverlapLayout(timedTasks, blocksById);
}

function _renderWeekTasks() {
  const mon  = mondayOfWeek(_viewDate);
  const tags = Store.getTagsForMonth(formatYearMonth(_viewDate));

  DAY_META.forEach(({ key, offset }) => {
    const col = _root.querySelector(`[data-weekcol][data-weekday="${key}"]`);
    if (!col) return;
    _clearTaskBlocks(col);
    const dateKey = formatDateKey(addDays(mon, offset));
    const tasks   = Store.getTasksByDate(dateKey).filter((t) => !t.isAllDay);
    const blocksById = new Map();
    tasks.forEach((t) => {
      const block = _makeTaskBlock(t, tags);
      blocksById.set(t.id, block);
      col.appendChild(block);
    });
    _applyOverlapLayout(tasks, blocksById);
  });

  _renderAllDayLane();
}

// ── 終日レーン ────────────────────────────────────────
function _renderAllDayLaneSingle(tasks) {
  const container = _root.querySelector(".allDayItems");
  if (!container) return;
  container.querySelectorAll("[data-task-id]").forEach((el) => el.remove());
  const tags = Store.getAllTags();
  tasks.filter((t) => t.isAllDay).forEach((t) => {
    const isRecurring = t?.recurrence?.type && t.recurrence.type !== "none";
    const tag = tags.find((x) => x.id === t.tagId);
    const pill = document.createElement("span");
    pill.className = "allDayPill";
    _applyTagColorStyle(pill, tag?.color || DEFAULT_TASK_COLOR, { allDay: true });
    pill.setAttribute("data-task-id", t.id);
    if (isRecurring) pill.setAttribute("data-recurring", "1");
    pill.textContent = `${t.title}${tag?.name ? ` / ${tag.name}` : ""}`;
    pill.style.cursor = "pointer";
    pill.addEventListener("click", () => {
      _setFocusedTaskElement(pill);
    });
    pill.addEventListener("dblclick", () => openEditDialog($dialog, t, _getDialogTagsForDateKey(t.date, t.tagId)));
    pill.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      _openTaskTagMenu(t, e.clientX, e.clientY, pill);
    });
    container.appendChild(pill);
  });
}

function _renderAllDayLane() {
  const mon = mondayOfWeek(_viewDate);
  const yearMonth = formatYearMonth(_viewDate);
  const tags = Store.getTagsForMonth(yearMonth);
  const allTags = Store.getAllTags();
  DAY_META.forEach(({ key, offset }) => {
    const cell = _root.querySelector(`.weekAllDayCell[data-weekday="${key}"]`);
    if (!cell) return;
    cell.querySelectorAll("[data-task-id]").forEach((el) => el.remove());
    const dateKey = formatDateKey(addDays(mon, offset));
    const tasks = Store.getTasksByDate(dateKey).filter((t) => t.isAllDay);
    tasks.forEach((t) => {
      const isRecurring = t?.recurrence?.type && t.recurrence.type !== "none";
      const tag = tags.find((x) => x.id === t.tagId) || allTags.find((x) => x.id === t.tagId);
      const pill = document.createElement("span");
      pill.className = "allDayPill";
      _applyTagColorStyle(pill, tag?.color || DEFAULT_TASK_COLOR, { allDay: true });
      pill.setAttribute("data-task-id", t.id);
      if (isRecurring) pill.setAttribute("data-recurring", "1");
      pill.textContent = `${t.title}${tag?.name ? ` / ${tag.name}` : ""}`;
      pill.style.cursor = "pointer";
      pill.addEventListener("click", () => {
        _setFocusedTaskElement(pill);
      });
      pill.addEventListener("dblclick", () => openEditDialog($dialog, t, _getDialogTagsForDateKey(t.date, t.tagId)));
      pill.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        _openTaskTagMenu(t, e.clientX, e.clientY, pill);
      });
      cell.appendChild(pill);
    });
  });
}

// ── サイドバー工数集計 ────────────────────────────────
function _renderSideSummary() {
  renderSideSummaries({ monthEl: $sideMonthSummary, dayEl: $sideDaySummary, Store, dateKey: formatDateKey(_viewDate) });
}

// ── ミニカレンダー ─────────────────────────────────────
function _wireMiniCalendar() {
  _miniCalInst = setupMiniCalendar({
    containerEl:       _root.querySelector("[data-mini-cal]"),
    monthLabelEl:      _root.querySelector("[data-mini-month-label]"),
    prevBtn:           _root.querySelector("[data-mini-month-prev]"),
    nextBtn:           _root.querySelector("[data-mini-month-next]"),
    collapseBtn: _root.querySelector("[data-mini-calendar-toggle]"),
    onDateSelect:      (date) => _setViewDate(date),
    initialDate:       new Date(),
    getHolidaysInMonth: (year, month) => getCombinedHolidaysInMonth(year, month, _settings),
  });

  wireMonthTagPopup(_root.querySelector("[data-mini-month-label]"), Store);
}

// ── タスク作成ダイアログ ──────────────────────────────
function _wireNewTaskButton() {
  _root.querySelectorAll("[data-new-task]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const now = new Date();
      const nowMins   = now.getHours() * 60 + now.getMinutes();
      const startMins = _snapTaskMinutes(nowMins, "end");
      const endMins   = Math.min(1440, startMins + _minTaskDurationMinutes());
      const tags = Store.getTagsForMonth(formatYearMonth(_viewDate));
      openCreateDialog($dialog, {
        startTime: minutesToTime(startMins),
        endTime:   minutesToTime(endMins),
        date:      formatDateKey(_viewDate),
        tags,
      });
    });
  });
}

function _wireDialog() {
  if (!$dialog) return;

  let _saving = false;
  const saveTask = async () => {
    if (_saving) return;
    const form = readDialogForm($dialog);
    if (!form.title) { alert("タイトルを入力してください。"); return; }
    const { editScope, ...taskPatch } = form;
    const mode = editScope || "single";

    const saveBtn = $dialog.querySelector("[data-save]");
    _saving = true;
    if (saveBtn) { saveBtn.disabled = true; saveBtn.dataset.origText = saveBtn.textContent; saveBtn.textContent = "保存中…"; }
    try {
      const editId = $dialog.getAttribute("data-edit-id");
      if (editId) {
        // Undo対象は単一予定編集のみ(繰り返し系列一括編集は対象外、_recordActionのコメント参照)。
        const existing = mode === "single" ? Store.getAllTasks().find((t) => t.id === editId) : null;
        const expandsSeries = existing && taskPatch.recurrence && taskPatch.recurrence.type !== "none"
          && Store.getTaskSeriesCount(existing) === 1
          && (existing.recurrence?.type !== taskPatch.recurrence.type
            || existing.recurrence?.until !== taskPatch.recurrence.until || existing.date !== taskPatch.date);
        const updated = await updateTaskByChoice(Store, editId, taskPatch, mode);
        if (!updated) return;
        if (existing && !expandsSeries) {
          const before = {};
          Object.keys(taskPatch).forEach((key) => { before[key] = existing[key]; });
          _recordAction({ type: "update", taskId: editId, before, after: { ...taskPatch } });
        }
      } else {
        const created = await Store.createTask({ ...taskPatch, date: taskPatch.date || formatDateKey(_viewDate) });
        // Undo対象は単発作成のみ(繰り返し系列の一括作成は対象外、_recordActionのコメント参照)。
        if (created && created.recurrence?.type === "none") {
          _recordAction({ type: "create", taskId: created.id, task: created });
        }
      }
      $dialog.close();
    } catch (error) {
      alert(`予定を保存できませんでした。\n${String(error?.message ?? error)}`);
    } finally {
      _saving = false;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = saveBtn.dataset.origText || "保存"; }
    }
  };

  // backdrop クリックで閉じる
  $dialog.addEventListener("click", (e) => {
    if (e.target !== $dialog) return;
    const r = $dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
      $dialog.close();
    }
  });

  // 閉じるにはどの経路でもロックを解除
  $dialog.addEventListener("close", () => {
    _saving = false;
    const saveBtn = $dialog.querySelector("[data-save]");
    if (saveBtn) { saveBtn.disabled = false; if (saveBtn.dataset.origText) saveBtn.textContent = saveBtn.dataset.origText; }
  });

  $dialog.querySelector("[data-cancel]")?.addEventListener("click", () => $dialog.close());

  $dialog.querySelector("[data-save]")?.addEventListener("click", () => {
    void saveTask();
  });

  // 削除ボタン（編集モード時のみ表示）
  $dialog.querySelector("[data-delete]")?.addEventListener("click", async () => {
    const editId = $dialog.getAttribute("data-edit-id");
    if (editId) {
      await _deleteTaskByChoice(editId);
      $dialog.close();
    }
  });

  $dialog.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    void saveTask();
  });

  // 時刻ピッカー初期化
  $dialog.querySelectorAll("[data-time-picker]").forEach(setupTimePicker);
}

// ── ドラッグ選択（タスク作成: F-TASK-001 / F-TASK-007） ──
function _wireCalendarSelection() {
  const dayColEl = _root.querySelector("[data-daycol]");
  const daySlots = _root.querySelector("[data-slots='day']");
  if (dayColEl && daySlots) {
    _wireSelectionColumn(dayColEl, daySlots, () => formatDateKey(_viewDate));
  }

  _root.querySelectorAll("[data-weekcol]").forEach((col) => {
    const slots = col.querySelector("[data-slots='week']");
    if (!slots) return;
    _wireSelectionColumn(col, slots, () => col.getAttribute("data-date") || formatDateKey(_viewDate));
  });
}

function _openAllDayCreateDialog(dateKey) {
  openCreateDialog($dialog, {
    date: dateKey,
    tags: _getDialogTagsForDateKey(dateKey),
    isAllDay: true,
    dialogTitle: "終日タスクを追加",
    focusTitle: true,
  });
}

function _wireAllDayCreateTargets() {
  const dayAllDay = _root.querySelector(".allDayItems");
  if (dayAllDay && dayAllDay.getAttribute("data-create-bound") !== "1") {
    dayAllDay.setAttribute("data-create-bound", "1");
    dayAllDay.addEventListener("click", (e) => {
      if (e.target.closest("[data-task-id]")) return;
      _openAllDayCreateDialog(formatDateKey(_viewDate));
    });
  }

  _root.querySelectorAll(".weekAllDayCell[data-weekday]").forEach((cell) => {
    if (cell.getAttribute("data-create-bound") === "1") return;
    cell.setAttribute("data-create-bound", "1");
    cell.addEventListener("click", (e) => {
      if (e.target.closest("[data-task-id]")) return;
      const dateKey = cell.getAttribute("data-date") || formatDateKey(_viewDate);
      _openAllDayCreateDialog(dateKey);
    });
  });
}

function _wireSelectionColumn(colEl, slotsEl, getDateKey) {
  let selecting = false;
  let dragging = false;
  let startY = 0;
  let currentY = 0;
  let selEl = null;

  if (colEl.getAttribute("data-slot-focus-bound") !== "1") {
    colEl.setAttribute("data-slot-focus-bound", "1");
    colEl.addEventListener("click", (e) => {
      if (e.target.closest("[data-task-id]")) return;
      const rect = slotsEl.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;

      const y = Math.max(0, Math.min(rect.height - 1, e.clientY - rect.top));
      const idx = Math.floor(y / ROW_HEIGHT);
      const slot = slotsEl.querySelector(`.slot[data-index="${idx}"]`);
      if (!slot) return;
      _setFocusedSlotElement(slot);
    });
  }

  function yToSnap(y, mode) {
    const raw = y * (_granularity / ROW_HEIGHT);
    return _snapTaskMinutes(raw, mode);
  }
  function ensureSel() {
    if (!selEl) { selEl = document.createElement("div"); selEl.className = "selection"; colEl.appendChild(selEl); }
  }
  function clearSel() { selEl?.remove(); selEl = null; }
  function renderSel() {
    ensureSel();
    const aY = Math.min(startY, currentY), bY = Math.max(startY, currentY);
    const sm = yToSnap(aY, "start");
    const em = Math.max(sm + _minTaskDurationMinutes(), yToSnap(bY, "end"));
    const top = sm / (_granularity / ROW_HEIGHT);
    const h   = Math.max(12, (Math.min(1440, em) - sm) / (_granularity / ROW_HEIGHT));
    selEl.style.top    = `${top}px`;
    selEl.style.height = `${h}px`;
  }

  function openCreateFromRange(sm, em, dateKey, dialogTitle) {
    openCreateDialog($dialog, {
      startTime:   minutesToTime(sm),
      endTime:     minutesToTime(Math.min(1440, em)),
      date:        dateKey,
      tags:        _getDialogTagsForDateKey(dateKey),
      dialogTitle,
      focusTitle:  true,
    });
  }

  colEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("[data-task-id]")) return;
    const rect = slotsEl.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
    selecting = true;
    dragging = false;
    startY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    currentY = startY;
    colEl.setPointerCapture?.(e.pointerId);
  });

  colEl.addEventListener("pointermove", (e) => {
    if (!selecting) return;
    const rect = slotsEl.getBoundingClientRect();
    currentY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    if (!dragging && Math.abs(currentY - startY) >= DRAG_SELECTION_THRESHOLD_PX) {
      dragging = true;
    }
    if (dragging) renderSel();
  });

  colEl.addEventListener("pointerup", () => {
    if (!selecting) return;
    selecting = false;
    if (!dragging) {
      clearSel();
      return;
    }
    const aY = Math.min(startY, currentY), bY = Math.max(startY, currentY);
    const sm = yToSnap(aY, "start");
    const em = Math.max(sm + _minTaskDurationMinutes(), yToSnap(bY, "end"));
    clearSel();

    openCreateFromRange(sm, em, getDateKey(), "タスク作成（ドラッグ選択から作成）");
  });

  colEl.addEventListener("pointercancel", () => {
    selecting = false;
    dragging = false;
    clearSel();
  });

  colEl.addEventListener("dblclick", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("[data-task-id]")) return;
    const rect = slotsEl.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;

    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    const sm = yToSnap(y, "start");
    const em = Math.min(1440, sm + _minTaskDurationMinutes());
    openCreateFromRange(sm, em, getDateKey(), "タスク作成（ダブルクリックから作成）");
  });
}

// ── DnD 移動 (F-TASK-003) ─────────────────────────────
function _wireDragMove(el, task) {
  el.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", task.id);
    e.dataTransfer.effectAllowed = "copyMove";
    _draggingTaskId = task.id;
    _dragCopyMode = Boolean(e.ctrlKey || e.metaKey || _ctrlOrMetaPressed);
    // ブロック内でのクリック位置（px）→ 分に変換して記録
    const rect = el.getBoundingClientRect();
    const offsetPx = e.clientY - rect.top;
    _dragOffsetMins = Math.max(0, offsetPx * (_granularity / ROW_HEIGHT));
    el.classList.add("dragging");
  });
  el.addEventListener("dragend", () => {
    _draggingTaskId = null;
    _dragCopyMode = false;
    _hideTaskTimePreview();
    el.classList.remove("dragging");
  });
}

function _wireDragDropTargets() {
  // 日表示
  if ($daycol) _wireDrop($daycol, () => formatDateKey(_viewDate));

  // 週表示
  _root.querySelectorAll("[data-weekcol][data-weekday]").forEach((col) => {
    _wireDrop(col, () => col.getAttribute("data-date") || formatDateKey(_viewDate));
  });
}

function _wireDrop(colEl, getDateKey) {
  if (colEl.getAttribute("data-drop-bound") === "1") return;
  colEl.setAttribute("data-drop-bound", "1");

  const resolveDraft = (clientY, task) => {
    const slots = colEl.querySelector("[data-slots='day'], [data-slots='week']");
    if (!slots) return null;
    const rect = slots.getBoundingClientRect();
    const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
    const rawMins = y * (_granularity / ROW_HEIGHT) - _dragOffsetMins;
    const duration = _normalizeTaskDurationMinutes(
      timeToMinutes(task.endTime) - timeToMinutes(task.startTime),
    );
    const startMins = Math.max(0, Math.min(1440 - duration, _snapTaskMinutes(rawMins, "start")));
    const endMins = Math.min(1440, _snapTaskMinutes(startMins + duration, "end"));
    return { startMins, endMins };
  };

  colEl.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("text/plain")) return;
    const taskId = _draggingTaskId || e.dataTransfer.getData("text/plain");
    const task = Store.getAllTasks().find((t) => t.id === taskId);
    if (!task || task.isAllDay) return;

    e.preventDefault();
    _dragCopyMode = Boolean(e.ctrlKey || e.metaKey || _ctrlOrMetaPressed);
    e.dataTransfer.dropEffect = _dragCopyMode ? "copy" : "move";

    const draft = resolveDraft(e.clientY, task);
    if (draft) {
      const previewLabel = _dragCopyMode ? "コピー" : "移動";
      _showTaskTimePreview(
        `${previewLabel}: ${minutesToTime(draft.startMins)} - ${minutesToTime(draft.endMins)}`,
        e.clientX,
        e.clientY,
      );
    }
  });

  colEl.addEventListener("dragleave", (e) => {
    const next = e.relatedTarget;
    if (next && colEl.contains(next)) return;
    _hideTaskTimePreview();
  });

  colEl.addEventListener("drop", async (e) => {
    e.preventDefault();
    _hideTaskTimePreview();

    const taskId = _draggingTaskId || e.dataTransfer.getData("text/plain");
    const task   = Store.getAllTasks().find((t) => t.id === taskId);
    if (!task || task.isAllDay) return;

    const draft = resolveDraft(e.clientY, task);
    if (!draft) return;

    const date = getDateKey();
    const startTime = minutesToTime(draft.startMins);
    const endTime = minutesToTime(draft.endMins);
    const copyMode = Boolean(e.ctrlKey || e.metaKey || _ctrlOrMetaPressed || _dragCopyMode);

    if (copyMode) {
      const created = await Store.createTask({
        ...task,
        id: undefined,
        date,
        startTime,
        endTime,
        recurrence: { type: "none" },
      });
      if (created) _recordAction({ type: "create", taskId: created.id, task: created });
    } else {
      _recordAction({
        type: "update",
        taskId,
        before: { date: task.date, startTime: task.startTime, endTime: task.endTime },
        after: { date, startTime, endTime },
      });
      await Store.updateTask(taskId, {
        date,
        startTime,
        endTime,
      });
    }
    _dragCopyMode = false;
  });
}

// ── リサイズ (F-TASK-004) ─────────────────────────────
function _wireResize(el, task) {
  // 上端ハンドル（開始時刻変更）
  const topHandle = document.createElement("div");
  topHandle.className = "resizeHandle";
  topHandle.style.cssText = "position:absolute;top:0;left:0;right:0;height:8px;cursor:ns-resize;z-index:2;";
  topHandle.setAttribute("aria-hidden", "true");
  el.prepend(topHandle);

  let topStartY = 0, origStartMins = 0;
  topHandle.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    topStartY     = e.clientY;
    origStartMins = _snapTaskMinutes(timeToMinutes(task.startTime), "start");
    const fixedEndMins = _snapTaskMinutes(timeToMinutes(task.endTime), "end");
    topHandle.setPointerCapture(e.pointerId);
    function onMove(ev) {
      const deltaMins = (ev.clientY - topStartY) * (_granularity / ROW_HEIGHT);
      const newStart  = _snapTaskMinutes(origStartMins + deltaMins, "start");
      const clamped   = Math.max(0, Math.min(fixedEndMins - _minTaskDurationMinutes(), newStart));
      positionTaskBlock(el, minutesToTime(clamped), minutesToTime(fixedEndMins), _granularity);
      _showTaskTimePreview(
        `${minutesToTime(clamped)} - ${minutesToTime(fixedEndMins)}`,
        ev.clientX,
        ev.clientY,
      );
    }
    function onUp(ev) {
      const deltaMins = (ev.clientY - topStartY) * (_granularity / ROW_HEIGHT);
      const newStart  = _snapTaskMinutes(origStartMins + deltaMins, "start");
      const clamped   = Math.max(0, Math.min(fixedEndMins - _minTaskDurationMinutes(), newStart));
      _hideTaskTimePreview();
      // 確定直前に対象が消えていないか（自動更新等での再描画と競合）を確認
      if (Store.getAllTasks().some((t) => t.id === task.id)) {
        _recordAction({
          type: "update",
          taskId: task.id,
          before: { startTime: task.startTime, endTime: task.endTime },
          after: { startTime: minutesToTime(clamped), endTime: minutesToTime(fixedEndMins) },
        });
        Store.updateTask(task.id, {
          startTime: minutesToTime(clamped),
          endTime: minutesToTime(fixedEndMins),
        });
      }
      topHandle.removeEventListener("pointermove", onMove);
      topHandle.removeEventListener("pointerup",   onUp);
      topHandle.removeEventListener("pointercancel", onCancel);
    }
    function onCancel() {
      _hideTaskTimePreview();
      topHandle.removeEventListener("pointermove", onMove);
      topHandle.removeEventListener("pointerup",   onUp);
      topHandle.removeEventListener("pointercancel", onCancel);
    }
    topHandle.addEventListener("pointermove", onMove);
    topHandle.addEventListener("pointerup",   onUp);
    topHandle.addEventListener("pointercancel", onCancel);
  });

  // 下端ハンドル（終了時刻変更）
  const handle = document.createElement("div");
  handle.className = "resizeHandle";
  handle.style.cssText = "position:absolute;bottom:0;left:0;right:0;height:8px;cursor:ns-resize;";
  handle.setAttribute("aria-hidden", "true");
  el.appendChild(handle);

  let startY = 0, origEndMins = 0;

  handle.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    startY       = e.clientY;
    origEndMins  = _snapTaskMinutes(timeToMinutes(task.endTime), "end");
    const fixedStartMins = _snapTaskMinutes(timeToMinutes(task.startTime), "start");
    handle.setPointerCapture(e.pointerId);

    function onMove(ev) {
      const deltaY    = ev.clientY - startY;
      const deltaMins = deltaY * (_granularity / ROW_HEIGHT);
      const newEnd    = _snapTaskMinutes(origEndMins + deltaMins, "end");
      const clampedEnd = Math.min(1440, Math.max(fixedStartMins + _minTaskDurationMinutes(), newEnd));
      positionTaskBlock(el, minutesToTime(fixedStartMins), minutesToTime(clampedEnd), _granularity);
      _showTaskTimePreview(
        `${minutesToTime(fixedStartMins)} - ${minutesToTime(clampedEnd)}`,
        ev.clientX,
        ev.clientY,
      );
    }

    function onUp(ev) {
      const deltaY    = ev.clientY - startY;
      const deltaMins = deltaY * (_granularity / ROW_HEIGHT);
      const newEnd    = _snapTaskMinutes(origEndMins + deltaMins, "end");
      const clampedEnd = Math.min(1440, Math.max(fixedStartMins + _minTaskDurationMinutes(), newEnd));
      _hideTaskTimePreview();
      // 確定直前に対象が消えていないか（自動更新等での再描画と競合）を確認
      if (Store.getAllTasks().some((t) => t.id === task.id)) {
        _recordAction({
          type: "update",
          taskId: task.id,
          before: { startTime: task.startTime, endTime: task.endTime },
          after: { startTime: minutesToTime(fixedStartMins), endTime: minutesToTime(clampedEnd) },
        });
        Store.updateTask(task.id, {
          startTime: minutesToTime(fixedStartMins),
          endTime: minutesToTime(clampedEnd),
        });
      }
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
    }

    function onCancel() {
      _hideTaskTimePreview();
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
    }

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup",   onUp);
    handle.addEventListener("pointercancel", onCancel);
  });
}
// ── コピー＆ペースト (F-TASK-005) ────────────────────
function _wireCopyPaste() {
  document.addEventListener("keydown", (e) => {
    const activeTag = document.activeElement?.tagName;
    if (activeTag === "INPUT" || activeTag === "TEXTAREA" || activeTag === "SELECT") return;
    if ($dialog?.open) return;

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "c") {
      // 選択中のタスクブロックをコピー（最初にフォーカスされているものを対象）
      const focused = _root.querySelector("[data-task-id]:focus, [data-task-id].focused");
      if (focused) {
        const taskId = focused.getAttribute("data-task-id");
        _clipboard = Store.getAllTasks().find((t) => t.id === taskId) ?? null;
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "x") {
      // 切り取り = コピー + 削除(単一予定のみUndo対応)
      const focused = _root.querySelector("[data-task-id]:focus, [data-task-id].focused");
      if (!focused) return;
      const taskId = focused.getAttribute("data-task-id");
      if (!taskId) return;
      const task = Store.getAllTasks().find((t) => t.id === taskId);
      if (!task) return;
      e.preventDefault();
      _clipboard = task;
      void _deleteTaskByChoice(taskId, "single");
      return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "v") {
      if (!_clipboard) return;
      e.preventDefault();
      void (async () => {
        const created = await Store.createTask({
          ..._clipboard,
          id: undefined,
          date: formatDateKey(_viewDate),
          recurrence: { type: "none" },
        });
        if (created) _recordAction({ type: "create", taskId: created.id, task: created });
      })();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "z") {
      e.preventDefault();
      void _undo();
      return;
    }

    if (((e.ctrlKey || e.metaKey) && e.key === "y") || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "Z")) {
      e.preventDefault();
      void _redo();
      return;
    }

    if (!e.ctrlKey && !e.metaKey && e.key === "Delete") {
      const focused = _root.querySelector("[data-task-id].focused");
      if (!focused) return;
      const taskId = focused.getAttribute("data-task-id");
      if (!taskId) return;
      e.preventDefault();
      void _deleteTaskByChoice(taskId);
    }
  });

  // タスクブロックをクリックでフォーカス可能にする
  document.addEventListener("click", (e) => {
    const block = e.target.closest("[data-task-id]");
    if (block) {
      _setFocusedTaskElement(block);
    }
  });
}
