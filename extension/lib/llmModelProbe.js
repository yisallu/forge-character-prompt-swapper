export const VISION_PROBE_IMAGE_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAnklEQVR42u3YwQ2DMAwFUM/CTlyZj0U6E0c6AWkQURqHZ3mA/+RDYseZvAIAAAAAAGBKwPLZnjQAAAAAAAAAAAAAAAAAAEBd7euRD7Cvx1WPDihEv8v4w12oMn2lIUZOX2OIwdP/NMT46csGgC7pCwYAgASAJumvDCYAAOAlfgsg/W90hn1gho1shp2401WiP6bxXShLAQAAAAC8G/AFZHXLzkgQWd0AAAAASUVORK5CYII=";

const VISION_PATTERNS = [
  { pattern: /\b(?:vision|visual|image|img|multimodal|omni|vl|qvq|vqa)\b/i, score: 95 },
  { pattern: /\bgpt-(?:4o|4\.1|4\.5|5|5\.5|o[1-9])/i, score: 80 },
  { pattern: /\bo(?:3|4)(?:[-_]|$)/i, score: 72 },
  { pattern: /\bgemini\b/i, score: 72 },
  { pattern: /\bclaude\b|\bsonnet\b|\bopus\b|\bhaiku\b/i, score: 66 },
  { pattern: /\bqwen(?:2|2\.5|3)?[-_ ]?(?:vl|omni|vision)\b/i, score: 92 },
  { pattern: /\bglm[-_ ]?4v\b|\bcogvlm\b|\binternvl\b|\bllava\b|\bminicpm[-_ ]?v\b/i, score: 92 },
  { pattern: /\bdoubao\b|\bseed\b|\bvolc/i, score: 58 },
  { pattern: /\bkimi[-_ ]?vl\b|\bmoonshot[-_ ]?vl\b/i, score: 85 },
  { pattern: /\bmimo\b|\bxiaomi\b/i, score: 38 }
];

const NON_CHAT_PATTERNS = [
  /embedding|embed|rerank|bge|jina/i,
  /tts|audio|whisper|speech|asr|voice/i,
  /moderation|guard|safety/i,
  /image[-_ ]?(?:gen|generation)|text[-_ ]?to[-_ ]?image|dall|flux|stable|sdxl|midjourney/i,
  /video|i2v|t2v/i
];

export function parseModelListPayload(payload) {
  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.data)
      ? parsed.data
      : Array.isArray(parsed?.models)
        ? parsed.models
        : [];

  const seen = new Set();
  return rows
    .map((row) => normalizeModelRow(row))
    .filter((model) => {
      if (!model.id || seen.has(model.id)) {
        return false;
      }
      seen.add(model.id);
      return true;
    });
}

export function selectVisionProbeCandidates(models, currentModel = "", maxCount = 24) {
  const current = String(currentModel || "").trim();
  const normalized = models
    .map((model) => typeof model === "string" ? { id: model } : model)
    .map((model) => ({ ...model, id: String(model?.id || "").trim() }))
    .filter((model) => model.id);

  if (current && !normalized.some((model) => sameModel(model.id, current))) {
    normalized.unshift({ id: current, source: "current" });
  }

  const scored = normalized
    .map((model) => ({
      id: model.id,
      score: scoreVisionModelId(model.id, current),
      reason: describeCandidateReason(model.id, current)
    }))
    .filter((model) => model.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const currentHit = current
    ? scored.find((model) => sameModel(model.id, current)) || { id: current, score: 10000, reason: "当前填写模型" }
    : null;
  const candidates = currentHit
    ? [currentHit, ...scored.filter((model) => !sameModel(model.id, current))]
    : scored;

  return dedupeModels(candidates).slice(0, Math.max(1, maxCount));
}

export function buildVisionProbeRequest({ model, imageDataUrl = VISION_PROBE_IMAGE_DATA_URL }) {
  return {
    model,
    temperature: 0,
    max_tokens: 120,
    messages: [
      {
        role: "system",
        content: "You test whether a chat model can inspect images. Answer JSON only."
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "Look at the attached image and report what colored shapes are visible.",
              "Do not guess from the text. If you cannot inspect the image, set can_see_image to false.",
              "Return JSON only: {\"can_see_image\": boolean, \"description\": string}."
            ].join(" ")
          },
          {
            type: "image_url",
            image_url: {
              url: imageDataUrl,
              detail: "low"
            }
          }
        ]
      }
    ]
  };
}

export function evaluateVisionProbeContent(content) {
  const text = String(content || "").trim();
  const lower = text.toLowerCase();
  const denial = /cannot|can't|unable|not able|no image|as an ai text|无法|不能|看不到|无法查看|无法看到|不能查看|不能看到/.test(lower);
  const green = /green|lime|emerald|绿色|绿/.test(lower);
  const purple = /purple|violet|magenta|lavender|紫色|紫/.test(lower);
  const square = /square|rectangle|rectangular|方形|矩形|正方形/.test(lower);
  const circle = /circle|round|circular|圆形|圆/.test(lower);
  const explicitTrue = /"can_see_image"\s*:\s*true|can_see_image\s*[:=]\s*true/i.test(text);
  const colorHits = Number(green) + Number(purple);
  const shapeHits = Number(square) + Number(circle);
  const canSeeImage = !denial && colorHits >= 2 && (shapeHits >= 1 || explicitTrue);

  return {
    canSeeImage,
    evidence: [
      green ? "green" : "",
      purple ? "purple" : "",
      square ? "square" : "",
      circle ? "circle" : ""
    ].filter(Boolean).join(", "),
    preview: text.replace(/\s+/g, " ").slice(0, 220)
  };
}

function normalizeModelRow(row) {
  if (typeof row === "string") {
    return { id: row };
  }
  return {
    id: String(row?.id || row?.model || row?.name || row?.value || "").trim(),
    owned_by: row?.owned_by || row?.owner || "",
    created: row?.created || ""
  };
}

function scoreVisionModelId(id, currentModel) {
  const name = String(id || "");
  let score = sameModel(name, currentModel) ? 10000 : 0;
  for (const { pattern, score: patternScore } of VISION_PATTERNS) {
    if (pattern.test(name)) {
      score += patternScore;
    }
  }
  for (const pattern of NON_CHAT_PATTERNS) {
    if (pattern.test(name)) {
      score -= 120;
    }
  }
  return score;
}

function describeCandidateReason(id, currentModel) {
  if (sameModel(id, currentModel)) {
    return "当前填写模型";
  }
  const matched = VISION_PATTERNS.find(({ pattern }) => pattern.test(id));
  return matched ? "名称疑似支持图片" : "候选模型";
}

function sameModel(left, right) {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
}

function dedupeModels(models) {
  const seen = new Set();
  return models.filter((model) => {
    const key = model.id.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
