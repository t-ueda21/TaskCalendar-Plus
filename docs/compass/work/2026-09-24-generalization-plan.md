# 旧版アプリの一般化計画

- 作成日: 2026-09-24
- 対象元: 旧版リポジトリ（v0.1.12）
- 作業先: `C:\Code\taskcalendar+`（当面Git管理なし、将来GitHubで管理）

## 1. 決定事項

| # | 項目 | 決定 |
|---|------|------|
| D1 | 作業場所 | `taskcalendar+` に新規作成。既存リポジトリの履歴は引き継がない（社内URL・社内メールアドレスを持ち込まない） |
| D2 | Git | 当面なし。将来GitHubへ公開 |
| D3 | 旧組織版の扱い | 一般版を本体とし、旧組織版は「設定プリセット＋ビルド設定の上書き」で作る。コードは1本 |
| D4 | AIモード | Claude Code / Codex を持っている人は、それと連携して動くようにする |
| D5 | 製品名 | TaskCalendar+ |
| D6 | ライセンス | MIT |
| D7 | 既定タグ | なし |
| D8 | 稼働時間の既定値 | 09:00–18:00（昼休み 12:00–13:00 は工数から除外） |
| D9 | 天気の地点 | 都道府県庁所在地の一覧から選ぶ |
| D10 | identifier | 仮に `io.github.t-ueda21.taskcalendarplus`（GitHub公開時に確定） |
| D11 | Outlook自動同期 | 既定 OFF |
| D12 | LICENSE 著作権者 | t-ueda21 |
| D13 | 旧組織版ビルド | 作らない（D3 のうち「ビルド設定の上書き」は取りやめ） |

## 2. 旧組織固有箇所の棚卸しと一般化方針

### A. 削除

| 箇所 | 内容 | 方針 |
|------|------|------|
| `app.html` ほか3ページのヘッダー | イントラ（社内URL）、ポータル（社内SharePointのURL）へのリンク | 削除し、C-2 のクイックリンクへ置き換え |
| `app.html` About | 社内GitLabのリリースノート、不具合報告リンク | 公開リポジトリのURLへ差し替え（決まるまでは非表示） |
| `src/api.rs` の live テスト | 社内Ollamaのホスト名を直書き | 環境変数指定へ変更、URLは削除 |

### B. 名前の変更

| 箇所 | 現在 | 一般版（案） |
|------|------|-------------|
| `tauri.conf.json` productName / window title | 旧版の製品名 | TaskCalendar+（仮） |
| `tauri.conf.json` identifier | 旧版のidentifier | 公開時の名前空間で決定（例 `io.github.<user>.taskcalendarplus`） |
| `Cargo.toml` name | 旧版 | taskcalendar-plus |
| HTML `<title>` / h1 | 旧版の製品名 | 製品名 |
| localStorage キー | 旧名の接頭辞付きキー3件 | `tcplus_*` |
| 環境変数 | 旧名の接頭辞付き環境変数3件 | `TCPLUS_*`（embedは削除） |
| AIプロンプト | 「あなたは 旧版の製品名 のアシスタントです」 | 製品名 |
| About 文言 | 「イントラの日報へ反映」 | 「日報・工数報告へ転記」 |
| アイコン | 「S」バッジ入り（`icons/*`、`renderer/assets/app-icon/icon.ico`） | 新規作成 |
| 設定キー | 旧組織名入りのキー | `companyHolidays` / `companyHolidayEntries`（旧キーは読み込み時に移行） |
| DOM属性 | 旧組織名入りの属性 | `data-company-holidays-*` |

### C. 設定化（値はユーザーまたはプリセットが与える）

| # | 箇所 | 現在 | 一般版の既定値 |
|---|------|------|---------------|
| C-1 | イントラ自動起動（URL・既定時刻が固定） | URL固定 | 「指定時刻にURLを開く」。URL・ラベル・時刻を入力、既定OFF・空欄 |
| C-2 | ヘッダーリンク | 固定2件 | クイックリンク（ラベル＋URLのリスト）、既定は空 |
| C-3 | 所定休日の名称（`DEFAULT_COMPANY_HOLIDAY_NAME = "旧組織所定休日"`） | 旧組織所定休日 | 会社休日 |
| C-4 | 既定タグ（`db.rs` の `DEFAULT_TAGS`） | 研修/セミナー、案件外会議、案件外日常業務 | 会議、作業、学習 |
| C-5 | 稼働時間 | 9:00–17:45、昼休み 11:30–12:30 は工数に含める、17:45–18:00 休憩 | 9:00–18:00、昼休み 12:00–13:00 は工数から除外 |
| C-6 | 天気の地点 | 既定大阪、6都市固定 | Open-Meteo Geocoding APIで地名検索、既定は東京 |
| C-7 | AI接続先・モデル | 社内Ollamaのホストと `qwen3.6:35b` 固定（環境変数でのみ変更） | 設定画面で指定（第3章） |

### D. そのまま使う

日本の祝日計算、Outlook COM連携、タスクトレイ、ログイン時自動起動、Open-Meteo天気、日報コピー、AIモード本体、SQLite、HTTP API構成。

### E. 整理

- `calendar.html` / `tasks.html` / `ai.html`: `/` は `app.html` へリダイレクトされるため旧ページの可能性が高い。ただし `ui-utils.js:254` に参照がある。旧組織文言が3倍に増えている原因なので、参照を確認したうえで削除する。
- `/api/ai/embed`: フロントエンドから呼ばれていないため削除する。

### F. リリース準備

- `docs/`、`CHANGELOG.md`、`.gitlab/` の6ファイル・27箇所に社内ホスト名、Issue番号、経緯がある。移すのではなく書き直す。
- ライセンス選定、README書き直し。
- コード署名は自己署名のためSmartScreen警告が出る。OSS向け署名（SignPath等）は公開時に検討する。
- identifier が変わるとデータ保存先も変わる。一般版は旧組織版とは別アプリとして共存する（データ移行なし）。

## 3. AIプロバイダー設計

### 現状

- フロントエンドは `/api/ai/chat` に `{messages, model?, format?}` を送り、`{message: {content}}` を受け取る。`format` はJSON Schemaで、構造化出力に使っている（`ai-memory.js` の複数箇所）。
- Rust側（`api.rs` の `ai_chat`）は Ollama の `/api/chat` へ中継するだけ。
- `/api/ai/embed` はフロントエンドから使われていない。

### 方針

`/api/ai/chat` の入出力はそのまま保ち、Rust側に provider の切り替えを入れる。フロントエンドの変更は設定画面だけで済む。

| provider | 呼び出し方 | 構造化出力 |
|----------|-----------|-----------|
| `claude-code` | `claude -p --output-format json --model <m> --system-prompt <s> --tools "" --no-session-persistence --setting-sources "" --strict-mcp-config` を子プロセスで起動し、promptは標準入力で渡す | `--json-schema <schema>` |
| `codex` | `codex app-server`（JSON-RPC over stdio）または `codex exec`。実装前に手元のCodexで仕様を確認する | `--output-schema` 相当を確認 |
| `ollama` | 現行どおりHTTP。旧組織プリセットはこれを使う | `format` |
| `none` | AIモードを無効化 | — |

- Claude Code のフラグはローカルの v2.1.258 で存在を確認済み（`-p` `--output-format` `--json-schema` `--model` `--system-prompt` `--tools` `--no-session-persistence` `--setting-sources` `--strict-mcp-config`）。
- messages 配列は system と会話本文に分けて1つのpromptへまとめる。
- 安全策: ツールを全部無効にする、作業ディレクトリは空の一時ディレクトリ、ユーザーのCLAUDE.md・MCP・設定を読ませない。ファイル操作やコマンド実行はさせない。
- 検出: 設定画面の「検出」ボタンで `claude --version` / `codex --version` を実行して利用可否を表示する。
- タイムアウト: CLIは起動に数秒かかるため、現行の45秒を provider ごとに設定できるようにする。
- 通知: 予定データが Anthropic / OpenAI へ送られることを、AIモードを初めて有効にするときに明示する。
- 未確認: Codex CLI はこのPCに未インストールのため、`codex` provider の呼び出し仕様は実装時に確認する。

## 4. 旧組織プリセットの仕組み

1. **設定プリセット（JSON）**: クイックリンク、URL自動オープン、所定休日の名称、既定タグ、稼働時間、天気の地点、AI provider（ollama＋社内ホスト＋モデル）。
2. **ビルド設定の上書き**: `tauri build --config <上書き用の設定ファイル>` で productName・identifier を旧組織版の値にする。identifierを 旧版のidentifier に戻せば、既存旧組織利用者のデータをそのまま引き継げる。
3. **適用**: バンドルリソースに `preset.json` があれば初回起動時に既定値として適用する。加えて設定画面に「設定のインポート／エクスポート」を付け、手動でも適用できるようにする。
4. **保管場所**: 旧組織プリセットと上書き設定には社内URLが入るため、公開リポジトリには置かない。社内GitLabに別リポジトリ（プリセットとビルド手順だけ）を置く。

## 5. 作業フェーズ

| Phase | 内容 | 確認方法 |
|-------|------|---------|
| 1 | ソースを `taskcalendar+` へコピー（`target/`、`gen/`、`docs/`、`.gitlab/`、`CHANGELOG.md` は除外） | `cargo test`、`cargo clippy` が元と同じ結果になる |
| 2 | A（削除）、B（名前の変更）、E（旧ページとembedの削除） | 社内ホスト名・組織名・「イントラ」「社内」の grep ヒットが0件、`cargo test` |
| 3 | C（設定化）、設定キーの移行、設定のインポート／エクスポート | 単体テストの追加、実際にアプリを起動して設定画面を確認 |
| 4 | AIプロバイダー（claude-code → codex → ollama維持） | モックCLIでのテスト、実機でClaude Code連携 |
| 5 | 旧組織プリセットとビルド上書き | 旧組織ビルドで既存データが読めること |
| 6 | README、ライセンス、アイコン、`.compass/plugin-config.json` の検証コマンド更新 | 配布用ビルド `npx --yes @tauri-apps/cli@2 build` |

## 6. 未決事項

- identifier の確定（GitHub公開時）
- 旧組織向けの設定プリセット（エクスポート形式のJSON）を作るか。作る場合、社内URLを含むため公開リポジトリの外に置く

## 7. 進捗

### 2026-09-24 Phase 1・2 完了

- 元リポジトリのGit追跡ファイルのうち `docs/`、`.gitlab/`、`CHANGELOG.md`、`README.md` を除く38ファイルをコピー。
- 変更前の基準: `cargo test` 25 passed / 2 ignored。
- 削除: 旧ページ `calendar.html` / `tasks.html` / `ai.html` と `main.js` の旧ページ起動処理、`ui-utils.js` の `_updateNavDateLinks`、ヘッダーのイントラ・ポータルリンク、About の社内GitLabリンク、`/api/ai/embed` とそのテスト2件。
- 名前の変更: 製品名、identifier、Cargo name（`taskcalendar-plus`、version 0.1.0、license MIT）、localStorage キー `tcplus_*`、環境変数 `TCPLUS_*`、AIプロンプト、About 文言、設定キー。
- 設定化（Phase 3 の一部を前倒し）: イントラ自動起動 →「URL自動オープン」（URL入力欄を追加、既定OFF・URL空・時刻空）。所定休日の名称を「会社休日」に変更。稼働時間の既定値を 09:00–18:00、昼休み 12:00–13:00（工数から除外）に変更。
- 旧設定キー移行: 旧版の設定キー（URL自動オープンと会社休日の旧名）は、新キーが無い場合に新キーへ引き継いで削除する（`store.js` の `LEGACY_SETTING_KEYS`）。
- AI既定ホストを `http://localhost:11434` に変更。liveテストは `TCPLUS_LIVE_AI_HOST` で接続先を指定する形に変更。
- 確認結果:
  - `cargo test`: 23 passed / 2 ignored（embedテスト2件の削除分だけ減少）
  - `cargo clippy`: 警告0
  - `node scripts/test-holidays.mjs`、`node scripts/test-recurrence.js`: 成功
  - `cargo run` で起動し、内蔵HTTPサーバーをブラウザで開いて確認: 詳細タブのURL自動オープン欄の表示・無効化・保存・時刻の正規化、旧キーからの移行、コンソールエラーなし
- 社内ホスト名・組織名等の grep のヒットは `store.js` の移行用旧キー名4件のみ（意図的に残している）。

### 2026-09-24 Phase 3 完了

- 既定タグなし: `db.rs` の既定タグ3件とシード処理を削除、スキーマの `tag_id` 既定値を空文字に、`repositories.rs` の tagId 未指定時の既定値を空文字（タグなし）に変更。
- 最後の1件のタグを削除できない不具合を修正: 従来は最後の1件だと 204 を返すだけで何もしなかった（既定タグ3件があったため表面化しなかった）。参照タスクを「タグなし」にしてから削除するように変更（`api.rs` の `tags_delete`）。
- 天気の地点: 都道府県庁所在地47件（北から都道府県コード順）、既定は東京。旧版の6都市のキーはそのまま使える。設定のラベル「勤務地」を「地点」に変更。
- クイックリンク: 設定 `quickLinks`（[{label, url}]、http/https のみ、最大8件）。基本タブで「ラベル,URL」を1行1件で入力し、ヘッダーに表示する。
- 設定のエクスポート／インポート: 説明タブに追加。設定とタグ（IDなし）をJSONに書き出す。タスクは含まない。このDBのタグIDを参照する `monthTagOrders` / `outlookSyncTagId` は書き出さない。取り込みは既知の設定キーだけを反映し、タグは名前で突き合わせて無いものだけ作成し、当月のタグ順へ追加する。旧組織プリセット（Phase 5）もこの形式を使う。
- 純粋関数を `renderer/src/settings-transfer.js` に分け、`scripts/test-settings-transfer.mjs` を追加。
- 確認結果:
  - `cargo test`: 25 passed / 2 ignored（既定タグなし・最後のタグ削除・tagId省略時のテストを追加）
  - `cargo clippy --all-targets`: 警告0
  - `node scripts/test-settings-transfer.mjs`（7件）、`test-holidays.mjs`、`test-recurrence.js`: 成功
  - 実機（`cargo run`、WebView2 の DevTools 経由で操作）: 新規DBでタグ0件、47地点の選択と天気取得、クイックリンクの保存とヘッダー表示（javascript: URL は除外）、タグ追加と当月への登録、最後のタグ削除でタスクがタグなしになる、エクスポートが `Downloads` に保存される、インポートの確認ダイアログと反映（未知キー除外、タグの突き合わせ、予算）、画面レイアウト

### 気づいた点（未対応）

- Outlook自動同期の既定値が ON のため、初回起動でOutlookの予定を自動で取り込む。一般版では既定 OFF が妥当か要判断。
- タグID省略時のタグ作成（`POST /api/tags`）はミリ秒時刻からIDを作るため、同じミリ秒に2件作ると重複して 500 になる。フロントは常にUUIDを付けるため通常利用では起きない（元からの挙動）。
- タグを削除しても `monthTagOrders` に削除済みIDが残る（表示時に除外されるため実害なし、元からの挙動）。

### 2026-09-24 Phase 4 完了（Codex は実機未確認）

- AIの接続先を設定 `aiProvider` で選ぶ: `none`（既定）/ `claude-code` / `codex` / `ollama`。関連設定 `aiClaudeModel` / `aiCodexModel` / `aiOllamaHost`（空欄ならCLIの既定・Rust側の既定ホスト）。
- Rust: `src/ai_cli.rs` を追加。`/api/ai/chat` はDBの設定を読んで接続先を切り替える（フロントからの呼び方・応答形式は変えていない）。`GET /api/ai/detect` で `claude --version` / `codex --version` を実行して利用可否を返す。
  - Claude Code: `claude -p --output-format json --no-session-persistence --strict-mcp-config --setting-sources "" --tools "" --system-prompt <s> [--model] [--json-schema]`。promptは標準入力。`structured_output` があればJSON文字列として返す。
  - Codex: `codex exec --skip-git-repo-check --ephemeral --sandbox read-only --ignore-user-config --ignore-rules -C <一時dir> -o <file> [-m] [--output-schema <file>] -`。フラグは公式リファレンス（developer-commands / non-interactive mode）で確認。
  - 共通: 呼び出しごとの空の一時ディレクトリで実行して終了後に削除、コンソールウィンドウを出さない（CREATE_NO_WINDOW）、170秒で打ち切り、Windowsでは `claude.cmd` 等も探す、環境変数 `TCPLUS_CLAUDE_PATH` / `TCPLUS_CODEX_PATH` で実行ファイルを指定可能。
- フロント: 設定の「AIモデル」欄を「AI」欄に置き換え（接続先、検出ボタン、接続先ごとのモデル・ホスト、送信内容の注意書き）。Claude Code / Codex を新たに選んで保存するときは、送信先（Anthropic / OpenAI）を示して確認する。
  - `_callAi`: `none` なら即エラー（呼び出し側はローカル要約・ローカル検索にフォールバック）。CLI型は別モデルでの再試行をせず、タイムアウトを180秒に延長。
  - 起動時の過去日サマリー一括補完（最大10日分）は CLI型では行わない（利用枠を消費するため）。タスク一覧で過去日を開いたときに1日分だけ生成される。
  - AIモードのラベルを「AI: 接続先 / モデル」に変更。接続先を切り替えた後は前の接続先の実行モデル名を出さない。
  - 元からの不具合修正: 存在しないモデル `qwen3.6:27b` へのフォールバック（`ai-memory.js`、`ui-utils.js`）を解消。
- 確認結果:
  - `cargo test`: 39 passed / 2 ignored（引数組立・出力解析・設定解決の単体テスト、偽CLI（.cmd）による Claude Code / Codex / 検出の結合テスト、未設定時503を追加）
  - `cargo clippy --all-targets`: 警告0
  - node テスト3本: 成功
  - 実機（WebView2 DevTools経由）: 既定「使わない」で503とAIモードのフォールバック、設定画面の切替表示・検出（Claude Code 2.1.258 検出、Codex 未検出）、同意ダイアログ、Claude Code（haiku）で予定作成の解釈から確認メッセージまで、単発の構造化出力（約5秒）、一時ディレクトリの削除とセッション履歴が残らないこと、Ollama未起動時のエラー
- 未確認: Codex CLI はこのPCに無いため実機では未確認（引数の単体テストと偽CLIでの結合テストのみ）。

### 2026-09-24 Phase 6（リリース準備）

- Outlook自動同期の既定を OFF に変更（`store.js`。Rust側の同期ループはキーが無ければ OFF 扱いのため変更なし）。
- `LICENSE`（MIT、Copyright (c) 2026 t-ueda21）、`README.md`（一般向けに書き直し）、`CHANGELOG.md`（0.1.0、未リリース）を追加。
- アイコンを作り直し（カレンダー＋オレンジの「+」バッジ）。`scripts/make-icon.py`（Pillow）で `src-tauri/icons/*` と `renderer/assets/app-icon/icon.ico` を生成。
- `.compass/plugin-config.json` に stacks と検証コマンドを登録（README と同じ文字列）。
- 確認結果:
  - README記載のテスト・lintコマンドをそのまま実行: `cargo test` 39 passed / 2 ignored、`cargo clippy --all-targets` 警告0、node テスト3本成功
  - 新規DBで起動: Outlook自動同期 OFF、設定保存後に同期ループの周期（60秒）以上待っても予定は取り込まれない、AI「使わない」、タグ0件、アプリアイコンは新しい `icon.ico`
  - `cargo build --release`: 成功。初回ビルドで警告1件と表示されたが、再コンパイルでは再現せず内容は未確認
  - インストーラー作成（`npx --yes @tauri-apps/cli@2 build`）は npm から Tauri CLI を取得するため未実行

### 2026-09-24 公開前の課題15件への対応

| # | 課題 | 対応 | 確認 |
|---|------|------|------|
| 1 | 内蔵HTTP APIに外部からのアクセス対策がない | 起動ごとの合言葉(Tauriコマンド `get_api_token` で画面にだけ渡し、`tauri-shell-bridge.js` が `/api/` の fetch に付ける)を全APIで確認。全要求で `Host` がループバックか、`Origin` があれば自分自身かを確認。POST/PUT は JSON のみ。Outlook同期ループも合言葉を付ける | 単体テスト4件、実機で合言葉なしは401・画面からは200 |
| 2 | タスクのバックアップ手段がない | `GET /api/backup` / `POST /api/restore`(トランザクションで全置換、不正なファイルは何も変更しない)。説明タブにバックアップ/復元 | 往復・不正ファイルのテスト、実機でバックアップ→データ追加→復元 |
| 3 | インストーラー未作成・署名なし | **未対応**(Tauri CLI のダウンロード許可と、署名サービスのアカウントが必要) | — |
| 4 | 計画書に社内情報 | 社内ホスト名・URL・旧identifier・元リポジトリ名を伏せ、組織名を「旧組織」に置換 | grep で社内ホスト名が0件 |
| 5 | Codex 実機未確認 | 設定画面・README・検出結果に「試験的」と表示。実機確認は**未対応**(Codex CLI の導入・ログインが必要) | — |
| 6 | CLI仕様変更で動かなくなる | 検出で動作確認済み(Claude Code 2.1.258)より古ければ警告。失敗時のエラーにCLIのバージョンを付ける。READMEに動作確認済みバージョン | 単体テスト(バージョン解析・比較)、偽CLIでエラー文言 |
| 7 | 利用規約 | README に利用規約・所属組織のルールに従う旨を明記(規約の内容自体は確認していない) | — |
| 8 | AIモードが遅い | 計測: 予定作成はAI呼び出し1回(約13秒)で、すでに1回にまとまっていた。待機中に経過秒数と「10〜30秒ほどかかる」旨を表示 | 実機で経過秒数の表示 |
| 9 | 日本向け専用 | README の動作環境に明記 | — |
| 10 | 新しいOutlook非対応 | README に明記 | — |
| 11 | 簡易サマリーが残る | サマリーに `generatedBy`("ai"/"local")を保存。AI有効時に簡易版の過去日を開くと作り直す(1回の起動につき同じ日は1回だけ)。起動時の一括補完(Ollama)も対象 | 実機で簡易版→AI版に更新(Claude Code、約65秒) |
| 12 | 取り込みでURL等を書き換えられる | 設定インポート・復元の確認に、URL自動オープン・クイックリンク・AIの接続先・Ollamaホスト・アイコンURLを表示 | 実機で確認文言 |
| 13 | 自動テストが薄い・CIなし | `.github/workflows/ci.yml`(Windows、cargo test / clippy -D warnings / JS構文チェック / node テスト)。`scripts/e2e-smoke.mjs`(実アプリを起動しCDPで10項目確認、データは `TCPLUS_DATA_DIR` の一時フォルダ)。`.gitignore` の `/.github/` 除外を削除 | CIの各コマンドを手元で実行、E2E 10項目成功、構文エラーを入れるとE2Eが失敗することを確認 |
| 14 | タグIDの重複、削除済みIDが残る | タグIDを乱数で生成。タグ削除時に `monthTagOrders` と `outlookSyncTagId` からも除去し、画面は設定を読み直す | 単体テスト、実機で確認 |
| 15 | 旧版からの設定移行処理が残る | 削除 | grep で旧名が0件 |

- 作業中に見つけた不具合: パッチ適用時に、JavaScriptの `"..."` の中へ本物の改行が入り、WebView2 で `ui-utils.js` が構文エラーになって画面が起動しなくなった。`node --check` では検出できなかったため、構文チェックを `node --input-type=module --check` に変え、CIとE2Eにも入れた。
- テスト結果: `cargo test` 47 passed / 2 ignored、`cargo clippy --all-targets -- -D warnings` 警告0、node テスト3本成功、E2E 10項目成功。
- 気づいた点(未対応): Claude Code(haiku)で「明日の10時から11時に定例を入れて」のタイトルが「明日の10時から11時に定例」になる(AIの解釈品質)。

### 2026-09-24 AI連携の見直しとCodexの実機確認

- 決定: インストーラーは作らない。コード署名はしない。Claude Code / Codex と接続するかは利用者が決める(既定オフ、説明付き)。
- 計画書から旧識別子名を削除。
- 連携スイッチ `aiCliEnabled`(既定 false)。オフの間は接続先の Claude Code / Codex を選べず(画面)、Rust側も呼び出さない。オンにして保存するときに送信先を示して確認する。
- モデルと effort を設定画面で選べるようにした: `aiClaudeEffort`(low/medium/high/xhigh/max → `--effort`)、`aiCodexEffort`(minimal/low/medium/high/xhigh → `-c model_reasoning_effort=`)。Claude のモデルは候補(sonnet/opus/haiku)付きの入力欄。AIモード画面に effort と実際のモデル名を表示。
- Codex CLI 0.156.1 を winget で導入(ChatGPTでログイン済み)。winget がエイリアスを作れず `codex-x86_64-pc-windows-msvc.exe` のままPATHに置かれたため、この名前も探すようにした。
- 実機で判明: OpenAIの構造化出力は厳格なスキーマ(`additionalProperties: false`・全項目 `required`)が必要で、1回目が 400 になりスキーマなしの再試行で成功していた。Codexに渡すときだけスキーマを変換(任意項目は null も許す必須項目に)。Codexの stderr の `model:` 行から実際のモデル名を取る。
- 実機で判明(元からの不具合): AIモードの予定作成・変更で、AIが抽出したタイトル等を正規表現の簡易抽出が上書きしていた。AIの値を優先し、空の項目だけ簡易抽出で補うよう修正。
- AI未設定時にAIモードで予定操作を頼むと、AIの設定が必要な旨を案内する。
- 確認結果:
  - `cargo test` 50 passed / 2 ignored、`cargo clippy --all-targets -- -D warnings` 警告0、JS構文チェック、node テスト3本
  - 実機: 連携スイッチ既定オフ・オフ時の選択肢無効・オフで保存すると接続先が「使わない」に戻る・Rust側もオフなら 503、検出(Claude Code 2.1.258 / Codex 0.156.1)、同意ダイアログ、Codex(effort low)で予定作成 1回・約12〜15秒・タイトル「設計レビュー」・実行モデル表示、Claude Code(haiku / effort low)で同じく1回・約21秒・タイトル「設計レビュー」、AI未設定時の案内
  - E2E(`scripts/e2e-smoke.mjs`)に「連携は既定でオフ」「AI未設定ではAIを呼ばない」を追加

### 2026-09-24 AIモードの質問応答の作り直し

- 原因: 質問かどうかをキーワードの正規表現で判定(「今月あと何時間使える？」は予定データを見ない雑談扱い)、データは文字一致の点数で選択(相対日付は読まず、一致が無いと一番古い40件を材料にする)、回答は正規表現で作った下書きをAIが言い直すだけ、タグ予算・営業日・稼働時間を使っていなかった。
- 決定: 「今月あとどれくらい工数使える？」には予算の残りと残りの稼働可能時間の両方を答える。AI呼び出しは2回(理解→アプリで計算→回答)。
- 実装:
  - `renderer/src/ai-query.js`(DOM・Store非依存): 日付・期間のローカル解析(今日/昨日/N日前/直近N日/先週の火曜/今週/先月/N月/M月D日/M/D/今年 等)、知りたいことの判定、問い合わせの実行と集計(一覧・合計・タグ別・日別・最初/最後・日次サマリー/メモ・タグ予算の残り・残りの稼働可能時間)、AIに渡す事実の文章化、AIなしの定型回答。
  - 操作判定(extractFunctionCallWithAi)に `query-records` を追加し、期間・タグ・キーワード・知りたいことをJSONで返させる。プロンプトに今日の日付と曜日を追加。
  - 回答はアプリが計算した事実だけをAIに渡して文章化させる(数値を計算させない、Markdown記法を使わせない)。AIなし・失敗時は定型回答。
  - 使われなくなった旧実装(`_looksLikeTaskQuestion`、`_taskScore`、`_buildDeterministicDraft`、`_polishAnswerWithAi`、`_extractTokens`、`_extractMonth`、`_formatDateRange`、`STOP_WORDS`)を削除。
- 確認結果:
  - `scripts/test-ai-query.mjs` 13件成功(今日を 2026-09-24 に固定して日付解析・判定・集計・予算・稼働可能時間を検証)
  - 実機(一時データフォルダに9月分51件・タグ予算を投入): AIなし・Codex(effort low)・Claude Code(haiku / effort low)の3通りで「先週の火曜は何してた？」「9月に設計レビューに何時間使った？」「今月あとどれくらい工数使える？」「最後にRust勉強会をやったのはいつ？」「今週の予定は？」等に期待どおりの数値で回答。AIなしは約1秒、AIありは1問あたり約11〜23秒(呼び出し2回)
  - 予定作成・キャンセル・雑談が引き続き動くことを確認

### 2026-09-24 回答のMarkdown表示と高速化

- 要望: 回答のMarkdown記法がそのまま表示される → Markdownとして表示する。もっと高速にする。
- `renderer/src/markdown.js`(DOM非依存): HTMLをエスケープしてから、見出し・太字・斜体・コード・箇条書き(- * ・、入れ子)・番号付きリスト・引用・表・区切り線・http/httpsのリンクだけを変換。AIの回答の吹き出しだけに使い、ユーザーの入力は従来どおりテキスト表示。記法を禁止していた指示と `**` の除去は撤去し、表・箇条書きの使用を許可。
- 高速化:
  - 記録の質問だとローカル解析で確実に分かる場合(質問語から種類が分かり、期間・タグ・「」の語・既存の予定名のいずれかが特定でき、操作を思わせる語を含まない)は、AIの判定(1回目の呼び出し)を省略(`isConfidentLocalQuery`)。
  - effort の既定値を low に(設定に項目が無い場合もRust側で low。「既定」を選ぶとCLIの既定)。
- 予算・稼働可能時間の回答では、個々の予定を根拠一覧に出さないようにした。
- 確認結果:
  - `scripts/test-markdown.mjs` 8件、`scripts/test-ai-query.mjs` 14件(ローカル判定の確実さを追加)、`cargo test` 51 passed / 2 ignored
  - 実機(9月分51件の一時データ): Claude Code(haiku / effort low)で記録の質問が1問あたりAI呼び出し1回・約4〜8秒(従来2回・約11〜23秒)、Codex(effort low)で約7〜9秒(従来約17〜23秒)。回答の太字・箇条書き・表がMarkdownとして表示されることを画面で確認

### 2026-09-24 AIモードのゼロベース作り直し(MCPエージェント方式)

- 要望: 実装が古い(正規表現で意図を判定し、決まった手順に流し込む)。ゼロベースで作り直す。ローカルAIの仕組み(Ollama接続と、正規表現のローカル解析・定型回答の両方)はやめる。
- 決定: AIがアプリの道具(MCP)を使うエージェント方式。予定の作成・変更・削除は確認カードで確定。
- Rust:
  - `src/calendar.rs`: 日本の祝日(画面側と同じ算出方式)、会社休日、営業日、休憩を除いた所要時間。
  - `src/mcp.rs`: Streamable HTTP の JSON-RPC による MCP サーバー。道具は get_context / search_tasks / summarize_work / month_status / get_daily_notes(読み取り)と propose_create_task / propose_update_task / propose_delete_task(提案の記録だけでDBに書き込まない)。時間は分と「○時間○分」の両方で返し、month_status は「あと使える時間」を内訳付きの文で返す。
  - `/api/ai/chat` に `agent: true` を追加: チャットごとにセッションを発行し、`/mcp/{session}?token=` をCLIへ渡す(Claude Code は `--mcp-config` と `--allowedTools mcp__taskcalendar`、組み込みツールは無効のまま。Codex は `-c mcp_servers.taskcalendar.url=` と、この道具に限った `default_tools_approval_mode="approve"`)。終了後に、そのセッションで出た提案を応答に付ける。
  - エージェントへの指示に、今日の日付と先週・今週・来週の範囲を書く(「来週月曜」の取り違えがあったため)。
  - Ollama の中継、環境変数 `TCPLUS_AI_HOST` / `TCPLUS_AI_MODEL` を削除。
- 画面:
  - `ai-mode.js` を書き直し(約2,200行→約400行)。チャット、Markdown表示、確認カード(作成・変更前後・削除、［確定］で Store 経由で実行、状態を会話と一緒に保存)、待機時間の表示と停止。
  - `ai-client.js`(新規): AI呼び出しとエージェント呼び出し。`ai-memory.js` は日次サマリー(AIのみ、構造化出力)だけに。
  - `ai-query.js` / `task-draft-local.js` とそのテストを削除。起動時の日次サマリー一括作成、簡易版サマリー、Ollama の設定項目(ホスト・モデル一覧)を削除。
- 実機で見つかった問題と対処: Claude Code が month_status の「空き」を「容量」と取り違えて二重に引いた → 結果の項目名を見直し、答えの文を追加。Codex で MCP の道具が承認待ちで拒否された → この道具に限って自動承認。「来週月曜」を10/5と誤解 → 週の範囲を指示に追加。
- 確認結果:
  - `cargo test` 58 passed / 1 ignored(calendar 4件、mcp 5件、MCP窓口の結合テストなどを追加)、`cargo clippy --all-targets -- -D warnings` 警告0
  - 実機(9月分51件の一時データ): Claude Code(haiku / effort low)と Codex(effort low)で、合計工数・あと使える時間・「最後の勉強会以降の予定を定例以外で一覧に」などの複合的な質問に正しく回答(1問約7〜23秒)。来週月曜の予定作成 → ［確定］で登録、変更 → ［確定］で反映、削除 → ［確定］で削除、［取消］で変更なし。日次サマリーの作成(Codex、約10秒)

### 2026-09-24 全体のリファクタリング(機能は変更なし)

- 要望: デッドコード・冗長なコードを削除する。機能はそのまま。
- Rust:
  - 未使用のルート `/api/app-icon`・`GET /api/ai-memory/{kind}/{date}` を削除。`/api/runtime` はアプリのバージョンだけを返す。
  - 要求本文のJSON解析を `parse_body` に共通化。設定の読み書きを `repositories.rs` に一本化(`db.rs` の重複を削除)。トレイ関係の真偽値設定の読み取りを `bool_setting` に統一。
  - 旧版の経緯(Issue番号・旧実装のファイル名)を書いたコメントを、現在の動作の説明に書き直した。
- 画面:
  - 3画面(カレンダー・タスク一覧・AIモード)で同じ内容だった部品を `ui-utils.js` にまとめた: 既定のタグ色 `DEFAULT_TAG_COLOR`、サイドバーの開閉 `wireSidebarToggle`、サイドバーの集計 `renderSideSummaries`、月見出しのタグ一覧 `wireMonthTagPopup`、予定のタグ変更メニュー `ensureTaskTagMenu` / `hideTaskTagMenu`。
  - `store.js`: 使われていない evidence(旧AI回答の根拠)、`ai-chat` の通知、日付変換の重複、ブラウザ実行時の名残を削除。
  - カレンダーのタイムグリッド描画(日・週)を `_renderTimeGrids` に共通化し、初期表示の二重描画をやめた。ヘッダー時計の未使用のタイムゾーン指定、`wireSettingsDialog` の未使用オプション(`defaultTagColor` / `logPrefix`)、会社休日の旧キーへのフォールバック、重複した日付キー判定を削除。
  - `styles.css` の未使用クラス25個、`app.html` の未使用の属性・クラスを削除。
- 確認結果: `cargo test` 58 passed / 1 ignored、`cargo clippy --all-targets -- -D warnings` 警告0、JSモジュールの構文確認、node テスト4本、`scripts/e2e-smoke.mjs` 13項目すべて成功。

### 2026-09-24 ui-utils.js の分割とE2Eの拡充(機能は変更なし)

- `ui-utils.js`(約2,550行)を宣言単位で分割した。循環 import は無い(新しい3ファイルは `ui-utils.js` だけを参照し、`ui-utils.js` は新しいファイルを参照しない)。
  - `time-grid.js`: タイムグリッドの描画、予定ブロックの位置、現在時刻線。
  - `settings-dialog.js`: 設定ダイアログ(タブ、AIの接続先、URL自動オープン、会社休日、設定・バックアップの取り込み/書き出し、Outlook同期、テーマ、休憩時間の編集)。
  - `tag-manager.js`: 設定ダイアログのタグ管理と色の選択ポップアップ。
  - `ui-utils.js`(約1,050行)には、日付・時刻・書式、ミニカレンダー、時刻ピッカー、予定ダイアログ、ヘッダー時計、3画面共通のサイドバー部品が残る。
- `scripts/e2e-smoke.mjs` に12項目を追加(計25項目): 新モジュールの読み込み、3画面のサイドバー集計と開閉、月見出しのタグ一覧(カレンダー・タスク一覧)、日表示の時間枠と予定ブロック、予定の右クリックでのタグ変更、サイドバーのタグ行から設定のタグ管理を開く。
- 確認結果: JSモジュールの構文確認、node テスト4本、`scripts/e2e-smoke.mjs` 25項目すべて成功。

### GitHub公開前に必要なこと

- identifier の確定。
- `.gitignore` 末尾のテンプレート由来のブロックは、`AGENTS.md` / `CLAUDE.md` / `.compass/` を引き続き除外している。Compass の設定をリポジトリに含めるなら見直す。
- 開発用DBの退避ファイル(`%APPDATA%\io.github.t-ueda21.taskcalendarplus\*.bak`)にはOutlookから取り込まれた予定が含まれる。不要なら削除する。
