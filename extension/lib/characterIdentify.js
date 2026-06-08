import { removeUndesiredSkinToneTags } from "./promptMerge.js";

export const IDENTIFY_IMAGE_MAX_EDGE = 1600;

const MIN_KNOWN_CHARACTER_CONFIDENCE = 0.72;

export function buildIdentifyCharacterRequest({ imageDataUrl, settings, imageMeta = {} }) {
  return {
    model: settings.llmModel,
    temperature: 0,
    messages: [
      {
        role: "system",
        content: [
          "You identify fictional anime, game, manga, and illustration characters for Stable Diffusion prompting.",
          "Return JSON only. Keys: character_name, series, character_prompt, visual_prompt, known_identity, confidence, evidence, notes.",
          "Be conservative: do not guess a famous character name unless the image or metadata uniquely supports it.",
          "When clicked_link_character_page contains VNDB or Mudae character data, treat it as a strong identity source for that clicked image, while still using the image for visual_prompt traits.",
          "If the identity is uncertain, set known_identity to false, leave character_name and series empty, and make character_prompt equal visual_prompt.",
          "visual_prompt must be concrete visible traits as comma-separated Stable Diffusion tags: hair, eyes, outfit, accessories, age impression, body framing, expression.",
          "character_prompt may include a canonical character and source only when known_identity is true and confidence is at least 0.72.",
          "Do not include skin whitening tags such as pale skin, white skin, fair skin, porcelain skin, or ghostly skin.",
          "Do not include quality, camera, pose, lighting, LoRA, artist, or negative prompt tags."
        ].join(" ")
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildIdentifyPromptText(imageMeta)
          },
          {
            type: "image_url",
            image_url: {
              url: imageDataUrl,
              detail: "high"
            }
          }
        ]
      }
    ]
  };
}

export function parseCharacterResponse(text) {
  return normalizeCharacterResult(parseJsonObject(text));
}

export function describeImageForLog(imageMeta = {}) {
  const size = imageMeta.naturalWidth && imageMeta.naturalHeight
    ? `${imageMeta.naturalWidth}x${imageMeta.naturalHeight}`
    : "";
  const alt = compactLine(imageMeta.alt, 80);
  const title = compactLine(imageMeta.title, 80);
  const pageTitle = compactLine(imageMeta.pageTitle, 80);
  const vndbCharacter = imageMeta.vndbCharacter
    ? compactLine([imageMeta.vndbCharacter.name, imageMeta.vndbCharacter.originalName].filter(Boolean).join(" / "), 120)
    : "";
  const mudaeCharacter = imageMeta.mudaeCharacter
    ? compactLine([imageMeta.mudaeCharacter.name, imageMeta.mudaeCharacter.series].filter(Boolean).join(" / "), 120)
    : "";
  const parts = [
    size ? `尺寸 ${size}` : "",
    vndbCharacter ? `VNDB: ${vndbCharacter}` : "",
    mudaeCharacter ? `Mudae: ${mudaeCharacter}` : "",
    alt ? `alt: ${alt}` : "",
    title ? `title: ${title}` : "",
    pageTitle ? `页面: ${pageTitle}` : ""
  ].filter(Boolean);
  return parts.join(" · ") || "没有网页文字线索";
}

export function describeCharacterForLog(character = {}) {
  const identity = character.known_identity ? "已确认角色" : "未确认角色";
  const name = character.character_name || character.series
    ? [character.character_name, character.series].filter(Boolean).join(" / ")
    : "使用外观 tags";
  const confidence = character.confidence === "" || character.confidence == null
    ? ""
    : `置信度 ${character.confidence}`;
  const evidence = compactLine(character.evidence || character.notes, 140);
  return [identity, name, confidence, evidence].filter(Boolean).join(" · ");
}

function buildIdentifyPromptText(imageMeta) {
  const context = describeImageContext(imageMeta);
  return [
    "识别这张图里的主要二次元/游戏/漫画角色，并给出可直接替换到 Stable Diffusion 正向提示词里的角色 tags。",
    "严格要求：",
    "1. 先看图像证据，再参考网页/图片线索；网页线索可能是错的，不能单独决定角色。",
    "2. 只有非常确定时才写 character_name、series，并让 known_identity=true。",
    "3. 不确定时不要硬猜角色名，known_identity=false，character_prompt 只写外观 tags。",
    "4. confidence 用 0 到 1 的数字。",
    "5. evidence 用一句话说明依据，例如发型、服装、武器、标志、图片文件名或页面文字。",
    context ? `网页/图片线索：\n${context}` : "网页/图片线索：无"
  ].join("\n");
}

function describeImageContext(imageMeta = {}) {
  return [
    ["page_title", imageMeta.pageTitle, 320],
    ["page_url", shortenUrl(imageMeta.pageUrl), 320],
    ["image_src", shortenUrl(imageMeta.src), 320],
    ["link_url", shortenUrl(imageMeta.linkUrl), 320],
    ["alt", imageMeta.alt, 320],
    ["title", imageMeta.title, 320],
    ["aria_label", imageMeta.ariaLabel, 320],
    ["nearby_text", imageMeta.nearbyText, 320],
    ["clicked_link_character_page", [imageMeta.vndbCharacterText, imageMeta.mudaeCharacterText].filter(Boolean).join("\n\n"), 2200],
    ["visible_size", imageMeta.naturalWidth && imageMeta.naturalHeight ? `${imageMeta.naturalWidth}x${imageMeta.naturalHeight}` : "", 320]
  ]
    .map(([key, value, maxLength]) => [key, compactLine(value, maxLength)])
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

function normalizeCharacterResult(character) {
  const explicitKnown = parseBoolean(character.known_identity ?? character.is_known_character ?? character.known_character);
  const confidence = parseConfidence(character.confidence);
  const visualPrompt = sanitizePrompt(character.visual_prompt || "");
  const rawCharacterPrompt = sanitizePrompt(character.character_prompt || "");
  const lowConfidence = confidence !== "" && confidence < MIN_KNOWN_CHARACTER_CONFIDENCE;
  const forceUnknown = explicitKnown !== true || lowConfidence;
  const characterName = forceUnknown ? "" : String(character.character_name || "").trim();
  const series = forceUnknown ? "" : String(character.series || "").trim();
  const characterPrompt = forceUnknown
    ? sanitizePrompt(visualPrompt || rawCharacterPrompt)
    : sanitizePrompt(rawCharacterPrompt || visualPrompt || characterName);

  if (!characterPrompt) {
    throw new Error("LLM 没有返回可用的角色提示词");
  }

  const notes = String(character.notes || "").trim();
  const evidence = String(character.evidence || "").trim();
  return {
    character_name: characterName,
    series,
    character_prompt: characterPrompt,
    visual_prompt: visualPrompt,
    known_identity: Boolean(!forceUnknown && (explicitKnown === true || characterName)),
    confidence,
    evidence,
    notes: forceUnknown
      ? [notes, lowConfidence ? "低置信度，已改用外观 tags，避免错认角色。" : "未确认官方角色，已改用外观 tags。"].filter(Boolean).join(" ")
      : notes
  };
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

function parseBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (/^(true|yes|known|1)$/i.test(value.trim())) {
      return true;
    }
    if (/^(false|no|unknown|0)$/i.test(value.trim())) {
      return false;
    }
  }
  return null;
}

function parseConfidence(value) {
  if (value === "" || value == null) {
    return "";
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "";
  }
  return Math.max(0, Math.min(1, number));
}

function sanitizePrompt(prompt) {
  const cleaned = String(prompt || "")
    .replace(/\n+/g, ", ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/,\s*,+/g, ", ")
    .trim()
    .replace(/^,|,$/g, "");
  return removeUndesiredSkinToneTags(cleaned);
}

function compactLine(value, maxLength) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.startsWith("data:image/")) {
    return "";
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function shortenUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("data:image/")) {
    return "";
  }
  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return raw;
  }
}
