/**
 * settings-dialog.js — 設定ダイアログ(カレンダー・タスク一覧・AIモードの3画面で共有)
 *
 * store.js を import しない(Store は呼び出し側から引数で受け取る)。
 */

import {
  buildSettingsExport,
  formatQuickLinksText,
  normalizeQuickLinks,
  parseSettingsImport,
} from "./settings-transfer.js";
import {
  formatCompanyHolidayInputText,
  normalizeCompanyHolidayEntries,
  parseCompanyHolidayText,
} from "./company-holidays.js";
import {
  DEFAULT_TAG_COLOR,
  escHtml,
  formatDateKey,
  formatYearMonth,
  minutesToTime,
  normalizeBreaks,
  normalizeUrlAutoOpenTimes,
} from "./ui-utils.js";
import { _renderTagManager, buildHslPicker } from "./tag-manager.js";
import { loadSelectedModels, populateModelSelection, readModelSelection } from "./ai-model-picker.js";
import { applyUiColor, populateUiColor, readUiColor, wireUiColorPicker } from "./ui-color-picker.js";

// ── 設定ダイアログ共通ヘルパー(3画面(calendar/tasks/ai-mode)で共用) ──
/**
 * 設定の時刻セレクト用の選択肢(15分刻み等)を生成する。
 */
function buildSettingsTimeValues(stepMinutes = 15) {
  const values = [];
  for (let mins = 0; mins <= 1440; mins += stepMinutes) {
    values.push(minutesToTime(mins));
  }
  return values;
}

/**
 * 設定ダイアログの勤務時間・休憩時間セレクトへ現在値を反映する。
 */
function populateSettingsTimeSelects(settingsDialog, s, timeValues) {
  setTimeSelectOptions(settingsDialog.querySelector("[name='workStart']"), s.workStart, timeValues);
  setTimeSelectOptions(settingsDialog.querySelector("[name='workEnd']"), s.workEnd, timeValues);
  renderBreaksEditor(settingsDialog.querySelector("[data-breaks-list]"), normalizeBreaks(s.breaks), timeValues);
}

// Claude Code / Codex を選んだときに、送信先を明示して同意を得るための表示名。
const AI_CLI_VENDORS = { "claude-code": "Anthropic", codex: "OpenAI" };

function syncAiProviderPanels(settingsDialog) {
  const selectEl = settingsDialog.querySelector("[data-ai-provider-select]");
  const cliEnabled = Boolean(settingsDialog.querySelector("[data-ai-cli-enabled]")?.checked);
  // 「連携する」がオフの間は Claude Code / Codex を選べない。
  if (selectEl instanceof HTMLSelectElement) {
    [...selectEl.options].forEach((option) => {
      if (AI_CLI_VENDORS[option.value]) option.disabled = !cliEnabled;
    });
    if (!cliEnabled && AI_CLI_VENDORS[selectEl.value]) selectEl.value = "none";
  }
  const provider = selectEl?.value ?? "none";
  settingsDialog.querySelectorAll("[data-ai-provider-panel]").forEach((panel) => {
    panel.hidden = panel.getAttribute("data-ai-provider-panel") !== provider;
  });
  const note = settingsDialog.querySelector("[data-ai-privacy-note]");
  if (note) note.hidden = provider === "none";
  loadSelectedModels(settingsDialog);
}

function populateAiProviderSettings(settingsDialog, settings) {
  const setValue = (selector, value) => {
    const el = settingsDialog.querySelector(selector);
    if (el) el.value = String(value ?? "");
  };
  const cliEnabledEl = settingsDialog.querySelector("[data-ai-cli-enabled]");
  if (cliEnabledEl instanceof HTMLInputElement) cliEnabledEl.checked = settings?.aiCliEnabled === true;
  setValue("[data-ai-provider-select]", settings?.aiProvider || "none");
  populateModelSelection(settingsDialog, "claude-code", settings?.aiClaudeModel);
  setValue("[name='aiClaudeEffort']", settings?.aiClaudeEffort);
  populateModelSelection(settingsDialog, "codex", settings?.aiCodexModel);
  setValue("[name='aiCodexEffort']", settings?.aiCodexEffort);
  const detectResult = settingsDialog.querySelector("[data-ai-detect-result]");
  if (detectResult) detectResult.hidden = true;
  syncAiProviderPanels(settingsDialog);
}

function readAiProviderSettings(settingsDialog) {
  const value = (selector) => String(settingsDialog.querySelector(selector)?.value ?? "").trim();
  return {
    aiCliEnabled: Boolean(settingsDialog.querySelector("[data-ai-cli-enabled]")?.checked),
    aiProvider: value("[data-ai-provider-select]") || "none",
    aiClaudeModel: readModelSelection(settingsDialog, "claude-code"),
    aiClaudeEffort: value("[name='aiClaudeEffort']"),
    aiCodexModel: readModelSelection(settingsDialog, "codex"),
    aiCodexEffort: value("[name='aiCodexEffort']"),
  };
}

/**
 * 接続先の切替と「検出」ボタンを配線する。ページ初期化時に一度だけ呼び出すこと。
 */
function wireAiProviderSettings(settingsDialog) {
  settingsDialog.querySelector("[data-ai-provider-select]")?.addEventListener("change", () => syncAiProviderPanels(settingsDialog));
  settingsDialog.querySelector("[data-ai-cli-enabled]")?.addEventListener("change", () => syncAiProviderPanels(settingsDialog));

  const detectBtn = settingsDialog.querySelector("[data-ai-detect-btn]");
  const resultEl = settingsDialog.querySelector("[data-ai-detect-result]");
  detectBtn?.addEventListener("click", async () => {
    if (!resultEl) return;
    resultEl.hidden = false;
    resultEl.textContent = "確認中...";
    detectBtn.disabled = true;
    try {
      const res = await fetch("/api/ai/detect");
      const data = await res.json();
      const line = (label, row) => {
        if (!row?.available) return `${label}: 見つかりません（${row?.error || "不明なエラー"}）`;
        const notes = [row.version || "バージョン不明"];
        if (row.olderThanTested) notes.push(`動作確認済みの ${row.testedVersion} より古いため、動かない可能性があります`);
        return `${label}: 利用できます（${notes.join("、")}）`;
      };
      resultEl.textContent = `${line("Claude Code", data.claudeCode)} ／ ${line("Codex", data.codex)}`;
    } catch (e) {
      resultEl.textContent = `確認に失敗しました: ${String(e?.message ?? e)}`;
    } finally {
      detectBtn.disabled = false;
    }
  });
}

/**
 * 設定ダイアログの天気地点セレクトへ選択肢と現在値を反映する。
 * @param {{key:string,name:string}[]} options getWeatherLocationOptions() の結果
 */
function populateWeatherLocationSelect(settingsDialog, selectedKey, options) {
  const selectEl = settingsDialog.querySelector("[data-weather-location-select]");
  if (!selectEl) return;
  const selected = String(selectedKey ?? "").trim() || "tokyo";

  selectEl.innerHTML = options
    .map((row) => `<option value="${escHtml(row.key)}">${escHtml(row.name)}</option>`)
    .join("");
  selectEl.value = options.some((row) => row.key === selected) ? selected : "tokyo";
}

/**
 * 設定ダイアログのタブ切り替えを配線する。
 */
function wireSettingsTabs(settingsDialog) {
  const tabButtons = Array.from(settingsDialog.querySelectorAll("[data-settings-tab]"));
  const tabPanels = Array.from(settingsDialog.querySelectorAll("[data-settings-tab-panel]"));
  if (!tabButtons.length || !tabPanels.length) {
    return { activate: () => {} };
  }

  const activate = (tabName) => {
    const target = String(tabName || tabButtons[0]?.getAttribute("data-settings-tab") || "general");

    tabButtons.forEach((btn) => {
      const active = btn.getAttribute("data-settings-tab") === target;
      btn.classList.toggle("isActive", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
      btn.tabIndex = active ? 0 : -1;
    });

    tabPanels.forEach((panel) => {
      const active = panel.getAttribute("data-settings-tab-panel") === target;
      panel.classList.toggle("isActive", active);
      panel.hidden = !active;
    });
  };

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      activate(btn.getAttribute("data-settings-tab"));
    });
  });

  activate("general");
  return { activate };
}

function populateUrlAutoOpenSettings(settingsDialog, settings) {
  const enabledEl = settingsDialog.querySelector("[name='urlAutoOpenEnabled']");
  const urlEl = settingsDialog.querySelector("[data-url-open-url-input]");
  const timesEl = settingsDialog.querySelector("[data-url-open-times-input]");
  if (enabledEl instanceof HTMLInputElement) {
    enabledEl.checked = settings?.urlAutoOpenEnabled === true;
  }
  if (urlEl instanceof HTMLInputElement) {
    urlEl.value = String(settings?.urlAutoOpenUrl ?? "");
    if (enabledEl instanceof HTMLInputElement) {
      urlEl.disabled = !enabledEl.checked;
    }
  }
  if (timesEl instanceof HTMLInputElement) {
    timesEl.value = normalizeUrlAutoOpenTimes(settings?.urlAutoOpenTimes).join(", ");
    if (enabledEl instanceof HTMLInputElement) {
      timesEl.disabled = !enabledEl.checked;
    }
  }
}

function readUrlAutoOpenSettings(settingsDialog) {
  const enabledEl = settingsDialog.querySelector("[name='urlAutoOpenEnabled']");
  const urlEl = settingsDialog.querySelector("[data-url-open-url-input]");
  const timesEl = settingsDialog.querySelector("[data-url-open-times-input]");
  const enabled = enabledEl instanceof HTMLInputElement
    ? enabledEl.checked
    : false;
  const url = urlEl instanceof HTMLInputElement
    ? urlEl.value.trim()
    : "";
  const timesText = timesEl instanceof HTMLInputElement
    ? timesEl.value
    : "";
  return {
    urlAutoOpenEnabled: enabled,
    urlAutoOpenUrl: url,
    urlAutoOpenTimes: normalizeUrlAutoOpenTimes(timesText),
  };
}

function populateCompanyHolidaySettings(settingsDialog, settings) {
  const inputEl = settingsDialog.querySelector("[data-company-holidays-input]");
  if (!(inputEl instanceof HTMLTextAreaElement)) return;
  inputEl.value = formatCompanyHolidayInputText(
    settings?.companyHolidayEntries,
  );
}

function readCompanyHolidaySettings(settingsDialog) {
  const inputEl = settingsDialog.querySelector("[data-company-holidays-input]");
  const text = inputEl instanceof HTMLTextAreaElement ? inputEl.value : "";
  const entries = parseCompanyHolidayText(text);
  return {
    companyHolidayEntries: entries,
    companyHolidays: entries.map((row) => row.dateKey),
  };
}

/**
 * 取り込む設定のうち、URLを開く・外部へデータを送る設定を確認用の文言にする。
 * 他人から受け取った設定ファイルで、開くURLやAIの送信先を気づかないまま変えられないようにする。
 */
function describeSensitiveImportSettings(settings, providerLabels) {
  const lines = [];
  if (typeof settings.urlAutoOpenUrl === "string" && settings.urlAutoOpenUrl.trim()) {
    const enabled = settings.urlAutoOpenEnabled === true ? "有効" : "無効";
    lines.push(`・URL自動オープン（${enabled}）: ${settings.urlAutoOpenUrl.trim()}`);
  }
  normalizeQuickLinks(settings.quickLinks).forEach((row) => {
    lines.push(`・クイックリンク: ${row.label} → ${row.url}`);
  });
  if (settings.aiCliEnabled === true) {
    lines.push("・Claude Code / Codex との連携: オン");
  }
  if (typeof settings.aiProvider === "string" && settings.aiProvider !== "none") {
    const vendor = AI_CLI_VENDORS[settings.aiProvider];
    const label = providerLabels[settings.aiProvider] ?? settings.aiProvider;
    lines.push(vendor
      ? `・AIの接続先: ${label}（予定の内容が${vendor}へ送信されます）`
      : `・AIの接続先: ${label}`);
  }
  if (typeof settings.appIconUrl === "string" && settings.appIconUrl.trim()) {
    lines.push(`・アプリアイコンのURL: ${settings.appIconUrl.trim().slice(0, 200)}`);
  }
  return lines;
}

/**
 * 設定のエクスポート/インポートを配線する。ページ初期化時に一度だけ呼び出すこと。
 * インポートは即時に反映し、フォームの古い値で上書きしないようダイアログを閉じる。
 */
function bindSettingsTransfer(settingsDialog, Store) {
  const exportBtn = settingsDialog.querySelector("[data-settings-export-btn]");
  const fileEl = settingsDialog.querySelector("[data-settings-import-file]");
  const importBtn = settingsDialog.querySelector("[data-settings-import-btn]");
  const fileNameEl = settingsDialog.querySelector("[data-settings-import-file-name]");

  exportBtn?.addEventListener("click", () => {
    const data = buildSettingsExport(Store.getSettings(), Store.getAllTags());
    downloadJsonFile(data, `taskcalendar-plus-settings-${formatDateKey(new Date())}.json`);
    alert("設定を「ダウンロード」フォルダに保存しました。");
  });

  if (!(fileEl instanceof HTMLInputElement) || !(importBtn instanceof HTMLButtonElement)) return;
  fileEl.addEventListener("change", () => {
    if (fileNameEl) fileNameEl.textContent = fileEl.files?.[0]?.name ?? "未選択";
  });
  importBtn.addEventListener("click", async () => {
    const file = fileEl.files?.[0];
    if (!file) {
      alert("設定ファイル(JSON)を選択してください。");
      return;
    }
    let parsed;
    try {
      parsed = parseSettingsImport(await file.text(), { allowedSettingKeys: Object.keys(Store.getSettings()) });
    } catch (e) {
      alert(e?.message || "設定ファイルの読み込みに失敗しました。");
      return;
    }
    const settingCount = Object.keys(parsed.settings).length;
    const details = describeSensitiveImportSettings(parsed.settings, Store.AI_PROVIDER_LABELS ?? {});
    const message = [
      `設定${settingCount}項目とタグ${parsed.tags.length}件を取り込みます。現在の設定は上書きされます。`,
      ...(details.length ? ["", "次の設定が含まれています。内容を確認してください。", ...details] : []),
      "",
      "よろしいですか？",
    ].join("\n");
    if (!confirm(message)) return;
    try {
      const result = await Store.applySettingsImport(parsed);
      fileEl.value = "";
      if (fileNameEl) fileNameEl.textContent = "未選択";
      settingsDialog.close();
      alert(`取り込みました(設定${result.settingKeys}項目、タグ新規${result.createdTags}件・既存${result.existingTags}件)。`);
    } catch (e) {
      console.warn(`[settings] settings import failed:`, e);
      alert("設定の取り込みに失敗しました。");
    }
  });
}

/** JSONをファイルとしてダウンロードさせる(WebView2では「ダウンロード」フォルダへ保存される)。 */
function downloadJsonFile(data, fileName) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 全データのバックアップ/復元を配線する。ページ初期化時に一度だけ呼び出すこと。
 * 復元後は各画面の状態を作り直すためページを読み直す。
 */
function bindBackupRestore(settingsDialog, Store) {
  const exportBtn = settingsDialog.querySelector("[data-backup-export-btn]");
  const fileEl = settingsDialog.querySelector("[data-backup-file]");
  const restoreBtn = settingsDialog.querySelector("[data-backup-restore-btn]");
  const fileNameEl = settingsDialog.querySelector("[data-backup-file-name]");

  exportBtn?.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/backup");
      if (!res.ok) throw new Error(`status ${res.status}`);
      downloadJsonFile(await res.json(), `taskcalendar-plus-backup-${formatDateKey(new Date())}.json`);
      alert("バックアップを「ダウンロード」フォルダに保存しました。");
    } catch (e) {
      console.warn(`[settings] backup failed:`, e);
      alert("バックアップの作成に失敗しました。");
    }
  });

  if (!(fileEl instanceof HTMLInputElement) || !(restoreBtn instanceof HTMLButtonElement)) return;
  fileEl.addEventListener("change", () => {
    if (fileNameEl) fileNameEl.textContent = fileEl.files?.[0]?.name ?? "未選択";
  });
  restoreBtn.addEventListener("click", async () => {
    const file = fileEl.files?.[0];
    if (!file) {
      alert("バックアップファイル(JSON)を選択してください。");
      return;
    }
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      alert("JSONとして読み込めませんでした。");
      return;
    }
    const taskCount = Array.isArray(data?.tasks) ? data.tasks.length : 0;
    const tagCount = Array.isArray(data?.tags) ? data.tags.length : 0;
    const exportedAt = String(data?.exportedAt ?? "不明");
    const details = describeSensitiveImportSettings(
      data?.settings && typeof data.settings === "object" ? data.settings : {},
      Store.AI_PROVIDER_LABELS ?? {},
    );
    if (!confirm([
      `バックアップ(作成日時: ${exportedAt}、タスク${taskCount}件、タグ${tagCount}件)で全データを置き換えます。`,
      "今のタスク・タグ・設定・サマリー・メモはすべて消え、元に戻せません。",
      "念のため、先に今のデータの「バックアップ」を取っておくことをおすすめします。",
      ...(details.length ? ["", "次の設定が含まれています。内容を確認してください。", ...details] : []),
      "",
      "復元しますか？",
    ].join("\n"))) return;
    try {
      const res = await fetch("/api/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `status ${res.status}`);
      alert(`復元しました(タスク${body.tasks}件、タグ${body.tags}件、サマリー・メモ等${body.aiMemory}件)。画面を読み直します。`);
      window.location.reload();
    } catch (e) {
      console.warn(`[settings] restore failed:`, e);
      alert(`復元に失敗しました。データは変更されていません。
${String(e?.message ?? e)}`);
    }
  });
}

/**
 * 会社休日のJSON/CSV取込フォームを配線する。ページ初期化時に一度だけ呼び出すこと。
 */
function bindCompanyHolidayImport(settingsDialog) {
  const fileEl = settingsDialog.querySelector("[data-company-holidays-import-file]");
  const importBtn = settingsDialog.querySelector("[data-company-holidays-import-btn]");
  const inputEl = settingsDialog.querySelector("[data-company-holidays-input]");
  const fileNameEl = settingsDialog.querySelector("[data-company-holidays-file-name]");
  if (!(fileEl instanceof HTMLInputElement)) return;
  if (!(importBtn instanceof HTMLButtonElement)) return;
  if (!(inputEl instanceof HTMLTextAreaElement)) return;
  if (importBtn.dataset.holidaysImportBound === "1") return;

  importBtn.dataset.holidaysImportBound = "1";
  fileEl.addEventListener("change", () => {
    const name = fileEl.files?.[0]?.name ?? null;
    if (fileNameEl) fileNameEl.textContent = name ?? "未選択";
  });

  importBtn.addEventListener("click", async () => {
    const file = fileEl.files?.[0];
    if (!file) {
      alert("JSON/CSVファイルを選択してください。");
      return;
    }

    try {
      const text = await file.text();
      const importedEntries = parseCompanyHolidayText(text);
      if (!importedEntries.length) {
        alert("取り込める休日データが見つかりませんでした。");
        return;
      }

      const manualEntries = parseCompanyHolidayText(inputEl.value);
      const mergedEntries = normalizeCompanyHolidayEntries([...manualEntries, ...importedEntries]);
      inputEl.value = formatCompanyHolidayInputText(mergedEntries);
      fileEl.value = "";
      if (fileNameEl) fileNameEl.textContent = "未選択";
      alert(`${importedEntries.length}件の休日を取り込みました。`);
    } catch (e) {
      console.warn(`[settings] company holiday import failed:`, e);
      alert("JSON/CSVの読み込みに失敗しました。ファイル形式を確認してください。");
    }
  });
}

/**
 * Outlook同期ボタンを配線する。ページ初期化時に一度だけ呼び出すこと。
 * store.jsとの循環import回避のため、Storeはimportではなく引数で受け取る。
 * @param {object} Store 呼び出し側でimportした Store モジュール
 * @param {{getTagMgrMonth: () => string}} opts
 */
function wireOutlookSync(settingsDialog, Store, { getTagMgrMonth } = {}) {
  const syncBtn = settingsDialog.querySelector("[data-sync-outlook-btn]");
  const statusEl = settingsDialog.querySelector("[data-outlook-sync-status]");
  const daysEl = settingsDialog.querySelector("[name='outlookDays']");
  const tagEl = settingsDialog.querySelector("[data-outlook-tag-select]");
  const calendarEl = settingsDialog.querySelector("[name='outlookCalendarName']");

  if (!syncBtn || !statusEl) return;

  // タグ選択肢を更新
  const updateTagOptions = () => {
    if (!tagEl) return;
    const currentValue = tagEl.value;
    const options = tagEl.querySelectorAll("option");
    options.forEach((opt) => {
      if (opt.value !== "") opt.remove();
    });
    const tagMgrMonth = getTagMgrMonth();
    const tags = Store.hasMonthTagOrder(tagMgrMonth)
      ? Store.getTagsForMonth(tagMgrMonth)
      : [];
    tags.forEach((tag) => {
      const option = document.createElement("option");
      option.value = tag.id;
      option.textContent = tag.name;
      tagEl.appendChild(option);
    });
    const exists = tags.some((tag) => String(tag.id) === String(currentValue));
    tagEl.value = exists ? currentValue : "";
  };
  settingsDialog.__refreshOutlookTagOptions = updateTagOptions;
  updateTagOptions();

  syncBtn.addEventListener("click", async () => {
    syncBtn.disabled = true;
    statusEl.textContent = "同期中...";
    statusEl.className = "";
    const controller = new AbortController();
    const timeoutMs = 45000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const days = Math.max(1, Math.min(Number(daysEl?.value) || 90, 365));
      const tagId = tagEl?.value || "";
      const calendarName = String(calendarEl?.value ?? "").trim() || "Calendar";

      // 次回自動同期用に同期パラメータを設定に保存
      await Store.updateSettings({
        outlookSyncCalendarName: calendarName,
        outlookSyncTagId: tagId,
        outlookSyncDaysAhead: days,
      }).catch(() => {});

      const response = await fetch("/api/outlook/auto-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: controller.signal,
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err?.error || "Outlook同期に失敗しました");
      }

      const result = await response.json();
      if (!result?.success) {
        throw new Error("Outlook同期の応答が無効です");
      }

      await Store.refreshTasks().catch(() => {});

      const added = Number(result?.added || 0);
      const skipped = Number(result?.skipped || 0);
      const deleted = Number(result?.deleted || 0);

      if (added === 0 && skipped === 0 && deleted === 0) {
        statusEl.textContent = "変更はありませんでした";
      } else {
        const parts = [`${added}件を取り込み`];
        if (skipped > 0) parts.push(`${skipped}件を重複スキップ`);
        if (deleted > 0) parts.push(`${deleted}件を削除`);
        statusEl.textContent = parts.join("、");
      }
      statusEl.className = "success";

      setTimeout(() => {
        statusEl.textContent = "";
        statusEl.className = "";
      }, 4000);

    } catch (e) {
      console.warn(`[settings] Outlook sync failed:`, e);
      const message = e?.name === "AbortError"
        ? `タイムアウト: ${Math.floor(timeoutMs / 1000)}秒以内に完了しませんでした。Outlookを開いて再試行してください。`
        : String(e?.message || e || "不明なエラー");
      statusEl.textContent = `エラー: ${message}`;
      statusEl.className = "error";
      setTimeout(() => {
        statusEl.textContent = "";
        statusEl.className = "";
      }, 5000);
    } finally {
      clearTimeout(timeoutId);
      syncBtn.disabled = false;
    }
  });

  Store.subscribe("tags", () => updateTagOptions());
}

const THEME_STORAGE_KEY = "tcplus_theme";

function _applyTheme(theme) {
  const isDark = theme === "dark";
  document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
  applyUiColor(document.documentElement.dataset.uiAccentColor);
}

/**
 * 設定ダイアログ右上のダーク/ライト切替トグルを配線する。
 * ダイアログ自体はカレンダー/タスク一覧/AIモードの3画面から共有される
 * 単一インスタンスのため、複数回呼ばれても二重に配線しないよう
 * dataset フラグでガードする。テーマはlocalStorageへ永続化し、
 * 次回起動時はHTML先頭のインラインスクリプトで再読込前に適用する。
 */
function _wireThemeToggle(settingsDialog) {
  const toggle = settingsDialog.querySelector("[data-theme-toggle]");
  if (!(toggle instanceof HTMLButtonElement)) return;
  if (toggle.dataset.themeToggleBound === "1") return;
  toggle.dataset.themeToggleBound = "1";

  const syncPressedState = () => {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    toggle.setAttribute("aria-pressed", String(isDark));
  };
  syncPressedState();

  toggle.addEventListener("click", () => {
    const nextIsDark = document.documentElement.getAttribute("data-theme") !== "dark";
    _applyTheme(nextIsDark ? "dark" : "light");
    try {
      window.localStorage?.setItem(THEME_STORAGE_KEY, nextIsDark ? "dark" : "light");
    } catch {
      // ignore storage errors (private browsing 等)
    }
    syncPressedState();
  });
}

// カレンダー/タスク一覧/AIモードの3画面が同じ設定ダイアログ要素を共有しているため、各画面のinit()から
// wireSettingsDialog()が複数回呼ばれる。ダイアログ本体の配線(休憩時間追加・保存・
// タグ管理など)を毎回やり直すと、その回数分イベントリスナーが重複登録され、
// 例えば「休憩時間を追加」を1回押しただけで行が複数追加される不具合になる。
// そのため実体の配線は要素ごとに1回だけ行い、画面ごとに異なる
// onAfterSave/getTagMgrSeedDate等は「どの画面の⚙設定ボタンが押されたか」に応じて
// state.activeConfigへ都度差し替える。
function _wireSettingsDialogCore(settingsDialog, Store) {
  wireUiColorPicker(settingsDialog, Store);
  const timeValues = buildSettingsTimeValues(15);
  let _tagMgrMonth = formatYearMonth(new Date());
  const state = { activeConfig: {} };
  const getConfig = () => state.activeConfig;

  const renderTagManager = () => _renderTagManager(settingsDialog, Store, _tagMgrMonth);

  // logPrefix はconsole.warn用の目印に過ぎず、複数画面分を厳密に出し分ける実益が
  // 無いため、コア配線(1回だけ実行)の時点の固定文字列でよい。
  _wireThemeToggle(settingsDialog);
  bindCompanyHolidayImport(settingsDialog);
  bindSettingsTransfer(settingsDialog, Store);
  bindBackupRestore(settingsDialog, Store);
  wireAiProviderSettings(settingsDialog);
  wireOutlookSync(settingsDialog, Store, { getTagMgrMonth: () => _tagMgrMonth });

  const tabControl = wireSettingsTabs(settingsDialog);

  // 全画面で実際には同じ既定色(DEFAULT_TAG_COLOR)を渡してくるため、
  // ピッカー自体はコア配線時の1回だけ生成すればよい。
  const _newTagColorCtl = buildHslPicker(
    settingsDialog.querySelector("[data-new-tag-hsl-picker]"),
    DEFAULT_TAG_COLOR,
  );

  const addTagBtn = settingsDialog.querySelector("[data-add-tag]");
  const saveBtn = settingsDialog.querySelector("[data-settings-save]");
  const urlOpenEnabledEl = settingsDialog.querySelector("[name='urlAutoOpenEnabled']");
  const urlOpenTimesEl = settingsDialog.querySelector("[data-url-open-times-input]");
  const urlOpenUrlEl = settingsDialog.querySelector("[data-url-open-url-input]");

  const syncUrlOpenInputState = () => {
    if (!(urlOpenEnabledEl instanceof HTMLInputElement)) return;
    if (urlOpenTimesEl instanceof HTMLInputElement) urlOpenTimesEl.disabled = !urlOpenEnabledEl.checked;
    if (urlOpenUrlEl instanceof HTMLInputElement) urlOpenUrlEl.disabled = !urlOpenEnabledEl.checked;
  };

  urlOpenEnabledEl?.addEventListener("change", syncUrlOpenInputState);

  // PCログイン時の自動起動(tauri-plugin-autostart)。DB保存の
  // settingsではなくOS側の実際の登録状態を直接取得・変更する。
  const launchAtLoginEl = settingsDialog.querySelector("[name='launchAtLogin']");
  launchAtLoginEl?.addEventListener("change", async () => {
    if (!(launchAtLoginEl instanceof HTMLInputElement)) return;
    const core = window.__TAURI__?.core;
    if (!core || typeof core.invoke !== "function") return;
    const desired = launchAtLoginEl.checked;
    try {
      await core.invoke("set_autostart_enabled", { enabled: desired });
    } catch (e) {
      console.error("[autostart] set_autostart_enabled failed:", e);
      launchAtLoginEl.checked = !desired;
    }
  });

  // タスクトレイに格納しない設定では「起動時にトレイへ格納」も無意味なため連動させる。
  const trayEnabledEl = settingsDialog.querySelector("[name='trayEnabled']");
  const startMinimizedEl = settingsDialog.querySelector("[name='startMinimizedToTray']");
  trayEnabledEl?.addEventListener("change", () => {
    if (!(trayEnabledEl instanceof HTMLInputElement)) return;
    if (!(startMinimizedEl instanceof HTMLInputElement)) return;
    startMinimizedEl.disabled = !trayEnabledEl.checked;
  });

  const addTag = async () => {
    const nameEl = settingsDialog.querySelector("[data-new-tag-name]");
    const name = nameEl?.value.trim();
    const color = _newTagColorCtl?.getColor() || DEFAULT_TAG_COLOR;
    if (!name) { nameEl?.focus(); return; }
    const newTag = await Store.createTag({ name, color });
    if (nameEl) nameEl.value = "";
    if (newTag && !Store.hasMonthTagOrder(_tagMgrMonth)) {
      await Store.setMonthTagOrder(_tagMgrMonth, [newTag.id]);
    } else if (newTag && Store.hasMonthTagOrder(_tagMgrMonth)) {
      const ids = Store.getTagsForMonth(_tagMgrMonth).map((t) => t.id);
      if (!ids.includes(newTag.id)) ids.push(newTag.id);
      await Store.setMonthTagOrder(_tagMgrMonth, ids);
    }
    renderTagManager();
  };

  let savingSettings = false;
  let dialogSession = 0;
  const saveSettings = async () => {
    if (savingSettings) return;
    const savingSession = dialogSession;
    const onAfterSave = getConfig().onAfterSave;
    const current = Store.getSettings();
    const nextProvider = settingsDialog.querySelector("[data-ai-provider-select]")?.value ?? "none";
    const nextCliEnabled = Boolean(settingsDialog.querySelector("[data-ai-cli-enabled]")?.checked);
    const vendor = nextCliEnabled ? AI_CLI_VENDORS[nextProvider] : undefined;
    if (vendor && (nextProvider !== current.aiProvider || !current.aiCliEnabled)) {
      const label = Store.AI_PROVIDER_LABELS?.[nextProvider] ?? nextProvider;
      const ok = confirm(
        `${label}を使うと、AIモード・日次サマリーの実行時に、予定のタイトル・時刻・メモ・気づきメモの内容が`
        + `このPCの${label}を通じて${vendor}へ送信されます。

よろしいですか？`,
      );
      if (!ok) return;
    }
    const patch = {
      workStart: settingsDialog.querySelector("[name='workStart']")?.value || current.workStart,
      workEnd: settingsDialog.querySelector("[name='workEnd']")?.value || current.workEnd,
      breaks: readBreaksFromEditor(settingsDialog.querySelector("[data-breaks-list]")),
      granularity: Number(settingsDialog.querySelector("[name='granularity']")?.value || current.granularity),
      showBusinessDaysOnly: Boolean(settingsDialog.querySelector("[name='showBusinessDaysOnly']")?.checked),
      ...readUrlAutoOpenSettings(settingsDialog),
      quickLinks: normalizeQuickLinks(settingsDialog.querySelector("[data-quick-links-input]")?.value ?? ""),
      uiAccentColor: readUiColor(settingsDialog),
      ...readCompanyHolidaySettings(settingsDialog),
      ...readAiProviderSettings(settingsDialog),
      weatherLocationKey: settingsDialog.querySelector("[name='weatherLocationKey']")?.value || current.weatherLocationKey || "tokyo",
      outlookAutoSync: Boolean(settingsDialog.querySelector("[name='outlookAutoSync']")?.checked),
      outlookAutoSyncIntervalMin: Number(settingsDialog.querySelector("[name='outlookAutoSyncIntervalMin']")?.value) || 10,
      trayEnabled: Boolean(settingsDialog.querySelector("[name='trayEnabled']")?.checked),
      checkUpdatesOnStartup: Boolean(settingsDialog.querySelector("[name='checkUpdatesOnStartup']")?.checked),
      startMinimizedToTray: Boolean(settingsDialog.querySelector("[name='startMinimizedToTray']")?.checked),
    };
    savingSettings = true;
    if (saveBtn) saveBtn.disabled = true;
    try {
      await Store.updateSettings(patch);
      if (dialogSession === savingSession) settingsDialog.close();
      onAfterSave?.(patch);
    } catch (error) {
      alert(`設定を保存できませんでした。もう一度お試しください。\n${String(error?.message ?? error)}`);
    } finally {
      savingSettings = false;
      if (saveBtn) saveBtn.disabled = false;
    }
  };

  const openDialog = (initialTab) => {
    dialogSession += 1;
    const { getTagMgrSeedDate, getWeatherLocationOptions } = getConfig();
    const s = Store.getSettings();
    const updateCheckEl = settingsDialog.querySelector("[name='checkUpdatesOnStartup']");
    if (updateCheckEl) updateCheckEl.checked = s.checkUpdatesOnStartup !== false;
    populateUiColor(settingsDialog, s.uiAccentColor);
    populateSettingsTimeSelects(settingsDialog, s, timeValues);
    populateUrlAutoOpenSettings(settingsDialog, s);
    const quickLinksEl = settingsDialog.querySelector("[data-quick-links-input]");
    if (quickLinksEl instanceof HTMLTextAreaElement) quickLinksEl.value = formatQuickLinksText(s.quickLinks);
    populateCompanyHolidaySettings(settingsDialog, s);
    populateAiProviderSettings(settingsDialog, s);
    populateWeatherLocationSelect(settingsDialog, s.weatherLocationKey, getWeatherLocationOptions ? getWeatherLocationOptions() : []);
    const granularityEl = settingsDialog.querySelector("[name='granularity']");
    if (granularityEl) granularityEl.value = String(s.granularity);
    const businessOnlyEl = settingsDialog.querySelector("[name='showBusinessDaysOnly']");
    if (businessOnlyEl) businessOnlyEl.checked = Boolean(s.showBusinessDaysOnly);
    const autoSyncEl = settingsDialog.querySelector("[name='outlookAutoSync']");
    if (autoSyncEl) autoSyncEl.checked = Boolean(s.outlookAutoSync);
    const intervalEl = settingsDialog.querySelector("[name='outlookAutoSyncIntervalMin']");
    if (intervalEl) intervalEl.value = String(s.outlookAutoSyncIntervalMin || 10);
    const calEl = settingsDialog.querySelector("[name='outlookCalendarName']");
    if (calEl) calEl.value = s.outlookSyncCalendarName || calEl.value;
    const daysEl2 = settingsDialog.querySelector("[name='outlookDays']");
    if (daysEl2) daysEl2.value = String(s.outlookSyncDaysAhead || daysEl2.value);
    const trayEnabledEl = settingsDialog.querySelector("[name='trayEnabled']");
    if (trayEnabledEl) trayEnabledEl.checked = Boolean(s.trayEnabled);
    const startMinimizedEl = settingsDialog.querySelector("[name='startMinimizedToTray']");
    if (startMinimizedEl) {
      startMinimizedEl.checked = Boolean(s.startMinimizedToTray);
      startMinimizedEl.disabled = !s.trayEnabled;
    }
    syncUrlOpenInputState();
    if (launchAtLoginEl instanceof HTMLInputElement) {
      const core = window.__TAURI__?.core;
      if (core && typeof core.invoke === "function") {
        core.invoke("get_autostart_enabled").then((enabled) => {
          launchAtLoginEl.checked = Boolean(enabled);
        }).catch(() => {});
      }
    }
    const versionChipEl = settingsDialog.querySelector("[data-app-version-chip]");
    if (versionChipEl) {
      const version = Store.getRuntimeInfo().appVersion;
      versionChipEl.textContent = version ? `v${version}` : "";
      versionChipEl.hidden = !version;
    }
    tabControl.activate(initialTab || "general");
    _tagMgrMonth = formatYearMonth(getTagMgrSeedDate ? getTagMgrSeedDate() : new Date());
    renderTagManager();
    settingsDialog.showModal();
    requestAnimationFrame(() => {
      settingsDialog.querySelector("[data-settings-save]")?.focus({ preventScroll: true });
    });
  };

  addTagBtn?.addEventListener("click", () => { void addTag(); });

  settingsDialog.querySelector("[data-add-break]")?.addEventListener("click", () => {
    addBreakRow(settingsDialog.querySelector("[data-breaks-list]"), timeValues);
  });

  settingsDialog.querySelector("[data-copy-prev-month]")?.addEventListener("click", async () => {
    await Store.copyTagOrderFromPrevMonth(_tagMgrMonth);
    renderTagManager();
  });

  settingsDialog.querySelector("[data-tagmgr-prev]")?.addEventListener("click", () => {
    const [y, m] = _tagMgrMonth.split("-").map(Number);
    _tagMgrMonth = m === 1
      ? `${y - 1}-${String(12).padStart(2, "0")}`
      : `${y}-${String(m - 1).padStart(2, "0")}`;
    renderTagManager();
  });
  settingsDialog.querySelector("[data-tagmgr-next]")?.addEventListener("click", () => {
    const [y, m] = _tagMgrMonth.split("-").map(Number);
    _tagMgrMonth = m === 12
      ? `${y + 1}-01`
      : `${y}-${String(m + 1).padStart(2, "0")}`;
    renderTagManager();
  });

  settingsDialog.querySelector("[data-settings-cancel]")?.addEventListener("click", () => settingsDialog.close());

  saveBtn?.addEventListener("click", saveSettings);

  settingsDialog.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.target instanceof HTMLTextAreaElement) return;
    if (e.target.closest("[data-tag-list]")) {
      e.preventDefault();
      e.target.blur?.();
      return;
    }
    if (e.target.closest("[data-new-tag-name]")) {
      e.preventDefault();
      void addTag();
      return;
    }
    e.preventDefault();
    saveSettings();
  });

  return { state, openDialog, tabControl };
}

/**
 * 設定ダイアログ全体(タブ切替・休憩時間・会社休日・URL自動オープン・
 * AIモデル管理・タグ管理・Outlook同期・保存/キャンセル)を配線する。
 * calendar/tasks/ai-modeの3画面から画面ごとに呼ばれる(それぞれ自身の
 * ⚙設定ボタンをtriggerRootで指定)が、ダイアログ本体の実配線は初回呼び出し時
 * のみ行われ、以降はonAfterSave等の差し替えだけが行われる(_wireSettingsDialogCore参照)。
 * store.jsとの循環import回避のため、Storeはimportではなく引数で受け取る。
 * @param {object} Store 呼び出し側でimportした Store モジュール
 * @param {{
 *   getTagMgrSeedDate: () => Date,
 *   onAfterSave: (patch) => void,
 *   triggerRoot?: ParentNode,
 * }} opts
 */
export function wireSettingsDialog(settingsDialog, Store, {
  getTagMgrSeedDate,
  onAfterSave,
  getWeatherLocationOptions,
  triggerRoot = document,
} = {}) {
  if (!settingsDialog) return null;

  if (!settingsDialog._wsdCore) {
    settingsDialog._wsdCore = _wireSettingsDialogCore(settingsDialog, Store);
  }
  const core = settingsDialog._wsdCore;
  const config = { getTagMgrSeedDate, onAfterSave, getWeatherLocationOptions };

  const open = (initialTab) => {
    core.state.activeConfig = config;
    core.openDialog(initialTab);
  };

  triggerRoot.querySelector("[data-settings-btn]")?.addEventListener("click", () => open());

  return { open, tabControl: core.tabControl };
}

// サイドバーの月次/日次集計のタグ行をクリックしたら、設定ダイアログを
// タグ管理タブが開いた状態で起動する。行の描画がStore更新のたびに再生成される
// ため、親要素(サイドバー全体)へのイベント委譲で対応する。calendar.js/tasks.js/
// ai-mode.jsの3画面で共用する。getSettingsDialogControlは
// 呼び出し側のwireSettingsDialog()戻り値を毎回最新の状態で参照するための
// コールバック(_wireSideTagClickToSettings()実行時点ではまだopen前の可能性があるため)。
export function wireSideTagClickToSettings(root, getSettingsDialogControl) {
  root.querySelector("[data-side-month-summary]")?.closest("aside")
    ?.addEventListener("click", (e) => {
      const row = e.target.closest?.("[data-tag-id]");
      if (!row) return;
      getSettingsDialogControl()?.open("tags");
    });
}

function setTimeSelectOptions(selectEl, selectedValue, timeValues) {
  if (!selectEl) return;
  selectEl.innerHTML = "";
  timeValues.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    selectEl.appendChild(opt);
  });
  const normalized = String(selectedValue ?? "").trim();
  if (normalized && !timeValues.includes(normalized)) {
    const opt = document.createElement("option");
    opt.value = normalized;
    opt.textContent = `${normalized}（既存値）`;
    selectEl.appendChild(opt);
  }
  selectEl.value = normalized || timeValues[0];
}

/**
 * 休憩時間帯の編集UI(行の追加・削除)を描画する。
 * @param {HTMLElement} container 行を並べるコンテナ要素
 * @param {{start:string,end:string}[]} breaks 現在の休憩時間帯
 * @param {string[]} timeValues 時刻選択肢(15分刻みの一覧など)
 */
function renderBreaksEditor(container, breaks, timeValues) {
  if (!container) return;
  const list = breaks.length ? breaks : [{ start: "12:00", end: "13:00", countAsWork: false }];
  container.innerHTML = list
    .map((_, i) => `
      <div class="settingsTimeRange settingsBreakRow" data-break-row="${i}">
        <div class="settingsTimeField">
          <label>開始</label>
          <select class="settingsTimeSelect" data-break-start></select>
        </div>
        <div class="settingsTimeField">
          <label>終了</label>
          <select class="settingsTimeSelect" data-break-end></select>
        </div>
        <label class="settingsCheck settingsBreakCountAsWork">
          <input type="checkbox" data-break-count-as-work />
          <span>工数に含める</span>
        </label>
        <button class="btn settingsBreakRemoveBtn" type="button" data-remove-break aria-label="この休憩時間を削除">✕</button>
      </div>
    `)
    .join("");
  container.querySelectorAll("[data-break-row]").forEach((row) => {
    const idx = Number(row.getAttribute("data-break-row"));
    const b = list[idx];
    setTimeSelectOptions(row.querySelector("[data-break-start]"), b.start, timeValues);
    setTimeSelectOptions(row.querySelector("[data-break-end]"), b.end, timeValues);
    const countAsWorkEl = row.querySelector("[data-break-count-as-work]");
    if (countAsWorkEl instanceof HTMLInputElement) countAsWorkEl.checked = Boolean(b.countAsWork);
    row.querySelector("[data-remove-break]")?.addEventListener("click", () => {
      const next = readBreaksFromEditor(container).filter((_, i) => i !== idx);
      renderBreaksEditor(container, next, timeValues);
    });
  });
}

/** 休憩時間帯の行を1つ追加する(既定18:00-18:15、工数計算からは除外)。 */
function addBreakRow(container, timeValues) {
  const current = readBreaksFromEditor(container);
  current.push({ start: "18:00", end: "18:15", countAsWork: false });
  renderBreaksEditor(container, current, timeValues);
}

/** 編集UIから現在の休憩時間帯一覧を読み取る。 */
function readBreaksFromEditor(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll("[data-break-row]"))
    .map((row) => ({
      start: row.querySelector("[data-break-start]")?.value || "",
      end: row.querySelector("[data-break-end]")?.value || "",
      countAsWork: Boolean(row.querySelector("[data-break-count-as-work]")?.checked),
    }))
    .filter((b) => b.start && b.end);
}
