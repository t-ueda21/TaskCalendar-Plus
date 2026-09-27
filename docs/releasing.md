# Release maintenance

Windows x64 uses a per-user Tauri NSIS installer with updater signatures. Windows Authenticode signing is intentionally absent. Keep the application identifier, public key, and data location stable.

## Prepare and build

1. Match versions in `src-tauri/Cargo.toml`, its `Cargo.lock` package entry, and `src-tauri/tauri.conf.json`.
2. Update `CHANGELOG.md`, `docs/releases/vX.Y.Z.md`, and the README/screenshots when relevant. Keep only the current release notes in main; old notes and screenshots remain available in Git tags and GitHub Releases. Keep temporary plans, test reports, and comparison images in ignored `out/`.
3. Run `node scripts/release-manifest.mjs --check`, Rust and JavaScript tests, renderer syntax checks, and Clippy. Test the actual packaged app with isolated data and verify compatibility with the previous version.
4. Commit the tested sources and push main with a matching version tag. Never move a published tag. Require CI success for that exact commit.

`.github/workflows/release.yml` builds, signs, and creates a **draft**, not a published update. It requires `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Preserve the original recovery key outside the repository; never print, commit, archive, or replace it for an ordinary release.

A verified local build is also supported:

```powershell
npx --yes @tauri-apps/cli@2.11.5 build --ci --bundles nsis -- --locked
node scripts/release-manifest.mjs
```

Use `src-tauri/target` as the target directory and scope signing secrets to the build process. If uploading locally built assets, cancel the duplicate release workflow and wait for cancellation before uploading.

## Publish and verify

1. Verify the installer against the committed public key, including rejection of modified bytes. Compare bundled renderer files with the release sources. Record hashes, commands, and results under `out/`.
2. Upload exactly the tested installer, its `.exe.sig`, and `latest.json` to the draft. Confirm remote hashes match and notes match `docs/releases/vX.Y.Z.md`.
3. Publish as the latest stable release when authorized. Never overwrite published assets.
4. Download the feed and installer without authentication; verify version, notes, URL, checksum, and signature. Check that the previous native app detects the update and the new app reports no newer version.

Production feed: `https://github.com/t-ueda21/TaskCalendar-Plus/releases/latest/download/latest.json`

Packaged-app tests and update detection do **not** prove installation/restart behavior. Test a complete installer upgrade only in an isolated Windows environment, including installation registration and shortcuts. State any skipped checks. Never use normal user data for release tests.

The app checks signatures and creates a restorable backup before installing; failure of either step aborts installation. When changing notes before publication, regenerate `latest.json` and update the draft body together. See the [README](../README.md) for user instructions.
