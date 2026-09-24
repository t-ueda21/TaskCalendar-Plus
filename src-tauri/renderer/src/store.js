/**
 * store.js — TaskCalendar+ データ層
 *
 * タスク・タグ・設定・AI関連データを、Rust側の組み込みHTTP API(SQLite)経由で永続化し、
 * 購読者(subscriber)への変更通知を行う。
 *
 * セキュリティ: ユーザ入力は UI 層でサニタイズ済みであることを前提とするが、
 * API 読み込み時も型チェックを行い不正値を弾く。
 */

import { normalizeCompanyHolidayEntries } from "./company-holidays.js";
import { normalizeQuickLinks } from "./settings-transfer.js";
import { DEFAULT_UI_COLOR, normalizeUiColor } from "./ui-colors.js";
import {
  normalizeBreaks, normalizeUrlAutoOpenTimes, _isDateKey, _normalizeDateKey, timeToMinutes, minutesToTime,
  formatDateKey, formatYearMonth, parseLocalDate,
} from "./ui-utils.js";

// AIの接続先。"none"(既定)のときはAIを呼ばない。
export const AI_PROVIDER_LABELS = {
  none: "使わない",
  "claude-code": "Claude Code",
  codex: "Codex",
};
const DEFAULT_APP_ICON_SIZE = 24;

function _normalizeAiProvider(value) {
  const token = String(value ?? "").trim();
  return Object.prototype.hasOwnProperty.call(AI_PROVIDER_LABELS, token) ? token : "none";
}

// effort(推論の深さ)の選択肢。空欄はCLIの既定。Rust側(ai_cli.rs)と揃える。
const AI_EFFORT_LEVELS = {
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};

function _normalizeEffort(provider, value) {
  const token = String(value ?? "").trim();
  return AI_EFFORT_LEVELS[provider].includes(token) ? token : "";
}

function _normalizeShortText(value) {
  return String(value ?? "").trim().slice(0, 200);
}

// ── デフォルト値 ──────────────────────────────────────
const DEFAULT_SETTINGS = {
  workStart:           "09:00",
  workEnd:             "18:00",
  // 休憩時間帯ごとに工数計算へ含めるか選べるようにする。
  // countAsWork=trueの休憩はカレンダー上ではグレー表示されるが工数計算からは除外しない。
  // countAsWork=false(既定の昼休み)は工数計算から除外する。
  breaks:              [{ start: "12:00", end: "13:00", countAsWork: false }],
  workWeekDays:        ["Mon","Tue","Wed","Thu","Fri"],
  showBusinessDaysOnly: true,
  granularity:         30,
  urlAutoOpenEnabled: false,
  urlAutoOpenUrl:    "",
  urlAutoOpenTimes:  [],
  quickLinks:        [], // [{ label, url }] ヘッダーに表示するリンク
  uiAccentColor: DEFAULT_UI_COLOR,
  companyHolidays:  [],
  companyHolidayEntries: [],
  aiProvider:          "none",
  aiEnterToSend:       false,
  checkUpdatesOnStartup: true,
  aiCliEnabled:        false, // Claude Code / Codex と連携するか(既定はオフ。オフの間はこの2つを選べない)
  aiClaudeEffort:      "low", // AIモードの用途では low で十分なことが多く、応答が速い
  aiCodexEffort:       "low",
  aiClaudeModel:       "",
  aiCodexModel:        "",
  appIconUrl:          "",
  appIconSize:         DEFAULT_APP_ICON_SIZE,
  weatherLocationKey:  "tokyo",
  monthTagOrders:      {}, // { "YYYY-MM": [tagId, ...] }
  outlookAutoSync: false, // Outlookの予定を勝手に取り込まないよう、既定はOFF(設定のOutlookタブで有効化する)
  outlookAutoSyncIntervalMin: 10,
  outlookSyncCalendarName: "Calendar",
  outlookSyncTagId: "",
  outlookSyncDaysAhead: 90,
  trayEnabled: true, // 「✕」でタスクトレイへ格納するか(Rust側main.rsが起動時に読む)
  startMinimizedToTray: false, // 起動時にタスクトレイのみで起動するか
};

// ── UUID ─────────────────────────────────────────────
function genId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  // fallback: timestamp + random
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

// ── バリデーション ─────────────────────────────────────
const RE_HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

function _normalizeAutoOpenEnabled(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const token = value.trim().toLowerCase();
    if (["false", "0", "off", "no"].includes(token)) return false;
    if (["true", "1", "on", "yes"].includes(token)) return true;
  }
  return Boolean(DEFAULT_SETTINGS.urlAutoOpenEnabled);
}

function _cloneCompanyHolidayEntries(entries) {
  return Array.isArray(entries)
    ? entries.map((row) => ({
      dateKey: String(row?.dateKey ?? ""),
      name: String(row?.name ?? ""),
    }))
    : [];
}

function _normalizeAppIconUrl(value) {
  const token = String(value ?? "").trim();
  if (!token) return "";
  return token.slice(0, 2048);
}

function _normalizeAppIconSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_APP_ICON_SIZE;
  return Math.max(16, Math.min(96, Math.round(n)));
}

function _normalizeSettings(settingsLike) {
  const merged = (settingsLike && typeof settingsLike === "object")
    ? { ...DEFAULT_SETTINGS, ...settingsLike }
    : { ...DEFAULT_SETTINGS };

  merged.workWeekDays = Array.isArray(merged.workWeekDays)
    ? merged.workWeekDays.map((day) => String(day ?? "")).filter(Boolean)
    : DEFAULT_SETTINGS.workWeekDays.slice();
  if (!merged.workWeekDays.length) {
    merged.workWeekDays = DEFAULT_SETTINGS.workWeekDays.slice();
  }

  // 旧形式(breakStart/breakEnd単一ペア)からの移行。breaks配列が無い場合のみ変換する
  const hasBreaksArray = Array.isArray(settingsLike?.breaks) && settingsLike.breaks.length > 0;
  if (!hasBreaksArray && settingsLike?.breakStart && settingsLike?.breakEnd) {
    merged.breaks = [{ start: settingsLike.breakStart, end: settingsLike.breakEnd }];
  }
  merged.breaks = normalizeBreaks(merged.breaks);
  if (!merged.breaks.length) merged.breaks = DEFAULT_SETTINGS.breaks.map((b) => ({ ...b }));
  delete merged.breakStart;
  delete merged.breakEnd;

  merged.urlAutoOpenEnabled = _normalizeAutoOpenEnabled(merged.urlAutoOpenEnabled);
  merged.urlAutoOpenUrl = String(merged.urlAutoOpenUrl ?? "").trim();
  merged.urlAutoOpenTimes = normalizeUrlAutoOpenTimes(merged.urlAutoOpenTimes);
  merged.quickLinks = normalizeQuickLinks(merged.quickLinks);
  merged.uiAccentColor = normalizeUiColor(merged.uiAccentColor);
  merged.companyHolidayEntries = normalizeCompanyHolidayEntries(merged.companyHolidayEntries ?? merged.companyHolidays);
  merged.companyHolidays = merged.companyHolidayEntries.map((row) => row.dateKey);
  merged.aiCliEnabled = merged.aiCliEnabled === true;
  merged.aiEnterToSend = merged.aiEnterToSend === true;
  merged.checkUpdatesOnStartup = merged.checkUpdatesOnStartup !== false;
  merged.aiProvider = _normalizeAiProvider(merged.aiProvider);
  if (!merged.aiCliEnabled && (merged.aiProvider === "claude-code" || merged.aiProvider === "codex")) {
    merged.aiProvider = "none";
  }
  merged.aiClaudeEffort = _normalizeEffort("claude-code", merged.aiClaudeEffort);
  merged.aiCodexEffort = _normalizeEffort("codex", merged.aiCodexEffort);
  merged.aiClaudeModel = _normalizeShortText(merged.aiClaudeModel);
  merged.aiCodexModel = _normalizeShortText(merged.aiCodexModel);
  merged.appIconUrl = _normalizeAppIconUrl(merged.appIconUrl);
  merged.appIconSize = _normalizeAppIconSize(merged.appIconSize);
  merged.monthTagOrders = _normalizeMonthTagOrders(merged.monthTagOrders);
  return merged;
}

function _normalizeTaskTimeRange(taskLike) {
  if (Boolean(taskLike?.isAllDay)) {
    return { startTime: null, endTime: null };
  }

  const startRaw = String(taskLike?.startTime ?? "09:00");
  const endRaw = String(taskLike?.endTime ?? "10:00");
  if (!RE_HHMM.test(startRaw) || !RE_HHMM.test(endRaw)) {
    return { startTime: startRaw, endTime: endRaw };
  }

  // 手入力時は分単位をそのまま保持し、境界と前後関係のみ補正する。
  let startMins = Math.max(0, Math.min(1439, timeToMinutes(startRaw)));
  let endMins = Math.max(0, Math.min(1440, timeToMinutes(endRaw)));

  // 終了が開始以下のときは最小1分だけ伸ばす。
  if (endMins <= startMins) {
    endMins = Math.min(1440, startMins + 1);
    if (endMins <= startMins) {
      startMins = 1439;
      endMins = 1440;
    }
  }

  return {
    startTime: minutesToTime(startMins),
    endTime: minutesToTime(endMins),
  };
}

// patchがisAllDay/startTime/endTimeのいずれかを含む場合のみ、updatedの時刻を
// 正規化する(updateTask/updateTaskWithModeで共通の判定・適用ロジック)。
function _maybeNormalizeClock(patch, updated) {
  const shouldNormalizeClock =
    Object.prototype.hasOwnProperty.call(patch, "isAllDay") ||
    Object.prototype.hasOwnProperty.call(patch, "startTime") ||
    Object.prototype.hasOwnProperty.call(patch, "endTime");
  if (!shouldNormalizeClock) return;
  const normalizedClock = _normalizeTaskTimeRange(updated);
  updated.startTime = normalizedClock.startTime;
  updated.endTime = normalizedClock.endTime;
}

function validateTask(t) {
  if (!t || typeof t !== "object") return false;
  if (typeof t.id     !== "string" || !t.id)    return false;
  if (typeof t.title  !== "string")              return false;
  if (typeof t.date   !== "string" || !_isDateKey(t.date)) return false;
  if (typeof t.isAllDay !== "boolean")           return false;
  if (!t.isAllDay) {
    if (!RE_HHMM.test(t.startTime)) return false;
    if (!RE_HHMM.test(t.endTime))   return false;
  }
  if (typeof t.tagId !== "string") return false;
  return true;
}

function validateTag(t) {
  if (!t || typeof t !== "object")               return false;
  if (typeof t.id    !== "string" || !t.id)      return false;
  if (typeof t.name  !== "string" || !t.name)    return false;
  if (typeof t.color !== "string" || !/^#[0-9a-fA-F]{3,8}$/.test(t.color)) return false;
  return true;
}

function _normalizeSummary(summaryLike) {
  if (!summaryLike || typeof summaryLike !== "object") return null;
  const date = String(summaryLike.date ?? "").trim();
  if (!_isDateKey(date)) return null;
  const summaryText = String(summaryLike.summaryText ?? "").trim();
  if (!summaryText) return null;

  const highlights = Array.isArray(summaryLike.highlights)
    ? summaryLike.highlights
      .map((v) => String(v ?? "").trim())
      .filter(Boolean)
      .slice(0, 6)
    : [];

  const sourceRefs = Array.isArray(summaryLike.sourceRefs)
    ? summaryLike.sourceRefs
      .filter((v) => v && typeof v === "object")
      .map((v) => ({ ...v }))
      .slice(0, 50)
    : [];

  return {
    id: String(summaryLike.id ?? `summary-${date}`),
    date,
    summaryText,
    comment: String(summaryLike.comment ?? "").trim(),
    mood: String(summaryLike.mood ?? "").trim(),
    highlights,
    sourceRefs,
    createdAt: String(summaryLike.createdAt ?? new Date().toISOString()),
    updatedAt: String(summaryLike.updatedAt ?? new Date().toISOString()),
  };
}

function _normalizeDailyNote(noteLike, fallbackDate = "") {
  if (!noteLike || typeof noteLike !== "object") return null;
  const date = String(noteLike.date ?? fallbackDate ?? "").trim();
  if (!_isDateKey(date)) return null;
  const text = String(noteLike.text ?? "").trim();
  if (!text) return null;

  return {
    id: String(noteLike.id ?? genId()),
    date,
    text,
    source: String(noteLike.source ?? "user").trim() || "user",
    createdAt: String(noteLike.createdAt ?? new Date().toISOString()),
  };
}

function _normalizeAiChatMessage(messageLike, fallbackDate = "") {
  if (!messageLike || typeof messageLike !== "object") return null;

  const date = _normalizeDateKey(messageLike.date ?? fallbackDate);
  if (!date) return null;

  const role = String(messageLike.role ?? "").trim();
  if (role !== "user" && role !== "assistant") return null;

  const text = String(messageLike.text ?? "").trim();
  if (!text) return null;

  // AIエージェントが出した予定の提案(確認カード)と、その状態。
  const proposals = Array.isArray(messageLike.proposals)
    ? messageLike.proposals
      .filter((p) => p && typeof p === "object" && ["create", "update", "delete"].includes(p.action))
      .slice(0, 10)
      .map((p) => ({
        ...JSON.parse(JSON.stringify(p)),
        status: ["pending", "applied", "dismissed", "failed"].includes(p.status) ? p.status : "pending",
      }))
    : [];

  return {
    id: String(messageLike.id ?? genId()),
    date,
    role,
    text,
    proposals,
    createdAt: String(messageLike.createdAt ?? new Date().toISOString()),
  };
}

// ── Pub/Sub ───────────────────────────────────────────
const _subscribers = new Map(); // channel → Set<fn>

function subscribe(channel, fn) {
  if (!_subscribers.has(channel)) _subscribers.set(channel, new Set());
  _subscribers.get(channel).add(fn);
  return () => _subscribers.get(channel)?.delete(fn); // unsubscribe
}

function publish(channel, payload) {
  _subscribers.get(channel)?.forEach((fn) => {
    try { fn(payload); } catch (e) { console.error("[store] subscriber error:", e); }
  });
}

// ── API フラグ ─────────────────────────────────────────
let _runtimeInfo = {};

/** 設定画面「説明」タブのバージョン表示等で使う、サーバーから取得した実行時情報。 */
function getRuntimeInfo() {
  return { ..._runtimeInfo };
}
let _syncReloading = false;

function _strictApiError(action, error) {
  const reason = String(error?.message ?? error ?? "Unknown error");
  return new Error(`${action}に失敗しました。\n${reason}`);
}

async function _failStrictApi(channel, action, error) {
  try {
    await _reloadFromSource(channel);
  } catch {
    // ignore reload failures; original error is more important
  }
  throw _strictApiError(action, error);
}

// 月次の繰り返しは、常に元の開始日(originDay)を基準に月末へ丸める
// (1/31→2/28→3/31→4/30)。直前の日を基準にすると、一度短い月を経由したあと
// 短い日に固定されてしまう(1/31→2/28→3/28→4/28)ため。
function _advanceRecurrenceDate(date, type, originDay) {
  const next = new Date(date);
  if (type === "daily") {
    next.setDate(next.getDate() + 1);
    return next;
  }
  if (type === "weekly") {
    next.setDate(next.getDate() + 7);
    return next;
  }
  if (type === "monthly") {
    const y = next.getFullYear();
    const m = next.getMonth();
    const day = originDay ?? next.getDate();
    const firstOfNext = new Date(y, m + 1, 1);
    const lastDay = new Date(y, m + 2, 0).getDate();
    firstOfNext.setDate(Math.min(day, lastDay));
    return firstOfNext;
  }
  return null;
}

function _normalizeRecurrence(raw, baseDateKey) {
  const typeRaw = String(raw?.type ?? "none");
  const type = ["none", "daily", "weekly", "monthly"].includes(typeRaw) ? typeRaw : "none";
  if (type === "none") return { type: "none" };

  const normalizedBaseDate = _normalizeDateKey(baseDateKey);
  const until = _normalizeDateKey(raw?.until) || normalizedBaseDate;
  const groupId = String(raw?.groupId ?? genId());
  const originDate = _normalizeDateKey(raw?.originDate) || normalizedBaseDate;
  return { type, until, groupId, originDate };
}

function _expandRecurrenceDateKeys(startDateKey, recurrence) {
  if (!_isDateKey(startDateKey)) return [];
  if (!recurrence || recurrence.type === "none") return [startDateKey];

  const untilKey = _isDateKey(recurrence.until) ? recurrence.until : startDateKey;
  if (untilKey < startDateKey) return [startDateKey];

  const startDate = parseLocalDate(startDateKey);
  const originDay = startDate.getDate();

  const result = [];
  let cursor = new Date(startDate);

  for (let i = 0; i < 5000; i++) {
    const key = formatDateKey(cursor);
    if (key > untilKey) break;
    result.push(key);
    const next = _advanceRecurrenceDate(cursor, recurrence.type, originDay);
    if (!next) break;
    cursor = next;
  }
  return result;
}

/**
 * 繰り返し予定で groupId を持たない Outlook由来データに
 * 系列IDベースの groupId を補完し、シリーズ一括操作の整合性を保つ。
 * 読み込み直後の _tasks に対してその場で適用する（in-memory）。
 */
function _backfillRecurrenceGroupIds(tasks) {
  if (!Array.isArray(tasks)) return tasks;
  for (const t of tasks) {
    const rec = t?.recurrence;
    if (!rec || typeof rec !== "object") continue;
    if (!rec.type || rec.type === "none") continue;
    if (rec.groupId) continue;
    if (t.outlookSeriesId) {
      rec.groupId = `series-${String(t.outlookSeriesId)}`;
    }
  }
  return tasks;
}

async function _reloadFromSource(channel = "all") {
  if (_syncReloading) return;
  _syncReloading = true;
  try {
    if (channel === "all" || channel === "tasks") {
      const tasks = await _api.get("/tasks");
      _tasks = _backfillRecurrenceGroupIds(Array.isArray(tasks) ? tasks.filter(validateTask) : []);
      publish("tasks", _tasks);
    }
    if (channel === "all" || channel === "tags") {
      const tags = await _api.get("/tags");
      _tags = Array.isArray(tags) ? tags.filter(validateTag) : [];
      publish("tags", _tags);
    }
    if (channel === "all" || channel === "settings") {
      const settings = await _api.get("/settings");
      _settings = _normalizeSettings(settings);
      publish("settings", _settings);
    }
  } catch (e) {
    console.warn("[store] sync reload failed:", e);
  } finally {
    _syncReloading = false;
  }
}

// ── API ヘルパー ──────────────────────────────────────
const _api = {
  async _request(path, options = {}) {
    const res = await fetch(`/api${path}`, options);
    if (!res.ok) throw new Error(`${options.method || "GET"} /api${path} → ${res.status}`);
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  },
  async get(path) {
    return this._request(path);
  },
  async post(path, body) {
    return this._request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },
  async put(path, body) {
    return this._request(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },
  async del(path) {
    return this._request(path, { method: "DELETE" });
  },
};

function _normalizeMonthTagOrders(monthTagOrders) {
  const source = (monthTagOrders && typeof monthTagOrders === "object") ? monthTagOrders : {};
  const normalized = {};
  Object.keys(source).sort().forEach((month) => {
    const seen = new Set();
    const ids = Array.isArray(source[month]) ? source[month] : [];
    normalized[month] = ids
      .map((id) => String(id ?? "").trim())
      .filter((id) => id && !seen.has(id) && (seen.add(id), true));
  });
  return normalized;
}

// ── タスク CRUD ───────────────────────────────────────
let _tasks = [];

// ── AI用のローカル永続データ（日次サマリー / 日次メモ） ────────
let _dailySummaries = {};
let _dailyNotes = {};
let _dailyAiChats = {};

function _cloneSummary(summary) {
  if (!summary) return null;
  return {
    ...summary,
    highlights: Array.isArray(summary.highlights) ? summary.highlights.slice() : [],
    sourceRefs: Array.isArray(summary.sourceRefs) ? summary.sourceRefs.map((v) => ({ ...v })) : [],
  };
}

// 日次サマリー/日次メモ/AIチャット履歴の生データ(dateKeyごとのマップ)を
// 正規化して_dailySummaries等へ反映する。
function _applyAiMemoryData({ rawSummaries, rawNotes, rawChatHistory }) {
  const nextSummaries = {};
  if (rawSummaries && typeof rawSummaries === "object" && !Array.isArray(rawSummaries)) {
    Object.entries(rawSummaries).forEach(([dateKey, value]) => {
      const summary = _normalizeSummary({ ...(value && typeof value === "object" ? value : {}), date: dateKey });
      if (summary) nextSummaries[summary.date] = summary;
    });
  }
  _dailySummaries = nextSummaries;

  const nextNotes = {};
  if (rawNotes && typeof rawNotes === "object" && !Array.isArray(rawNotes)) {
    Object.entries(rawNotes).forEach(([dateKey, values]) => {
      if (!_isDateKey(dateKey)) return;
      const list = Array.isArray(values) ? values : [];
      const normalized = list
        .map((v) => _normalizeDailyNote(v, dateKey))
        .filter(Boolean)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      if (normalized.length > 0) nextNotes[dateKey] = normalized;
    });
  }
  _dailyNotes = nextNotes;

  const nextChats = {};
  if (rawChatHistory && typeof rawChatHistory === "object" && !Array.isArray(rawChatHistory)) {
    Object.entries(rawChatHistory).forEach(([dateKey, values]) => {
      if (!_isDateKey(dateKey)) return;
      const list = Array.isArray(values) ? values : [];
      const normalized = list
        .map((v) => _normalizeAiChatMessage(v, dateKey))
        .filter(Boolean)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      if (normalized.length > 0) nextChats[dateKey] = normalized;
    });
  }
  _dailyAiChats = nextChats;
}

// SQLite API(ai_memoryテーブル)から日次サマリー/日次メモ/AIチャット履歴を取得する。
async function _loadAiMemoryFromApi() {
  const [rawSummaries, rawNotes, rawChatHistory] = await Promise.all([
    _api.get("/ai-memory/summary"),
    _api.get("/ai-memory/notes"),
    _api.get("/ai-memory/chat"),
  ]);
  _applyAiMemoryData({ rawSummaries, rawNotes, rawChatHistory });
}

// 天気キャッシュ(地点ごと)をSQLite側から取得・保存する。weather.jsから利用する。
async function getWeatherCache(locationKey) {
  return _api.get(`/weather-cache/${encodeURIComponent(locationKey)}`);
}

async function putWeatherCache(locationKey, records) {
  return _api.put(`/weather-cache/${encodeURIComponent(locationKey)}`, records);
}

function _persistSummary(dateKey) {
  const value = _dailySummaries[dateKey] ?? null;
  const request = value === null
    ? _api.del(`/ai-memory/summary/${encodeURIComponent(dateKey)}`)
    : _api.put(`/ai-memory/summary/${encodeURIComponent(dateKey)}`, value);
  request.catch((e) => console.warn("[store] 日次サマリーの保存に失敗しました:", e));
}

function _persistNotes(dateKey) {
  const list = _dailyNotes[dateKey] ?? [];
  _api.put(`/ai-memory/notes/${encodeURIComponent(dateKey)}`, list)
    .catch((e) => console.warn("[store] 日次メモの保存に失敗しました:", e));
}

function _persistChat(dateKey) {
  const list = _dailyAiChats[dateKey] ?? [];
  _api.put(`/ai-memory/chat/${encodeURIComponent(dateKey)}`, list)
    .catch((e) => console.warn("[store] AIチャット履歴の保存に失敗しました:", e));
}

function getDailySummary(dateKey) {
  const key = _normalizeDateKey(dateKey);
  if (!key) return null;
  return _cloneSummary(_dailySummaries[key] ?? null);
}

function getAllDailySummaries() {
  return Object.values(_dailySummaries)
    .map((summary) => _cloneSummary(summary))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function upsertDailySummary(summaryLike) {
  const normalized = _normalizeSummary(summaryLike);
  if (!normalized) return null;

  const prev = _dailySummaries[normalized.date];
  const nowIso = new Date().toISOString();
  const next = {
    ...normalized,
    createdAt: String(prev?.createdAt ?? normalized.createdAt ?? nowIso),
    updatedAt: nowIso,
  };

  _dailySummaries[next.date] = next;
  _persistSummary(next.date);
  publish("ai-summaries", getAllDailySummaries());
  return _cloneSummary(next);
}

function deleteDailySummary(dateKey) {
  const key = _normalizeDateKey(dateKey);
  if (!key) return false;
  if (!_dailySummaries[key]) return false;

  delete _dailySummaries[key];
  _persistSummary(key);
  publish("ai-summaries", getAllDailySummaries());
  return true;
}

function getDailyNotes(dateKey) {
  const key = _normalizeDateKey(dateKey);
  if (!key) return [];
  const list = Array.isArray(_dailyNotes[key]) ? _dailyNotes[key] : [];
  return list.map((note) => ({ ...note }));
}

function addDailyNote(dateKey, text, meta = {}) {
  const normalized = _normalizeDailyNote({
    id: meta.id,
    date: dateKey,
    text,
    source: meta.source ?? "user",
    createdAt: meta.createdAt,
  });
  if (!normalized) return null;

  const key = normalized.date;
  if (!_dailyNotes[key]) _dailyNotes[key] = [];
  _dailyNotes[key].push(normalized);
  _dailyNotes[key].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  _persistNotes(key);
  publish("ai-notes", getDailyNotes(key));
  return { ...normalized };
}

function getAiChatHistory(dateKey) {
  const key = _normalizeDateKey(dateKey);
  if (!key) return [];
  const list = Array.isArray(_dailyAiChats[key]) ? _dailyAiChats[key] : [];
  return list.map((row) => ({
    ...row,
    proposals: Array.isArray(row.proposals) ? row.proposals.map((p) => JSON.parse(JSON.stringify(p))) : [],
  }));
}

/** チャットメッセージの提案(確認カード)の状態を更新して保存する。 */
function updateAiChatProposalStatus(dateKey, messageId, proposalId, status) {
  const key = _normalizeDateKey(dateKey);
  const message = (_dailyAiChats[key] ?? []).find((row) => row.id === messageId);
  const proposal = message?.proposals?.find((p) => p.id === proposalId);
  if (!proposal) return false;
  proposal.status = status;
  _persistChat(key);
  return true;
}

function addAiChatMessage(dateKey, messageLike) {
  const key = _normalizeDateKey(dateKey);
  if (!key) return null;

  const normalized = _normalizeAiChatMessage({ ...(messageLike ?? {}), date: key }, key);
  if (!normalized) return null;

  if (!_dailyAiChats[key]) _dailyAiChats[key] = [];
  _dailyAiChats[key].push(normalized);
  _dailyAiChats[key].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  const overflow = _dailyAiChats[key].length - 200;
  if (overflow > 0) {
    _dailyAiChats[key] = _dailyAiChats[key].slice(overflow);
  }

  _persistChat(key);
  return JSON.parse(JSON.stringify(normalized));
}

/** 全タスク取得 */
function getAllTasks() {
  return _tasks.slice();
}

/** 日付でフィルタ */
function getTasksByDate(dateKey) {
  return _tasks.filter((t) => t.date === dateKey);
}

/** 月でフィルタ (YYYY-MM) */
function getTasksByMonth(yearMonth) {
  return _tasks.filter((t) => t.date.startsWith(yearMonth));
}

function _makeTaskEntity(data, dateKey, recurrence, nowIso) {
  const isAllDay = Boolean(data.isAllDay);
  const normalizedClock = _normalizeTaskTimeRange({
    isAllDay,
    startTime: data.startTime,
    endTime: data.endTime,
  });

  return {
    id:        String(data.id ?? genId()),
    title:     String(data.title  ?? "").trim() || "無題",
    date:      String(dateKey ?? data.date ?? ""),
    isAllDay,
    startTime: normalizedClock.startTime,
    endTime:   normalizedClock.endTime,
    tagId:     String(data.tagId  ?? ""),
    recurrence,
    memo:      String(data.memo   ?? "").trim(),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/** タスク作成 */
async function createTask(data) {
  const now = new Date().toISOString();
  const baseDateKey = _normalizeDateKey(data.date);
  const recurrence = _normalizeRecurrence(data.recurrence, baseDateKey);
  const dateKeys = _expandRecurrenceDateKeys(baseDateKey, recurrence);
  const nextTasks = dateKeys.map((dateKey) => _makeTaskEntity(
    data,
    dateKey,
    recurrence.type === "none" ? { type: "none" } : { ...recurrence },
    now,
  ));

  if (!nextTasks.length || nextTasks.some((task) => !validateTask(task))) {
    console.warn("[store] createTask: invalid data", data);
    return null;
  }

  try {
    const createdTasks = await Promise.all(nextTasks.map((task) => _api.post("/tasks", task)));
    _tasks.push(...createdTasks.filter(validateTask));
    publish("tasks", _tasks);
    return createdTasks[0] ?? null;
  } catch (e) {
    return _failStrictApi("tasks", "予定の保存", e);
  }
}

/** タスク更新 */
async function updateTask(id, patch) {
  const idx = _tasks.findIndex((t) => t.id === id);
  if (idx < 0) return null;

  let recurrence = patch.recurrence;
  if (recurrence !== undefined) {
    const current = _tasks[idx].recurrence;
    const normalized = _normalizeRecurrence(recurrence, String(patch.date ?? _tasks[idx].date ?? ""));
    if (normalized.type !== "none" && current?.groupId && !recurrence?.groupId) {
      normalized.groupId = current.groupId;
      normalized.originDate = current.originDate ?? _tasks[idx].date;
    }
    recurrence = normalized;
  }

  const updated = {
    ..._tasks[idx],
    ...patch,
    ...(recurrence !== undefined ? { recurrence } : {}),
    id,
    updatedAt: new Date().toISOString(),
  };

  _maybeNormalizeClock(patch, updated);

  if (!validateTask(updated)) {
    console.warn("[store] updateTask: invalid patch", updated);
    return null;
  }
  try {
    // 保存済みの単発予定を繰り返しに変える場合も、新規作成と同じ日付展開を行う。
    // 規則を変更したときだけ展開する。単なるタイトル編集で、削除済みの回を復活させない。
    const previousRecurrence = _tasks[idx].recurrence ?? { type: "none" };
    const recurrenceChanged = previousRecurrence.type !== updated.recurrence?.type
      || previousRecurrence.until !== updated.recurrence?.until
      || _tasks[idx].date !== updated.date;
    if (patch.recurrence !== undefined && updated.recurrence?.type !== "none"
      && recurrenceChanged && getTaskSeriesCount(_tasks[idx]) === 1) {
      updated.recurrence = { ...updated.recurrence, originDate: updated.date };
      const dates = _expandRecurrenceDateKeys(updated.date, updated.recurrence);
      const occurrences = dates.slice(1).map(date => _makeTaskEntity(
        { ...updated, id: genId() }, date, { ...updated.recurrence }, updated.updatedAt,
      ));
      if (occurrences.length) {
        const saved = await _api.post(`/tasks/${id}/recurrence`, { expectedUpdatedAt: _tasks[idx].updatedAt, task: updated, occurrences });
        if (!Array.isArray(saved) || saved.length !== dates.length || !saved.every(validateTask)) {
          throw new Error("API returned invalid recurring tasks");
        }
        const first = saved.find(task => task.id === id);
        if (!first) throw new Error("API did not return the original task");
        _tasks = _tasks.map(task => task.id === id ? first : task);
        _tasks.push(...saved.filter(task => task.id !== id));
        publish("task-series-expanded", { taskId: id });
        publish("tasks", _tasks);
        return first;
      }
    }
    const saved = await _api.put(`/tasks/${id}`, updated);
    if (!validateTask(saved)) throw new Error("API returned invalid task");
    _tasks[idx] = saved;
    publish("tasks", _tasks);
    return saved;
  } catch (e) {
    return _failStrictApi("tasks", "予定の更新", e);
  }
}

function _collectSeriesTaskIndexes(target) {
  if (!target) return [];

  const gid = target.recurrence?.groupId;
  if (gid) {
    const result = [];
    _tasks.forEach((t, idx) => {
      if (t.recurrence?.groupId === gid) result.push(idx);
    });
    return result;
  }

  const type = target.recurrence?.type;
  if (!type || type === "none") return [];

  const targetOrigin = String(target.recurrence?.originDate ?? "");
  const targetUntil = String(target.recurrence?.until ?? "");
  const result = [];

  _tasks.forEach((t, idx) => {
    const rec = t.recurrence;
    if (!rec || rec.type !== type) return;

    const byOrigin = targetOrigin && String(rec.originDate ?? "") === targetOrigin;
    const bySignature =
      targetUntil &&
      String(rec.until ?? "") === targetUntil &&
      String(t.title ?? "") === String(target.title ?? "") &&
      String(t.startTime ?? "") === String(target.startTime ?? "") &&
      String(t.endTime ?? "") === String(target.endTime ?? "") &&
      String(t.tagId ?? "") === String(target.tagId ?? "");

    if (byOrigin || bySignature) result.push(idx);
  });

  return result;
}

// calendar.js/tasks.jsで共用する。_collectSeriesTaskIndexesを再利用し、groupId一致を
// 優先、無ければorigin一致またはシグネチャ一致でカウントする。フォールバックでも
// 1件も無ければ単発予定として1を返す。
/** 繰り返しシリーズの件数。単発予定または該当なしの場合は1を返す。 */
function getTaskSeriesCount(task) {
  const indexes = _collectSeriesTaskIndexes(task);
  return indexes.length > 0 ? indexes.length : 1;
}

async function updateTaskWithMode(id, patch, mode = "single") {
  const target = _tasks.find((t) => t.id === id);
  if (!target) return null;

  const isMultiMode = mode === "series" || mode === "future";
  let indexes = isMultiMode ? _collectSeriesTaskIndexes(target) : [];
  // 「今日以降すべて」はtarget自身の日付以降(含む)のみに絞る
  // (Outlookの「これ以降の予定」相当。日付はYYYY-MM-DD形式なので文字列比較で時系列順)。
  if (mode === "future") {
    indexes = indexes.filter((idx) => String(_tasks[idx].date ?? "") >= String(target.date ?? ""));
  }
  if (!isMultiMode || indexes.length <= 1) {
    return updateTask(id, patch);
  }

  const sharedPatch = { ...patch };

  // シリーズ更新時は各予定の date を保持する（全件を同日付にしない）
  if (Object.prototype.hasOwnProperty.call(sharedPatch, "date")) {
    delete sharedPatch.date;
  }

  const nowIso = new Date().toISOString();
  const updatedById = new Map();
  const ensuredGroupId = target.recurrence?.groupId || genId();

  for (const idx of indexes) {
    const current = _tasks[idx];

    let recurrence;
    if (sharedPatch.recurrence !== undefined) {
      recurrence = _normalizeRecurrence(sharedPatch.recurrence, String(current.date ?? ""));
    } else if (current.recurrence !== undefined) {
      recurrence = { ...current.recurrence };
    }

    if (recurrence && recurrence.type !== "none") {
      recurrence.groupId = current.recurrence?.groupId || target.recurrence?.groupId || ensuredGroupId;
      recurrence.originDate = current.recurrence?.originDate ?? target.recurrence?.originDate ?? current.date;
    }

    const updated = {
      ...current,
      ...sharedPatch,
      ...(recurrence !== undefined ? { recurrence } : {}),
      id: current.id,
      date: current.date,
      updatedAt: nowIso,
    };

    _maybeNormalizeClock(sharedPatch, updated);

    if (!validateTask(updated)) {
      console.warn("[store] updateTaskWithMode: invalid patch", updated);
      return null;
    }

    updatedById.set(current.id, updated);
  }

  try {
    const savedTasks = await Promise.all(Array.from(updatedById.values()).map((task) => _api.put(`/tasks/${task.id}`, task)));
    const savedById = new Map(savedTasks.filter(validateTask).map((task) => [task.id, task]));
    _tasks = _tasks.map((t) => savedById.get(t.id) ?? t);
    publish("tasks", _tasks);
    return savedById.get(id) ?? null;
  } catch (e) {
    return _failStrictApi("tasks", "繰り返し予定の更新", e);
  }
}

/** タスク削除 */
async function deleteTaskWithMode(id, mode = "single") {
  const target = _tasks.find((t) => t.id === id);
  if (!target) return;

  let idsToDelete = [id];
  if (mode === "series" || mode === "future") {
    let indexes = _collectSeriesTaskIndexes(target);
    // 「今日以降すべて」はtarget自身の日付以降(含む)のみに絞る
    // (Outlookの「これ以降の予定」相当。日付はYYYY-MM-DD形式なので文字列比較で時系列順)。
    if (mode === "future") {
      indexes = indexes.filter((idx) => String(_tasks[idx].date ?? "") >= String(target.date ?? ""));
    }
    if (indexes.length > 1) {
      idsToDelete = indexes.map((idx) => _tasks[idx].id);
    }
  }

  const deleteSet = new Set(idsToDelete);
  const before = _tasks.length;
  const nextTasks = _tasks.filter((t) => !deleteSet.has(t.id));
  if (nextTasks.length === before) return;

  try {
    await Promise.all(idsToDelete.map((taskId) => _api.del(`/tasks/${taskId}`)));
    _tasks = nextTasks;
    publish("tasks", _tasks);
  } catch (e) {
    return _failStrictApi("tasks", "予定の削除", e);
  }
}

// ── タグ CRUD ────────────────────────────────────────
let _tags = [];

function getAllTags() { return _tags.slice(); }

async function createTag(data) {
  const tag = { id: genId(), name: String(data.name ?? "").trim(), color: String(data.color ?? "#888888") };
  if (!validateTag(tag)) return null;
  try {
    const saved = await _api.post("/tags", tag);
    if (!validateTag(saved)) throw new Error("API returned invalid tag");
    _tags.push(saved);
    publish("tags", _tags);
    return saved;
  } catch (e) {
    return _failStrictApi("tags", "タグの保存", e);
  }
}

async function updateTag(id, patch) {
  const idx = _tags.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  const updated = { ..._tags[idx], ...patch, id };
  if (!validateTag(updated)) return null;
  try {
    const saved = await _api.put(`/tags/${id}`, updated);
    if (!validateTag(saved)) throw new Error("API returned invalid tag");
    _tags[idx] = saved;
    publish("tags", _tags);
    return saved;
  } catch (e) {
    return _failStrictApi("tags", "タグの更新", e);
  }
}

async function deleteTag(id) {
  try {
    await _api.del(`/tags/${id}`);
    _tags = _tags.filter((t) => t.id !== id);
    publish("tags", _tags);
    // サーバー側で設定内の参照(monthTagOrders/outlookSyncTagId)も取り除かれるため読み直す。
    await _reloadFromSource("settings");
  } catch (e) {
    return _failStrictApi("tags", "タグの削除", e);
  }
}

// ── 設定 ─────────────────────────────────────────────
let _settings = { ...DEFAULT_SETTINGS };

function getSettings() {
  const normalized = _normalizeSettings(_settings);
  return {
    ...normalized,
    workWeekDays: normalized.workWeekDays.slice(),
    urlAutoOpenTimes: normalized.urlAutoOpenTimes.slice(),
    quickLinks: normalized.quickLinks.map((row) => ({ ...row })),
    companyHolidayEntries: _cloneCompanyHolidayEntries(normalized.companyHolidayEntries),
    companyHolidays: normalized.companyHolidays.slice(),
    monthTagOrders: _normalizeMonthTagOrders(normalized.monthTagOrders),
  };
}

/** 指定月に明示的なタグ設定があるか */
function hasMonthTagOrder(yearMonth) {
  return Object.prototype.hasOwnProperty.call(_settings.monthTagOrders ?? {}, yearMonth);
}

/**
 * 指定月のタグ一覧を順序を考慮して返す。
 * monthTagOrders に月キーがなければ空配列を返す。
 */
function getTagsForMonth(yearMonth) {
  const orders = _settings.monthTagOrders ?? {};
  if (!Object.prototype.hasOwnProperty.call(orders, yearMonth)) return [];
  const order = Array.isArray(orders[yearMonth]) ? orders[yearMonth] : [];
  // order に含まれるタグのみ、順番通りに返す
  const result = [];
  order.forEach((id) => {
    const tag = _tags.find((t) => t.id === id);
    if (tag) result.push(tag);
  });
  return result;
}

/**
 * 指定月のタグ順序から除外して保存する（グローバルのタグ定義は残る）。
 */
async function removeTagFromMonth(yearMonth, tagId) {
  const orders = { ...(_settings.monthTagOrders ?? {}) };
  const current = Array.isArray(orders[yearMonth]) ? orders[yearMonth] : _tags.map((t) => t.id);
  orders[yearMonth] = current.filter((id) => id !== tagId);
  await updateSettings({ monthTagOrders: orders });
  publish("tags", _tags);
}

/**
 * 指定月のタグ順序を保存する。
 * @param {string} yearMonth - "YYYY-MM"
 * @param {string[]} tagIds
 */
async function setMonthTagOrder(yearMonth, tagIds) {
  const orders = { ...(_settings.monthTagOrders ?? {}) };
  orders[yearMonth] = tagIds;
  await updateSettings({ monthTagOrders: orders });
  publish("tags", _tags);
}

/**
 * 指定月のタグ設定を前月からコピーする。
 * @param {string} yearMonth - "YYYY-MM"
 */
async function copyTagOrderFromPrevMonth(yearMonth) {
  const [y, m] = yearMonth.split("-").map(Number);
  const prevMonth = m === 1
    ? `${y - 1}-${String(12).padStart(2, "0")}`
    : `${y}-${String(m - 1).padStart(2, "0")}`;
  const prevOrder = _settings.monthTagOrders?.[prevMonth];
  // 前月が「空配列」のときも前月設定なし扱いとし、全タグへフォールバックする
  if (Array.isArray(prevOrder) && prevOrder.length > 0) {
    await setMonthTagOrder(yearMonth, [...prevOrder]);
  } else {
    await setMonthTagOrder(yearMonth, _tags.map((t) => t.id));
  }
}

async function updateSettings(patch) {
  const nextSettings = _normalizeSettings({ ..._settings, ...patch });
  try {
    const saved = await _api.put("/settings", nextSettings);
    _settings = (saved && typeof saved === "object") ? _normalizeSettings(saved) : _normalizeSettings(nextSettings);
    publish("settings", _settings);
  } catch (e) {
    return _failStrictApi("settings", "設定の更新", e);
  }
}

// ── 工数計算 ──────────────────────────────────────────
/** タスク1件の工数(分) */
// 工数計算から除外する(重なりを引く)休憩時間帯のみを返す。
// countAsWork=trueの休憩は工数に含めるため対象にしない。
function _excludedBreaks() {
  return normalizeBreaks(_settings?.breaks).filter((b) => !b.countAsWork);
}

// 設定された休憩時間帯(複数対応)と[start,end]区間との重なり分数(分)を返す。
function _breakOverlapMinutes(startMin, endMin) {
  const breaks = _excludedBreaks();
  let overlap = 0;
  for (const b of breaks) {
    const bs = timeToMinutes(b.start);
    const be = timeToMinutes(b.end);
    const os = Math.max(startMin, bs);
    const oe = Math.min(endMin, be);
    if (oe > os) overlap += oe - os;
  }
  return overlap;
}

// [start,end]区間から休憩時間帯と重なる部分を取り除いた残り区間の配列を返す
// (休憩が区間の途中にある場合は2つに分割される)。countAsWork=trueの休憩は
// 除外対象にしない。
function _subtractBreaksFromInterval(startMin, endMin) {
  const breaks = _excludedBreaks();
  let segments = [[startMin, endMin]];
  for (const b of breaks) {
    const bs = timeToMinutes(b.start);
    const be = timeToMinutes(b.end);
    const next = [];
    for (const [s, e] of segments) {
      if (be <= s || bs >= e) { next.push([s, e]); continue; }
      if (bs > s) next.push([s, bs]);
      if (be < e) next.push([be, e]);
    }
    segments = next;
  }
  return segments;
}

// 休憩時間との重なりを除いた実質の工数(分)。タスク一覧の「工数」列・タグ別集計に使用する
function taskDurationMinutes(task) {
  if (task.isAllDay || !task.startTime || !task.endTime) return 0;
  const startMin = timeToMinutes(task.startTime);
  const endMin = timeToMinutes(task.endTime);
  const raw = Math.max(0, endMin - startMin);
  if (raw === 0) return 0;
  return Math.max(0, raw - _breakOverlapMinutes(startMin, endMin));
}

/**
 * 区間配列 [[start,end],...] を結合し、重なりを除いた実時間(分)を返す。
 * 「合計」の二重計上を防ぐために使用する（タグ別は並行作業として別途加算）。
 */
function _mergeIntervalMinutes(intervals) {
  if (!Array.isArray(intervals) || intervals.length === 0) return 0;
  const sorted = intervals
    .filter((pair) => Array.isArray(pair) && pair[1] > pair[0])
    .sort((a, b) => a[0] - b[0]);
  if (sorted.length === 0) return 0;

  let total = 0;
  let curStart = sorted[0][0];
  let curEnd = sorted[0][1];
  for (let i = 1; i < sorted.length; i += 1) {
    const [s, e] = sorted[i];
    if (s > curEnd) {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  total += curEnd - curStart;
  return total;
}

/**
 * 日次集計: { total, byTag: Map<tagId, minutes> }
 * - byTag: タグ別の工数（並行作業はそのまま加算）
 * - total: 重なりをマージした実時間（同日内のみマージ）
 */
function calcDaySummary(dateKey) {
  const tasks = getTasksByDate(dateKey);
  const validTagIds = new Set(_tags.map((tag) => String(tag.id ?? "").trim()).filter(Boolean));
  const byTag = new Map();
  const intervals = [];
  for (const t of tasks) {
    const tagId = String(t.tagId ?? "").trim();
    if (!tagId || !validTagIds.has(tagId)) continue;
    const mins = taskDurationMinutes(t);
    byTag.set(tagId, (byTag.get(tagId) ?? 0) + mins);
    if (!t.isAllDay && t.startTime && t.endTime) {
      intervals.push(..._subtractBreaksFromInterval(timeToMinutes(t.startTime), timeToMinutes(t.endTime)));
    }
  }
  return { total: _mergeIntervalMinutes(intervals), byTag };
}

/**
 * 月次集計: { total, byTag: Map<tagId, minutes> }
 * - total は日ごとに重なりをマージしてから合算する（別日同士はマージしない）。
 */
function calcMonthSummary(yearMonth) {
  const tasks = getTasksByMonth(yearMonth);
  const validTagIds = new Set(_tags.map((tag) => String(tag.id ?? "").trim()).filter(Boolean));
  const byTag = new Map();
  const intervalsByDate = new Map();
  for (const t of tasks) {
    const tagId = String(t.tagId ?? "").trim();
    if (!tagId || !validTagIds.has(tagId)) continue;
    const mins = taskDurationMinutes(t);
    byTag.set(tagId, (byTag.get(tagId) ?? 0) + mins);
    if (!t.isAllDay && t.startTime && t.endTime) {
      const list = intervalsByDate.get(t.date) ?? [];
      list.push(..._subtractBreaksFromInterval(timeToMinutes(t.startTime), timeToMinutes(t.endTime)));
      intervalsByDate.set(t.date, list);
    }
  }
  let total = 0;
  for (const list of intervalsByDate.values()) {
    total += _mergeIntervalMinutes(list);
  }
  return { total, byTag };
}

// ── 初期化 ────────────────────────────────────────────
async function init() {
  try {
    const runtime = await _api.get("/runtime");
    _runtimeInfo = (runtime && typeof runtime === "object")
      ? { ..._runtimeInfo, ...runtime }
      : { ..._runtimeInfo };

    const [tasks, tags, settings] = await Promise.all([
      _api.get("/tasks"),
      _api.get("/tags"),
      _api.get("/settings"),
    ]);

    _tasks = _backfillRecurrenceGroupIds(Array.isArray(tasks) ? tasks.filter(validateTask) : []);
    _tags = Array.isArray(tags) ? tags.filter(validateTag) : [];
    _settings = _normalizeSettings(settings);

    try {
      await _loadAiMemoryFromApi();
    } catch (e) {
      console.warn("[store] 日次サマリー等の読み込みに失敗しました:", e);
    }
    console.info("[store] SQLite API で初期化しました");
  } catch (e) {
    console.error("[store] strict SQLite runtime initialization failed:", e);
    throw _strictApiError("アプリの起動", e);
  }
}

// タスクデータをサーバーから再取得する(AIタブなど別ページからの呼び出し用)
async function refreshTasks() {
  await _reloadFromSource("tasks");
}

// 5分ごとにタスクをリフレッシュ(自動同期で追加されたタスクを画面に反映)
setInterval(() => {
  refreshTasks().catch(() => {});
}, 5 * 60 * 1000);

// ── Public API ────────────────────────────────────────
/**
 * 設定ファイル(settings-transfer.js の parseSettingsImport の結果)を反映する。
 * タグは名前で突き合わせ、無いものだけ作成する。取り込んだタグは当月のタグ順へ追加する。
 * @returns {{ settingKeys: number, createdTags: number, existingTags: number }}
 */
async function applySettingsImport({ settings = {}, tags = [] } = {}) {
  if (Object.keys(settings).length) {
    await updateSettings(settings);
  }

  const tagIds = [];
  let createdTags = 0;
  for (const row of tags) {
    const existing = _tags.find((t) => t.name === row.name);
    if (existing) {
      tagIds.push(existing.id);
      continue;
    }
    const created = await createTag({ name: row.name, color: row.color });
    if (!created) continue;
    createdTags += 1;
    tagIds.push(created.id);
    if (row.budgetMinMinutes != null || row.budgetMaxMinutes != null) {
      await updateTag(created.id, {
        budgetMinMinutes: row.budgetMinMinutes ?? null,
        budgetMaxMinutes: row.budgetMaxMinutes ?? null,
      });
    }
  }

  if (tagIds.length) {
    const yearMonth = formatYearMonth(new Date());
    const current = Array.isArray(_settings.monthTagOrders?.[yearMonth]) ? _settings.monthTagOrders[yearMonth] : [];
    const next = current.slice();
    tagIds.forEach((id) => { if (!next.includes(id)) next.push(id); });
    if (next.length !== current.length) await setMonthTagOrder(yearMonth, next);
  }

  return { settingKeys: Object.keys(settings).length, createdTags, existingTags: tagIds.length - createdTags };
}

export {
  init,
  applySettingsImport,
  subscribe,
  refreshTasks,
  getRuntimeInfo,
  // tasks
  getAllTasks,
  getTasksByDate,
  createTask,
  updateTask,
  updateTaskWithMode,
  deleteTaskWithMode,
  getTaskSeriesCount,
  // tags
  getAllTags,
  createTag,
  updateTag,
  deleteTag,
  // settings
  getSettings,
  updateSettings,
  getTagsForMonth,
  hasMonthTagOrder,
  setMonthTagOrder,
  removeTagFromMonth,
  copyTagOrderFromPrevMonth,
  // calc
  taskDurationMinutes,
  calcDaySummary,
  calcMonthSummary,
  // ai daily memory
  getDailySummary,
  getAllDailySummaries,
  upsertDailySummary,
  deleteDailySummary,
  getDailyNotes,
  addDailyNote,
  getAiChatHistory,
  updateAiChatProposalStatus,
  addAiChatMessage,
  // weather cache
  getWeatherCache,
  putWeatherCache,
};
