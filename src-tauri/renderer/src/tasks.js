/**
 * tasks.js — タスク一覧ページのロジック
 *
 * 要件カバー:
 *   F-LIST-001〜006, F-WH-001〜005
 */

import * as Store from "./store.js";
import { buildUiPalette } from "./ui-colors.js";
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
  normalizeHexColor,
  DEFAULT_TAG_COLOR,
  wireSidebarToggle,
  renderSideSummaries,
  wireMonthTagPopup,
  ensureTaskTagMenu,
  hideTaskTagMenu,
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
function _chooseDeleteModeForTask(task) {
  const count = Store.getTaskSeriesCount(task);
  if (count <= 1) return "single";
  const answer = window.prompt("削除方法: 1=選択した予定のみ / 2=繰り返し予定をすべて / 3=今日以降すべて", "1");
  if (answer == null) return null;
  const token = String(answer).trim();
  if (token === "2") return "series";
  if (token === "3") return "future";
  return "single";
}

async function _deleteTaskByChoice(taskId, preferredMode = null) {
  const task = Store.getAllTasks().find((t) => t.id === taskId);
  if (!task) return;
  const mode = preferredMode ?? _chooseDeleteModeForTask(task);
  if (!mode) return;
  await Store.deleteTaskWithMode(taskId, mode);
  if (_focusedTaskId === taskId) _setFocusedTaskRow("");
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

    btn.addEventListener("click", async () => {
      await Store.updateTask(task.id, { tagId: value });
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
    const dateKey = formatDateKey(_selectedDate);
    _renderDaySummaryBubble(dateKey, Store.getTasksByDate(dateKey));
    _renderInsightMeta(dateKey);
  });
  Store.subscribe("settings", () => {
    _settings = Store.getSettings();
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

    const original = btn.textContent;
    _copyTextToClipboard(text)
      .then(() => {
        btn.textContent = "✓";
        setTimeout(() => { btn.textContent = original; }, 1500);
      })
      .catch(() => {
        console.warn("[tasks] clipboard write failed");
        btn.textContent = "✗";
        setTimeout(() => { btn.textContent = original; }, 1500);
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
    $daySummaryMeta.textContent = `${formatDateJP(parseLocalDate(dateKey))} | タスク${allDayTasks.length}件 | メモ${notes.length}件`;
    $daySummaryText.textContent = "この日は休日で、タグ未設定の予定のみのためAIサマリーは作成しません。";
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
  $daySummaryMeta.textContent = `${formatDateJP(parseLocalDate(dateKey))} | タスク${allDayTasks.length}件 | メモ${notes.length}件`;

  if (!summary) {
    const generating = _summaryGeneratingDates.has(dateKey);
    $daySummaryText.textContent = !isAiConfigured()
      ? "AIの接続先を設定すると、日次サマリーを自動で作ります（⚙設定 →「基本」→「AI」）。"
      : generating
        ? "この日のサマリーをAIで作成中です。"
        : "この日のサマリーはまだありません。過去の日を開いたとき、または気づきを保存したときに作ります。";
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
      $dayInsightSend.dataset.idleLabel = $dayInsightSend.textContent || "保存してサマリー反映";
    }
    $dayInsightSend.textContent = _insightBusy
      ? "保存中..."
      : ($dayInsightSend.dataset.idleLabel || "保存してサマリー反映");
  }
  if ($dayInsightInput instanceof HTMLTextAreaElement) {
    $dayInsightInput.disabled = _insightBusy;
  }
}

function _renderInsightMeta(dateKey) {
  if (!$dayInsightMeta) return;
  const notes = Store.getDailyNotes(dateKey);
  $dayInsightMeta.textContent = `${formatDateJP(parseLocalDate(dateKey))} | 既存メモ${notes.length}件`;
}

async function _renderTaskDayWeather(dateKey) {
  if (!$dayWeather) return;
  const token = ++_dayWeatherRenderToken;
  $dayWeather.classList.add("loading");
  $dayWeather.textContent = "天気取得中...";

  try {
    const weather = await getWeatherByDate(dateKey);
    if (token !== _dayWeatherRenderToken) return;
    $dayWeather.classList.remove("loading");
    $dayWeather.textContent = formatWeatherForDisplay(weather);
  } catch (e) {
    console.warn("[tasks] weather rendering failed:", e);
    if (token !== _dayWeatherRenderToken) return;
    $dayWeather.classList.remove("loading");
    $dayWeather.textContent = "天気取得に失敗しました";
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
  $dayInsightReply.textContent = "入力内容を保存し、今日のサマリーへ直接反映中...";

  try {
    const note = Store.addDailyNote(dateKey, text, { source: "tasks-user-note" });
    if (!note) throw new Error("failed to save daily note");

    const summary = await summarizeDay(dateKey, { overwrite: true });
    $dayInsightInput.value = "";
    _renderDaySummaryBubble(dateKey, Store.getTasksByDate(dateKey));
    _renderInsightMeta(dateKey);

    $dayInsightReply.textContent = summary
      ? "今日のサマリーへ直接反映しました。修正があれば、この入力欄やAIモードのチャットで追記してください。"
      : !isAiConfigured()
        ? "メモは保存しました。AIの接続先を設定すると、サマリーにも反映されます。"
        : "メモは保存しました。サマリーには反映できませんでした(サマリー対象外の日、またはAIの呼び出しに失敗)。";
  } catch (e) {
    console.error("[tasks] day insight send failed:", e);
    $dayInsightReply.textContent = "気づき保存またはサマリー反映に失敗しました。時間をおいて再試行してください。";
  } finally {
    _setInsightBusy(false);
  }
}

function _wireDayInsightInput() {
  $dayInsightSend?.addEventListener("click", () => {
    void _sendDayInsight().catch((e) => {
      console.error("[tasks] day insight send failed (uncaught):", e);
      if ($dayInsightReply) {
        $dayInsightReply.textContent = "保存処理で予期しないエラーが発生しました。再試行してください。";
      }
      _setInsightBusy(false);
    });
  });

  $dayInsightInput?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    void _sendDayInsight().catch((err) => {
      console.error("[tasks] day insight send failed (uncaught):", err);
      if ($dayInsightReply) {
        $dayInsightReply.textContent = "保存処理で予期しないエラーが発生しました。再試行してください。";
      }
      _setInsightBusy(false);
    });
  });
}

// ── ツールバー ─────────────────────────────────────────
function _wireToolbar() {
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
  _selectedDate = new Date(date);
  _selectedDate.setHours(0, 0, 0, 0);
  const dateKey = syncViewDate(_selectedDate);
  if ($dayInsightInput) $dayInsightInput.value = "";
  if ($dayInsightReply) {
    $dayInsightReply.textContent = "この日の思ったことや気づいたことを入力して保存すると、今日のサマリーへ直接反映します。";
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
    $emptyState.textContent = "保存済みの予定はありません。";
    return;
  }

  const otherDates = Array.from(new Set(
    allTasks
      .map((task) => String(task.date ?? ""))
      .filter((taskDate) => taskDate && taskDate !== dateKey)
  )).sort();

  if (otherDates.length === 0) {
    $emptyState.hidden = false;
    $emptyState.textContent = `${formatDateJP(_selectedDate)} に表示対象の予定はありません。`;
    return;
  }

  const nearestDates = otherDates
    .slice()
    .sort((left, right) => Math.abs(parseLocalDate(left) - _selectedDate) - Math.abs(parseLocalDate(right) - _selectedDate))
    .slice(0, 3)
    .map((taskDate) => formatDateJP(parseLocalDate(taskDate)));

  $emptyState.hidden = false;
  $emptyState.textContent = `${formatDateJP(_selectedDate)} に表示対象の予定はありません。他の日付には予定があります: ${nearestDates.join(" / ")}`;
}

// ── 描画 ──────────────────────────────────────────────
function _render() {
  if (!$tbody) return;
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
        cmp = _tagName(a).localeCompare(_tagName(b), "ja");
      } else if (key === "title") {
        cmp = String(a.title ?? "").localeCompare(String(b.title ?? ""), "ja");
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
      <td class="taskTitleCell"${isRecurring ? " data-recurring=\"1\"" : ""}>${escHtml(task.title || "無題")}</td>
      <td><span class="taskTagBadge" style="background:${escHtml(tag?.color ?? "#888")}22;border-color:${escHtml(tag?.color ?? "#888")}66">${escHtml(tag?.name ?? "")}</span></td>
      <td>${formatDurationHtml(minutes)}</td>
      <td class="taskActions">
        <button class="btn" type="button" data-edit aria-label="編集">✎</button>
        <button class="btn danger" type="button" data-del aria-label="削除">✕</button>
      </td>
    `;

    tr.querySelector("[data-edit]")?.addEventListener("click", () => openEditDialog($dialog, task, tags));
    tr.querySelector("[data-del]")?.addEventListener("click", () => {
      void _deleteTaskByChoice(task.id);
    });

    tr.addEventListener("click", () => {
      _setFocusedTaskRow(task.id);
    });

    tr.addEventListener("dblclick", () => {
      openEditDialog($dialog, task, tags);
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
  $tagFilterSel.innerHTML = `<option value="__all__">全て</option>` +
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
      const title = String(task.title ?? "").trim() || "無題";
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
      const tagName = String(tag?.name ?? "タグなし");
      const tagColor = String(tag?.color ?? "#888");
      const titles = titlesByTag.get(tagId) ?? [];
      const titleText = titles.join("、");
      const titleLabel = titles.length ? `（${escHtml(titleText)}）` : "";
      return `<div class="tag">
        <div class="name"><span class="swatch" style="background:${escHtml(tagColor)}"></span><span class="tagNameLabel">${escHtml(tagName)}</span>${titleLabel ? `<span class="tagTaskTitles"><span class="tagTaskTitlesText">${titleLabel}</span>${titleText ? `<button class="copySummaryBtn" type="button" aria-label="コピー" data-copy-text="${escHtml(titleText)}">📋</button>` : ""}</span>` : ""}</div>
        <span class="tagRowRight">
          <span class="small" data-tag-total="${escHtml(tagId)}">${formatDurationHtml(mins)}</span><button class="copySummaryBtn" type="button" aria-label="分数をコピー" data-copy-text="${Math.round(mins)}">📋</button>
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
    if (!form.title) { alert("タイトルを入力してください。"); return; }
    const { editScope, ...taskPatch } = form;

    const saveBtn = $dialog.querySelector("[data-save]");
    _saving = true;
    if (saveBtn) { saveBtn.disabled = true; saveBtn.dataset.origText = saveBtn.textContent; saveBtn.textContent = "保存中…"; }
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
      alert(`予定を保存できませんでした。\n${String(error?.message ?? error)}`);
    } finally {
      _saving = false;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = saveBtn.dataset.origText || "保存"; }
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
