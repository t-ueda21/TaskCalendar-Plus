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
const SUMMARY_PERSONA = [
  "あなたは、その人の一日の記録を見守る相棒のような存在です。",
  "データを淡々と読み上げるのではなく、よく働いた日はねぎらい、詰め込みすぎた日はそっと気遣い、",
  "面白い偏りがあれば軽くツッコむなど、人間味のある一言を添えます。",
  "口調はフランクで温かく、説教くさくしないこと。事実は決して捏造しないこと。",
].join("");

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summaryText: { type: "string", description: "入力データにある事実だけの要約" },
    comment: { type: "string", description: "その日への人間味のある一言(1〜2文)" },
    mood: { type: "string", enum: ["高稼働", "中稼働", "低稼働", "軽稼働"] },
    highlights: { type: "array", items: { type: "string" }, description: "事実の箇条書き(最大4つ)" },
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
    "以下の業務データから日次サマリーを作ってください。",
    "summaryText と highlights は入力データにある事実のみで淡々とまとめること(ない事実・理由・意図を作らない)。",
    "comment は、その事実をふまえた人間味のある一言です。その日で一番目立つ点を1つ選び、感心・ねぎらい・気遣い・軽いツッコミなどで1〜2文。事実の捏造はしないこと。",
    `対象日: ${formatDateJP(parseLocalDate(dateKey))} (${dateKey})`,
    `タスク件数: ${tasks.length}、合計工数: ${totalMinutes}分`,
    `天気: ${weather ? formatWeatherForDisplay(weather) : "情報なし"}`,
    "タスク一覧:",
    ...tasks.slice(0, 80).map((task) => {
      const tag = tagById.get(String(task.tagId ?? "")) || "タグなし";
      const time = task.isAllDay ? "終日" : `${task.startTime ?? "--:--"}-${task.endTime ?? "--:--"}`;
      const memo = String(task.memo ?? "").trim();
      return `- ${time} ${String(task.title ?? "").trim() || "無題"} [${tag}] ${Store.taskDurationMinutes(task)}分${memo ? ` メモ:${memo}` : ""}`;
    }),
    "気づきメモ:",
    ...(notes.length ? notes.slice(0, 20).map((note) => `- ${String(note.text ?? "").trim()}`) : ["(なし)"]),
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
