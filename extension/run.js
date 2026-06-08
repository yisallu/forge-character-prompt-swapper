import { RUN_JOB_PREFIX, STORAGE_KEYS } from "./lib/defaults.js";
import {
  getBaseTemplate,
  getSettings,
  saveBaseTemplate,
  saveLastCharacter,
  saveLatestResult,
  setStatus,
  storageGet,
  storageSet
} from "./lib/storage.js";
import { buildForgeTxt2ImgPayload } from "./lib/forgePayload.js";
import { llmChatCompletionsUrl } from "./lib/llmEndpoint.js";
import { extractChatMessageContent, formatLlmHttpError } from "./lib/llmResponse.js";
import { joinPromptTags, removeUndesiredSkinToneTags, replacePromptSegment, splitPromptTags, stripGeneratedCharacterDetailsForDefault } from "./lib/promptMerge.js";
import { applyCharacterTagLimit } from "./lib/characterPromptLimit.js";
import {
  IDENTIFY_IMAGE_MAX_EDGE,
  buildIdentifyCharacterRequest,
  describeCharacterForLog,
  describeImageForLog,
  parseCharacterResponse
} from "./lib/characterIdentify.js";
import {
  applyTranslationCache,
  fetchLocalCsvTranslationsForTags,
  isTranslatablePromptTag,
  mergeTranslationsIntoCache,
  normalizeTagKey,
  translateTagsWithForgePlugin
} from "./lib/tagTranslations.js";
import {
  fetchVndbCharacterContext,
  formatVndbCharacterContext,
  mergeVndbContextIntoCharacter
} from "./lib/vndbCharacter.js";
import {
  fetchMudaeCharacterContext,
  formatMudaeCharacterContext,
  mergeMudaeContextIntoCharacter
} from "./lib/mudaeCharacter.js";

const elements = {
  jobMeta: document.getElementById("jobMeta"),
  phaseText: document.getElementById("phaseText"),
  progressText: document.getElementById("progressText"),
  progressBar: document.getElementById("progressBar"),
  characterName: document.getElementById("characterName"),
  pushState: document.getElementById("pushState"),
  templateName: document.getElementById("templateName"),
  sourceImage: document.getElementById("sourceImage"),
  resultImageLink: document.getElementById("resultImageLink"),
  resultImage: document.getElementById("resultImage"),
  refineFeedback: document.getElementById("refineFeedback"),
  promptOutput: document.getElementById("promptOutput"),
  activePromptTags: document.getElementById("activePromptTags"),
  inactivePromptTags: document.getElementById("inactivePromptTags"),
  addPromptTag: document.getElementById("addPromptTag"),
  characterPromptTags: document.getElementById("characterPromptTags"),
  characterPromptOutput: document.getElementById("characterPromptOutput"),
  addCharacterPromptTag: document.getElementById("addCharacterPromptTag"),
  tagLanguageEnglish: document.getElementById("tagLanguageEnglish"),
  tagLanguageChinese: document.getElementById("tagLanguageChinese"),
  logList: document.getElementById("logList"),
  regeneratePrompt: document.getElementById("regeneratePrompt"),
  refinePrompt: document.getElementById("refinePrompt"),
  saveDefaultPrompt: document.getElementById("saveDefaultPrompt"),
  copyPrompt: document.getElementById("copyPrompt"),
  openResultImage: document.getElementById("openResultImage"),
  downloadResult: document.getElementById("downloadResult"),
  openOptions: document.getElementById("openOptions")
};

const jobId = new URL(location.href).searchParams.get("jobId") || "";
let logs = [];
let finalPrompt = "";
let latestImageDataUrl = "";
let currentSettings = null;
let currentTemplate = null;
let currentCharacter = null;
let currentResult = null;
let latestImageObjectUrl = "";
let busy = false;
let savedPromptTagState = null;
let restoringPromptTags = false;
let applyingExternalPromptSync = false;
let savePromptTagStateTimer = null;
let promptTagState = {
  active: [],
  inactive: [],
  language: "en",
  translations: {},
  translationLoading: false,
  syncingTextarea: false
};
let characterTagState = {
  active: [],
  inactive: [],
  syncingTextarea: false
};

elements.regeneratePrompt.addEventListener("click", () => regenerateCurrentPrompt());
elements.refinePrompt.addEventListener("click", () => refinePromptAndRegenerate());
elements.saveDefaultPrompt.addEventListener("click", () => saveCurrentPromptAsDefault());
elements.copyPrompt.addEventListener("click", () => copyText(currentPromptText()));
elements.openResultImage.addEventListener("click", () => openResultImage());
elements.downloadResult.addEventListener("click", () => chrome.runtime.sendMessage({ type: "DOWNLOAD_LATEST_RESULT" }));
elements.openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
elements.addPromptTag.addEventListener("click", () => addPromptTag());
elements.addCharacterPromptTag.addEventListener("click", () => addCharacterPromptTag());
elements.tagLanguageEnglish.addEventListener("click", () => setTagLanguage("en").catch((error) => log("error", error?.message || String(error))));
elements.tagLanguageChinese.addEventListener("click", () => setTagLanguage("zh").catch((error) => log("error", error?.message || String(error))));
elements.promptOutput.addEventListener("input", () => {
  if (promptTagState.syncingTextarea) {
    return;
  }
  setPromptTagsFromText(elements.promptOutput.value, { preserveInactive: true });
  finalPrompt = currentPromptText();
});
elements.characterPromptOutput.addEventListener("input", () => {
  if (characterTagState.syncingTextarea) {
    return;
  }
  setCharacterPromptTagsFromText(elements.characterPromptOutput.value, { preserveInactive: true });
  finalPrompt = currentPromptText();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  if (changes[STORAGE_KEYS.activePromptSync]) {
    applyExternalPromptSync(changes[STORAGE_KEYS.activePromptSync].newValue)
      .catch((error) => log("error", `同步 popup 提示词失败：${error?.message || error}`));
  }
  if (changes[STORAGE_KEYS.baseTemplate]) {
    applyExternalBaseTemplate(changes[STORAGE_KEYS.baseTemplate].newValue)
      .catch((error) => log("error", `同步基础模板失败：${error?.message || error}`));
  }
});

run().catch((error) => fail(error));

async function run() {
  if (!jobId) {
    throw new Error("缺少 jobId");
  }

  const job = await readJob();
  elements.jobMeta.textContent = `${jobId.slice(0, 8)} · ${new Date(job.createdAt || Date.now()).toLocaleString("zh-CN")}`;
  await log("info", "生成标签页已打开");

  const settings = await getSettings();
  const template = await requireTemplate();
  currentSettings = settings;
  currentTemplate = template;
  await loadTagTranslationCache();
  await loadSavedPromptTagState();
  elements.templateName.textContent = template.fileName || "基础模板";
  if (template.cleanedWithLlmAt) {
    await log("success", `基础模板有 LLM 清理记录：${template.llmCleanModel || "LLM"} · HTTP ${template.llmCleanHttpStatus || "?"} · 移除 ${template.llmCleanRemovedTagCount || "?"} 个标签 · ${new Date(template.cleanedWithLlmAt).toLocaleString("zh-CN")}`);
  } else {
    await log("info", "基础模板没有 LLM 清理记录");
  }

  let character = null;
  let sourceDataUrl = "";
  if (job.input?.mode === "lastCharacter") {
    await step("读取最近角色", 12);
    const stored = await storageGet(STORAGE_KEYS.lastCharacter);
    character = stored[STORAGE_KEYS.lastCharacter];
    if (!character?.character_prompt) {
      throw new Error("还没有最近一次角色识别结果");
    }
  } else {
    if (!settings.llmApiKey) {
      throw new Error("还没有在扩展选项里填写 api.sysmeng.com 的 API key");
    }
    const imageMeta = job.input?.image || {};
    await step("读取鼠标下图片", 8);
    sourceDataUrl = await getImageDataUrl(imageMeta);
    elements.sourceImage.src = sourceDataUrl;
    elements.sourceImage.hidden = false;
    await enrichImageMetaFromLinkedPage(imageMeta);
    await log("info", `图片线索：${describeImageForLog(imageMeta)}`);

    const llmImage = await prepareImageForRecognition(sourceDataUrl);

    await step("调用 LLM 识别角色", 22);
    character = await identifyCharacterWithLlm(llmImage, settings, imageMeta);
    character = mergeVndbContextIntoCharacter(character, imageMeta.vndbCharacter);
    character = mergeMudaeContextIntoCharacter(character, imageMeta.mudaeCharacter);
  }

  character = await applyCharacterTagLimitForRun(character, settings);
  await saveLastCharacter(character);

  elements.characterName.textContent = character.character_name || character.visual_prompt || character.character_prompt || "未知角色";
  currentCharacter = character;
  await log("info", `识别结果：${describeCharacterForLog(character)}`);
  await log("success", `角色提示词：${character.character_prompt}`);

  await step("替换基础提示词角色段", 30);
  setCharacterPromptText(character.character_prompt || character.visual_prompt || character.character_name || "");
  setBasePromptText(basePromptWithoutCharacterDetails(template, character));

  await generatePromptImage(currentPromptText(), template, settings, character, "提交 Forge txt2img");
  await complete();
}

async function applyCharacterTagLimitForRun(character, settings) {
  const result = applyCharacterTagLimit(character, settings);
  if (!result.applied) {
    await log("info", "角色标签限制未启用");
    return character;
  }
  const before = splitPromptTags(result.originalPrompt).length;
  const after = splitPromptTags(result.limitedPrompt).length;
  await log("info", `角色标签限制：${before} -> ${after} 个，当前：${result.limitedPrompt}${result.removedPrompt ? `；移除：${result.removedPrompt}` : ""}`);
  return result.character;
}

async function generatePromptImage(prompt, template, settings, character, submitMessage) {
  setBusy(true);
  prompt = await applyGenerationPromptGuards(prompt);
  const payload = buildForgeTxt2ImgPayload({ ...template, positive: prompt }, settings);
  await log("info", `Forge 参数：${payload.width || "?"}x${payload.height || "?"} · steps ${payload.steps || "?"} · sampler ${payload.sampler_name || "?"} · ${payload.enable_hr ? `放大 ${payload.hr_scale || "?"}x · ${payload.hr_upscaler || "默认"}` : "不放大"} · 模型 ${settings.sdModelCheckpoint || "Forge 当前"} · seed 随机`);

  await step(submitMessage, 36);
  const forgeResult = await callForgeTxt2ImgWithProgress(payload, settings);
  const firstImage = forgeResult.images?.[0];
  if (!firstImage) {
    throw new Error("Forge API 没有返回图片");
  }

  latestImageDataUrl = firstImage.startsWith("data:") ? firstImage : `data:image/png;base64,${firstImage}`;
  await showResultImage(latestImageDataUrl);
  elements.sourceImage.hidden = true;
  document.body.classList.add("result-ready");
  elements.resultImage.scrollIntoView({ block: "center" });

  const result = {
    imageDataUrl: latestImageDataUrl,
    info: forgeResult.info || "",
    character,
    prompt,
    payload,
    sourceTemplateName: template.fileName || ""
  };
  currentResult = result;
  await saveLatestResult(result);
  await step("Forge 图片已返回", 92);

  await pushYisalbotIfConfigured(result, settings);
  setBusy(false);
}

async function applyGenerationPromptGuards(prompt) {
  const cleanCharacter = removeUndesiredSkinToneTags(currentCharacterPromptText());
  const cleanBase = removeUndesiredSkinToneTags(currentBasePromptText());
  if (cleanCharacter !== currentCharacterPromptText()) {
    setCharacterPromptText(cleanCharacter);
  }
  if (cleanBase !== currentBasePromptText()) {
    setBasePromptText(cleanBase);
  }
  const cleaned = currentPromptText();
  if (cleaned === prompt) {
    return prompt;
  }

  finalPrompt = cleaned;
  await log("info", "已移除会导致皮肤发白的标签：pale skin / white skin / fair skin 等");
  return cleaned;
}

async function regenerateCurrentPrompt() {
  if (busy) {
    await log("info", "当前还在生成，等这轮完成后再重新生成");
    return;
  }
  const prompt = currentPromptText();
  if (!prompt || !currentTemplate || !currentSettings) {
    await log("error", "还没有可重新生成的提示词");
    return;
  }

  try {
    setBusy(true);
    await log("info", "使用当前提示词重新生成，不调用 LLM");
    await generatePromptImage(prompt, currentTemplate, currentSettings, currentCharacter, "重新生成当前提示词");
    await complete();
  } catch (error) {
    await fail(error);
  } finally {
    setBusy(false);
  }
}

async function saveCurrentPromptAsDefault() {
  const prompt = currentBasePromptText();
  if (!prompt || !currentTemplate) {
    await log("error", "还没有可保存的默认提示词");
    return;
  }
  const defaultPrompt = promptForDefaultTemplate(prompt, currentTemplate);
  currentTemplate = {
    ...currentTemplate,
    positive: defaultPrompt.positive,
    characterSegment: defaultPrompt.characterSegment
  };
  await saveBaseTemplate(currentTemplate);
  elements.templateName.textContent = currentTemplate.fileName || "基础模板";
  await log("success", "已设为默认提示词：只保存基础提示词，角色提示词/外观/衣服没有写入默认");
}

async function applyExternalPromptSync(state) {
  if (!state || state.jobId !== jobId || state.source === "run" || applyingExternalPromptSync) {
    return;
  }
  applyingExternalPromptSync = true;
  try {
    characterTagState.active = syncTagsFromState(state.characterActive, state.characterPrompt).map(createPromptTag);
    characterTagState.inactive = normalizeSavedTagList(state.characterInactive).map(createPromptTag);
    promptTagState.active = syncTagsFromState(state.active, state.basePrompt).map(createPromptTag);
    promptTagState.inactive = normalizeSavedTagList(state.inactive).map(createPromptTag);
    promptTagState.language = state.language === "zh" ? "zh" : promptTagState.language;
    removeInactiveTagsThatAreActive();
    removeCharacterInactiveTagsThatAreActive();
    syncCharacterPromptTextarea(joinPromptTags(characterTagState.active.map((tag) => tag.text)));
    syncPromptTextarea(joinPromptTags(promptTagState.active.map((tag) => tag.text)));
    finalPrompt = currentPromptText();
    renderPromptTags();
  } finally {
    applyingExternalPromptSync = false;
  }
  await savePromptTagState();
  await log("success", "已从 popup 同步当前提示词");
}

async function applyExternalBaseTemplate(template) {
  if (!template?.positive || applyingExternalPromptSync) {
    return;
  }
  currentTemplate = {
    ...(currentTemplate || {}),
    ...template
  };
  elements.templateName.textContent = currentTemplate.fileName || "基础模板";
  if (!currentCharacter) {
    return;
  }
  const nextBasePrompt = basePromptWithoutCharacterDetails(currentTemplate, currentCharacter);
  if (normalizePromptForCompare(nextBasePrompt) === normalizePromptForCompare(currentBasePromptText())) {
    return;
  }
  setBasePromptText(nextBasePrompt);
  await log("success", "已从 popup 同步基础提示词");
}

async function readJob() {
  const key = `${RUN_JOB_PREFIX}${jobId}`;
  const stored = await storageGet(key);
  const job = stored[key];
  if (!job) {
    throw new Error("找不到生成任务，可能是扩展存储被清理了");
  }
  return job;
}

async function requireTemplate() {
  const template = await getBaseTemplate();
  if (!template?.positive) {
    throw new Error("请先在扩展弹窗上传一张带 PNG info 的基础图");
  }
  return template;
}

async function identifyCharacterWithLlm(imageDataUrl, settings, imageMeta = {}) {
  const url = llmChatCompletionsUrl(settings.llmBaseUrl);
  await log("info", `LLM 请求：${url} · model ${settings.llmModel}`);
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

async function enrichImageMetaFromLinkedPage(imageMeta) {
  if (imageMeta?.vndbCharacter) {
    imageMeta.vndbCharacterText ||= formatVndbCharacterContext(imageMeta.vndbCharacter);
    await log("success", `已使用原页面读取的 VNDB 角色页：${imageMeta.vndbCharacter.name || imageMeta.vndbCharacter.originalName}`);
    return;
  }
  if (imageMeta?.mudaeCharacter) {
    imageMeta.mudaeCharacterText ||= formatMudaeCharacterContext(imageMeta.mudaeCharacter);
    await log("success", `已使用原页面读取的 Mudae 角色页：${imageMeta.mudaeCharacter.name}`);
    return;
  }
  if (imageMeta?.vndbCharacterError) {
    await log("error", `原页面读取 VNDB 角色页失败：${imageMeta.vndbCharacterError}`);
    return;
  }
  if (imageMeta?.mudaeCharacterError) {
    await log("error", `原页面读取 Mudae 角色页失败：${imageMeta.mudaeCharacterError}`);
    return;
  }
  if (!imageMeta?.linkUrl) {
    return;
  }

  try {
    const context = await fetchVndbCharacterContext(imageMeta.linkUrl);
    if (!context) {
      return;
    }
    imageMeta.vndbCharacter = context;
    imageMeta.vndbCharacterText = formatVndbCharacterContext(context);
    await log("success", `已读取 VNDB 角色页：${context.name || context.originalName}`);
  } catch (error) {
    await log("error", `读取 VNDB 角色页失败：${error?.message || error}`);
  }

  try {
    const context = await fetchMudaeCharacterContext(imageMeta.linkUrl);
    if (!context) {
      return;
    }
    imageMeta.mudaeCharacter = context;
    imageMeta.mudaeCharacterText = formatMudaeCharacterContext(context);
    await log("success", `已读取 Mudae 角色页：${context.name}`);
  } catch (error) {
    await log("error", `读取 Mudae 角色页失败：${error?.message || error}`);
  }
}

async function prepareImageForRecognition(dataUrl) {
  const size = await getDataUrlImageSize(dataUrl).catch(() => null);
  if (size && Math.max(size.width, size.height) <= IDENTIFY_IMAGE_MAX_EDGE) {
    await step(`准备识别图片：${size.width}x${size.height}，无需压缩`, 14);
    return dataUrl;
  }

  await step(
    size
      ? `准备识别图片：${size.width}x${size.height}，缩小到 ${IDENTIFY_IMAGE_MAX_EDGE}px 内`
      : "准备识别图片",
    14
  );
  return shrinkImageDataUrl(dataUrl, IDENTIFY_IMAGE_MAX_EDGE);
}

async function callForgeTxt2ImgWithProgress(payload, settings) {
  const base = trimRight(settings.forgeApiUrl);
  const txt2imgUrl = `${base}/sdapi/v1/txt2img`;
  let polling = true;
  let lastLoggedPercent = -1;

  const pollLoop = (async () => {
    while (polling) {
      try {
        const progressResponse = await fetch(`${base}/sdapi/v1/progress?skip_current_image=true`, {
          method: "GET",
          cache: "no-store"
        });
        if (progressResponse.ok) {
          const progressData = await progressResponse.json();
          const percent = Math.max(0, Math.min(100, Math.round((progressData.progress || 0) * 100)));
          updateProgress(percent, etaText(progressData.eta_relative));
          if (percent >= 0 && Math.abs(percent - lastLoggedPercent) >= 10) {
            lastLoggedPercent = percent;
            await log("info", `Forge 进度 ${percent}%${etaText(progressData.eta_relative, " · ")}`);
          }
        }
      } catch {}
      await sleep(Number(settings.progressPollMs) || 2000);
    }
  })();

  try {
    await log("info", `Forge 请求：${txt2imgUrl}`);
    const response = await fetchWithTimeout(
      txt2imgUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      },
      settings.generationTimeoutMs
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Forge txt2img 返回 ${response.status}: ${text.slice(0, 500)}`);
    }
    return JSON.parse(text);
  } finally {
    polling = false;
    await pollLoop.catch(() => {});
  }
}

async function pushYisalbotIfConfigured(result, settings) {
  const token = String(settings.yisalbotToken || "").trim();
  const chatId = String(settings.yisalbotChatId || "").trim();
  if (!token || !chatId) {
    elements.pushState.textContent = "未配置";
    await log("info", "Yisalbot 未配置，跳过推送");
    return;
  }

  elements.pushState.textContent = "推送中";
  await step("推送图片到 Yisalbot", 96);
  try {
    const blob = await dataUrlToBlob(result.imageDataUrl);
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("caption", yisalbotCaption(result));
    form.append("photo", blob, "forge-swapper.png");
    const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      body: form
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      throw new Error(data?.description || `HTTP ${response.status}`);
    }
    elements.pushState.textContent = "已推送";
    await log("success", "Yisalbot 推送成功");
  } catch (error) {
    elements.pushState.textContent = "失败";
    await log("error", `Yisalbot 推送失败：${error?.message || error}`);
  }
}

async function refinePromptAndRegenerate() {
  if (busy) {
    await log("info", "当前还在生成，等这轮完成后再改提示词");
    return;
  }
  const prompt = currentPromptText();
  if (!latestImageDataUrl || !prompt || !currentTemplate || !currentSettings) {
    await log("error", "还没有可改的生成结果");
    return;
  }
  if (!currentSettings.llmApiKey) {
    await log("error", "还没有在扩展选项里填写 api.sysmeng.com 的 API key");
    return;
  }

  setBusy(true);
  try {
    const feedback = elements.refineFeedback.value.trim();
    await step("让 LLM 改提示词", 12);
    const refined = await refinePromptWithLlm({
      imageDataUrl: await shrinkImageDataUrl(latestImageDataUrl),
      prompt,
      feedback,
      settings: currentSettings,
      character: currentCharacter,
      result: currentResult
    });
    finalPrompt = refined.positive_prompt;
    setCombinedPromptText(finalPrompt);
    await log("success", `LLM 改写说明：${refined.reason || "已优化提示词"}`);
    await generatePromptImage(finalPrompt, currentTemplate, currentSettings, currentCharacter, "用改过的提示词重生成");
    await complete();
  } catch (error) {
    await fail(error);
  } finally {
    setBusy(false);
  }
}

async function showResultImage(dataUrl) {
  if (latestImageObjectUrl) {
    URL.revokeObjectURL(latestImageObjectUrl);
  }
  const blob = await dataUrlToBlob(dataUrl);
  latestImageObjectUrl = URL.createObjectURL(blob);
  elements.resultImage.src = latestImageObjectUrl;
  elements.resultImageLink.href = latestImageObjectUrl;
  elements.resultImageLink.hidden = false;
}

async function openResultImage() {
  if (!latestImageObjectUrl) {
    await log("error", "还没有图片可打开");
    return;
  }
  window.open(latestImageObjectUrl, "_blank", "noopener");
}

async function refinePromptWithLlm({ imageDataUrl, prompt, feedback, settings, character, result }) {
  const url = llmChatCompletionsUrl(settings.llmBaseUrl);
  await log("info", `LLM 改提示词请求：${url} · model ${settings.llmModel}`);
  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${settings.llmApiKey}`
      },
      body: JSON.stringify({
        model: settings.llmModel,
        temperature: 0.35,
        messages: [
          {
            role: "system",
            content: [
              "You refine Stable Diffusion positive prompts for anime/game character images.",
              "Return JSON only with keys: positive_prompt, reason.",
              "Keep the same character identity, LoRA tags, quality/style tags, camera/composition intent, and useful scene tags unless the user feedback asks otherwise.",
              "Do not add negative prompt text. Do not remove important LoRA tags. Use comma-separated tags."
            ].join(" ")
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  "请根据这张生成结果和我的反馈，改写正向提示词，让下一张更好。",
                  `角色: ${character?.character_name || character?.character_prompt || "未知"}`,
                  `当前正向提示词: ${prompt}`,
                  `用户反馈: ${feedback || "图片不够好，请增强角色准确度、脸部质量、自然度和画面稳定性，同时保持原始构图/风格。"}`
                ].join("\n")
              },
              {
                type: "image_url",
                image_url: { url: imageDataUrl }
              }
            ]
          }
        ]
      })
    },
    settings.llmTimeoutMs
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(formatLlmHttpError(response.status, text, "LLM 改提示词"));
  }
  const content = extractChatMessageContent(text);
  const parsed = parseJsonObject(content);
  const positivePrompt = sanitizePrompt(parsed.positive_prompt || parsed.prompt || "");
  if (!positivePrompt) {
    throw new Error("LLM 没有返回可用的改写提示词");
  }
  return {
    positive_prompt: positivePrompt,
    reason: String(parsed.reason || "").trim()
  };
}

function yisalbotCaption(result) {
  const character = result.character?.character_name || result.character?.character_prompt || "未知角色";
  const seed = result.payload?.seed ?? "";
  const size = result.payload?.width && result.payload?.height ? `${result.payload.width}x${result.payload.height}` : "";
  const prompt = String(result.prompt || "").slice(0, 700);
  return [`Forge Swapper`, character, [size, seed ? `seed ${seed}` : ""].filter(Boolean).join(" · "), prompt]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1024);
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
  return blobToDataUrl(await response.blob());
}

async function shrinkImageDataUrl(dataUrl, maxEdge = 1024) {
  try {
    const image = await loadImage(dataUrl);
    const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
    if (scale >= 1) {
      return dataUrl;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    return dataUrl;
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片压缩预览加载失败"));
    image.src = src;
  });
}

async function getDataUrlImageSize(dataUrl) {
  const image = await loadImage(dataUrl);
  return {
    width: image.naturalWidth || image.width || 0,
    height: image.naturalHeight || image.height || 0
  };
}

async function dataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob();
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
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
      throw new Error(`请求失败：${url}。请检查接口地址、网络/CORS、API Key 权限，当前 LLM Base URL 应类似 https://api.sysmeng.com/v1`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonObject(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
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

async function step(message, percent) {
  elements.phaseText.textContent = message;
  updateProgress(percent);
  await setStatus({ phase: "running", message, jobId });
  await log("info", message);
}

async function complete() {
  updateProgress(100);
  elements.phaseText.textContent = "完成";
  await setStatus({ phase: "done", message: "图片生成完成", jobId });
  await log("success", "任务完成");
  setBusy(false);
}

async function fail(error) {
  const message = error?.message || String(error);
  elements.phaseText.textContent = "失败";
  elements.progressText.textContent = "失败";
  elements.progressBar.classList.add("danger");
  await setStatus({ phase: "error", message, jobId });
  await log("error", message);
  setBusy(false);
}

function setBusy(value) {
  busy = value;
  elements.regeneratePrompt.disabled = value;
  elements.refinePrompt.disabled = value;
  elements.saveDefaultPrompt.disabled = value && !currentBasePromptText();
  elements.copyPrompt.disabled = value && !currentPromptText();
  elements.openResultImage.disabled = value && !latestImageObjectUrl;
  elements.downloadResult.disabled = value && !latestImageDataUrl;
}

function currentPromptText() {
  const prompt = joinPromptTags([
    currentCharacterPromptText(),
    currentBasePromptText()
  ]);
  finalPrompt = prompt;
  return prompt;
}

function currentCharacterPromptText() {
  const prompt = characterTagState.active.length || characterTagState.inactive.length
    ? joinPromptTags(characterTagState.active.map((tag) => tag.text))
    : elements.characterPromptOutput.value.trim();
  syncCharacterPromptTextarea(prompt);
  return prompt;
}

function currentBasePromptText() {
  const prompt = promptTagState.active.length || promptTagState.inactive.length
    ? joinPromptTags(promptTagState.active.map((tag) => tag.text))
    : elements.promptOutput.value.trim();
  syncPromptTextarea(prompt);
  return prompt;
}

function setBasePromptText(prompt) {
  const basePrompt = normalizePromptText(prompt);
  syncPromptTextarea(basePrompt);
  if (savedPromptTagState && canRestoreSavedPromptTagState(savedPromptTagState)) {
    restorePromptTagState(savedPromptTagState);
    savedPromptTagState = null;
    return;
  }
  savedPromptTagState = null;
  setPromptTagsFromText(basePrompt, { clearInactive: true });
  finalPrompt = currentPromptText();
}

function setCharacterPromptText(prompt) {
  const characterPrompt = normalizePromptText(prompt);
  syncCharacterPromptTextarea(characterPrompt);
  setCharacterPromptTagsFromText(characterPrompt, { clearInactive: true });
  finalPrompt = currentPromptText();
}

function setCombinedPromptText(prompt) {
  const refinedPrompt = normalizePromptText(prompt);
  const previousBasePrompt = currentBasePromptText();
  const previousCharacterPrompt = currentCharacterPromptText();
  const basePrompt = stripGeneratedCharacterDetailsForDefault(refinedPrompt, {
    character: currentCharacter,
    templatePositive: previousBasePrompt,
    baseCharacterSegment: ""
  });
  const removedTags = tagsRemovedFromPrompt(refinedPrompt, basePrompt)
    .filter((tag) => isRuntimeCharacterTag(tag));
  const nextCharacterPrompt = joinPromptTags(uniqueTagTexts([
    ...splitPromptTags(previousCharacterPrompt),
    ...removedTags
  ]));

  setCharacterPromptText(nextCharacterPrompt || previousCharacterPrompt);
  setBasePromptText(basePrompt || refinedPrompt);
  finalPrompt = currentPromptText();
}

function setPromptTagsFromText(prompt, { clearInactive = false, preserveInactive = false, persist = true } = {}) {
  promptTagState.active = splitPromptTags(prompt).map(createPromptTag);
  if (clearInactive) {
    promptTagState.inactive = [];
  } else if (preserveInactive) {
    removeInactiveTagsThatAreActive();
  }
  renderPromptTags();
  if (persist) {
    scheduleSavePromptTagState();
  }
}

function setCharacterPromptTagsFromText(prompt, { clearInactive = false, preserveInactive = false, persist = true } = {}) {
  characterTagState.active = splitPromptTags(prompt).map(createPromptTag);
  if (clearInactive) {
    characterTagState.inactive = [];
  } else if (preserveInactive) {
    removeCharacterInactiveTagsThatAreActive();
  }
  renderPromptTags();
  if (persist) {
    scheduleSavePromptTagState();
  }
}

function createPromptTag(text) {
  const tagText = String(text || "").trim();
  return {
    id: `tag-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`,
    text: tagText,
    zh: promptTagState.translations[normalizeTagKey(tagText)] || ""
  };
}

function renderPromptTags() {
  elements.tagLanguageEnglish.classList.toggle("active", promptTagState.language === "en");
  elements.tagLanguageChinese.classList.toggle("active", promptTagState.language === "zh");
  elements.tagLanguageChinese.disabled = promptTagState.translationLoading;
  renderTagList(elements.characterPromptTags, characterTagState.active, {
    role: true,
    emptyText: "无角色标签",
    onEdit: editCharacterPromptTag,
    onDisable: disableCharacterPromptTag
  });
  renderTagList(elements.activePromptTags, promptTagState.active, {
    emptyText: "无基础标签",
    onEdit: editPromptTag,
    onDisable: disablePromptTag
  });
  renderTagList(elements.inactivePromptTags, inactivePromptTagsForDisplay(), {
    inactive: true,
    emptyText: "无未启用标签",
    onEnable: enableInactivePromptTag
  });
}

function renderTagList(container, tags, options) {
  container.textContent = "";
  if (!tags.length) {
    const empty = document.createElement("span");
    empty.className = "tag-empty";
    empty.textContent = options.emptyText;
    container.append(empty);
    return;
  }

  for (const tag of tags) {
    const item = document.createElement("span");
    item.className = [
      "prompt-tag",
      options.inactive ? "tag-inactive" : "",
      options.role || tag.scope === "character" ? "tag-role" : ""
    ].filter(Boolean).join(" ");

    const label = document.createElement("button");
    label.type = "button";
    label.className = "tag-label";
    label.textContent = options.inactive && tag.scope === "character"
      ? `角色: ${displayTagText(tag)}`
      : displayTagText(tag);
    const scopeText = options.role || tag.scope === "character" ? "角色标签" : "基础标签";
    label.title = options.inactive ? `启用${scopeText}：${tag.text}` : `修改${scopeText}：${tag.text}`;
    label.addEventListener("click", () => {
      if (options.inactive) {
        options.onEnable?.(tag);
      } else {
        options.onEdit?.(tag.id);
      }
    });
    item.append(label);

    if (!options.inactive && options.onDisable) {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "tag-close";
      close.textContent = "×";
      close.title = "关闭标签";
      close.setAttribute("aria-label", `关闭 ${tag.text}`);
      close.addEventListener("click", () => options.onDisable(tag.id));
      item.append(close);
    }

    container.append(item);
  }
}

function inactivePromptTagsForDisplay() {
  return [
    ...characterTagState.inactive.map((tag) => ({ ...tag, scope: "character" })),
    ...promptTagState.inactive.map((tag) => ({ ...tag, scope: "base" }))
  ];
}

function addPromptTag() {
  const text = window.prompt("新增标签", "");
  const tagText = String(text || "").trim();
  if (!tagText) {
    return;
  }
  promptTagState.active.push(createPromptTag(tagText));
  syncPromptFromTags();
}

function addCharacterPromptTag() {
  const text = window.prompt("新增角色标签", "");
  const tagText = String(text || "").trim();
  if (!tagText) {
    return;
  }
  characterTagState.active.push(createPromptTag(tagText));
  syncCharacterPromptFromTags();
}

function editPromptTag(id) {
  const tag = promptTagState.active.find((item) => item.id === id);
  if (!tag) {
    return;
  }
  const next = window.prompt("修改标签", tag.text);
  if (next === null) {
    return;
  }
  const text = String(next).trim();
  if (!text) {
    disablePromptTag(id);
    return;
  }
  tag.text = text;
  tag.zh = promptTagState.translations[normalizeTagKey(text)] || "";
  syncPromptFromTags();
  if (promptTagState.language === "zh") {
    translateMissingPromptTags().catch((error) => log("error", error?.message || String(error)));
  }
}

function editCharacterPromptTag(id) {
  const tag = characterTagState.active.find((item) => item.id === id);
  if (!tag) {
    return;
  }
  const next = window.prompt("修改角色标签", tag.text);
  if (next === null) {
    return;
  }
  const text = String(next).trim();
  if (!text) {
    disableCharacterPromptTag(id);
    return;
  }
  tag.text = text;
  tag.zh = promptTagState.translations[normalizeTagKey(text)] || "";
  syncCharacterPromptFromTags();
  if (promptTagState.language === "zh") {
    translateMissingPromptTags().catch((error) => log("error", error?.message || String(error)));
  }
}

function disablePromptTag(id) {
  const index = promptTagState.active.findIndex((tag) => tag.id === id);
  if (index < 0) {
    return;
  }
  const [tag] = promptTagState.active.splice(index, 1);
  promptTagState.inactive.push(tag);
  syncPromptFromTags();
}

function disableCharacterPromptTag(id) {
  const index = characterTagState.active.findIndex((tag) => tag.id === id);
  if (index < 0) {
    return;
  }
  const [tag] = characterTagState.active.splice(index, 1);
  characterTagState.inactive.push(tag);
  syncCharacterPromptFromTags();
}

function enablePromptTag(id) {
  const index = promptTagState.inactive.findIndex((tag) => tag.id === id);
  if (index < 0) {
    return;
  }
  const [tag] = promptTagState.inactive.splice(index, 1);
  promptTagState.active.push(tag);
  syncPromptFromTags();
}

function enableCharacterPromptTag(id) {
  const index = characterTagState.inactive.findIndex((tag) => tag.id === id);
  if (index < 0) {
    return;
  }
  const [tag] = characterTagState.inactive.splice(index, 1);
  characterTagState.active.push(tag);
  syncCharacterPromptFromTags();
}

function enableInactivePromptTag(tag) {
  if (tag.scope === "character") {
    enableCharacterPromptTag(tag.id);
    return;
  }
  enablePromptTag(tag.id);
}

function syncPromptFromTags() {
  const prompt = joinPromptTags(promptTagState.active.map((tag) => tag.text));
  syncPromptTextarea(prompt);
  finalPrompt = currentPromptText();
  renderPromptTags();
  savePromptTagState().catch((error) => console.warn("保存标签状态失败", error));
}

function syncCharacterPromptFromTags() {
  const prompt = joinPromptTags(characterTagState.active.map((tag) => tag.text));
  syncCharacterPromptTextarea(prompt);
  finalPrompt = currentPromptText();
  renderPromptTags();
  savePromptTagState().catch((error) => console.warn("保存标签状态失败", error));
}

function removeInactiveTagsThatAreActive() {
  const activeKeys = new Set(promptTagState.active.map((tag) => normalizeTagKey(tag.text)));
  promptTagState.inactive = promptTagState.inactive.filter((tag) => !activeKeys.has(normalizeTagKey(tag.text)));
}

function removeCharacterInactiveTagsThatAreActive() {
  const activeKeys = new Set(characterTagState.active.map((tag) => normalizeTagKey(tag.text)));
  characterTagState.inactive = characterTagState.inactive.filter((tag) => !activeKeys.has(normalizeTagKey(tag.text)));
}

async function setTagLanguage(language) {
  if (promptTagState.language === language && language !== "zh") {
    return;
  }
  promptTagState.language = language;
  renderPromptTags();
  scheduleSavePromptTagState();
  if (language !== "zh") {
    return;
  }
  await translateMissingPromptTags();
}

async function translateMissingPromptTags() {
  applyTranslationCache(allPromptTags(), promptTagState.translations);
  const tags = allPromptTags().filter((tag) => tag.text && !tag.zh && isTranslatablePromptTag(tag.text));
  if (!tags.length) {
    renderPromptTags();
    return;
  }

  promptTagState.translationLoading = true;
  renderPromptTags();
  try {
    await log("info", `读取本地标签翻译缓存：缺失 ${tags.length} 个`);
    const localTranslations = await fetchLocalCsvTranslationsForTags(tags.map((tag) => tag.text), currentSettings).catch((error) => {
      log("error", `读取 Forge CSV 翻译失败：${error?.message || error}`);
      return {};
    });
    const localCount = mergeTranslationsIntoCache(promptTagState.translations, localTranslations);
    applyTranslationCache(allPromptTags(), promptTagState.translations);

    const stillMissing = allPromptTags().filter((tag) => tag.text && !tag.zh && isTranslatablePromptTag(tag.text));
    let forgeCount = 0;
    if (stillMissing.length) {
      const forgeTranslations = await translateTagsWithForgePlugin(stillMissing.map((tag) => tag.text), currentSettings);
      forgeCount = mergeTranslationsIntoCache(promptTagState.translations, forgeTranslations);
      applyTranslationCache(allPromptTags(), promptTagState.translations);
    }
    await saveTagTranslationCache();
    await log("success", `标签中文显示已更新：本地词库 ${localCount} 个，Forge 翻译缓存 ${forgeCount} 个；生成仍使用英文标签`);
  } finally {
    promptTagState.translationLoading = false;
    renderPromptTags();
  }
}

function allPromptTags() {
  return [
    ...characterTagState.active,
    ...promptTagState.active,
    ...characterTagState.inactive,
    ...promptTagState.inactive
  ];
}

async function loadSavedPromptTagState() {
  const key = promptTagStateStorageKey();
  const stored = await storageGet(key);
  savedPromptTagState = normalizeSavedPromptTagState(stored[key]);
}

function restorePromptTagState(state) {
  restoringPromptTags = true;
  try {
    const scoped = splitSavedPromptTagScopes(state);
    characterTagState.active = scoped.characterActive.map(createPromptTag);
    characterTagState.inactive = scoped.characterInactive.map(createPromptTag);
    promptTagState.active = scoped.active.map(createPromptTag);
    promptTagState.inactive = scoped.inactive.map(createPromptTag);
    promptTagState.language = state.language || promptTagState.language;
    removeInactiveTagsThatAreActive();
    removeCharacterInactiveTagsThatAreActive();
    syncCharacterPromptTextarea(joinPromptTags(characterTagState.active.map((tag) => tag.text)));
    syncPromptTextarea(joinPromptTags(promptTagState.active.map((tag) => tag.text)));
    finalPrompt = currentPromptText();
    renderPromptTags();
  } finally {
    restoringPromptTags = false;
  }
  scheduleSavePromptTagState();
}

function canRestoreSavedPromptTagState(state) {
  if (!state || !state.active.length && !state.inactive.length && !state.characterActive.length && !state.characterInactive.length) {
    return false;
  }
  if (state.jobId && state.jobId !== jobId) {
    return false;
  }
  return true;
}

function scheduleSavePromptTagState() {
  if (restoringPromptTags || applyingExternalPromptSync || !jobId) {
    return;
  }
  clearTimeout(savePromptTagStateTimer);
  savePromptTagStateTimer = setTimeout(() => {
    savePromptTagState().catch((error) => console.warn("保存标签状态失败", error));
  }, 120);
}

async function savePromptTagState() {
  const key = promptTagStateStorageKey();
  const characterActive = characterTagState.active.map((tag) => tag.text).filter(Boolean);
  const characterInactive = characterTagState.inactive.map((tag) => tag.text).filter(Boolean);
  const active = promptTagState.active.map((tag) => tag.text).filter(Boolean);
  const inactive = promptTagState.inactive.map((tag) => tag.text).filter(Boolean);
  const syncState = {
    jobId,
    source: "run",
    characterActive,
    characterInactive,
    active,
    inactive,
    characterPrompt: joinPromptTags(characterActive),
    basePrompt: joinPromptTags(active),
    prompt: joinPromptTags([...characterActive, ...active]),
    allPrompt: joinPromptTags([...characterActive, ...active, ...characterInactive, ...inactive]),
    language: promptTagState.language,
    updatedAt: new Date().toISOString()
  };
  await storageSet({
    [key]: {
      jobId,
      characterActive,
      characterInactive,
      active,
      inactive,
      characterPrompt: joinPromptTags(characterActive),
      basePrompt: joinPromptTags(active),
      prompt: joinPromptTags([...characterActive, ...active]),
      allPrompt: joinPromptTags([...characterActive, ...active, ...characterInactive, ...inactive]),
      language: promptTagState.language,
      updatedAt: new Date().toISOString()
    },
    [STORAGE_KEYS.activePromptSync]: syncState
  });
}

function normalizeSavedPromptTagState(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const hasScopedCharacterState = Array.isArray(value.characterActive) ||
    Array.isArray(value.characterInactive) ||
    typeof value.characterPrompt === "string";
  return {
    jobId: String(value.jobId || ""),
    characterActive: normalizeSavedTagList(value.characterActive),
    characterInactive: normalizeSavedTagList(value.characterInactive),
    active: normalizeSavedTagList(value.active),
    inactive: normalizeSavedTagList(value.inactive),
    prompt: String(value.prompt || ""),
    characterPrompt: String(value.characterPrompt || ""),
    basePrompt: String(value.basePrompt || ""),
    allPrompt: String(value.allPrompt || ""),
    language: value.language === "zh" ? "zh" : "en",
    hasScopedCharacterState
  };
}

function normalizeSavedTagList(value) {
  return Array.isArray(value)
    ? value.map((tag) => String(tag || "").trim()).filter(Boolean)
    : [];
}

function syncTagsFromState(tags, prompt) {
  const savedTags = normalizeSavedTagList(tags);
  return savedTags.length ? savedTags : splitPromptTags(prompt || "");
}

function tagCounts(tags) {
  const counts = new Map();
  for (const tag of tags) {
    const key = normalizeTagKey(tag);
    if (!key) {
      continue;
    }
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function normalizePromptForCompare(prompt) {
  return joinPromptTags(splitPromptTags(prompt)).toLowerCase();
}

function splitSavedPromptTagScopes(state) {
  let active = [...state.active];
  let inactive = [...state.inactive];
  let characterActive = [...state.characterActive];
  let characterInactive = [...state.characterInactive];

  const activeSplit = splitRuntimeCharacterTags(active);
  active = activeSplit.base;
  characterActive = uniqueTagTexts([...characterActive, ...activeSplit.character]);

  const inactiveSplit = splitRuntimeCharacterTags(inactive);
  inactive = inactiveSplit.base;
  characterInactive = uniqueTagTexts([...characterInactive, ...inactiveSplit.character]);

  if (!state.hasScopedCharacterState && !characterActive.length) {
    characterActive = splitPromptTags(state.characterPrompt);
  }

  return {
    active: uniqueTagTexts(active),
    inactive: uniqueTagTexts(inactive),
    characterActive: uniqueTagTexts(characterActive),
    characterInactive: uniqueTagTexts(characterInactive)
  };
}

function splitRuntimeCharacterTags(tags) {
  const base = [];
  const character = [];
  for (const tag of tags) {
    if (isRuntimeCharacterTag(tag)) {
      character.push(tag);
    } else {
      base.push(tag);
    }
  }
  return { base, character };
}

function isRuntimeCharacterTag(tag) {
  const text = String(tag || "").trim();
  if (!text) {
    return false;
  }
  if (tagIsInPromptSegment(text, currentTemplate?.characterSegment)) {
    return true;
  }
  return !normalizePromptForCompare(stripGeneratedCharacterDetailsForDefault(text, {
    character: currentCharacter,
    templatePositive: "",
    baseCharacterSegment: ""
  }));
}

function tagIsInPromptSegment(tag, segment) {
  const key = normalizeTagKey(tag);
  if (!key || !segment) {
    return false;
  }
  return splitPromptTags(segment).some((segmentTag) => normalizeTagKey(segmentTag) === key);
}

function tagsRemovedFromPrompt(originalPrompt, keptPrompt) {
  const keptCounts = tagCounts(splitPromptTags(keptPrompt));
  const removed = [];
  for (const tag of splitPromptTags(originalPrompt)) {
    const key = normalizeTagKey(tag);
    const count = keptCounts.get(key) || 0;
    if (count > 0) {
      keptCounts.set(key, count - 1);
    } else {
      removed.push(tag);
    }
  }
  return removed;
}

function uniqueTagTexts(tags) {
  const seen = new Set();
  const result = [];
  for (const tag of tags) {
    const text = String(tag || "").trim();
    const key = normalizeTagKey(text);
    if (!text || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(text);
  }
  return result;
}

function normalizePromptText(prompt) {
  return joinPromptTags(splitPromptTags(String(prompt || "").replace(/\n+/g, ", ")));
}

function promptTagStateStorageKey() {
  return `${RUN_JOB_PREFIX}${jobId}:promptTags`;
}

async function loadTagTranslationCache() {
  const stored = await storageGet(STORAGE_KEYS.tagTranslationCache);
  promptTagState.translations = stored[STORAGE_KEYS.tagTranslationCache]?.translations || {};
}

async function saveTagTranslationCache() {
  await storageSet({
    [STORAGE_KEYS.tagTranslationCache]: {
      translations: promptTagState.translations,
      updatedAt: new Date().toISOString()
    }
  });
}

function displayTagText(tag) {
  if (promptTagState.language !== "zh") {
    return tag.text;
  }
  if (promptTagState.translationLoading && !tag.zh) {
    return "翻译中...";
  }
  return tag.zh || tag.text;
}

function syncPromptTextarea(prompt) {
  promptTagState.syncingTextarea = true;
  elements.promptOutput.value = prompt;
  promptTagState.syncingTextarea = false;
}

function syncCharacterPromptTextarea(prompt) {
  characterTagState.syncingTextarea = true;
  elements.characterPromptOutput.value = prompt;
  characterTagState.syncingTextarea = false;
}

function promptForDefaultTemplate(prompt, template) {
  const baseCharacterSegment = String(template?.characterSegment || "").trim();
  let positive = normalizePromptText(prompt);
  positive = stripGeneratedCharacterDetailsForDefault(positive, {
    character: currentCharacter,
    templatePositive: "",
    baseCharacterSegment: ""
  });

  return {
    positive,
    characterSegment: baseCharacterSegment
  };
}

function basePromptWithoutCharacterDetails(template, character) {
  const positive = typeof template === "string" ? template : template?.positive || "";
  const baseCharacterSegment = typeof template === "string" ? "" : template?.characterSegment || "";
  let basePrompt = normalizePromptText(positive);
  if (baseCharacterSegment) {
    basePrompt = replacePromptSegment(basePrompt, baseCharacterSegment, "");
  }
  return stripGeneratedCharacterDetailsForDefault(basePrompt, {
    character,
    templatePositive: "",
    baseCharacterSegment: ""
  });
}

function updateProgress(percent, detail = "") {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  elements.progressBar.value = value;
  elements.progressText.textContent = `${Math.round(value)}%${detail ? ` · ${detail}` : ""}`;
}

async function log(level, message) {
  const entry = {
    at: new Date().toISOString(),
    level,
    message
  };
  logs.push(entry);
  renderLog(entry);
  await storageSet({
    [`${RUN_JOB_PREFIX}${jobId}:logs`]: logs
  });
}

function renderLog(entry) {
  const item = document.createElement("li");
  item.className = `log-${entry.level}`;
  const time = new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false });
  item.innerHTML = `<time>${time}</time><span>${escapeHtml(entry.message)}</span>`;
  elements.logList.appendChild(item);
  item.scrollIntoView({ block: "end" });
}

function etaText(value, prefix = "") {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  return `${prefix}ETA ${Math.ceil(seconds)}s`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimRight(value) {
  return String(value || "").replace(/\/+$/, "");
}

async function copyText(text) {
  if (!text) {
    return;
  }
  await navigator.clipboard.writeText(text);
  await log("success", "提示词已复制");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}
