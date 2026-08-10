export interface ToolImageContent {
  type: "image";
  data: string;
  mimeType: string;
  name?: string;
  path?: string;
}

export interface ToolResultParts {
  text: string;
  images: ToolImageContent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function imageFromBlock(value: unknown): ToolImageContent | undefined {
  if (!isRecord(value) || value.type !== "image" || typeof value.data !== "string" || typeof value.mimeType !== "string" || !value.mimeType.startsWith("image/")) return undefined;
  const dataUrl = value.data.match(/^data:[^;,]+;base64,(.*)$/s);
  return { type: "image", data: dataUrl?.[1] || value.data, mimeType: value.mimeType, ...(typeof value.name === "string" ? { name: value.name } : {}), ...(typeof value.path === "string" ? { path: value.path } : {}) };
}

function textFromValue(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** Converts MCP/local tool results into provider-neutral text and image parts. */
export function toolResultParts(value: unknown): ToolResultParts {
  const image = imageFromBlock(value);
  if (image) return { text: "", images: [image] };
  if (Array.isArray(value) && value.every((item) => isRecord(item) && (item.type === "text" || item.type === "image" || item.type === "resource"))) {
    const parts = value.map(toolResultParts);
    return { text: parts.map((item) => item.text).filter(Boolean).join("\n"), images: parts.flatMap((item) => item.images) };
  }
  if (isRecord(value) && Array.isArray(value.content)) {
    const parts = toolResultParts(value.content);
    if (value.structuredContent !== undefined) parts.text = [parts.text, textFromValue(value.structuredContent)].filter(Boolean).join("\n");
    return parts;
  }
  if (isRecord(value) && value.type === "text" && typeof value.text === "string") return { text: value.text, images: [] };
  if (isRecord(value) && value.type === "resource" && isRecord(value.resource)) {
    const resource = value.resource;
    if (typeof resource.blob === "string" && typeof resource.mimeType === "string" && resource.mimeType.startsWith("image/")) return { text: "", images: [{ type: "image", data: resource.blob, mimeType: resource.mimeType }] };
  }
  return { text: textFromValue(value), images: [] };
}

export function toolResultText(parts: ToolResultParts): string {
  if (parts.text) return parts.text;
  if (parts.images.length) return `已返回 ${parts.images.length} 张图片供模型查看。`;
  return "工具未返回内容。";
}

/** Keep binary image data out of audit logs and renderer trace events. */
export function summarizeToolResult(value: unknown): unknown {
  const parts = toolResultParts(value);
  if (!parts.images.length) return value;
  return { ...(parts.text ? { text: parts.text } : {}), images: parts.images.map((image) => ({ type: image.type, name: image.name, path: image.path, mimeType: image.mimeType, bytes: Math.floor(image.data.length * 3 / 4) - (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0) })) };
}
