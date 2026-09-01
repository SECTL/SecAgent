import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AgentTool } from "./model-provider.js";
import type { ToolImageContent } from "./tool-content.js";

const execAsync = promisify(exec);

/** Supported local image formats shared by `look_at` and the vision sub-model tool. */
const IMAGE_MEDIA_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export interface ReadImageResult {
  filePath: string;
  name: string;
  mimeType: string;
  base64: string;
}

export function resolveWorkspacePath(workspace: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(workspace, filePath);
}

/**
 * Shared image read + validation used both by the `look_at` Pi tool (returns the image to a
 * vision-capable main model) and by `secagent__look_at_image` (feeds the image to a dedicated
 * vision sub-model and returns text).
 */
export async function readImageFile(workspace: string, filePath: string): Promise<ReadImageResult> {
  const resolved = resolveWorkspacePath(workspace, filePath);
  const mediaType = IMAGE_MEDIA_TYPES[path.extname(resolved).toLowerCase()];
  if (!mediaType) throw new Error("仅支持 png、jpg、jpeg、webp、gif 图片");
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error("path 不是文件");
  if (stat.size > MAX_IMAGE_BYTES) throw new Error("图片不能超过 12 MB");
  return { filePath: resolved, name: path.basename(resolved), mimeType: mediaType, base64: (await fs.readFile(resolved)).toString("base64") };
}

export const piTools: AgentTool[] = [
  { key: "look_at", description: "查看本地图片并把图片内容直接提供给模型。path 可使用绝对路径或相对于工作区的路径；仅支持 png、jpg、jpeg、webp、gif 图片。需要理解图片内容时必须调用此工具，不要只读取图片文件的二进制内容。", inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", description: "图片的绝对路径或相对于工作区的路径" } } } },
  { key: "read", description: "读取文件内容。path 可使用绝对路径或相对于工作区的路径。", inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } } } },
  { key: "write", description: "写入文件内容；父目录不存在时自动创建。", inputSchema: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } },
  { key: "edit", description: "将文件中唯一匹配的 oldText 替换为 newText。", inputSchema: { type: "object", additionalProperties: false, required: ["path", "oldText", "newText"], properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } } } },
  { key: "bash", description: "在工作区目录执行 shell 命令并返回标准输出和错误输出。", inputSchema: { type: "object", additionalProperties: false, required: ["command"], properties: { command: { type: "string" }, timeout: { type: "integer", minimum: 1 } } } }
];

function resolvePath(workspace: string, filePath: string): string { return resolveWorkspacePath(workspace, filePath); }

export async function callPiTool(workspace: string, key: string, args: Record<string, unknown>): Promise<unknown> {
  if (key === "look_at") {
    if (typeof args.path !== "string" || !args.path.trim()) throw new Error("look_at 需要非空 path");
    const image = await readImageFile(workspace, args.path);
    const result: ToolImageContent = { type: "image", data: image.base64, mimeType: image.mimeType, name: image.name, path: image.filePath };
    return result;
  }
  if (key === "read") {
    if (typeof args.path !== "string" || !args.path.trim()) throw new Error("read 需要非空 path");
    const filePath = resolvePath(workspace, args.path);
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Math.max(1, Number(args.limit) || 200);
    const startIndex = Math.min(lines.length, offset - 1);
    const selected = lines.slice(startIndex, startIndex + limit);
    const truncated = startIndex + selected.length < lines.length;
    const nextOffset = truncated ? offset + selected.length : undefined;
    return { path: filePath, content: selected.join("\n"), offset, limit, totalLines: lines.length, totalChars: content.length, truncated, ...(truncated ? { nextOffset } : {}) };
  }
  if (key === "write") {
    if (typeof args.path !== "string" || !args.path.trim()) throw new Error("write 需要非空 path，例如 clock.html");
    if (typeof args.content !== "string") throw new Error("write 需要 content");
    const filePath = resolvePath(workspace, args.path);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, args.content, "utf8");
    return { path: filePath, bytes: Buffer.byteLength(args.content, "utf8") };
  }
  if (key === "edit") {
    const filePath = resolvePath(workspace, String(args.path || ""));
    const content = await fs.readFile(filePath, "utf8");
    const oldText = String(args.oldText ?? "");
    const occurrences = content.split(oldText).length - 1;
    if (occurrences !== 1) throw new Error(`oldText 必须恰好匹配一次，实际匹配 ${occurrences} 次`);
    await fs.writeFile(filePath, content.replace(oldText, String(args.newText ?? "")), "utf8");
    return { path: filePath, replaced: 1 };
  }
  if (key === "bash") {
    const command = String(args.command || "");
    if (!command) throw new Error("bash 需要 command");
    const result = await execAsync(command, { cwd: workspace, timeout: Number(args.timeout) || 120_000, maxBuffer: 10 * 1024 * 1024 });
    return { cwd: workspace, stdout: result.stdout, stderr: result.stderr };
  }
  throw new Error(`未知 Pi 工具：${key}`);
}
