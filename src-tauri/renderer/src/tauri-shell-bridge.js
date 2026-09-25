// 画面ロジックとTauri APIの間をつなぐ橋渡しスクリプト。
//
// 外部リンク(window.open呼び出し、target="_blank"のアンカー)は、
// @tauri-apps/plugin-shellのopen()コマンドでOSブラウザに開く。レンダラーは
// ビルドステップを持たないため、withGlobalTauri経由のwindow.__TAURI__.shell.openを
// 呼ぶだけの薄い層としてここにまとめ、画面ロジック本体はTauri APIに依存させない。
(function () {
  'use strict';

  // 組み込みHTTP API(/api/)への要求に、起動ごとの合言葉ヘッダーを付ける。
  // 合言葉はHTTPでは配らず、Tauriコマンドでだけ受け取る(他のWebページや
  // DNSリバインディングから読み取れないようにするため)。画面側のfetch呼び出しは
  // 変更せずに済むよう、ここでwindow.fetchを包む。合言葉の取得が終わるまで
  // /api/ への要求は待たせる。
  var API_TOKEN_HEADER = 'X-TCPlus-Token';
  var tauriCore = window.__TAURI__ && window.__TAURI__.core;
  var apiTokenPromise = (tauriCore && typeof tauriCore.invoke === 'function')
    ? tauriCore.invoke('get_api_token').catch(function (err) {
      console.error('[api-token] get_api_token の呼び出しに失敗しました:', err);
      return '';
    })
    : Promise.resolve('');

  function isOwnApiUrl(input) {
    var raw = typeof input === 'string' ? input : (input && input.url) || '';
    try {
      var url = new URL(raw, window.location.href);
      return url.origin === window.location.origin && url.pathname.indexOf('/api/') === 0;
    } catch (e) {
      return false;
    }
  }

  var originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    if (!isOwnApiUrl(input)) return originalFetch(input, init);
    return apiTokenPromise.then(function (token) {
      var options = Object.assign({}, init || {});
      var headers = new Headers(options.headers || (input instanceof Request ? input.headers : undefined));
      if (token) headers.set(API_TOKEN_HEADER, token);
      options.headers = headers;
      return originalFetch(input, options);
    });
  };

  function isExternalHttpUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
  }

  function openExternal(url) {
    var shell = window.__TAURI__ && window.__TAURI__.shell;
    if (shell && typeof shell.open === 'function') {
      shell.open(url);
    }
  }

  // main.jsのURL自動オープンタイマー(window.open(url, "_blank"))相当を横取りする。
  var originalOpen = window.open ? window.open.bind(window) : null;
  window.open = function (url, target, features) {
    if (isExternalHttpUrl(url)) {
      openExternal(url);
      return null;
    }
    return originalOpen ? originalOpen(url, target, features) : null;
  };

  // app.html内の外部リンクを横取りする。
  //
  // target="_blank"を付けたリンクはWebView2がクリックとは別経路で
  // ネイティブの新規ウィンドウ要求(NewWindowRequested)を発生させ、下のJS横取りと
  // 二重に開いてしまう(タブが2つ開く)。そのためリンク側は
  // target="_blank"を付けず、hrefのみで外部リンクかどうかを判定する。
  document.addEventListener(
    'click',
    function (event) {
      var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      var href = anchor.getAttribute('href');
      if (!isExternalHttpUrl(href)) return;
      event.preventDefault();
      openExternal(href);
    },
    true
  );

  // Native preference file is shared across localhost ports. Legacy localStorage
  // values are imported once when that file does not exist yet.
  var ZOOM_STORAGE_KEY = 'tcplus_ui_zoom';
  var THEME_STORAGE_KEY = 'tcplus_theme';
  var ZOOM_MIN = 0.5;
  var ZOOM_MAX = 3.0;
  var ZOOM_STEP = 0.1;

  function readStoredZoom() {
    try {
      var raw = window.localStorage.getItem(ZOOM_STORAGE_KEY);
      var n = parseFloat(raw);
      if (Number.isFinite(n) && n >= ZOOM_MIN && n <= ZOOM_MAX) return n;
    } catch (e) {}
    return null;
  }

  function readStoredTheme() {
    try {
      var value = window.localStorage.getItem(THEME_STORAGE_KEY);
      return value === 'light' || value === 'dark' ? value : null;
    } catch (e) { return null; }
  }

  var _zoomLevel = 1.0;
  var _zoomOperations = Promise.resolve();
  var _preferenceWrite = Promise.resolve();
  function invokePreference(command, args) {
    if (!tauriCore || typeof tauriCore.invoke !== 'function') return Promise.resolve();
    var result = _preferenceWrite.then(function () { return tauriCore.invoke(command, args); });
    // A failed write must not block the next user retry.
    _preferenceWrite = result.catch(function () {});
    return result;
  }

  var preferencesReady = (tauriCore && typeof tauriCore.invoke === 'function')
    ? tauriCore.invoke('get_ui_preferences').then(async function (saved) {
      if (saved) {
        document.documentElement.setAttribute('data-theme', saved.theme);
        _zoomLevel = saved.zoom;
        return;
      }
      var oldTheme = readStoredTheme();
      var oldZoom = readStoredZoom();
      document.documentElement.setAttribute('data-theme', oldTheme || 'light');
      if (oldZoom !== null) _zoomLevel = oldZoom;
      if (oldTheme) await invokePreference('set_ui_theme', { theme: oldTheme });
      if (oldZoom !== null) await invokePreference('set_ui_zoom', { level: oldZoom });
    }).catch(function (err) {
      console.error('[ui-preferences] 読み込みに失敗しました:', err);
      document.documentElement.setAttribute('data-theme', readStoredTheme() || 'light');
      _zoomLevel = readStoredZoom() || 1.0;
    })
    : Promise.resolve();

  window.tcplusUiPreferences = {
    ready: preferencesReady,
    setTheme: function (theme) {
      return preferencesReady.then(function () {
        return invokePreference('set_ui_theme', { theme: theme });
      });
    }
  };

  document.addEventListener('keydown', function (event) {
    if (!event.ctrlKey || event.altKey || event.metaKey) return;
    var key = event.key;
    // JIS配列では「+」がShift+;側にあり押しにくいため、Shift不要な「;」でも拡大できるようにする。
    if (key !== '+' && key !== '=' && key !== ';' && key !== '-' && key !== '0') return;
    event.preventDefault();
    var operation = _zoomOperations.then(function () { return preferencesReady; }).then(function () {
      var next = key === '0' ? 1.0
        : key === '-' ? Math.max(ZOOM_MIN, _zoomLevel - ZOOM_STEP)
          : Math.min(ZOOM_MAX, _zoomLevel + ZOOM_STEP);
      next = Math.round(next * 100) / 100;
      return invokePreference('set_ui_zoom', { level: next }).then(function () {
        _zoomLevel = next;
      });
    });
    _zoomOperations = operation.catch(function () {});
    void operation.catch(function (err) {
      console.error('[ui-zoom] set_ui_zoom の呼び出しに失敗しました:', err);
    });
  });
})();
