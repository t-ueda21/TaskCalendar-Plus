// Settings defaults and normalization, independent of API persistence and task indexes.
import { normalizeCompanyHolidayEntries } from "./company-holidays.js";
import { normalizeQuickLinks } from "./settings-transfer.js";
import { DEFAULT_UI_COLOR, normalizeUiColor } from "./ui-colors.js";
import { normalizeLocale, t as translate } from './i18n.js';
import { personalization } from "./ai-personalization.js";
import { normalizeBreaks, normalizeUrlAutoOpenTimes } from "./ui-utils.js";

// AIの接続先。"none"(既定)のときはAIを呼ばない。
export const AI_PROVIDER_LABELS = {
  get none() { return translate('ui.16f23fffd1'); },
  "claude-code": "Claude Code",
  codex: "Codex",
  ollama: "Ollama",
  lmstudio: "LM Studio",
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
export const DEFAULT_SETTINGS = {
  uiLanguage: "auto",
  aiPersonalization: personalization({}),
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
  aiOllamaEndpoint:    "http://localhost:11434/v1",
  aiOllamaModel:       "",
  aiLmStudioEndpoint:  "http://localhost:1234/v1",
  aiLmStudioModel:     "",
  appIconUrl:          "",
  appIconSize:         DEFAULT_APP_ICON_SIZE,
  weatherLocationKey:  "tokyo",
  monthTagOrders:      {}, // { "YYYY-MM": [tagId, ...] }
  outlookAutoSync: false, // Outlookの予定を勝手に取り込まないよう、既定はOFF(設定のOutlookタブで有効化する)
  outlookAutoSyncIntervalMin: 10,
  outlookSyncCalendarName: "Calendar",
  outlookSyncTagId: "",
  outlookSyncDaysAhead: 90,
  outlookWriteEnabled: false,
  outlookWriteDefault: false,
  outlookWriteCalendarName: "Calendar",
  trayEnabled: true, // 「✕」でタスクトレイへ格納するか(Rust側main.rsが起動時に読む)
  startMinimizedToTray: false, // 起動時にタスクトレイのみで起動するか
};


function _normalizeAutoOpenEnabled(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const token = value.trim().toLowerCase();
    if (["false", "0", "off", "no"].includes(token)) return false;
    if (["true", "1", "on", "yes"].includes(token)) return true;
  }
  return Boolean(DEFAULT_SETTINGS.urlAutoOpenEnabled);
}

export function _cloneCompanyHolidayEntries(entries) {
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

export function _normalizeSettings(settingsLike) {
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
  merged.uiLanguage = merged.uiLanguage === "auto" ? "auto" : normalizeLocale(merged.uiLanguage);
  merged.aiPersonalization = personalization(merged);
  merged.outlookWriteEnabled = merged.outlookWriteEnabled === true;
  merged.outlookWriteDefault = merged.outlookWriteDefault === true;
  for (const key of ['outlookWriteCalendarName','outlookSyncCalendarName']) {
    const value = String(merged[key] ?? 'Calendar').trim();
    merged[key] = (value.startsWith('outlook-folder:') ? value : value.slice(0, 200)) || 'Calendar';
  }
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
  for (const key of ["aiOllamaModel", "aiLmStudioModel"]) merged[key] = _normalizeShortText(merged[key]);
  for (const key of ["aiOllamaEndpoint", "aiLmStudioEndpoint"]) merged[key] = String(merged[key] ?? "").trim().slice(0, 2048) || DEFAULT_SETTINGS[key];
  merged.appIconUrl = _normalizeAppIconUrl(merged.appIconUrl);
  merged.appIconSize = _normalizeAppIconSize(merged.appIconSize);
  merged.monthTagOrders = _normalizeMonthTagOrders(merged.monthTagOrders);
  return merged;
}


export function _normalizeMonthTagOrders(monthTagOrders) {
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

