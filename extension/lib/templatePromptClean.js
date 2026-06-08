import { joinPromptTags, splitPromptTags, stripGeneratedCharacterDetailsForDefault } from "./promptMerge.js";

export function buildCleanTemplatePromptRequest({ template, settings }) {
  return {
    model: settings.llmModel,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: [
          "You clean Stable Diffusion positive prompts imported from PNG info so they can become reusable base templates.",
          "Return JSON only with keys: positive_prompt, removed_character_prompt, reason.",
          "Remove the current character identity, series/franchise names, named-character tags, hair, eyes, body, skin tone, outfit, clothing, accessories, and other character appearance tags.",
          "Preserve quality/style tags, LoRA tags, camera/composition/pose intent, scene, background, lighting, effects, and generation-control tags.",
          "Keep comma-separated English tags. Do not add negative prompt text. Do not invent a replacement character."
        ].join(" ")
      },
      {
        role: "user",
        content: [
          "请把这张基础图 PNG info 里的正向提示词清理成可复用基础模板。",
          "把角色身份、角色外观、服装配饰等放进 removed_character_prompt。",
          "positive_prompt 只能保留通用质量、画风、构图、场景、镜头、光照、LoRA/控制类标签。",
          `当前本地猜测角色段: ${template.characterSegment || "(empty)"}`,
          `正向提示词: ${template.positive || ""}`,
          `负向提示词: ${template.negative || ""}`,
          `参数: ${template.parameterLine || ""}`
        ].join("\n")
      }
    ]
  };
}

export function parseCleanTemplatePromptResponse(text, { originalPrompt = "", fallbackCharacterSegment = "" } = {}) {
  const parsed = parseJsonObject(text);
  const rawPositive = parsed.positive_prompt || parsed.base_prompt || parsed.prompt || "";
  const removedCharacterPrompt = sanitizePrompt(
    parsed.removed_character_prompt ||
    parsed.character_prompt ||
    parsed.character_segment ||
    fallbackCharacterSegment
  );
  let positivePrompt = sanitizePrompt(rawPositive);
  if (!positivePrompt) {
    throw new Error("LLM 没有返回清理后的正向提示词");
  }

  positivePrompt = stripGeneratedCharacterDetailsForDefault(positivePrompt, {
    character: removedCharacterPrompt
      ? {
          character_prompt: removedCharacterPrompt,
          visual_prompt: removedCharacterPrompt
        }
      : null,
    templatePositive: "",
    baseCharacterSegment: ""
  });

  if (!positivePrompt && originalPrompt) {
    positivePrompt = sanitizePrompt(originalPrompt);
  }

  return {
    positive_prompt: positivePrompt,
    removed_character_prompt: removedCharacterPrompt,
    reason: String(parsed.reason || "").trim()
  };
}

function parseJsonObject(text) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
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

function sanitizePrompt(prompt) {
  return joinPromptTags(splitPromptTags(String(prompt || "").replace(/\n+/g, ", ")));
}
