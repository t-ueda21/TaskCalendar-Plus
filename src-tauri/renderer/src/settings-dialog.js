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
import { LOCAL_AI_PROVIDERS, populateLocalAiSettings, readLocalAiSettings, validateSelectedLocalAi, describeLocalAiImport, validateLocalAiImport } from "./local-ai-settings.js";
import { applyUiColor, populateUiColor, readUiColor, wireUiColorPicker } from "./ui-color-picker.js";
import { LANGUAGES, t as translate, applyTranslations, th as translateHtml } from './i18n.js';
import { readPersonalization, populatePersonalization } from "./ai-personalization.js";
import { wireOutlookSync as wireOutlookSyncV3 } from "./outlook-settings.js";
import { wireTransferUi } from "./transfer-ui.js";

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
  if (note) {
    note.hidden = provider === "none";
    note.textContent = LOCAL_AI_PROVIDERS[provider]
      ? translate('ui.4a16781f97')
      : translate('ui.d071681f9d');
  }
  const detect = settingsDialog.querySelector("[data-ai-detect-btn]");
  if (detect) detect.hidden = Boolean(LOCAL_AI_PROVIDERS[provider]);
  const cliNote = settingsDialog.querySelector("[data-ai-cli-note]");
  if (cliNote) cliNote.hidden = Boolean(LOCAL_AI_PROVIDERS[provider]);
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
  populateLocalAiSettings(settingsDialog, settings);
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
    ...readLocalAiSettings(settingsDialog),
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
    resultEl.textContent = translate('ui.0c40e92e4e');
    detectBtn.disabled = true;
    try {
      const res = await fetch("/api/ai/detect");
      const data = await res.json();
      const line = (label, row) => {
        if (!row?.available) return translate('ui.6b5d7576c3', { p0: (label), p1: (row?.error || "不明なエラー") });
        const notes = [row.version || translate('ui.e2c7d045c0')];
        if (row.olderThanTested) notes.push(translate('ui.387f965eb3', { p0: (row.testedVersion) }));
        return translate('ui.7bfa1d0443', { p0: (label), p1: (notes.join("、")) });
      };
      resultEl.textContent = `${line("Claude Code", data.claudeCode)} ／ ${line("Codex", data.codex)}`;
    } catch (e) {
      resultEl.textContent = translate('ui.821b093462', { p0: (String(e?.message ?? e)) });
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
    const enabled = settings.urlAutoOpenEnabled === true ? translate('ui.3ac909bffc') : translate('ui.383bbb5e84');
    lines.push(translate('ui.ddd6b62fbd', { p0: (enabled), p1: (settings.urlAutoOpenUrl.trim()) }));
  }
  normalizeQuickLinks(settings.quickLinks).forEach((row) => {
    lines.push(translate('ui.949c460181', { p0: (row.label), p1: (row.url) }));
  });
  if (settings.aiCliEnabled === true) {
    lines.push(translate('ui.c5d9d4a44d'));
  }
  if (typeof settings.aiProvider === "string" && settings.aiProvider !== "none") {
    const vendor = AI_CLI_VENDORS[settings.aiProvider];
    const label = providerLabels[settings.aiProvider] ?? settings.aiProvider;
    lines.push(vendor
      ? translate('ui.12b03038b3', { p0: (label), p1: (vendor) })
      : translate('ui.97ce940f2f', { p0: (label) }));
  }
  if (typeof settings.appIconUrl === "string" && settings.appIconUrl.trim()) {
    lines.push(translate('ui.b42af3153f', { p0: (settings.appIconUrl.trim().slice(0, 200)) }));
  }
  return lines;
}

/**
 * 設定のエクスポート/インポートを配線する。ページ初期化時に一度だけ呼び出すこと。
 * インポートは即時に反映し、フォームの古い値で上書きしないようダイアログを閉じる。
 */
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
    if (fileNameEl) fileNameEl.textContent = name ?? translate('ui.a28710cc66');
  });

  importBtn.addEventListener("click", async () => {
    const file = fileEl.files?.[0];
    if (!file) {
      alert(translate('ui.48ec6e953a'));
      return;
    }

    try {
      const text = await file.text();
      const importedEntries = parseCompanyHolidayText(text);
      if (!importedEntries.length) {
        alert(translate('ui.394a685552'));
        return;
      }

      const manualEntries = parseCompanyHolidayText(inputEl.value);
      const mergedEntries = normalizeCompanyHolidayEntries([...manualEntries, ...importedEntries]);
      inputEl.value = formatCompanyHolidayInputText(mergedEntries);
      fileEl.value = "";
      if (fileNameEl) fileNameEl.textContent = translate('ui.a28710cc66');
      alert(translate('ui.5384f8a49c', { p0: (importedEntries.length) }));
    } catch (e) {
      console.warn(`[settings] company holiday import failed:`, e);
      alert(translate('ui.8ca39f56b3'));
    }
  });
}

/**
 * Outlook同期ボタンを配線する。ページ初期化時に一度だけ呼び出すこと。
 * store.jsとの循環import回避のため、Storeはimportではなく引数で受け取る。
 * @param {object} Store 呼び出し側でimportした Store モジュール
 * @param {{getTagMgrMonth: () => string}} opts
 */
function _applyTheme(theme) {
  const isDark = theme === "dark";
  document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
  applyUiColor(document.documentElement.dataset.uiAccentColor);
}

/**
 * 設定ダイアログ右上のダーク/ライト切替トグルを配線する。
 * ダイアログ自体はカレンダー/タスク一覧/AIモードの3画面から共有される
 * 単一インスタンスのため、複数回呼ばれても二重に配線しないよう
 * dataset フラグでガードする。テーマはアプリのデータフォルダへ保存する。
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

  toggle.addEventListener("click", async () => {
    if (toggle.disabled) return;
    const nextIsDark = document.documentElement.getAttribute("data-theme") !== "dark";
    _applyTheme(nextIsDark ? "dark" : "light");
    toggle.disabled = true;
    try {
      await window.tcplusUiPreferences?.setTheme(nextIsDark ? "dark" : "light");
    } catch (error) {
      _applyTheme(nextIsDark ? "light" : "dark");
      console.error("[ui-theme] 設定を保存できませんでした:", error);
    } finally {
      toggle.disabled = false;
      syncPressedState();
    }
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
  const languageSelect = settingsDialog.querySelector('[data-language-select]');
  if (languageSelect) {
    languageSelect.replaceChildren();
    for (const row of [{ code: 'auto', name: translate('language.auto') }, ...LANGUAGES]) {
      const option = document.createElement('option'); option.value = row.code; option.textContent = row.name;
      if (row.code === 'auto') option.dataset.i18n = 'language.auto';
      languageSelect.appendChild(option);
    }
  }
  settingsDialog.querySelector('[data-ai-personality-reset]')?.addEventListener('click', () => populatePersonalization(settingsDialog, {}));
  let previewController = null;
  settingsDialog.addEventListener('close', () => { previewController?.abort(); previewController = null; });
  settingsDialog.querySelector('[data-ai-personality-preview]')?.addEventListener('click', async (event) => {
    if (previewController) return;
    const controller = new AbortController(); previewController = controller;
    const status = settingsDialog.querySelector('[data-ai-preview-status]');
    event.currentTarget.disabled = true;
    status.textContent = translate('ui.bf1fc22354');
    const timer = setTimeout(() => controller.abort(), 180000);
    try {
      const response = await fetch('/api/ai/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { ...readAiProviderSettings(settingsDialog), uiLanguage: languageSelect?.value ?? 'auto', aiPersonalization: readPersonalization(settingsDialog) } }), signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || translate('ui.d0596ad069'));
      if (previewController === controller) status.textContent = String(data.message?.content ?? '');
    } catch (error) { if (previewController === controller) status.textContent = String(error?.message ?? error); }
    finally { clearTimeout(timer); if (previewController === controller) previewController = null; if (!previewController) settingsDialog.querySelector('[data-ai-personality-preview]').disabled = false; }
  });
  const getConfig = () => state.activeConfig;

  const renderTagManager = () => _renderTagManager(settingsDialog, Store, _tagMgrMonth);

  // logPrefix はconsole.warn用の目印に過ぎず、複数画面分を厳密に出し分ける実益が
  // 無いため、コア配線(1回だけ実行)の時点の固定文字列でよい。
  _wireThemeToggle(settingsDialog);
  const syncSettingToggles = () => {
    settingsDialog.querySelector('[name="outlookAutoSyncIntervalMin"]').disabled =
      !settingsDialog.querySelector('[name="outlookAutoSync"]').checked;
  };
  settingsDialog.querySelector('[name="outlookAutoSync"]').addEventListener('change', syncSettingToggles);
  bindCompanyHolidayImport(settingsDialog);
  wireTransferUi(settingsDialog, Store, { downloadJsonFile, describeSensitiveImportSettings });
  wireAiProviderSettings(settingsDialog);
  wireOutlookSyncV3(settingsDialog, Store, { getTagMgrMonth: () => _tagMgrMonth, getSelectedDate: () => getConfig().getTagMgrSeedDate?.() ?? new Date() });

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
    if (savingSettings || !validateSelectedLocalAi(settingsDialog)) return false;
    const savingSession = dialogSession;
    const onAfterSave = getConfig().onAfterSave;
    const current = Store.getSettings();
    const nextProvider = settingsDialog.querySelector("[data-ai-provider-select]")?.value ?? "none";
    const nextCliEnabled = Boolean(settingsDialog.querySelector("[data-ai-cli-enabled]")?.checked);
    const vendor = nextCliEnabled ? AI_CLI_VENDORS[nextProvider] : undefined;
    if (vendor && (nextProvider !== current.aiProvider || !current.aiCliEnabled)) {
      const label = Store.AI_PROVIDER_LABELS?.[nextProvider] ?? nextProvider;
      const ok = confirm(
        translate('ui.4bc3090c37', { p0: (label) })
        + translate('ui.9a7c517e8d', { p0: (label), p1: (vendor) }),
      );
      if (!ok) return false;
    }
    const patch = {
      uiLanguage: languageSelect?.value ?? current.uiLanguage,
      aiPersonalization: readPersonalization(settingsDialog),
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
      outlookWriteDefault: Boolean(settingsDialog.querySelector('[name="outlookWriteDefault"]')?.checked),
      outlookWriteCalendarName: settingsDialog.querySelector('[name="outlookWriteCalendarName"]')?.value || 'Calendar',
      outlookAutoSyncIntervalMin: Number(settingsDialog.querySelector("[name='outlookAutoSyncIntervalMin']")?.value) || 10,
      trayEnabled: Boolean(settingsDialog.querySelector("[name='trayEnabled']")?.checked),
      checkUpdatesOnStartup: Boolean(settingsDialog.querySelector("[name='checkUpdatesOnStartup']")?.checked),
      startMinimizedToTray: Boolean(settingsDialog.querySelector("[name='startMinimizedToTray']")?.checked),
    };
    savingSettings = true;
    if (saveBtn) saveBtn.disabled = true;
    try {
      await Store.updateSettings(patch);
      try {
        await window.__TAURI__?.core?.invoke("set_tray_enabled", { enabled: patch.trayEnabled });
      } catch (error) {
        console.error("[tray] アイコン表示の切り替えに失敗しました:", error);
      }
      if (dialogSession === savingSession) settingsDialog.close();
      onAfterSave?.(patch);
      return dialogSession === savingSession;
    } catch (error) {
      alert(translate('ui.008379f02c', { p0: (String(error?.message ?? error)) }));
      return false;
    } finally {
      savingSettings = false;
      if (saveBtn) saveBtn.disabled = false;
    }
  };

  const openDialog = (initialTab) => {
    dialogSession += 1;
    const { getTagMgrSeedDate, getWeatherLocationOptions } = getConfig();
    const s = Store.getSettings();
    if (languageSelect) languageSelect.value = s.uiLanguage ?? 'auto';
    populatePersonalization(settingsDialog, s);
    settingsDialog.querySelector('[data-ai-preview-status]').textContent = '';
    applyTranslations(settingsDialog);
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
    settingsDialog.querySelector('[name="outlookWriteDefault"]').checked = s.outlookWriteDefault === true;
    settingsDialog.querySelector('[name="outlookWriteCalendarName"]').value = s.outlookWriteCalendarName || 'Calendar';
    const intervalEl = settingsDialog.querySelector("[name='outlookAutoSyncIntervalMin']");
    if (intervalEl) intervalEl.value = String(s.outlookAutoSyncIntervalMin || 10);
    syncSettingToggles();
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
    if (e.target.closest("button")) return;
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

  return { state, openDialog, tabControl, saveSettings };
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
    opt.textContent = translate('ui.08628f2e5b', { p0: (normalized) });
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
          <label>${translateHtml('ui.cc147e162c')}</label>
          <select class="settingsTimeSelect" data-break-start></select>
        </div>
        <div class="settingsTimeField">
          <label>${translateHtml('ui.8f26d43810')}</label>
          <select class="settingsTimeSelect" data-break-end></select>
        </div>
        <label class="uiToggle settingsBreakCountAsWork">
          <input class="uiToggleInput" type="checkbox" role="switch" data-break-count-as-work />
          <span class="themeToggleTrack" aria-hidden="true"><span class="themeToggleThumb"></span></span>
          <span class="themeToggleLabel">${translateHtml('ui.14348b04f7')}</span>
        </label>
        <button class="btn settingsBreakRemoveBtn" type="button" data-remove-break aria-label="${translateHtml('ui.97d99595dc')}">✕</button>
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
