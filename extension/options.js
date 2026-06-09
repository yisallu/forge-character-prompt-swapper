import { getSettings, saveSettings } from "./lib/storage.js";
import { llmChatCompletionsUrl, llmModelsUrl, normalizeLlmBaseUrl } from "./lib/llmEndpoint.js";
import { extractChatMessageContent, formatLlmHttpError } from "./lib/llmResponse.js";
import { buildVisionProbeRequest, evaluateVisionProbeContent, parseModelListPayload, selectVisionProbeCandidates } from "./lib/llmModelProbe.js";

const fields = {
  llmBaseUrl: document.getElementById("llmBaseUrl"),
  llmModel: document.getElementById("llmModel"),
  llmApiKey: document.getElementById("llmApiKey"),
  limitCharacterTags: document.getElementById("limitCharacterTags"),
  characterTagLimit: document.getElementById("characterTagLimit"),
  forgeApiUrl: document.getElementById("forgeApiUrl"),
  seedMode: document.getElementById("seedMode"),
  sdModelCheckpoint: document.getElementById("sdModelCheckpoint"),
  hiresMode: document.getElementById("hiresMode"),
  hiresUpscaler: document.getElementById("hiresUpscaler"),
  hiresScale: document.getElementById("hiresScale"),
  hiresDenoisingStrength: document.getElementById("hiresDenoisingStrength"),
  yisalbotToken: document.getElementById("yisalbotToken"),
  yisalbotChatId: document.getElementById("yisalbotChatId"),
  llmTimeoutMs: document.getElementById("llmTimeoutMs"),
  generationTimeoutMs: document.getElementById("generationTimeoutMs")
};

const saveStatus = document.getElementById("saveStatus");
const visionProbeSummary = document.getElementById("visionProbeSummary");
const visionProbeResults = document.getElementById("visionProbeResults");
document.getElementById("saveButton").addEventListener("click", handleSave);
document.getElementById("refreshForgeResources").addEventListener("click", handleRefreshForgeResources);
document.getElementById("testForge").addEventListener("click", handleTestForge);
document.getElementById("testYisalbot").addEventListener("click", handleTestYisalbot);
document.getElementById("probeVisionModels").addEventListener("click", handleProbeVisionModels);

await loadSettings();

async function loadSettings() {
  const settings = await getSettings();
  ensureSelectValue(fields.sdModelCheckpoint, settings.sdModelCheckpoint, "当前保存的模型");
  ensureSelectValue(fields.hiresUpscaler, settings.hiresUpscaler, "当前保存的放大模型");
  for (const [key, field] of Object.entries(fields)) {
    if (field.type === "checkbox") {
      field.checked = Boolean(settings[key]);
    } else {
      field.value = settings[key] ?? "";
    }
  }
  await refreshForgeResources(false);
}

async function handleSave() {
  await saveSettings(readSettings());
  saveStatus.textContent = "已保存";
}

async function handleTestForge() {
  await saveSettings(readSettings());
  saveStatus.textContent = "测试中";
  const response = await chrome.runtime.sendMessage({ type: "PING_FORGE" });
  saveStatus.textContent = response?.ok
    ? `Forge 可用：${response.result?.model || "OK"}`
    : response?.error || "Forge 不可用";
}

async function handleRefreshForgeResources() {
  await saveSettings(readSettings());
  await refreshForgeResources(true);
}

async function refreshForgeResources(showStatus) {
  if (showStatus) {
    saveStatus.textContent = "刷新 SD 列表中";
  }
  const response = await chrome.runtime.sendMessage({ type: "LIST_FORGE_RESOURCES" });
  if (!response?.ok) {
    if (showStatus) {
      saveStatus.textContent = response?.error || "刷新失败";
    }
    return;
  }

  const settings = await getSettings();
  setSelectOptions(
    fields.sdModelCheckpoint,
    response.result?.models || [],
    "沿用 Forge 当前模型",
    settings.sdModelCheckpoint
  );
  setSelectOptions(
    fields.hiresUpscaler,
    response.result?.upscalers || [],
    "沿用基础图/Forge 默认",
    settings.hiresUpscaler
  );
  if (showStatus) {
    saveStatus.textContent = `已刷新：${response.result?.models?.length || 0} 个模型，${response.result?.upscalers?.length || 0} 个放大模型`;
  }
}

async function handleTestYisalbot() {
  await saveSettings(readSettings());
  saveStatus.textContent = "测试 Yisalbot 中";
  const response = await chrome.runtime.sendMessage({ type: "TEST_YISALBOT" });
  saveStatus.textContent = response?.ok
    ? "Yisalbot 可用"
    : response?.error || "Yisalbot 不可用";
}

async function handleProbeVisionModels() {
  const settings = readSettings();
  await saveSettings(settings);

  if (!settings.llmBaseUrl || !settings.llmApiKey) {
    setVisionProbeSummary("请先填写 LLM Base URL 和 API Key");
    renderVisionProbeRows([]);
    return;
  }

  const button = document.getElementById("probeVisionModels");
  button.disabled = true;
  saveStatus.textContent = "检测 LLM 模型中";
  setVisionProbeSummary("读取 /models 中");
  renderVisionProbeRows([]);

  try {
    const models = await fetchLlmModels(settings);
    const candidates = selectVisionProbeCandidates(models, settings.llmModel, 24);
    const rows = candidates.map((candidate) => ({
      ...candidate,
      status: "waiting",
      detail: "等待测试"
    }));

    renderVisionProbeRows(rows);
    setVisionProbeSummary(`/models 返回 ${models.length} 个模型，准备测试 ${rows.length} 个疑似可识图模型`);

    for (let index = 0; index < rows.length; index += 1) {
      rows[index] = { ...rows[index], status: "testing", detail: "发图测试中" };
      renderVisionProbeRows(rows);
      setVisionProbeSummary(`发图测试中：${index + 1}/${rows.length}`);
      rows[index] = await probeVisionModel(rows[index], settings);
      renderVisionProbeRows(rows);
    }

    const passed = rows.filter((row) => row.canSeeImage).length;
    const failed = rows.length - passed;
    setVisionProbeSummary(`检测完成：${passed} 个可识图，${failed} 个未通过或不可用`);
    saveStatus.textContent = passed ? `找到 ${passed} 个可识图模型` : "没有测到可识图模型";
  } catch (error) {
    const message = redactSensitive(String(error?.message || error), settings);
    setVisionProbeSummary(message);
    saveStatus.textContent = "LLM 模型检测失败";
  } finally {
    button.disabled = false;
  }
}

function readSettings() {
  return {
    llmBaseUrl: normalizeLlmBaseUrl(fields.llmBaseUrl.value),
    llmModel: fields.llmModel.value.trim(),
    llmApiKey: fields.llmApiKey.value.trim(),
    limitCharacterTags: fields.limitCharacterTags.checked,
    characterTagLimit: readOptionalInteger(fields.characterTagLimit, 3),
    forgeApiUrl: fields.forgeApiUrl.value.trim(),
    seedMode: fields.seedMode.value,
    sdModelCheckpoint: fields.sdModelCheckpoint.value.trim(),
    hiresMode: fields.hiresMode.value,
    hiresUpscaler: fields.hiresUpscaler.value.trim(),
    hiresScale: readOptionalNumber(fields.hiresScale),
    hiresDenoisingStrength: readOptionalNumber(fields.hiresDenoisingStrength),
    yisalbotToken: fields.yisalbotToken.value.trim(),
    yisalbotChatId: fields.yisalbotChatId.value.trim(),
    llmTimeoutMs: Number(fields.llmTimeoutMs.value),
    generationTimeoutMs: Number(fields.generationTimeoutMs.value)
  };
}

function setSelectOptions(select, values, emptyLabel, selectedValue) {
  const selected = String(selectedValue || "");
  const normalized = Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
  select.textContent = "";
  select.append(new Option(emptyLabel, ""));
  if (selected && !normalized.includes(selected)) {
    select.append(new Option(`${selected}（已保存）`, selected));
  }
  for (const value of normalized) {
    select.append(new Option(value, value));
  }
  select.value = selected;
}

function ensureSelectValue(select, value, label) {
  const selected = String(value || "").trim();
  if (!selected || Array.from(select.options).some((option) => option.value === selected)) {
    return;
  }
  select.append(new Option(`${selected}（${label}）`, selected));
}

function readOptionalNumber(field) {
  const value = field.value.trim();
  if (!value) {
    return "";
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : "";
}

function readOptionalInteger(field, fallback) {
  const value = field.value.trim();
  if (!value) {
    return fallback;
  }
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? Math.max(1, number) : fallback;
}

async function fetchLlmModels(settings) {
  const url = llmModelsUrl(settings.llmBaseUrl);
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${settings.llmApiKey}`
    }
  }, 20000);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(formatLlmHttpError(response.status, redactSensitive(text, settings), "LLM 模型列表"));
  }
  return parseModelListPayload(text);
}

async function probeVisionModel(row, settings) {
  const url = llmChatCompletionsUrl(settings.llmBaseUrl);
  try {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${settings.llmApiKey}`
      },
      body: JSON.stringify(buildVisionProbeRequest({ model: row.id }))
    }, Math.min(Math.max(Number(settings.llmTimeoutMs) || 25000, 10000), 30000));
    const text = await response.text();
    if (!response.ok) {
      return {
        ...row,
        status: "failed",
        httpStatus: response.status,
        detail: formatLlmHttpError(response.status, redactSensitive(text, settings), "发图测试")
      };
    }

    const content = extractChatMessageContent(text);
    const evaluated = evaluateVisionProbeContent(content);
    return {
      ...row,
      status: evaluated.canSeeImage ? "passed" : "failed",
      httpStatus: response.status,
      canSeeImage: evaluated.canSeeImage,
      detail: evaluated.canSeeImage ? `可识图：${evaluated.evidence || "已看懂测试图"}` : `未确认可识图：${evaluated.preview || "返回内容无法判断"}`,
      preview: evaluated.preview
    };
  } catch (error) {
    return {
      ...row,
      status: "failed",
      detail: redactSensitive(String(error?.message || error), settings)
    };
  }
}

function renderVisionProbeRows(rows) {
  visionProbeResults.textContent = "";
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "summary";
    empty.textContent = "还没有检测结果";
    visionProbeResults.append(empty);
    return;
  }

  for (const row of rows) {
    const item = document.createElement("div");
    item.className = `model-probe-row model-probe-${row.status || "waiting"}`;

    const main = document.createElement("div");
    main.className = "model-probe-main";

    const name = document.createElement("strong");
    name.textContent = row.id;
    main.append(name);

    const detail = document.createElement("span");
    detail.textContent = [
      row.httpStatus ? `HTTP ${row.httpStatus}` : "",
      row.reason || "",
      row.detail || ""
    ].filter(Boolean).join(" · ");
    main.append(detail);
    item.append(main);

    const actions = document.createElement("div");
    actions.className = "model-probe-actions";
    const badge = document.createElement("span");
    badge.className = "model-probe-badge";
    badge.textContent = statusLabel(row.status);
    actions.append(badge);

    if (row.canSeeImage) {
      const useButton = document.createElement("button");
      useButton.type = "button";
      useButton.className = "secondary small-button";
      useButton.textContent = "设为模型";
      useButton.addEventListener("click", async () => {
        fields.llmModel.value = row.id;
        await saveSettings(readSettings());
        saveStatus.textContent = `已设为 ${row.id}`;
      });
      actions.append(useButton);
    }

    item.append(actions);
    visionProbeResults.append(item);
  }
}

function setVisionProbeSummary(message) {
  visionProbeSummary.textContent = message;
}

function statusLabel(status) {
  if (status === "passed") {
    return "可识图";
  }
  if (status === "failed") {
    return "失败";
  }
  if (status === "testing") {
    return "测试中";
  }
  return "等待";
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function redactSensitive(text, settings) {
  let value = String(text || "");
  const key = String(settings?.llmApiKey || "").trim();
  if (key) {
    value = value.split(key).join("[API KEY]");
  }
  return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g, "Bearer [API KEY]");
}
