# Release maintenance

Windows x64 releases use a per-user Tauri NSIS installer and Tauri updater signatures. Windows Authenticode signing is intentionally absent. Keep the application identifier, updater public key, and per-user data directory stable across releases.

## Prepare a release

1. Set the same stable version in `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`; update the package entry in `Cargo.lock`.
2. Add user-facing notes in `docs/releases/vX.Y.Z.md` and update `CHANGELOG.md`. If controls or wording changed, update the README and capture the current app with isolated sample data. Keep historical release screenshots unchanged.
3. Run `node scripts/release-manifest.mjs --check`, Rust and JavaScript tests, renderer syntax checks, and Clippy. Test the packaged application with the native UI suites and check data compatibility with the previous public version.
4. Commit the tested sources, push `main`, and push a matching `vX.Y.Z` tag. Do not move an existing tag to different sources. Check the CI result for the exact release commit.

The workflow in `.github/workflows/release.yml` tests the tagged sources, builds and signs the NSIS installer, generates `latest.json`, and creates a **draft** release. A successful workflow does not itself publish an update.

## Build with GitHub Actions or locally

GitHub Actions is the normal build path. It uses these secrets:

- `TAURI_SIGNING_PRIVATE_KEY`: the original updater private key.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password, if set.

The original recovery key is stored outside the repository in the maintainer's `.tauri/taskcalendar-plus/` directory. Never print it, commit it, or include it in verification archives. Existing installations trust the committed public key, so do not replace the signing key for an ordinary release.

A locally built installer is also acceptable when it is built from the same tested tag and verified before publication. If a release workflow for that tag is running, cancel it and wait until cancellation completes before manually uploading assets, so two writers cannot replace each other's files.

On the release machine, load the original signing key into the environment above without displaying it, then run from the repository root:

```powershell
npx --yes @tauri-apps/cli@2.11.5 build --ci --bundles nsis -- --locked
node scripts/release-manifest.mjs
```

Use `src-tauri/target` as the target directory; the manifest script expects the NSIS bundle under `src-tauri/target/release/bundle/nsis`. Remove signing secrets from the build process environment afterward. If the CLI version changes, confirm it against the release workflow and test that version before using it.

Both build paths must produce exactly these distribution assets:

- `TaskCalendar+_<version>_x64-setup.exe`
- The corresponding `.exe.sig`
- `latest.json`, pointing to that version's installer URL

## Verify the candidate

Verify the installer signature with the committed public key, and confirm that modified installer bytes are rejected. Compare the bundled renderer files with the tagged sources. Record the artifact SHA-256, version, source commit, commands, and results in a release verification report.

Keep different kinds of verification explicit:

- **Packaged app check:** extract the real installer and run its application with an isolated data directory and WebView2 profile.
- **Data compatibility check:** open synthetic data saved by the previous public app in the new app; compare task IDs and fields, tags, settings, notes, and summaries.
- **Installer upgrade check:** install the old and new NSIS packages in an isolated Windows test environment and verify the installed app and preserved data. Extraction alone does not verify installer behavior.
- **Native updater check:** check the public feed from the previous app. Detecting a version is distinct from downloading, installing, and restarting. When testing the full update, also verify the restorable before-update backup.

Never use the maintainer's normal task database for these tests. An installer test must also isolate installation registration and shortcuts; changing only the data directory is insufficient. Report skipped or unavailable checks explicitly, including whether automatic installation was left to the user.

## Publish and verify the public update

1. Create or inspect the draft for the existing tag. Upload only the tested installer, its signature, and `latest.json`.
2. Verify that uploaded asset hashes match the tested files and that release notes match `docs/releases/vX.Y.Z.md`.
3. Publish the draft as the latest stable release after release authorization. Neither committing source nor pushing a tag is publication.
4. Without authentication, download the latest feed and installer. Check the version, release notes, URL, checksum, and signature. Confirm that the previous native app detects the update and that the new version reports no newer version.
5. Record public verification results and any cancelled duplicate workflow in `docs/releases/vX.Y.Z-verification.md`.

The release page and in-app notes come from the same notes file. If notes change before publication, regenerate `latest.json` and update the draft body together. Editing only the GitHub body does not change in-app notes. Do not overwrite assets of an already published version.

Only published releases in the public repository are accessible to the unauthenticated updater. The production endpoint is:

```text
https://github.com/t-ueda21/TaskCalendar-Plus/releases/latest/download/latest.json
```

## In-app behavior

The toolbar always shows **Side / Fetch / Update / Settings** with icons and labels. Update is highlighted when a newer version is available. Startup checking defaults to ON and can be disabled in settings; a found update opens its notes after any editor closes.

Installation is an explicit user action. The app verifies the downloaded signature, writes a restorable JSON backup under the existing data directory's `backups` folder, then launches the installer. Failed signature verification or backup creation aborts installation. Database migration and compatibility remain the application's responsibility.

Current user instructions are in the [README](../README.md). The [v0.1.6 verification record](releases/v0.1.6-verification.md) shows the actual local-build path, checks performed, and remaining limits for that release.
