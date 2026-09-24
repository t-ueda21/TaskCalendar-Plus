/**
 * settings-transfer.js
 *
 * クイックリンクの正規化と、設定・タグのエクスポート/インポート用JSONの生成・解析。
 * DOMに依存しない純粋関数だけを置く(scripts/test-settings-transfer.mjs でテストする)。
 */

export const SETTINGS_EXPORT_FORMAT = "taskcalendar-plus-settings";
const SETTINGS_EXPORT_VERSION = 1;
export const MAX_QUICK_LINKS = 8;

// 他の端末へ持ち出しても意味を持たない(このDBのタグIDを参照する)設定キー。
const NON_PORTABLE_SETTING_KEYS = new Set(["monthTagOrders", "outlookSyncTagId"]);

function _isHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(String(value ?? "").trim());
}

/**
 * クイックリンクを [{label, url}] に正規化する。
 * 配列(オブジェクト)または「ラベル,URL」を1行1件で書いたテキストを受け付ける。
 * URLはhttp/httpsのみ。ラベルが空ならURLをラベルにする。名前とURLが両方同じ行だけをまとめる。
 */
export function normalizeQuickLinks(value) {
  const rows = Array.isArray(value)
    ? value
    : String(value ?? "").split(/\r?\n/).map((line) => {
      const idx = line.indexOf(",");
      return idx < 0
        ? { label: "", url: line }
        : { label: line.slice(0, idx), url: line.slice(idx + 1) };
    });
  const seen = new Set();
  const result = [];
  rows.forEach((row) => {
    if (result.length >= MAX_QUICK_LINKS) return;
    const url = String(row?.url ?? "").trim();
    const label = String(row?.label ?? "").trim() || url;
    const key = JSON.stringify([label, url]);
    if (!_isHttpUrl(url) || seen.has(key)) return;
    seen.add(key);
    result.push({ label, url });
  });
  return result;
}

export function formatQuickLinksText(links) {
  return normalizeQuickLinks(links).map((row) => `${row.label},${row.url}`).join("\n");
}

/**
 * エクスポート用のオブジェクトを作る。タスクは含めない。
 * タグはID抜き(名前・色・予算)で書き出し、取り込み側で名前をキーに突き合わせる。
 */
export function buildSettingsExport(settings, tags, { exportedAt = new Date().toISOString() } = {}) {
  const portableSettings = {};
  Object.entries(settings ?? {}).forEach(([key, value]) => {
    if (NON_PORTABLE_SETTING_KEYS.has(key)) return;
    portableSettings[key] = value;
  });
  const portableTags = (Array.isArray(tags) ? tags : []).map((tag) => {
    const row = { name: String(tag?.name ?? ""), color: String(tag?.color ?? "") };
    if (tag?.budgetMinMinutes != null) row.budgetMinMinutes = tag.budgetMinMinutes;
    if (tag?.budgetMaxMinutes != null) row.budgetMaxMinutes = tag.budgetMaxMinutes;
    return row;
  });
  return {
    format: SETTINGS_EXPORT_FORMAT,
    version: SETTINGS_EXPORT_VERSION,
    exportedAt,
    settings: portableSettings,
    tags: portableTags,
  };
}

/**
 * インポートJSONを解析する。形式が違う場合は例外を投げる。
 * `allowedSettingKeys` に含まれるキーだけを取り込む(未知のキーを保存しない)。
 * 戻り値: { settings, tags }
 */
export function parseSettingsImport(text, { allowedSettingKeys = [] } = {}) {
  let data;
  try {
    data = JSON.parse(String(text ?? ""));
  } catch {
    throw new Error("JSONとして読み込めませんでした。");
  }
  if (!data || typeof data !== "object" || data.format !== SETTINGS_EXPORT_FORMAT) {
    throw new Error("TaskCalendar+ の設定ファイルではありません。");
  }
  if (Number(data.version) !== SETTINGS_EXPORT_VERSION) {
    throw new Error(`対応していない設定ファイルのバージョンです(version=${data.version})。`);
  }

  const allowed = new Set(allowedSettingKeys);
  const settings = {};
  Object.entries(data.settings && typeof data.settings === "object" ? data.settings : {}).forEach(([key, value]) => {
    if (NON_PORTABLE_SETTING_KEYS.has(key) || !allowed.has(key)) return;
    settings[key] = value;
  });

  const seenNames = new Set();
  const tags = [];
  (Array.isArray(data.tags) ? data.tags : []).forEach((row) => {
    const name = String(row?.name ?? "").trim();
    const color = String(row?.color ?? "").trim();
    if (!name || seenNames.has(name) || !/^#[0-9a-fA-F]{3,8}$/.test(color)) return;
    seenNames.add(name);
    const tag = { name, color };
    ["budgetMinMinutes", "budgetMaxMinutes"].forEach((key) => {
      const n = Number(row?.[key]);
      if (row?.[key] != null && Number.isFinite(n) && n >= 0) tag[key] = Math.round(n);
    });
    tags.push(tag);
  });

  return { settings, tags };
}
