/**
 * ai-mode.js
 *
 * AIモードタブ。AI(Claude Code / Codex)がアプリのMCPサーバーの道具で予定・作業記録を調べて答える。
 * 予定の作成・変更・削除はAIが「提案」し、チャットの確認カードで［確定］を押したときだけ実行する。
 * 会話は選択中の日付ごとに保存する。
 */

import * as Store from "./store.js";
import { renderMarkdown } from "./markdown.js";
import {
  formatDateKey,
  formatDateJP,
  parseLocalDate,
  addDays,
  setupMiniCalendar,
  getInitialViewDate,
  syncViewDate,
  getCombinedHolidaysInMonth,
  DEFAULT_TAG_COLOR,
  wireSidebarToggle,
  renderSideSummaries,
} from "./ui-utils.js";
import { wireSettingsDialog, wireSideTagClickToSettings } from "./settings-dialog.js";
import { chatWithAgent, cancelAi, getLastUsedModel, isAiConfigured } from "./ai-client.js";
import { todayDateKeyInJst } from "./ai-memory.js";
import { getWeatherLocationOptions } from "./weather.js";

const HISTORY_TURNS = 12; // AIに渡す直近の会話の数
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const WELCOME_MESSAGE = [
  "予定や作業記録について、なんでも聞いてください。予定の作成・変更・削除もできます。",
  "",
  "- 先週の火曜は何してた？",
  "- 9月に設計レビューに何時間使った？",
  "- 今月あとどれくらい工数使える？",
  "- 明日の15時から16時に設計会議を入れて",
  "",
  "予定の作成・変更・削除は確認カードで［確定］を押したときに反映されます。Ctrl+Enter で送信できます。",
].join("\n");

const SETUP_MESSAGE = [
  "AIモードを使うには、AIの接続先の設定が必要です。",
  "",
  "⚙設定 →「基本」→「AI」で「Claude Code / Codex と連携する」をオンにし、接続先を選んでください。",
  "このPCに Claude Code または Codex がインストール・ログイン済みである必要があります。",
].join("\n");

let _settings = Store.getSettings();
let _activeDateKey = formatDateKey(getInitialViewDate());
let _miniCalInst = null;
let _busy = false;
let _sendCancelled = false;
let _root = null;
let _initialized = false;
let _settingsDialogControl = null;
const $ = {};

// ── 待機表示 ─────────────────────────────────────────────

let _loadingTimerId = 0;

function _showLoading() {
  _hideLoading();
  const wrap = document.createElement("div");
  wrap.className = "aiMsg assistant aiLoadingMsg";
  wrap.setAttribute("data-ai-loading-indicator", "1");
  const bubble = document.createElement("div");
  bubble.className = "aiBubble aiLoadingBubble";
  const label = document.createElement("span");
  label.className = "aiLoadingText";
  label.textContent = "AIが記録を調べています";
  const dots = document.createElement("span");
  dots.className = "aiLoadingDots";
  dots.setAttribute("aria-hidden", "true");
  dots.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
  const elapsed = document.createElement("span");
  elapsed.className = "aiLoadingElapsed small";
  bubble.append(label, dots, elapsed);
  wrap.appendChild(bubble);
  $.chatLog.appendChild(wrap);
  $.chatLog.scrollTop = $.chatLog.scrollHeight;

  const startedAt = Date.now();
  const tick = () => { elapsed.textContent = `（${Math.floor((Date.now() - startedAt) / 1000)}秒）`; };
  tick();
  _loadingTimerId = window.setInterval(tick, 1000);
}

function _hideLoading() {
  window.clearInterval(_loadingTimerId);
  _loadingTimerId = 0;
  $.chatLog?.querySelector("[data-ai-loading-indicator]")?.remove();
}

function _setBusy(busy) {
  _busy = busy;
  if ($.input) $.input.disabled = busy;
  if ($.askBtn) {
    $.askBtn.textContent = busy ? "停止" : "送信";
    $.askBtn.classList.toggle("danger", busy);
  }
  if (busy) _showLoading();
  else _hideLoading();
}

// ── 提案(確認カード) ───────────────────────────────────────

function _dateLabel(dateKey) {
  const dt = parseLocalDate(dateKey);
  return `${dt.getMonth() + 1}/${dt.getDate()}(${WEEKDAYS[dt.getDay()]})`;
}

function _taskLabel(task) {
  const time = task.allDay ? "終日" : `${task.startTime}〜${task.endTime}`;
  return `${_dateLabel(task.date)} ${time}`;
}

const ACTION_LABELS = { create: "予定の作成", update: "予定の変更", delete: "予定の削除" };
const STATUS_LABELS = { applied: "反映しました", dismissed: "取り消しました", failed: "反映できませんでした" };
const FIELD_LABELS = { date: "日付", startTime: "開始", endTime: "終了", allDay: "終日", title: "タイトル", tagName: "タグ", memo: "メモ" };

function _proposalRows(proposal) {
  const task = proposal.task ?? {};
  if (proposal.action === "update") {
    const before = proposal.before ?? {};
    return Object.keys(FIELD_LABELS)
      .filter((key) => JSON.stringify(before[key] ?? "") !== JSON.stringify(task[key] ?? ""))
      .map((key) => [FIELD_LABELS[key], `${_fieldText(key, before[key])} → ${_fieldText(key, task[key])}`])
      .concat([["対象", `${_taskLabel(before)} ${before.title ?? ""}`]]);
  }
  return [
    ["日時", _taskLabel(task)],
    ["タイトル", task.title ?? ""],
    ["タグ", task.tagName ? `${task.tagName}${proposal.newTag ? "（新しいタグ）" : ""}` : "なし"],
    ...(task.memo ? [["メモ", task.memo]] : []),
  ];
}

function _fieldText(key, value) {
  if (key === "allDay") return value ? "終日" : "時刻指定";
  if (key === "date" && value) return _dateLabel(value);
  return String(value ?? "") || "なし";
}

function _renderProposalCard(proposal, { dateKey, messageId }) {
  const card = document.createElement("div");
  card.className = `aiProposal aiProposal-${proposal.action}`;
  const title = document.createElement("div");
  title.className = "aiProposalTitle";
  title.textContent = ACTION_LABELS[proposal.action] ?? "提案";
  card.appendChild(title);

  const table = document.createElement("dl");
  table.className = "aiProposalRows";
  _proposalRows(proposal).forEach(([label, value]) => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    table.append(dt, dd);
  });
  card.appendChild(table);

  const footer = document.createElement("div");
  footer.className = "aiProposalActions";
  const renderFooter = (status, errorMessage = "") => {
    footer.replaceChildren();
    if (status && status !== "pending") {
      const done = document.createElement("span");
      done.className = `aiProposalStatus ${status}`;
      done.textContent = errorMessage || STATUS_LABELS[status] || status;
      footer.appendChild(done);
      return;
    }
    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = `btn ${proposal.action === "delete" ? "danger" : "primary"}`;
    confirmBtn.textContent = "確定";
    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "btn";
    dismissBtn.textContent = "取消";
    confirmBtn.addEventListener("click", async () => {
      confirmBtn.disabled = true;
      dismissBtn.disabled = true;
      let next = "applied";
      let errorMessage = "";
      try {
        await _applyProposal(proposal);
      } catch (e) {
        console.error("[ai-mode] apply proposal failed:", e);
        next = "failed";
        errorMessage = String(e?.message ?? e);
      }
      Store.updateAiChatProposalStatus(dateKey, messageId, proposal.id, next);
      renderFooter(next, errorMessage);
    });
    dismissBtn.addEventListener("click", () => {
      Store.updateAiChatProposalStatus(dateKey, messageId, proposal.id, "dismissed");
      renderFooter("dismissed");
    });
    footer.append(confirmBtn, dismissBtn);
  };
  renderFooter(proposal.status);
  card.appendChild(footer);
  return card;
}

/** タグ名からタグIDを求める。無ければ作成し、その月のタグ順にも加える(画面に表示されるように)。 */
async function _ensureTagId(tagName, dateKey) {
  const name = String(tagName ?? "").trim();
  if (!name) return "";
  let tag = Store.getAllTags().find((t) => String(t.name ?? "").toLowerCase() === name.toLowerCase());
  if (!tag) tag = await Store.createTag({ name, color: DEFAULT_TAG_COLOR });
  if (!tag) throw new Error(`タグ「${name}」を作成できませんでした`);
  const yearMonth = String(dateKey).slice(0, 7);
  const ids = Store.hasMonthTagOrder(yearMonth) ? Store.getTagsForMonth(yearMonth).map((t) => t.id) : [];
  if (!ids.includes(tag.id)) await Store.setMonthTagOrder(yearMonth, [...ids, tag.id]);
  return tag.id;
}

function _proposalTaskSnapshot(task, tagName = task?.tagName) {
  const allDay = Boolean(task?.isAllDay ?? task?.allDay);
  return {
    title: String(task?.title ?? ""), date: String(task?.date ?? ""), allDay,
    startTime: allDay ? "" : String(task?.startTime ?? ""),
    endTime: allDay ? "" : String(task?.endTime ?? ""),
    tagName: String(tagName ?? ""), memo: String(task?.memo ?? ""),
  };
}

async function _proposalRevision(proposal) {
  // Refresh first; comparing only the cached task misses changes from Outlook or another view.
  await Store.refreshTasks();
  const current = Store.getAllTasks().find(t => t.id === proposal.taskId);
  if (!current) throw new Error("対象の予定が見つかりません。最新の内容で依頼し直してください。");
  const before = proposal.action === "update" ? proposal.before : proposal.task;
  const currentTag = Store.getAllTags().find(t => t.id === current.tagId)?.name ?? "";
  if (!before || !current.updatedAt
      || (proposal.expectedUpdatedAt && proposal.expectedUpdatedAt !== current.updatedAt)
      || JSON.stringify(_proposalTaskSnapshot(before)) !== JSON.stringify(_proposalTaskSnapshot(current, currentTag))) {
    throw new Error("この予定は提案後に変更されています。最新の内容でAIに依頼し直してください。");
  }
  // The backend checks this revision atomically too, covering changes after this refresh.
  return current.updatedAt;
}

async function _applyProposal(proposal) {
  const task = proposal.task ?? {};
  const fields = async () => ({
    title: task.title,
    date: task.date,
    isAllDay: Boolean(task.allDay),
    startTime: task.allDay ? "" : task.startTime,
    endTime: task.allDay ? "" : task.endTime,
    tagId: await _ensureTagId(task.tagName, task.date),
    memo: task.memo ?? "",
  });
  if (proposal.action === "create") {
    const created = await Store.createTask({ ...(await fields()), recurrence: { type: "none" } });
    if (!created) throw new Error("予定を作成できませんでした");
  } else if (proposal.action === "update") {
    const expectedUpdatedAt = await _proposalRevision(proposal);
    const updated = await Store.updateTask(proposal.taskId, await fields(), { expectedUpdatedAt });
    if (!updated) throw new Error("予定を変更できませんでした");
  } else if (proposal.action === "delete") {
    const expectedUpdatedAt = await _proposalRevision(proposal);
    await Store.deleteTaskWithMode(proposal.taskId, "single", { expectedUpdatedAt });
  } else {
    throw new Error("予定の提案を読み取れませんでした。");
  }
}

// ── チャット ────────────────────────────────────────────────

function _appendMessage({ role, text, proposals = [], id = "", dateKey = _activeDateKey }) {
  const wrap = document.createElement("div");
  wrap.className = `aiMsg ${role === "user" ? "user" : "assistant"}`;
  const bubble = document.createElement("div");
  if (role === "user") {
    bubble.className = "aiBubble";
    bubble.textContent = text;
  } else {
    // AIの回答はMarkdownとして表示する(renderMarkdown はHTMLをエスケープしてから記法だけを変換する)。
    bubble.className = "aiBubble markdown";
    bubble.innerHTML = renderMarkdown(text);
    proposals.forEach((proposal) => bubble.appendChild(_renderProposalCard(proposal, { dateKey, messageId: id })));
  }
  wrap.appendChild(bubble);
  $.chatLog.appendChild(wrap);
  $.chatLog.scrollTop = $.chatLog.scrollHeight;
}

function _renderChatHistory() {
  if (!$.chatLog) return;
  _hideLoading();
  $.chatLog.replaceChildren();
  const rows = Store.getAiChatHistory(_activeDateKey);
  if (!rows.length) {
    _appendMessage({ role: "assistant", text: isAiConfigured() ? WELCOME_MESSAGE : SETUP_MESSAGE });
    return;
  }
  rows.forEach((row) => _appendMessage({ role: row.role, text: row.text, proposals: row.proposals, id: row.id, dateKey: _activeDateKey }));
}

function _cancelSend() {
  _sendCancelled = true;
  cancelAi();
}

async function _send() {
  if (_busy || !$.input) return;
  const text = String($.input.value ?? "").trim();
  if (!text) return;
  const dateKey = _activeDateKey;

  if (!isAiConfigured()) {
    _appendMessage({ role: "assistant", text: SETUP_MESSAGE });
    return;
  }

  // Reserve sending before the first await so a slow refresh cannot admit a second send.
  _sendCancelled = false;
  _setBusy(true);
  try {
    await Store.refreshTasks().catch((e) => console.warn("[ai-mode] refreshTasks failed:", e));
    if (_sendCancelled) return;
    const history = Store.getAiChatHistory(dateKey)
      .slice(-HISTORY_TURNS)
      .map((row) => ({ role: row.role, content: row.text }));
    const saved = Store.addAiChatMessage(dateKey, { role: "user", text });
    _appendMessage({ role: "user", text, id: saved?.id, dateKey });
    $.input.value = "";
    _showLoading();
    const reply = await chatWithAgent([...history, { role: "user", content: text }]);
    if (_sendCancelled) return;
    const answer = reply.content || "内容を確認して、下のカードで確定してください。";
    const message = Store.addAiChatMessage(dateKey, { role: "assistant", text: answer, proposals: reply.proposals });
    if (dateKey === _activeDateKey) {
      _appendMessage({ role: "assistant", text: answer, proposals: message?.proposals ?? [], id: message?.id, dateKey });
    }
  } catch (e) {
    const message = String(e?.message ?? e);
    if (!e?.cancelled) console.warn("[ai-mode] agent failed:", e);
    if (!_sendCancelled && dateKey === _activeDateKey) _appendMessage({ role: "assistant", text: message });
  } finally {
    _setBusy(false);
    _renderModelStatus();
  }
}

// ── サイドバー・表示 ────────────────────────────────────────

function _renderSideSummaries() {
  renderSideSummaries({
    monthEl: $.sideMonth,
    dayEl: $.sideDay,
    Store,
    dateKey: _activeDateKey,
  });
}

function _renderModelStatus() {
  if (!$.modelStatus) return;
  if (!isAiConfigured()) {
    $.modelStatus.textContent = "AI: 未設定（⚙設定 → 基本 → AI）";
    $.modelStatus.title = "設定画面の「AI」で Claude Code / Codex との連携をオンにすると使えます";
    return;
  }
  const provider = String(_settings.aiProvider);
  const label = Store.AI_PROVIDER_LABELS[provider] ?? provider;
  const model = String((provider === "codex" ? _settings.aiCodexModel : _settings.aiClaudeModel) ?? "").trim() || "既定";
  const effort = String((provider === "codex" ? _settings.aiCodexEffort : _settings.aiClaudeEffort) ?? "").trim();
  const used = getLastUsedModel();
  $.modelStatus.textContent = `AI: ${label} / ${model}${effort ? ` / effort: ${effort}` : ""}${used && used !== model ? `（実行: ${used}）` : ""}`;
  $.modelStatus.title = $.modelStatus.textContent;
}

function _setActiveDate(dateKey) {
  const key = formatDateKey(parseLocalDate(dateKey));
  _activeDateKey = key;
  syncViewDate(key);
  const dt = parseLocalDate(key);
  if ($.dayLabel) $.dayLabel.textContent = formatDateJP(dt);
  _miniCalInst?.highlightDate(key);
  _miniCalInst?.navigateToMonth(dt.getFullYear(), dt.getMonth());
  _renderChatHistory();
  _renderSideSummaries();
}

// ── 初期化 ─────────────────────────────────────────────────

function _renderInputMode() {
  const enabled = _settings.aiEnterToSend === true;
  $.enterToggle?.setAttribute("aria-checked", String(enabled));
  if ($.inputHint) $.inputHint.textContent = enabled
    ? "Enterで送信 / Shift+Enterで改行"
    : "Enterで改行 / Ctrl+Enterで送信";
}

function _wire() {
  $.askBtn?.addEventListener("click", () => (_busy ? _cancelSend() : void _send()));
  $.input?.addEventListener("keydown", (e) => {
    // 変換候補の確定Enterは送信に使わない(keyCode=229もIME入力)。
    if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
    const send = !e.shiftKey && !e.altKey && ((e.ctrlKey || e.metaKey) || _settings.aiEnterToSend === true);
    if (send) {
      e.preventDefault();
      if (!e.repeat) void _send();
    }
  });
  $.enterToggle?.addEventListener("click", async () => {
    $.enterToggle.disabled = true;
    try {
      await Store.updateSettings({ aiEnterToSend: _settings.aiEnterToSend !== true });
    } catch (error) {
      if ($.inputHint) $.inputHint.textContent = `送信設定を保存できませんでした。もう一度お試しください。${String(error?.message ?? error)}`;
    } finally {
      $.enterToggle.disabled = false;
    }
  });
  _root.querySelector("[data-ai-today]")?.addEventListener("click", () => _setActiveDate(todayDateKeyInJst()));
  _root.querySelector("[data-ai-day-prev]")?.addEventListener("click", () => _setActiveDate(formatDateKey(addDays(parseLocalDate(_activeDateKey), -1))));
  _root.querySelector("[data-ai-day-next]")?.addEventListener("click", () => _setActiveDate(formatDateKey(addDays(parseLocalDate(_activeDateKey), 1))));
  wireSidebarToggle(_root);

  _miniCalInst = setupMiniCalendar({
    containerEl: _root.querySelector("[data-mini-cal]"),
    monthLabelEl: _root.querySelector("[data-mini-month-label]"),
    prevBtn: _root.querySelector("[data-mini-month-prev]"),
    nextBtn: _root.querySelector("[data-mini-month-next]"),
    collapseBtn: _root.querySelector("[data-mini-calendar-toggle]"),
    onDateSelect: (date) => _setActiveDate(formatDateKey(date)),
    initialDate: getInitialViewDate(),
    getHolidaysInMonth: (year, month) => getCombinedHolidaysInMonth(year, month, _settings),
  });

  const settingsDialog = document.querySelector("[data-settings-dialog]");
  if (settingsDialog) {
    _settingsDialogControl = wireSettingsDialog(settingsDialog, Store, {
      getTagMgrSeedDate: () => parseLocalDate(_activeDateKey),
      getWeatherLocationOptions,
      triggerRoot: _root,
    });
  }
  wireSideTagClickToSettings(_root, () => _settingsDialogControl);
}

export function init(rootEl) {
  if (_initialized) return;
  _initialized = true;
  _root = rootEl;
  _settings = Store.getSettings();
  Object.assign($, {
    dayLabel: _root.querySelector("[data-ai-day-label]"),
    chatLog: _root.querySelector("[data-ai-chat-log]"),
    input: _root.querySelector("[data-ai-input]"),
    askBtn: _root.querySelector("[data-ai-ask]"),
    enterToggle: _root.querySelector("[data-ai-enter-toggle]"),
    inputHint: _root.querySelector("[data-ai-input-hint]"),
    sideMonth: _root.querySelector("[data-side-month-summary]"),
    sideDay: _root.querySelector("[data-side-day-summary]"),
    modelStatus: _root.querySelector("[data-ai-model-current]"),
  });
  _wire();
  _renderModelStatus();
  _renderInputMode();

  Store.subscribe("tasks", _renderSideSummaries);
  Store.subscribe("tags", _renderSideSummaries);
  Store.subscribe("settings", () => {
    _settings = Store.getSettings();
    _renderModelStatus();
    _renderInputMode();
    _renderSideSummaries(); // タグ管理(月ごとのタグ順)の変更を反映
    // 会話の無い日は、AIの設定状態に合わせて案内文(使い方/設定方法)を出し直す。
    if (!_busy && !Store.getAiChatHistory(_activeDateKey).length) _renderChatHistory();
  });

  _setActiveDate(formatDateKey(getInitialViewDate()));
}

// SPAシェルでタブを再訪したとき、他のタブで選んだ日付を拾い直す(init は初回だけ呼ばれる)。
export function activate() {
  _setActiveDate(formatDateKey(getInitialViewDate()));
}
