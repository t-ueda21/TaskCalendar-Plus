/**
 * company-holidays.js
 *
 * 会社休日の入力/保存/表示向けユーティリティ。
 * - 手入力: 1行1件 (例: 2026-12-29, 年末休暇)
 * - JSON: [{"date":"2026-12-29","name":"年末休暇"}] / {"2026-12-29":"年末休暇"}
 * - CSV: date,name
 */

const DEFAULT_COMPANY_HOLIDAY_NAME = "会社休日";

function _pad2(n) {
  return String(n).padStart(2, "0");
}

function _normalizeInputToken(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/／/g, "/")
    .replace(/[－ー―‐]/g, "-")
    .replace(/．/g, ".")
    .replace(/[，、]/g, ",")
    .replace(/\s+/g, " ");
}

function _normalizeHolidayName(rawName) {
  const token = String(rawName ?? "").trim();
  return token || DEFAULT_COMPANY_HOLIDAY_NAME;
}

function _toDateKey(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return "";
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return "";
  return `${String(y).padStart(4, "0")}-${_pad2(m)}-${_pad2(d)}`;
}

function _toRecurringKey(m, d) {
  if (!Number.isInteger(m) || !Number.isInteger(d)) return "";
  const dt = new Date(2000, m - 1, d);
  if (dt.getMonth() !== m - 1 || dt.getDate() !== d) return "";
  return `--${_pad2(m)}-${_pad2(d)}`;
}

function normalizeCompanyHolidayDateKey(rawValue) {
  const token = _normalizeInputToken(rawValue).replace(/\s+/g, "");
  if (!token) return "";

  let hit = token.match(/^--(\d{2})-(\d{2})$/);
  if (hit) {
    return _toRecurringKey(Number(hit[1]), Number(hit[2]));
  }

  hit = token.match(/^(\d{4})[\/\.-](\d{1,2})[\/\.-](\d{1,2})$/);
  if (hit) {
    return _toDateKey(Number(hit[1]), Number(hit[2]), Number(hit[3]));
  }

  hit = token.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  if (hit) {
    return _toDateKey(Number(hit[1]), Number(hit[2]), Number(hit[3]));
  }

  const recurringToken = token.replace(/^毎年/, "");

  hit = recurringToken.match(/^(\d{1,2})[\/\.-](\d{1,2})$/);
  if (hit) {
    return _toRecurringKey(Number(hit[1]), Number(hit[2]));
  }

  hit = recurringToken.match(/^(\d{1,2})月(\d{1,2})日$/);
  if (hit) {
    return _toRecurringKey(Number(hit[1]), Number(hit[2]));
  }

  return "";
}

function _stripOuterQuotes(text) {
  const token = String(text ?? "").trim();
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1).trim();
  }
  return token;
}

function _parseCsvLine(line) {
  const src = String(line ?? "");
  const cols = [];
  let buf = "";
  let inQuote = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '"') {
      if (inQuote && src[i + 1] === '"') {
        buf += '"';
        i += 1;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }

    if (ch === "," && !inQuote) {
      cols.push(_stripOuterQuotes(buf));
      buf = "";
      continue;
    }

    buf += ch;
  }

  cols.push(_stripOuterQuotes(buf));
  return cols.map((v) => String(v ?? "").trim());
}

function _normalizeCompanyHolidayEntry(entryLike) {
  if (typeof entryLike === "string") {
    const line = _normalizeInputToken(entryLike);
    if (!line || /^#|^\/\//.test(line)) return null;

    const csvCols = _parseCsvLine(line);
    if (csvCols.length >= 2) {
      const dateKey = normalizeCompanyHolidayDateKey(csvCols[0]);
      if (dateKey) {
        return {
          dateKey,
          name: _normalizeHolidayName(csvCols[1]),
        };
      }
    }

    let hit = line.match(/^(\S+)\s+(.+)$/);
    if (hit) {
      const leftDateKey = normalizeCompanyHolidayDateKey(hit[1]);
      if (leftDateKey) {
        return {
          dateKey: leftDateKey,
          name: _normalizeHolidayName(hit[2]),
        };
      }

      const rightDateKey = normalizeCompanyHolidayDateKey(hit[2]);
      if (rightDateKey) {
        return {
          dateKey: rightDateKey,
          name: _normalizeHolidayName(hit[1]),
        };
      }
    }

    const onlyDateKey = normalizeCompanyHolidayDateKey(line);
    if (!onlyDateKey) return null;
    return {
      dateKey: onlyDateKey,
      name: DEFAULT_COMPANY_HOLIDAY_NAME,
    };
  }

  if (!entryLike || typeof entryLike !== "object") return null;

  const dateRaw = entryLike.dateKey ?? entryLike.date ?? entryLike.day ?? entryLike.key ?? "";
  const dateKey = normalizeCompanyHolidayDateKey(dateRaw);
  if (!dateKey) return null;

  const nameRaw = entryLike.name ?? entryLike.title ?? entryLike.label ?? "";
  return {
    dateKey,
    name: _normalizeHolidayName(nameRaw),
  };
}

function _sortCompanyHolidayEntries(a, b) {
  const aRecurring = String(a.dateKey).startsWith("--");
  const bRecurring = String(b.dateKey).startsWith("--");
  if (aRecurring !== bRecurring) return aRecurring ? 1 : -1;
  return String(a.dateKey).localeCompare(String(b.dateKey));
}

export function normalizeCompanyHolidayEntries(value) {
  const map = new Map();

  const push = (entryLike) => {
    const normalized = _normalizeCompanyHolidayEntry(entryLike);
    if (!normalized) return;
    map.set(normalized.dateKey, normalized);
  };

  if (Array.isArray(value)) {
    value.forEach((row) => {
      if (typeof row === "string" && /\r|\n/.test(row)) {
        parseCompanyHolidayText(row).forEach((entry) => push(entry));
        return;
      }
      push(row);
    });
  } else if (typeof value === "string") {
    parseCompanyHolidayText(value).forEach((entry) => push(entry));
  } else if (value && typeof value === "object") {
    if (
      Object.prototype.hasOwnProperty.call(value, "date") ||
      Object.prototype.hasOwnProperty.call(value, "dateKey") ||
      Object.prototype.hasOwnProperty.call(value, "day") ||
      Object.prototype.hasOwnProperty.call(value, "key")
    ) {
      push(value);
    } else {
      Object.entries(value).forEach(([dateKey, nameLike]) => {
        if (nameLike && typeof nameLike === "object") {
          push({ dateKey, ...nameLike });
        } else {
          push({ dateKey, name: nameLike });
        }
      });
    }
  }

  return Array.from(map.values()).sort(_sortCompanyHolidayEntries);
}

export function parseCompanyHolidayText(text) {
  const source = String(text ?? "").trim();
  if (!source) return [];

  if (source.startsWith("[") || source.startsWith("{")) {
    try {
      const parsed = JSON.parse(source);
      return normalizeCompanyHolidayEntries(parsed);
    } catch {
      // fall through to line parsing
    }
  }

  const rows = [];
  source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const entry = _normalizeCompanyHolidayEntry(line);
      if (entry) rows.push(entry);
    });

  return normalizeCompanyHolidayEntries(rows);
}

function formatCompanyHolidayDateForInput(dateKey) {
  const key = String(dateKey ?? "").trim();
  const recurring = key.match(/^--(\d{2})-(\d{2})$/);
  if (recurring) {
    return `${Number(recurring[1])}/${Number(recurring[2])}`;
  }
  return key;
}

export function formatCompanyHolidayInputText(value) {
  const entries = normalizeCompanyHolidayEntries(value);
  return entries
    .map((entry) => {
      const dateText = formatCompanyHolidayDateForInput(entry.dateKey);
      const name = _normalizeHolidayName(entry.name);
      if (!name || name === DEFAULT_COMPANY_HOLIDAY_NAME) return dateText;
      return `${dateText},${name}`;
    })
    .join("\n");
}

export function getCompanyHolidayNameForDate(dateKey, entriesLike) {
  const key = String(dateKey ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;

  const recurringKey = `--${key.slice(5)}`;
  const entries = normalizeCompanyHolidayEntries(entriesLike);

  const exact = entries.find((entry) => entry.dateKey === key);
  if (exact) return _normalizeHolidayName(exact.name);

  const recurring = entries.find((entry) => entry.dateKey === recurringKey);
  if (recurring) return _normalizeHolidayName(recurring.name);

  return null;
}

export function getCompanyHolidaysInMonthMap(year, month, entriesLike) {
  const map = new Map();
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 0 || m > 11) return map;

  const entries = normalizeCompanyHolidayEntries(entriesLike);
  const monthNum = m + 1;

  entries.forEach((entry) => {
    const name = _normalizeHolidayName(entry.name);
    const key = String(entry.dateKey ?? "").trim();

    const recurring = key.match(/^--(\d{2})-(\d{2})$/);
    if (recurring) {
      const mm = Number(recurring[1]);
      const dd = Number(recurring[2]);
      if (mm !== monthNum) return;
      const dateKey = _toDateKey(y, mm, dd);
      if (!dateKey) return;
      map.set(dateKey, name);
      return;
    }

    if (key.startsWith(`${String(y).padStart(4, "0")}-${_pad2(monthNum)}-`)) {
      map.set(key, name);
    }
  });

  return map;
}
