export function extractChatMessageContent(text) {
  const payload = parseChatPayload(text);
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) {
    return content;
  }

  if (Array.isArray(payload?.choices)) {
    const streamed = payload.choices
      .map((choice) => choice?.delta?.content || choice?.message?.content || "")
      .join("");
    if (streamed.trim()) {
      return streamed;
    }
  }

  throw new Error("LLM API 没有返回 message.content");
}

export function parseChatPayload(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    throw new Error("LLM API 返回为空");
  }

  if (!raw.startsWith("data:")) {
    return JSON.parse(raw);
  }

  const events = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");

  if (!events.length) {
    throw new Error("LLM 流式响应没有 data 内容");
  }

  if (events.length === 1) {
    return JSON.parse(events[0]);
  }

  let base = null;
  let content = "";
  for (const event of events) {
    const chunk = JSON.parse(event);
    if (!base) {
      base = chunk;
    }
    const choice = chunk?.choices?.[0];
    content += choice?.delta?.content || choice?.message?.content || "";
  }

  return {
    ...(base || {}),
    choices: [
      {
        ...(base?.choices?.[0] || {}),
        message: {
          role: "assistant",
          content
        }
      }
    ]
  };
}

export function formatLlmHttpError(status, text, label = "LLM API") {
  const hint = statusHint(status);
  const detail = responseErrorDetail(text);
  return `${label} 返回 ${status}${hint ? `：${hint}` : ""}${detail ? `；${detail}` : ""}`;
}

function statusHint(status) {
  if (status === 401) {
    return "认证失败，请检查 API Key";
  }
  if (status === 403) {
    return "访问被拒绝，请检查 API Key 是否有权限、模型是否可用，或账号是否被接口限制";
  }
  if (status === 404) {
    return "接口或模型不存在，请检查 Base URL 和模型名";
  }
  if (status === 429) {
    return "请求过多或额度不足";
  }
  if (status >= 500) {
    return "上游服务异常";
  }
  return "";
}

function responseErrorDetail(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return "";
  }

  let value = raw;
  try {
    const parsed = JSON.parse(raw);
    value = parsed?.error?.message ||
      parsed?.error?.code ||
      parsed?.message ||
      parsed?.detail ||
      parsed?.details ||
      raw;
  } catch (_) {}

  value = String(value || "").trim();
  if (looksLikeHtml(value) || looksLikeHtml(raw)) {
    const title = value.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
      raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
      "";
    const cleanedTitle = stripHtml(title);
    return cleanedTitle ? `服务器返回 HTML 错误页：${cleanedTitle}` : "服务器返回 HTML 错误页";
  }

  return value.replace(/\s+/g, " ").slice(0, 220);
}

function looksLikeHtml(text) {
  return /<(?:!doctype\s+html|html|head|body|style|script|meta|div)\b/i.test(String(text || ""));
}

function stripHtml(text) {
  return String(text || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
