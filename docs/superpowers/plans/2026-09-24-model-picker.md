# AI model picker implementation plan

**Goal:** Replace empty Claude Code / Codex model inputs with selectable models retrieved from the installed CLI.

**Design:** Keep the existing provider and opt-in settings. Show an explicit default option, retrieve models when the selected provider panel opens, allow refresh and manual names, and preserve saved values even if discovery fails. Discovery sends initialization/model-list requests only, never a prompt or calendar data. Failures must be visible and must not prevent saving other settings.

**Architecture:** A Rust module owns bounded CLI protocol exchanges (Codex app-server model/list, Claude streaming initialization). An authenticated provider-specific API returns normalized model choices. A shared browser module owns selection/loading/error states.

**Constraints:** Preserve current settings keys, existing task data, and earlier CSS/text changes. No new runtime dependencies. Work directly in the current checkout so the running development app can use the UI changes. Do not interrupt unsaved user edits.

- [x] API: test unknown provider and missing CLI, then add the endpoint and bounded CLI discovery. Test normalization, protocol errors, pagination, and timeout/cleanup.
- [x] UI: add default/model/manual choices, refresh and automatic discovery on provider selection. Preserve existing and in-flight selections. Verify failed discovery remains usable.
- [x] Validation: Rust tests, Clippy, JavaScript checks and existing tests, isolated WebView smoke tests with mocked discovery, then real Codex discovery. Build without overwriting the running executable; apply after preserving active input.

**Related requests:** Header and toolbar each shrink by 6px; return 12px to all content layouts. Change the insight hint to the exact requested Japanese sentence.

**References:** https://learn.chatgpt.com/docs/app-server ; https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py

## Verification

- Rust: 64 passed, 1 ignored (real Outlook); Clippy passed with -D warnings.
- JavaScript: 18 module syntax checks and 22 existing checks passed.
- WebView: 30 checks passed, including actual Codex model discovery (4 choices). Isolated profile screenshot confirmed model select and refresh layout.
- Heights: at 1280/1100/800px, header and toolbar each decreased by 6px in all three views; content gained 12px.
- Reviewer configuration-alignment finding resolved by rejecting incompatible custom Codex catalog/provider settings before displaying candidates.
- Verified executable copied into the normal debug launch path and restarted after confirming no active editor/dialog. SHA-256 matches the verified build.
- Claude Code is absent on this PC: protocol fixture covered, actual Claude discovery not verified.
