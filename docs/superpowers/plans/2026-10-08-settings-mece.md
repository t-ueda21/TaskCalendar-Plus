# Settings MECE Implementation Plan

> **For agentic workers:** Follow refactor-with-baseline with separate A/B/C owners. The user already approved the 11-page design and implementation. Use superpowers:executing-plans within the assigned role.

**Goal:** 設定を11ページへ整理し、古い意味の識別子を直してから、動作を保つ内部整理を検証する。

**Architecture:** 仕様変更と純粋な整理を2段階に分ける。最初は既存のDOM再配置方式のまま11ページへ変更し、設定値・保存処理を保持する。全試験成功後に固定し、HTMLの直接配置へ移すことで不要な再配置と死んだスタイルを除く。

**Tech Stack:** JavaScript ES modules、HTML/CSS、Rust/Tauri、Playwright Chromium。

**Spec:** [承認済み構成](../specs/2026-10-08-settings-mece-design.md)

## Global Constraints

- 永続データ形式・全既存設定・9言語・保存/取消/失敗時の保持を維持する。
- A `/root/settings_a` は試験と基準、B `/root/settings_b` は実装、C `/root/settings_c` は独立最終検証。
- 固定後の試験・画像・データ・計測器・許容差はB/Cが変更しない。不足はAへ返す。
- 私的添付・AppData・稼働アプリは対象外。ネイティブ・実サービス起動を行わない。
- ソースはdevelopへ通常push。main更新・force push・タグ・Releaseは行わない。

## Review Focus

- ページ移動による項目の消失・二重配置・フォーム所有の変化：Task 1/2で全入力名と値を照合。
- 新IDに追随しないOutlook取得・タグ管理・更新等の入口：Task 2の呼出しテスト。
- 保存、取消、失敗後の再試行と即保存の違い：Task 2の既存ケース保持。
- 9言語、狭幅、11ページのキーボード移動・スクロール：Task 2の表示/操作ケース。
- 古い誤称の残存と互換キーの破壊：Task 2/4の命名監査。旧記録と現行ソースを区別する。

### Task 1: Aが8ページの現状を保存

**Files:** `out/settings-mece-20261008/initial-*`。

- [ ] allowlistで現在ソースを保存し、私的添付を除外する。
- [ ] 既存175必須と20画像を実行・保存する。
- [ ] 既存設定の型・名前・値と構成の記録をBへ渡す。

### Task 2: Bが11ページと正しい命名へ変更、Aが受入試験

**Files:** `src-tauri/renderer/src/settings-pages.js`、`settings-dialog.js`、関連するcaller、`assets/app.html`、`assets/styles.css`、`src/locales/settings-followup.js`と辞書。Aは既存settings/UI/harness試験と必要な設定契約試験を担当する。

- [ ] 一時UI page IDをdisplay/work/tags/ai/outlook/links/startup/data/updates/shortcuts/infoへ統一する。
- [ ] 既存DOM移動方式で各設定を唯一の目的別ページへ移す。
- [ ] pageControl/initialPage等へ意味を合わせ、深いリンク・翻訳・案内を同期する。
- [ ] Aが承認された新構成へ試験を更新し、保存/取消/値/エラー等の従来の保証を保持する。旧8期待値は記録に残す。
- [ ] 11ページの全必須ケース、画面、16指標×7回、ソースを新しいbeforeとしてAが固定する。

### Task 3: Bが純粋な内部整理

**Files:** `assets/app.html`、`src/settings-pages.js`、必要な死んだスタイルの箇所。

- [ ] HTMLへ同じ11ページ・設定順序を直接配置し、起動後の不要なDOM移動を除く。
- [ ] 動的参照とCSS上書きを確認した不要コードだけを削除する。
- [ ] 設定値・DOMの表示順・見た目・操作を保った関連試験を実行する。
- [ ] 差分と根拠をCへ渡す。

### Task 4: Cの独立確認と親の反映

**Files:** `out/settings-mece-20261008/verification/` と日本語の利用者向け報告。

- [ ] 全必須ケース・画面・性能・ガードをCが独立に再実行する。
- [ ] 初期8→最終11の比較画像と、純粋整理11→11の画素一致を別記する。
- [ ] 本体・試験・文書を分けた容量/行数、速度の生値・ばらつき、未確認を報告する。
- [ ] 親が実際の証跡を確認してREADME/画像を更新し、developへcommit/push、リモートSHAを確認する。
