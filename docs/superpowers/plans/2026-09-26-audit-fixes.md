# v0.1.4 audit fixes

The user approved fixing all 16 findings from the 2026-09-26 v0.1.3 audit.
Work on `fix/audit-20260926`; preserve real data and do not run real Outlook or
change the user's startup registration during tests. Reproduce before fixing.

## Ownership and acceptance

- [x] Backend: findings 01/02/04/05/06. Reject incomplete Outlook snapshots before
  database writes; reconcile a verified empty snapshot; preserve tags/IDs for a
  moved single Outlook appointment. Validate all backup collections before
  deletion and restore valid backups larger than 2 MiB. Use atomic transactions.
- [x] Calendar/data frontend: 07/08/09/10/11/15. Rebuild edited recurrence schedules
  atomically; restore exact task IDs and recurrence on Undo; retain existing tags
  outside a month's tag list; merge overlapping unpaid breaks; show a selected
  Sunday in its week; recalculate the clock from current settings.
- [x] Native/settings: 12/13/14. Never hide a window without a usable tray icon;
  preserve the OS autostart choice; persist theme and zoom independently of the
  random localhost port. Retain existing app identifier and database location.
- [x] AI: 03/16. Reject stale proposals (including deletes) at confirmation and
  use a native atomic revision guard; reserve send state before awaiting refresh.
- [x] Integration/review: validate all new regressions, existing Rust/JS/native
  UI checks, release package signature and old-version update discovery.
- [ ] Release v0.1.4 with user-facing notes; leave installation to the user.

## Shared interfaces

Backend adds `POST /api/tasks/batch` with JSON:
`{ expected: [{id, updatedAt}], upserts: [task], deleteIds: [id] }`.
Existing rows mutated/deleted must have matching expected revisions; create IDs
must not already exist. Validate whole input, commit atomically, return the full
task list. HTTP409 for conflicts, HTTP400 for invalid input.

Ordinary PUT task accepts optional `expectedUpdatedAt`; DELETE task accepts the
same as a query parameter. Comparison and mutation occur under the existing DB
lock. Frontend Store exposes optional `{expectedUpdatedAt}` on updateTask and
deleteTask without weakening legacy callers. Failed operations do not alter cache.

Calendar owner also adds `getWorkEnd` callback support to startHeaderClock.
Settings owner passes `getWorkEnd: () => Store.getSettings().workEnd` from main.js.

## Verification

Each owner converts the isolated audit probes into maintained regression tests.
Native preference persistence uses a dedicated data/profile directory. Tests must
cover errors and retries as well as successful edits. No real AI API calls are
needed; use deterministic adapters. Review data-changing interfaces together.
