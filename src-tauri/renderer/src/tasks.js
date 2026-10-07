import { t as translate, th as translateHtml, getLocale } from './i18n.js';
import { copyIconHtml, checkIconHtml, errorIconHtml, editIconHtml, deleteIconHtml } from './ui-icons.js';
import { wireTaskBatch } from './task-batch-ui.js';
import { showAppAlert, showAppConfirm, chooseRecurrenceScope } from './app-dialogs.js';
/**
 * tasks.js — タスク一覧ページのロジック
 *
 * 要件カバー:
 *   F-LIST-001〜006, F-WH-001〜005
 */

import * as Store from "./store.js";
import {
  escHtml,
  formatDateKey,
  formatYearMonth,
  formatDateJP,
  formatDurationHtml,
  timeToMinutes,
  parseLocalDate,
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
  getCombinedHolidaysInMonth,
  wireSidebarToggle,
  renderSideSummaries,
  wireMonthTagPopup,
  ensureTaskTagMenu,
  hideTaskTagMenu,
  renderTaskTagMenu,
} from "./ui-utils.js";
import { wireSettingsDialog, wireSideTagClickToSettings } from "./settings-dialog.js";
import { summarizeDay, shouldSkipDailySummary } from "./ai-memory.js";
import { isAiConfigured } from "./ai-client.js";
import {
  getWeatherByDate,
  formatWeatherForDisplay,
  getWeatherLocationOptions,
} from "./weather.js";


// ── 状態 ─────────────────────────────────────────────
let _selectedDate = new Date();
let _tagFilter    = "";     // "" = 全て
let _sortCol      = { key: "startTime", dir: "asc" }; // { key, dir: "asc"|"desc" }
let _miniCalInst  = null;
let _settings     = null;
let _focusedTaskId = "";
let _batchControl;
const _summaryGeneratingDates = new Set();
// サマリーの自動作成は、1回の起動につき同じ日は1回だけ試す(AIの呼び出しに失敗したときに繰り返さないため)。
const _summaryAttemptedDates = new Set();
let _dayWeatherRenderToken = 0;
let _insightBusy = false;

function _setFocusedTaskRow(taskId = "") {
  _focusedTaskId = String(taskId || "");
  _root.querySelectorAll("[data-task-id].focused").forEach((el) => el.classList.remove("focused"));
  if (!_focusedTaskId) return;
  const row = Array.from(_root.querySelectorAll("tr[data-task-id]")).find((el) => el.getAttribute("data-task-id") === _focusedTaskId);
  if (row) row.classList.add("focused");
}

// 繰り返し予定の削除範囲を選ばせる(Outlookの「これ以降の予定」相当)。1=このみ/2=すべて/3=今日以降すべて。
async function _chooseDeleteModeForTask(task) {
  const count = Store.getTaskSeriesCount(task);
  const message = task.title + '\n' + task.date;
  if (count > 1) return chooseRecurrenceScope({title:translate('ui.e9653dc3ed'),message,operation:'delete'});
  return await showAppConfirm(message, {title:translate('ui.e9653dc3ed'),confirmLabel:translate('ui.e9653dc3ed'),danger:true}) ? 'single' : null;
}

async function _deleteTaskByChoice(taskId, preferredMode = null) {
  const task = Store.getAllTasks().find((t) => t.id === taskId);
  if (!task) return;
  const mode = preferredMode ?? await _chooseDeleteModeForTask(task);
  if (!mode) return false;
  if (preferredMode && !await showAppConfirm(task.title + '\n' + task.date, {title:translate('ui.e9653dc3ed'),confirmLabel:translate('ui.e9653dc3ed'),danger:true})) return false;
  try { await Store.deleteTaskWithMode(taskId, mode); }
  catch (error) { await showAppAlert(String(error?.message ?? error), {tone:'error'}); return false; }
  if (_focusedTaskId === taskId) _setFocusedTaskRow("");
  return true;
}

// 月ごとにタグを明示設定する前提のため、その月に設定がなければ空になる。
// ただし既存タスクの現在のタグが月設定から外れていても、編集時に見えなくなって
// 保存時に消えてしまわないよう、currentTagIdは常に候補へ残す。
function _getDialogTagsForDateKey(dateKey, currentTagId = "") {
  return getDialogTagsForDateKey(Store, dateKey, currentTagId, () => _selectedDate);
}

function _openTaskTagMenu(task, clientX, clientY, sourceRow = null) {
  const menu = ensureTaskTagMenu();
  if (!menu) return;

  _setFocusedTaskRow(task.id);
  if (sourceRow) sourceRow.classList.add("focused");

  const tags = _getDialogTagsForDateKey(task.date, task.tagId);
  const seriesCount = Store.getTaskSeriesCount(task);
  const contextTasks = _batchControl.getContextTasks(task.id);

  renderTaskTagMenu(menu, {
    task, tags, seriesCount, clientX, clientY,
    selectionCount: contextTasks.length,
    selectedTagId: contextTasks.every(row => row.tagId === task.tagId) ? task.tagId : null,
    onEdit: async () => {
      openEditDialog($dialog, task, _getDialogTagsForDateKey(task.date, task.tagId));
    },
    onDelete: (mode) => _deleteTaskByChoice(task.id, mode),
    onTagSelect: async (value) => {
      if (contextTasks.length > 1) return _batchControl.applyContextTag(contextTasks, value);
      await Store.updateTask(task.id, { tagId: value });
      hideTaskTagMenu();
    },
  });
}

// ── DOM refs ─────────────────────────────────────────
let $thead, $tbody, $dialog;
let $dayLabel;
let $taskDayPrev, $taskDayNext, $listToday;
let $tagFilterSel;
let $dayTotal, $dayTagTotals;
let $sideMonthSummary, $sideDaySummary;
let $emptyState;
let $daySummaryWrap, $daySummaryMeta, $daySummaryText, $daySummaryComment, $daySummaryHighlights;
let $dayWeather;
let $dayInsightInput, $dayInsightSend, $dayInsightReply, $dayInsightMeta;
let _settingsDialogControl;

// ── 初期化 ────────────────────────────────────────────
let _initialized = false;
let _root = null;
export function init(rootEl) {
  if (_initialized) return; // 二重初期化を防ぐ
  _initialized = true;
  _root = rootEl;
  _settings = Store.getSettings();
  _cacheDOM();
  ensureTaskTagMenu();
  _wireToolbar();
  _wireDayInsightInput();
  _wireMiniCalendar();
  _wireDialog();
  _wireNewTaskButton();
  _wireSettingsButton();
  wireSideTagClickToSettings(_root, () => _settingsDialogControl);

  Store.subscribe("tasks", () => _render());
  Store.subscribe("tags",  () => _render());
  Store.subscribe("ai-summaries", () => _render());
  Store.subscribe("ai-notes", () => {
    if (_root.hidden) return;
    const dateKey = formatDateKey(_selectedDate);
    _renderDaySummaryBubble(dateKey, Store.getTasksByDate(dateKey));
    _renderInsightMeta(dateKey);
  });
  Store.subscribe("settings", () => {
    _settings = Store.getSettings();
    if (_root.hidden) return;
    const dateKey = formatDateKey(_selectedDate);
    void _renderTaskDayWeather(dateKey);
    _render();
  });

  _selectDate(_resolveInitialDate());

  // コピーボタンのイベントハンドリング（日次集計の括弧内テキストをコピー）
  document.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest(".copySummaryBtn");
    if (!btn) return;
    const text = btn.getAttribute("data-copy-text");
    if (!text) return;

    const original = btn.innerHTML;
    _copyTextToClipboard(text)
      .then(() => {
        btn.innerHTML = checkIconHtml();
        setTimeout(() => { btn.innerHTML = original; }, 1500);
      })
      .catch(() => {
        console.warn("[tasks] clipboard write failed");
        btn.innerHTML = errorIconHtml();
        setTimeout(() => { btn.innerHTML = original; }, 1500);
      });
  });
}

/**
 * クリップボードへコピーする。Clipboard API が使えない環境（file:// 等）では
 * 一時 textarea + execCommand("copy") にフォールバックする。
 */
async function _copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // フォールバックへ
    }
  }

  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  if (!ok) throw new Error("clipboard copy failed");
}

// ── 初期表示日の解決 ─────────────────────────────────
function _resolveInitialDate() {
  const candidate = getInitialViewDate();
  const candidateKey = formatDateKey(candidate);

  // 候補日に表示できる予定があればそのまま使う
  const candidateTasks = Store.getTasksByDate(candidateKey)
    .filter((t) => Store.taskDurationMinutes(t) > 0);
  if (candidateTasks.length > 0) return candidate;

  // 候補日に予定がない場合、全予定から最近の日付を探す
  const allVisibleDates = Array.from(
    new Set(
      Store.getAllTasks()
        .filter((t) => Store.taskDurationMinutes(t) > 0)
        .map((t) => String(t.date ?? ""))
        .filter(Boolean)
    )
  );
  if (allVisibleDates.length === 0) return candidate;

  const baseTime = candidate.getTime();
  allVisibleDates.sort(
    (a, b) =>
      Math.abs(parseLocalDate(a).getTime() - baseTime) -
      Math.abs(parseLocalDate(b).getTime() - baseTime)
  );
  return parseLocalDate(allVisibleDates[0]);
}

// SPAシェルでタブを再訪した際、他ビューでの日付選択をsessionStorage/URL
// クエリ経由で拾い直す(initは初回マウント時にしか呼ばれないため)。
export function activate() {
  _settings = Store.getSettings();
  _selectDate(_resolveInitialDate());
}

// ── DOM キャッシュ ─────────────────────────────────────
function _cacheDOM() {
  $thead          = _root.querySelector("[data-task-thead]");
  $tbody          = _root.querySelector("[data-task-tbody]");
  $dialog         = _root.querySelector("[data-task-dialog]");
  $dayLabel       = _root.querySelector("[data-task-day-label]");
  $taskDayPrev    = _root.querySelector("[data-task-day-prev]");
  $taskDayNext    = _root.querySelector("[data-task-day-next]");
  $listToday      = _root.querySelector("[data-list-today]");
  $tagFilterSel   = _root.querySelector("[data-tag-filter]");
  $dayTotal       = _root.querySelector("[data-day-total]");
  $dayTagTotals   = _root.querySelectorAll("[data-tag-total]");
  $sideMonthSummary = _root.querySelector("[data-side-month-summary]");
  $sideDaySummary = _root.querySelector("[data-side-day-summary]");
  $emptyState     = _root.querySelector("[data-task-empty-state]");
  $daySummaryWrap = _root.querySelector("[data-day-summary-wrap]");
  $daySummaryMeta = _root.querySelector("[data-day-summary-meta]");
  $daySummaryText = _root.querySelector("[data-day-summary-text]");
  $daySummaryComment = _root.querySelector("[data-day-summary-comment]");
  $daySummaryHighlights = _root.querySelector("[data-day-summary-highlights]");
  $dayWeather = _root.querySelector("[data-task-day-weather]");
  $dayInsightInput = _root.querySelector("[data-day-insight-input]");
  $dayInsightSend = _root.querySelector("[data-day-insight-send]");
  $dayInsightReply = _root.querySelector("[data-day-insight-reply]");
  $dayInsightMeta = _root.querySelector("[data-day-insight-meta]");
}

function _setDaySummaryComment(text) {
  if (!$daySummaryComment) return;
  const value = String(text ?? "").trim();
  $daySummaryComment.textContent = value;
  $daySummaryComment.hidden = value.length === 0;
}

function _renderDaySummaryBubble(dateKey, dayTasks) {
  if (!$daySummaryWrap || !$daySummaryMeta || !$daySummaryText || !$daySummaryHighlights) return;

  const allDayTasks = Array.isArray(dayTasks) ? dayTasks : [];
  const notes = Store.getDailyNotes(dateKey);
  if (allDayTasks.length === 0) {
    $daySummaryWrap.hidden = true;
    $daySummaryText.textContent = "";
    _setDaySummaryComment("");
    $daySummaryMeta.textContent = "";
    $daySummaryHighlights.innerHTML = "";
    return;
  }

  let summary = Store.getDailySummary(dateKey);
  const summaryExcluded = shouldSkipDailySummary(dateKey, allDayTasks);
  if (summaryExcluded && summary) {
    Store.deleteDailySummary(dateKey);
    summary = null;
  }

  if (summaryExcluded) {
    $daySummaryWrap.hidden = false;
    $daySummaryMeta.textContent = translate('ui.ded7ba9926', { p0: (formatDateJP(parseLocalDate(dateKey))), p1: (allDayTasks.length), p2: (notes.length) });
    $daySummaryText.textContent = translate('ui.f74cd68ca7');
    $daySummaryHighlights.innerHTML = "";
    return;
  }

  const todayKey = formatDateKey(new Date());
  if (!summary && dateKey < todayKey && isAiConfigured()
    && !_summaryGeneratingDates.has(dateKey) && !_summaryAttemptedDates.has(dateKey)) {
    _summaryGeneratingDates.add(dateKey);
    _summaryAttemptedDates.add(dateKey);
    void summarizeDay(dateKey)
      .catch((e) => {
        console.warn("[tasks] summarizeDay failed:", e);
      })
      .finally(() => {
        _summaryGeneratingDates.delete(dateKey);
      });
  }

  $daySummaryWrap.hidden = false;
  $daySummaryMeta.textContent = translate('ui.ded7ba9926', { p0: (formatDateJP(parseLocalDate(dateKey))), p1: (allDayTasks.length), p2: (notes.length) });

  if (!summary) {
    const generating = _summaryGeneratingDates.has(dateKey);
    $daySummaryText.textContent = !isAiConfigured()
      ? translate('ui.fb12c74329')
      : generating
        ? translate('ui.da24ace836')
        : translate('ui.9a1375af30');
    _setDaySummaryComment("");
    $daySummaryHighlights.innerHTML = "";
    return;
  }

  $daySummaryText.textContent = String(summary.summaryText ?? "");
  _setDaySummaryComment(String(summary.comment ?? ""));
  $daySummaryHighlights.innerHTML = "";
  (summary.highlights ?? []).slice(0, 3).forEach((line) => {
    const li = document.createElement("li");
    li.textContent = String(line ?? "");
    $daySummaryHighlights.appendChild(li);
  });
}

function _setInsightBusy(nextBusy) {
  _insightBusy = Boolean(nextBusy);
  if ($dayInsightSend instanceof HTMLButtonElement) {
    $dayInsightSend.disabled = _insightBusy;
    if (!$dayInsightSend.dataset.idleLabel) {
      $dayInsightSend.dataset.idleLabel = $dayInsightSend.textContent || translate('ui.2923874991');
    }
    $dayInsightSend.textContent = _insightBusy
      ? translate('ui.917b1c1f18')
      : ($dayInsightSend.dataset.idleLabel || translate('ui.2923874991'));
  }
  if ($dayInsightInput instanceof HTMLTextAreaElement) {
    $dayInsightInput.disabled = _insightBusy;
  }
}

function _renderInsightMeta(dateKey) {
  if (!$dayInsightMeta) return;
  const notes = Store.getDailyNotes(dateKey);
  $dayInsightMeta.textContent = translate('ui.02fe6cf82f', { p0: (formatDateJP(parseLocalDate(dateKey))), p1: (notes.length) });
}

async function _renderTaskDayWeather(dateKey) {
  if (_root.hidden) return;
  if (!$dayWeather) return;
  const token = ++_dayWeatherRenderToken;
  $dayWeather.classList.add("loading");
  $dayWeather.textContent = translate('ui.e766dd8d41');

  try {
    const weather = await getWeatherByDate(dateKey);
    if (token !== _dayWeatherRenderToken || _root.hidden) return;
    $dayWeather.classList.remove("loading");
    $dayWeather.textContent = formatWeatherForDisplay(weather);
  } catch (e) {
    console.warn("[tasks] weather rendering failed:", e);
    if (token !== _dayWeatherRenderToken || _root.hidden) return;
    $dayWeather.classList.remove("loading");
    $dayWeather.textContent = translate('ui.545c4f248f');
  }
}

async function _sendDayInsight() {
  if (!$dayInsightInput || !$dayInsightReply) return;
  if (_insightBusy) return;

  const dateKey = formatDateKey(_selectedDate);
  const text = String($dayInsightInput.value ?? "").trim();
  if (!text) {
    $dayInsightInput.focus();
    return;
  }

  _setInsightBusy(true);
  $dayInsightReply.textContent = translate('ui.aff8fa69cb');

  try {
    const note = Store.addDailyNote(dateKey, text, { source: "tasks-user-note" });
    if (!note) throw new Error("failed to save daily note");

    const summary = await summarizeDay(dateKey, { overwrite: true });
    $dayInsightInput.value = "";
    _renderDaySummaryBubble(dateKey, Store.getTasksByDate(dateKey));
    _renderInsightMeta(dateKey);

    $dayInsightReply.textContent = summary
      ? translate('ui.f93b3cee1c')
      : !isAiConfigured()
        ? translate('ui.21aa07d6bc')
        : translate('ui.920234e636');
  } catch (e) {
    console.error("[tasks] day insight send failed:", e);
    $dayInsightReply.textContent = translate('ui.e956fdabb0');
  } finally {
    _setInsightBusy(false);
  }
}

function _wireDayInsightInput() {
  $dayInsightSend?.addEventListener("click", () => {
    void _sendDayInsight().catch((e) => {
      console.error("[tasks] day insight send failed (uncaught):", e);
      if ($dayInsightReply) {
        $dayInsightReply.textContent = translate('ui.7bb8edb0ed');
      }
      _setInsightBusy(false);
    });
  });

  $dayInsightInput?.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key !== "Enter") return;
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    void _sendDayInsight().catch((err) => {
      console.error("[tasks] day insight send failed (uncaught):", err);
      if ($dayInsightReply) {
        $dayInsightReply.textContent = translate('ui.7bb8edb0ed');
      }
      _setInsightBusy(false);
    });
  });
}

// ── ツールバー ─────────────────────────────────────────
function _wireToolbar() {
  _batchControl = wireTaskBatch(_root, Store, {onFocus:id=>_setFocusedTaskRow(id??'')});
  $taskDayPrev?.addEventListener("click", () => _selectDate(addDays(_selectedDate, -1)));
  $taskDayNext?.addEventListener("click", () => _selectDate(addDays(_selectedDate, +1)));
  $listToday?.addEventListener("click",   () => _selectDate(new Date()));

  wireSidebarToggle(_root);

  $tagFilterSel?.addEventListener("change", () => {
    const val = $tagFilterSel.value;
    _tagFilter = (val === "__all__") ? "" : val;
    _render();
  });

  // ソート (F-LIST-006)
  $thead?.addEventListener("click", (e) => {
    const targetEl = e.target instanceof Element ? e.target : e.target?.parentElement;
    const th = targetEl?.closest("th[data-sort]");
    if (!th) return;
    const key = String(th.getAttribute("data-sort") ?? "");
    const sortable = new Set(["startTime", "endTime", "title", "tag", "duration"]);
    if (!sortable.has(key)) return;
    if (_sortCol?.key === key) {
      _sortCol = { key, dir: _sortCol.dir === "asc" ? "desc" : "asc" };
    } else {
      _sortCol = { key, dir: "asc" };
    }
    _render();
  });

  document.addEventListener("keydown", (e) => {
    if (_root.hidden || document.querySelector('dialog[open]')) return;
    const active = document.activeElement?.tagName;
    if (active === "INPUT" || active === "TEXTAREA" || active === "SELECT") return;
    if ($dialog?.open) return;
    if (e.key !== "Delete" || e.ctrlKey || e.metaKey) return;
    if (!_focusedTaskId) return;
    e.preventDefault();
    void _deleteTaskByChoice(_focusedTaskId);
  });
}

// ── 日付選択 ───────────────────────────────────────────
function _selectDate(date) {
  _batchControl?.clear();
  _selectedDate = new Date(date);
  _selectedDate.setHours(0, 0, 0, 0);
  const dateKey = syncViewDate(_selectedDate);
  if ($dayInsightInput) $dayInsightInput.value = "";
  if ($dayInsightReply) {
    $dayInsightReply.textContent = translate('ui.f6d3613523');
  }
  if ($dayLabel) $dayLabel.textContent = formatDateJP(_selectedDate);
  _miniCalInst?.highlightDate(formatDateKey(_selectedDate));
  _miniCalInst?.navigateToMonth(_selectedDate.getFullYear(), _selectedDate.getMonth());
  _renderInsightMeta(dateKey || formatDateKey(_selectedDate));
  void _renderTaskDayWeather(dateKey || formatDateKey(_selectedDate));
  _render();
}

function _renderEmptyState(dateKey, visibleTasks) {
  if (!$emptyState) return;
  if (visibleTasks.length > 0) {
    $emptyState.hidden = true;
    $emptyState.textContent = "";
    return;
  }

  const allTasks = Store.getAllTasks();
  if (allTasks.length === 0) {
    $emptyState.hidden = false;
    $emptyState.textContent = translate('ui.5b6097779a');
    return;
  }

  const otherDates = Array.from(new Set(
    allTasks
      .map((task) => String(task.date ?? ""))
      .filter((taskDate) => taskDate && taskDate !== dateKey)
  )).sort();

  if (otherDates.length === 0) {
    $emptyState.hidden = false;
    $emptyState.textContent = translate('ui.0fc51bc7a1', { p0: (formatDateJP(_selectedDate)) });
    return;
  }

  const nearestDates = otherDates
    .slice()
    .sort((left, right) => Math.abs(parseLocalDate(left) - _selectedDate) - Math.abs(parseLocalDate(right) - _selectedDate))
    .slice(0, 3)
    .map((taskDate) => formatDateJP(parseLocalDate(taskDate)));

  $emptyState.hidden = false;
  $emptyState.textContent = translate('ui.076b47e53b', { p0: (formatDateJP(_selectedDate)), p1: (nearestDates.join(" / ")) });
}

// ── 描画 ──────────────────────────────────────────────
function _render() {
  if (!$tbody || _root.hidden) return;
  $thead?.querySelectorAll('[data-sort]').forEach(th => th.setAttribute('aria-sort', th.dataset.sort === _sortCol?.key ? (_sortCol.dir === 'asc' ? 'ascending' : 'descending') : 'none'));
  hideTaskTagMenu();
  const dateKey  = formatDateKey(_selectedDate);
  const yearMonth = formatYearMonth(_selectedDate);
  const allDayTasks = Store.getTasksByDate(dateKey);
  const monthTags = Store.getTagsForMonth(yearMonth);
  const allTags = Store.getAllTags();
  const tags = monthTags.length ? monthTags : allTags;
  const tagById = new Map(allTags.map((t) => [String(t.id ?? ""), t]));

  function _tagName(task) {
    const tagId = String(task?.tagId ?? "");
    return String(tagById.get(tagId)?.name ?? "");
  }

  // タグフィルタセレクトの選択肢を最新のタグで同期
  _syncTagFilter(tags);
  _renderDaySummaryBubble(dateKey, allDayTasks);

  let tasks = allDayTasks;
  if (_tagFilter) tasks = tasks.filter((t) => t.tagId === _tagFilter);

  // ソート
  if (_sortCol) {
    const { key, dir } = _sortCol;
    tasks = tasks.slice().sort((a, b) => {
      let cmp = 0;

      if (key === "startTime" || key === "endTime") {
        const av = a[key] ? timeToMinutes(a[key]) : Number.MAX_SAFE_INTEGER;
        const bv = b[key] ? timeToMinutes(b[key]) : Number.MAX_SAFE_INTEGER;
        cmp = av - bv;
      } else if (key === "duration") {
        cmp = Store.taskDurationMinutes(a) - Store.taskDurationMinutes(b);
      } else if (key === "tag") {
        cmp = _tagName(a).localeCompare(_tagName(b), getLocale());
      } else if (key === "title") {
        cmp = String(a.title ?? "").localeCompare(String(b.title ?? ""), getLocale());
      }

      if (cmp === 0 && key === "startTime") {
        const aEnd = a.endTime ? timeToMinutes(a.endTime) : Number.MAX_SAFE_INTEGER;
        const bEnd = b.endTime ? timeToMinutes(b.endTime) : Number.MAX_SAFE_INTEGER;
        cmp = aEnd - bEnd;
      }

      if (cmp === 0) {
        cmp = String(a.id ?? "").localeCompare(String(b.id ?? ""), "ja");
      }

      if (cmp === 0) return 0;
      if (dir === "asc") return cmp < 0 ? -1 : 1;
      return cmp < 0 ? 1 : -1;
    });
  }

  // 一覧では工数0分のタスク（終日含む）を表示しない
  tasks = tasks.filter((t) => Store.taskDurationMinutes(t) > 0);
  _renderEmptyState(dateKey, tasks);

  $tbody.innerHTML = "";
  tasks.forEach((task) => {
    const tag     = tags.find((t) => t.id === task.tagId) || allTags.find((t) => t.id === task.tagId);
    const minutes = Store.taskDurationMinutes(task);
    const isRecurring = task?.recurrence?.type && task.recurrence.type !== "none";
    const tr      = document.createElement("tr");
    tr.setAttribute("data-task-id", task.id);
    tr.innerHTML = `
      <td>${escHtml(task.startTime ?? "──")}</td>
      <td>${escHtml(task.endTime   ?? "──")}</td>
      <td class="taskTitleCell"${isRecurring ? " data-recurring=\"1\"" : ""}>${escHtml(task.title || translate('ui.6ada6dbdde'))}</td>
      <td><span class="taskTagBadge${tag ? '' : ' isUntagged'}"${tag ? ` style="background:${escHtml(tag.color)}22;border-color:${escHtml(tag.color)}66"` : ''}>${escHtml(tag?.name || translate('ui.af1cc864e3'))}</span></td>
      <td>${formatDurationHtml(minutes)}</td>
      <td class="taskActions">
        <button class="btn" type="button" data-edit aria-label="${translateHtml('ui.11f9049dda')}" title="${translateHtml('ui.11f9049dda')}">${editIconHtml()}</button>
        <button class="btn danger" type="button" data-del aria-label="${translateHtml('ui.e9653dc3ed')}" title="${translateHtml('ui.e9653dc3ed')}">${deleteIconHtml()}</button>
      </td>
    `;

    tr.querySelector("[data-edit]")?.addEventListener("click", () => openEditDialog($dialog, task, _getDialogTagsForDateKey(task.date, task.tagId)));
    tr.querySelector("[data-del]")?.addEventListener("click", () => {
      void _deleteTaskByChoice(task.id);
    });

    tr.addEventListener("click", () => {
      _setFocusedTaskRow(task.id);
    });

    tr.addEventListener("dblclick", () => {
      openEditDialog($dialog, task, _getDialogTagsForDateKey(task.date, task.tagId));
    });

    tr.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      _openTaskTagMenu(task, e.clientX, e.clientY, tr);
    });

    $tbody.appendChild(tr);
  });

  if (_focusedTaskId && !tasks.some((t) => t.id === _focusedTaskId)) {
    _setFocusedTaskRow("");
  } else if (_focusedTaskId) {
    _setFocusedTaskRow(_focusedTaskId);
  }

  _renderDayTotals(dateKey, tags);
  renderSideSummaries({ monthEl: $sideMonthSummary, dayEl: $sideDaySummary, Store, dateKey });
}

function _syncTagFilter(tags) {
  if (!$tagFilterSel) return;
  const current = $tagFilterSel.value;
  $tagFilterSel.innerHTML = `<option value="__all__">${translateHtml('ui.bb7d147bc0')}</option>` +
    tags.map((t) => `<option value="${escHtml(t.id)}"${t.id === current ? " selected" : ""}>${escHtml(t.name)}</option>`).join("");
}

function _renderDayTotals(dateKey, tags) {
  const { total, byTag } = Store.calcDaySummary(dateKey);
  const titlesByTag = new Map();
  const allTags = Store.getAllTags();
  const tagById = new Map(allTags.map((t) => [String(t.id ?? ""), t]));

  Store.getTasksByDate(dateKey)
    .filter((task) => Store.taskDurationMinutes(task) > 0)
    .slice()
    .sort((a, b) => {
      const aStart = a.startTime ? timeToMinutes(a.startTime) : Number.MAX_SAFE_INTEGER;
      const bStart = b.startTime ? timeToMinutes(b.startTime) : Number.MAX_SAFE_INTEGER;
      if (aStart !== bStart) return aStart - bStart;

      const aEnd = a.endTime ? timeToMinutes(a.endTime) : Number.MAX_SAFE_INTEGER;
      const bEnd = b.endTime ? timeToMinutes(b.endTime) : Number.MAX_SAFE_INTEGER;
      if (aEnd !== bEnd) return aEnd - bEnd;

      return String(a.id ?? "").localeCompare(String(b.id ?? ""), "ja");
    })
    .forEach((task) => {
      const tagId = String(task.tagId ?? "").trim();
      if (!tagId) return;
      const title = String(task.title ?? "").trim() || translate('ui.6ada6dbdde');
      const list = titlesByTag.get(tagId) ?? [];
      if (!list.includes(title)) list.push(title);
      titlesByTag.set(tagId, list);
    });

  if ($dayTotal) $dayTotal.innerHTML = formatDurationHtml(total);

  $dayTagTotals?.forEach((el) => {
    const tagId = el.getAttribute("data-tag-total");
    el.innerHTML = formatDurationHtml(byTag.get(tagId) ?? 0);
  });

  // 日次集計ブロック（動的生成箇所）
  const dynEl = _root.querySelector("[data-day-tag-summary-dynamic]");
  if (dynEl) {
    const preferredOrder = tags.map((t) => String(t.id ?? ""));
    const usedTagIds = Array.from(byTag.keys()).filter((id) => (byTag.get(id) ?? 0) > 0);
    const orderedTagIds = [
      ...preferredOrder.filter((id) => usedTagIds.includes(id)),
      ...usedTagIds.filter((id) => !preferredOrder.includes(id)),
    ];

    dynEl.innerHTML = orderedTagIds
      .map((tagId) => {
      const mins = byTag.get(tagId) ?? 0;
      const tag = tagById.get(tagId);
      const tagName = String(tag?.name ?? translate('ui.af1cc864e3'));
      const tagColor = String(tag?.color ?? "#888");
      const titles = titlesByTag.get(tagId) ?? [];
      const titleText = titles.join("、");
      const titleLabel = titles.length ? `（${escHtml(titleText)}）` : "";
      return `<div class="tag">
        <div class="name"><span class="swatch" style="background:${escHtml(tagColor)}"></span><span class="tagNameLabel">${escHtml(tagName)}</span>${titleLabel ? `<span class="tagTaskTitles"><span class="tagTaskTitlesText">${titleLabel}</span>${titleText ? `<button class="copySummaryBtn" type="button" aria-label="${translateHtml('ui.4beb295c47')}" title="${translateHtml('ui.4beb295c47')}" data-copy-text="${escHtml(titleText)}">${copyIconHtml()}</button>` : ""}</span>` : ""}</div>
        <span class="tagRowRight">
          <span class="small" data-tag-total="${escHtml(tagId)}">${formatDurationHtml(mins)}</span><button class="copySummaryBtn" type="button" aria-label="${translateHtml('ui.15eaf2f54e')}" title="${translateHtml('ui.15eaf2f54e')}" data-copy-text="${Math.round(mins)}">${copyIconHtml()}</button>
        </span>
      </div>`;
      }).join("");
  }
}

// ── 設定ダイアログ ────────────────────────────────────
function _wireSettingsButton() {
  const settingsDialog = document.querySelector("[data-settings-dialog]");
  if (!settingsDialog) return;
  _settingsDialogControl = wireSettingsDialog(settingsDialog, Store, {
    getTagMgrSeedDate: () => _selectedDate,
    onAfterSave: (patch) => {
      _settings = { ...Store.getSettings(), ...patch };
      _render();
    },
    getWeatherLocationOptions,
    triggerRoot: _root,
  });
}

// ── ミニカレンダー ─────────────────────────────────────
function _wireMiniCalendar() {
  _miniCalInst = setupMiniCalendar({
    containerEl:  _root.querySelector("[data-mini-cal]"),
    monthLabelEl: _root.querySelector("[data-mini-month-label]"),
    prevBtn:      _root.querySelector("[data-mini-month-prev]"),
    nextBtn:      _root.querySelector("[data-mini-month-next]"),
    collapseBtn: _root.querySelector("[data-mini-calendar-toggle]"),
    onDateSelect: (date) => _selectDate(date),
    initialDate:  new Date(),
    getHolidaysInMonth: (year, month) => getCombinedHolidaysInMonth(year, month, _settings),
  });

  wireMonthTagPopup(_root.querySelector("[data-mini-month-label]"), Store);
}

// ── ダイアログ ────────────────────────────────────────
function _wireNewTaskButton() {
  _root.querySelectorAll("[data-new-task]").forEach((btn) => {
    btn.addEventListener("click", () => {
      openCreateDialog($dialog, {
        date: formatDateKey(_selectedDate),
        tags: _getDialogTagsForDateKey(formatDateKey(_selectedDate)),
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
    if (!form.title) { await showAppAlert(translate('ui.f611575d37'), {tone:'error'}); return; }
    const { editScope, ...taskPatch } = form;

    const saveBtn = $dialog.querySelector("[data-save]");
    _saving = true;
    if (saveBtn) { saveBtn.disabled = true; saveBtn.dataset.origText = saveBtn.textContent; saveBtn.textContent = translate('ui.ff509c9ba0'); }
    try {
      const editId = $dialog.getAttribute("data-edit-id");
      if (editId) {
        const updated = await updateTaskByChoice(Store, editId, taskPatch, editScope || "single");
        if (!updated) return;
      } else {
        await Store.createTask({ ...taskPatch, date: taskPatch.date || formatDateKey(_selectedDate) });
      }
      $dialog.close();
    } catch (error) {
      await showAppAlert(translate('ui.20817f47e9', { p0: (String(error?.message ?? error)) }), {tone:'error'});
    } finally {
      _saving = false;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = saveBtn.dataset.origText || translate('ui.a3030bf8f1'); }
    }
  };

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

  $dialog.querySelector("[data-delete]")?.addEventListener("click", async () => {
    const editId = $dialog.getAttribute("data-edit-id");
    if (editId) {
      if (await _deleteTaskByChoice(editId)) $dialog.close();
    }
  });

  $dialog.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
    if (e.target.closest('button')) return;
    if (e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    void saveTask();
  });

  // 時刻ピッカー初期化
  $dialog.querySelectorAll("[data-time-picker]").forEach(setupTimePicker);
}
