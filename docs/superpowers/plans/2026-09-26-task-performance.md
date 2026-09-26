# Task performance implementation plan

**Goal:** Implement the user's approved items 1–3: visible-only rendering, indexed task queries/cached summaries, and conditional refresh. Preserve all records and existing UI behavior; do not publish.

**Architecture:** SQLite task mutation triggers maintain a revision used by GET /api/tasks ETags. The renderer retains its full dataset but avoids unchanged responses, shares refresh promises, indexes dates/months and caches summaries. Inactive views catch up on activation; day/week rendering is restricted to the visible mode.

**Scope:** No range loading (item 4), no data removal, no changes to updater release configuration. Existing uncommitted UI and Outlook cancellation fixes are preserved in this checkout.

**Verification:** Isolated native profiles at 1k/10k/50k tasks; Node store tests; SQLite/API revision tests; native visibility/refresh tests; existing Rust/Node/UI suites. Compare semantic results as well as timings. Real user data and Outlook accounts are not used for benchmarks.

- [x] Capture baseline task lookup, summary, unchanged-refresh timings and hidden-view DOM mutations.
- [x] Add SQLite revision triggers and conditional task-list responses. Test create/update/delete/rollback/restore and unchanged 304 payload.
- [x] Add task date/month indexes and defensive summary caches; invalidate on task/tag/settings changes. Test mutation freshness, cache isolation, refresh concurrency and failure retry.
- [x] Defer hidden-view work and activate after showing the target. Refresh current settings and date on activation; preserve calendar mode, focus and edits.
- [x] Repeat benchmarks and native parity checks; review the complete diff and resolve findings. Build locally; stop before release.

**Risks:** Concurrent refresh versus writes; stale caches after tag/break changes; restore/outlook deletions bypassing revision; hidden view settings not catching up; early-return rendering hiding fresh data on tab/mode switches.


## Results

Native WebView2, isolated temporary SQLite profiles, 10 weekday tasks/day. Five samples per size; warm-cache median. Same renderer workload and fixture before/after. No real user records or Outlook account were used.

| Tasks | Date lookup 100x before / after | Monthly summary 100x before / after | Unchanged refresh before / after | Response body before / after |
|---|---|---|---|---|
| 1,000 | 0.6 ms / below timer resolution | 7.6 ms / below timer resolution | 21.7 ms / 1.4 ms | 348,781 / 0 bytes |
| 10,000 | 5.6 ms / below timer resolution | 15.0 ms / below timer resolution | 186.5 ms / 1.0 ms | 3,507,781 / 0 bytes |
| 50,000 | 42.6 ms / below timer resolution | 50.6 ms / below timer resolution | 909.1 ms / 1.3 ms | 17,627,781 / 0 bytes |

Each fixture retained 10 tasks on the target date and 960 monthly work minutes. Five unchanged refreshes produced 90 hidden-view DOM mutations before, zero after. These are unchanged-refresh/warm-query results, not cold-start or all-operation speedups. Full initial loading remains unchanged in scope (item 4 was not authorized).

Reviewer findings resolved: out-of-order write/refresh responses (generation-aware authoritative reload and local ETag invalidation); temporary toolbar choices reset on activation (preserve local state); hidden task focus accepted by keyboard shortcuts (visible-root/mode guards and cleared selections). Independent re-review reported no new material issues.

Validation: 92 Rust tests passed, 1 live Outlook test intentionally ignored; Clippy all-targets -D warnings passed. Node regression covers lookup/cached summary invalidation, conditional refresh, shared waits, create/update/delete response races, retry and tag deletion. Native performance regressions cover hidden tabs/modes, synchronization, settings catch-up, temporary display choices and hidden-task keyboard actions. Existing native smoke verifies 3-tab layout and application flows.

Delivery remains local. Do not publish the existing v0.1.4 tag or release without new user authorization. Existing unrelated UI edits and Outlook cancellation changes were preserved.
