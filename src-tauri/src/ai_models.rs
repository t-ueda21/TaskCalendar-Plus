//! CLIのモデル情報だけを取得する。会話・推論・MCPセッションは開始しない。
use crate::ai_cli::{CliError, CliKind, RequestDir, resolve_program};
use serde::Serialize;
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

const TIMEOUT: Duration = Duration::from_secs(25);
type Lines = tokio::io::Lines<BufReader<tokio::io::Take<ChildStdout>>>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    id: String,
    label: String,
    is_default: bool,
}

fn normalize(kind: CliKind, rows: &Value) -> Result<Vec<ModelChoice>, CliError> {
    let rows = rows.as_array().ok_or_else(|| {
        CliError("モデル一覧の形式を読み取れませんでした。CLIを更新してください".into())
    })?;
    let mut seen = HashSet::new();
    let models: Vec<_> = rows
        .iter()
        .filter_map(|row| {
            if row.get("hidden").and_then(Value::as_bool) == Some(true) {
                return None;
            }
            let key = if kind == CliKind::Codex {
                "model"
            } else {
                "value"
            };
            let id = row.get(key)?.as_str()?.trim();
            if id.is_empty() || !seen.insert(id.to_string()) {
                return None;
            }
            let label = row
                .get("displayName")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(id);
            Some(ModelChoice {
                id: id.into(),
                label: label.into(),
                is_default: row
                    .get("isDefault")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect();
    if models.is_empty() {
        return Err(CliError(
            "モデル候補がありません。CLIのログイン状態を確認して再取得してください".into(),
        ));
    }
    Ok(models)
}

async fn write(stdin: &mut ChildStdin, message: Value) -> Result<(), CliError> {
    stdin
        .write_all(format!("{message}\n").as_bytes())
        .await
        .map_err(|e| CliError(format!("モデル一覧を要求できませんでした: {e}")))
}

async fn response(lines: &mut Lines, kind: CliKind, id: Value) -> Result<Value, CliError> {
    for _ in 0..256 {
        let line = lines.next_line().await.map_err(|e| CliError(e.to_string()))?
            .ok_or_else(|| CliError("モデル一覧の応答前にCLIが終了しました。CLIのバージョンとログイン状態を確認してください".into()))?;
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if kind == CliKind::Codex && message.get("id") == Some(&id) {
            if let Some(error) = message.get("error") {
                return Err(CliError(format!(
                    "モデル一覧を取得できませんでした: {}",
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("CLIエラー")
                )));
            }
            return message
                .get("result")
                .cloned()
                .ok_or_else(|| CliError("モデル一覧の応答が不正です".into()));
        }
        if kind == CliKind::ClaudeCode
            && message["type"] == "control_response"
            && message["response"]["request_id"] == id
        {
            let reply = &message["response"];
            if reply["subtype"] != "success" {
                return Err(CliError(format!(
                    "モデル一覧を取得できませんでした: {}",
                    reply["error"].as_str().unwrap_or("CLIエラー")
                )));
            }
            return reply
                .get("response")
                .cloned()
                .ok_or_else(|| CliError("モデル一覧の応答が不正です".into()));
        }
    }
    Err(CliError(
        "モデル一覧の応答が多すぎるため中止しました".into(),
    ))
}

async fn exchange(
    stdin: &mut ChildStdin,
    lines: &mut Lines,
    kind: CliKind,
) -> Result<Vec<ModelChoice>, CliError> {
    if kind == CliKind::ClaudeCode {
        write(stdin, json!({"type":"control_request","request_id":"models-init","request":{"subtype":"initialize","hooks":{}}})).await?;
        let result = response(lines, kind, json!("models-init")).await?;
        return normalize(kind, &result["models"]);
    }
    write(stdin, json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"taskcalendar_plus","title":"TaskCalendar+","version":env!("CARGO_PKG_VERSION")}}})).await?;
    response(lines, kind, json!(1)).await?;
    write(stdin, json!({"method":"initialized"})).await?;
    write(
        stdin,
        json!({"id":2,"method":"config/read","params":{"includeLayers":false}}),
    )
    .await?;
    let config = response(lines, kind, json!(2)).await?;
    validate_codex_config(&config["config"])?;
    let mut all = Vec::new();
    let mut cursor = Value::Null;
    let mut cursors = HashSet::new();
    for id in 3..13 {
        write(stdin, json!({"id":id,"method":"model/list","params":{"limit":100,"includeHidden":false,"cursor":cursor}})).await?;
        let result = response(lines, kind, json!(id)).await?;
        let rows = result["data"]
            .as_array()
            .ok_or_else(|| CliError("モデル一覧の形式が不正です".into()))?;
        all.extend(rows.iter().cloned());
        cursor = result.get("nextCursor").cloned().unwrap_or(Value::Null);
        if cursor.is_null() {
            return normalize(kind, &Value::Array(all));
        }
        if !cursor.is_string() || !cursors.insert(cursor.to_string()) {
            return Err(CliError("モデル一覧の続きが不正です".into()));
        }
    }
    Err(CliError("モデル一覧のページ数が上限を超えました".into()))
}

fn validate_codex_config(config: &Value) -> Result<(), CliError> {
    // execは--ignore-user-configを使うがapp-serverには相当するオプションがない。
    // 別プロバイダー・カタログ・接続先の候補を、実行できる候補として表示しない。
    if !config.is_object() {
        return Err(CliError("Codexの接続設定を確認できませんでした".into()));
    }
    let provider = config["model_provider"].as_str().unwrap_or("openai");
    let customized = provider != "openai"
        || !config["model_catalog_json"].is_null()
        || !config["model_providers"]["openai"].is_null()
        || !config["openai_base_url"].is_null();
    if customized {
        return Err(CliError("Codexに独自のモデル・接続設定があります。このアプリは標準のOpenAI接続で実行するため、自動取得は利用できません".into()));
    }
    Ok(())
}

// npm版CLIのcmdラッパーも含め、取得用に起動したプロセスだけを終了する。
async fn stop(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    #[cfg(windows)]
    if let Some(id) = child.id() {
        let mut kill = Command::new("taskkill.exe");
        kill.args(["/PID", &id.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let _ = tokio::time::timeout(Duration::from_secs(3), kill.status()).await;
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

pub async fn discover(
    kind: CliKind,
    program_override: Option<&Path>,
) -> Result<Vec<ModelChoice>, CliError> {
    discover_with_timeout(kind, program_override, TIMEOUT).await
}

async fn discover_with_timeout(
    kind: CliKind,
    program_override: Option<&Path>,
    timeout: Duration,
) -> Result<Vec<ModelChoice>, CliError> {
    let program = resolve_program(kind, program_override)
        .filter(|p| p.is_file())
        .ok_or_else(|| {
            CliError(format!(
                "{}が見つかりません。インストール先とPATHを確認してください",
                kind.label()
            ))
        })?;
    let dir = RequestDir::create()?;
    let mut command = Command::new(program);
    match kind {
        // App-serverではユーザーの認証・プロバイダー設定を使う。スレッドは作らない。
        CliKind::Codex => {
            command.args(["app-server", "--listen", "stdio://"]);
        }
        CliKind::ClaudeCode => {
            command.args([
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--no-session-persistence",
                "--strict-mcp-config",
                "--setting-sources",
                "",
                "--tools",
                "",
            ]);
        }
    }
    command
        .current_dir(&dir.0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .env_remove("CLAUDECODE")
        .env_remove("CLAUDE_CODE_ENTRYPOINT");
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command
        .spawn()
        .map_err(|e| CliError(format!("{}を起動できませんでした: {e}", kind.label())))?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let mut lines = BufReader::new(
        child
            .stdout
            .take()
            .expect("piped stdout")
            .take(2 * 1024 * 1024),
    )
    .lines();
    let result = tokio::time::timeout(timeout, exchange(&mut stdin, &mut lines, kind)).await
        .unwrap_or_else(|_| Err(CliError(format!("モデル一覧を{}秒以内に取得できませんでした。ログイン状態を確認して再取得してください", timeout.as_secs()))));
    drop(stdin);
    drop(lines);
    stop(&mut child).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_choices_filter_hidden_duplicates_and_invalid_rows() {
        let rows = json!([
            {"model":"a","displayName":"Model A","isDefault":true},
            {"model":"a"}, {"model":"hidden","hidden":true}, {"model":""}, {}, {"model":"b"}
        ]);
        let models = normalize(CliKind::Codex, &rows).unwrap();
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(models[0].label, "Model A");
        assert!(models[0].is_default);
        assert_eq!(models[1].label, "b");
        let claude = normalize(
            CliKind::ClaudeCode,
            &json!([{"value":"sonnet","displayName":"Sonnet"}]),
        )
        .unwrap();
        assert_eq!(claude[0].id, "sonnet");
        assert!(normalize(CliKind::Codex, &json!([])).is_err());
        assert!(normalize(CliKind::Codex, &Value::Null).is_err());
    }

    #[test]
    fn custom_codex_provider_or_catalog_is_not_advertised_for_default_execution() {
        assert!(
            validate_codex_config(&json!({"model":"preferred", "model_provider":null})).is_ok()
        );
        assert!(validate_codex_config(&json!({"model_provider":"openai"})).is_ok());
        for config in [
            json!({"model_provider":"custom"}),
            json!({"model_catalog_json":"custom.json"}),
            json!({"model_providers":{"openai":{"base_url":"https://example.test"}}}),
            json!({"openai_base_url":"https://example.test"}),
            Value::Null,
        ] {
            assert!(validate_codex_config(&config).is_err());
        }
    }

    #[cfg(windows)]
    fn fixture(dir: &Path, script: &str) -> std::path::PathBuf {
        std::fs::write(dir.join("fixture.ps1"), script).unwrap();
        let path = dir.join("fixture.cmd");
        std::fs::write(&path, "@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0fixture.ps1\"\r\n").unwrap();
        path
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn codex_discovery_initializes_and_reads_all_pages_without_starting_a_thread() {
        let dir = tempfile::tempdir().unwrap();
        let program = fixture(
            dir.path(),
            r#"
$init = [Console]::ReadLine() | ConvertFrom-Json
if ($init.method -ne 'initialize') { exit 2 }
[Console]::WriteLine('{"id":1,"result":{}}')
$ready = [Console]::ReadLine() | ConvertFrom-Json
if ($ready.method -ne 'initialized') { exit 3 }
$config = [Console]::ReadLine() | ConvertFrom-Json
if ($config.method -ne 'config/read') { exit 6 }
[Console]::WriteLine('{"id":2,"result":{"config":{"model_provider":"openai"}}}')
$first = [Console]::ReadLine() | ConvertFrom-Json
if ($first.method -ne 'model/list' -or $first.params.includeHidden) { exit 4 }
[Console]::WriteLine('{"method":"unrelated/notification"}')
[Console]::WriteLine('{"id":3,"result":{"data":[{"model":"first","displayName":"First"}],"nextCursor":"page2"}}')
$next = [Console]::ReadLine() | ConvertFrom-Json
if ($next.method -ne 'model/list' -or $next.params.cursor -ne 'page2') { exit 5 }
[Console]::WriteLine('{"id":4,"result":{"data":[{"model":"second"}],"nextCursor":null}}')
[Console]::ReadLine() | Out-Null
"#,
        );
        let models = discover(CliKind::Codex, Some(&program)).await.unwrap();
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["first", "second"]
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn claude_discovery_reads_initialize_models_without_a_user_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let program = fixture(
            dir.path(),
            r#"
$init = [Console]::ReadLine() | ConvertFrom-Json
if ($init.type -ne 'control_request' -or $init.request.subtype -ne 'initialize') { exit 2 }
[Console]::WriteLine('{"type":"control_response","response":{"subtype":"success","request_id":"models-init","response":{"models":[{"value":"sonnet","displayName":"Sonnet"}]}}}')
[Console]::ReadLine() | Out-Null
"#,
        );
        let models = discover(CliKind::ClaudeCode, Some(&program)).await.unwrap();
        assert_eq!(models[0].id, "sonnet");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn discovery_reports_protocol_error_and_bounds_a_hung_cli() {
        let dir = tempfile::tempdir().unwrap();
        let program = fixture(
            dir.path(),
            r#"
[Console]::ReadLine() | Out-Null
[Console]::WriteLine('{"id":1,"error":{"message":"unsupported version"}}')
[Console]::ReadLine() | Out-Null
"#,
        );
        assert!(
            discover(CliKind::Codex, Some(&program))
                .await
                .unwrap_err()
                .0
                .contains("unsupported version")
        );
        let program = fixture(dir.path(), "Start-Sleep -Seconds 30");
        let start = std::time::Instant::now();
        let error =
            discover_with_timeout(CliKind::Codex, Some(&program), Duration::from_millis(200))
                .await
                .unwrap_err();
        assert!(error.0.contains("取得できませんでした"));
        assert!(start.elapsed() < Duration::from_secs(8));
    }
}
