export const DEFAULT_SETTINGS = Object.freeze({
  llmBaseUrl: "https://api.sysmeng.com/v1",
  llmModel: "gpt-4o-mini",
  llmApiKey: "",
  forgeApiUrl: "http://127.0.0.1:7860",
  seedMode: "random",
  sdModelCheckpoint: "",
  hiresMode: "template",
  hiresUpscaler: "",
  hiresScale: 2,
  hiresDenoisingStrength: "",
  limitCharacterTags: true,
  characterTagLimit: 3,
  yisalbotToken: "",
  yisalbotChatId: "",
  llmTimeoutMs: 90000,
  generationTimeoutMs: 180000,
  progressPollMs: 2000
});

export const STORAGE_KEYS = Object.freeze({
  settings: "settings",
  baseTemplate: "baseTemplate",
  lastRunStatus: "lastRunStatus",
  lastCharacter: "lastCharacter",
  latestResult: "latestResult",
  activeRunJobId: "activeRunJobId",
  activePromptSync: "activePromptSync",
  tagTranslationCache: "tagTranslationCache",
  templateImportCleanWithLlm: "templateImportCleanWithLlm"
});

export const RUN_JOB_PREFIX = "runJob:";

export const DEFAULT_STATUS = Object.freeze({
  phase: "idle",
  message: "Ready",
  at: null
});
