/**
 * time-grid.js — カレンダーのタイムグリッド(時刻の目盛り・枠・予定ブロックの位置・現在時刻線)
 */

import { formatDateKey, pad2, timeToMinutes } from "./ui-utils.js";

// ── タイムグリッド ────────────────────────────────────
export const ROW_HEIGHT = 34; // px per granularity unit

function minutesToY(minutes, granularity) {
  return minutes / (granularity / ROW_HEIGHT);
}

/**
 * タイムグリッドを描画する。
 * @param {{ timesEl, slotEls: HTMLElement[], granularity: number, workStart: string, workEnd: string }}
 */
export function renderTimeGrid({ timesEl, slotEls, granularity, workStart = "09:00", workEnd = "18:00", breaks = [] }) {
  const wsMin  = timeToMinutes(workStart);
  const weMin  = timeToMinutes(workEnd);
  // 複数の休憩時間帯に対応する(重複しない前提で、該当する範囲を都度探す)
  const breakRanges = (Array.isArray(breaks) ? breaks : [])
    .map((b) => ({ start: timeToMinutes(b?.start ?? ""), end: timeToMinutes(b?.end ?? "") }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);
  const count  = Math.floor(1440 / granularity);

  timesEl.innerHTML = "";
  slotEls.forEach((s) => (s.innerHTML = ""));

  for (let i = 0; i < count; i++) {
    const mins = i * granularity;
    const slotEndMins = mins + granularity;
    const h = Math.floor(mins / 60);
    const m = mins % 60;

    const timeEl = document.createElement("div");
    timeEl.className = "timeRow";
    // 表示間隔: 通常は1時間おき、粒度15分の時だけ30分おきにラベルを出す
    const labelInterval = granularity === 15 ? 30 : 60;
    timeEl.textContent = mins % labelInterval === 0 ? `${pad2(h)}:${pad2(m)}` : "";
    timesEl.appendChild(timeEl);

    let isBreak = false;
    let hasBreakStartBoundary = false;
    let hasBreakEndBoundary = false;
    let hasBreakMiddleSegment = false;
    let breakStartRatio = 0;
    let breakEndRatio = 0;
    for (const { start: brMin, end: breMin } of breakRanges) {
      const _isBreak = mins >= brMin && slotEndMins <= breMin;
      const _hasStart = mins < brMin && slotEndMins > brMin;
      const _hasEnd = mins < breMin && slotEndMins > breMin && mins >= brMin;
      const _hasMiddle = mins < brMin && slotEndMins > breMin;
      if (!(_isBreak || _hasStart || _hasEnd || _hasMiddle)) continue;
      isBreak = isBreak || _isBreak;
      hasBreakStartBoundary = hasBreakStartBoundary || _hasStart;
      hasBreakEndBoundary = hasBreakEndBoundary || _hasEnd;
      hasBreakMiddleSegment = hasBreakMiddleSegment || _hasMiddle;
      if (_hasStart) breakStartRatio = Math.max(0, Math.min(100, ((brMin - mins) / granularity) * 100));
      if (_hasEnd || _hasMiddle) breakEndRatio = Math.max(0, Math.min(100, ((breMin - mins) / granularity) * 100));
    }
    const isBeforeWork = slotEndMins <= wsMin;
    const isAfterWork = mins >= weMin;
    const hasWorkStartBoundary = mins < wsMin && slotEndMins > wsMin;
    const hasWorkEndBoundary = mins < weMin && slotEndMins > weMin;

    const startBoundaryRatio = hasWorkStartBoundary
      ? Math.max(0, Math.min(100, ((wsMin - mins) / granularity) * 100))
      : 0;
    const endBoundaryRatio = hasWorkEndBoundary
      ? Math.max(0, Math.min(100, ((weMin - mins) / granularity) * 100))
      : 0;

    slotEls.forEach((slots) => {
      const slotEl = document.createElement("div");
      slotEl.className = "slot"
        + (m === 0 ? " hour" : "")
        + (isBeforeWork || isAfterWork ? " workoff" : "")
        + (hasWorkStartBoundary ? " workoff-partial-before" : "")
        + (hasWorkEndBoundary ? " workoff-partial-after" : "")
        + (isBreak ? " break" : "")
        + (hasBreakMiddleSegment ? " break-partial-middle" : "")
        + (!hasBreakMiddleSegment && hasBreakStartBoundary ? " break-partial-start" : "")
        + (!hasBreakMiddleSegment && hasBreakEndBoundary ? " break-partial-end" : "");
      if (hasWorkStartBoundary) {
        slotEl.style.setProperty("--workoff-boundary", `${startBoundaryRatio}%`);
      }
      if (hasWorkEndBoundary) {
        slotEl.style.setProperty("--workoff-boundary", `${endBoundaryRatio}%`);
      }
      if (hasBreakStartBoundary) {
        slotEl.style.setProperty("--break-start-boundary", `${breakStartRatio}%`);
      }
      if (hasBreakEndBoundary || hasBreakMiddleSegment) {
        slotEl.style.setProperty("--break-end-boundary", `${breakEndRatio}%`);
      }
      slotEl.setAttribute("data-index", String(i));
      slots.appendChild(slotEl);
    });
  }
}

/**
 * taskBlock の position を計算して適用する。
 */
export function positionTaskBlock(el, startTime, endTime, granularity) {
  const startMins = timeToMinutes(startTime);
  const endMins   = Math.max(startMins + 1, timeToMinutes(endTime));
  const h = minutesToY(endMins - startMins, granularity);
  el.style.top    = `${minutesToY(startMins, granularity) + 2}px`;
  el.style.height = `${Math.max(12, h - 4)}px`;
}

// ── 現在時刻ライン ─────────────────────────────────────
export function updateNowLine(granularity, mode) {
  const now = new Date();
  const todayKey = formatDateKey(now);
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const y = minutesToY(nowMins, granularity);

  const dayCol = document.querySelector("[data-daycol]");
  if (dayCol) {
    let line = dayCol.querySelector(".nowLine");
    if (!line) { line = document.createElement("div"); line.className = "nowLine"; dayCol.appendChild(line); }
    line.style.top = `${y}px`;
    line.hidden = !(mode === "day" && dayCol.getAttribute("data-date") === todayKey);
  }

  document.querySelectorAll("[data-weekcol][data-weekday]").forEach((col) => {
    let line = col.querySelector(".nowLine");
    if (!line) { line = document.createElement("div"); line.className = "nowLine"; col.appendChild(line); }
    line.style.top = `${y}px`;
    line.hidden = !(mode === "week" && col.getAttribute("data-date") === todayKey);
  });
}
