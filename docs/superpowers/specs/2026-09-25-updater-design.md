# Windows distribution and in-app updates

## Agreed outcome
Use Tauri's updater signature, without Windows Authenticode signing. Distribute
TaskCalendar+ through this repository's public GitHub Releases.
The user explicitly asked to start implementation on 2026-09-25.

## Behavior
- Windows x64, per-user NSIS installer, existing application identifier/data directory.
- Check once at startup by default; persist the opt-out in settings.
- Keep the update entry visible in every view's toolbar, ordered as
  Side / Fetch / Update / Settings. Use an icon and text for each action and
  highlight Update when a newer version is available. Keep the date, clock,
  and remaining work time in the top header. Settings show the current
  version, status, manual check, and startup-check preference.
- Show release notes and download progress; installation is an explicit action.
- Open release notes when a startup check finds an update; defer the notice until
  open editors close. The user can dismiss it and reopen it from the toolbar.
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
to existing installations. Verified local artifacts can also be published using the
documented fallback in [release maintenance](../../releasing.md). The same signing key,
source tag, and verification requirements apply to either build location.

## Verification
Exercise controller error/retry/concurrency paths, native backup fidelity/failure,
actual WebView UI integration, signed installer generation, and clean installed startup.
An actual old-to-new installed update must be distinguished from simulated UI tests.
