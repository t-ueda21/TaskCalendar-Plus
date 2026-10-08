import { t as translate, th as translateHtml, weekdayLabels } from './i18n.js';
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
const WEEKDAYS = weekdayLabels();

const WELCOME_MESSAGE = () => [
  translate('ui.86ce342e4a'),
  "",
  translate('ui.02b863889f'),
  translate('ui.7da97b8bce'),
  translate('ui.8a063e51cf'),
  translate('ui.68215d7f60'),
  "",
  translate('ui.c73927c87c'),
].join("\n");

const SETUP_MESSAGE = () => [
  translate('ui.75470d60bd'),
  "",
  translate('ui.e86898bcbd'),
  translate('ui.14175555c8'),
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
  label.textContent = translate('ui.c6d7aa14f1');
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
  const tick = () => { elapsed.textContent = translate('ui.8e73cdfe82', { p0: (Math.floor((Date.now() - startedAt) / 1000)) }); };
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
    $.askBtn.textContent = busy ? translate('ui.ca4d973c0b') : translate('ui.a6c1ceaf4b');
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
  const time = task.allDay ? translate('ui.0aff5cf2d8') : `${task.startTime}〜${task.endTime}`;
  return `${_dateLabel(task.date)} ${time}`;
}

const ACTION_LABELS = { get create() { return translate('ui.50f5f9e681'); }, get update() { return translate('ui.07fc6daa5f'); }, get delete() { return translate('ui.a14cee8184'); } };
const STATUS_LABELS = { get applied() { return translate('ui.b45c497caf'); }, get dismissed() { return translate('ui.958b5cd4de'); }, get failed() { return translate('ui.195e9b8a56'); } };
const FIELD_LABELS = { get date() { return translate('ui.666819e178'); }, get startTime() { return translate('ui.cc147e162c'); }, get endTime() { return translate('ui.8f26d43810'); }, get allDay() { return translate('ui.0aff5cf2d8'); }, get title() { return translate('ui.a20f57232e'); }, get tagName() { return translate('ui.302eafc71d'); }, get memo() { return translate('ui.99fa5c96e0'); } };

function _proposalRows(proposal) {
  const task = proposal.task ?? {};
  if (proposal.action === "update") {
    const before = proposal.before ?? {};
    return Object.keys(FIELD_LABELS)
      .filter((key) => JSON.stringify(before[key] ?? "") !== JSON.stringify(task[key] ?? ""))
      .map((key) => [FIELD_LABELS[key], `${_fieldText(key, before[key])} → ${_fieldText(key, task[key])}`])
      .concat([[translate('ui.b8e1cf9f89'), `${_taskLabel(before)} ${before.title ?? ""}`]]);
  }
  return [
    [translate('ui.11b74db9d1'), _taskLabel(task)],
    [translate('ui.a20f57232e'), task.title ?? ""],
    [translate('ui.302eafc71d'), task.tagName ? `${task.tagName}${proposal.newTag ? translate('ui.d0bd1c2904') : ""}` : translate('ui.868310e193')],
    ...(task.memo ? [[translate('ui.99fa5c96e0'), task.memo]] : []),
  ];
}

function _fieldText(key, value) {
  if (key === "allDay") return value ? translate('ui.0aff5cf2d8') : translate('ui.9c4da99579');
  if (key === "date" && value) return _dateLabel(value);
  return String(value ?? "") || translate('ui.868310e193');
}

function _renderProposalCard(proposal, { dateKey, messageId }) {
  const card = document.createElement("div");
  card.className = `aiProposal aiProposal-${proposal.action}`;
  const title = document.createElement("div");
  title.className = "aiProposalTitle";
  title.textContent = ACTION_LABELS[proposal.action] ?? translate('ui.46adc49713');
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
    confirmBtn.textContent = translate('ui.20db9f87b8');
    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "btn";
    dismissBtn.textContent = translate('ui.2cd0f3be87');
    if (proposal.action === 'create') {
      const label = document.createElement('label');
      const toggle = document.createElement('input'); toggle.type = 'checkbox';
      toggle.checked = proposal.outlookEnabled ?? Store.getSettings().outlookWriteDefault;
      proposal.outlookEnabled = toggle.checked;
      toggle.addEventListener('change', () => { proposal.outlookEnabled = toggle.checked; });
      label.append(toggle, document.createTextNode(translate('ui.3cd1ed84ff')));
      footer.appendChild(label);
    }
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
  if (!tag) throw new Error(translate('ui.0382f629ab', { p0: (name) }));
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
  if (!current) throw new Error(translate('ui.a98306acab'));
  const before = proposal.action === "update" ? proposal.before : proposal.task;
  const currentTag = Store.getAllTags().find(t => t.id === current.tagId)?.name ?? "";
  if (!before || !current.updatedAt
      || (proposal.expectedUpdatedAt && proposal.expectedUpdatedAt !== current.updatedAt)
      || JSON.stringify(_proposalTaskSnapshot(before)) !== JSON.stringify(_proposalTaskSnapshot(current, currentTag))) {
    throw new Error(translate('ui.2a0524f848'));
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
    const created = await Store.createTask({ ...(await fields()), outlookEnabled: proposal.outlookEnabled ?? Store.getSettings().outlookWriteDefault, recurrence: { type: "none" } });
    if (!created) throw new Error(translate('ui.5f61d2c3bb'));
  } else if (proposal.action === "update") {
    const expectedUpdatedAt = await _proposalRevision(proposal);
    const updated = await Store.updateTask(proposal.taskId, await fields(), { expectedUpdatedAt });
    if (!updated) throw new Error(translate('ui.b7a94a4bef'));
  } else if (proposal.action === "delete") {
    const expectedUpdatedAt = await _proposalRevision(proposal);
    await Store.deleteTaskWithMode(proposal.taskId, "single", { expectedUpdatedAt });
  } else {
    throw new Error(translate('ui.73b1d9dcc9'));
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
    _appendMessage({ role: "assistant", text: isAiConfigured() ? WELCOME_MESSAGE() : SETUP_MESSAGE() });
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
    _appendMessage({ role: "assistant", text: SETUP_MESSAGE() });
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
    const answer = reply.content || translate('ui.f5d59c00eb');
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
  if (_root.hidden) return;
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
    $.modelStatus.textContent = translate('ui.3bb1d8d6af');
    $.modelStatus.title = translate('ui.7cb8457bcc');
    return;
  }
  const provider = String(_settings.aiProvider);
  const label = Store.AI_PROVIDER_LABELS[provider] ?? provider;
  const modelKey = { "claude-code": "aiClaudeModel", codex: "aiCodexModel", ollama: "aiOllamaModel", lmstudio: "aiLmStudioModel" }[provider];
  const model = String(_settings[modelKey] ?? "").trim() || translate('ui.3f0577f9b1');
  const effort = String((provider === "codex" ? _settings.aiCodexEffort : provider === "claude-code" ? _settings.aiClaudeEffort : "") ?? "").trim();
  const used = getLastUsedModel();
  $.modelStatus.textContent = `AI: ${label} / ${model}${effort ? ` / effort: ${effort}` : ""}${used && used !== model ? translate('ui.73486a16fe', { p0: (used) }) : ""}`;
  $.modelStatus.title = $.modelStatus.textContent;
}

function _setActiveDate(dateKey) {
  const key = formatDateKey(parseLocalDate(dateKey));
  _activeDateKey = key;
  syncViewDate(key);
  const dt = parseLocalDate(key);
  if ($.dayLabel) $.dayLabel.textContent = formatDateJP(dt, { withWeekday: true });
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
    ? translate('ui.59a8b44b57')
    : translate('ui.3f9cf63fb0');
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
      if ($.inputHint) $.inputHint.textContent = translate('ui.6878d4d13d', { p0: (String(error?.message ?? error)) });
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
    if (_root.hidden) return;
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
  _settings = Store.getSettings();
  _renderModelStatus();
  _renderInputMode();
  _setActiveDate(formatDateKey(getInitialViewDate()));
}
