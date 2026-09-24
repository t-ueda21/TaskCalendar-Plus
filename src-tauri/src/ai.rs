//! AIの接続先の選択と、AIエージェントへの指示(system prompt)。
//!
//! AIは利用者のPCにインストール・ログイン済みの Claude Code / Codex だけを使う(`ai_cli.rs`)。
//! 「Claude Code / Codex と連携する」(aiCliEnabled、既定オフ)をオンにし、接続先(aiProvider)を選んだときだけ呼び出す。

use crate::ai_cli::CliKind;
use serde_json::Value;

/// 設定JSONから読み取ったAI接続設定。provider が None ならAIを呼ばない。
#[derive(Debug, Clone)]
pub struct AiSettings {
    pub provider: Option<CliKind>,
    pub claude_model: String,
    pub claude_effort: String,
    pub codex_model: String,
    pub codex_effort: String,
}

fn setting_str(settings: &Value, key: &str) -> String {
    settings.get(key).and_then(|v| v.as_str()).unwrap_or("").trim().to_string()
}

/// effort は設定に項目が無ければ low(画面側の既定値と同じ)。空文字は「CLIの既定」を選んだもの。
fn setting_effort(settings: &Value, key: &str) -> String {
    match settings.get(key).and_then(|v| v.as_str()) {
        Some(value) => value.trim().to_string(),
        None => "low".to_string(),
    }
}

impl AiSettings {
    pub fn from_settings(settings: &Value) -> Self {
        let cli_enabled = settings.get("aiCliEnabled").and_then(|v| v.as_bool()).unwrap_or(false);
        let provider = match setting_str(settings, "aiProvider").as_str() {
            "claude-code" if cli_enabled => Some(CliKind::ClaudeCode),
            "codex" if cli_enabled => Some(CliKind::Codex),
            _ => None,
        };
        Self {
            provider,
            claude_model: setting_str(settings, "aiClaudeModel"),
            claude_effort: CliKind::ClaudeCode.normalize_effort(&setting_effort(settings, "aiClaudeEffort")).to_string(),
            codex_model: setting_str(settings, "aiCodexModel"),
            codex_effort: CliKind::Codex.normalize_effort(&setting_effort(settings, "aiCodexEffort")).to_string(),
        }
    }

    pub fn model_and_effort(&self, kind: CliKind) -> (&str, &str) {
        match kind {
            CliKind::ClaudeCode => (&self.claude_model, &self.claude_effort),
            CliKind::Codex => (&self.codex_model, &self.codex_effort),
        }
    }
}

/// 週(月曜始まり)の範囲を「2026-09-28(月)〜2026-10-04(日)」の形にする。
fn week_label(monday: chrono::NaiveDate) -> String {
    let sunday = monday + chrono::Duration::days(6);
    format!("{}(月)〜{}(日)", monday.format("%Y-%m-%d"), sunday.format("%Y-%m-%d"))
}

/// AIモードのエージェントへの指示。今日の日付と、道具(MCP)の使い方の規則。
/// 「来週月曜」などの取り違えを防ぐため、先週・今週・来週の範囲も書いておく。
pub fn agent_system_prompt(today: chrono::NaiveDate) -> String {
    use chrono::Datelike;
    let this_monday = today - chrono::Duration::days(today.weekday().num_days_from_monday() as i64);
    format!(
        "あなたは作業記録・予定管理アプリ TaskCalendar+ のアシスタントです。今日は{}({})、タイムゾーンは Asia/Tokyo です。\n\
         先週は{}、今週は{}、来週は{}です(週は月曜始まり)。\n\
         規則:\n\
         - 予定・作業記録・工数・予算についての質問は、必ず {server} の道具で調べてから答える。推測で答えない。記録が無ければ無いと答える。\n\
         - 時間・件数・日数は道具が返した値(分と「○時間○分」)をそのまま使い、自分で計算し直さない。合計が必要なら summarize_work や month_status を使う。\n\
         - 「昨日」「先週の火曜」「今月」などは今日を基準に YYYY-MM-DD に直す。週は月曜始まり。\n\
         - 予定の作成・変更・削除を頼まれたら propose_create_task / propose_update_task / propose_delete_task で提案する。変更・削除は先に search_tasks で対象を特定し、候補が複数あって特定できないときは提案せずに候補を示して聞き返す。\n\
         - 提案した後は「〜を提案しました」と伝え、画面のカードで［確定］するよう促す。確定前なので「登録しました」「変更しました」「削除しました」とは言わない。\n\
         - タグは get_context のタグ一覧から、タイトルに合うものがあれば選ぶ。\n\
         - 回答は日本語で簡潔に。見やすくなるならMarkdown(箇条書き・表・太字)を使ってよい。",
        today.format("%Y-%m-%d"),
        crate::calendar::weekday_jp(today),
        week_label(this_monday - chrono::Duration::days(7)),
        week_label(this_monday),
        week_label(this_monday + chrono::Duration::days(7)),
        server = crate::mcp::SERVER_NAME,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn provider_requires_opt_in() {
        for provider in ["claude-code", "codex"] {
            assert!(AiSettings::from_settings(&json!({ "aiProvider": provider })).provider.is_none());
            assert!(AiSettings::from_settings(&json!({ "aiProvider": provider, "aiCliEnabled": false })).provider.is_none());
        }
        let s = AiSettings::from_settings(&json!({ "aiProvider": "codex", "aiCliEnabled": true, "aiCodexModel": " gpt-x " }));
        assert_eq!(s.provider, Some(CliKind::Codex));
        assert_eq!(s.model_and_effort(CliKind::Codex), ("gpt-x", "low"));
        assert!(AiSettings::from_settings(&json!({ "aiProvider": "ollama", "aiCliEnabled": true })).provider.is_none());
    }

    #[test]
    fn effort_defaults_to_low_but_empty_means_cli_default() {
        let unset = AiSettings::from_settings(&json!({}));
        assert_eq!((unset.claude_effort.as_str(), unset.codex_effort.as_str()), ("low", "low"));
        let cli_default = AiSettings::from_settings(&json!({ "aiClaudeEffort": "", "aiCodexEffort": "" }));
        assert_eq!((cli_default.claude_effort.as_str(), cli_default.codex_effort.as_str()), ("", ""));
        let invalid = AiSettings::from_settings(&json!({ "aiClaudeEffort": "minimal", "aiCodexEffort": "max" }));
        assert_eq!((invalid.claude_effort.as_str(), invalid.codex_effort.as_str()), ("", ""));
    }

    #[test]
    fn agent_prompt_contains_today() {
        let p = agent_system_prompt(chrono::NaiveDate::from_ymd_opt(2026, 9, 24).unwrap());
        assert!(p.contains("2026-09-24(木)"));
        assert!(p.contains("来週は2026-09-28(月)〜2026-10-04(日)"));
        assert!(p.contains("先週は2026-09-14(月)〜2026-09-20(日)"));
        assert!(p.contains("propose_create_task"));
    }
}
