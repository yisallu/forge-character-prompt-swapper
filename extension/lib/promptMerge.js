const GENERIC_PREFIX_TAGS = new Set([
  "game cg",
  "anime screenshot",
  "anime screencap",
  "anime coloring",
  "masterpiece",
  "best quality",
  "highres",
  "newest",
  "year 2024",
  "very awa",
  "smooth quality"
]);

const SCENE_OR_CONTROL_HINTS = [
  "upper body",
  "full body",
  "cowboy shot",
  "pov",
  "looking at viewer",
  "face_focus",
  "window",
  "light",
  "dust",
  "glint",
  "1girl",
  "1boy",
  "solo"
];

const GENERATED_CHARACTER_DETAIL_RE = /\b(?:hair|eyes?|dress|skirt|shirt|blouse|sweater|jacket|blazers?|coat|uniform|kimono|yukata|hoodie|armor|robe|bodysuit|leotard|swimsuit|bikini|pantyhose|stockings?|thighhighs?|boots?|shoes?|gloves?|sleeves?|collar|ties?|neckties?|ribbons?|bows?|hairband|headband|hat|cap|crown|horns?|fangs?|tail|wings?|ears?|halo|glasses|mask|choker|necklace|earrings?|bracelet|rings?|brooch|belt|weapons?|sword|staff|wand|lollipop|umbrella|bag|clothes?|clothing|outfits?|costumes?|appearance|skin|complexion|breasts?|chest|slim|curvy|petite|muscular|girls?|boys?|woman|women|man|men|lady|teen(?:age)?|adult|child|children|female|male)\b/i;

function normalizeTag(tag) {
  return tag.trim().toLowerCase().replace(/\s+/g, " ");
}

function isGenericTag(tag) {
  const normalized = normalizeTag(tag).replace(/^\(|\)$/g, "");
  return GENERIC_PREFIX_TAGS.has(normalized) ||
    normalized.startsWith("<lora:") ||
    normalized.startsWith("score_") ||
    normalized.startsWith("rating_");
}

function isSceneOrControlTag(tag) {
  const normalized = normalizeTag(tag).replace(/^\(|\)$/g, "");
  return SCENE_OR_CONTROL_HINTS.some((hint) => normalized.includes(hint));
}

export function splitPromptTags(prompt) {
  const parts = [];
  let current = "";
  let quote = null;
  let roundDepth = 0;
  let squareDepth = 0;
  let angleDepth = 0;

  const text = String(prompt || "");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if ((char === "\"" || char === "'") && !quote && current.trim() === "") {
      quote = char;
      current += char;
      continue;
    }
    if (quote && char === quote) {
      quote = null;
      current += char;
      continue;
    }
    if (!quote) {
      if (char === "(") roundDepth += 1;
      if (char === ")" && roundDepth > 0) roundDepth -= 1;
      if (char === "[") squareDepth += 1;
      if (char === "]" && squareDepth > 0) squareDepth -= 1;
      if (char === "<") angleDepth += 1;
      if (char === ">" && angleDepth > 0) angleDepth -= 1;
      if (char === "," && roundDepth === 0 && squareDepth === 0 && angleDepth === 0) {
        parts.push(current.trim());
        current = "";
        continue;
      }
    }
    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts.filter(Boolean);
}

export function joinPromptTags(tags) {
  return tags
    .map((tag) => tag.trim())
    .filter(Boolean)
    .join(", ")
    .replace(/,\s*,+/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

export function removeUndesiredSkinToneTags(prompt) {
  return joinPromptTags(splitPromptTags(prompt).filter((tag) => !isUndesiredSkinToneTag(tag)));
}

export function isUndesiredSkinToneTag(tag) {
  const normalized = normalizeSkinToneTag(tag);
  if (!normalized) {
    return false;
  }
  return /^(?:very |extremely |slightly |light |lightly )?(?:pale|fair|white|porcelain|snow white|milky white|ghostly|ashen|washed out) (?:skin|complexion)$/.test(normalized) ||
    /^(?:pale|fair|white|porcelain|ashen)$/.test(normalized) ||
    /^(?:pale|fair|light) skinned$/.test(normalized);
}

export function guessCharacterSegment(prompt) {
  const tags = splitPromptTags(prompt);
  if (!tags.length) {
    return "";
  }

  let start = tags.findIndex((tag) => !isGenericTag(tag));
  if (start < 0) {
    return tags.slice(0, 1).join(", ");
  }

  if (isSceneOrControlTag(tags[start]) && tags[start + 1]) {
    start += 1;
  }

  const selected = [];
  for (let i = start; i < Math.min(tags.length, start + 4); i += 1) {
    const tag = tags[i];
    if (!tag || isGenericTag(tag)) {
      break;
    }
    if (selected.length > 0 && isSceneOrControlTag(tag)) {
      break;
    }
    selected.push(tag);
    if (selected.length >= 2) {
      break;
    }
  }

  return selected.join(", ") || tags[start] || "";
}

export function replaceCharacterInPrompt(prompt, characterSegment, replacementPrompt) {
  const replacement = joinPromptTags(splitPromptTags(replacementPrompt || ""));
  if (!replacement) {
    return prompt || "";
  }

  const basePrompt = prompt || "";
  const segment = (characterSegment || "").trim();
  if (segment) {
    const baseTags = splitPromptTags(basePrompt);
    const segmentTags = splitPromptTags(segment).map(normalizeTag);
    const start = findTagSequence(baseTags, segmentTags);
    if (start >= 0) {
      baseTags.splice(start, segmentTags.length, ...splitPromptTags(replacement));
      return joinPromptTags(baseTags);
    }
  }

  const tags = splitPromptTags(basePrompt);
  let insertIndex = 0;
  while (insertIndex < tags.length && isGenericTag(tags[insertIndex])) {
    insertIndex += 1;
  }
  tags.splice(insertIndex, 0, ...splitPromptTags(replacement));
  return joinPromptTags(tags);
}

export function replacePromptSegment(prompt, segment, replacementPrompt = "") {
  const baseTags = splitPromptTags(prompt || "");
  const segmentTags = splitPromptTags(segment || "").map(normalizeTag);
  if (!baseTags.length || !segmentTags.length) {
    return prompt || "";
  }
  const start = findTagSequence(baseTags, segmentTags);
  if (start < 0) {
    return prompt || "";
  }
  baseTags.splice(start, segmentTags.length, ...splitPromptTags(replacementPrompt || ""));
  return joinPromptTags(baseTags);
}

export function stripGeneratedCharacterDetailsForDefault(prompt, { character, templatePositive = "", baseCharacterSegment = "" } = {}) {
  const baseKeys = new Set(splitPromptTags([templatePositive, baseCharacterSegment].filter(Boolean).join(", "))
    .map(normalizeTag)
    .filter(Boolean));
  const characterKeys = new Set(splitPromptTags([
    character?.character_prompt,
    character?.visual_prompt,
    character?.character_name,
    character?.series
  ].filter(Boolean).join(", "))
    .map(normalizeTag)
    .filter(Boolean));
  const tags = splitPromptTags(prompt);
  const kept = [];
  let firstRemovedIndex = -1;

  for (const tag of tags) {
    const key = normalizeTag(tag);
    const isOriginalBaseTag = baseKeys.has(key);
    const isCurrentCharacterTag = characterKeys.has(key);
    const isGeneratedDetail = isGeneratedCharacterDetailTag(tag);
    if (!isOriginalBaseTag && (isCurrentCharacterTag || isGeneratedDetail)) {
      if (firstRemovedIndex < 0) {
        firstRemovedIndex = kept.length;
      }
      continue;
    }
    kept.push(tag);
  }

  const baseSegmentTags = splitPromptTags(baseCharacterSegment);
  if (firstRemovedIndex >= 0 && baseSegmentTags.length && findTagSequence(kept, baseSegmentTags.map(normalizeTag)) < 0) {
    const insertAt = Math.max(0, Math.min(firstRemovedIndex, kept.length));
    kept.splice(insertAt, 0, ...baseSegmentTags);
  }

  return joinPromptTags(kept);
}

function isGeneratedCharacterDetailTag(tag) {
  return GENERATED_CHARACTER_DETAIL_RE.test(normalizeTagCore(tag));
}

function findTagSequence(baseTags, normalizedSegmentTags) {
  if (!normalizedSegmentTags.length || normalizedSegmentTags.length > baseTags.length) {
    return -1;
  }

  for (let i = 0; i <= baseTags.length - normalizedSegmentTags.length; i += 1) {
    let matched = true;
    for (let j = 0; j < normalizedSegmentTags.length; j += 1) {
      if (normalizeTag(baseTags[i + j]) !== normalizedSegmentTags[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return i;
    }
  }
  return -1;
}

function normalizeSkinToneTag(tag) {
  return normalizeTagCore(tag);
}

function normalizeTagCore(tag) {
  let text = String(tag || "")
    .trim()
    .replace(/_/g, " ")
    .toLowerCase();

  let changed = true;
  while (changed && text.length > 1) {
    changed = false;
    for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
      if (text.startsWith(open) && text.endsWith(close)) {
        text = text.slice(1, -1).trim();
        changed = true;
      }
    }
  }

  text = text.replace(/:\s*-?\d+(?:\.\d+)?$/, "");
  return text.replace(/\s+/g, " ").trim();
}
