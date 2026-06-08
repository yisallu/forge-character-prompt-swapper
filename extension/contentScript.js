const TOAST_ID = "forge-character-prompt-swapper-toast";

document.addEventListener("click", (event) => {
  handleShiftClick(event).catch((error) => {
    showToast(contentScriptErrorMessage(error), "error");
  });
}, true);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "FORGE_SWAPPER_TOAST") {
    showToast(message.message, message.kind);
  }
});

async function handleShiftClick(event) {
  if (!event.shiftKey || event.button !== 0) {
    return;
  }

  const image = await findImageAtPoint(event.clientX, event.clientY, event);
  if (!image?.src && !image?.dataUrl) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  await enrichCharacterFromLinkedPage(image);
  showToast("已捕获图片，准备识别", "info");

  await sendShiftImageClicked(image);
}

async function sendShiftImageClicked(image) {
  try {
    if (!chrome?.runtime?.id) {
      throw new Error("Extension context invalidated.");
    }
    const response = await chrome.runtime.sendMessage({
      type: "SHIFT_IMAGE_CLICKED",
      image
    });
    if (!response?.ok) {
      showToast(response?.error || "处理失败", "error");
    }
  } catch (error) {
    showToast(contentScriptErrorMessage(error), "error");
  }
}

function contentScriptErrorMessage(error) {
  const message = error?.message || String(error || "");
  if (/extension context invalidated|context invalidated/i.test(message)) {
    return "扩展已重新加载，请刷新当前网页后再点图片";
  }
  if (/receiving end does not exist|could not establish connection/i.test(message)) {
    return "扩展后台未响应，请重新加载扩展或刷新网页";
  }
  return message || "扩展后台未响应";
}

async function findImageAtPoint(clientX, clientY, event) {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  for (const node of path) {
    const image = await imageFromElement(node);
    if (image) {
      return image;
    }
  }

  let element = document.elementFromPoint(clientX, clientY);
  while (element && element !== document.documentElement) {
    const image = await imageFromElement(element);
    if (image) {
      return image;
    }
    element = element.parentElement;
  }

  return null;
}

async function imageFromElement(element) {
  if (!(element instanceof Element)) {
    return null;
  }

  if (element instanceof HTMLImageElement) {
    return {
      src: element.currentSrc || element.src,
      dataUrl: tryCanvasCapture(element),
      alt: element.alt || "",
      title: element.title || "",
      ariaLabel: imageAriaLabel(element),
      pageTitle: document.title || "",
      linkUrl: element.closest("a")?.href || "",
      nearbyText: nearbyText(element),
      naturalWidth: element.naturalWidth || 0,
      naturalHeight: element.naturalHeight || 0,
      pageUrl: location.href
    };
  }

  const background = getComputedStyle(element).backgroundImage;
  const match = background && background.match(/url\(["']?(.+?)["']?\)/);
  if (match?.[1]) {
    return {
      src: new URL(match[1], location.href).href,
      alt: element.getAttribute("aria-label") || element.textContent?.slice(0, 200) || "",
      title: element.getAttribute("title") || "",
      ariaLabel: imageAriaLabel(element),
      pageTitle: document.title || "",
      linkUrl: element.closest("a")?.href || "",
      nearbyText: nearbyText(element),
      naturalWidth: element.clientWidth || 0,
      naturalHeight: element.clientHeight || 0,
      pageUrl: location.href
    };
  }

  return null;
}

function tryCanvasCapture(image) {
  try {
    if (!image.complete || !image.naturalWidth || !image.naturalHeight) {
      return "";
    }
    if (Math.max(image.naturalWidth, image.naturalHeight) <= 1600) {
      return "";
    }
    const maxEdge = 1600;
    const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: false });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    return "";
  }
}

async function enrichCharacterFromLinkedPage(image) {
  await enrichVndbCharacterFromLinkedPage(image);
  await enrichMudaeCharacterFromLinkedPage(image);
}

async function enrichVndbCharacterFromLinkedPage(image) {
  if (!isVndbCharacterUrl(image?.linkUrl)) {
    return;
  }

  try {
    showToast("正在读取 VNDB 角色页", "info");
    const url = normalizeVndbCharacterUrl(image.linkUrl);
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
      cache: "force-cache"
    });
    if (!response.ok) {
      throw new Error(`VNDB 角色页返回 ${response.status}`);
    }

    const context = parseVndbCharacterHtml(await response.text(), url);
    if (!context.name && !context.originalName) {
      throw new Error("VNDB 角色页没有解析到角色名");
    }
    image.vndbCharacter = context;
    image.vndbCharacterText = formatVndbCharacterContext(context);
    showToast(`已读取 VNDB：${context.name || context.originalName}`, "success");
  } catch (error) {
    image.vndbCharacterError = error?.message || String(error);
    showToast(`读取 VNDB 角色页失败：${image.vndbCharacterError}`, "error");
  }
}

async function enrichMudaeCharacterFromLinkedPage(image) {
  if (!isMudaeCharacterUrl(image?.linkUrl)) {
    return;
  }

  try {
    showToast("正在读取 Mudae 角色页", "info");
    const url = normalizeMudaeCharacterUrl(image.linkUrl);
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
      cache: "force-cache"
    });
    if (!response.ok) {
      throw new Error(`Mudae 角色页返回 ${response.status}`);
    }

    const context = parseMudaeCharacterHtml(await response.text(), url);
    if (!context.name) {
      throw new Error("Mudae 角色页没有解析到角色名");
    }
    image.mudaeCharacter = context;
    image.mudaeCharacterText = formatMudaeCharacterContext(context);
    showToast(`已读取 Mudae：${context.name}`, "success");
  } catch (error) {
    image.mudaeCharacterError = error?.message || String(error);
    showToast(`读取 Mudae 角色页失败：${image.mudaeCharacterError}`, "error");
  }
}

function isVndbCharacterUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)vndb\.org$/i.test(url.hostname) && /^\/c\d+\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function normalizeVndbCharacterUrl(value) {
  const url = new URL(value);
  url.protocol = "https:";
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

function isMudaeCharacterUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)mudae\.net$/i.test(url.hostname) && /^\/character\/\d+\/[^/]+\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function normalizeMudaeCharacterUrl(value) {
  const url = new URL(value);
  url.protocol = "https:";
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

function parseVndbCharacterHtml(html, pageUrl) {
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
    const valueCell = keyCell?.nextElementSibling;
    const key = normalizeText(keyCell?.textContent);
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
    } else if (key === "Measurements") {
      measurements = normalizeText(valueCell.textContent);
    } else if (["Hair", "Eyes", "Body", "Clothes", "Items", "Personality", "Role", "Engages in"].includes(key)) {
      traits[key] = [...valueCell.querySelectorAll("a")]
        .map((link) => normalizeText(link.textContent))
        .filter(Boolean);
    } else if (key === "Visual novels") {
      visualNovels = linesFromText(valueCell.textContent);
    } else if (key === "Voiced by") {
      voicedBy = normalizeText(valueCell.textContent);
    }
  }

  return {
    url: pageUrl,
    name: normalizeText(article.querySelector("h1")?.textContent),
    originalName: normalizeText(article.querySelector("h2.alttitle")?.textContent),
    aliases: unique(aliases).slice(0, 10),
    sex: sexFromDom(details),
    measurements,
    traits: compactTraits(traits),
    visualNovels: unique(visualNovels).slice(0, 8),
    voicedBy,
    imageUrl: absoluteUrl(doc.querySelector("meta[property='og:image']")?.content || details.querySelector(".charimg img")?.src, pageUrl)
  };
}

function formatVndbCharacterContext(context) {
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

function parseMudaeCharacterHtml(html, pageUrl) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  const bodyText = normalizeText(doc.body?.innerText || doc.body?.textContent || "");
  const title = doc.querySelector("meta[property='og:title'], meta[name='og:title']")?.content ||
    doc.querySelector("title")?.textContent ||
    "";
  const titleInfo = parseMudaeTitle(title);
  const tags = unique([...doc.querySelectorAll("a.tag[href*='/tag/']")]
    .map((link) => normalizeText(link.textContent))
    .filter(Boolean));
  const visualTags = tags
    .filter((tag) => /\b(?:hair|eyes|horns?|fangs?|headband|ribbon|bow|hat|cap|glasses|mask|uniform|dress|skirt|kimono|armor|boots?|shoes?|gloves?|stockings?|tail|wings?|ears?|halo|weapon|sword|staff|scarf|cloak|coat|jacket|shirt|tie|choker|lollipop)\b/i.test(tag))
    .filter((tag) => !/\b(?:breasts?|bust|flat chest|loli|shota|child|teen|minor|young|underage|nsfw|nude|naked)\b/i.test(tag))
    .slice(0, 18);

  return {
    url: pageUrl,
    name: titleInfo.name || decodeMudaeNameFromUrl(pageUrl),
    series: titleInfo.series || normalizeText(doc.querySelector("a[href^='/series/'], a[href*='mudae.net/series/']")?.textContent),
    gender: textAfterLabel(bodyText, "GENDER", ["RANK", "ALIASES", "VOICE ACTORS", "TAGS"]),
    rank: textAfterLabel(bodyText, "RANK", ["favorite", "ALIASES", "VOICE ACTORS", "TAGS"]),
    aliases: parseMudaeAliases(bodyText),
    voiceActors: parseMudaeVoiceActors(bodyText),
    tags,
    visualTags,
    imageUrl: absoluteUrl(doc.querySelector("meta[property='og:image'], meta[name='og:image']")?.content, pageUrl)
  };
}

function formatMudaeCharacterContext(context) {
  return [
    context.url ? `url: ${context.url}` : "",
    context.name ? `name: ${context.name}` : "",
    context.series ? `series: ${context.series}` : "",
    context.gender ? `gender: ${context.gender}` : "",
    context.rank ? `rank: ${context.rank}` : "",
    context.aliases?.length ? `aliases: ${context.aliases.join("; ")}` : "",
    safeMudaeTags(context.tags)?.length ? `tags: ${safeMudaeTags(context.tags).join(", ")}` : "",
    context.visualTags?.length ? `visual_tags: ${context.visualTags.join(", ")}` : "",
    context.voiceActors?.length ? `voice_actors: ${context.voiceActors.join("; ")}` : "",
    context.imageUrl ? `image: ${context.imageUrl}` : ""
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 2400);
}

function parseMudaeTitle(value) {
  const title = normalizeText(String(value || "").replace(/\s+-\s+Mudae$/i, ""));
  const [name, ...seriesParts] = title.split(/\s+\|\s+/);
  return {
    name: normalizeText(name),
    series: normalizeText(seriesParts.join(" | "))
  };
}

function parseMudaeAliases(text) {
  const segment = textAfterLabel(text, "ALIASES", ["VOICE ACTORS", "TAGS", "CUSTOM LISTS", "Images", "Related Characters"]);
  return unique(segment
    .replace(/\b(?:list|update|See more)\b/gi, " ")
    .split(/\s*\|\s*|[;\n]+/)
    .map(normalizeText)
    .filter(Boolean))
    .slice(0, 16);
}

function parseMudaeVoiceActors(text) {
  const segment = textAfterLabel(text, "VOICE ACTORS", ["TAGS", "CUSTOM LISTS", "Images", "Related Characters"]);
  return unique(segment
    .replace(/\b(?:English|Japanese|Korean|Chinese|French|German|Spanish|Portuguese):/gi, "")
    .split(/\s{2,}|[;\n]+/)
    .map(normalizeText)
    .filter(Boolean))
    .slice(0, 12);
}

function safeMudaeTags(tags) {
  return unique((tags || [])
    .map(normalizeText)
    .filter((tag) => !/\b(?:breasts?|bust|flat chest|loli|shota|child|teen|minor|young|underage|nsfw|nude|naked)\b/i.test(tag)))
    .slice(0, 36);
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

function decodeMudaeNameFromUrl(value) {
  try {
    const url = new URL(value);
    const part = url.pathname.split("/").filter(Boolean).at(-1) || "";
    return normalizeText(decodeURIComponent(part).replace(/\{[^}]+\}/g, ""));
  } catch {
    return "";
  }
}

function compactTraits(traits) {
  const result = {};
  for (const [key, values] of Object.entries(traits || {})) {
    const cleaned = unique((values || []).map(normalizeText).filter(Boolean)).slice(0, 18);
    if (cleaned.length) {
      result[key] = cleaned;
    }
  }
  return result;
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

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
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
    const key = String(value).toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function imageAriaLabel(element) {
  return element.getAttribute("aria-label") || element.closest("[aria-label]")?.getAttribute("aria-label") || "";
}

function nearbyText(element) {
  const container = element.closest("figure, article, [role='article'], a") || element.parentElement;
  return String(container?.textContent || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function showToast(message, kind = "info") {
  let toast = document.getElementById(TOAST_ID);
  if (!toast) {
    toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "right:18px",
      "bottom:18px",
      "max-width:min(360px,calc(100vw - 36px))",
      "padding:10px 12px",
      "border-radius:8px",
      "font:13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "color:#f8fafc",
      "box-shadow:0 12px 28px rgba(15,23,42,.28)",
      "transition:opacity .18s ease, transform .18s ease",
      "pointer-events:none"
    ].join(";");
    document.documentElement.appendChild(toast);
  }

  const colors = {
    info: "#1f2937",
    success: "#047857",
    error: "#b91c1c"
  };
  toast.textContent = message;
  toast.style.background = colors[kind] || colors.info;
  toast.style.opacity = "1";
  toast.style.transform = "translateY(0)";
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(8px)";
  }, kind === "error" ? 6200 : 3600);
}
