# Readable Summary UI Implementation Plan

> **For agentic workers:** Implement the coordinated changes with focused delegated test work and one fresh final review. Preserve the current checkout on `codex/summary-readable-ui`; never stage private untracked attachments.

**Goal:** Rebuild the Summary screen at a readable scale and restore the upper page tabs and shared application action bar.

**Architecture:** Keep the existing Store aggregation and state behavior. Reuse the shared toolbar template without the sidebar action on Summary. Use existing shared shell styles for all views; larger typography belongs only to Summary content. Preserve the original arrangement: chart and numeric dates in one panel on the left, tags above insights on the right.

**Tech Stack:** Existing vanilla HTML/CSS/JavaScript, nine locale catalogs and isolated Chromium harness.

**Spec / user authority:** The user requested larger text/UI, restored bars and an overall rebuild, then clarified on 2026-10-24: upper page tabs plus acquisition/update/settings bar; Summary screen only. Their earlier simultaneous chart/numbers and multi-tag requirements remain. Prior release authorization was completed with v4.0.0; this new UI work is not a release request.

## Design choices

- Use 16px for primary Summary content text/actions, at least 14px for supporting text, axis labels, weekdays and time units; use 30px metric values and 18px section headings. Shared navigation and toolbar retain existing shared sizing. These are implementation choices, not user-specified exact dimensions.
- Following the user's explicit correction, restore numeric dates below the chart inside the original left panel. Use 12 columns for all 28–31 dates and six columns for all 12 months to retain enlarged text. Keep hours and minutes explicit on separate lines. Dates remain selectable and annual cells still open the selected month.
- Restore tags above the derived insights on the right. Keep all four components visible at the standard desktop targets with 10 tags. Tag names and durations use separate lines. The rejected chart/tag-left and numbers/insights-right arrangement is superseded, not an accepted design.
- Restore shared Outlook acquisition, update and settings actions, with one working settings trigger. Omit the sidebar toggle because the user selected upper bars rather than a left sidebar.
- Retain the existing four navigation tabs at the same size in every view. No Summary-only header, navigation or toolbar overrides. Do not enlarge shared controls through inherited custom properties.
- Aim for no page scrolling at 1280×800 and 1366×768, standard CSS scale. For smaller/zoomed windows allow scrolling rather than hide controls or reduce text below the stated floor.

## Constraints

**2026-10-24 correction:** User: 「これはひどい、元の配置に戻して、大きさはこんな漢字でいい」. Restore spatial grouping while keeping the enlarged text, controls, upper tabs and shared action bar. This is a layout correction, with no aggregation or release change.

**Subsequent correction:** User: 「上のタブ切り替えボタンの大きさがほかのタブと変わったらダメ」「ツールバーについてもそう」. The former Summary-only shell enlargement is superseded. Preserve the shared shell while enlarging only the screen content. Test dimensions during Summary activation, not merely after leaving it.

**Full audit and six metrics:** User: 「他にも既存のUIと統一できてないところがないか、全体を見直して修正して。まだリリースしないで。表示項目は６つおけるでしょ。おいて」. Audit four views, common dialogs and all settings pages. Show all six existing metrics by default and allow1–6 selections. Upgrade only the unversioned canonical old four-metric default; preserve custom subsets/order and explicit subsequent four-metric choices with display-preference version2. Standard desktop widths keep six cards on one row; long translated labels align numeric baselines and numeric values retain full units. Reuse the shared toggle, selected-state colors and task-dialog chrome; correct narrow four-tab wrapping and settings input/switch inconsistencies found by audit.

**Latest correction supersedes selection UI:** User removes the 「表示項目」 button, requests text plus icon for previous/next month/year like existing controls, and says tag heading/Show all are crowded against the top. Remove the button, its dialog and unused handlers/styles/translations. Always render all six metrics while preserving saved preferences and existing averageBase. Reuse calendar titleNavBtn and calendar navigation labels with ◀/▶. Set tag and chart heading top padding to12px, maintaining aligned headings and desktop bottom clearance. No release.

- No aggregation changes, new AI calls, live Outlook calls, DB schema migration, application version bump, release, or main merge. Native launch was separately authorized and performed before the six-metric correction; the current audit uses isolated Chromium.
- No change to task data. Use synthetic data/API/native bridge for UI tests and screenshots.
- Keep month/year modes, future inclusion, tag paging, errors/retry, saved average denominator, keyboard focus, empty states and nine locales. Metric selection UI is intentionally removed by the latest correction.
- Do not reintroduce all-time mode, a daily detail table, or the removed aggregation-help button.
- Use existing theme tokens and shared icons. Keep long labels safe, with readable tooltips/accessible names for intentional truncation.

## Review focus

1. Restored toolbar actions must actually work, with no duplicate settings handlers or no-op sidebar button.
2. 31 dates, 10 tags, six metrics and long durations must fit with visible time units at the typography floor.
3. Long translations and multiple selected tag names must not collide with period controls or application actions.
4. Shared header/navigation/toolbar dimensions must remain identical while Summary is active and after leaving it. Preserve other views' appearance/behavior.
5. Larger controls must preserve graph/day synchronization, keyboard focus, tag paging, errors and settings persistence.

## Tasks

- [x] Record failing font/toolbar acceptance tests before changing the production UI. Existing v4 baseline screenshots are in `out/ui-rebuild-20261023/before`; take a same-fixture summary gallery for comparison.
- [x] Rebuild `assets/app.html` Summary markup and `assets/summary.css`. Add optional `data-without-sidebar` support for the shared toolbar slot in `src/view-shell.js`; defaults unchanged.
- [x] Update `src/summary-renderer.js` numeric-cell structure and concise insights. Keep aggregation in `summary-model.js` untouched. Update nine-language strings and generated JSON as necessary.
- [x] Add/adjust `scripts/test-summary-readable.mjs`, `test-summary-ui.mjs` and `test-summary-alignment.mjs` for the intentional new layout while retaining functional checks and recording superseded layout expectations.
- [x] Verify standard viewports, all locales, light/dark, 10+ tags, long values, keyboard actions and return to existing views. Inspect actual rendered screenshots, not only rectangle containment.
- [x] Run the complete safe suite, obtain one fresh review, address material findings, save before/after report. Delivery after commit: create a draft PR; do not merge or publish.
