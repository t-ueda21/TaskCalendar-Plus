# v3.0.0 Second Refactoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for the implementation steps, within the separate A/B/C roles of refactor-with-baseline. The user has already authorized implementation and push to develop.

**Goal:** 現在のv3.0.0をもう一度、機能を変えずに整理し、前後を確認してdevelopへpushする。

**Architecture:** カレンダーとタスク一覧で重複する右クリックメニューの描画・配置を、既存のメニュー要素を管理するui-utilsへ集約する。各画面はフォーカス、Store操作、Undo記録、非同期完了を担い続ける。対象3ファイルの参照されないimportだけを除去する。

**Tech Stack:** JavaScript ES modules、Rust/Tauri、隔離Chromium + Playwright、既存の合成API検証ハーネス。

**Spec:** ユーザー原文「一通り完了したらもう一度リファクタリングだけして下さい。そして、developブランチにpushして下さい。」。開始点はc87c570。詳細境界と担当記録はローカルの `out/refactor-20261008-pass2/request.md`、`roles.json`。

## Global Constraints

- 機能、文言、見た目、操作、保存形式、公開APIを変更しない。
- `develop` は開始時リモートに存在しないため、確認済みv3.0.0のc87c570から作成。検証後に通常pushし、リモートSHAを確認する。
- バージョン3.0.0維持。main更新、force push、タグ、Release、公開配布を行わない。
- A `/root/refactor2_baseline`、B `/root/refactor2_impl`、C `/root/refactor2_verify`。A/B/Cは兼任しない。
- BはAの全必須成功・基準固定までアプリを編集せず、固定後の試験・計測器・データ・画像・許容差を変更しない。
- 既存の実環境確認待ち #2/#4/#5/#12を確認済みとしない。
- ネイティブアプリ/Tauri/WebView2/Edge起動、実Outlook/AI、ユーザーAppData、稼働中アプリへ触れない。
- `.codex-remote-attachments`、過去証跡、資格情報を変更・保存・pushに含めない。

## Review Focus

- カレンダーのタグ変更はUndo記録後に更新を開始してすぐ閉じる。一覧は更新完了を待って閉じる。この既存差をTask 1で固定しTask 2で保持する。
- 編集時はその時点のタグ情報を再取得する。メニューを別の予定で開き直しても前の予定を操作しない（Task 1）。
- 単独予定/シリーズ、タグなし/削除済みタグ、タグ0件でも項目と選択状態を維持する（Task 1）。
- タグ名をHTMLとして実行しない。色・aria属性、画面端8pxの配置、Esc/外側/スクロール/リサイズによる閉じ方を維持する（Task 1）。
- `ui-utils.js` からStoreをimportせず、現在の循環依存回避とモジュール副作用を維持する（Task 2、Cの差分確認）。

### Task 1: Aが現在のメニュー動作を固定する

**Files:** 既存 `scripts/refactor-20261008-{checks,ui,harness,benchmark,snapshot,freeze}.mjs`、追加特性試験、`out/refactor-20261008-pass2/` のbefore資料と固定契約。

**Interfaces:** 既存openHarnessのpage/boot/state/closeと実際の右クリックUIを使用。内部共通関数の形に依存する試験にはしない。B/Cへケース表・contract・beforeソース・ログ・生計測・画像・ガードSHAを渡す。

- [ ] 両画面の右クリック、編集、削除の取消/成功、タグ変更、Undo/Redo、非同期閉じ方、空・境界・閉じ操作を現行コードで確認する。
- [ ] 必要な特性試験を追加し、既存の全必須試験とともに現行コードで成功させる。失敗の除外や期待値緩和で固定しない。
- [ ] 同じデータ・時計・テーマ・画面条件で変更前の画面と16性能指標×7回を取得する。計測中は他の試験/ビルドを止める。
- [ ] 未追跡の必要ソースを含むallowlist snapshotとガードを作成し、Bへ固定条件を渡す。未確認範囲は別記する。

### Task 2: Bがメニュー重複と未参照importを整理する

**Files:** `src-tauri/renderer/src/calendar.js`、`tasks.js`、`ui-utils.js` のみ。

**Interfaces:** `ui-utils.js` の新しい共通描画関数は既存menu要素、task/tags/seriesCount、座標、編集・削除・タグ選択callbackを受ける。描画関数へStoreや画面のUndo状態を持ち込まない。既存ensureTaskTagMenu/hideTaskTagMenuの動作を維持する。

- [ ] 既存メニューDOM、textContentによるラベル、色見本、active/aria状態、画面端配置を共通関数へ移す。
- [ ] 両画面の_openTaskTagMenuはフォーカス・最新タグの取得・操作callbackを維持して共通描画を呼ぶ。
- [ ] タグ変更callbackへ各画面の即時/awaitとUndoの既存動作をそのまま残す。
- [ ] 動的参照とimport副作用を確認した未参照importのみ除去する。
- [ ] 固定した関連試験を実行し、変更一覧と根拠・結果をCへ渡す。

### Task 3: Cが独立検証し、親がdevelopへ反映する

**Files:** `out/refactor-20261008-pass2/verification/`、`docs/reviews/v3.0.0-refactor-pass2.md`。

**Interfaces:** CはAの固定ガード/contract/beforeを読み、完成したアプリで全必須ケース・画像・性能・ソース量を再計測する。親はCの証跡を確認し、Gitの反映と報告だけを行う。

- [ ] 前後のガード、ケース/データ、全必須試験、画像、16指標の生値を照合する。失敗はB、基準の問題はAへ返す。
- [ ] 容量・物理行・非空行を同じ規則で比較し、試験・文書・資産をアプリ本体から分ける。UI変更なしを状態と条件付きで報告する。
- [ ] Cの独立結果を日本語にまとめ、改善しなかった点と未確認を記載する。
- [ ] 親が差分・実際の結果・バージョンを確認し、実装と報告をcommitする。
- [ ] `git push origin HEAD:refs/heads/develop` を実行し、ローカルHEADとリモートdevelopのSHA一致、タグ/Release未作成を確認する。
