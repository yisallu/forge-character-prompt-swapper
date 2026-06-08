import { STORAGE_KEYS } from "./lib/defaults.js";
import {
  getBaseTemplate,
  getSettings,
  saveLastCharacter,
  saveLatestResult,
  setStatus,
  storageGet,
  storageSet
} from "./lib/storage.js";
import { buildForgeTxt2ImgPayload } from "./lib/forgePayload.js";
import { llmChatCompletionsUrl } from "./lib/llmEndpoint.js";
import { extractChatMessageContent, formatLlmHttpError } from "./lib/llmResponse.js";
import { replaceCharacterInPrompt } from "./lib/promptMerge.js";
import { applyCharacterTagLimit } from "./lib/characterPromptLimit.js";
import {
  IDENTIFY_IMAGE_MAX_EDGE,
  buildIdentifyCharacterRequest,
  parseCharacterResponse
} from "./lib/characterIdentify.js";

chrome.runtime.onInstalled.addListener(() => {
  setStatus({ phase: "idle", message: "扩展已就绪" });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      const detail = error?.message || String(error);
      setStatus({ phase: "error", message: detail });
      sendTabToast(sender?.tab?.id, detail, "error");
      sendResponse({ ok: false, error: detail });
    });
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "SHIFT_IMAGE_CLICKED":
      return openGenerationTab({
        mode: "image",
        image: message.image || null,
        sourceTabId: sender?.tab?.id || null,
        sourceUrl: sender?.tab?.url || message.image?.pageUrl || ""
      });
    case "PING_FORGE":
      return pingForge();
    case "LIST_FORGE_RESOURCES":
      return listForgeResources();
    case "GENERATE_WITH_LAST_CHARACTER":
      return openGenerationTab({
        mode: "lastCharacter",
        sourceTabId: sender?.tab?.id || null
      });
    case "DOWNLOAD_LATEST_RESULT":
      return downloadLatestResult();
    case "SAVE_RESULT_FILE":
      return saveResultFile(message.imageDataUrl, message.meta || {});
    case "OPEN_RESULT_FILE":
      return openResultFile(message.downloadId, message.filePath);
    case "SHOW_RESULT_FILE":
      return showResultFile(message.downloadId, message.filePath);
    case "TEST_YISALBOT":
      return testYisalbot();
    default:
      throw new Error(`Unknown message type: ${message?.type || "(empty)"}`);
  }
}

async function openGenerationTab(input) {
  const jobId = makeJobId();
  const job = {
    id: jobId,
    status: "queued",
    input,
    logs: [
      {
        at: new Date().toISOString(),
        level: "info",
        message: "任务已创建"
      }
    ],
    createdAt: new Date().toISOString()
  };
  await storageSet({
    [`runJob:${jobId}`]: job,
    [STORAGE_KEYS.activeRunJobId]: jobId
  });
  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL(`run.html?jobId=${encodeURIComponent(jobId)}`),
    active: false
  });
  await setStatus({
    phase: "queued",
    message: "已在后台打开生成标签页",
    jobId,
    tabId: tab.id
  });
  return { jobId, tabId: tab.id };
}

function makeJobId() {
  if (globalThis.crypto?.randomUUID) {
    return crypto.randomUUID();
  }
  return `job-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function runShiftClickFlow(image, tabId) {
  await updateProgress(tabId, "recognizing", "正在读取鼠标下的图片");
  const template = await requireTemplate();
  const settings = await getSettings();
  if (!settings.llmApiKey) {
    throw new Error("还没有在扩展选项里填写 api.sysmeng.com 的 API key");
  }

  const dataUrl = await getImageDataUrl(image);
  const llmImage = await shrinkImageDataUrl(dataUrl, IDENTIFY_IMAGE_MAX_EDGE);
  await updateProgress(tabId, "recognizing", "正在识别角色");
  const character = await identifyCharacterWithLlm(llmImage, settings, image);
  await saveLastCharacter(character);

  await updateProgress(tabId, "generating", `识别到：${character.character_name || "未知角色"}`);
  const result = await generateFromCharacter(character, template, settings);
  await updateProgress(tabId, "done", "图片生成完成");
  sendTabToast(tabId, "图片生成完成，可在扩展弹窗查看", "success");
  return result;
}

async function generateWithLastCharacter() {
  const template = await requireTemplate();
  const settings = await getSettings();
  const stored = await storageGet(STORAGE_KEYS.lastCharacter);
  const character = stored[STORAGE_KEYS.lastCharacter];
  if (!character?.character_prompt) {
    throw new Error("还没有最近一次角色识别结果");
  }
  await setStatus({ phase: "generating", message: `使用最近识别结果：${character.character_name || "未知角色"}` });
  return generateFromCharacter(character, template, settings);
}

async function generateFromCharacter(character, template, settings) {
  const limited = applyCharacterTagLimit(character, settings);
  character = limited.character;
  const characterPrompt = character.character_prompt || character.visual_prompt || character.character_name || "";
  const mergedPrompt = replaceCharacterInPrompt(template.positive, template.characterSegment, characterPrompt);
  const generationTemplate = {
    ...template,
    positive: mergedPrompt
  };
  const payload = buildForgeTxt2ImgPayload(generationTemplate, settings);
  const forgeResult = await callForgeTxt2Img(payload, settings);
  const firstImage = forgeResult.images?.[0];
  if (!firstImage) {
    throw new Error("Forge API 没有返回图片");
  }

  const imageDataUrl = firstImage.startsWith("data:")
    ? firstImage
    : `data:image/png;base64,${firstImage}`;
  const result = {
    imageDataUrl,
    info: forgeResult.info || "",
    character,
    prompt: mergedPrompt,
    payload,
    sourceTemplateName: template.fileName || ""
  };
  await saveLatestResult(result);
  return {
    character,
    prompt: mergedPrompt,
    imageDataUrl,
    info: forgeResult.info || ""
  };
}

async function requireTemplate() {
  const template = await getBaseTemplate();
  if (!template?.positive) {
    throw new Error("请先在扩展弹窗上传一张带 PNG info 的基础图");
  }
  return template;
}

async function pingForge() {
  const settings = await getSettings();
  const url = `${trimRight(settings.forgeApiUrl)}/sdapi/v1/options`;
  const response = await fetchWithTimeout(url, { method: "GET" }, 5000);
  if (!response.ok) {
    throw new Error(`Forge API 返回 ${response.status}`);
  }
  const data = await response.json();
  await setStatus({ phase: "idle", message: `Forge API 可用：${data.sd_model_checkpoint || "options ok"}` });
  return {
    model: data.sd_model_checkpoint || "",
    ok: true
  };
}

async function listForgeResources() {
  const settings = await getSettings();
  const base = trimRight(settings.forgeApiUrl);
  const [modelsResponse, upscalersResponse, optionsResponse] = await Promise.all([
    fetchWithTimeout(`${base}/sdapi/v1/sd-models`, { method: "GET" }, 10000),
    fetchWithTimeout(`${base}/sdapi/v1/upscalers`, { method: "GET" }, 10000),
    fetchWithTimeout(`${base}/sdapi/v1/options`, { method: "GET" }, 10000)
  ]);
  if (!modelsResponse.ok) {
    throw new Error(`模型列表返回 ${modelsResponse.status}`);
  }
  if (!upscalersResponse.ok) {
    throw new Error(`放大模型列表返回 ${upscalersResponse.status}`);
  }
  const models = await modelsResponse.json();
  const upscalers = await upscalersResponse.json();
  const options = optionsResponse.ok ? await optionsResponse.json() : {};
  return {
    currentModel: options.sd_model_checkpoint || "",
    models: models.map((model) => model.title || model.model_name).filter(Boolean),
    upscalers: upscalers.map((upscaler) => upscaler.name).filter(Boolean)
  };
}

async function testYisalbot() {
  const settings = await getSettings();
  const token = String(settings.yisalbotToken || "").trim();
  const chatId = String(settings.yisalbotChatId || "").trim();
  if (!token || !chatId) {
    throw new Error("Yisalbot Token 或 Chat ID 还没填");
  }

  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("text", `Forge Swapper 测试消息 ${new Date().toLocaleString("zh-CN")}`);
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    body: form
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`Yisalbot 测试失败：${data?.description || response.status}`);
  }
  await setStatus({ phase: "idle", message: "Yisalbot 测试消息已发送" });
  return { ok: true };
}

async function callForgeTxt2Img(payload, settings) {
  const url = `${trimRight(settings.forgeApiUrl)}/sdapi/v1/txt2img`;
  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    },
    settings.generationTimeoutMs
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Forge txt2img 返回 ${response.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

async function identifyCharacterWithLlm(imageDataUrl, settings, imageMeta = {}) {
  const url = llmChatCompletionsUrl(settings.llmBaseUrl);
  const request = buildIdentifyCharacterRequest({ imageDataUrl, settings, imageMeta });
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
    throw new Error(formatLlmHttpError(response.status, text, "LLM API"));
  }
  const content = extractChatMessageContent(text);
  return parseCharacterResponse(content);
}

function parseJsonObject(text) {
  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(`LLM 返回的不是 JSON: ${cleaned.slice(0, 300)}`);
    }
    return JSON.parse(match[0]);
  }
}

function sanitizePrompt(prompt) {
  return String(prompt || "")
    .replace(/\n+/g, ", ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/,\s*,+/g, ", ")
    .trim()
    .replace(/^,|,$/g, "");
}

async function getImageDataUrl(image) {
  if (image?.dataUrl?.startsWith("data:image/")) {
    return image.dataUrl;
  }
  if (image?.src?.startsWith("data:image/")) {
    return image.src;
  }
  if (!image?.src) {
    throw new Error("没有拿到图片地址");
  }
  const response = await fetchWithTimeout(
    image.src,
    {
      method: "GET",
      credentials: "include",
      cache: "force-cache"
    },
    30000
  );
  if (!response.ok) {
    throw new Error(`读取网页图片失败 ${response.status}`);
  }
  const blob = await response.blob();
  return blobToDataUrl(blob);
}

async function shrinkImageDataUrl(dataUrl, maxEdge = 1024) {
  try {
    if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
      return dataUrl;
    }
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) {
      return dataUrl;
    }
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0, width, height);
    const resized = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
    return blobToDataUrl(resized);
  } catch {
    return dataUrl;
  }
}

function blobToDataUrl(blob) {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
  });
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || 30000);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`请求超时：${url}`);
    }
    const message = error?.message || String(error);
    if (/failed to fetch|networkerror/i.test(message)) {
      throw new Error(`请求失败：${url}。请检查接口地址、网络/CORS、API Key 权限，当前 LLM Base URL 应类似 https://api.sysmeng.com/v1`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function updateProgress(tabId, phase, message) {
  await setStatus({ phase, message });
  sendTabToast(tabId, message, phase === "done" ? "success" : "info");
}

function sendTabToast(tabId, message, kind = "info") {
  if (!tabId) {
    return;
  }
  chrome.tabs.sendMessage(tabId, {
    type: "FORGE_SWAPPER_TOAST",
    message,
    kind
  }).catch(() => {});
}

async function downloadLatestResult() {
  const stored = await storageGet(STORAGE_KEYS.latestResult);
  const latest = stored[STORAGE_KEYS.latestResult];
  if (latest?.file?.downloadId || latest?.file?.filePath) {
    await showResultFile(latest.file.downloadId, latest.file.filePath);
    return latest.file;
  }
  if (!latest?.imageDataUrl) {
    throw new Error("还没有生成结果可保存");
  }
  const file = await saveResultFile(latest.imageDataUrl, {
    characterName: latest.character?.character_name || "",
    prefix: "manual"
  });
  await saveLatestResult({
    ...latest,
    file
  });
  return file;
}

async function saveResultFile(imageDataUrl, meta = {}) {
  if (!String(imageDataUrl || "").startsWith("data:image/")) {
    throw new Error("没有可保存的图片数据");
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const character = sanitizeFilenamePart(meta.characterName || "result");
  const prefix = sanitizeFilenamePart(meta.prefix || "forge-swapper");
  const filename = `Forge Swapper/${prefix}-${character}-${stamp}.png`;
  const id = await chrome.downloads.download({
    url: imageDataUrl,
    filename,
    conflictAction: "uniquify",
    saveAs: false
  });
  const item = await waitForDownloadItem(id);
  return downloadItemToFileInfo(item);
}

async function openResultFile(downloadId, filePath) {
  const item = await resolveDownloadItem(downloadId, filePath);
  if (!item?.id) {
    throw new Error("找不到硬盘图片文件");
  }
  await chrome.downloads.open(item.id);
  return downloadItemToFileInfo(item);
}

async function showResultFile(downloadId, filePath) {
  const item = await resolveDownloadItem(downloadId, filePath);
  if (!item?.id) {
    throw new Error("找不到硬盘图片文件");
  }
  await chrome.downloads.show(item.id);
  return downloadItemToFileInfo(item);
}

async function resolveDownloadItem(downloadId, filePath) {
  if (downloadId) {
    const byId = await chrome.downloads.search({ id: Number(downloadId) });
    if (byId[0]) {
      return byId[0];
    }
  }
  if (filePath) {
    const byFilename = await chrome.downloads.search({ filename: filePath });
    if (byFilename[0]) {
      return byFilename[0];
    }
  }
  return null;
}

async function waitForDownloadItem(id) {
  const started = Date.now();
  while (Date.now() - started < 120000) {
    const items = await chrome.downloads.search({ id });
    const item = items[0];
    if (item?.state === "complete") {
      return item;
    }
    if (item?.state === "interrupted") {
      throw new Error(`图片保存失败：${item.error || "download interrupted"}`);
    }
    await sleep(250);
  }
  throw new Error("图片保存超时");
}

function downloadItemToFileInfo(item) {
  return {
    downloadId: item.id,
    filePath: item.filename || "",
    fileUrl: item.filename ? pathToFileUrl(item.filename) : "",
    filename: item.filename || "",
    url: item.url || "",
    state: item.state || ""
  };
}

function pathToFileUrl(filePath) {
  const path = String(filePath || "").replace(/\\/g, "/");
  return path ? `file:///${encodeURI(path)}` : "";
}

function sanitizeFilenamePart(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "image";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimRight(value) {
  return String(value || "").replace(/\/+$/, "");
}
