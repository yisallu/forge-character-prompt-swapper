export function normalizeTagKey(tag) {
  return extractTagCore(tag)
    .toLowerCase()
    .replace(/\s+/g, "_")
    .trim();
}

export function extractTagCore(tag) {
  let text = String(tag || "").trim();
  if (!text || text.startsWith("<") || text.includes(":") && /^<[^>]+>$/.test(text)) {
    return text;
  }

  let changed = true;
  while (changed && text.length > 1) {
    changed = false;
    for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
      if (text.startsWith(open) && text.endsWith(close) && isBalancedWrapper(text, open, close)) {
        text = text.slice(1, -1).trim();
        changed = true;
      }
    }
  }

  const weighted = text.match(/^(.+):\s*-?\d+(?:\.\d+)?$/);
  if (weighted) {
    text = weighted[1].trim();
  }
  return text;
}

export function isTranslatablePromptTag(tag) {
  const core = extractTagCore(tag);
  if (!core || core.startsWith("<") || /[\u4e00-\u9fff]/.test(core)) {
    return false;
  }
  if (/^[\d\s:()[\]{}.,+-]+$/.test(core)) {
    return false;
  }
  return /[a-zA-Z]/.test(core);
}

export function applyTranslationCache(tags, cache) {
  for (const tag of tags) {
    const key = normalizeTagKey(tag.text);
    tag.zh = cache[key] || "";
  }
}

export function mergeTranslationsIntoCache(cache, translations) {
  let added = 0;
  for (const [tag, translation] of Object.entries(translations || {})) {
    const key = normalizeTagKey(tag);
    const value = sanitizeTranslation(translation);
    if (key && value && cache[key] !== value) {
      cache[key] = value;
      added += 1;
    }
  }
  return added;
}

export async function fetchLocalCsvTranslationsForTags(tags, settings, fetcher = fetch) {
  const missing = uniqueLookupTags(tags);
  if (!missing.length) {
    return {};
  }

  const base = trimRight(settings.forgeApiUrl);
  const response = await fetcher(`${base}/physton_prompt/get_csvs`, { method: "GET", cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Forge CSV 列表返回 ${response.status}`);
  }
  const data = await response.json();
  const csvs = prioritizeCsvFiles(data.csvs || []);
  const translations = {};
  let remaining = new Set(missing.map((tag) => normalizeTagKey(tag)));

  for (const csv of csvs) {
    if (!remaining.size) {
      break;
    }
    const text = await fetchCsvText(base, csv.key, fetcher);
    const found = extractCsvTranslations(text, remaining);
    for (const [tag, translation] of Object.entries(found)) {
      translations[tag] = translation;
      remaining.delete(normalizeTagKey(tag));
    }
  }

  return translations;
}

export async function translateTagsWithForgePlugin(tags, settings, fetcher = fetch) {
  const uniqueTags = uniqueLookupTags(tags).filter(isTranslatablePromptTag);
  if (!uniqueTags.length) {
    return {};
  }

  const base = trimRight(settings.forgeApiUrl);
  const api = await readPromptAllInOneData(base, "translateApi", fetcher).catch(() => "alibaba_free") || "alibaba_free";
  const apiConfig = await readPromptAllInOneData(base, `translate_api.${api}`, fetcher).catch(() => ({})) || {};
  const cleanTags = uniqueTags.map((tag) => extractTagCore(tag).replace(/_/g, " "));
  const response = await fetcher(`${base}/physton_prompt/translates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      texts: cleanTags,
      from_lang: "en_US",
      to_lang: "zh_CN",
      api,
      api_config: apiConfig && typeof apiConfig === "object" ? apiConfig : {}
    })
  });
  if (!response.ok) {
    throw new Error(`Forge 翻译接口返回 ${response.status}`);
  }
  const data = await response.json();
  if (!data.success || !Array.isArray(data.translated_text)) {
    throw new Error(data.message || "Forge 翻译接口没有返回可用结果");
  }

  const translations = {};
  uniqueTags.forEach((tag, index) => {
    translations[tag] = data.translated_text[index] || "";
  });
  return translations;
}

export function extractCsvTranslations(csvText, wantedKeys) {
  const wanted = wantedKeys instanceof Set ? wantedKeys : new Set(wantedKeys);
  const result = {};
  for (const row of parseCsvRows(csvText)) {
    if (!row.length || String(row[0] || "").startsWith("#")) {
      continue;
    }
    const tag = String(row[0] || "").trim();
    const key = normalizeTagKey(tag);
    if (!wanted.has(key)) {
      continue;
    }
    const translation = translationFromCsvRow(row);
    if (translation) {
      result[tag] = translation;
    }
  }
  return result;
}

export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < String(text || "").length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        value += "\"";
        i += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        value += char;
      }
      continue;
    }

    if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }

  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

function translationFromCsvRow(row) {
  const candidates = [];
  if (row[4]) {
    candidates.push(row[4]);
  }
  if (row.length === 2) {
    candidates.push(row[1]);
  }
  if (row.length === 3) {
    candidates.push(row[2]);
  }
  if (row[3]) {
    candidates.push(...String(row[3]).split(","));
  }

  for (const candidate of candidates) {
    const value = sanitizeTranslation(candidate);
    if (value && /[\u4e00-\u9fff]/.test(value)) {
      return value;
    }
  }
  return "";
}

function prioritizeCsvFiles(csvs) {
  return [...csvs]
    .filter((csv) => csv?.key && /\.csv$/i.test(csv.name || csv.key))
    .sort((a, b) => csvPriority(a) - csvPriority(b));
}

function csvPriority(csv) {
  const name = String(csv.name || csv.key || "").toLowerCase();
  if (/zh|cn|chinese|translation|translate|tagtable/.test(name)) {
    return 0;
  }
  if (name === "extra-quality-tags.csv") {
    return 1;
  }
  if (name === "danbooru.csv") {
    return 2;
  }
  if (name === "danbooru_e621_merged.csv") {
    return 3;
  }
  return 9;
}

async function fetchCsvText(base, key, fetcher) {
  const response = await fetcher(`${base}/physton_prompt/get_csv?key=${encodeURIComponent(key)}`, {
    method: "GET",
    cache: "force-cache"
  });
  if (!response.ok) {
    return "";
  }
  return response.text();
}

async function readPromptAllInOneData(base, key, fetcher) {
  const response = await fetcher(`${base}/physton_prompt/get_data?key=${encodeURIComponent(key)}`, {
    method: "GET",
    cache: "no-store"
  });
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  return data.data;
}

function uniqueLookupTags(tags) {
  const seen = new Set();
  const result = [];
  for (const tag of tags) {
    if (!isTranslatablePromptTag(tag)) {
      continue;
    }
    const key = normalizeTagKey(tag);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(tag);
  }
  return result;
}

function sanitizeTranslation(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["']|["']$/g, "")
    .slice(0, 80);
}

function isBalancedWrapper(text, open, close) {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === open) {
      depth += 1;
    } else if (text[i] === close) {
      depth -= 1;
      if (depth === 0 && i < text.length - 1) {
        return false;
      }
    }
  }
  return depth === 0;
}

function trimRight(value) {
  return String(value || "").replace(/\/+$/, "");
}
