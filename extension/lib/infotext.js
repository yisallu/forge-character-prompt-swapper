export function splitCommaAware(text) {
  const parts = [];
  let current = "";
  let quote = null;

  for (const char of text) {
    if ((char === "\"" || char === "'") && !quote) {
      quote = char;
      current += char;
      continue;
    }
    if (quote && char === quote) {
      quote = null;
      current += char;
      continue;
    }
    if (char === "," && !quote) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

export function parseParametersLine(line) {
  const params = {};
  for (const part of splitCommaAware(line || "")) {
    const separator = part.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim().replace(/^"|"$/g, "");
    if (key) {
      params[key] = value;
    }
  }
  return params;
}

export function parseInfotext(infoText) {
  const raw = (infoText || "").replace(/\r\n/g, "\n").trim();
  if (!raw) {
    throw new Error("The parameters text is empty.");
  }

  let positive = raw;
  let negative = "";
  let parameterLine = "";
  const negativeMarker = "\nNegative prompt:";
  const negativeIndex = raw.indexOf(negativeMarker);

  if (negativeIndex >= 0) {
    positive = raw.slice(0, negativeIndex).trim();
    const rest = raw.slice(negativeIndex + negativeMarker.length).trim();
    const stepsIndex = rest.search(/\nSteps:\s*/);
    if (stepsIndex >= 0) {
      negative = rest.slice(0, stepsIndex).trim();
      parameterLine = rest.slice(stepsIndex + 1).trim();
    } else if (rest.startsWith("Steps:")) {
      parameterLine = rest;
    } else {
      negative = rest;
    }
  } else {
    const stepsIndex = raw.search(/\nSteps:\s*/);
    if (stepsIndex >= 0) {
      positive = raw.slice(0, stepsIndex).trim();
      parameterLine = raw.slice(stepsIndex + 1).trim();
    }
  }

  const params = parseParametersLine(parameterLine);
  return {
    raw,
    positive,
    negative,
    parameterLine,
    params
  };
}

export function summarizeParams(parsed) {
  const params = parsed?.params || {};
  const fields = [
    ["Steps", params.Steps],
    ["Sampler", params.Sampler],
    ["Schedule", params["Schedule type"]],
    ["CFG", params["CFG scale"]],
    ["Seed", params.Seed],
    ["Size", params.Size],
    ["Model", params.Model],
    ["Hires", params["Hires upscale"] ? `${params["Hires upscale"]}x` : ""]
  ];
  return fields
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`)
    .join(" · ");
}
