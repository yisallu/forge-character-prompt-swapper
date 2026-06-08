import { STORAGE_KEYS } from "./lib/defaults.js";
import { extractPngParametersFromFile } from "./lib/pngInfo.js";
import { parseInfotext, summarizeParams } from "./lib/infotext.js";
import { guessCharacterSegment, joinPromptTags, splitPromptTags } from "./lib/promptMerge.js";
import { llmChatCompletionsUrl } from "./lib/llmEndpoint.js";
import { extractChatMessageContent, formatLlmHttpError } from "./lib/llmResponse.js";
import { buildCleanTemplatePromptRequest, parseCleanTemplatePromptResponse } from "./lib/templatePromptClean.js";
import { getBaseTemplate, getSettings, saveBaseTemplate, storageGet, storageSet } from "./lib/storage.js";

const elements = {
  statusText: document.getElementById("statusText"),
  imageFile: document.getElementById("imageFile"),
  cleanTemplateWithLlm: document.getElementById("cleanTemplateWithLlm"),
  cleanCurrentTemplate: document.getElementById("cleanCurrentTemplate"),
  cleanTemplateLog: document.getElementById("cleanTemplateLog"),
  characterSegment: document.getElementById("characterSegment"),
  positivePrompt: document.getElementById("positivePrompt"),
  negativePrompt: document.getElementById("negativePrompt"),
  paramSummary: document.getElementById("paramSummary"),
  saveTemplate: document.getElementById("saveTemplate"),
  lastCharacter: document.getElementById("lastCharacter"),
  generateAgain: document.getElementById("generateAgain"),
  resultImage: document.getElementById("resultImage"),
  downloadResult: document.getElementById("downloadResult"),
  optionsButton: document.getElementById("optionsButton")
};

let currentTemplate = null;
let activePromptState = null;
let showingActivePrompt = false;

elements.imageFile.addEventListener("change", handleFileChange);
elements.cleanTemplateWithLlm.addEventListener("change", () => {
  saveCleanWithLlmPreference().catch((error) => setStatus(error?.message || "保存上传选项失败"));
});
elements.cleanCurrentTemplate.addEventListener("click", () => cleanAndSaveCurrentTemplateWithLlm());
elements.saveTemplate.addEventListener("click", handleSaveTemplate);
elements.generateAgain.addEventListener("click", sendGenerateAgain);
elements.downloadResult.addEventListener("click", sendDownloadResult);
elements.optionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  if (changes[STORAGE_KEYS.baseTemplate] || changes[STORAGE_KEYS.activeRunJobId] || changes[STORAGE_KEYS.activePromptSync]) {
    refreshPromptDisplay().catch((error) => setStatus(error?.message || "同步提示词失败"));
  }
  if (changes[STORAGE_KEYS.lastRunStatus] || changes[STORAGE_KEYS.lastCharacter] || changes[STORAGE_KEYS.latestResult]) {
    renderRuntimeState();
  }
});

await loadInitialState();

async function loadInitialState() {
  const stored = await storageGet(STORAGE_KEYS.templateImportCleanWithLlm);
  elements.cleanTemplateWithLlm.checked = Boolean(stored[STORAGE_KEYS.templateImportCleanWithLlm]);
  await refreshPromptDisplay();
  await renderRuntimeState();
}

async function refreshPromptDisplay() {
  const stored = await storageGet([
    STORAGE_KEYS.baseTemplate,
    STORAGE_KEYS.activeRunJobId,
    STORAGE_KEYS.activePromptSync
  ]);
  currentTemplate = stored[STORAGE_KEYS.baseTemplate] || currentTemplate;
  const activeJobId = stored[STORAGE_KEYS.activeRunJobId];
  const promptState = normalizeActivePromptSync(stored[STORAGE_KEYS.activePromptSync]);
  if (promptState?.jobId && promptState.jobId === activeJobId) {
    activePromptState = promptState;
    renderActivePromptState(promptState);
    return;
  }
  activePromptState = null;
  if (currentTemplate) {
    renderTemplate(currentTemplate);
  }
}

async function handleFileChange(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }
  setStatus(`读取 ${file.name}`);
  try {
    const extracted = await extractPngParametersFromFile(file);
    const parsed = parseInfotext(extracted.parameters);
    currentTemplate = {
      fileName: file.name,
      infoText: parsed.raw,
      positive: parsed.positive,
      negative: parsed.negative,
      params: parsed.params,
      parameterLine: parsed.parameterLine,
      characterSegment: guessCharacterSegment(parsed.positive),
      importedAt: new Date().toISOString()
    };
    renderTemplate(currentTemplate);

    if (elements.cleanTemplateWithLlm.checked) {
      try {
        setCleanLog("准备调用 LLM 去除角色提示词");
        currentTemplate = await cleanTemplateWithLlm(currentTemplate);
        renderTemplate(currentTemplate);
        setCleanLog(cleanSuccessMessage(currentTemplate));
      } catch (error) {
        setCleanLog(`LLM 去除失败：${error?.message || error}；未自动保存，请手动确认后保存`);
        return;
      }
    }

    await saveBaseTemplate(currentTemplate);
    setStatus(currentTemplate.cleanedWithLlmAt ? `基础模板已保存（${cleanSuccessMessage(currentTemplate)}）` : "基础模板已保存");
  } catch (error) {
    setStatus(error?.message || "读取失败");
  }
}

async function cleanAndSaveCurrentTemplateWithLlm() {
  if (!currentTemplate) {
    setStatus("还没有基础模板");
    return;
  }
  currentTemplate = {
    ...currentTemplate,
    characterSegment: elements.characterSegment.value.trim(),
    positive: elements.positivePrompt.value.trim(),
    negative: elements.negativePrompt.value.trim()
  };
  try {
    elements.cleanCurrentTemplate.disabled = true;
    setCleanLog("准备调用 LLM 清理当前模板");
    currentTemplate = await cleanTemplateWithLlm(currentTemplate);
    renderTemplate(currentTemplate);
    await saveBaseTemplate(currentTemplate);
    setStatus("当前模板已用 LLM 清理并保存");
    setCleanLog(cleanSuccessMessage(currentTemplate));
  } catch (error) {
    setStatus(`LLM 清理失败：${error?.message || error}`);
    setCleanLog(`LLM 清理失败：${error?.message || error}`);
  } finally {
    elements.cleanCurrentTemplate.disabled = false;
  }
}

async function saveCleanWithLlmPreference() {
  await storageSet({
    [STORAGE_KEYS.templateImportCleanWithLlm]: elements.cleanTemplateWithLlm.checked
  });
  setStatus(elements.cleanTemplateWithLlm.checked
    ? "上传基础图时会调用 LLM 清理角色提示词"
    : "上传基础图时只使用本地规则");
}

async function cleanTemplateWithLlm(template) {
  const settings = await getSettings();
  if (!settings.llmApiKey) {
    throw new Error("还没有在扩展选项里填写 api.sysmeng.com 的 API key");
  }
  const url = llmChatCompletionsUrl(settings.llmBaseUrl);
  setStatus(`LLM 清理请求：${settings.llmModel}`);
  setCleanLog(`正在请求 LLM：${settings.llmModel} · ${url}`);
  const request = buildCleanTemplatePromptRequest({ template, settings });
  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${settings.llmApiKey}`
      },
      body: JSON.stringify(request)
    },
    settings.llmTimeoutMs
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(formatLlmHttpError(response.status, text, "LLM 清理基础模板"));
  }
  const content = extractChatMessageContent(text);
  setCleanLog(`LLM API 已返回 HTTP ${response.status}，开始解析清理结果`);
  const cleaned = parseCleanTemplatePromptResponse(content, {
    originalPrompt: template.positive,
    fallbackCharacterSegment: template.characterSegment
  });
  const removedCount = cleaned.removed_character_prompt
    ? cleaned.removed_character_prompt.split(",").map((tag) => tag.trim()).filter(Boolean).length
    : 0;
  return {
    ...template,
    positive: cleaned.positive_prompt,
    characterSegment: cleaned.removed_character_prompt || template.characterSegment || "",
    llmCleanedCharacterPrompt: cleaned.removed_character_prompt || "",
    llmCleanReason: cleaned.reason || "",
    llmCleanModel: settings.llmModel,
    llmCleanUrl: url,
    llmCleanHttpStatus: response.status,
    llmCleanRemovedTagCount: removedCount,
    llmCleanResponsePreview: content.slice(0, 500),
    cleanedWithLlmAt: new Date().toISOString()
  };
}

async function handleSaveTemplate() {
  if (!currentTemplate) {
    setStatus("还没有基础模板");
    return;
  }
  if (showingActivePrompt && activePromptState?.jobId) {
    await saveSyncedActivePrompt();
    return;
  }
  currentTemplate = {
    ...currentTemplate,
    characterSegment: elements.characterSegment.value.trim(),
    positive: elements.positivePrompt.value.trim(),
    negative: elements.negativePrompt.value.trim()
  };
  await saveBaseTemplate(currentTemplate);
  setStatus("基础模板已保存");
}

async function saveSyncedActivePrompt() {
  const characterPrompt = elements.characterSegment.value.trim();
  const basePrompt = elements.positivePrompt.value.trim();
  const negativePrompt = elements.negativePrompt.value.trim();
  currentTemplate = {
    ...(currentTemplate || {}),
    positive: basePrompt,
    negative: negativePrompt
  };
  await saveBaseTemplate(currentTemplate);
  const characterActive = splitPromptTags(characterPrompt);
  const active = splitPromptTags(basePrompt);
  const syncState = {
    ...(activePromptState || {}),
    jobId: activePromptState.jobId,
    source: "popup",
    characterActive,
    characterInactive: normalizeTagList(activePromptState.characterInactive),
    active,
    inactive: normalizeTagList(activePromptState.inactive),
    characterPrompt: joinPromptTags(characterActive),
    basePrompt: joinPromptTags(active),
    prompt: joinPromptTags([...characterActive, ...active]),
    allPrompt: joinPromptTags([
      ...characterActive,
      ...active,
      ...normalizeTagList(activePromptState.characterInactive),
      ...normalizeTagList(activePromptState.inactive)
    ]),
    language: activePromptState.language || "en",
    updatedAt: new Date().toISOString()
  };
  activePromptState = normalizeActivePromptSync(syncState);
  await storageSet({
    [STORAGE_KEYS.activePromptSync]: syncState
  });
  renderActivePromptState(activePromptState);
  setStatus("已同步生成页并保存基础提示词，角色提示词没有写进默认");
}

async function sendGenerateAgain() {
  setStatus("打开生成标签页");
  const response = await chrome.runtime.sendMessage({ type: "GENERATE_WITH_LAST_CHARACTER" });
  setStatus(response?.ok ? "生成标签页已打开" : response?.error || "打开失败");
}

async function sendDownloadResult() {
  const response = await chrome.runtime.sendMessage({ type: "DOWNLOAD_LATEST_RESULT" });
  setStatus(response?.ok ? "结果已保存到下载目录" : response?.error || "保存失败");
}

function renderTemplate(template) {
  showingActivePrompt = false;
  elements.saveTemplate.textContent = "保存基础模板";
  elements.characterSegment.value = template.characterSegment || "";
  elements.positivePrompt.value = template.positive || "";
  elements.negativePrompt.value = template.negative || "";
  elements.paramSummary.textContent = summarizeParams(template);
  renderCleanTemplateLog(template);
}

function renderActivePromptState(state) {
  showingActivePrompt = true;
  elements.saveTemplate.textContent = "同步并保存基础模板";
  elements.characterSegment.value = state.characterPrompt || joinPromptTags(state.characterActive);
  elements.positivePrompt.value = state.basePrompt || joinPromptTags(state.active);
  elements.negativePrompt.value = currentTemplate?.negative || "";
  elements.paramSummary.textContent = [
    currentTemplate ? summarizeParams(currentTemplate) : "",
    `当前生成页同步 · ${state.jobId.slice(0, 8)}`
  ].filter(Boolean).join(" · ");
  setCleanLog("正在显示当前生成页提示词；保存会同步生成页，默认模板只保存基础提示词");
}

async function renderRuntimeState() {
  const stored = await storageGet([
    STORAGE_KEYS.lastRunStatus,
    STORAGE_KEYS.lastCharacter,
    STORAGE_KEYS.latestResult
  ]);

  const status = stored[STORAGE_KEYS.lastRunStatus];
  if (status?.message) {
    setStatus(status.message);
  }

  const character = stored[STORAGE_KEYS.lastCharacter];
  elements.lastCharacter.textContent = character?.character_name ||
    character?.character_prompt ||
    "无";

  const latest = stored[STORAGE_KEYS.latestResult];
  if (latest?.imageDataUrl) {
    elements.resultImage.src = latest.file?.fileUrl || latest.imageDataUrl;
    elements.resultImage.onerror = () => {
      elements.resultImage.onerror = null;
      elements.resultImage.src = latest.imageDataUrl;
    };
    elements.resultImage.hidden = false;
  }
}

function setStatus(message) {
  elements.statusText.textContent = message;
}

function setCleanLog(message) {
  elements.cleanTemplateLog.textContent = message || "";
}

function renderCleanTemplateLog(template) {
  if (!template?.cleanedWithLlmAt) {
    setCleanLog(elements.cleanTemplateWithLlm.checked
      ? "上传时会调用 LLM；当前模板还没有 LLM 清理记录"
      : "当前模板没有 LLM 清理记录");
    return;
  }
  setCleanLog(cleanSuccessMessage(template));
}

function cleanSuccessMessage(template) {
  const time = template.cleanedWithLlmAt
    ? new Date(template.cleanedWithLlmAt).toLocaleString("zh-CN")
    : "";
  const count = Number(template.llmCleanRemovedTagCount) || countPromptTags(template.llmCleanedCharacterPrompt || template.characterSegment);
  const model = template.llmCleanModel || "LLM";
  const status = template.llmCleanHttpStatus ? `HTTP ${template.llmCleanHttpStatus}` : "已返回";
  const removed = (template.llmCleanedCharacterPrompt || template.characterSegment || "").slice(0, 120);
  return `LLM 清理完成：${model} · ${status} · 移除 ${count} 个标签${time ? ` · ${time}` : ""}${removed ? ` · ${removed}` : ""}`;
}

function countPromptTags(prompt) {
  return String(prompt || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .length;
}

function normalizeActivePromptSync(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return {
    ...value,
    jobId: String(value.jobId || ""),
    source: String(value.source || ""),
    characterActive: normalizeTagList(value.characterActive),
    characterInactive: normalizeTagList(value.characterInactive),
    active: normalizeTagList(value.active),
    inactive: normalizeTagList(value.inactive),
    characterPrompt: String(value.characterPrompt || ""),
    basePrompt: String(value.basePrompt || ""),
    language: value.language === "zh" ? "zh" : "en"
  };
}

function normalizeTagList(value) {
  return Array.isArray(value)
    ? value.map((tag) => String(tag || "").trim()).filter(Boolean)
    : [];
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || 30000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`请求超时：${url}`);
    }
    const message = error?.message || String(error);
    if (/failed to fetch|networkerror/i.test(message)) {
      throw new Error(`请求失败：${url}。请检查接口地址、网络/CORS、API Key 权限`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
