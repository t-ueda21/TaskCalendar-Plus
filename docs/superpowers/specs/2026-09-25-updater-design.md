# Windows distribution and in-app updates

## Agreed outcome
Use Tauri's updater signature, without Windows Authenticode signing. Distribute
TaskCalendar+ through this repository's GitHub Releases when it becomes public.
The user explicitly asked to start implementation on 2026-09-25.

## Behavior
- Windows x64, per-user NSIS installer, existing application identifier/data directory.
- Check once at startup by default; persist the opt-out in settings.
- Show an update button to the right of the header tabs only when an update exists.
  Keep the date, clock, and remaining work time on the same header row at normal
  desktop widths. Settings show the current
  version, status, manual check, and startup-check preference.
- Show release notes and download progress; installation is an explicit action.
- Open release notes when a startup check finds an update; defer the notice until
  open editors close. The user can dismiss it and reopen it from the header.
- Save and close settings before opening release notes from settings. A failed or
  cancelled save keeps the settings editor open. Refuse to install while any other
  editor remains open. Back up the full
  database as restorable JSON before installation; abort if backup fails.
- Failed checks/downloads must preserve current data and allow retry. Serialize native
  updater operations and retain the exact checked update for installation.
- Verify update signatures with Tauri; fixed HTTPS GitHub feed in production.

## Distribution
Generate a dedicated private key outside the repository; public key is committed.
Private key is stored as an Actions secret and retained locally for recovery.
Version tags trigger tests, a signed NSIS build, and a draft GitHub release containing
the installer, signature, and latest.json. Publishing a tested draft makes it available
to existing installations. No repository visibility change is part of implementation.

## Verification
Exercise controller error/retry/concurrency paths, native backup fidelity/failure,
actual WebView UI integration, signed installer generation, and clean installed startup.
An actual old-to-new installed update must be distinguished from simulated UI tests.
