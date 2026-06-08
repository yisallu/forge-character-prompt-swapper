import { getSettings, saveSettings } from "./lib/storage.js";
import { normalizeLlmBaseUrl } from "./lib/llmEndpoint.js";

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
document.getElementById("saveButton").addEventListener("click", handleSave);
document.getElementById("refreshForgeResources").addEventListener("click", handleRefreshForgeResources);
document.getElementById("testForge").addEventListener("click", handleTestForge);
document.getElementById("testYisalbot").addEventListener("click", handleTestYisalbot);

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
