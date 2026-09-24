//! Claude Code / Codex のCLIを子プロセスとして呼び出すAIプロバイダー。
//!
//! どちらも「ツールを使わせない・ユーザーの設定やMCPを読ませない・セッションを
//! 保存しない・空の作業ディレクトリで動かす」ことで、予定データを渡して文章や
//! JSONを返してもらうだけの用途に限定する。promptは標準入力で渡す(コマンドライン
//! の長さ制限と、Windowsのバッチファイル経由時の引数エスケープを避けるため)。

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

/// CLIは起動と推論に時間がかかるため、Ollamaより長く待つ。
pub const CLI_TIMEOUT: Duration = Duration::from_secs(170);
const DETECT_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_SYSTEM_PROMPT: &str = "あなたは役立つアシスタントです。";
/// 動作を確認したClaude Codeのバージョン。これより古いと引数(`--tools` 等)に対応していない可能性がある。
pub const TESTED_CLAUDE_CODE_VERSION: &str = "2.1.258";
/// 動作を確認したCodex CLIのバージョン。
pub const TESTED_CODEX_VERSION: &str = "0.156.1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliKind {
    ClaudeCode,
    Codex,
}

impl CliKind {
    pub fn program_name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude",
            Self::Codex => "codex",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
        }
    }

    /// 動作確認済みのバージョン。これより古いと引数に対応していない可能性がある。
    pub fn tested_version(self) -> Option<&'static str> {
        match self {
            Self::ClaudeCode => Some(TESTED_CLAUDE_CODE_VERSION),
            Self::Codex => Some(TESTED_CODEX_VERSION),
        }
    }

    /// 設定画面で選べる effort(推論の深さ)。空欄はCLIの既定。
    pub fn effort_levels(self) -> &'static [&'static str] {
        match self {
            Self::ClaudeCode => &["low", "medium", "high", "xhigh", "max"],
            Self::Codex => &["minimal", "low", "medium", "high", "xhigh"],
        }
    }

    /// 対応していない値は既定(空欄)として扱う。
    pub fn normalize_effort(self, value: &str) -> &'static str {
        self.effort_levels().iter().copied().find(|level| *level == value).unwrap_or("")
    }

    /// PATH上で探す実行ファイル名(拡張子なし)。wingetでCodexを入れた環境では
    /// `codex` のエイリアスが作られず、実体の名前のままPATHに置かれることがあるため、それも探す。
    fn program_candidates(self) -> &'static [&'static str] {
        match self {
            Self::ClaudeCode => &["claude"],
            Self::Codex => &["codex", "codex-x86_64-pc-windows-msvc", "codex-aarch64-pc-windows-msvc"],
        }
    }

    pub fn provider_id(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
        }
    }
}

#[derive(Debug)]
pub struct CliError(pub String);

pub struct CliReply {
    pub content: String,
    pub model: String,
}

/// 実行ファイルを探す。`override_path` があればそれを使い、無ければPATHから探す。
/// Windowsではnpm経由のインストール(`claude.cmd`)も見つけられるよう拡張子を補う。
pub fn resolve_program(kind: CliKind, override_path: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = override_path {
        return Some(path.to_path_buf());
    }
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat"] } else { &[""] };
    let path_var = std::env::var_os("PATH")?;
    let dirs: Vec<PathBuf> = std::env::split_paths(&path_var).collect();
    kind.program_candidates().iter().find_map(|name| {
        dirs.iter().find_map(|dir| {
            exts.iter()
                .map(|ext| dir.join(format!("{name}{ext}")))
                .find(|candidate| candidate.is_file())
        })
    })
}

/// messages配列を (system prompt, 本文prompt) に分ける。
/// 本文が1件だけならそのまま、複数なら話者ラベル付きで連結する。
pub fn split_messages(messages: &[Value]) -> (String, String) {
    let mut system = Vec::new();
    let mut turns: Vec<(String, String)> = Vec::new();
    for message in messages {
        let role = message.get("role").and_then(|v| v.as_str()).unwrap_or("user");
        let content = message.get("content").and_then(|v| v.as_str()).unwrap_or("").trim();
        if content.is_empty() {
            continue;
        }
        if role == "system" {
            system.push(content.to_string());
        } else {
            turns.push((role.to_string(), content.to_string()));
        }
    }
    let system = if system.is_empty() { DEFAULT_SYSTEM_PROMPT.to_string() } else { system.join("\n\n") };
    let prompt = match turns.len() {
        0 => String::new(),
        1 => turns.remove(0).1,
        _ => turns
            .iter()
            .map(|(role, content)| {
                let label = if role == "assistant" { "アシスタント" } else { "ユーザー" };
                format!("[{label}]\n{content}")
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
    };
    (system, prompt)
}

/// MCPサーバー(`mcp.rs`)をCLIへ渡すための設定。AIモードのエージェントで使う。
pub fn claude_mcp_config(url: &str) -> String {
    serde_json::json!({ "mcpServers": { crate::mcp::SERVER_NAME: { "type": "http", "url": url } } }).to_string()
}

pub fn claude_args(system: &str, model: &str, effort: &str, schema: Option<&Value>, mcp_url: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--tools",
        "",
        "--system-prompt",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.push(system.to_string());
    if !model.is_empty() {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    let effort = CliKind::ClaudeCode.normalize_effort(effort);
    if !effort.is_empty() {
        args.push("--effort".to_string());
        args.push(effort.to_string());
    }
    if let Some(schema) = schema {
        args.push("--json-schema".to_string());
        args.push(schema.to_string());
    }
    if let Some(url) = mcp_url {
        // 組み込みのツール(--tools "")は無効のまま、アプリのMCPサーバーの道具だけを許可する。
        args.push("--mcp-config".to_string());
        args.push(claude_mcp_config(url));
        args.push("--allowedTools".to_string());
        args.push(format!("mcp__{}", crate::mcp::SERVER_NAME));
    }
    args
}

/// `claude -p --output-format json` の出力から本文とモデル名を取り出す。
/// 構造化出力(`--json-schema`)を指定した場合は `structured_output` をJSON文字列にして返す。
pub fn parse_claude_output(stdout: &str) -> Result<CliReply, CliError> {
    let data: Value = serde_json::from_str(stdout.trim())
        .map_err(|e| CliError(format!("Claude Codeの出力を解析できませんでした: {e}")))?;
    let result_text = data.get("result").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if data.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false) {
        let reason = if result_text.is_empty() {
            data.get("subtype").and_then(|v| v.as_str()).unwrap_or("unknown").to_string()
        } else {
            result_text
        };
        return Err(CliError(format!("Claude Codeがエラーを返しました: {reason}")));
    }
    let content = match data.get("structured_output") {
        Some(v) if !v.is_null() => v.to_string(),
        _ => result_text,
    };
    let model = data
        .get("modelUsage")
        .and_then(|v| v.as_object())
        .and_then(|obj| obj.keys().next().cloned())
        .unwrap_or_default();
    Ok(CliReply { content, model })
}

pub fn codex_args(
    work_dir: &Path,
    output_file: &Path,
    model: &str,
    effort: &str,
    schema_file: Option<&Path>,
    mcp_url: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--ignore-user-config",
        "--ignore-rules",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.push("-C".to_string());
    args.push(work_dir.to_string_lossy().into_owned());
    args.push("-o".to_string());
    args.push(output_file.to_string_lossy().into_owned());
    if !model.is_empty() {
        args.push("-m".to_string());
        args.push(model.to_string());
    }
    let effort = CliKind::Codex.normalize_effort(effort);
    if !effort.is_empty() {
        args.push("-c".to_string());
        args.push(format!("model_reasoning_effort={effort}"));
    }
    if let Some(schema_file) = schema_file {
        args.push("--output-schema".to_string());
        args.push(schema_file.to_string_lossy().into_owned());
    }
    if let Some(url) = mcp_url {
        // アプリのMCPサーバーを渡す(ユーザー設定は --ignore-user-config で読まないため、ここで指定する)。
        let server = crate::mcp::SERVER_NAME;
        args.push("-c".to_string());
        args.push(format!("mcp_servers.{server}.url=\"{url}\""));
        // codex exec は承認を求めない(approval: never)ため、承認が要る道具は拒否される。
        // アプリのMCPサーバーの道具(読み取りと、DBに書き込まない提案だけ)に限って自動承認する。
        args.push("-c".to_string());
        args.push(format!("mcp_servers.{server}.default_tools_approval_mode=\"approve\""));
    }
    args.push("-".to_string());
    args
}

/// バージョン表示(例: "2.1.258 (Claude Code)"、"codex-cli 0.40.0")から x.y.z を取り出す。
pub fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    text.split(|c: char| !(c.is_ascii_digit() || c == '.')).find_map(|token| {
        let mut parts = token.split('.').map(|p| p.parse::<u64>());
        match (parts.next(), parts.next(), parts.next()) {
            (Some(Ok(a)), Some(Ok(b)), Some(Ok(c))) => Some((a, b, c)),
            _ => None,
        }
    })
}

/// `version` が動作確認済みより古いか。どちらかが解析できなければ false。
pub fn is_older_than_tested(kind: CliKind, version: &str) -> bool {
    match (kind.tested_version().and_then(parse_version), parse_version(version)) {
        (Some(tested), Some(actual)) => actual < tested,
        _ => false,
    }
}

fn tail(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    let count = trimmed.chars().count();
    if count <= max_chars {
        return trimmed.to_string();
    }
    trimmed.chars().skip(count - max_chars).collect()
}

/// OpenAIの構造化出力(Codexの `--output-schema`)は厳格なJSON Schemaを要求する:
/// すべてのオブジェクトで `additionalProperties: false`、全プロパティを `required` に並べる。
/// 画面側のスキーマは任意項目を省略できる書き方なので、任意だった項目は「nullも許す必須項目」に変換する
/// (画面側の正規化は null を空として扱う)。
pub fn to_strict_schema(schema: &Value) -> Value {
    let mut out = schema.clone();
    make_strict(&mut out);
    out
}

fn make_strict(node: &mut Value) {
    let Some(obj) = node.as_object_mut() else { return };
    if let Some(items) = obj.get_mut("items") {
        make_strict(items);
    }
    let is_object = obj.get("type").and_then(|t| t.as_str()) == Some("object") || obj.contains_key("properties");
    if !is_object {
        return;
    }
    let originally_required: std::collections::HashSet<String> = obj
        .get("required")
        .and_then(|r| r.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let mut keys = Vec::new();
    if let Some(props) = obj.get_mut("properties").and_then(|p| p.as_object_mut()) {
        for (key, prop) in props.iter_mut() {
            make_strict(prop);
            if !originally_required.contains(key) {
                make_nullable(prop);
            }
            keys.push(Value::String(key.clone()));
        }
    }
    obj.insert("required".to_string(), Value::Array(keys));
    obj.insert("additionalProperties".to_string(), Value::Bool(false));
}

fn make_nullable(prop: &mut Value) {
    let Some(obj) = prop.as_object_mut() else { return };
    match obj.get("type").cloned() {
        Some(Value::String(t)) if t != "null" => {
            obj.insert("type".to_string(), serde_json::json!([t, "null"]));
        }
        Some(Value::Array(mut types)) if !types.contains(&Value::from("null")) => {
            types.push(Value::from("null"));
            obj.insert("type".to_string(), Value::Array(types));
        }
        _ => {}
    }
    if let Some(Value::Array(values)) = obj.get_mut("enum")
        && !values.contains(&Value::Null)
    {
        values.push(Value::Null);
    }
}

/// Codexの進捗出力(stderr)の `model: ...` 行から、実際に使われたモデル名を取り出す。
pub fn parse_codex_model(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .find_map(|line| line.trim().strip_prefix("model:"))
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty())
}

struct CliOutput {
    stdout: String,
    stderr: String,
}

/// CLIを起動して標準入力へ`stdin_text`を渡し、標準出力と標準エラーを返す。
async fn run_cli(
    program: &Path,
    args: &[String],
    stdin_text: &str,
    cwd: &Path,
    timeout: Duration,
) -> Result<CliOutput, CliError> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        // Claude Code のセッション内から起動された場合(開発時)に入れ子実行とみなされないようにする。
        .env_remove("CLAUDECODE")
        .env_remove("CLAUDE_CODE_ENTRYPOINT");
    #[cfg(windows)]
    {
        // リリースビルドはGUIサブシステムのため、コンソールウィンドウを出さない(CREATE_NO_WINDOW)。
        command.creation_flags(0x0800_0000);
    }

    let mut child = command
        .spawn()
        .map_err(|e| CliError(format!("{}を起動できませんでした: {e}", program.display())))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(stdin_text.as_bytes())
            .await
            .map_err(|e| CliError(format!("promptを渡せませんでした: {e}")))?;
    }
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| CliError(format!("{}秒以内に応答がありませんでした", timeout.as_secs())))?
        .map_err(|e| CliError(e.to_string()))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() {
        let detail = if stderr.trim().is_empty() { tail(&stdout, 500) } else { tail(&stderr, 500) };
        return Err(CliError(format!("終了コード {}: {detail}", output.status.code().unwrap_or(-1))));
    }
    Ok(CliOutput { stdout, stderr })
}

/// 1回の呼び出し用の一時ディレクトリ(空の作業ディレクトリ兼、Codexの入出力ファイル置き場)。
pub(crate) struct RequestDir(pub(crate) PathBuf);

impl RequestDir {
    pub(crate) fn create() -> Result<Self, CliError> {
        let dir = std::env::temp_dir()
            .join("taskcalendar-plus-ai")
            .join(format!("req-{}-{:08x}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(&dir).map_err(|e| CliError(format!("作業ディレクトリを作成できませんでした: {e}")))?;
        Ok(Self(dir))
    }
}

impl Drop for RequestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub async fn chat(
    kind: CliKind,
    program_override: Option<&Path>,
    model: &str,
    effort: &str,
    messages: &[Value],
    schema: Option<&Value>,
    mcp_url: Option<&str>,
) -> Result<CliReply, CliError> {
    let program = resolve_program(kind, program_override)
        .ok_or_else(|| CliError(format!("{}({})がPATHに見つかりません", kind.label(), kind.program_name())))?;
    let (system, prompt) = split_messages(messages);
    let dir = RequestDir::create()?;

    match kind {
        CliKind::ClaudeCode => {
            let args = claude_args(&system, model, effort, schema, mcp_url);
            let output = run_cli(&program, &args, &prompt, &dir.0, CLI_TIMEOUT).await?;
            parse_claude_output(&output.stdout)
        }
        CliKind::Codex => {
            let output_file = dir.0.join("last-message.txt");
            let schema_file = match schema {
                Some(schema) => {
                    let path = dir.0.join("schema.json");
                    std::fs::write(&path, to_strict_schema(schema).to_string())
                        .map_err(|e| CliError(format!("スキーマを書き出せませんでした: {e}")))?;
                    Some(path)
                }
                None => None,
            };
            let args = codex_args(&dir.0, &output_file, model, effort, schema_file.as_deref(), mcp_url);
            let stdin_text = format!("{system}\n\n{prompt}");
            let output = run_cli(&program, &args, &stdin_text, &dir.0, CLI_TIMEOUT).await?;
            let used_model = parse_codex_model(&output.stderr).unwrap_or_else(|| model.to_string());
            let content = std::fs::read_to_string(&output_file).unwrap_or(output.stdout).trim().to_string();
            if content.is_empty() {
                return Err(CliError("Codexの応答が空でした".to_string()));
            }
            Ok(CliReply { content, model: used_model })
        }
    }
}

/// `--version` の1行目を返す(失敗時は None)。
pub async fn version(kind: CliKind, program_override: Option<&Path>) -> Option<String> {
    let program = resolve_program(kind, program_override)?;
    let dir = RequestDir::create().ok()?;
    let output = run_cli(&program, &["--version".to_string()], "", &dir.0, DETECT_TIMEOUT).await.ok()?;
    Some(output.stdout.lines().next().unwrap_or("").trim().to_string())
}

/// `--version` を実行して利用可否を返す(設定画面の「検出」ボタン用)。
pub async fn detect(kind: CliKind, program_override: Option<&Path>) -> Value {
    let Some(program) = resolve_program(kind, program_override) else {
        return serde_json::json!({ "available": false, "error": format!("{}がPATHに見つかりません", kind.program_name()) });
    };
    let dir = match RequestDir::create() {
        Ok(dir) => dir,
        Err(err) => return serde_json::json!({ "available": false, "error": err.0 }),
    };
    match run_cli(&program, &["--version".to_string()], "", &dir.0, DETECT_TIMEOUT).await {
        Ok(output) => {
            let version = output.stdout.lines().next().unwrap_or("").trim().to_string();
            serde_json::json!({
                "available": true,
                "path": program.to_string_lossy(),
                "olderThanTested": is_older_than_tested(kind, &version),
                "testedVersion": kind.tested_version(),
                "version": version,
            })
        }
        Err(err) => serde_json::json!({ "available": false, "path": program.to_string_lossy(), "error": err.0 }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn split_messages_uses_single_turn_as_is_and_joins_system() {
        let (system, prompt) = split_messages(&[
            json!({ "role": "system", "content": "A" }),
            json!({ "role": "system", "content": "B" }),
            json!({ "role": "user", "content": "質問" }),
        ]);
        assert_eq!(system, "A\n\nB");
        assert_eq!(prompt, "質問");
    }

    #[test]
    fn split_messages_labels_multiple_turns_and_defaults_system() {
        let (system, prompt) = split_messages(&[
            json!({ "role": "user", "content": "こんにちは" }),
            json!({ "role": "assistant", "content": "どうぞ" }),
            json!({ "role": "user", "content": "予定は？" }),
        ]);
        assert_eq!(system, DEFAULT_SYSTEM_PROMPT);
        assert_eq!(prompt, "[ユーザー]\nこんにちは\n\n[アシスタント]\nどうぞ\n\n[ユーザー]\n予定は？");
    }

    #[test]
    fn claude_args_disable_tools_settings_and_mcp() {
        let args = claude_args("sys", "haiku", "high", Some(&json!({ "type": "object" })), None);
        let joined = args.join(" ");
        assert!(args.windows(2).any(|w| w[0] == "--tools" && w[1].is_empty()));
        assert!(args.windows(2).any(|w| w[0] == "--setting-sources" && w[1].is_empty()));
        assert!(joined.contains("--strict-mcp-config"));
        assert!(joined.contains("--no-session-persistence"));
        assert!(args.windows(2).any(|w| w[0] == "--system-prompt" && w[1] == "sys"));
        assert!(args.windows(2).any(|w| w[0] == "--model" && w[1] == "haiku"));
        assert!(args.windows(2).any(|w| w[0] == "--json-schema" && w[1] == r#"{"type":"object"}"#));
        assert!(args.windows(2).any(|w| w[0] == "--effort" && w[1] == "high"));
        let defaults = claude_args("sys", "", "", None, None);
        assert!(!defaults.contains(&"--model".to_string()));
        assert!(!defaults.contains(&"--effort".to_string()));
        // 対応していない effort は渡さない(Codex用の値など)。
        assert!(!claude_args("sys", "", "minimal", None, None).contains(&"--effort".to_string()));
        assert!(!defaults.contains(&"--mcp-config".to_string()));

        let agent = claude_args("sys", "", "", None, Some("http://127.0.0.1:1/mcp/s?token=t"));
        let config_idx = agent.iter().position(|a| a == "--mcp-config").unwrap();
        let config: Value = serde_json::from_str(&agent[config_idx + 1]).unwrap();
        assert_eq!(config["mcpServers"]["taskcalendar"]["url"], "http://127.0.0.1:1/mcp/s?token=t");
        assert!(agent.windows(2).any(|w| w[0] == "--allowedTools" && w[1] == "mcp__taskcalendar"));
        assert!(agent.windows(2).any(|w| w[0] == "--tools" && w[1].is_empty()), "組み込みツールは無効のまま");
    }

    #[test]
    fn parse_claude_output_prefers_structured_output() {
        let reply = parse_claude_output(
            r#"{"type":"result","is_error":false,"result":"{\"a\":1}","structured_output":{"a":1},"modelUsage":{"claude-haiku-4-5":{}}}"#,
        )
        .unwrap();
        assert_eq!(reply.content, r#"{"a":1}"#);
        assert_eq!(reply.model, "claude-haiku-4-5");

        let plain = parse_claude_output(r#"{"is_error":false,"result":" こんにちは "}"#).unwrap();
        assert_eq!(plain.content, "こんにちは");
    }

    #[test]
    fn parse_claude_output_reports_errors() {
        let err = parse_claude_output(r#"{"is_error":true,"result":"Not logged in"}"#).err().unwrap();
        assert!(err.0.contains("Not logged in"));
        assert!(parse_claude_output("not json").is_err());
    }

    #[test]
    fn codex_args_read_only_ephemeral_and_stdin() {
        let args = codex_args(Path::new("W"), Path::new("O"), "", "", Some(Path::new("S")), None);
        assert_eq!(args.first().map(String::as_str), Some("exec"));
        assert_eq!(args.last().map(String::as_str), Some("-"));
        assert!(args.windows(2).any(|w| w[0] == "--sandbox" && w[1] == "read-only"));
        assert!(args.windows(2).any(|w| w[0] == "--output-schema" && w[1] == "S"));
        assert!(args.windows(2).any(|w| w[0] == "-o" && w[1] == "O"));
        for flag in ["--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"] {
            assert!(args.iter().any(|a| a == flag), "{flag}");
        }
        assert!(!args.iter().any(|a| a == "-m"));
        assert!(!args.iter().any(|a| a == "-c"));

        let tuned = codex_args(Path::new("W"), Path::new("O"), "gpt-x", "low", None, Some("http://h/mcp/s?token=t"));
        assert!(tuned.windows(2).any(|w| w[0] == "-c" && w[1] == "mcp_servers.taskcalendar.url=\"http://h/mcp/s?token=t\""));
        assert!(tuned.windows(2).any(|w| w[0] == "-c" && w[1] == "mcp_servers.taskcalendar.default_tools_approval_mode=\"approve\""));
        assert!(tuned.windows(2).any(|w| w[0] == "-m" && w[1] == "gpt-x"));
        assert!(tuned.windows(2).any(|w| w[0] == "-c" && w[1] == "model_reasoning_effort=low"));
        assert!(!codex_args(Path::new("W"), Path::new("O"), "", "max", None, None).iter().any(|a| a == "-c"));
    }

    #[test]
    fn strict_schema_requires_all_and_makes_optional_nullable() {
        let schema = json!({
            "type": "object",
            "properties": {
                "intent": { "type": "string", "enum": ["a", "b"] },
                "title": { "type": "string" },
                "kind": { "type": "string", "enum": ["x", "y"] },
                "args": { "type": "object", "properties": { "n": { "type": "integer" } } },
                "tags": { "type": "array", "items": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] } }
            },
            "required": ["intent", "tags"]
        });
        let strict = to_strict_schema(&schema);
        assert_eq!(strict["additionalProperties"], false);
        let required: Vec<&str> = strict["required"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(required.len(), 5);
        // 元から必須の項目はそのまま、任意だった項目は null を許す。
        assert_eq!(strict["properties"]["intent"]["type"], "string");
        assert_eq!(strict["properties"]["title"]["type"], json!(["string", "null"]));
        assert_eq!(strict["properties"]["kind"]["enum"], json!(["x", "y", null]));
        // 入れ子のオブジェクトと配列の要素も厳格にする。
        assert_eq!(strict["properties"]["args"]["additionalProperties"], false);
        assert_eq!(strict["properties"]["args"]["required"], json!(["n"]));
        assert_eq!(strict["properties"]["args"]["properties"]["n"]["type"], json!(["integer", "null"]));
        assert_eq!(strict["properties"]["tags"]["items"]["additionalProperties"], false);
        assert_eq!(strict["properties"]["tags"]["items"]["properties"]["name"]["type"], "string");
    }

    #[test]
    fn parse_codex_model_reads_header_line() {
        let stderr = "OpenAI Codex v0.156.1\n--------\nworkdir: C:\\x\nmodel: gpt-6-astra\nprovider: openai\n";
        assert_eq!(parse_codex_model(stderr).as_deref(), Some("gpt-6-astra"));
        assert_eq!(parse_codex_model("no header"), None);
    }

    #[test]
    fn version_parsing_and_comparison() {
        assert_eq!(parse_version("2.1.258 (Claude Code)"), Some((2, 1, 258)));
        assert_eq!(parse_version("codex-cli 0.40.0"), Some((0, 40, 0)));
        assert_eq!(parse_version("unknown"), None);
        assert!(is_older_than_tested(CliKind::ClaudeCode, "2.0.9 (Claude Code)"));
        assert!(!is_older_than_tested(CliKind::ClaudeCode, "2.1.258 (Claude Code)"));
        assert!(!is_older_than_tested(CliKind::ClaudeCode, "10.0.0 (Claude Code)"));
        assert!(is_older_than_tested(CliKind::Codex, "codex-cli 0.100.0"));
        assert!(!is_older_than_tested(CliKind::Codex, "codex-cli 0.156.1"));
    }

    #[test]
    fn resolve_program_uses_override() {
        assert_eq!(
            resolve_program(CliKind::Codex, Some(Path::new("C:/x/codex.exe"))),
            Some(PathBuf::from("C:/x/codex.exe"))
        );
    }
}
