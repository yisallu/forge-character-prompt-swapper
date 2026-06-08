import { removeUndesiredSkinToneTags } from "./promptMerge.js";

const MUDAE_CHARACTER_PATH = /^\/character\/\d+\/[^/]+\/?$/i;
const VISUAL_TAG_RE = /\b(?:hair|eyes|horns?|fangs?|headband|ribbon|bow|hat|cap|glasses|mask|uniform|dress|skirt|kimono|armor|boots?|shoes?|gloves?|stockings?|tail|wings?|ears?|halo|weapon|sword|staff|scarf|cloak|coat|jacket|shirt|tie|choker|lollipop)\b/i;
const EXCLUDED_VISUAL_TAG_RE = /\b(?:breasts?|bust|flat chest|loli|shota|child|teen|minor|young|underage|nsfw|nude|naked)\b/i;

export function isMudaeCharacterUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)mudae\.net$/i.test(url.hostname) && MUDAE_CHARACTER_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

export function normalizeMudaeCharacterUrl(value) {
  const url = new URL(value);
  url.protocol = "https:";
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

export async function fetchMudaeCharacterContext(linkUrl, fetcher = fetch) {
  if (!isMudaeCharacterUrl(linkUrl)) {
    return null;
  }

  const url = normalizeMudaeCharacterUrl(linkUrl);
  const response = await fetcher(url, {
    method: "GET",
    credentials: "omit",
    cache: "force-cache"
  });
  if (!response.ok) {
    throw new Error(`Mudae 角色页返回 ${response.status}`);
  }

  const context = parseMudaeCharacterHtml(await response.text(), url);
  if (!context.name) {
    throw new Error("Mudae 角色页没有解析到角色名");
  }
  return context;
}

export function parseMudaeCharacterHtml(html, pageUrl = "") {
  if (typeof DOMParser === "function") {
    return parseMudaeCharacterDom(html, pageUrl);
  }
  return parseMudaeCharacterFallback(html, pageUrl);
}

export function formatMudaeCharacterContext(context) {
  if (!context) {
    return "";
  }

  return [
    context.url ? `url: ${context.url}` : "",
    context.name ? `name: ${context.name}` : "",
    context.series ? `series: ${context.series}` : "",
    context.gender ? `gender: ${context.gender}` : "",
    context.rank ? `rank: ${context.rank}` : "",
    context.aliases?.length ? `aliases: ${context.aliases.join("; ")}` : "",
    safeTags(context.tags)?.length ? `tags: ${safeTags(context.tags).join(", ")}` : "",
    context.visualTags?.length ? `visual_tags: ${context.visualTags.join(", ")}` : "",
    context.voiceActors?.length ? `voice_actors: ${context.voiceActors.join("; ")}` : "",
    context.imageUrl ? `image: ${context.imageUrl}` : ""
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 2400);
}

export function mergeMudaeContextIntoCharacter(character, context) {
  if (!context?.name) {
    return character;
  }

  const name = context.name || character?.character_name || "";
  const series = context.series || character?.series || "";
  const visualPrompt = sanitizePrompt(character?.visual_prompt || mudaeVisualPrompt(context));
  const characterPrompt = sanitizePrompt([
    name,
    series,
    mudaeVisualPrompt(context),
    visualPrompt
  ].filter(Boolean).join(", "));

  return {
    ...character,
    character_name: name,
    series,
    character_prompt: characterPrompt || character?.character_prompt || name,
    visual_prompt: visualPrompt,
    known_identity: true,
    confidence: Math.max(Number(character?.confidence) || 0, 0.95),
    evidence: `点击图片链接到 Mudae 角色页：${[name, series].filter(Boolean).join(" / ")}`,
    notes: [character?.notes, "已优先采用 Mudae 角色页信息，避免仅凭图片误判角色。"].filter(Boolean).join(" ")
  };
}

function parseMudaeCharacterDom(html, pageUrl) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  const bodyText = normalizeText(doc.body?.innerText || doc.body?.textContent || "");
  const title = doc.querySelector("meta[property='og:title'], meta[name='og:title']")?.content ||
    doc.querySelector("title")?.textContent ||
    "";
  const titleInfo = parseTitle(title);
  const tags = unique([...doc.querySelectorAll("a.tag[href*='/tag/']")]
    .map((link) => normalizeText(link.textContent))
    .filter(Boolean));
  const series = titleInfo.series || normalizeText(doc.querySelector("a[href^='/series/'], a[href*='mudae.net/series/']")?.textContent);

  return {
    url: pageUrl,
    name: titleInfo.name || decodeNameFromUrl(pageUrl),
    series,
    gender: textAfterLabel(bodyText, "GENDER", ["RANK", "ALIASES", "VOICE ACTORS", "TAGS"]),
    rank: textAfterLabel(bodyText, "RANK", ["favorite", "ALIASES", "VOICE ACTORS", "TAGS"]),
    aliases: parseAliases(bodyText),
    voiceActors: parseVoiceActors(bodyText),
    tags,
    visualTags: visualTags(tags),
    imageUrl: absoluteUrl(doc.querySelector("meta[property='og:image'], meta[name='og:image']")?.content, pageUrl)
  };
}

function parseMudaeCharacterFallback(html, pageUrl) {
  const text = stripHtml(html);
  const title = html.match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
    "";
  const titleInfo = parseTitle(decodeHtml(title));
  const tags = unique([...String(html || "").matchAll(/<a[^>]+class=["'][^"']*\btag\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => normalizeText(stripHtml(match[1])))
    .filter(Boolean));

  return {
    url: pageUrl,
    name: titleInfo.name || decodeNameFromUrl(pageUrl),
    series: titleInfo.series,
    gender: textAfterLabel(text, "GENDER", ["RANK", "ALIASES", "VOICE ACTORS", "TAGS"]),
    rank: textAfterLabel(text, "RANK", ["favorite", "ALIASES", "VOICE ACTORS", "TAGS"]),
    aliases: parseAliases(text),
    voiceActors: parseVoiceActors(text),
    tags,
    visualTags: visualTags(tags),
    imageUrl: ""
  };
}

function parseTitle(value) {
  const title = normalizeText(String(value || "").replace(/\s+-\s+Mudae$/i, ""));
  const [name, ...seriesParts] = title.split(/\s+\|\s+/);
  return {
    name: normalizeText(name),
    series: normalizeText(seriesParts.join(" | "))
  };
}

function parseAliases(text) {
  const segment = textAfterLabel(text, "ALIASES", ["VOICE ACTORS", "TAGS", "CUSTOM LISTS", "Images", "Related Characters"]);
  return unique(segment
    .replace(/\b(?:list|update|See more)\b/gi, " ")
    .split(/\s*\|\s*|[;\n]+/)
    .map(normalizeText)
    .filter(Boolean))
    .slice(0, 16);
}

function parseVoiceActors(text) {
  const segment = textAfterLabel(text, "VOICE ACTORS", ["TAGS", "CUSTOM LISTS", "Images", "Related Characters"]);
  return unique(segment
    .replace(/\b(?:English|Japanese|Korean|Chinese|French|German|Spanish|Portuguese):/gi, "")
    .split(/\s{2,}|[;\n]+/)
    .map(normalizeText)
    .filter(Boolean))
    .slice(0, 12);
}

function textAfterLabel(text, label, stopLabels = []) {
  const normalized = normalizeText(text);
  const start = normalized.search(new RegExp(`\\b${escapeRegExp(label)}\\b`, "i"));
  if (start < 0) {
    return "";
  }

  let chunk = normalized.slice(start + label.length).trim();
  for (const stop of stopLabels) {
    const stopIndex = chunk.search(new RegExp(`\\b${escapeRegExp(stop)}\\b`, "i"));
    if (stopIndex >= 0) {
      chunk = chunk.slice(0, stopIndex).trim();
    }
  }
  return chunk.replace(/^(?:list|update|expand_less|Hide)\b/i, "").trim();
}

function visualTags(tags) {
  return unique((tags || [])
    .map(normalizeText)
    .filter((tag) => VISUAL_TAG_RE.test(tag) && !EXCLUDED_VISUAL_TAG_RE.test(tag)))
    .slice(0, 18);
}

function safeTags(tags) {
  return unique((tags || [])
    .map(normalizeText)
    .filter((tag) => !EXCLUDED_VISUAL_TAG_RE.test(tag)))
    .slice(0, 36);
}

function mudaeVisualPrompt(context) {
  return sanitizePrompt((context?.visualTags || []).map((tag) => tag.toLowerCase()).join(", "));
}

function decodeNameFromUrl(value) {
  try {
    const url = new URL(value);
    const part = url.pathname.split("/").filter(Boolean).at(-1) || "";
    return normalizeText(decodeURIComponent(part).replace(/\{[^}]+\}/g, ""));
  } catch {
    return "";
  }
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

function normalizeText(value) {
  return decodeHtml(String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value) {
  return decodeHtml(String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "));
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"");
}

function absoluteUrl(value, base) {
  if (!value) {
    return "";
  }
  try {
    return new URL(value, base).href;
  } catch {
    return String(value || "");
  }
}

function unique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = normalizeText(value);
    const key = text.toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(text);
  }
  return result;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
