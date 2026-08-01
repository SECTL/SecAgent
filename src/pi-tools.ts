import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AgentTool } from "./model-provider.js";

const execAsync = promisify(exec);

export const piTools: AgentTool[] = [
  {
    key: "read",
    description: "读取文件内容。path 可使用绝对路径或相对于工作区的路径。",
    inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } } }
  },
  {
    key: "write",
    description: "写入文件内容；父目录不存在时自动创建。",
    inputSchema: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } }
  },
  {
    key: "edit",
    description: "将文件中唯一匹配的 oldText 替换为 newText。",
    inputSchema: { type: "object", additionalProperties: false, required: ["path", "oldText", "newText"], properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } } }
  },
  {
    key: "bash",
    description: "在工作区目录执行 shell 命令并返回标准输出和错误输出。",
    inputSchema: { type: "object", additionalProperties: false, required: ["command"], properties: { command: { type: "string" }, timeout: { type: "integer", minimum: 1 } } }
  }
];

function resolvePath(workspace: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(workspace, filePath);
}

export async function callPiTool(workspace: string, key: string, args: Record<string, unknown>): Promise<unknown> {
  if (key === "read") {
    if (typeof args.path !== "string" || !args.path.trim()) throw new Error("read 需要非空 path");
    const filePath = resolvePath(workspace, args.path);
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Math.max(1, Number(args.limit) || lines.length);
    return { path: filePath, content: lines.slice(offset - 1, offset - 1 + limit).join("\n"), offset, limit, totalLines: lines.length };
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
