import assert from "node:assert/strict";
import fs from "node:fs";
import { extractPngParametersFromArrayBuffer } from "../extension/lib/pngInfo.js";
import { parseInfotext } from "../extension/lib/infotext.js";
import { guessCharacterSegment, removeUndesiredSkinToneTags, replaceCharacterInPrompt, replacePromptSegment, splitPromptTags, stripGeneratedCharacterDetailsForDefault } from "../extension/lib/promptMerge.js";
import { buildForgeTxt2ImgPayload } from "../extension/lib/forgePayload.js";
import { llmChatCompletionsUrl, normalizeLlmBaseUrl } from "../extension/lib/llmEndpoint.js";
import { extractChatMessageContent, formatLlmHttpError } from "../extension/lib/llmResponse.js";
import { buildIdentifyCharacterRequest, parseCharacterResponse } from "../extension/lib/characterIdentify.js";
import { applyCharacterTagLimit } from "../extension/lib/characterPromptLimit.js";
import { buildCleanTemplatePromptRequest, parseCleanTemplatePromptResponse } from "../extension/lib/templatePromptClean.js";
import {
  extractCsvTranslations,
  extractTagCore,
  normalizeTagKey,
  parseCsvRows
} from "../extension/lib/tagTranslations.js";
import {
  formatVndbCharacterContext,
  isVndbCharacterUrl,
  mergeVndbContextIntoCharacter,
  parseVndbCharacterHtml
} from "../extension/lib/vndbCharacter.js";
import {
  formatMudaeCharacterContext,
  isMudaeCharacterUrl,
  mergeMudaeContextIntoCharacter,
  parseMudaeCharacterHtml
} from "../extension/lib/mudaeCharacter.js";

const sample = "D:/sd-webui-forge-neo/output/txt2img-images/2026-06-07/00213-913612528.png";

const uncertainCharacter = parseCharacterResponse(JSON.stringify({
  known_identity: false,
  character_name: "Hatsune Miku",
  series: "Vocaloid",
  character_prompt: "hatsune miku, vocaloid",
  visual_prompt: "aqua hair, twintails, black hair ribbons, sleeveless outfit",
  confidence: 0.4
}));
assert.equal(uncertainCharacter.known_identity, false);
assert.equal(uncertainCharacter.character_name, "");
assert.equal(uncertainCharacter.series, "");
assert.equal(uncertainCharacter.character_prompt, "aqua hair, twintails, black hair ribbons, sleeveless outfit");

const paleCharacter = parseCharacterResponse(JSON.stringify({
  known_identity: true,
  character_name: "Carmilla",
  series: "VenusBlood",
  character_prompt: "Carmilla, VenusBlood, blonde hair, red eyes, pale skin, porcelain skin, white dress",
  visual_prompt: "blonde hair, red eyes, pale skin, white dress",
  confidence: 0.95
}));
assert.equal(paleCharacter.known_identity, true);
assert.doesNotMatch(paleCharacter.character_prompt, /pale skin|porcelain skin/i);
assert.match(paleCharacter.character_prompt, /white dress/);

const limitedKnownCharacter = applyCharacterTagLimit({
  known_identity: true,
  character_name: "Hinata Hyuuga",
  series: "Naruto",
  character_prompt: "Hinata Hyuuga, Naruto, black hair, white eyes, white hoodie, purple clothing",
  visual_prompt: "black hair, white eyes, white hoodie, purple clothing"
}, {
  limitCharacterTags: true,
  characterTagLimit: 3
});
assert.equal(limitedKnownCharacter.character.character_prompt, "Hinata Hyuuga, Naruto, black hair");
assert.equal(limitedKnownCharacter.character.full_character_prompt, "Hinata Hyuuga, Naruto, black hair, white eyes, white hoodie, purple clothing");
assert.match(limitedKnownCharacter.character.character_prompt_removed, /white eyes/);

const unlimitedCharacter = applyCharacterTagLimit({
  known_identity: true,
  character_name: "Hinata Hyuuga",
  series: "Naruto",
  character_prompt: "Hinata Hyuuga, Naruto, black hair, white eyes"
}, {
  limitCharacterTags: false,
  characterTagLimit: 3
});
assert.equal(unlimitedCharacter.character.character_prompt, "Hinata Hyuuga, Naruto, black hair, white eyes");
assert.equal(unlimitedCharacter.applied, false);

const identifyRequest = buildIdentifyCharacterRequest({
  imageDataUrl: "data:image/png;base64,AAAA",
  settings: { llmModel: "gpt-5.5" },
  imageMeta: { alt: "sample alt", pageTitle: "sample page" }
});
assert.equal(identifyRequest.temperature, 0);
assert.equal(identifyRequest.messages[1].content[1].image_url.detail, "high");

assert.equal(isVndbCharacterUrl("https://vndb.org/c36559"), true);
assert.equal(isVndbCharacterUrl("https://vndb.org/i1727?f=&m=1"), false);
assert.equal(isMudaeCharacterUrl("https://mudae.net/character/2706259/Zero%20Two"), true);
assert.equal(isMudaeCharacterUrl("https://mudae.net/search?type=character"), false);

const vndbCharacter = parseVndbCharacterHtml(`
<main><article>
  <h1 lang="ja-Latn">Aizome Isuzu</h1>
  <h2 class="alttitle" lang="ja">藍染 五十鈴</h2>
  <div class="chardetails"><table>
    <tr><td class="key">Aliases</td><td><table class="names"><tr><td>薔薇姫</td><td>Barahime</td></tr></table></td></tr>
    <tr><td class="key">Measurements</td><td>Height: 163cm, Bust-Waist-Hips: 87-55-84cm</td></tr>
    <tr><td class="key"><a href="/i1">Hair</a></td><td><a>Black</a>, <a>Hime Cut</a>, <a>Waist Length+</a></td></tr>
    <tr><td class="key"><a href="/i35">Eyes</a></td><td><a>Black</a>, <a>Hosome</a></td></tr>
    <tr><td class="key"><a href="/i36">Body</a></td><td><a>Flat Chest</a>, <a>Pale</a>, <a>Slim</a>, <a>Teen</a></td></tr>
    <tr><td class="key"><a href="/i40">Role</a></td><td><a>Ojousama</a>, <a>Senpai</a></td></tr>
    <tr><td class="key">Visual novels</td><td>Main character - <a title="ヒメと魔神と恋するたましぃ">Hime to Majin to Koi Suru Tamashii</a></td></tr>
  </table></div>
</article></main>
`, "https://vndb.org/c36559");
assert.equal(vndbCharacter.name, "Aizome Isuzu");
assert.equal(vndbCharacter.originalName, "藍染 五十鈴");
assert.deepEqual(vndbCharacter.traits.Hair, ["Black", "Hime Cut", "Waist Length+"]);
const vndbContextText = formatVndbCharacterContext(vndbCharacter);
assert.match(vndbContextText, /Aizome Isuzu/);
assert.match(vndbContextText, /Hair: Black, Hime Cut, Waist Length\+/);

const identifyRequestWithVndb = buildIdentifyCharacterRequest({
  imageDataUrl: "data:image/png;base64,AAAA",
  settings: { llmModel: "gpt-5.5" },
  imageMeta: { linkUrl: "https://vndb.org/c36559", vndbCharacterText: vndbContextText }
});
assert.match(identifyRequestWithVndb.messages[1].content[0].text, /clicked_link_character_page/);
assert.match(identifyRequestWithVndb.messages[1].content[0].text, /Aizome Isuzu/);

const mergedVndbCharacter = mergeVndbContextIntoCharacter({
  known_identity: false,
  character_prompt: "black hair, black eyes",
  visual_prompt: "black hair, black eyes",
  confidence: 0.3
}, vndbCharacter);
assert.equal(mergedVndbCharacter.known_identity, true);
assert.equal(mergedVndbCharacter.character_name, "Aizome Isuzu");
assert.equal(mergedVndbCharacter.confidence, 0.95);
assert.match(mergedVndbCharacter.character_prompt, /Aizome Isuzu/);
assert.doesNotMatch(mergedVndbCharacter.character_prompt, /pale skin|flat chest|teen/i);

const mudaeCharacter = parseMudaeCharacterHtml(`
<html><head>
  <meta property="og:title" content="Zero Two | DARLING in the FRANXX - Mudae">
  <meta property="og:image" content="https://mudae.net/uploads/2706259/2eBVJqB.png">
</head><body>
  <main>
    <a href="/series/9509073/DARLING%20in%20the%20FRANXX">DARLING in the FRANXX</a>
    <section>GENDER Female RANK #1 favorite Login ALIASES list update 002 | Eo To | Partner Killer | The Horned Pistil Parasite VOICE ACTORS English: Tia Ballard Japanese: Haruka Tomatsu TAGS update</section>
    <a class="tag" href="/tag/7945273/Horns">Horns</a>
    <a class="tag" href="/tag/8738891/Long%20Hair">Long Hair</a>
    <a class="tag" href="/tag/2649528/Pink%20Hair">Pink Hair</a>
    <a class="tag" href="/tag/1705400/Teal%20Eyes">Teal Eyes</a>
    <a class="tag" href="/tag/3300667/Medium%20Breasts">Medium Breasts</a>
    <a class="tag" href="/tag/4809807/Military%20Uniform">Military Uniform</a>
  </main>
</body></html>
`, "https://mudae.net/character/2706259/Zero%20Two");
assert.equal(mudaeCharacter.name, "Zero Two");
assert.equal(mudaeCharacter.series, "DARLING in the FRANXX");
assert.equal(mudaeCharacter.rank, "#1");
assert.deepEqual(mudaeCharacter.aliases.slice(0, 2), ["002", "Eo To"]);
assert.match(formatMudaeCharacterContext(mudaeCharacter), /visual_tags: Horns, Long Hair, Pink Hair, Teal Eyes, Military Uniform/);
assert.doesNotMatch(formatMudaeCharacterContext(mudaeCharacter), /Medium Breasts/);
const mergedMudaeCharacter = mergeMudaeContextIntoCharacter({
  known_identity: false,
  character_prompt: "pink hair, horns",
  visual_prompt: "pink hair, horns",
  confidence: 0.2
}, mudaeCharacter);
assert.equal(mergedMudaeCharacter.known_identity, true);
assert.equal(mergedMudaeCharacter.character_name, "Zero Two");
assert.match(mergedMudaeCharacter.character_prompt, /DARLING in the FRANXX/);
assert.doesNotMatch(mergedMudaeCharacter.character_prompt, /Medium Breasts/i);

assert.equal(extractTagCore("((upper body:1.2))"), "upper body");
assert.equal(normalizeTagKey("blue eyes"), "blue_eyes");
assert.deepEqual(parseCsvRows('blue_eyes,0,10,"蓝眼睛,blueeyes"\nlong_hair,长发'), [
  ["blue_eyes", "0", "10", "蓝眼睛,blueeyes"],
  ["long_hair", "长发"]
]);
assert.deepEqual(extractCsvTranslations(
  'blue_eyes,0,10,"蓝眼睛,blueeyes"\nlong_hair,长发\n',
  new Set(["blue_eyes", "long_hair"])
), {
  blue_eyes: "蓝眼睛",
  long_hair: "长发"
});

const apostropheTags = splitPromptTags("(grabbing another's arm:1.2),hands up,disgust,(light leaks:1.3),window,light particles,dust, Smooth Quality, masterpiece");
assert.deepEqual(apostropheTags, [
  "(grabbing another's arm:1.2)",
  "hands up",
  "disgust",
  "(light leaks:1.3)",
  "window",
  "light particles",
  "dust",
  "Smooth Quality",
  "masterpiece"
]);

const skinToneFilteredPrompt = removeUndesiredSkinToneTags("blonde hair, pale skin, white dress, (porcelain skin:1.2), fair skin, red eyes");
assert.equal(skinToneFilteredPrompt, "blonde hair, white dress, red eyes");

const promptWithGeneratedCharacter = "masterpiece, Cecile Liberati, Silverio, blonde hair, blue eyes, ornate dress, castle garden";
const restoredDefaultPrompt = replacePromptSegment(
  promptWithGeneratedCharacter,
  "Cecile Liberati, Silverio, blonde hair, blue eyes",
  "touma kazusa, white album 2"
);
assert.equal(restoredDefaultPrompt, "masterpiece, touma kazusa, white album 2, ornate dress, castle garden");

const strippedDefaultPrompt = stripGeneratedCharacterDetailsForDefault(restoredDefaultPrompt, {
  character: {
    character_name: "Cecile Liberati",
    series: "Silverio",
    character_prompt: "Cecile Liberati, Silverio, blonde hair, blue eyes",
    visual_prompt: "blonde hair, blue eyes"
  },
  templatePositive: "masterpiece, touma kazusa, white album 2, castle garden",
  baseCharacterSegment: "touma kazusa, white album 2"
});
assert.equal(strippedDefaultPrompt, "masterpiece, touma kazusa, white album 2, castle garden");

const strippedRuntimeDefaultPrompt = stripGeneratedCharacterDetailsForDefault(
  "masterpiece, best quality, Hinata Hyuuga, Naruto, black hair, white eyes, white hoodie, purple clothing, long sleeves, teenage girl, faithful Emilia appearance, Emilia official outfit, upper body, looking at viewer, castle garden",
  {
    character: {
      character_name: "Hinata Hyuuga",
      series: "Naruto",
      character_prompt: "Hinata Hyuuga, Naruto, black hair, white eyes, white hoodie, purple clothing, long sleeves",
      visual_prompt: "black hair, white eyes, white hoodie, purple clothing, long sleeves"
    },
    templatePositive: "",
    baseCharacterSegment: ""
  }
);
assert.equal(strippedRuntimeDefaultPrompt, "masterpiece, best quality, upper body, looking at viewer, castle garden");

const cleanTemplateRequest = buildCleanTemplatePromptRequest({
  template: {
    positive: "masterpiece, Hinata Hyuuga, Naruto, black hair, white eyes, white hoodie, upper body",
    negative: "lowres",
    characterSegment: "Hinata Hyuuga, Naruto"
  },
  settings: { llmModel: "gpt-5.5" }
});
assert.equal(cleanTemplateRequest.model, "gpt-5.5");
assert.equal(cleanTemplateRequest.temperature, 0.1);
assert.match(cleanTemplateRequest.messages[1].content, /removed_character_prompt/);

const cleanTemplateParsed = parseCleanTemplatePromptResponse([
  "```json",
  "{",
  "  \"positive_prompt\": \"masterpiece, Hinata Hyuuga, upper body, looking at viewer, soft light\",",
  "  \"removed_character_prompt\": \"Hinata Hyuuga, Naruto, black hair, white eyes, white hoodie\",",
  "  \"reason\": \"removed character identity\"",
  "}",
  "```"
].join("\n"), {
  originalPrompt: "masterpiece, Hinata Hyuuga, Naruto, black hair, white eyes, white hoodie, upper body, looking at viewer, soft light",
  fallbackCharacterSegment: "Hinata Hyuuga, Naruto"
});
assert.equal(cleanTemplateParsed.positive_prompt, "masterpiece, upper body, looking at viewer, soft light");
assert.equal(cleanTemplateParsed.removed_character_prompt, "Hinata Hyuuga, Naruto, black hair, white eyes, white hoodie");

const screenshotBaseTagsCleaned = stripGeneratedCharacterDetailsForDefault(
  "red school blazer, black necktie, ring, (on back:1.1), (upper body:1.3), (pov:1.2), kyoto_animation, (anime coloring:1.4), anime screenshot, glint, looking at viewer",
  {
    character: {
      character_prompt: "red school blazer, black necktie, ring",
      visual_prompt: "red school blazer, black necktie, ring"
    },
    templatePositive: "",
    baseCharacterSegment: ""
  }
);
assert.equal(screenshotBaseTagsCleaned, "(on back:1.1), (upper body:1.3), (pov:1.2), kyoto_animation, (anime coloring:1.4), anime screenshot, glint, looking at viewer");

const llmMissedClothingCleaned = parseCleanTemplatePromptResponse(JSON.stringify({
  positive_prompt: "red school blazer, black necktie, ring, (upper body:1.3), looking at viewer, glint",
  removed_character_prompt: "",
  reason: "missed clothing"
}));
assert.equal(llmMissedClothingCleaned.positive_prompt, "(upper body:1.3), looking at viewer, glint");

if (!fs.existsSync(sample)) {
  console.log(`Skipped: sample image not found at ${sample}`);
  process.exit(0);
}

const bytes = fs.readFileSync(sample);
const extracted = extractPngParametersFromArrayBuffer(bytes);
assert.match(extracted.parameters, /Negative prompt:/);

const parsed = parseInfotext(extracted.parameters);
assert.match(parsed.positive, /touma kazusa/i);
assert.equal(parsed.params.Steps, "20");
assert.equal(parsed.params.Sampler, "Euler a");
assert.equal(parsed.params.Size, "1024x640");

const segment = guessCharacterSegment(parsed.positive);
assert.equal(segment, "touma kazusa, white album 2");

const replaced = replaceCharacterInPrompt(parsed.positive, segment, "hatsune miku, vocaloid, aqua hair, twintails");
assert.match(replaced, /hatsune miku/);
assert.doesNotMatch(replaced, /touma kazusa/i);

const payload = buildForgeTxt2ImgPayload(
  {
    positive: replaced,
    negative: parsed.negative,
    params: parsed.params
  },
  { seedMode: "random" }
);
assert.equal(payload.steps, 20);
assert.equal(payload.sampler_name, "Euler a");
assert.equal(payload.width, 1024);
assert.equal(payload.height, 640);
assert.equal(payload.enable_hr, true);
assert.deepEqual(payload.hr_additional_modules, ["Use same choices"]);
assert.equal(payload.seed, -1);

const noHiresPayload = buildForgeTxt2ImgPayload(
  {
    positive: replaced,
    negative: parsed.negative,
    params: parsed.params
  },
  { seedMode: "random", hiresMode: "off" }
);
assert.equal(noHiresPayload.enable_hr, false);
assert.equal(noHiresPayload.hr_upscaler, undefined);

const overridePayload = buildForgeTxt2ImgPayload(
  {
    positive: replaced,
    negative: parsed.negative,
    params: { ...parsed.params, "Hires upscaler": "Lanczos" }
  },
  {
    seedMode: "random",
    sdModelCheckpoint: "waiNSFWIllustrious_v150.safetensors [befc694a29]",
    hiresMode: "on",
    hiresUpscaler: "RealESRGAN_x4plus_anime_6B",
    hiresScale: 1.5,
    hiresDenoisingStrength: 0.42
  }
);
assert.equal(overridePayload.override_settings.sd_model_checkpoint, "waiNSFWIllustrious_v150.safetensors [befc694a29]");
assert.equal(overridePayload.override_settings_restore_afterwards, false);
assert.equal(overridePayload.enable_hr, true);
assert.equal(overridePayload.hr_upscaler, "RealESRGAN_x4plus_anime_6B");
assert.equal(overridePayload.hr_scale, 1.5);
assert.equal(overridePayload.denoising_strength, 0.42);

const normalLlm = JSON.stringify({
  choices: [{ message: { content: "{\"positive_prompt\":\"a\"}" } }]
});
assert.equal(extractChatMessageContent(normalLlm), "{\"positive_prompt\":\"a\"}");

const oneShotSse = 'data: {"choices":[{"message":{"content":"{\\"positive_prompt\\":\\"b\\"}"}}]}\n\n';
assert.equal(extractChatMessageContent(oneShotSse), "{\"positive_prompt\":\"b\"}");

const streamedSse = [
  'data: {"choices":[{"delta":{"content":"{\\\"positive_prompt\\\":"}}]}',
  'data: {"choices":[{"delta":{"content":"\\\"c\\\"}"}}]}',
  'data: [DONE]'
].join("\n");
assert.equal(extractChatMessageContent(streamedSse), "{\"positive_prompt\":\"c\"}");
assert.equal(normalizeLlmBaseUrl("api.sysmeng.com"), "https://api.sysmeng.com/v1");
assert.equal(normalizeLlmBaseUrl("https://api.sysmeng.com"), "https://api.sysmeng.com/v1");
assert.equal(normalizeLlmBaseUrl("https://api.sysmeng.com/v1"), "https://api.sysmeng.com/v1");
assert.equal(llmChatCompletionsUrl("https://api.sysmeng.com/chat/completions"), "https://api.sysmeng.com/v1/chat/completions");

const html403Error = formatLlmHttpError(
  403,
  JSON.stringify({ error: { message: "<html><head><style>body{color:red}</style></head><body>Forbidden</body></html>" } })
);
assert.match(html403Error, /LLM API 返回 403/);
assert.match(html403Error, /访问被拒绝/);
assert.match(html403Error, /HTML 错误页/);
assert.doesNotMatch(html403Error, /body\{color:red\}/);

console.log("parser ok");
