import { t as translate, th as translateHtml } from './i18n.js';
import { showAppConfirm } from './app-dialogs.js';
/**
 * tag-manager.js — 設定ダイアログのタグ管理(月ごとのタグの並び・色・予算)と色の選択ポップアップ
 */

import { DEFAULT_TAG_COLOR } from "./ui-utils.js";

/**
 * タグ管理(月別タグ並び替え・色変更・追加・除外)のUIを描画する。
 * calendar/tasks/ai-modeで共用する。
 */
export function _renderTagManager(dlg, Store, tagMgrMonth) {
  const listEl = dlg.querySelector("[data-tag-list]");
  const monthLabelEl = dlg.querySelector("[data-tagmgr-month]");
  if (!listEl) return;

  if (monthLabelEl) {
    const [y, m] = tagMgrMonth.split("-").map(Number);
    monthLabelEl.textContent = translate('ui.b907b4b50e', { p0: (y), p1: (m) });
  }

  listEl.querySelectorAll(".hslPicker").forEach((el) => {
    if (typeof el.__hslDestroy === "function") el.__hslDestroy();
  });
  listEl.innerHTML = "";
  const emptyMsg = translate('ui.37a0e79eea');
  const tags = Store.getTagsForMonth(tagMgrMonth);
  if (!Store.hasMonthTagOrder(tagMgrMonth) || tags.length === 0) {
    const msg = document.createElement("div");
    msg.className = "settingsTagEmpty";
    msg.textContent = emptyMsg;
    listEl.appendChild(msg);
    if (typeof dlg.__refreshOutlookTagOptions === "function") {
      dlg.__refreshOutlookTagOptions();
    }
    return;
  }

  const saveOrder = async () => {
    const ids = Array.from(listEl.querySelectorAll("[data-tag-row]"))
      .map((el) => el.getAttribute("data-tag-row"));
    await Store.setMonthTagOrder(tagMgrMonth, ids);
  };

  // タグの並び順は行のドラッグ&ドロップで入れ替える。
  let _draggingTagRow = null;

  listEl.addEventListener("dragover", (e) => {
    if (!_draggingTagRow) return;
    e.preventDefault();
    if (e.target === listEl) listEl.appendChild(_draggingTagRow);
  });
  listEl.addEventListener("drop", async (e) => {
    if (!_draggingTagRow) return;
    e.preventDefault();
    await saveOrder();
  });

  tags.forEach((tag) => {
    const row = document.createElement("div");
    row.className = "settingsTagRow";
    row.setAttribute("data-tag-row", tag.id);
    row.draggable = true;

    row.addEventListener("dragstart", (e) => {
      _draggingTagRow = row;
      row.classList.add("isDragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", tag.id);
    });
    row.addEventListener("dragend", () => {
      _draggingTagRow = null;
      row.classList.remove("isDragging");
    });
    row.addEventListener("dragover", (e) => {
      if (!_draggingTagRow || _draggingTagRow === row) return;
      e.preventDefault();
      const rect = row.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      listEl.insertBefore(_draggingTagRow, before ? row : row.nextElementSibling);
    });
    row.addEventListener("drop", async (e) => {
      e.preventDefault();
      await saveOrder();
    });

    const dragHandle = document.createElement("button");
    dragHandle.type = 'button';
    dragHandle.className = "settingsTagDragHandle";
    dragHandle.setAttribute('aria-label', translate('ui.01605357a7') + ': ' + tag.name);
    dragHandle.textContent = "⠿";
    dragHandle.title = translate('ui.01605357a7');
    dragHandle.addEventListener('keydown', async event => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      event.stopPropagation();
      const sibling = event.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
      if (!sibling?.matches('[data-tag-row]')) return;
      if (event.key === 'ArrowUp') listEl.insertBefore(row, sibling);
      else listEl.insertBefore(sibling, row);
      await saveOrder();
      listEl.querySelector(`[data-tag-row="${tag.id}"] .settingsTagDragHandle`)?.focus();
    });

    const colorField = document.createElement("div");
    colorField.className = "hslPicker";

    const nameEl = document.createElement("input");
    nameEl.type  = "text";
    nameEl.value = tag.name;
    nameEl.className = "settingsTagInput";
    nameEl.setAttribute('aria-label', translate('ui.a0e69d6faf') + ': ' + tag.name);
    nameEl.addEventListener("blur", () => {
      const v = nameEl.value.trim();
      if (v && v !== tag.name) Store.updateTag(tag.id, { name: v });
    });

    // タグごとの月間予定工数(下限・上限、1時間刻みで入力しbudgetMinMinutes/
    // budgetMaxMinutes(分)で保存)。パターンは3つ: 未設定/上限のみ/下限+上限。
    // 下限は上限あってこそ意味を持つため、上限が空の間は下限欄を無効化する。
    // テーブル形式(列見出しはapp.html側の.settingsTagTableHeadで固定表示)のため、
    // ここでは入力欄だけを作り、ラベル文言は持たせない。
    const makeBudgetInput = (minutesValue) => {
      const input = document.createElement("input");
      input.type = "number";
      input.step = "1";
      input.min = "0";
      input.className = "settingsTagBudgetInput";
      input.placeholder = "—";
      const hours = Number.isFinite(minutesValue) && minutesValue > 0
        ? Math.round(minutesValue / 60)
        : null;
      input.value = hours == null ? "" : String(hours);
      return input;
    };

    const maxInput = makeBudgetInput(tag.budgetMaxMinutes);
    const minInput = makeBudgetInput(tag.budgetMinMinutes);
    maxInput.setAttribute('aria-label', translate('ui.38229718b2') + ': ' + tag.name);
    minInput.setAttribute('aria-label', translate('ui.cf20e6cfc6') + ': ' + tag.name);

    const syncMinEnabled = () => {
      const maxIsEmpty = maxInput.value.trim() === "";
      minInput.disabled = maxIsEmpty;
      if (maxIsEmpty) minInput.value = "";
    };
    syncMinEnabled();

    const commitBudget = () => {
      const toMinutes = (input) => {
        const raw = input.value.trim();
        const hours = raw === "" ? null : Number(raw);
        return hours == null || !Number.isFinite(hours) || hours <= 0 ? null : Math.round(hours * 60);
      };
      const nextMax = toMinutes(maxInput);
      const nextMin = nextMax == null ? null : toMinutes(minInput);
      const prevMax = Number.isFinite(tag.budgetMaxMinutes) && tag.budgetMaxMinutes > 0 ? tag.budgetMaxMinutes : null;
      const prevMin = Number.isFinite(tag.budgetMinMinutes) && tag.budgetMinMinutes > 0 ? tag.budgetMinMinutes : null;
      if (nextMax !== prevMax || nextMin !== prevMin) {
        Store.updateTag(tag.id, { budgetMaxMinutes: nextMax, budgetMinMinutes: nextMin });
      }
    };
    maxInput.addEventListener("input", syncMinEnabled);
    maxInput.addEventListener("blur", () => { syncMinEnabled(); commitBudget(); });
    minInput.addEventListener("blur", commitBudget);

    const delBtn = document.createElement("button");
    delBtn.className = "btn danger settingsDeleteBtn";
    delBtn.type = "button";
    delBtn.textContent = "✕";
    delBtn.title = translate('ui.bd6dc69e2d', { p0: (tag.name) });
    delBtn.addEventListener("click", async () => {
      const confirmed = await showAppConfirm(translate('ui.d33b3810a5', { p0: (tag.name) }), {
        danger: true, confirmLabel: translate('dialog.remove'),
        onConfirm: () => Store.removeTagFromMonth(tagMgrMonth, tag.id),
      });
      if (!confirmed) return;
      _renderTagManager(dlg, Store, tagMgrMonth);
      dlg.querySelector('[data-new-tag-name]')?.focus({ preventScroll: true });
    });

    row.append(dragHandle, colorField, nameEl, minInput, maxInput, delBtn);
    listEl.appendChild(row);

    // colorFieldがdialog配下に接続された後でpickerを構築する。
    // buildHslPickerはポップアップの表示先をcontainer.closest("dialog")で決めるため、
    // 未接続のまま呼ぶとdocument.bodyへ誤って配置され、モーダルの裏に隠れて見えなくなる。
    buildHslPicker(colorField, tag.color, async (nextColor) => {
      try {
        await Store.updateTag(tag.id, { color: nextColor });
        _renderTagManager(dlg, Store, tagMgrMonth);
      } catch (e) {
        console.error("[settings] updateTag failed:", e);
      }
    });
  });

  if (typeof dlg.__refreshOutlookTagOptions === "function") {
    dlg.__refreshOutlookTagOptions();
  }
}

// ── HSLカラーピッカー（ポップアップ式スウォッチ） ─────────────
// 色相だけを均等ステップにすると隣接色(黄緑〜緑〜青緑など)が近すぎて
// 見分けにくくなるため、色相に加えて彩度・明度もずらした色を個別に定義する
// (原色20種 + その明るいバリエーション20種で40色)。
// ポップアップは dialog（無ければ body）に fixed でマウントして確実に操作可能にする。
const _SWATCHES = [
  "#E4392B", // 赤
  "#E76423", // 朱色
  "#F2A007", // オレンジ
  "#C9A200", // 山吹(黄)
  "#7CB342", // 黄緑
  "#2E9E44", // 緑
  "#16A085", // 緑青(ティール)
  "#13AEAE", // シアン
  "#17A2B8", // 水色
  "#2B7DE9", // 青
  "#1B4F9C", // 紺
  "#3535D4", // インディゴ
  "#6C3FC5", // 紫
  "#8C33CC", // バイオレット
  "#9B2FAE", // 赤紫
  "#D6249F", // ピンク(マゼンタ)
  "#D0256C", // ローズ(深紅)
  "#E4576B", // 珊瑚(コーラル)
  "#A85C32", // 茶
  "#6B7280", // グレー
  "#E79E98", // 赤(明)
  "#E8AE92", // 朱色(明)
  "#EFC77B", // オレンジ(明)
  "#F0CE47", // 山吹(黄)(明)
  "#B3CA9B", // 黄緑(明)
  "#77C587", // 緑(明)
  "#53D5BB", // 緑青(ティール)(明)
  "#57DBDB", // シアン(明)
  "#65CCDC", // 水色(明)
  "#99BCEA", // 青(明)
  "#5988CF", // 紺(明)
  "#9C9CDE", // インディゴ(明)
  "#B19FD5", // 紫(明)
  "#BD97D8", // バイオレット(明)
  "#C080CB", // 赤紫(明)
  "#DE8CC4", // ピンク(マゼンタ)(明)
  "#DD88AB", // ローズ(深紅)(明)
  "#EDBFC6", // 珊瑚(コーラル)(明)
  "#C99B83", // 茶(明)
  "#9DA8BE", // グレー(明)
];

function _swatchDistance(hexA, hexB) {
  const ar = parseInt(hexA.slice(1, 3), 16), ag = parseInt(hexA.slice(3, 5), 16), ab = parseInt(hexA.slice(5, 7), 16);
  const br = parseInt(hexB.slice(1, 3), 16), bg = parseInt(hexB.slice(3, 5), 16), bb = parseInt(hexB.slice(5, 7), 16);
  return (ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2;
}

function _nearestSwatch(hex) {
  return _SWATCHES.reduce((best, swatch) => (
    _swatchDistance(swatch, hex) < _swatchDistance(best, hex) ? swatch : best
  ), _SWATCHES[0]);
}

/**
 * コンテナにポップアップ式スウォッチピッカーを構築する。
 * 平常時は色ボタン1つ。クリックで識別しやすい15色パレットが開く。
 * @returns {{ getColor: () => string, setColor: (hex: string) => void }}
 */
export function buildHslPicker(container, initialColor = DEFAULT_TAG_COLOR, onCommit = null) {
  // 既存インスタンスがあれば先に破棄（同一コンテナ再利用時の保険）
  if (typeof container?.__hslDestroy === "function") {
    container.__hslDestroy();
  }

  let selectedColor = _nearestSwatch(initialColor);
  let outsideHandler = null;
  let scrollHandler = null;
  let resizeHandler = null;
  let keyHandler = null;

  // 要素が見つからない場合でも呼び出し側を壊さない
  if (!container) {
    return {
      getColor: () => selectedColor,
      setColor: (hex) => {
        selectedColor = _nearestSwatch(hex);
      },
    };
  }

  // トリガーボタン（常時表示の色丸）
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "hslTrigger";
  trigger.title = translate('ui.df5c4c0450');
  trigger.setAttribute("aria-label", translate('ui.57b05322d6'));
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");

  // ポップアップパネル（dialog優先でマウント）
  const popup = document.createElement("div");
  popup.className = "hslPopup";
  popup.hidden = true;
  popup.setAttribute("role", "listbox");
  popup.setAttribute("aria-label", translate('ui.bb80a52a07'));

  const popupHost = container.closest("dialog") || document.body;
  popupHost.appendChild(popup);

  container.innerHTML = "";
  container.appendChild(trigger);

  function updateTrigger() {
    trigger.style.background = selectedColor;
    trigger.title = translate('ui.df5c4c0450');
    trigger.setAttribute('aria-label', translate('ui.57b05322d6') + ': ' + selectedColor);
    popup.setAttribute('aria-label', translate('ui.bb80a52a07'));
  }

  function positionPopup() {
    const rect = trigger.getBoundingClientRect();
    // popupが<dialog>の子として追加されている場合、position:fixedの基準は
    // ビューポートではなく<dialog>自身のボックスになる(top-layer要素の仕様)。
    // そのためtrigger/windowの座標(ビューポート基準)からdialogのオフセット分を差し引く。
    const hostRect = popupHost.tagName === "DIALOG" ? popupHost.getBoundingClientRect() : { left: 0, top: 0 };
    const popupW = 115; // 5列固定
    const rows = Math.ceil(_SWATCHES.length / 5);
    const popupH = 10 + rows * 21 - 3 + 20; // padding + (swatch18px+gap3px)×行 + 余裕
    let left = Math.max(8, Math.min(rect.left, window.innerWidth - popupW - 8)) - hostRect.left;
    let top = rect.bottom + 4 - hostRect.top;
    if (rect.bottom + 4 + popupH > window.innerHeight - 8) {
      top = Math.max(8, rect.top - popupH - 4) - hostRect.top;
    }
    popup.style.top = `${top}px`;
    popup.style.left = `${left}px`;
  }

  function buildSwatches() {
    popup.innerHTML = "";
    _SWATCHES.forEach((color) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hslSwatch" + (color === selectedColor ? " selected" : "");
      btn.style.setProperty("--swatch-color", color);
      btn.setAttribute("aria-selected", color === selectedColor ? "true" : "false");
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-label', translate('ui.57b05322d6') + ': ' + color);
      btn.title = color;
      btn.tabIndex = color === selectedColor ? 0 : -1;
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        selectedColor = color;
        updateTrigger();
        buildSwatches();
        closePopup();
        const tagId = container.closest('[data-tag-row]')?.dataset.tagRow;
        trigger.focus({ preventScroll: true });
        try { await onCommit?.(selectedColor); }
        finally {
          if (document.activeElement === document.body || document.activeElement === trigger) {
            const target = trigger.isConnected ? trigger : dialogEl?.querySelector(`[data-tag-row="${tagId}"] .hslTrigger`);
            target?.focus({ preventScroll: true });
          }
        }
      });
      popup.appendChild(btn);
    });
  }

  function openPopup() {
    buildSwatches();
    popup.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    positionPopup();
    popup.querySelector('.hslSwatch.selected')?.focus({ preventScroll: true });

    outsideHandler = (e) => {
      if (e.target === trigger || popup.contains(e.target)) return;
      closePopup();
    };
    scrollHandler = () => {
      if (!popup.hidden) positionPopup();
    };
    resizeHandler = () => {
      if (!popup.hidden) positionPopup();
    };
    keyHandler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closePopup();
        trigger.focus();
      } else if (popup.contains(e.target)) {
        const buttons = [...popup.querySelectorAll('.hslSwatch')];
        const index = buttons.indexOf(e.target);
        const columns = buttons.filter(button => Math.abs(button.offsetTop - buttons[0].offsetTop) < 1).length;
        const next = { ArrowLeft: index - 1, ArrowRight: index + 1, ArrowUp: index - columns, ArrowDown: index + columns, Home: 0, End: buttons.length - 1 }[e.key];
        if (index < 0 || next === undefined) return;
        e.preventDefault();
        const target = buttons[Math.max(0, Math.min(buttons.length - 1, next))];
        buttons.forEach(button => { button.tabIndex = button === target ? 0 : -1; });
        target?.focus();
      }
    };

    setTimeout(() => {
      document.addEventListener("click", outsideHandler);
      document.addEventListener("scroll", scrollHandler, true);
      window.addEventListener("resize", resizeHandler);
      document.addEventListener("keydown", keyHandler);
    }, 0);
  }

  function closePopup() {
    if (popup.hidden) return;
    popup.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (outsideHandler) {
      document.removeEventListener("click", outsideHandler);
      outsideHandler = null;
    }
    if (scrollHandler) {
      document.removeEventListener("scroll", scrollHandler, true);
      scrollHandler = null;
    }
    if (resizeHandler) {
      window.removeEventListener("resize", resizeHandler);
      resizeHandler = null;
    }
    if (keyHandler) {
      document.removeEventListener("keydown", keyHandler);
      keyHandler = null;
    }
  }

  function destroy() {
    closePopup();
    popup.remove();
    if (dialogEl) {
      dialogEl.removeEventListener("close", onDialogClose);
      dialogEl.removeEventListener("cancel", closePopup);
    }
    container.innerHTML = "";
    container.__hslDestroy = null;
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    popup.hidden ? openPopup() : closePopup();
  });

  updateTrigger();

  // ダイアログが閉じたときはポップアップも閉じる
  const dialogEl = container.closest("dialog");
  const onDialogClose = () => { if (!dialogEl?.open) closePopup(); };
  if (dialogEl) {
    dialogEl.addEventListener("close", onDialogClose);
    dialogEl.addEventListener("cancel", closePopup);
  }

  // 呼び出し元が再描画前に明示的に掃除できるようにする
  container.__hslDestroy = destroy;

  return {
    getColor: () => selectedColor,
    setColor: (hex) => {
      selectedColor = _nearestSwatch(hex);
      updateTrigger();
      if (!popup.hidden) buildSwatches();
    },
    destroy,
  };
}
