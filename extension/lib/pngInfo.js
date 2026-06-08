const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function readUint32(bytes, offset) {
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}

function indexOfNull(bytes, start = 0) {
  for (let i = start; i < bytes.length; i += 1) {
    if (bytes[i] === 0) {
      return i;
    }
  }
  return -1;
}

function decode(bytes, encoding = "utf-8") {
  return new TextDecoder(encoding).decode(bytes);
}

function parseTextChunk(type, data) {
  if (type === "tEXt") {
    const nul = indexOfNull(data);
    if (nul < 0) {
      return null;
    }
    return {
      type,
      keyword: decode(data.slice(0, nul), "iso-8859-1"),
      text: decode(data.slice(nul + 1), "iso-8859-1")
    };
  }

  if (type === "iTXt") {
    const keywordEnd = indexOfNull(data);
    if (keywordEnd < 0 || keywordEnd + 3 >= data.length) {
      return null;
    }
    const compressionFlag = data[keywordEnd + 1];
    let cursor = keywordEnd + 3;
    const languageEnd = indexOfNull(data, cursor);
    if (languageEnd < 0) {
      return null;
    }
    cursor = languageEnd + 1;
    const translatedEnd = indexOfNull(data, cursor);
    if (translatedEnd < 0) {
      return null;
    }
    cursor = translatedEnd + 1;
    return {
      type,
      keyword: decode(data.slice(0, keywordEnd), "utf-8"),
      text: compressionFlag === 0 ? decode(data.slice(cursor), "utf-8") : "",
      compressed: compressionFlag !== 0
    };
  }

  if (type === "zTXt") {
    const nul = indexOfNull(data);
    return {
      type,
      keyword: nul >= 0 ? decode(data.slice(0, nul), "iso-8859-1") : "",
      text: "",
      compressed: true
    };
  }

  return null;
}

export function extractPngTextChunks(arrayBufferOrBytes) {
  const bytes = arrayBufferOrBytes instanceof Uint8Array
    ? arrayBufferOrBytes
    : new Uint8Array(arrayBufferOrBytes);

  if (bytes.length < PNG_SIGNATURE.length) {
    throw new Error("File is too small to be a PNG.");
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      throw new Error("Only PNG metadata is supported for automatic info extraction.");
    }
  }

  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset);
    offset += 4;
    const type = decode(bytes.slice(offset, offset + 4), "ascii");
    offset += 4;
    const data = bytes.slice(offset, offset + length);
    offset += length + 4;

    const textChunk = parseTextChunk(type, data);
    if (textChunk) {
      chunks.push(textChunk);
    }
    if (type === "IEND") {
      break;
    }
  }
  return chunks;
}

export function extractPngParametersFromArrayBuffer(arrayBufferOrBytes) {
  const chunks = extractPngTextChunks(arrayBufferOrBytes);
  const parameters = chunks.find((chunk) => chunk.keyword === "parameters" && chunk.text);
  if (parameters) {
    return {
      parameters: parameters.text,
      chunks
    };
  }

  const firstText = chunks.find((chunk) => chunk.text);
  if (firstText) {
    return {
      parameters: firstText.text,
      chunks
    };
  }

  const compressed = chunks.find((chunk) => chunk.compressed);
  if (compressed) {
    throw new Error("This PNG stores compressed metadata, which Chrome cannot decode without an extra decompressor.");
  }
  throw new Error("No Stable Diffusion parameters text was found in this PNG.");
}

export async function extractPngParametersFromFile(file) {
  return extractPngParametersFromArrayBuffer(await file.arrayBuffer());
}
