export function normalizeLlmBaseUrl(value) {
  let url = String(value || "").trim();
  if (!url) {
    return "";
  }
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  url = url.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(url)) {
    url = url.replace(/\/chat\/completions$/i, "");
  }
  if (!/\/v\d+$/i.test(url)) {
    url += "/v1";
  }
  return url;
}

export function llmChatCompletionsUrl(baseUrl) {
  const base = normalizeLlmBaseUrl(baseUrl);
  if (!base) {
    return "";
  }
  return `${base}/chat/completions`;
}
