//! OpenAI-compatible local model transport for Ollama and LM Studio.

use crate::{api::AppState, mcp};
use serde_json::{Value, json};
use std::time::Duration;

const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_ROUNDS: usize = 12;
const MAX_CALLS_PER_ROUND: usize = 8;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const CHAT_TIMEOUT: Duration = Duration::from_secs(170);

#[derive(Clone, Debug)]
pub struct LocalSettings {
    pub provider: String,
    pub endpoint: String,
    pub model: String,
}

impl LocalSettings {
    pub fn from_settings(settings: &Value) -> Option<Self> {
        let provider = settings.get("aiProvider")?.as_str()?;
        let (endpoint_key, model_key, default) = match provider {
            "ollama" => (
                "aiOllamaEndpoint",
                "aiOllamaModel",
                "http://localhost:11434/v1",
            ),
            "lmstudio" => (
                "aiLmStudioEndpoint",
                "aiLmStudioModel",
                "http://localhost:1234/v1",
            ),
            _ => return None,
        };
        Some(Self {
            provider: provider.into(),
            endpoint: settings
                .get(endpoint_key)
                .and_then(Value::as_str)
                .unwrap_or(default)
                .trim()
                .into(),
            model: settings
                .get(model_key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .into(),
        })
    }
}

fn normalize_endpoint(endpoint: &str) -> Result<String, String> {
    let mut url =
        reqwest::Url::parse(endpoint.trim()).map_err(|_| "接続先URLを確認してください")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "接続先はHTTP/HTTPSのURLにしてください。認証情報・クエリ・フラグメントは指定できません"
                .into(),
        );
    }
    let path = url.path().trim_end_matches('/');
    let path = if path.ends_with("/v1") {
        path.to_string()
    } else {
        format!("{path}/v1")
    };
    url.set_path(&path);
    Ok(url.to_string())
}

#[derive(Debug)]
struct TransportError {
    status: Option<u16>,
    message: String,
}

impl From<String> for TransportError {
    fn from(message: String) -> Self {
        Self {
            status: None,
            message,
        }
    }
}

struct LocalClient {
    client: reqwest::Client,
    base: String,
}

impl LocalClient {
    fn new(provider: &str, endpoint: &str) -> Result<Self, String> {
        if !matches!(provider, "ollama" | "lmstudio") {
            return Err("未対応のローカルAI接続先です".into());
        }
        let base = normalize_endpoint(endpoint)?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| "ローカルAIのHTTP接続を準備できませんでした")?;
        Ok(Self { client, base })
    }

    async fn request(&self, path: &str, body: Option<&Value>) -> Result<Value, TransportError> {
        let url = format!("{}{path}", self.base);
        let request = if let Some(body) = body {
            let bytes = serde_json::to_vec(body)
                .map_err(|_| "AIへの要求をJSON化できませんでした".to_string())?;
            if bytes.len() > MAX_BYTES {
                return Err("AIへの要求が大きすぎます。会話を短くしてください"
                    .to_string()
                    .into());
            }
            self.client
                .post(url)
                .header("Content-Type", "application/json")
                .body(bytes)
        } else {
            self.client.get(url).timeout(Duration::from_secs(25))
        };
        let mut response = request.send().await.map_err(|err| {
            let message = if err.is_timeout() {
                "ローカルAIが制限時間内に応答しませんでした。モデルの読み込み状態を確認してください"
            } else {
                "ローカルAIに接続できません。サーバーの起動と接続先URLを確認してください"
            };
            TransportError::from(message.to_string())
        })?;
        let status = response.status();
        if !status.is_success() {
            let message = match status.as_u16() {
                401 | 403 => "認証が必要なサーバーには未対応です。APIキー不要の接続先を指定してください".to_string(),
                404 => "APIまたはモデルが見つかりません。接続先URLとモデル名を確認してください (HTTP 404)".into(),
                400 | 422 => format!("モデルが要求形式に対応していません。モデル名・ツール呼び出し・JSON出力への対応を確認してください (HTTP {status})"),
                _ => format!("ローカルAIサーバーがエラーを返しました (HTTP {status})"),
            };
            return Err(TransportError {
                status: Some(status.as_u16()),
                message,
            });
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_BYTES as u64)
        {
            return Err("ローカルAIの応答が大きすぎます".to_string().into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "ローカルAIの応答を読み取れませんでした".to_string())?
        {
            if bytes.len() + chunk.len() > MAX_BYTES {
                return Err("ローカルAIの応答が大きすぎます".to_string().into());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| "ローカルAIが不正なJSONを返しました".to_string().into())
    }
}

pub async fn models(provider: &str, endpoint: &str) -> Result<Value, String> {
    let client = LocalClient::new(provider, endpoint)?;
    let value = client
        .request("/models", None)
        .await
        .map_err(|e| e.message)?;
    let rows = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or("モデル一覧の応答形式が不正です")?;
    let mut ids = Vec::new();
    for row in rows {
        let id = row
            .get("id")
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .ok_or("モデル一覧に不正なモデルIDがあります")?;
        ids.push(id);
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(json!({ "models": ids.into_iter().map(|id| json!({"id":id})).collect::<Vec<_>>() }))
}

fn request_body(
    model: &str,
    messages: &[Value],
    tools: Option<&Value>,
    format: Option<&Value>,
) -> Result<Value, String> {
    if model.trim().is_empty() {
        return Err("設定画面でローカルAIのモデルを選択または入力してください".into());
    }
    let mut body =
        json!({"model":model.trim(),"messages":messages,"stream":false,"max_tokens":4096});
    if let Some(tools) = tools {
        body["tools"] = tools.clone();
        body["tool_choice"] = json!("auto");
    }
    if let Some(format) = format {
        body["response_format"] = if format == "json" {
            json!({"type":"json_object"})
        } else if format.is_object() {
            json!({"type":"json_schema","json_schema":{"name":"response","schema":format}})
        } else {
            return Err("JSON出力形式の指定が不正です".into());
        };
    }
    Ok(body)
}

struct Completion {
    message: Value,
    content: String,
    calls: Vec<Value>,
    model: String,
}

fn completion(value: Value) -> Result<Completion, String> {
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|v| v.first())
        .ok_or("AI応答にchoicesがありません")?;
    if choice.get("finish_reason").and_then(Value::as_str) == Some("length") {
        return Err("AIの回答が長さの上限で途切れました。質問を短くしてください".into());
    }
    let message = choice
        .get("message")
        .filter(|v| v.is_object())
        .ok_or("AI応答にmessageがありません")?;
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return Err("AI応答のroleが不正です".into());
    }
    let content = match message.get("content") {
        Some(Value::String(content)) => content.trim().to_string(),
        None | Some(Value::Null) => String::new(),
        _ => return Err("AI応答の本文形式が不正です".into()),
    };
    let calls = match message.get("tool_calls") {
        Some(Value::Array(calls)) if calls.len() <= MAX_CALLS_PER_ROUND => calls.clone(),
        None | Some(Value::Null) => Vec::new(),
        _ => return Err("AIのツール呼び出し数または形式が不正です".into()),
    };
    if content.is_empty() && calls.is_empty() {
        return Err("AI response is empty".into());
    }
    Ok(Completion {
        message: message.clone(),
        content,
        calls,
        model: value
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
    })
}

fn parse_call(call: &Value) -> Result<(&str, &str, Value), String> {
    let id = call
        .get("id")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or("ツール呼び出しIDがありません")?;
    if call.get("type").and_then(Value::as_str) != Some("function") {
        return Err("ツール呼び出し形式が不正です".into());
    }
    let function = call.get("function").ok_or("ツール名がありません")?;
    let name = function
        .get("name")
        .and_then(Value::as_str)
        .ok_or("ツール名がありません")?;
    let args = match function.get("arguments") {
        Some(Value::String(args)) => {
            serde_json::from_str::<Value>(args).map_err(|_| "ツールの引数が不正なJSONです")?
        }
        Some(args) if args.is_object() => args.clone(),
        _ => return Err("ツールの引数が不正です".into()),
    };
    if !args.is_object() {
        return Err("ツールの引数はJSONオブジェクトが必要です".into());
    }
    Ok((id, name, args))
}

/// A synthetic tool roundtrip only. No task database or app settings enter the prompt.
pub async fn test_connection(provider: &str, endpoint: &str, model: &str) -> Result<Value, String> {
    let client = LocalClient::new(provider, endpoint)?;
    let future = async {
        let mut messages = vec![
            json!({"role":"user","content":"Call local_connection_probe once with nonce tcplus-check. After receiving its result, reply with the exact value of its result field."}),
        ];
        let tools = json!([{"type":"function","function":{"name":"local_connection_probe","description":"Synthetic connection check","parameters":{"type":"object","properties":{"nonce":{"type":"string"}},"required":["nonce"]}}}]);
        let body = request_body(model, &messages, Some(&tools), None)?;
        let first = match client.request("/chat/completions", Some(&body)).await {
            Ok(value) => completion(value)?,
            Err(err) if matches!(err.status, Some(400 | 422)) => {
                let basic = request_body(
                    model,
                    &[
                        json!({"role":"user","content":"Reply OK. This is a synthetic connection check."}),
                    ],
                    None,
                    None,
                )?;
                let reply = completion(
                    client
                        .request("/chat/completions", Some(&basic))
                        .await
                        .map_err(|e| e.message)?,
                )?;
                if !reply.calls.is_empty() {
                    return Err(
                        "ツールなしの接続テストで予期しないツール呼び出しが返りました".into(),
                    );
                }
                return Ok(probe_result(false));
            }
            Err(err) => return Err(err.message),
        };
        if first.calls.len() != 1 {
            return Ok(probe_result(false));
        }
        let (id, name, args) = parse_call(&first.calls[0])?;
        if name != "local_connection_probe" || args["nonce"] != "tcplus-check" {
            return Ok(probe_result(false));
        }
        let id = id.to_string();
        messages.push(first.message);
        messages.push(
            json!({"role":"tool","tool_call_id":id,"content":"{\"result\":\"TCPLUS_LOCAL_OK\"}"}),
        );
        let body = request_body(model, &messages, Some(&tools), None)?;
        let last = completion(
            client
                .request("/chat/completions", Some(&body))
                .await
                .map_err(|e| e.message)?,
        )?;
        Ok(probe_result(
            last.calls.is_empty() && last.content.contains("TCPLUS_LOCAL_OK"),
        ))
    };
    tokio::time::timeout(CHAT_TIMEOUT, future)
        .await
        .map_err(|_| "接続テストが時間切れになりました".to_string())?
}

fn probe_result(supported: bool) -> Value {
    json!({"ok":true,"toolsSupported":supported,"message":if supported { "接続とツール呼び出しを確認しました" } else { "接続できましたが、ツール呼び出しを確認できませんでした。AIモードにはツール対応モデルを選んでください" }})
}

/// Removing the session on Drop covers success, errors, timeout and dropped futures.
struct Session {
    id: String,
    store: mcp::ProposalStore,
}

impl Session {
    fn new(store: &mcp::ProposalStore) -> Self {
        let id = format!("local-{:032x}", rand::random::<u128>());
        store
            .lock()
            .expect("proposal store poisoned")
            .insert(id.clone(), Vec::new());
        Self {
            id,
            store: store.clone(),
        }
    }
    fn take(&self) -> Vec<Value> {
        self.store
            .lock()
            .expect("proposal store poisoned")
            .remove(&self.id)
            .unwrap_or_default()
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Ok(mut store) = self.store.lock() {
            store.remove(&self.id);
        }
    }
}

pub async fn chat(
    state: &AppState,
    settings: &LocalSettings,
    messages: Vec<Value>,
    format: Option<&Value>,
    agent: bool,
) -> Result<Value, String> {
    chat_with_timeout(state, settings, messages, format, agent, CHAT_TIMEOUT).await
}

async fn chat_with_timeout(
    state: &AppState,
    settings: &LocalSettings,
    mut messages: Vec<Value>,
    format: Option<&Value>,
    agent: bool,
    timeout: Duration,
) -> Result<Value, String> {
    let client = LocalClient::new(&settings.provider, &settings.endpoint)?;
    let session = agent.then(|| Session::new(&state.proposals));
    let today = chrono::Local::now().date_naive();
    let tools = if agent {
        if !messages.first().and_then(|m| m.get("content")).and_then(Value::as_str).is_some_and(|s| s.starts_with("# TaskCalendar+ application instructions")) {
            let config = {
                let conn = state.conn.lock().map_err(|_| "Database lock failed")?;
                crate::repositories::settings_get(&conn).map_err(|e| e.to_string())?.unwrap_or(Value::Null)
            };
            messages.insert(0, json!({"role":"system","content":crate::ai::build_system_instructions(today, &config, &state.os_locale, true)}));
        }
        Some(Value::Array(mcp::tool_definitions().as_array().expect("MCP definitions array").iter().map(|tool| {
            json!({"type":"function","function":{"name":tool["name"],"description":tool["description"],"parameters":tool["inputSchema"]}})
        }).collect()))
    } else {
        None
    };
    let future = async {
        for _ in 0..MAX_ROUNDS {
            let body = request_body(&settings.model, &messages, tools.as_ref(), format)?;
            let reply = completion(
                client
                    .request("/chat/completions", Some(&body))
                    .await
                    .map_err(|e| e.message)?,
            )?;
            if reply.calls.is_empty() {
                if format.is_some() {
                    serde_json::from_str::<Value>(&reply.content)
                        .map_err(|_| "AIが指定されたJSON形式で回答しませんでした")?;
                }
                let proposals = session.as_ref().map(Session::take).unwrap_or_default();
                return Ok(
                    json!({"provider":settings.provider,"model":if reply.model.is_empty() { &settings.model } else { &reply.model },"message":{"content":reply.content},"proposals":proposals}),
                );
            }
            let session = session
                .as_ref()
                .ok_or("ツールを許可していない要求でツール呼び出しが返りました")?;
            let mut ids = std::collections::HashSet::new();
            let calls = reply
                .calls
                .iter()
                .map(parse_call)
                .collect::<Result<Vec<_>, _>>()?;
            if calls.iter().any(|(id, _, _)| !ids.insert(*id)) {
                return Err("ツール呼び出しIDが重複しています".into());
            }
            messages.push(reply.message);
            for (id, name, args) in calls {
                // Never hold the DB mutex across an HTTP await. Same read/proposal-only executor as CLI MCP.
                let result = {
                    let conn = state
                        .conn
                        .lock()
                        .map_err(|_| "データベースのロックに失敗しました")?;
                    let ctx = mcp::McpContext {
                        conn: &conn,
                        today,
                        session: &session.id,
                        proposals: &state.proposals,
                    };
                    match mcp::call_tool(&ctx, name, &args) {
                        Ok(value) => value,
                        Err(error) => json!({"isError":true,"error":error}),
                    }
                };
                messages
                    .push(json!({"role":"tool","tool_call_id":id,"content":result.to_string()}));
            }
        }
        Err("AIのツール呼び出しが12回の上限に達しました。質問を分けてください".into())
    };
    tokio::time::timeout(timeout, future)
        .await
        .map_err(|_| "ローカルAIの処理が170秒の上限に達しました".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::Body,
        extract::State,
        http::{Request, StatusCode},
        response::IntoResponse,
    };
    use http_body_util::BodyExt;
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };
    use tower::ServiceExt;

    #[derive(Clone)]
    struct MockData {
        responses: Arc<Mutex<VecDeque<(StatusCode, String)>>>,
        requests: Arc<Mutex<Vec<Value>>>,
        delay: Duration,
    }
    struct MockServer {
        base: String,
        data: MockData,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for MockServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    impl MockServer {
        async fn start(responses: Vec<Value>) -> Self {
            Self::raw(
                responses
                    .into_iter()
                    .map(|v| (StatusCode::OK, v.to_string()))
                    .collect(),
                Duration::ZERO,
            )
            .await
        }
        async fn raw(responses: Vec<(StatusCode, String)>, delay: Duration) -> Self {
            async fn handle(
                State(data): State<MockData>,
                request: Request<Body>,
            ) -> axum::response::Response {
                let path = request.uri().path().to_string();
                let method = request.method().to_string();
                let bytes = request.into_body().collect().await.unwrap().to_bytes();
                let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                data.requests
                    .lock()
                    .unwrap()
                    .push(json!({"path":path,"method":method,"body":body}));
                tokio::time::sleep(data.delay).await;
                let (status, body) = data
                    .responses
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or((StatusCode::INTERNAL_SERVER_ERROR, "no mock response".into()));
                (status, [("content-type", "application/json")], body).into_response()
            }
            let data = MockData {
                responses: Arc::new(Mutex::new(responses.into())),
                requests: Default::default(),
                delay,
            };
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let app = Router::new().fallback(handle).with_state(data.clone());
            let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            Self { base, data, task }
        }
        fn requests(&self) -> Vec<Value> {
            self.data.requests.lock().unwrap().clone()
        }
    }

    fn answer(content: &str) -> Value {
        json!({"model":"mock-model","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":content}}]})
    }
    fn tool(name: &str, args: Value) -> Value {
        json!({"model":"mock-model","choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"call-1","type":"function","function":{"name":name,"arguments":args.to_string()}}]}}]})
    }
    fn state() -> AppState {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn, "2026-09").unwrap();
        AppState {
            os_locale: "ja-JP".into(),
            conn: Arc::new(Mutex::new(conn)),
            static_root: Default::default(),
            proposals: Default::default(),
            claude_command: None,
            codex_command: None,
            api_token: "test-token".into(),
        }
    }
    fn config(provider: &str, endpoint: &str) -> LocalSettings {
        LocalSettings {
            provider: provider.into(),
            endpoint: endpoint.into(),
            model: "mock-model".into(),
        }
    }
    async fn api(state: &AppState, path: &str, body: Value, token: &str) -> (StatusCode, Value) {
        let request = Request::builder()
            .method("POST")
            .uri(path)
            .header("host", "127.0.0.1")
            .header("content-type", "application/json")
            .header(crate::api::API_TOKEN_HEADER, token)
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = crate::api::build_router(state.clone())
            .oneshot(request)
            .await
            .unwrap();
        let status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&body).unwrap())
    }

    #[test]
    fn endpoint_normalization_preserves_explicit_base_and_rejects_secrets() {
        assert_eq!(
            normalize_endpoint(" http://localhost:11434/ ").unwrap(),
            "http://localhost:11434/v1"
        );
        assert_eq!(
            normalize_endpoint("http://localhost:1234/v1/").unwrap(),
            "http://localhost:1234/v1"
        );
        assert_eq!(
            normalize_endpoint("https://llm.example/prefix").unwrap(),
            "https://llm.example/prefix/v1"
        );
        for bad in [
            "file:///tmp/model",
            "http://user:pass@localhost",
            "http://localhost/?token=secret",
            "http://localhost/#fragment",
            "",
        ] {
            assert!(normalize_endpoint(bad).is_err(), "accepted {bad}");
        }
    }

    #[test]
    fn local_provider_settings_are_independent_from_cli_consent() {
        for (provider, endpoint_key, model_key, default) in [
            (
                "ollama",
                "aiOllamaEndpoint",
                "aiOllamaModel",
                "http://localhost:11434/v1",
            ),
            (
                "lmstudio",
                "aiLmStudioEndpoint",
                "aiLmStudioModel",
                "http://localhost:1234/v1",
            ),
        ] {
            let mut value = json!({"aiProvider":provider,"aiCliEnabled":false});
            assert_eq!(
                LocalSettings::from_settings(&value).unwrap().endpoint,
                default
            );
            value[endpoint_key] = json!(" http://localhost:9999/v1/ ");
            value[model_key] = json!(" model-name ");
            let settings = LocalSettings::from_settings(&value).unwrap();
            assert_eq!(settings.model, "model-name");
            assert_eq!(settings.endpoint, "http://localhost:9999/v1/");
        }
        assert!(LocalSettings::from_settings(&json!({"aiProvider":"codex"})).is_none());
    }

    #[tokio::test]
    async fn both_providers_discover_models_and_complete_synthetic_tool_roundtrip() {
        for provider in ["ollama", "lmstudio"] {
            let server = MockServer::start(vec![
                json!({"data":[{"id":"z"},{"id":"a"},{"id":"z"}]}),
                tool("local_connection_probe", json!({"nonce":"tcplus-check"})),
                answer("TCPLUS_LOCAL_OK"),
            ])
            .await;
            let state = state();
            let (status, found) = api(
                &state,
                "/api/ai/local/models",
                json!({"provider":provider,"endpoint":server.base}),
                "test-token",
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(found, json!({"models":[{"id":"a"},{"id":"z"}]}));
            let (status, tested) = api(
                &state,
                "/api/ai/local/test",
                json!({"provider":provider,"endpoint":server.base,"model":"mock-model"}),
                "test-token",
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(tested["ok"], true);
            assert_eq!(tested["toolsSupported"], true);
            let requests = server.requests();
            assert_eq!(requests[0]["path"], "/v1/models");
            assert_eq!(requests[1]["path"], "/v1/chat/completions");
            assert_eq!(
                requests[1]["body"]["tools"][0]["function"]["name"],
                "local_connection_probe"
            );
            assert_eq!(requests[2]["body"]["messages"][2]["role"], "tool");
            assert!(
                state.proposals.lock().unwrap().is_empty(),
                "probe never creates app tool sessions"
            );
            assert!(
                !serde_json::to_string(&requests)
                    .unwrap()
                    .contains("search_tasks"),
                "probe sends no app tools"
            );
        }
    }

    #[tokio::test]
    async fn text_only_and_rejected_tools_remain_connected_but_not_tool_capable() {
        let server = MockServer::start(vec![answer("OK")]).await;
        let result = test_connection("ollama", &server.base, "model")
            .await
            .unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(result["toolsSupported"], false);
        let server = MockServer::raw(
            vec![
                (StatusCode::BAD_REQUEST, "unsupported tools".into()),
                (StatusCode::OK, answer("OK").to_string()),
            ],
            Duration::ZERO,
        )
        .await;
        let result = test_connection("lmstudio", &server.base, "model")
            .await
            .unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(result["toolsSupported"], false);
        assert!(server.requests()[1]["body"].get("tools").is_none());
    }

    #[tokio::test]
    async fn agent_uses_shared_read_and_proposal_tools_without_mutating_tasks() {
        for provider in ["ollama", "lmstudio"] {
            let state = state();
            let server = MockServer::start(vec![tool("search_tasks", json!({"dateFrom":"2026-09-27","dateTo":"2026-09-27"})),tool("propose_create_task",json!({"date":"2026-09-27","startTime":"09:00","endTime":"10:00","title":"synthetic-only"})),answer("予定を提案しました。カードで確定してください。")]).await;
            let before = crate::repositories::tasks_list(&state.conn.lock().unwrap()).unwrap();
            let (endpoint_key, model_key) = if provider == "ollama" {
                ("aiOllamaEndpoint", "aiOllamaModel")
            } else {
                ("aiLmStudioEndpoint", "aiLmStudioModel")
            };
            let mut settings = json!({"aiProvider":provider,"aiCliEnabled":false});
            settings[endpoint_key] = json!(server.base);
            settings[model_key] = json!("mock-model");
            crate::repositories::settings_set(&state.conn.lock().unwrap(), &settings).unwrap();
            let (status, reply) = api(
                &state,
                "/api/ai/chat",
                json!({"agent":true,"messages":[{"role":"user","content":"synthetic request"}]}),
                "test-token",
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{reply}");
            assert_eq!(reply["provider"], provider);
            assert_eq!(reply["proposals"].as_array().unwrap().len(), 1);
            assert_eq!(
                serde_json::to_value(before).unwrap(),
                serde_json::to_value(
                    crate::repositories::tasks_list(&state.conn.lock().unwrap()).unwrap()
                )
                .unwrap()
            );
            assert!(state.proposals.lock().unwrap().is_empty());
            let requests = server.requests();
            assert_eq!(requests[1]["body"]["messages"][3]["role"], "tool");
            let tools = requests[0]["body"]["tools"].as_array().unwrap();
            assert_eq!(
                tools.len(),
                mcp::tool_definitions().as_array().unwrap().len()
            );
            assert!(
                tools
                    .iter()
                    .any(|v| v["function"]["name"] == "propose_delete_task")
            );
        }
    }

    #[tokio::test]
    async fn daily_json_schema_reaches_server_and_invalid_json_is_rejected() {
        let state = state();
        let schema = json!({"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]});
        for provider in ["ollama", "lmstudio"] {
            let server = MockServer::start(vec![
                answer("{\"summary\":\"synthetic day\"}"),
                answer("not json"),
            ])
            .await;
            let settings = config(provider, &server.base);
            let result = chat(
                &state,
                &settings,
                vec![json!({"role":"user","content":"JSON summary"})],
                Some(&schema),
                false,
            )
            .await
            .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(result["message"]["content"].as_str().unwrap())
                    .unwrap()["summary"],
                "synthetic day"
            );
            assert_eq!(
                server.requests()[0]["body"]["response_format"]["json_schema"]["schema"],
                schema
            );
            assert!(server.requests()[0]["body"].get("tools").is_none());
            assert!(
                chat(&state, &settings, vec![], Some(&schema), false)
                    .await
                    .unwrap_err()
                    .contains("JSON")
            );
        }
    }

    #[tokio::test]
    async fn malformed_reply_and_arguments_fail_with_session_cleanup() {
        let state = state();
        for bad in [
            json!({"choices":[]}),
            json!({"choices":[{"message":{"role":"assistant","content":null}}]}),
            {
                let mut value = tool("search_tasks", json!({}));
                value["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"] =
                    json!("{broken");
                value
            },
        ] {
            let server = MockServer::start(vec![bad]).await;
            assert!(
                chat(&state, &config("ollama", &server.base), vec![], None, true)
                    .await
                    .is_err()
            );
            assert!(state.proposals.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn unknown_tool_returns_error_to_model_and_round_limit_cleans_up() {
        let state = state();
        let server = MockServer::start(vec![
            tool("delete_all_tasks", json!({})),
            answer("未対応です"),
        ])
        .await;
        chat(&state, &config("ollama", &server.base), vec![], None, true)
            .await
            .unwrap();
        let requests = server.requests();
        let result = requests[1]["body"]["messages"][2]["content"]
            .as_str()
            .unwrap();
        assert!(result.contains("unknown tool"));
        assert_eq!(
            serde_json::from_str::<Value>(result).unwrap()["isError"],
            true
        );
        let server = MockServer::start(
            (0..MAX_ROUNDS)
                .map(|_| tool("get_context", json!({})))
                .collect(),
        )
        .await;
        assert!(
            chat(
                &state,
                &config("lmstudio", &server.base),
                vec![],
                None,
                true
            )
            .await
            .unwrap_err()
            .contains("12回")
        );
        assert_eq!(server.requests().len(), MAX_ROUNDS);
        assert!(state.proposals.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn http_errors_invalid_models_and_auth_guard_are_explicit() {
        for status in [
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::NOT_FOUND,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::FOUND,
        ] {
            let server = MockServer::raw(vec![(status, "failure".into())], Duration::ZERO).await;
            let error = models("ollama", &server.base).await.unwrap_err();
            if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
                assert!(error.contains("APIキー"));
            } else {
                assert!(error.contains("HTTP"));
            }
            assert_eq!(server.requests().len(), 1, "redirects must not be followed");
        }
        let server = MockServer::start(vec![json!({"models":[]}), json!({"data":[{}]})]).await;
        assert!(models("ollama", &server.base).await.is_err());
        assert!(models("lmstudio", &server.base).await.is_err());
        let state = state();
        let (status, _) = api(
            &state,
            "/api/ai/local/models",
            json!({"provider":"ollama","endpoint":server.base}),
            "wrong",
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(
            server.requests().len(),
            2,
            "auth guard must reject before network request"
        );
        assert!(
            chat(
                &state,
                &config("invalid", &server.base),
                vec![],
                None,
                false
            )
            .await
            .is_err()
        );
        assert!(request_body("", &[], None, None).is_err());
    }

    #[tokio::test]
    async fn timeout_and_dropped_future_remove_session_without_holding_db_lock() {
        let state = state();
        let server = MockServer::raw(
            vec![(StatusCode::OK, answer("late").to_string())],
            Duration::from_secs(30),
        )
        .await;
        assert!(
            chat_with_timeout(
                &state,
                &config("ollama", &server.base),
                vec![],
                None,
                true,
                Duration::from_millis(50)
            )
            .await
            .unwrap_err()
            .contains("上限")
        );
        assert!(state.proposals.lock().unwrap().is_empty());
        let cloned = state.clone();
        let settings = config("lmstudio", &server.base);
        let task = tokio::spawn(async move { chat(&cloned, &settings, vec![], None, true).await });
        tokio::time::timeout(Duration::from_secs(2), async {
            while server.requests().len() < 2 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            state.conn.try_lock().is_ok(),
            "network wait must not hold DB lock"
        );
        assert_eq!(state.proposals.lock().unwrap().len(), 1);
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(state.proposals.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn failed_chat_discards_pending_proposal_and_oversized_response() {
        let state = state();
        let server = MockServer::start(vec![
            tool(
                "propose_create_task",
                json!({"date":"2026-09-27","title":"synthetic","allDay":true}),
            ),
            json!({"choices":[]}),
        ])
        .await;
        assert!(
            chat(&state, &config("ollama", &server.base), vec![], None, true)
                .await
                .is_err()
        );
        assert!(state.proposals.lock().unwrap().is_empty());
        let requests = server.requests();
        assert!(
            requests[1]["body"]["messages"][2]["content"]
                .as_str()
                .unwrap()
                .contains("pending_user_confirmation")
        );
        let server = MockServer::raw(
            vec![(StatusCode::OK, "x".repeat(MAX_BYTES + 1))],
            Duration::ZERO,
        )
        .await;
        assert!(
            models("lmstudio", &server.base)
                .await
                .unwrap_err()
                .contains("大きすぎ")
        );
        let server =
            MockServer::raw(vec![(StatusCode::OK, "{broken".into())], Duration::ZERO).await;
        assert!(
            models("ollama", &server.base)
                .await
                .unwrap_err()
                .contains("不正なJSON")
        );
    }

    #[tokio::test]
    async fn disconnected_http_client_cancels_generation_and_removes_session() {
        use tokio::io::AsyncWriteExt;
        let state = state();
        let server = MockServer::raw(
            vec![(StatusCode::OK, answer("late").to_string())],
            Duration::from_secs(30),
        )
        .await;
        crate::repositories::settings_set(&state.conn.lock().unwrap(), &json!({"aiProvider":"ollama","aiOllamaEndpoint":server.base,"aiOllamaModel":"mock-model"})).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = crate::api::build_router(state.clone());
        let app_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut socket = tokio::net::TcpStream::connect(addr).await.unwrap();
        let body =
            r#"{"agent":true,"messages":[{"role":"user","content":"synthetic cancellation"}]}"#;
        socket.write_all(format!("POST /api/ai/chat HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nx-tcplus-token: test-token\r\nContent-Length: {}\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while server.requests().is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(state.proposals.lock().unwrap().len(), 1);
        drop(socket);
        let cancelled = tokio::time::timeout(Duration::from_secs(2), async {
            while !state.proposals.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        app_task.abort();
        assert!(
            cancelled.is_ok(),
            "HTTP disconnection must drop the generation future and proposal session"
        );
    }
}
