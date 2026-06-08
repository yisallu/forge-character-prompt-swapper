import { removeUndesiredSkinToneTags } from "./promptMerge.js";

const VNDB_CHARACTER_PATH = /^\/c\d+\/?$/i;
const VISUAL_TRAIT_GROUPS = new Set(["Hair", "Eyes", "Body", "Clothes", "Items"]);

export function isVndbCharacterUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)vndb\.org$/i.test(url.hostname) && VNDB_CHARACTER_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

export function normalizeVndbCharacterUrl(value) {
  const url = new URL(value);
  url.protocol = "https:";
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

export async function fetchVndbCharacterContext(linkUrl, fetcher = fetch) {
  if (!isVndbCharacterUrl(linkUrl)) {
    return null;
  }

  const url = normalizeVndbCharacterUrl(linkUrl);
  const response = await fetcher(url, {
    method: "GET",
    credentials: "omit",
    cache: "force-cache"
  });
  if (!response.ok) {
    throw new Error(`VNDB 角色页返回 ${response.status}`);
  }

  const context = parseVndbCharacterHtml(await response.text(), url);
  if (!context.name && !context.originalName) {
    throw new Error("VNDB 角色页没有解析到角色名");
  }
  return context;
}

export function parseVndbCharacterHtml(html, pageUrl = "") {
  if (typeof DOMParser === "function") {
    return parseVndbCharacterDom(html, pageUrl);
  }
  return parseVndbCharacterFallback(html, pageUrl);
}

export function formatVndbCharacterContext(context) {
  if (!context) {
    return "";
  }

  const traitLines = Object.entries(context.traits || {})
    .filter(([, values]) => values?.length)
    .map(([key, values]) => `${key}: ${values.join(", ")}`);

  return [
    context.url ? `url: ${context.url}` : "",
    context.name ? `name: ${context.name}` : "",
    context.originalName ? `original_name: ${context.originalName}` : "",
    context.aliases?.length ? `aliases: ${context.aliases.join("; ")}` : "",
    context.sex ? `sex: ${context.sex}` : "",
    context.measurements ? `measurements: ${context.measurements}` : "",
    traitLines.length ? `traits: ${traitLines.join("; ")}` : "",
    context.visualNovels?.length ? `visual_novels: ${context.visualNovels.join("; ")}` : "",
    context.voicedBy ? `voiced_by: ${context.voicedBy}` : ""
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 2400);
}

export function mergeVndbContextIntoCharacter(character, context) {
  if (!context?.name && !context?.originalName) {
    return character;
  }

  const name = context.name || context.originalName || character?.character_name || "";
  const series = firstVisualNovelTitle(context) || character?.series || "";
  const visualPrompt = sanitizePrompt(character?.visual_prompt || vndbVisualPrompt(context));
  const characterPrompt = sanitizePrompt([
    name,
    series,
    vndbVisualPrompt(context),
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
    evidence: `点击图片链接到 VNDB 角色页：${[name, context.originalName].filter(Boolean).join(" / ")}`,
    notes: [character?.notes, "已优先采用 VNDB 角色页信息，避免仅凭图片误判角色。"].filter(Boolean).join(" ")
  };
}

function parseVndbCharacterDom(html, pageUrl) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  const article = doc.querySelector("main article") || doc;
  const details = doc.querySelector(".chardetails") || article;
  const traits = {};
  const aliases = [];
  let measurements = "";
  let visualNovels = [];
  let voicedBy = "";

  for (const row of details.querySelectorAll("tr")) {
    const keyCell = row.querySelector("td.key");
    if (!keyCell) {
      continue;
    }
    const key = normalizeText(keyCell.textContent);
    const valueCell = keyCell.nextElementSibling;
    if (!key || !valueCell) {
      continue;
    }

    if (key === "Aliases") {
      for (const aliasRow of valueCell.querySelectorAll("table.names tr")) {
        const names = [...aliasRow.querySelectorAll("td")]
          .map((cell) => normalizeText(cell.textContent))
          .filter(Boolean);
        if (names.length) {
          aliases.push(names.join(" / "));
        }
      }
      if (!aliases.length) {
        aliases.push(...linesFromText(valueCell.textContent));
      }
    } else if (key === "Measurements") {
      measurements = normalizeText(valueCell.textContent);
    } else if (VISUAL_TRAIT_GROUPS.has(key) || ["Personality", "Role", "Engages in"].includes(key)) {
      traits[key] = [...valueCell.querySelectorAll("a")]
        .map((link) => normalizeText(link.textContent))
        .filter(Boolean);
      if (!traits[key].length) {
        traits[key] = splitCommaText(valueCell.textContent);
      }
    } else if (key === "Visual novels") {
      visualNovels = linesFromText(valueCell.textContent);
    } else if (key === "Voiced by") {
      voicedBy = normalizeText(valueCell.textContent);
    }
  }

  return compactContext({
    url: pageUrl,
    name: normalizeText(article.querySelector("h1")?.textContent),
    originalName: normalizeText(article.querySelector("h2.alttitle")?.textContent),
    aliases,
    sex: sexFromDom(details),
    measurements,
    traits,
    visualNovels,
    voicedBy,
    imageUrl: absoluteUrl(doc.querySelector("meta[property='og:image']")?.content || details.querySelector(".charimg img")?.src, pageUrl)
  });
}

function parseVndbCharacterFallback(html, pageUrl) {
  const text = String(html || "");
  const context = {
    url: pageUrl,
    name: htmlText(firstMatch(text, /<main[\s\S]*?<article[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/i)),
    originalName: htmlText(firstMatch(text, /<h2[^>]*class=["'][^"']*\balttitle\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i)),
    aliases: extractAliasTexts(extractSimpleRow(text, "Aliases")),
    sex: htmlText(firstMatch(text, /title=["']Sex:\s*([^"']+)["']/i)),
    measurements: htmlText(extractSimpleRow(text, "Measurements")),
    traits: {},
    visualNovels: linesFromText(htmlText(extractSimpleRow(text, "Visual novels"))),
    voicedBy: htmlText(extractSimpleRow(text, "Voiced by")),
    imageUrl: htmlEntityDecode(firstMatch(text, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i))
  };

  for (const key of ["Hair", "Eyes", "Body", "Clothes", "Items", "Personality", "Role", "Engages in"]) {
    const row = extractSimpleRow(text, key);
    if (row) {
      context.traits[key] = extractAnchorTexts(row);
    }
  }
  return compactContext(context);
}

function extractAliasTexts(html) {
  const values = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch = rowPattern.exec(String(html || ""));
  while (rowMatch) {
    const cells = [];
    const cellPattern = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch = cellPattern.exec(rowMatch[1]);
    while (cellMatch) {
      const value = htmlText(cellMatch[1]);
      if (value) {
        cells.push(value);
      }
      cellMatch = cellPattern.exec(rowMatch[1]);
    }
    if (cells.length) {
      values.push(cells.join(" / "));
    }
    rowMatch = rowPattern.exec(String(html || ""));
  }
  return values.length ? values : linesFromText(htmlText(html));
}

function extractSimpleRow(html, key) {
  const keyPattern = escapeRegExp(key);
  const pattern = new RegExp(`<tr[^>]*>\\s*<td[^>]*class=["'][^"']*\\bkey\\b[^"']*["'][^>]*>\\s*(?:<a[^>]*>)?${keyPattern}(?:<\\/a>)?\\s*<\\/td>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>\\s*<\\/tr>`, "i");
  return firstMatch(html, pattern);
}

function extractAnchorTexts(html) {
  const values = [];
  const pattern = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let match = pattern.exec(String(html || ""));
  while (match) {
    const value = htmlText(match[1]);
    if (value) {
      values.push(value);
    }
    match = pattern.exec(String(html || ""));
  }
  return values.length ? values : splitCommaText(htmlText(html));
}

function compactContext(context) {
  const uniqueAliases = unique((context.aliases || []).map(normalizeText).filter(Boolean)).slice(0, 10);
  const traits = {};
  for (const [key, values] of Object.entries(context.traits || {})) {
    const cleaned = unique((values || []).map(normalizeText).filter(Boolean)).slice(0, 18);
    if (cleaned.length) {
      traits[key] = cleaned;
    }
  }
  return {
    url: context.url || "",
    name: normalizeText(context.name),
    originalName: normalizeText(context.originalName),
    aliases: uniqueAliases,
    sex: normalizeText(context.sex),
    measurements: normalizeText(context.measurements),
    traits,
    visualNovels: unique((context.visualNovels || []).map(normalizeText).filter(Boolean)).slice(0, 8),
    voicedBy: normalizeText(context.voicedBy),
    imageUrl: context.imageUrl || ""
  };
}

function vndbVisualPrompt(context) {
  const traits = context.traits || {};
  const parts = [];
  parts.push(...traitTags("Hair", traits.Hair));
  parts.push(...traitTags("Eyes", traits.Eyes));
  parts.push(...traitTags("Clothes", traits.Clothes));
  parts.push(...traitTags("Items", traits.Items));
  return sanitizePrompt(unique(parts).join(", "));
}

function traitTags(group, values = []) {
  return values.map((value) => traitToPromptTag(group, value)).filter(Boolean);
}

function traitToPromptTag(group, value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) {
    return "";
  }
  const direct = {
    "waist length+": "very long hair",
    "blunt bangs": "blunt bangs",
    "hime cut": "hime cut",
    "thigh-high stockings": "thighhighs",
    "string ribbon tie": "ribbon tie",
    "miko's dress": "miko outfit"
  };
  if (direct[text]) {
    return direct[text];
  }
  if (group === "Hair" && !/hair|bangs|cut|twintails|ponytail|braid/.test(text)) {
    return `${text} hair`;
  }
  if (group === "Eyes" && !/eyes|pupil|hosome/.test(text)) {
    return `${text} eyes`;
  }
  return text;
}

function firstVisualNovelTitle(context) {
  const value = context.visualNovels?.[0] || "";
  return normalizeText(value.replace(/^(main|side|appears as|mentioned).*?\s+-\s+/i, ""));
}

function sexFromDom(root) {
  const title = [...root.querySelectorAll("abbr[title]")]
    .map((node) => node.getAttribute("title") || "")
    .find((value) => /^Sex:/i.test(value));
  return normalizeText(String(title || "").replace(/^Sex:\s*/i, ""));
}

function linesFromText(value) {
  return unique(String(value || "")
    .split(/[\n;]+/)
    .map(normalizeText)
    .filter(Boolean));
}

function splitCommaText(value) {
  return unique(String(value || "")
    .split(/,|\n/)
    .map(normalizeText)
    .filter(Boolean));
}

function normalizeText(value) {
  return htmlEntityDecode(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlText(value) {
  return normalizeText(String(value || "").replace(/<br\s*\/?>/gi, "\n"));
}

function htmlEntityDecode(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
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

function firstMatch(text, pattern) {
  return String(text || "").match(pattern)?.[1] || "";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = String(value).toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}
