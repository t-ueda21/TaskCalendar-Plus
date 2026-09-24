/**
 * ai-client.js
 *
 * AI(Claude Code / Codex)の呼び出し。実体はRust側の /api/ai/chat(ai_cli.rs)。
 * - callAi: 道具なしの1回の呼び出し(日次サマリーなど)
 * - chatWithAgent: AIモードのエージェント。アプリのMCPサーバーの道具で予定を調べ、
 *   予定の作成・変更・削除は「提案」として返す(確定は画面のカードで行う)。
 */

import * as Store from "./store.js";

// Claude Code / Codex はCLIの起動と、道具を使いながらの推論に時間がかかる(Rust側は170秒で打ち切る)。
const AI_TIMEOUT_MS = 180_000;

let _abortController = null;
let _lastUsed = { provider: "", model: "" };

export class AiError extends Error {
  constructor(message, { cancelled = false, unavailable = false } = {}) {
    super(message);
    this.name = "AiError";
    this.cancelled = cancelled;
    this.unavailable = unavailable;
  }
}

/** AIの接続先が設定され、連携がオンになっているか。 */
export function isAiConfigured() {
  const s = Store.getSettings();
  return s?.aiCliEnabled === true && ["claude-code", "codex"].includes(String(s?.aiProvider ?? ""));
}

/** 直前の呼び出しで実際に使われたモデル名。接続先を切り替えた後は空。 */
export function getLastUsedModel() {
  return _lastUsed.provider === String(Store.getSettings()?.aiProvider ?? "") ? _lastUsed.model : "";
}

/** 進行中の呼び出しを止める(画面の「停止」ボタン)。Rust側は接続が切れるとCLIを終了させる。 */
export function cancelAi() {
  _abortController?.abort();
}

async function _request(body) {
  if (!isAiConfigured()) {
    throw new AiError("AIの接続先が設定されていません。⚙設定 →「基本」→「AI」で、Claude Code / Codex との連携をオンにして接続先を選んでください。", { unavailable: true });
  }
  const controller = new AbortController();
  _abortController = controller;
  const timer = window.setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), AI_TIMEOUT_MS);
  try {
    const res = await fetch("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new AiError(String(data?.error || `AIの呼び出しに失敗しました(status ${res.status})`));
    _lastUsed = { provider: String(data.provider ?? ""), model: String(data.model ?? "") };
    return data;
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (controller.signal.aborted) {
      const timedOut = controller.signal.reason?.name === "TimeoutError";
      throw new AiError(timedOut ? "AIの応答が時間内に返りませんでした。" : "AIの応答を停止しました。", { cancelled: !timedOut });
    }
    throw new AiError(`AIの呼び出しに失敗しました: ${String(e?.message ?? e)}`);
  } finally {
    window.clearTimeout(timer);
    if (_abortController === controller) _abortController = null;
  }
}

/**
 * 道具なしの1回の呼び出し。format(JSON Schema)を渡すと構造化出力になり、content はJSON文字列。
 * @returns {Promise<string>} content
 */
export async function callAi(messages, { format = null } = {}) {
  const data = await _request({ messages, ...(format ? { format } : {}) });
  return String(data?.message?.content ?? "").trim();
}

/**
 * AIモードのエージェントとして呼び出す。
 * @param {{role: "user"|"assistant", content: string}[]} messages 直近の会話(最後が今回の質問)
 * @returns {Promise<{content: string, proposals: object[]}>}
 */
export async function chatWithAgent(messages) {
  const data = await _request({ agent: true, messages });
  return {
    content: String(data?.message?.content ?? "").trim(),
    proposals: Array.isArray(data?.proposals) ? data.proposals : [],
  };
}
