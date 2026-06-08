function numberValue(value, fallback = undefined) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function intValue(value, fallback = undefined) {
  const parsed = numberValue(value, fallback);
  return parsed === undefined ? undefined : Math.trunc(parsed);
}

function parseSize(size) {
  const match = String(size || "").match(/(\d+)\s*x\s*(\d+)/i);
  if (!match) {
    return {};
  }
  return {
    width: Number(match[1]),
    height: Number(match[2])
  };
}

function assignDefined(target, key, value) {
  if (value !== undefined && value !== null && value !== "") {
    target[key] = value;
  }
}

export function buildForgeTxt2ImgPayload(template, settings = {}) {
  const params = template?.params || {};
  const size = parseSize(params.Size);
  const hiresMode = settings.hiresMode || "template";
  const payload = {
    prompt: template?.positive || "",
    negative_prompt: template?.negative || "",
    batch_size: 1,
    n_iter: 1,
    do_not_save_samples: false,
    do_not_save_grid: true,
    send_images: true,
    save_images: true
  };

  assignDefined(payload, "steps", intValue(params.Steps));
  assignDefined(payload, "sampler_name", params.Sampler);
  assignDefined(payload, "scheduler", params["Schedule type"]);
  assignDefined(payload, "cfg_scale", numberValue(params["CFG scale"]));
  assignDefined(payload, "width", size.width);
  assignDefined(payload, "height", size.height);

  payload.seed = -1;

  const sdModelCheckpoint = String(settings.sdModelCheckpoint || "").trim();
  if (sdModelCheckpoint) {
    payload.override_settings = {
      sd_model_checkpoint: sdModelCheckpoint
    };
    payload.override_settings_restore_afterwards = false;
  }

  const templateHiresScale = numberValue(params["Hires upscale"]);
  const hiresSteps = intValue(params["Hires steps"]);
  const templateHiresUpscaler = params["Hires upscaler"];
  const templateHiresDenoise = numberValue(params["Denoising strength"]);
  const forceHires = hiresMode === "on";
  const disableHires = hiresMode === "off";
  const hasTemplateHires = Boolean(templateHiresScale || hiresSteps || templateHiresUpscaler);

  if (!disableHires && (forceHires || hasTemplateHires)) {
    const hiresScale = forceHires
      ? numberValue(settings.hiresScale, templateHiresScale || 2)
      : templateHiresScale;
    const hiresUpscaler = String(settings.hiresUpscaler || templateHiresUpscaler || (forceHires ? "Latent" : "")).trim();
    const hiresDenoise = numberValue(settings.hiresDenoisingStrength, templateHiresDenoise);
    payload.enable_hr = true;
    payload.hr_additional_modules = ["Use same choices"];
    assignDefined(payload, "hr_scale", hiresScale);
    assignDefined(payload, "hr_upscaler", hiresUpscaler);
    assignDefined(payload, "hr_second_pass_steps", hiresSteps);
    assignDefined(payload, "hr_cfg", numberValue(params["Hires CFG Scale"]));
    assignDefined(payload, "denoising_strength", hiresDenoise);
  } else if (disableHires) {
    payload.enable_hr = false;
  }

  return payload;
}
