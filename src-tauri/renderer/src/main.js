/**
 * main.js — エントリーポイント
 *
 * Store を初期化(Rust側の組み込みHTTP API)してから、SPAシェル(app.html)を起動する。
 */

import * as Store from "./store.js";
import { startHeaderClock, timeToMinutes } from "./ui-utils.js";
import { applyUiColor } from "./ui-color-picker.js";
import { initAppUpdater } from "./app-updater.js";

// SPAシェル(app.html)で切替可能なビュー一覧。
const VIEW_MODULE_LOADERS = {
  calendar: () => import("./calendar.js"),
  tasks: () => import("./tasks.js"),
  ai: () => import("./ai-mode.js"),
};

const _mountedViews = new Map(); // name -> 初回importしたモジュール(再取得を避けるためキャッシュ)
let _currentView = null;

function showBootstrapError(error) {
  const message = (error && typeof error.message === "string" && error.message)
    ? error.message
    : String(error ?? "Unknown error");
  const panel = document.createElement("div");
  panel.style.margin = "16px";
  panel.style.padding = "12px";
  panel.style.border = "1px solid #ef4444";
  panel.style.borderRadius = "8px";
  panel.style.background = "#fff5f5";
  panel.style.color = "#7f1d1d";
  panel.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  panel.style.whiteSpace = "pre-wrap";
  panel.textContent = `起動エラー\n${message}\n\nCtrl+Shift+I でコンソールを開き、エラー詳細を確認してください。`;
  document.body.prepend(panel);
}

function _viewSection(name) {
  return document.querySelector(`#viewRoot .view[data-view="${name}"]`);
}

// 対象ビューのJSモジュールを初回のみ動的importしてinit(rootEl)を呼ぶ。
// 一度マウントしたビューは非表示にするだけで、二度とinit()を呼ばない
// (Store.subscribeの永続購読・calendar.jsの現在時刻線setIntervalが
// 再マウントのたびに積み重なるのを防ぐため)。既にマウント済みのビューを
// 再訪した場合はactivate()を呼び、sessionStorage/URLクエリ経由で他ビュー
// での日付選択を拾い直す(initはマウント時にしか実行されないため)。
async function _mountView(name) {
  const cached = _mountedViews.get(name);
  if (cached) {
    cached.activate?.();
    return _viewSection(name);
  }
  const rootEl = _viewSection(name);
  if (!rootEl) return null;
  const mod = await VIEW_MODULE_LOADERS[name]();
  mod.init(rootEl);
  _mountedViews.set(name, mod);
  return rootEl;
}

// アクティブなタブの位置・幅に合わせて.navIndicator(スライドするピル背景)を
// 追従させる(「スライド」はタブ切替ボタン自体の演出を指す)。
function _positionNavIndicator(activeLink) {
  const nav = activeLink?.closest("nav.nav");
  const indicator = nav?.querySelector(".navIndicator");
  if (!indicator || !activeLink) return;
  indicator.style.transform = `translateX(${activeLink.offsetLeft}px)`;
  indicator.style.width = `${activeLink.offsetWidth}px`;
}

function _updateNavCurrent(name) {
  document.querySelectorAll("nav.nav a[data-nav-target]").forEach((a) => {
    if (a.getAttribute("data-nav-target") === name) {
      a.setAttribute("aria-current", "page");
      _positionNavIndicator(a);
    } else {
      a.removeAttribute("aria-current");
    }
  });
}

// タブ切替: 同一ドキュメント内でhidden属性を付け替えるだけなので
// 画面のちらつきは発生しない。表示切替そのものは即時に行い、
// タブ切替ボタンの背景(.navIndicator)だけがCSSトランジションでスライドする。
async function switchView(name) {
  if (!(name in VIEW_MODULE_LOADERS) || name === _currentView) return;

  const rootEl = await _mountView(name);
  if (!rootEl) return;

  document.querySelectorAll("#viewRoot .view").forEach((section) => {
    section.hidden = section.getAttribute("data-view") !== name;
  });
  _currentView = name;
  _updateNavCurrent(name);
}

function _wireShellNav() {
  document.querySelectorAll("a[data-nav-target]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      void switchView(a.getAttribute("data-nav-target"));
    });
  });

  // ウィンドウ幅変化(nav折返し等)で.navIndicatorの位置がずれないよう追従させる。
  // resizeは連続発火するためrequestAnimationFrameで間引く。
  let _resizeRaf = 0;
  window.addEventListener("resize", () => {
    if (_resizeRaf) return;
    _resizeRaf = requestAnimationFrame(() => {
      _resizeRaf = 0;
      const current = document.querySelector('nav.nav a[aria-current="page"]');
      if (current) _positionNavIndicator(current);
    });
  });
}

// ヘッダーのクイックリンク(設定のquickLinks)を描画する。
// 外部リンクのクリックはtauri-shell-bridge.jsがOSブラウザへ振り向けるため、
// target="_blank"は付けない(二重に開くのを防ぐ)。
function _renderQuickLinks() {
  const nav = document.querySelector("[data-quick-links]");
  if (!nav) return;
  const links = Store.getSettings().quickLinks ?? [];
  nav.replaceChildren(...links.map((row) => {
    const a = document.createElement("a");
    a.href = row.url;
    a.textContent = row.label;
    a.title = row.url;
    return a;
  }));
  nav.hidden = links.length === 0;
}

async function bootstrap() {
  try {
    await Store.init();
    applyUiColor(Store.getSettings().uiAccentColor);
    Store.subscribe("settings", () => {
      if (!document.querySelector('[data-settings-dialog]')?.open) applyUiColor(Store.getSettings().uiAccentColor);
    });

    startHeaderClock({ workEnd: Store.getSettings().workEnd });
    _renderQuickLinks();
    Store.subscribe("settings", _renderQuickLinks);
    _wireShellNav();
    await switchView("calendar");
    void initAppUpdater(Store);
  } catch (e) {
    console.error("[main] bootstrap failed:", e);
    showBootstrapError(e);
  }
  // FOUC解消: JS初期化完了後に表示
  requestAnimationFrame(() => {
    document.body.style.transition = "opacity 0.12s ease";
    document.body.style.opacity = "1";
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}

// ── 自動Webオープンタイマー ──────────────────────────
// 設定された時刻に、設定されたURLを自動で開く
(function _startAutoOpenTimer() {
  const _firedToday = new Set();

  function _autoOpenUrl(value) {
    const raw = String(value ?? "").trim();
    return /^https?:\/\/\S+$/i.test(raw) ? raw : "";
  }

  function _checkAutoOpen() {
    // Store.getSettings() は正規化済み(有効/無効は真偽値、時刻は HH:MM の配列)。
    const settings = Store.getSettings();
    if (settings.urlAutoOpenEnabled !== true) return;
    const url = _autoOpenUrl(settings.urlAutoOpenUrl);
    if (!url) return;

    const openAtMins = new Set(settings.urlAutoOpenTimes.map(timeToMinutes));

    const now = new Date();
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
    const mins = now.getHours() * 60 + now.getMinutes();
    const fireKey = `${key}:${mins}`;
    if (openAtMins.has(mins) && !_firedToday.has(fireKey)) {
      _firedToday.add(fireKey);
      window.open(url, "_blank");
    }
    // 日付変わったら古い記録を掃除
    if (_firedToday.size > 10) {
      for (const k of _firedToday) {
        if (!k.startsWith(key)) _firedToday.delete(k);
      }
    }
  }

  // 毎分0秒直後にチェックするため、次の分頭までの遅延を計算して起動
  function _scheduleNextMinute() {
    const now = new Date();
    const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 100;
    setTimeout(() => {
      _checkAutoOpen();
      setInterval(_checkAutoOpen, 60_000);
      // _scheduleNextMinute は最初の1回だけ呼ぶ（以降はsetIntervalで担う）
    }, msToNextMinute);
  }

  // 起動直後にも1回チェック（アプリが該当時刻内に起動された場合のため）
  _checkAutoOpen();
  _scheduleNextMinute();
})();
