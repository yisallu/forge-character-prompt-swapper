import { DEFAULT_SETTINGS, STORAGE_KEYS } from "./defaults.js";

export function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

export function storageSet(values) {
  return chrome.storage.local.set(values);
}

export async function getSettings() {
  const result = await storageGet(STORAGE_KEYS.settings);
  return {
    ...DEFAULT_SETTINGS,
    ...(result[STORAGE_KEYS.settings] || {})
  };
}

export async function saveSettings(settings) {
  await storageSet({
    [STORAGE_KEYS.settings]: {
      ...DEFAULT_SETTINGS,
      ...settings
    }
  });
}

export async function getBaseTemplate() {
  const result = await storageGet(STORAGE_KEYS.baseTemplate);
  return result[STORAGE_KEYS.baseTemplate] || null;
}

export async function saveBaseTemplate(template) {
  await storageSet({
    [STORAGE_KEYS.baseTemplate]: {
      ...template,
      updatedAt: new Date().toISOString()
    }
  });
}

export async function setStatus(status) {
  await storageSet({
    [STORAGE_KEYS.lastRunStatus]: {
      ...status,
      at: new Date().toISOString()
    }
  });
}

export async function saveLastCharacter(character) {
  await storageSet({
    [STORAGE_KEYS.lastCharacter]: {
      ...character,
      at: new Date().toISOString()
    }
  });
}

export async function saveLatestResult(result) {
  await storageSet({
    [STORAGE_KEYS.latestResult]: {
      ...result,
      at: new Date().toISOString()
    }
  });
}

export async function saveRunJob(jobId, job) {
  await storageSet({
    [`runJob:${jobId}`]: {
      ...job,
      updatedAt: new Date().toISOString()
    },
    [STORAGE_KEYS.activeRunJobId]: jobId
  });
}
