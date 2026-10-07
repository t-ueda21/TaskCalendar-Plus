import { t as translate, th as translateHtml } from './i18n.js';
/**
 * ai-memory.js
 *
 * タスク一覧の「日次サマリー」をAIで作る。AIの接続先が設定されていなければ作らない。
 */

import * as Store from "./store.js";
import { formatDateKey, formatDateJP, parseLocalDate, _isDateKey } from "./ui-utils.js";
import { getHolidayName } from "./holidays.js";
import { getCompanyHolidayNameForDate } from "./company-holidays.js";
import { getWeatherByDate, formatWeatherForDisplay } from "./weather.js";
import { callAi, isAiConfigured } from "./ai-client.js";

// 日次サマリーの一言コメントの人柄。事実は捏造させない。
const SUMMARY_PERSONA = 'Create a factual daily summary. Do not invent records, causes or intentions. Follow the application system instructions for language, tone, warmth, emoji and length.';

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summaryText: { type: "string", get description() { return translate('ui.db6b5e2a54'); } },
    comment: { type: "string", get description() { return translate('ui.c543a25991'); } },
    mood: { type: "string", enum: ["高稼働", "中稼働", "低稼働", "軽稼働"] },
    highlights: { type: "array", items: { type: "string" }, get description() { return translate('ui.e3430da3f7'); } },
  },
  required: ["summaryText", "comment", "mood", "highlights"],
  additionalProperties: false,
};

/** 今日の日付(日本時間)。 */
export function todayDateKeyInJst() {
  try {
    const parts = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const key = `${get("year")}-${get("month")}-${get("day")}`;
    if (_isDateKey(key)) return key;
  } catch {
    // ignore formatter errors
  }
  return formatDateKey(new Date());
}

function _isOffDay(dateKey) {
  const dow = parseLocalDate(dateKey).getDay();
  const settings = Store.getSettings();
  return dow === 0 || dow === 6
    || Boolean(getHolidayName(dateKey))
    || Boolean(getCompanyHolidayNameForDate(dateKey, settings?.companyHolidayEntries));
}

/** 休日で、タグの付いた予定が無い日はサマリーを作らない。 */
export function shouldSkipDailySummary(dateKey, tasks = null) {
  if (!_isDateKey(dateKey) || !_isOffDay(dateKey)) return false;
  const dayTasks = Array.isArray(tasks) ? tasks : Store.getTasksByDate(dateKey);
  if (!dayTasks.length) return false;
  const tagIds = new Set(Store.getAllTags().map((tag) => String(tag.id)));
  return !dayTasks.some((task) => tagIds.has(String(task.tagId ?? "")));
}

// 事実の要約に、推測の言葉(ない事実・理由の補完の兆候)が混じっていないか。
function _containsSpeculation(text) {
  return /(かもしれ|と思われ|おそらく|恐らく|たぶん|多分|推測|憶測|可能性|見込み)/.test(String(text ?? ""));
}

/**
 * 指定日の日次サマリーをAIで作って保存する。既にあれば overwrite が true のときだけ作り直す。
 * AIの接続先が無い・予定が無い・AIの呼び出しに失敗したときは null。
 */
export async function summarizeDay(dateKey, { overwrite = false } = {}) {
  if (!_isDateKey(dateKey)) return null;
  const tasks = Store.getTasksByDate(dateKey)
    .slice()
    .sort((a, b) => String(a.startTime ?? "99:99").localeCompare(String(b.startTime ?? "99:99")));
  if (shouldSkipDailySummary(dateKey, tasks)) {
    Store.deleteDailySummary(dateKey);
    return null;
  }
  const existing = Store.getDailySummary(dateKey);
  if (existing && !overwrite) return existing;
  if (!tasks.length || !isAiConfigured()) return null;

  const tagById = new Map(Store.getAllTags().map((tag) => [String(tag.id), tag.name]));
  const notes = Store.getDailyNotes(dateKey);
  const totalMinutes = tasks.reduce((sum, task) => sum + Store.taskDurationMinutes(task), 0);
  const weather = await getWeatherByDate(dateKey).catch(() => null);

  const prompt = [
    translate('ui.1b2cb0d304'),
    translate('ui.e5ace782e2'),
    translate('ui.081ecdbaab'),
    translate('ui.7b1fa49add', { p0: (formatDateJP(parseLocalDate(dateKey))), p1: (dateKey) }),
    translate('ui.862604751a', { p0: (tasks.length), p1: (totalMinutes) }),
    translate('ui.9dac48b964', { p0: (weather ? formatWeatherForDisplay(weather) : "情報なし") }),
    translate('ui.0dcb8b48aa'),
    ...tasks.slice(0, 80).map((task) => {
      const tag = tagById.get(String(task.tagId ?? "")) || translate('ui.af1cc864e3');
      const time = task.isAllDay ? translate('ui.0aff5cf2d8') : `${task.startTime ?? "--:--"}-${task.endTime ?? "--:--"}`;
      const memo = String(task.memo ?? "").trim();
      return translate('ui.d901206d87', { p0: (time), p1: (String(task.title ?? "").trim() || "無題"), p2: (tag), p3: (Store.taskDurationMinutes(task)), p4: (memo ? ` メモ:${memo}` : "") });
    }),
    translate('ui.e966ed6e9c'),
    ...(notes.length ? notes.slice(0, 20).map((note) => `- ${String(note.text ?? "").trim()}`) : [translate('ui.0b720f3b2e')]),
  ].join("\n");

  let parsed;
  try {
    const content = await callAi([
      { role: "system", content: SUMMARY_PERSONA },
      { role: "user", content: prompt },
    ], { format: SUMMARY_SCHEMA });
    parsed = JSON.parse(content);
  } catch (e) {
    console.warn("[ai-memory] summarizeDay failed:", e);
    return null;
  }

  const summaryText = String(parsed?.summaryText ?? "").trim();
  const highlights = (Array.isArray(parsed?.highlights) ? parsed.highlights : [])
    .map((line) => String(line ?? "").trim())
    .filter(Boolean)
    .slice(0, 4);
  if (!summaryText || _containsSpeculation(summaryText) || highlights.some(_containsSpeculation)) return null;

  return Store.upsertDailySummary({
    id: `summary-${dateKey}`,
    date: dateKey,
    summaryText,
    comment: String(parsed?.comment ?? "").trim(),
    mood: String(parsed?.mood ?? "").trim(),
    highlights,
    sourceRefs: [
      ...tasks.map((task) => ({ type: "task", id: task.id })),
      ...notes.map((note) => ({ type: "user-note", id: note.id })),
      ...(weather ? [{ type: "weather", id: dateKey }] : []),
    ],
  });
}
