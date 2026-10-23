# Summary Screen Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, with one independent review of the finished branch.

**Goal:** Implement the approved summary mock against the application's real Store, without releasing it.

**Architecture:** A pure summary model consumes the existing per-day task index, known tags, work settings and Japan calendar rules. A summary view renders the approved simultaneous chart/numeric layout and subscribes to Store changes. New styles are scoped to this view and use existing theme tokens. No database migration or AI/Outlook call is needed.

**Tech Stack:** Existing vanilla JavaScript, CSS, HTML, i18n catalogs and isolated Chromium test harness.

**Spec:** `docs/mockups/summary-v1.html`, Issue #31 and the user's 2026-10-23 instruction to implement this mock while retaining simultaneous chart/numbers, multiple tag selection and the no-scroll layout. The user approved this artifact for implementation; no further design approval is needed.

## Global Constraints

- Add Summary immediately after AI mode. Monthly/yearly modes only; no all-time mode, daily detail table or aggregation-help button.
- Keep chart, numeric day/month totals, tag selection and the right-hand derived summary visible together.
- Clicking a tag from All isolates it; subsequent clicks toggle other tags. Explicitly removing the last selected tag returns to All. Selection remains when navigating periods/views.
- A selected tag deleted elsewhere must not silently broaden the selection to unrelated tags. Show an empty selection until the user chooses another tag or All.
- Target no scrolling/clipping at 1280×800 and 1366×768, including 10 tags; use tag pagination above 10. Smaller/zoomed layouts may scroll rather than hide controls.
- Use work/break settings and Japanese public/company holidays. Existing UI languages remain supported (all nine catalogs).
- Totals use only known-tag timed events, split multi-day events at midnight, exclude configured unpaid breaks and merge overlapping intervals. Zero-duration/all-day/invalid/orphan-tag rows do not contribute work or counted work events. Count distinct contributing task IDs across the period.
- Per-tag hours are unioned within each tag and may include cross-tag overlap. Selected tags' overall total is a union. The chart stacks exclusive normal time by tag, a neutral cross-tag overlap segment, and overtime, so stacked height equals total. Existing sidebar/tag-budget calculations are not changed.
- Default end is today's JST date, inclusive; optionally include future registered events. No live task mutation and no automatic AI/Outlook requests.
- Right-hand insights are calculated facts as in the approved mock. Do not imply AI generation.
- UI metric choices/average basis are persisted through the existing Store settings JSON, with an allowlist and no database schema change. Tag filters and the selected period remain in view state. Save/cancel remains explicit.
- No version bump, release workflow dispatch, tag, main merge or published release. Work on `codex/summary-screen` from the approved mock commit `3baa3a2` (main `e82af9f` included).
- Never launch Tauri/WebView2/Edge or run live Outlook ignored tests for this task. Use synthetic API/native boundaries in isolated Chromium. Never collect private attachments or AppData.

## Review Focus

1. Overlap across selected tags, unpaid breaks, overtime boundaries and fractional minutes must keep chart stacks equal to totals.
2. Cross-month/year and multi-day task counts must deduplicate IDs; leap days, JST rollover and company holidays affect period/denominator behavior.
3. A selected tag removed or renamed while hidden must not leave stale data or widen scope unexpectedly; task/settings changes must update visible totals.
4. Long/malicious tag names, invalid colors, many tags and long translations must remain safe and usable without losing the 10-tag layout.
5. Data refresh errors preserve the last snapshot and expose a retry. Re-entering the view must not multiply listeners or requests.

## Task 1: Pure aggregation model

Files: `src-tauri/renderer/src/summary-model.js`, `work-time.js`; tests `scripts/test-summary-model.mjs`, existing work-time and event-range tests.

Interfaces: `buildSummary({period,year,month,today,includeFuture,selectedTagIds,tags,settings,getTasksByDate})` returns display dates/groups, total/overtime, known-tag breakdown, registered/business days, unique work-event count, longest day, previous-period comparison and chart allocations. `workIntervals(tasks,settings)` exposes the existing merged, unpaid-break-adjusted intervals without changing `summarizeWork` results.

- [x] Write failing literal-fixture tests: empty/no-tag, 08:00–19:00 with unpaid 12:00–13:00 = 600 total/120 overtime; selected A 09:00–11:00 plus B 10:00–12:00 = 180 total/60 overlap; same-tag duplicates = 120; overnight January/February slices and unique count; leap February; company/public holidays and custom workweek; current-period cutoff/future switch; comparison cutoff; input immutability.
- [x] Observe failure, implement the model, pass new and existing related suites.

## Task 2: Real-data screen and localization

Files: `src-tauri/renderer/src/summary.js`, `summary-renderer.js`, `summary-preferences.js`; `assets/summary.css`, summary markup in `assets/app.html`; add loader in `main.js`, adjust shared navigation to four entries; `locales/summary.js`, catalog registration and generated native catalog JSON.

Interfaces: `init(root)`/`activate()` follow current view lifecycle. Renderers accept a model plus state; event delegation handles date/tag controls without rebinding on render. Preferences validate metric IDs (1–4) and denominator; Store remains authoritative for tasks, tags and settings.

- [x] Write failing renderer tests through the existing isolated harness for missing Summary navigation and simultaneous graph/numbers.
- [x] Implement scoped markup/style and real-data subscriptions, local metric dialog, tag pages and empty/error states.
- [x] Add nine-language strings and regenerate catalog JSON. Verify Japanese/English/Korean, light/dark and 10-tag layout at target sizes, long tag labels, page keyboard actions and cancelling preferences.
- [x] Verify add/edit/delete and settings changes update summary without mutating data from the screen. Verify filtering and year/month drilldown preserve state.

## Task 3: Verification and review

- [x] Run every `scripts/test-*`, JS syntax, regular Rust tests (ignored live tests stay ignored) and Clippy via the existing compiler environment helper.
- [x] Capture actual renderer screens with synthetic fixtures at target viewports; record layout and interaction evidence separately.
- [x] Obtain one fresh read-only whole-branch review, fix material issues and repeat affected tests.
- [x] Update README/Unreleased notes with implemented scope, evidence and limitations.

Delivery: record the resulting draft PR and checks in Issue #31 after committing. Preserve the feature branch for review; do not merge or release.
