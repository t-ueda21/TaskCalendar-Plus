//! HTTPサーバー・ルーティング。
//!
//! 画面向けのREST API(タスク・タグ・設定・Outlook・AIなど)と、
//! 画面資材の静的配信を提供する。

use axum::{
    Router,
    body::Bytes,
    extract::{Path, Request, State},
    middleware::{self, Next},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Redirect, Response},
    routing::{get, put},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex};

use crate::repositories as repo;

#[derive(Clone)]
pub struct AppState {
    pub conn: Arc<Mutex<Connection>>,
    /// 静的配信のroot(`renderer/`)。配下の`assets/`を静的配信する。
    pub static_root: PathBuf,
    /// AIモードのチャットごとのMCPセッションと、そこで出された予定の提案。
    pub proposals: crate::mcp::ProposalStore,
    /// Claude Code / Codex の実行ファイル(未指定ならPATHから探す)。
    pub claude_command: Option<PathBuf>,
    pub codex_command: Option<PathBuf>,
    /// 起動ごとに生成する合言葉。`/api/` への要求は `X-TCPlus-Token` ヘッダーで示す必要がある。
    /// 画面へはHTTPではなくTauriコマンド(`get_api_token`)で渡す。
    pub api_token: String,
}

pub const API_TOKEN_HEADER: &str = "x-tcplus-token";

/// `Host` の値(`host[:port]`)がループバックかを判定する。DNSリバインディング対策。
fn is_loopback_authority(value: &str) -> bool {
    let host = match value.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => host,
        _ => value,
    };
    matches!(host, "127.0.0.1" | "localhost")
}

fn is_loopback_origin(origin: &str) -> bool {
    origin.strip_prefix("http://").is_some_and(is_loopback_authority)
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// ブラウザで開いた他のWebページや、DNSリバインディングからの要求を拒否する。
/// - すべての要求: `Host` がループバックであること、`Origin` があれば自分自身であること
/// - `/api/`: 合言葉ヘッダーが一致すること、POST/PUTは `Content-Type: application/json` であること
async fn request_guard(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    let host_ok = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(is_loopback_authority);
    if !host_ok {
        return json_err(StatusCode::FORBIDDEN, "forbidden host");
    }
    if let Some(origin) = headers.get(header::ORIGIN)
        && !origin.to_str().ok().is_some_and(is_loopback_origin)
    {
        return json_err(StatusCode::FORBIDDEN, "forbidden origin");
    }
    if request.uri().path().starts_with("/api/") {
        let token_ok = headers
            .get(API_TOKEN_HEADER)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|token| constant_time_eq(token, &state.api_token));
        if !token_ok {
            return json_err(StatusCode::UNAUTHORIZED, "missing or invalid API token");
        }
        if matches!(*request.method(), Method::POST | Method::PUT) {
            let is_json = headers
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.trim_start().to_ascii_lowercase().starts_with("application/json"));
            if !is_json {
                return json_err(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Content-Type must be application/json");
            }
        }
    }
    next.run(request).await
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/", get(root_redirect))
        .route("/favicon.ico", get(favicon))
        .route("/api/tasks", get(tasks_list).post(tasks_create))
        .route("/api/tasks/{id}/recurrence", axum::routing::post(tasks_expand_recurrence))
        .route(
            "/api/tasks/{id}",
            put(tasks_update).delete(tasks_delete),
        )
        .route("/api/tags", get(tags_list).post(tags_create))
        .route("/api/tags/{id}", put(tags_update).delete(tags_delete))
        .route("/api/settings", get(settings_get).put(settings_put))
        .route(
            "/api/ai-memory/{kind}/{date}",
            put(ai_memory_put_item).delete(ai_memory_delete_item),
        )
        .route("/api/ai-memory/{kind}", get(ai_memory_list_by_kind))
        .route(
            "/api/weather-cache/{location_key}",
            get(weather_cache_get).put(weather_cache_put),
        )
        .route("/api/runtime", get(runtime_info))
        .route("/api/outlook/auto-sync", axum::routing::post(outlook_auto_sync))
        .route("/api/ai/chat", axum::routing::post(ai_chat))
        .route(
            "/mcp/{session}",
            axum::routing::post(mcp_post).get(mcp_not_allowed).delete(mcp_not_allowed),
        )
        .route("/api/ai/detect", get(ai_detect))
        .route("/api/ai/models/{provider}", get(ai_models))
        .route("/api/backup", get(backup_get))
        .route("/api/restore", axum::routing::post(backup_restore))
        .fallback(fallback)
        .layer(middleware::from_fn_with_state(state.clone(), request_guard))
        .with_state(state)
}

fn json_ok(value: impl serde::Serialize) -> Response {
    axum::Json(value).into_response()
}

fn json_created(value: impl serde::Serialize) -> Response {
    (StatusCode::CREATED, axum::Json(value)).into_response()
}

/// 要求本文をJSONとして読む。読めなければ 400 の応答を返す。
fn parse_body<T: serde::de::DeserializeOwned>(body: &Bytes) -> Result<T, Box<Response>> {
    serde_json::from_slice(body)
        .map_err(|err| Box::new(json_err(StatusCode::BAD_REQUEST, format!("invalid JSON body: {err}"))))
}

fn json_err(status: StatusCode, message: impl Into<String>) -> Response {
    (status, axum::Json(json!({ "error": message.into() }))).into_response()
}

fn no_content() -> Response {
    StatusCode::NO_CONTENT.into_response()
}

fn lock_conn(state: &AppState) -> std::sync::MutexGuard<'_, Connection> {
    state.conn.lock().expect("db mutex poisoned")
}

async fn root_redirect() -> Response {
    Redirect::temporary("/assets/app.html").into_response()
}

async fn favicon() -> Response {
    StatusCode::NO_CONTENT.into_response()
}

// --- tasks -------------------------------------------------------------

async fn tasks_list(State(state): State<AppState>) -> Response {
    let conn = lock_conn(&state);
    match repo::tasks_list(&conn) {
        Ok(rows) => json_ok(rows),
        Err(err) => json_err(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

async fn tasks_create(State(state): State<AppState>, body: Bytes) -> Response {
    let input: repo::TaskInsertInput = match parse_body(&body) {
        Ok(v) => v,
        Err(response) => return *response,
    };
    let conn = lock_conn(&state);
    match repo::tasks_insert(&conn, input) {
        Ok(row) => json_created(row),
        Err(err) => json_err(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

async fn tasks_update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let input: repo::TaskUpdateInput = match parse_body(&body) {
        Ok(v) => v,
        Err(response) => return *response,
    };
    let conn = lock_conn(&state);
    match repo::tasks_update(&conn, &id, input) {
        Ok(Some(row)) => json_ok(row),
        Ok(None) => json_err(StatusCode::NOT_FOUND, "Task not found"),
        Err(err) => json_err(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[derive(serde::Deserialize)]
struct RecurringTaskUpdate {
    #[serde(rename = "expectedUpdatedAt")]
    expected_updated_at: String,
    task: repo::TaskUpdateInput,
    occurrences: Vec<repo::TaskInsertInput>,
}

async fn tasks_expand_recurrence(State(state): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    let input: RecurringTaskUpdate = match parse_body(&body) {
        Ok(v) => v,
        Err(response) => return *response,
    };
    if input.occurrences.len() > 4999 {
        return json_err(StatusCode::BAD_REQUEST, "繰り返し予定は5000件までです");
    }
    let conn = lock_conn(&state);
    match repo::tasks_update_with_occurrences(&conn, &id, &input.expected_updated_at, input.task, input.occurrences) {
        Ok(repo::RecurringTaskUpdateResult::Updated(rows)) => json_ok(rows),
        Ok(repo::RecurringTaskUpdateResult::NotFound) => json_err(StatusCode::NOT_FOUND, "Task not found"),
        Ok(repo::RecurringTaskUpdateResult::Conflict) => json_err(StatusCode::CONFLICT, "予定が変更されています。開き直してから保存してください"),
        Err(err) => json_err(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

async fn tasks_delete(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let conn = lock_conn(&state);
    match repo::tasks_remove(&conn, &id) {
        Ok(()) => no_content(),
        Err(err) => json_err(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

// --- tags ----------------------------------------------------------------

async fn tags_list(State(state): State<AppState>) -> Response {
    let conn = lock_conn(&state);
    match repo::tags_list(&conn) {
        Ok(rows) => json_ok(rows),
        Err(err) => json_err(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

async fn tags_create(State(state): State<AppState>, body: Bytes) -> Response {
    let input: repo::TagInput = match parse_body(&body) {
        Ok(v) => v,
        Err(response) => return *response,
    };
    let conn = lock_conn(&state);
    match repo::tags_create(&conn, input) {
        Ok(tag) => json_created(tag),
        Err(err) => json_err(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

async fn tags_update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let input: repo::TagInput = match parse_body(&body) {
        Ok(v) => v,
        Err(response) => return *response,
    };
    let conn = lock_conn(&state);
    match repo::tags_update(&conn, &id, input) {
        Ok(tag) => json_ok(tag),
        Err(err) => json_err(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

/// 参照タスクは残りタグの先頭(タグ一覧取得順の1件目)へ再割当する。削除対象が最後の1件だった場合は
/// 参照タスクを「タグなし」(空文字列)にしてから削除する(既定タグが無いため、
/// タグ0件は正常な状態として扱う)。
async fn tags_delete(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let conn = lock_conn(&state);
    let remaining = match repo::tags_list(&conn) {
        Ok(rows) => rows.into_iter().filter(|t| t.id != id).collect::<Vec<_>>(),
        Err(err) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    };
    let fallback_id = remaining.first().map(|t| t.id.as_str()).unwrap_or("");
    if let Err(err) = repo::tags_remove(&conn, &id, fallback_id) {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }
    no_content()
}

// --- settings --------------------------------------------------------------

async fn settings_get(State(state): State<AppState>) -> Response {
    let conn = lock_conn(&state);
    match repo::settings_get(&conn) {
        Ok(Some(value)) => json_ok(value),
        Ok(None) => json_ok(json!({})),
        Err(err) => json_err(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

async fn settings_put(State(state): State<AppState>, body: Bytes) -> Response {
    let value: Value = match parse_body(&body) {
        Ok(v) => v,
        Err(response) => return *response,
    };
    let conn = lock_conn(&state);
    match repo::settings_set(&conn, &value) {
        Ok(()) => json_ok(value),
        Err(err) => json_err(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

// --- ai-memory ---------------------------------------------------------

fn invalid_ai_memory_kind(kind: &str) -> Response {
    json_err(StatusCode::NOT_FOUND, format!("unknown ai-memory kind: {kind}"))
}

async fn ai_memory_put_item(
    State(state): State<AppState>,
    Path((kind, date)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    if !repo::is_valid_ai_memory_kind(&kind) {
        return invalid_ai_memory_kind(&kind);
    }
    let value: Value = match parse_body(&body) {
        Ok(v) => v,
        Err(response) => return *response,
    };
    let conn = lock_conn(&state);
    match repo::ai_memory_set(&conn, &kind, &date, &value) {
        Ok(()) => json_ok(value),
        Err(err) => json_err(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

async fn ai_memory_delete_item(
    State(state): State<AppState>,
    Path((kind, date)): Path<(String, String)>,
) -> Response {
    if !repo::is_valid_ai_memory_kind(&kind) {
        return invalid_ai_memory_kind(&kind);
    }
    let conn = lock_conn(&state);
    match repo::ai_memory_remove(&conn, &kind, &date) {
        Ok(()) => no_content(),
        Err(err) => json_err(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

async fn ai_memory_list_by_kind(State(state): State<AppState>, Path(kind): Path<String>) -> Response {
    if !repo::is_valid_ai_memory_kind(&kind) {
        return invalid_ai_memory_kind(&kind);
    }
    let conn = lock_conn(&state);
    match repo::ai_memory_list_by_kind(&conn, &kind) {
        Ok(map) => json_ok(Value::Object(map)),
        Err(err) => json_err(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

// --- weather-cache -------------------------------------------------------

/// 場所キーのバリデーション(`/^[a-z0-9_-]+$/`に一致するもののみ許可)。
fn is_valid_location_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

async fn weather_cache_get(State(state): State<AppState>, Path(location_key): Path<String>) -> Response {
    if !is_valid_location_key(&location_key) {
        return json_err(StatusCode::NOT_FOUND, "GET /api/weather-cache not found");
    }
    let conn = lock_conn(&state);
    match repo::weather_cache_list_by_location(&conn, &location_key) {
        Ok(map) => json_ok(Value::Object(map)),
        Err(err) => json_err(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

async fn weather_cache_put(
    State(state): State<AppState>,
    Path(location_key): Path<String>,
    body: Bytes,
) -> Response {
    if !is_valid_location_key(&location_key) {
        return json_err(StatusCode::NOT_FOUND, "PUT /api/weather-cache not found");
    }
    let value: Value = match serde_json::from_slice(&body) {
        Ok(Value::Object(map)) => Value::Object(map),
        Ok(_) => return json_err(StatusCode::BAD_REQUEST, "body must be a JSON object"),
        Err(err) => return json_err(StatusCode::BAD_REQUEST, format!("invalid JSON body: {err}")),
    };
    let records = value.as_object().cloned().unwrap_or_default();
    let conn = lock_conn(&state);
    match repo::weather_cache_set_many(&conn, &location_key, &records) {
        Ok(()) => json_ok(value),
        Err(err) => json_err(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

// --- runtime / アプリアイコン ---------------------------------------------

fn app_icon_dir(static_root: &FsPath) -> PathBuf {
    static_root.join("assets").join("app-icon")
}

const APP_ICON_EXTENSIONS: [&str; 7] = [".ico", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];

pub fn list_app_icon_candidates(static_root: &FsPath) -> Vec<PathBuf> {
    let dir = app_icon_dir(static_root);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|name| {
            let lower = name.to_lowercase();
            APP_ICON_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
        })
        .collect();
    names.sort();
    let (mut ico, others): (Vec<_>, Vec<_>) = names
        .drain(..)
        .partition(|name| name.to_lowercase().ends_with(".ico"));
    ico.extend(others);
    ico.into_iter().map(|name| dir.join(name)).collect()
}

/// 画面の「説明」タブに表示するアプリのバージョン。
async fn runtime_info() -> Response {
    json_ok(json!({ "appVersion": env!("CARGO_PKG_VERSION") }))
}

// --- outlook -------------------------------------------------------------

/// Outlookの予定を取得し、タスクへ自動同期する。
/// Outlook COM呼び出しは`outlook::fetch_events`内の専用ワーカースレッドで行い、
/// このasyncハンドラ自体はブロックしない。
async fn outlook_auto_sync(State(state): State<AppState>) -> Response {
    let settings = {
        let conn = lock_conn(&state);
        match repo::settings_get(&conn) {
            Ok(v) => v.unwrap_or_else(|| json!({})),
            Err(err) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
        }
    };

    let calendar_name = settings
        .get("outlookSyncCalendarName")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Calendar".to_string());
    let tag_id = settings
        .get("outlookSyncTagId")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let days_ahead = settings
        .get("outlookSyncDaysAhead")
        .and_then(|v| v.as_i64())
        .unwrap_or(90)
        .clamp(1, 365);

    let snapshot = match crate::outlook::fetch_events(calendar_name, days_ahead).await {
        Ok(snapshot) => snapshot,
        Err(message) => return json_err(StatusCode::SERVICE_UNAVAILABLE, message),
    };

    let start_key = snapshot.range.start_key();
    let end_key = snapshot.range.end_key();

    let conn = lock_conn(&state);
    match repo::outlook_auto_sync(&conn, &snapshot.events, &tag_id, &start_key, &end_key) {
        Ok(result) => json_ok(json!({
            "success": true,
            "count": result.count,
            "added": result.added,
            "skipped": result.skipped,
            "deleted": result.deleted,
            "updated": result.updated,
        })),
        Err(err) => json_err(StatusCode::SERVICE_UNAVAILABLE, err.to_string()),
    }
}

// --- ai ---------------------------------------------------------------

/// AIを呼び出す。`agent: true` のときはAIモードのエージェントとして、アプリのMCPサーバー(`mcp.rs`)の
/// 道具を使わせる(チャットごとにセッションを発行し、終了後に、そのチャットで出た予定の提案を応答に付ける)。
/// `agent` が無いときは道具なしの1回の呼び出し(日次サマリーなど)。
async fn ai_chat(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let body: Value = match parse_body(&body) {
        Ok(v) => v,
        Err(response) => return *response,
    };
    let mut messages = body.get("messages").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let format = body.get("format").filter(|v| !v.is_null()).cloned();
    let agent = body.get("agent").and_then(|v| v.as_bool()).unwrap_or(false);
    let ai = {
        let conn = lock_conn(&state);
        let settings = repo::settings_get(&conn).ok().flatten().unwrap_or(Value::Null);
        crate::ai::AiSettings::from_settings(&settings)
    };
    let Some(kind) = ai.provider else {
        return json_err(
            StatusCode::SERVICE_UNAVAILABLE,
            "AIの接続先が設定されていません。設定画面の「AI」で「Claude Code / Codex と連携する」をオンにし、接続先を選んでください。",
        );
    };
    let program_override = match kind {
        crate::ai_cli::CliKind::ClaudeCode => state.claude_command.as_deref(),
        crate::ai_cli::CliKind::Codex => state.codex_command.as_deref(),
    };
    let (model, effort) = ai.model_and_effort(kind);

    // エージェント: セッションを発行し、MCPサーバーの接続先をCLIに渡す。接続先のホストは、
    // この要求が届いたホスト(127.0.0.1:ポート)をそのまま使う。
    let session = agent.then(|| format!("s-{:016x}", rand::random::<u64>()));
    let mcp_url = session.as_ref().map(|id| {
        let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("127.0.0.1");
        format!("http://{host}/mcp/{id}?token={}", state.api_token)
    });
    if let Some(id) = &session {
        state.proposals.lock().expect("proposal store poisoned").insert(id.clone(), Vec::new());
        messages.insert(0, json!({ "role": "system", "content": crate::ai::agent_system_prompt(chrono::Local::now().date_naive()) }));
    }

    let result = crate::ai_cli::chat(kind, program_override, model, effort, &messages, format.as_ref(), mcp_url.as_deref()).await;
    let proposals = session
        .as_ref()
        .and_then(|id| state.proposals.lock().expect("proposal store poisoned").remove(id))
        .unwrap_or_default();

    match result {
        Ok(reply) if !reply.content.is_empty() || !proposals.is_empty() => json_ok(json!({
            "provider": kind.provider_id(),
            "model": if reply.model.is_empty() { model.to_string() } else { reply.model },
            "message": { "content": reply.content },
            "proposals": proposals,
        })),
        Ok(_) => json_err(StatusCode::BAD_GATEWAY, "AI response is empty"),
        Err(err) => {
            // CLIの仕様変更が原因のことがあるため、調査しやすいようバージョンを添える。
            let version = crate::ai_cli::version(kind, program_override)
                .await
                .map(|v| format!("(バージョン: {v})"))
                .unwrap_or_default();
            json_err(
                StatusCode::SERVICE_UNAVAILABLE,
                format!("{}の呼び出しに失敗しました{version}: {}", kind.label(), err.0),
            )
        }
    }
}

/// AIエージェント向けMCPサーバーの窓口(Streamable HTTP、応答は application/json)。
/// 合言葉(token)が一致し、実行中のチャットのセッションだけを受け付ける。
async fn mcp_post(
    State(state): State<AppState>,
    Path(session): Path<String>,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
    body: Bytes,
) -> Response {
    if !query.get("token").is_some_and(|t| constant_time_eq(t, &state.api_token)) {
        return json_err(StatusCode::UNAUTHORIZED, "missing or invalid token");
    }
    if !state.proposals.lock().expect("proposal store poisoned").contains_key(&session) {
        return json_err(StatusCode::NOT_FOUND, "session not found");
    }
    let message: Value = match parse_body(&body) {
        Ok(v) => v,
        Err(response) => return *response,
    };
    let conn = lock_conn(&state);
    let ctx = crate::mcp::McpContext {
        conn: &conn,
        today: chrono::Local::now().date_naive(),
        session: &session,
        proposals: &state.proposals,
    };
    let responses: Vec<Value> = match &message {
        Value::Array(batch) => batch.iter().filter_map(|m| crate::mcp::handle_message(&ctx, m)).collect(),
        single => crate::mcp::handle_message(&ctx, single).into_iter().collect(),
    };
    match (message.is_array(), responses.len()) {
        (_, 0) => StatusCode::ACCEPTED.into_response(),
        (false, _) => json_ok(responses.into_iter().next()),
        (true, _) => json_ok(responses),
    }
}

async fn mcp_not_allowed() -> Response {
    StatusCode::METHOD_NOT_ALLOWED.into_response()
}

/// 設定画面の「検出」ボタン用。Claude Code / Codex のCLIが使えるかを返す。
async fn ai_detect(State(state): State<AppState>) -> Response {
    let (claude, codex) = tokio::join!(
        crate::ai_cli::detect(crate::ai_cli::CliKind::ClaudeCode, state.claude_command.as_deref()),
        crate::ai_cli::detect(crate::ai_cli::CliKind::Codex, state.codex_command.as_deref()),
    );
    json_ok(json!({ "claudeCode": claude, "codex": codex }))
}

async fn ai_models(State(state): State<AppState>, Path(provider): Path<String>) -> Response {
    use crate::ai_cli::CliKind;
    let (kind, program) = match provider.as_str() {
        "claude-code" => (CliKind::ClaudeCode, state.claude_command.as_deref()),
        "codex" => (CliKind::Codex, state.codex_command.as_deref()),
        _ => return json_err(StatusCode::BAD_REQUEST, "未対応のAI接続先です"),
    };
    match crate::ai_models::discover(kind, program).await {
        Ok(models) => json_ok(json!({ "models": models })),
        Err(err) => json_err(StatusCode::SERVICE_UNAVAILABLE, err.0),
    }
}

// --- 全データのバックアップ/復元 ---------------------------------------------

async fn backup_get(State(state): State<AppState>) -> Response {
    let conn = lock_conn(&state);
    match repo::backup_export(&conn) {
        Ok(value) => json_ok(value),
        Err(err) => json_err(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

async fn backup_restore(State(state): State<AppState>, body: Bytes) -> Response {
    let value: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(err) => return json_err(StatusCode::BAD_REQUEST, format!("JSONとして読み込めませんでした: {err}")),
    };
    let conn = lock_conn(&state);
    match repo::backup_restore(&conn, &value) {
        Ok(counts) => json_ok(counts),
        Err(repo::RestoreError::Invalid(message)) => json_err(StatusCode::BAD_REQUEST, message),
        Err(repo::RestoreError::Db(err)) => json_err(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

// --- 静的ファイル配信 / 未一致routeの404 -----------------------------------

const MIME_TYPES: &[(&str, &str)] = &[
    (".html", "text/html; charset=utf-8"),
    (".js", "text/javascript; charset=utf-8"),
    (".css", "text/css; charset=utf-8"),
    (".json", "application/json; charset=utf-8"),
    (".ico", "image/x-icon"),
    (".png", "image/png"),
    (".svg", "image/svg+xml"),
    (".jpg", "image/jpeg"),
    (".jpeg", "image/jpeg"),
    (".gif", "image/gif"),
    (".webp", "image/webp"),
];

fn mime_for(path: &FsPath) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_lowercase()));
    ext.as_deref()
        .and_then(|e| MIME_TYPES.iter().find(|(k, _)| *k == e))
        .map(|(_, v)| *v)
        .unwrap_or("application/octet-stream")
}

async fn serve_static(state: &AppState, url_path: &str) -> Response {
    // 先頭の `.`/`/`/`\` を除去し、root外へ出られないようにする。
    let trimmed = url_path.trim_start_matches(['.', '/', '\\']);
    let file_path = state.static_root.join(trimmed);
    let Ok(canonical_root) = state.static_root.canonicalize() else {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, "static root unavailable");
    };
    match tokio::fs::read(&file_path).await {
        Ok(data) => {
            let canonical_file = file_path.canonicalize().unwrap_or(file_path.clone());
            if !canonical_file.starts_with(&canonical_root) {
                return json_err(StatusCode::FORBIDDEN, "Forbidden");
            }
            let mut headers = HeaderMap::new();
            headers.insert(
                header::CONTENT_TYPE,
                mime_for(&file_path).parse().unwrap(),
            );
            (StatusCode::OK, headers, data).into_response()
        }
        Err(_) => json_err(StatusCode::NOT_FOUND, "Not found"),
    }
}

async fn fallback(State(state): State<AppState>, method: Method, uri: axum::http::Uri) -> Response {
    let path = uri.path();
    if let Some(api_path) = path.strip_prefix("/api") {
        return json_err(
            StatusCode::NOT_FOUND,
            format!("{method} /api{api_path} not found"),
        );
    }
    if method != Method::GET {
        return json_err(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
    }
    serve_static(&state, path).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    const TEST_TOKEN: &str = "test-token";
    const TEST_HOST: &str = "127.0.0.1:1234";

    fn test_state() -> (AppState, tempfile::TempDir) {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn, "2026-08").unwrap();
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("hello.txt"), b"hi").unwrap();
        let state = AppState {
            conn: Arc::new(Mutex::new(conn)),
            static_root: tmp.path().to_path_buf(),
            proposals: Default::default(),
            claude_command: None,
            codex_command: None,
            api_token: TEST_TOKEN.to_string(),
        };
        (state, tmp)
    }

    fn set_settings(state: &AppState, value: Value) {
        let conn = state.conn.lock().unwrap();
        repo::settings_set(&conn, &value).unwrap();
    }

    /// 固定のJSON/テキストを標準出力へ返すだけの偽CLI(Windowsのバッチファイル)を作る。
    #[cfg(windows)]
    fn write_mock_cli(dir: &std::path::Path, name: &str, stdout_line: &str) -> PathBuf {
        let path = dir.join(format!("{name}.cmd"));
        std::fs::write(&path, format!("@echo off
more > nul
echo {stdout_line}
")).unwrap();
        path
    }

    #[tokio::test]
    async fn ai_chat_returns_503_when_provider_is_not_configured() {
        let (state, _tmp) = test_state();
        let router = build_router(state);
        let (status, body) = send(&router, "POST", "/api/ai/chat", Some(json!({ "messages": [] }))).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(body["error"].as_str().unwrap().contains("接続先が設定されていません"));
    }

    #[tokio::test]
    async fn model_discovery_rejects_unknown_provider_and_reports_missing_cli() {
        let (mut state, tmp) = test_state();
        state.codex_command = Some(tmp.path().join("missing-codex.exe"));
        state.claude_command = Some(tmp.path().join("missing-claude.exe"));
        let router = build_router(state);
        let (status, _) = send(&router, "GET", "/api/ai/models/unknown", None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        for provider in ["codex", "claude-code"] {
            let (status, body) = send(&router, "GET", &format!("/api/ai/models/{provider}"), None).await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
            assert!(body["error"].as_str().is_some_and(|s| !s.is_empty()));
        }
    }

    #[tokio::test]
    async fn recurring_update_saves_original_and_occurrences_together() {
        let (state, _tmp) = test_state();
        let router = build_router(state);
        let original = json!({"id":"base","title":"終日予定","date":"2026-09-14","isAllDay":true});
        let (created_status, created) = send(&router, "POST", "/api/tasks", Some(original)).await;
        assert_eq!(created_status, StatusCode::CREATED);
        let recurrence = json!({"type":"daily","until":"2026-09-17","originDate":"2026-09-14","groupId":"series"});
        let occurrences = (15..=17).map(|day| json!({
            "id":format!("day-{day}"),"title":"終日予定","date":format!("2026-09-{day}"),"isAllDay":true,"recurrence":recurrence,
        })).collect::<Vec<_>>();
        let mut payload = json!({
            "expectedUpdatedAt":created["updatedAt"],
            "task":{"title":"終日予定","date":"2026-09-14","isAllDay":true,"recurrence":recurrence},"occurrences":occurrences,
        });
        let (status, rows) = send(&router, "POST", "/api/tasks/base/recurrence", Some(payload.clone())).await;
        assert_eq!(status, StatusCode::OK, "{rows}");
        assert_eq!(rows.as_array().unwrap().len(), 4);
        payload["occurrences"] = json!([{"id":"duplicate-day","title":"重複","date":"2026-09-15","isAllDay":true,"recurrence":recurrence}]);
        assert_eq!(send(&router, "POST", "/api/tasks/base/recurrence", Some(payload.clone())).await.0, StatusCode::CONFLICT);
        payload["expectedUpdatedAt"] = rows[0]["updatedAt"].clone();
        assert_eq!(send(&router, "POST", "/api/tasks/base/recurrence", Some(payload)).await.0, StatusCode::CONFLICT);
        let (_, persisted) = send(&router, "GET", "/api/tasks", None).await;
        let persisted = persisted.as_array().unwrap();
        assert_eq!(persisted.len(), 4);
        assert!(persisted.iter().all(|row| row["isAllDay"] == true && row["recurrence"]["groupId"] == "series"));
    }

    #[tokio::test]
    async fn recurring_update_rolls_back_when_an_occurrence_cannot_be_inserted() {
        let (state, _tmp) = test_state();
        let router = build_router(state);
        let (_, created) = send(&router, "POST", "/api/tasks", Some(json!({"id":"base","title":"元の予定","date":"2026-09-14","isAllDay":true}))).await;
        let (status, _) = send(&router, "POST", "/api/tasks/base/recurrence", Some(json!({
            "expectedUpdatedAt":created["updatedAt"],
            "task":{"title":"変更後","date":"2026-09-14","isAllDay":true,"recurrence":{"type":"daily"}},
            "occurrences":[
                {"id":"extra","title":"追加予定","date":"2026-09-15","isAllDay":true},
                {"id":"base","title":"重複ID","date":"2026-09-16","isAllDay":true}
            ],
        }))).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        let (_, rows) = send(&router, "GET", "/api/tasks", None).await;
        assert_eq!(rows.as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["title"], "元の予定");
        assert_eq!(rows[0]["recurrence"]["type"], "none");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn ai_chat_uses_claude_code_cli_when_selected() {
        let (mut state, tmp) = test_state();
        state.claude_command = Some(write_mock_cli(
            tmp.path(),
            "claude",
            r#"{"type":"result","is_error":false,"result":"x","structured_output":{"ok":true},"modelUsage":{"claude-mock":{}}}"#,
        ));
        set_settings(&state, json!({ "aiProvider": "claude-code", "aiCliEnabled": true }));
        let router = build_router(state);

        let (status, body) = send(
            &router,
            "POST",
            "/api/ai/chat",
            Some(json!({ "messages": [{ "role": "user", "content": "hi" }], "format": { "type": "object" } })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["provider"], "claude-code");
        assert_eq!(body["model"], "claude-mock");
        assert_eq!(body["message"]["content"], r#"{"ok":true}"#);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn ai_chat_reports_claude_code_error_result() {
        let (mut state, tmp) = test_state();
        state.claude_command = Some(write_mock_cli(tmp.path(), "claude", r#"{"is_error":true,"result":"Not logged in"}"#));
        set_settings(&state, json!({ "aiProvider": "claude-code", "aiCliEnabled": true }));
        let router = build_router(state);

        let (status, body) = send(&router, "POST", "/api/ai/chat", Some(json!({ "messages": [{ "role": "user", "content": "hi" }] }))).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        let error = body["error"].as_str().unwrap();
        assert!(error.starts_with("Claude Codeの呼び出しに失敗しました"), "{error}");
        // 偽CLIは --version にも同じ行を返すため、バージョン欄にその内容が入る。
        assert!(error.contains("バージョン:"), "{error}");
        assert!(error.contains("Not logged in"), "{error}");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn ai_chat_uses_codex_cli_output_when_selected() {
        let (mut state, tmp) = test_state();
        state.codex_command = Some(write_mock_cli(tmp.path(), "codex", "codex reply"));
        set_settings(&state, json!({ "aiProvider": "codex", "aiCliEnabled": true, "aiCodexModel": "gpt-mock" }));
        let router = build_router(state);

        let (status, body) = send(&router, "POST", "/api/ai/chat", Some(json!({ "messages": [{ "role": "user", "content": "hi" }] }))).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["provider"], "codex");
        assert_eq!(body["model"], "gpt-mock");
        assert_eq!(body["message"]["content"], "codex reply");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn ai_detect_reports_versions_and_missing_cli() {
        let (mut state, tmp) = test_state();
        state.claude_command = Some(write_mock_cli(tmp.path(), "claude", "9.9.9 (Claude Code)"));
        state.codex_command = Some(tmp.path().join("does-not-exist.cmd"));
        let router = build_router(state);

        let (status, body) = send(&router, "GET", "/api/ai/detect", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["claudeCode"]["available"], true);
        assert_eq!(body["claudeCode"]["version"], "9.9.9 (Claude Code)");
        assert_eq!(body["claudeCode"]["olderThanTested"], false);
        assert_eq!(body["claudeCode"]["testedVersion"], crate::ai_cli::TESTED_CLAUDE_CODE_VERSION);
        assert_eq!(body["codex"]["available"], false);
    }

    async fn mcp_send(router: &Router, uri: &str, body: Value) -> (StatusCode, Value) {
        let request = Request::builder()
            .method("POST")
            .uri(uri)
            .header("host", TEST_HOST)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    #[tokio::test]
    async fn mcp_endpoint_requires_token_and_active_session() {
        let (state, _tmp) = test_state();
        state.proposals.lock().unwrap().insert("s-test".into(), vec![]);
        let router = build_router(state.clone());
        let init = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} });

        let (status, _) = mcp_send(&router, "/mcp/s-test?token=wrong", init.clone()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = mcp_send(&router, &format!("/mcp/s-other?token={TEST_TOKEN}"), init.clone()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let base = format!("/mcp/s-test?token={TEST_TOKEN}");
        let (status, body) = mcp_send(&router, &base, init).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["result"]["serverInfo"]["name"], "taskcalendar");
        let (status, _) = mcp_send(&router, &base, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let (_, body) = mcp_send(&router, &base, json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await;
        assert!(body["result"]["tools"].as_array().unwrap().iter().any(|t| t["name"] == "month_status"));

        send(&router, "POST", "/api/tags", Some(json!({ "id": "g1", "name": "会議", "color": "#111111" }))).await;
        let call = json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "propose_create_task", "arguments": { "date": "2026-09-25", "startTime": "15:00", "title": "設計会議", "tagName": "会議" } } });
        let (_, body) = mcp_send(&router, &base, call).await;
        assert_eq!(body["result"]["isError"], false);
        assert_eq!(state.proposals.lock().unwrap()["s-test"].len(), 1);
    }

    async fn raw_status(router: &Router, request: Request<Body>) -> StatusCode {
        router.clone().oneshot(request).await.unwrap().status()
    }

    #[tokio::test]
    async fn guard_rejects_missing_or_wrong_token() {
        let (state, _tmp) = test_state();
        let router = build_router(state);
        let no_token = Request::builder().uri("/api/tasks").header("host", TEST_HOST).body(Body::empty()).unwrap();
        assert_eq!(raw_status(&router, no_token).await, StatusCode::UNAUTHORIZED);
        let wrong = Request::builder()
            .uri("/api/tasks")
            .header("host", TEST_HOST)
            .header(API_TOKEN_HEADER, "wrong-token")
            .body(Body::empty())
            .unwrap();
        assert_eq!(raw_status(&router, wrong).await, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn guard_rejects_foreign_host_and_origin_even_for_static_files() {
        let (state, _tmp) = test_state();
        let router = build_router(state);
        // DNSリバインディング: 攻撃者のドメイン名でループバックへ到達した要求。
        let rebinding = Request::builder()
            .uri("/hello.txt")
            .header("host", "evil.example:1234")
            .body(Body::empty())
            .unwrap();
        assert_eq!(raw_status(&router, rebinding).await, StatusCode::FORBIDDEN);
        let no_host = Request::builder().uri("/hello.txt").body(Body::empty()).unwrap();
        assert_eq!(raw_status(&router, no_host).await, StatusCode::FORBIDDEN);
        let cross_origin = Request::builder()
            .method("POST")
            .uri("/api/tags")
            .header("host", TEST_HOST)
            .header("origin", "https://evil.example")
            .header(API_TOKEN_HEADER, TEST_TOKEN)
            .header("content-type", "application/json")
            .body(Body::from(r##"{"name":"x","color":"#000000"}"##))
            .unwrap();
        assert_eq!(raw_status(&router, cross_origin).await, StatusCode::FORBIDDEN);
        let same_origin = Request::builder()
            .method("POST")
            .uri("/api/tags")
            .header("host", "localhost:1234")
            .header("origin", "http://localhost:1234")
            .header(API_TOKEN_HEADER, TEST_TOKEN)
            .header("content-type", "application/json")
            .body(Body::from(r##"{"id":"t","name":"x","color":"#000000"}"##))
            .unwrap();
        assert_eq!(raw_status(&router, same_origin).await, StatusCode::CREATED);
    }

    #[tokio::test]
    async fn guard_rejects_non_json_post() {
        let (state, _tmp) = test_state();
        let router = build_router(state);
        // text/plain はCORSのプリフライト無しで送れるため、JSON以外は受け付けない。
        let plain = Request::builder()
            .method("POST")
            .uri("/api/tags")
            .header("host", TEST_HOST)
            .header(API_TOKEN_HEADER, TEST_TOKEN)
            .header("content-type", "text/plain")
            .body(Body::from(r##"{"name":"x","color":"#000000"}"##))
            .unwrap();
        assert_eq!(raw_status(&router, plain).await, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    #[test]
    fn loopback_authority_parsing() {
        assert!(is_loopback_authority("127.0.0.1:5000"));
        assert!(is_loopback_authority("localhost"));
        assert!(!is_loopback_authority("127.0.0.1.evil.example"));
        assert!(!is_loopback_authority("evil.example:127"));
        assert!(!is_loopback_origin("https://127.0.0.1:5000"));
        assert!(is_loopback_origin("http://127.0.0.1:5000"));
    }

    async fn send(
        router: &Router,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .header("host", TEST_HOST)
            .header(API_TOKEN_HEADER, TEST_TOKEN)
            .header("content-type", "application/json")
            .body(match body {
                Some(v) => Body::from(v.to_string()),
                None => Body::empty(),
            })
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, value)
    }

    #[tokio::test]
    async fn tasks_crud_round_trip() {
        let (state, _tmp) = test_state();
        let router = build_router(state);

        let (status, body) = send(&router, "GET", "/api/tasks", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!([]));

        let (status, created) = send(
            &router,
            "POST",
            "/api/tasks",
            Some(json!({ "id": "t-1", "date": "2026-08-04", "title": "打合せ" })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(created["id"], "t-1");
        assert_eq!(created["title"], "打合せ");
        assert_eq!(created["tagId"], "");
        assert_eq!(created["isAllDay"], false);
        assert_eq!(created["recurrence"], json!({ "type": "none" }));

        let (_, list) = send(&router, "GET", "/api/tasks", None).await;
        assert_eq!(list.as_array().unwrap().len(), 1);

        // PUTは置換セマンティクス: titleを省略すると空文字になる。
        let (status, updated) = send(
            &router,
            "PUT",
            "/api/tasks/t-1",
            Some(json!({ "date": "2026-08-05" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(updated["title"], "");
        assert_eq!(updated["date"], "2026-08-05");

        let (status, _) = send(&router, "PUT", "/api/tasks/does-not-exist", Some(json!({}))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let (status, _) = send(&router, "DELETE", "/api/tasks/t-1", None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (_, list_after_delete) = send(&router, "GET", "/api/tasks", None).await;
        assert_eq!(list_after_delete.as_array().unwrap().len(), 0);
    }

    /// 手動確認で見つかった不具合の回帰テスト: 「タグなし」(空文字列)を明示的に
    /// 選択した場合、別のタグIDへ勝手に置き換わらないこと。
    #[tokio::test]
    async fn explicit_empty_tag_id_is_preserved_not_defaulted() {
        let (state, _tmp) = test_state();
        let router = build_router(state);

        let (status, created) = send(
            &router,
            "POST",
            "/api/tasks",
            Some(json!({ "id": "t-1", "date": "2026-08-04", "title": "予定", "tagId": "" })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(created["tagId"], "");

        // Outlookのドラッグでの時刻変更相当: PUTで他フィールドを更新してもtagIdは空文字のまま。
        let (status, updated) = send(
            &router,
            "PUT",
            "/api/tasks/t-1",
            Some(json!({ "title": "予定", "startTime": "10:00", "endTime": "11:00", "tagId": "" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(updated["tagId"], "", "タグなしのタスクを更新しても既定タグへ戻らないこと");
    }

    #[tokio::test]
    async fn tags_create_update_and_reassign_on_delete() {
        let (state, _tmp) = test_state();
        let router = build_router(state);

        // 既定タグは無いため、タグ0件の状態から開始。
        let (_, list) = send(&router, "GET", "/api/tags", None).await;
        assert_eq!(list.as_array().unwrap().len(), 0);

        let (status, base) = send(&router, "POST", "/api/tags", Some(json!({ "id": "tag-base", "name": "基本", "color": "#000000" }))).await;
        assert_eq!(status, StatusCode::CREATED);
        let base_tag_id = base["id"].as_str().unwrap().to_string();

        let (status, created) = send(
            &router,
            "POST",
            "/api/tags",
            Some(json!({ "id": "tag-new", "name": "新タグ", "color": "#111111" })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let new_tag_id = created["id"].as_str().unwrap().to_string();

        // UPDATEは実DBを再取得せず入力をそのまま返す。
        let (status, updated) = send(
            &router,
            "PUT",
            &format!("/api/tags/{new_tag_id}"),
            Some(json!({ "name": "改名後", "color": "#222222" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(updated["name"], "改名後");

        // タスクをこの新タグへ割り当ててから削除 → 残りタグ先頭へ再割当されることを確認。
        send(
            &router,
            "POST",
            "/api/tasks",
            Some(json!({ "id": "t-1", "date": "2026-08-04", "tagId": new_tag_id })),
        )
        .await;
        let (status, _) = send(&router, "DELETE", &format!("/api/tags/{new_tag_id}"), None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let (_, task_after) = send(&router, "GET", "/api/tasks", None).await;
        assert_eq!(task_after[0]["tagId"], base_tag_id.as_str());
    }

    #[tokio::test]
    async fn deleting_last_tag_removes_it_and_clears_task_tag() {
        let (state, _tmp) = test_state();
        let router = build_router(state);

        let (_, tag) = send(&router, "POST", "/api/tags", Some(json!({ "name": "唯一", "color": "#111111" }))).await;
        let tag_id = tag["id"].as_str().unwrap().to_string();
        send(
            &router,
            "PUT",
            "/api/settings",
            Some(json!({ "monthTagOrders": { "2026-08": [tag_id] }, "outlookSyncTagId": tag_id })),
        )
        .await;
        send(&router, "POST", "/api/tasks", Some(json!({ "id": "t-1", "date": "2026-08-04", "tagId": tag_id }))).await;

        let (status, _) = send(&router, "DELETE", &format!("/api/tags/{tag_id}"), None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let (_, tags_after) = send(&router, "GET", "/api/tags", None).await;
        assert_eq!(tags_after.as_array().unwrap().len(), 0);

        // 設定内の参照(月ごとのタグ順、Outlook取り込み先)からも取り除かれる。
        let (_, settings_after) = send(&router, "GET", "/api/settings", None).await;
        let order = settings_after["monthTagOrders"]["2026-08"].as_array().unwrap();
        assert!(!order.iter().any(|v| v == tag_id.as_str()));
        assert_eq!(settings_after["outlookSyncTagId"], "");
        let (_, tasks_after) = send(&router, "GET", "/api/tasks", None).await;
        assert_eq!(tasks_after[0]["tagId"], "");
    }

    #[tokio::test]
    async fn backup_round_trip_replaces_all_data() {
        let (state, _tmp) = test_state();
        let router = build_router(state);
        send(&router, "POST", "/api/tags", Some(json!({ "id": "tag-a", "name": "会議", "color": "#111111", "budgetMaxMinutes": 600 }))).await;
        send(&router, "POST", "/api/tasks", Some(json!({ "id": "t-1", "date": "2026-08-04", "title": "打合せ", "tagId": "tag-a", "memo": "メモ" }))).await;
        send(&router, "PUT", "/api/settings", Some(json!({ "workStart": "08:30" }))).await;
        send(&router, "PUT", "/api/ai-memory/summary/2026-08-04", Some(json!({ "summaryText": "要約" }))).await;

        let (status, backup) = send(&router, "GET", "/api/backup", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(backup["format"], repo::BACKUP_FORMAT);
        assert_eq!(backup["tasks"].as_array().unwrap().len(), 1);

        // 復元前にデータを変更・追加しておき、バックアップの内容に置き換わることを確認する。
        send(&router, "POST", "/api/tasks", Some(json!({ "id": "t-2", "date": "2026-08-05", "title": "後から追加" }))).await;
        send(&router, "PUT", "/api/settings", Some(json!({ "workStart": "10:00" }))).await;

        let (status, counts) = send(&router, "POST", "/api/restore", Some(backup.clone())).await;
        assert_eq!(status, StatusCode::OK, "{counts}");
        assert_eq!(counts, json!({ "tasks": 1, "tags": 1, "aiMemory": 1 }));

        let (_, tasks) = send(&router, "GET", "/api/tasks", None).await;
        assert_eq!(tasks.as_array().unwrap().len(), 1);
        assert_eq!(tasks[0]["memo"], "メモ");
        let (_, tags) = send(&router, "GET", "/api/tags", None).await;
        assert_eq!(tags[0]["budgetMaxMinutes"], 600);
        let (_, settings) = send(&router, "GET", "/api/settings", None).await;
        assert_eq!(settings["workStart"], "08:30");
        let (_, summaries) = send(&router, "GET", "/api/ai-memory/summary", None).await;
        assert_eq!(summaries["2026-08-04"]["summaryText"], "要約");
    }

    #[tokio::test]
    async fn restore_rejects_invalid_file_without_changing_data() {
        let (state, _tmp) = test_state();
        let router = build_router(state);
        send(&router, "POST", "/api/tasks", Some(json!({ "id": "t-1", "date": "2026-08-04" }))).await;

        let (status, body) = send(&router, "POST", "/api/restore", Some(json!({ "format": "other", "version": 1 }))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("バックアップファイルではありません"));

        // タスクの必須項目(date)が無い → 400、既存データはそのまま。
        let broken = json!({ "format": repo::BACKUP_FORMAT, "version": 1, "tasks": [{ "id": "x" }] });
        let (status, _) = send(&router, "POST", "/api/restore", Some(broken)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (_, tasks) = send(&router, "GET", "/api/tasks", None).await;
        assert_eq!(tasks.as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn tags_created_in_the_same_instant_get_distinct_ids() {
        let (state, _tmp) = test_state();
        let router = build_router(state);
        let (s1, a) = send(&router, "POST", "/api/tags", Some(json!({ "name": "A", "color": "#111111" }))).await;
        let (s2, b) = send(&router, "POST", "/api/tags", Some(json!({ "name": "B", "color": "#222222" }))).await;
        assert_eq!((s1, s2), (StatusCode::CREATED, StatusCode::CREATED));
        assert_ne!(a["id"], b["id"]);
    }

    #[tokio::test]
    async fn task_without_tag_id_field_is_saved_without_tag() {
        let (state, _tmp) = test_state();
        let router = build_router(state);

        let (status, created) = send(&router, "POST", "/api/tasks", Some(json!({ "id": "t-1", "date": "2026-08-04" }))).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(created["tagId"], "");
    }

    #[tokio::test]
    async fn settings_round_trip() {
        let (state, _tmp) = test_state();
        let router = build_router(state);

        let (status, initial) = send(&router, "GET", "/api/settings", None).await;
        assert_eq!(status, StatusCode::OK);
        // migrate()がmonthTagOrdersを初回シードしているため空オブジェクトではない。
        assert!(initial.get("monthTagOrders").is_some());

        let (status, saved) = send(
            &router,
            "PUT",
            "/api/settings",
            Some(json!({ "workStartTime": "09:00" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(saved["workStartTime"], "09:00");

        let (_, reloaded) = send(&router, "GET", "/api/settings", None).await;
        assert_eq!(reloaded["workStartTime"], "09:00");
    }

    #[tokio::test]
    async fn ai_memory_kind_whitelist_and_crud() {
        let (state, _tmp) = test_state();
        let router = build_router(state);

        let (status, _) = send(&router, "PUT", "/api/ai-memory/bogus/2026-08-04", Some(json!({}))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = send(&router, "GET", "/api/ai-memory/bogus", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let (status, saved) = send(
            &router,
            "PUT",
            "/api/ai-memory/summary/2026-08-04",
            Some(json!({ "text": "今日のまとめ" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(saved["text"], "今日のまとめ");

        let (_, by_kind) = send(&router, "GET", "/api/ai-memory/summary", None).await;
        assert_eq!(by_kind["2026-08-04"]["text"], "今日のまとめ");

        let (status, _) = send(&router, "DELETE", "/api/ai-memory/summary/2026-08-04", None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (_, after) = send(&router, "GET", "/api/ai-memory/summary", None).await;
        assert!(after.get("2026-08-04").is_none());
    }

    #[tokio::test]
    async fn weather_cache_round_trip_and_invalid_key() {
        let (state, _tmp) = test_state();
        let router = build_router(state);

        // 大文字は場所キーのバリデーション(`/^[a-z0-9_-]+$/`)で不一致。
        let (status, _) = send(&router, "GET", "/api/weather-cache/BadKey", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let (status, saved) = send(
            &router,
            "PUT",
            "/api/weather-cache/tokyo",
            Some(json!({ "2026-08-04": { "tempMax": 30 } })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(saved["2026-08-04"]["tempMax"], 30);

        let (_, reloaded) = send(&router, "GET", "/api/weather-cache/tokyo", None).await;
        assert_eq!(reloaded["2026-08-04"]["tempMax"], 30);
    }

    #[tokio::test]
    async fn runtime_returns_app_version() {
        let (state, _tmp) = test_state();
        let router = build_router(state);

        let (status, runtime) = send(&router, "GET", "/api/runtime", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(runtime, json!({ "appVersion": env!("CARGO_PKG_VERSION") }));
    }

    #[tokio::test]
    async fn static_serving_root_redirect_and_not_found() {
        let (state, _tmp) = test_state();
        let router = build_router(state);

        let request = Request::builder().header("host", TEST_HOST).uri("/").body(Body::empty()).unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
        assert_eq!(
            response.headers().get(header::LOCATION).unwrap(),
            "/assets/app.html"
        );

        let request = Request::builder().header("host", TEST_HOST)
            .uri("/favicon.ico")
            .body(Body::empty())
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);

        let request = Request::builder().header("host", TEST_HOST).uri("/hello.txt").body(Body::empty()).unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/octet-stream"
        );

        let request = Request::builder().header("host", TEST_HOST)
            .uri("/does-not-exist.txt")
            .body(Body::empty())
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn unmatched_api_route_returns_404_json_and_non_get_static_is_405() {
        let (state, _tmp) = test_state();
        let router = build_router(state);

        let (status, body) = send(&router, "GET", "/api/does-not-exist", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "GET /api/does-not-exist not found");

        let request = Request::builder().header("host", TEST_HOST)
            .method("POST")
            .uri("/hello.txt")
            .body(Body::empty())
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

}
