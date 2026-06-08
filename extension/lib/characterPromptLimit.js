import { joinPromptTags, splitPromptTags } from "./promptMerge.js";
import { normalizeTagKey } from "./tagTranslations.js";

export function applyCharacterTagLimit(character, settings = {}) {
  const originalPrompt = joinPromptTags(splitPromptTags(
    character?.character_prompt ||
    character?.visual_prompt ||
    character?.character_name ||
    ""
  ));
  if (!originalPrompt || !settings.limitCharacterTags) {
    return {
      character,
      applied: false,
      originalPrompt,
      limitedPrompt: originalPrompt,
      removedPrompt: ""
    };
  }

  const limit = Math.max(1, Math.floor(Number(settings.characterTagLimit) || 3));
  const selected = [];
  const originalTags = splitPromptTags(originalPrompt);
  const knownIdentity = character?.known_identity !== false;

  if (knownIdentity) {
    addUniqueTag(selected, character?.character_name);
    addUniqueTag(selected, character?.series);
  }

  for (const tag of originalTags) {
    if (selected.length >= limit) {
      break;
    }
    addUniqueTag(selected, tag);
  }

  const limitedTags = selected.slice(0, limit);
  const removedTags = removeSelectedTags(originalTags, limitedTags);
  const limitedPrompt = joinPromptTags(limitedTags);
  const removedPrompt = joinPromptTags(removedTags);

  return {
    character: {
      ...(character || {}),
      full_character_prompt: originalPrompt,
      character_prompt: limitedPrompt,
      character_prompt_limited: true,
      character_prompt_limit: limit,
      character_prompt_removed: removedPrompt
    },
    applied: true,
    originalPrompt,
    limitedPrompt,
    removedPrompt
  };
}

function addUniqueTag(tags, value) {
  const tag = String(value || "").trim();
  if (!tag) {
    return;
  }
  const key = normalizeTagKey(tag);
  if (!key || tags.some((item) => normalizeTagKey(item) === key)) {
    return;
  }
  tags.push(tag);
}

function removeSelectedTags(originalTags, selectedTags) {
  const selectedCounts = new Map();
  for (const tag of selectedTags) {
    const key = normalizeTagKey(tag);
    selectedCounts.set(key, (selectedCounts.get(key) || 0) + 1);
  }

  const removed = [];
  for (const tag of originalTags) {
    const key = normalizeTagKey(tag);
    const count = selectedCounts.get(key) || 0;
    if (count > 0) {
      selectedCounts.set(key, count - 1);
    } else {
      removed.push(tag);
    }
  }
  return removed;
}
