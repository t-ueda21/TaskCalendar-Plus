# Summary formatting offline baseline

This is a synthetic, offline behavior-preservation contract designed by role A before product edits. The implementation may change `summary-renderer.js`'s formatting prefix and add `summary-format.js`. All other captured app/config/UI sources are guarded, as is the renderer from `metricDetails` onward. No visual change is authorized.

Run from the repository root using the existing Node runtime:

```powershell
node --experimental-vm-modules scripts/refactor-summary-offline/run.mjs check after
node --experimental-vm-modules scripts/refactor-summary-offline/run.mjs metrics after
```

Each label writes new evidence and refuses to overwrite existing output. For self-checks use another label, such as `implementation`. An optional third argument selects a source directory; for example the immutable `out/refactor-summary-offline-20261024/before-source` snapshot. The harness and contract remain the same in both runs.

Preparation performed by A, before the product implementation:

```powershell
node --experimental-vm-modules scripts/refactor-summary-offline/run.mjs prepare
node --experimental-vm-modules scripts/refactor-summary-offline/run.mjs check before
node --experimental-vm-modules scripts/refactor-summary-offline/run.mjs metrics before
node --experimental-vm-modules scripts/refactor-summary-offline/run.mjs freeze
```

`expected.json` holds exact original formatting outcomes (including existing invalid/non-finite outcomes), generated strings and fake DOM state across all 9 supported locales. Real locale catalogs and i18n are loaded. `ui-utils.js` is replaced with its exact two pure helper functions. App/native/browser/Outlook code, timers, network, real data and account functions are unavailable in the product VM. The existing model test runs in that VM; the existing preferences integration test does not, because its settings-model dependency enters a broader UI graph. Pure preference normalization has a separate case.

The fake DOM records HTML, text, attributes, selection, pagination, focus requests and style properties. It does not render pixels, implement layout, dispatch real DOM events, or validate browser/WebView accessibility behavior. Pixel/UI runtime checks are explicitly not run under the current safety constraints; no visual-equivalence claim follows from these checks.

Measurements use 2 warmups followed by 7 raw samples of 240 fixed iterations, with constructor counts measured separately from timing. The timed operation is pure formatting in a VM, not app/UI response time. Hardware/runtime/ICU/timezone and source/code metrics are saved. Re-run both source versions on the same host for new comparisons. A cached formatter may produce identical strings with fewer constructors; bounded cache size still requires implementation review.

Source/code metrics separate runtime source, UI source, test files, docs, config and assets. Rust runtime files may contain embedded tests; their complete physical/nonblank line counts are retained. New harness files and generated evidence never count as product code reduction. `source-manifest.json` lists all saved working-tree bytes and exclusions. Private attachment contents, dependency folders, generated output and user data are not archived. `baseline-lock.json` fixes all contract/evidence hashes. B/C must request changes from A instead of modifying them.
