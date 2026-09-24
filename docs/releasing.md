# Release maintenance

Windows x64 releases use Tauri NSIS and Tauri updater signatures. They do not use
Windows Authenticode. The application identifier and per-user data directory must
remain stable across releases.

1. Set the same stable version in `src-tauri/Cargo.toml` and `tauri.conf.json`,
   update Cargo.lock, add `docs/releases/vX.Y.Z.md`, and commit the tested change.
2. Push a matching `vX.Y.Z` tag. `.github/workflows/release.yml` runs checks,
   builds the installer, signs it, generates `latest.json`, and creates a draft.
3. Test installation and update from the previous installed release. Check that
   tasks, settings, notes, and the before-update backup survive.
4. Publish the tested draft. Release text and the in-app notes both come from
   `docs/releases/vX.Y.Z.md`. If notes change before publication, regenerate and
   replace `latest.json` and update the draft body from that same file; editing
   only the GitHub draft body will not change in-app notes. Only published releases in the
   public repository are available to the unauthenticated updater.

The private key belongs in Actions secret `TAURI_SIGNING_PRIVATE_KEY`. Its original
local recovery copy is under the maintainer's `.tauri/taskcalendar-plus/` directory,
outside the repository. Keep an additional secure offline copy. The initial key has
an empty password; `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is optional. Never regenerate
or replace the key casually: existing installations trust the committed public key.

`node scripts/release-manifest.mjs --check` checks version consistency.
`node scripts/release-manifest.mjs` generates the feed from the signed NSIS artifacts.
The workflow refuses to replace an already-published release.

Updates are explicitly installed by the user. A restorable JSON backup is written
under the existing data directory's `backups` folder after signature verification
and before installer launch. Failed backup or signature verification aborts installation.
Database schema migration and compatibility remain the application's responsibility.
