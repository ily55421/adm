// 单轮消息统计：仅使用已保存的消息，不把会话累计用量当成单轮账单。

/** @param {unknown} value @returns {number} 毫秒时间戳，缺失或无效时为 0 */
export function messageTimeMs(value) {
  if (value == null || value === "") return 0;
  var numeric = typeof value === "number" ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  var timestamp = Number.isFinite(numeric) ? (numeric < 1e12 ? numeric * 1000 : numeric)
    : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8640000000000000 ? timestamp : 0;
}

/** @param {number} timestamp @returns {string} */
export function formatRoundTime(timestamp) {
  if (!timestamp) return "—";
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

/** @param {number|null} milliseconds @returns {string} */
export function formatRoundDuration(milliseconds) {
  if (milliseconds == null || !Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  var seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return seconds + "秒";
  var minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "分" + String(seconds % 60).padStart(2, "0") + "秒";
  return Math.floor(minutes / 60) + "时" + String(minutes % 60).padStart(2, "0") + "分" + String(seconds % 60).padStart(2, "0") + "秒";
}

// SSE 每次用新消息对象替换旧对象；WeakMap 使历史长文本只扫描一次，并随消息回收。
var messageMetricsCache = new WeakMap();

/** @param {unknown} value @returns {number} */
function estimateTextTokens(value) {
  if (typeof value !== "string" || !value) return 0;
  var cjk = (value.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  return Math.ceil(cjk + (value.length - cjk) / 4);
}

/** @param {any} message */
function messageMetrics(message) {
  var cached = messageMetricsCache.get(message);
  if (cached) return cached;
  var tokens = 0;
  var tools = 0;
  var updatedAt = Math.max(messageTimeMs(message.updated_at), messageTimeMs(message.created_at));
  var parts = Array.isArray(message.parts) ? message.parts : [];
  if (!parts.length) tokens = estimateTextTokens(message.content);
  parts.forEach(function(part) {
    if (!part) return;
    var data = part.data || {};
    switch (part.type) {
      case "text": tokens += estimateTextTokens(data.text); break;
      case "reasoning": tokens += estimateTextTokens(data.thinking); break;
      case "tool_call": tools++; tokens += estimateTextTokens(data.input); break;
      case "tool_result": tokens += estimateTextTokens(data.content); break;
      case "shell_command": tokens += estimateTextTokens(data.command) + estimateTextTokens(data.output); break;
    }
  });
  var result = { tokens: tokens, tools: tools, updatedAt: updatedAt, requests: message.role === "assistant" ? 1 : 0 };
  messageMetricsCache.set(message, result);
  return result;
}

/**
 * 历史结束时间取最后一条保存消息的更新时间；缺少回复不虚构结束时间。
 * 文本 token 不包含反复发送的上下文、系统提示词、图片和供应商隐藏 token，不能作计费用量。
 * @param {any[]} items @param {boolean} running @param {number} [now]
 */
export function collectRoundMetrics(items, running, now = Date.now()) {
  var user = items.find(function(message) { return message && message.role === "user"; });
  var startedAt = user ? messageTimeMs(user.created_at) : 0;
  var endedAt = 0;
  var tokens = 0;
  var tools = 0;
  var requests = 0;
  var hasReply = false;
  items.forEach(function(message) {
    if (!message || typeof message !== "object" || message._temp || message._error || message.role === "error") return;
    var metrics = messageMetrics(message);
    tokens += metrics.tokens;
    tools += metrics.tools;
    requests += metrics.requests;
    if (message.role !== "user" && metrics.updatedAt) {
      hasReply = true;
      endedAt = Math.max(endedAt, metrics.updatedAt);
    }
  });
  if (!hasReply || (startedAt && endedAt < startedAt)) endedAt = 0;
  return {
    startedAt: startedAt, endedAt: running ? 0 : endedAt, tokens: tokens, tools: tools, requests: requests,
    durationMs: startedAt && (running || endedAt) ? Math.max(0, (running ? now : endedAt) - startedAt) : null,
  };
}
