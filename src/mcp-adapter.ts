import type { McpServerConfig, SecAgentConfig, Student } from "./types.js";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { PluginMcpServer } from "./plugin-manager.js";

interface McpToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string; resource?: { blob?: string; mimeType?: string } }>;
}

interface RpcResponse { result?: McpToolResult; error?: { message?: string } }

/** `hidden` is a SecAgent MCP extension: hidden tools remain callable but are omitted from model tool definitions. */
export interface McpToolDefinition { name: string; description?: string; inputSchema?: Record<string, unknown>; hidden?: boolean }
export interface RegisteredMcpTool extends McpToolDefinition { key: string; server: string }
export interface McpDiscoveryError { server: string; message: string }

/** Minimal JSON-RPC client for HTTP MCP servers configured by the workspace. */
export class HttpMcpClient {
  private requestId = 0;
  constructor(private server: McpServerConfig, private serverName = "MCP 服务") {
    if (server.transport !== "http" || !server.url) throw new Error("该 MCP 配置不是有效的 HTTP 服务");
  }
  private async request(method: string, params?: Record<string, unknown>): Promise<RpcResponse> {
    let response: Response;
    try {
      response = await fetch(this.server.url!, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.requestId, method, ...(params ? { params } : {}) }),
        signal: AbortSignal.timeout(8_000)
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? "连接超时" : "无法连接";
      throw new Error(`${reason} ${this.serverName} MCP：${this.server.url}。请确认对应的 MCP 服务已启动，并检查“系统设置 → 关于 → MCP 服务”中的地址。`);
    }
    if (!response.ok) throw new Error(`MCP HTTP 请求失败：${response.status} ${response.statusText}`);
    return await response.json() as RpcResponse;
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const payload = await this.request("tools/call", { name, arguments: args });
    if (payload.error) throw new Error(`MCP 错误：${payload.error.message ?? "未知错误"}`);
    if (!payload.result) throw new Error("MCP 返回缺少 result");
    if (payload.result.isError) throw new Error(payload.result.content?.map((item) => item.text).filter(Boolean).join("；") || "MCP 工具调用失败");
    const content = payload.result.content;
    const hasImage = content?.some((item) => item.type === "image" || item.type === "resource" && item.resource?.mimeType?.startsWith("image/"));
    return hasImage && content ? { structuredContent: payload.result.structuredContent, content } : payload.result.structuredContent ?? content;
  }
  async listTools(): Promise<McpToolDefinition[]> {
    const payload = await this.request("tools/list");
    if (payload.error) throw new Error(`MCP 错误：${payload.error.message ?? "未知错误"}`);
    const result = payload.result as unknown as { tools?: McpToolDefinition[] } | undefined;
    if (!Array.isArray(result?.tools)) throw new Error("MCP tools/list 返回格式不正确");
    return result.tools;
  }
}

class StreamableHttpMcpClient implements McpConnection {
  private requestId = 0;
  private sessionId?: string;
  private initialized = false;
  constructor(private server: PluginMcpServer, private serverName: string) {}
  private async request(method: string, params?: Record<string, unknown>): Promise<RpcResponse> {
    if (!this.initialized && method !== "initialize") await this.initialize();
    const response = await fetch(this.server.url!, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(this.server.headers || {}), ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: ++this.requestId, method, ...(params ? { params } : {}) }), signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`${this.serverName} MCP HTTP ${response.status}`);
    this.sessionId ||= response.headers.get("mcp-session-id") || undefined;
    const text = await response.text();
    if (!text.trim()) return {};
    if (text.trimStart().startsWith("data:")) {
      const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1);
      return data ? JSON.parse(data) as RpcResponse : {};
    }
    return JSON.parse(text) as RpcResponse;
  }
  private async initialize(): Promise<void> {
    if (this.initialized) return;
    const response = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "SecAgent", version: "0.1.0" } });
    if (response.error || !response.result) throw new Error(`${this.serverName} MCP initialize 失败`);
    this.initialized = true;
    await this.request("notifications/initialized");
  }
  async listTools(): Promise<McpToolDefinition[]> { await this.initialize(); const response = await this.request("tools/list"); if (response.error) throw new Error(response.error.message || "MCP tools/list 失败"); const tools = (response.result as unknown as { tools?: McpToolDefinition[] } | undefined)?.tools; if (!Array.isArray(tools)) throw new Error("MCP tools/list 返回格式不正确"); return tools; }
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> { await this.initialize(); return unwrapMcpResult(await this.request("tools/call", { name, arguments: args })); }
}

interface McpConnection { listTools(): Promise<McpToolDefinition[]>; callTool(name: string, args: Record<string, unknown>): Promise<unknown>; close?(): Promise<void> }

class StdioMcpClient implements McpConnection {
  private readonly child: ChildProcess;
  private requestId = 0;
  private buffer = "";
  private initialized = false;
  private pending = new Map<number, { resolve: (value: RpcResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private server: PluginMcpServer, private serverName: string) {
    fs.mkdirSync(server.dataRoot, { recursive: true });
    const command = server.command!.startsWith("./") ? safePluginPath(server.root, server.command!) : server.command!;
    const args = (server.args || []).map((value) => expandPluginValue(value, server));
    const cwd = server.cwd ? expandPluginValue(server.cwd, server) : server.root;
    const resolvedCwd = resolvePluginCwd(server, cwd);
    const env = { ...process.env, ...(server.env || {}), PLUGIN_ROOT: server.root, PLUGIN_DATA: server.dataRoot };
    this.child = spawn(command, args, { cwd: resolvedCwd, env, stdio: ["pipe", "pipe", "ignore"] });
    this.child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    this.child.on("error", (error) => this.failPending(error));
    this.child.on("exit", () => this.failPending(new Error(`${serverName} MCP 进程已退出`)));
  }
  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1); newline = this.buffer.indexOf("\n");
      if (!line) continue;
      try { const message = JSON.parse(line) as { id?: number } & RpcResponse; if (typeof message.id === "number") { const pending = this.pending.get(message.id); if (pending) { this.pending.delete(message.id); clearTimeout(pending.timer); pending.resolve(message); } } } catch { /* Ignore non-JSON process output. */ }
    }
  }
  private failPending(error: Error): void { for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(error); this.pending.delete(id); } }
  private request(method: string, params?: Record<string, unknown>): Promise<RpcResponse> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.serverName} MCP 请求超时`)); }, 8_000); this.pending.set(id, { resolve, reject, timer }); this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`); });
  }
  private async initialize(): Promise<void> { if (this.initialized) return; const response = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "SecAgent", version: "0.1.0" } }); if (response.error || !response.result) throw new Error(`${this.serverName} MCP initialize 失败`); this.initialized = true; this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`); }
  async listTools(): Promise<McpToolDefinition[]> { await this.initialize(); const response = await this.request("tools/list"); if (response.error) throw new Error(response.error.message || "MCP tools/list 失败"); const tools = (response.result as unknown as { tools?: McpToolDefinition[] } | undefined)?.tools; if (!Array.isArray(tools)) throw new Error("MCP tools/list 返回格式不正确"); return tools; }
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> { await this.initialize(); return unwrapMcpResult(await this.request("tools/call", { name, arguments: args })); }
  async close(): Promise<void> { this.failPending(new Error("MCP client closed")); if (!this.child.killed) this.child.kill(); }
}

function unwrapMcpResult(payload: RpcResponse): unknown { if (payload.error) throw new Error(`MCP 错误：${payload.error.message ?? "未知错误"}`); if (!payload.result) throw new Error("MCP 返回缺少 result"); if (payload.result.isError) throw new Error(payload.result.content?.map((item) => item.text).filter(Boolean).join("；") || "MCP 工具调用失败"); const content = payload.result.content; const hasImage = content?.some((item) => item.type === "image" || item.type === "resource" && item.resource?.mimeType?.startsWith("image/")); return hasImage && content ? { structuredContent: payload.result.structuredContent, content } : payload.result.structuredContent ?? content; }
function expandPluginValue(value: string, server: PluginMcpServer): string { return value.replaceAll("${PLUGIN_ROOT}", server.root).replaceAll("${PLUGIN_DATA}", server.dataRoot); }
function safePluginPath(root: string, value: string): string { const candidate = path.resolve(root, value); if (!candidate.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("Agent Plugin MCP 路径越界"); return candidate; }
function resolvePluginCwd(server: PluginMcpServer, value: string): string {
  const candidate = path.resolve(path.isAbsolute(value) ? value : path.join(server.root, value));
  const roots = [path.resolve(server.root), path.resolve(server.dataRoot)];
  if (!roots.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`))) throw new Error("Agent Plugin MCP cwd 路径越界");
  return candidate;
}

/** Discovers explicitly enabled workspace HTTP MCP servers and active Agent Plugin MCP servers. */
export class McpRegistry {
  private clients = new Map<string, McpConnection>();
  private tools = new Map<string, RegisteredMcpTool>();
  private configurationErrors: McpDiscoveryError[] = [];
  private discoveryErrors: McpDiscoveryError[] = [];
  constructor(config: SecAgentConfig, pluginServers: PluginMcpServer[] = []) {
    for (const [name, server] of Object.entries(config.mcp.servers)) {
      if (!server.enabled) continue;
      if (server.transport !== "http") {
        this.configurationErrors.push({ server: name, message: `暂不支持 ${server.transport} MCP` });
        continue;
      }
      try {
        this.clients.set(name, new HttpMcpClient(server, name));
      } catch (error) {
        this.configurationErrors.push({ server: name, message: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const server of pluginServers) {
      const name = `${server.pluginId}__${server.name}`;
      try {
        if (server.type === "stdio") this.clients.set(name, new StdioMcpClient(server, name));
        else if (server.type === "streamable-http") this.clients.set(name, new StreamableHttpMcpClient(server, name));
        else this.configurationErrors.push({ server: name, message: "Agent Plugins 的 SSE transport 暂不支持" });
      } catch (error) { this.configurationErrors.push({ server: name, message: error instanceof Error ? error.message : String(error) }); }
    }
  }
  async discover(): Promise<RegisteredMcpTool[]> {
    this.tools.clear();
    this.discoveryErrors = [...this.configurationErrors];
    for (const [server, client] of this.clients) {
      try {
        for (const tool of await client.listTools()) {
          const key = `${server}__${tool.name}`;
          const registered = { ...tool, key, server };
          this.tools.set(key, registered);
        }
      } catch (error) {
        // An unavailable optional MCP must not prevent the model request itself.
        this.discoveryErrors.push({ server, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return [...this.tools.values()];
  }
  getDiscoveryErrors(): McpDiscoveryError[] { return [...this.discoveryErrors]; }
  async call(key: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(key);
    if (!tool) throw new Error(`模型请求了未注册工具：${key}`);
    const client = this.clients.get(tool.server);
    if (!client) throw new Error(`工具所属 MCP 未启用：${tool.server}`);
    return client.callTool(tool.name, args);
  }
  async close(): Promise<void> { for (const client of this.clients.values()) await client.close?.(); }
}

interface SecScoreStudent { id: number; name: string; score: number; group_name?: string | null }
interface AddScoreResult { event_id: number; event_uuid: string; student_id: number; student_name: string; delta: number; val_prev: number; val_curr: number; reason_content: string; event_time: string }
interface UndoScoreResult { event_uuid: string; student_id: number; student_name: string; delta: number; val_curr: number }

export class SecScoreMcpAdapter {
  private client: HttpMcpClient;
  constructor(server: McpServerConfig) { this.client = new HttpMcpClient(server, "secscore"); }
  async listStudents(): Promise<Student[]> {
    const payload = await this.client.callTool("list_students", { limit: 1000 }) as { students?: SecScoreStudent[] };
    return this.toStudents(payload);
  }
  async findStudents(query: string): Promise<Student[]> {
    const payload = await this.client.callTool("find_students", { query, limit: 20 }) as { students?: SecScoreStudent[] };
    return this.toStudents(payload);
  }
  private toStudents(payload: { students?: SecScoreStudent[] }): Student[] {
    if (!Array.isArray(payload.students)) throw new Error("SecScore list_students 返回格式不正确");
    return payload.students.map((student) => ({ id: student.id, name: student.name, class: student.group_name ?? "未分组", balance: student.score }));
  }
  async adjust(student: Student, delta: number, reason: string): Promise<AddScoreResult> {
    return await this.client.callTool("add_score", { student_id: student.id, student_name: student.name, delta, reason_content: reason }) as AddScoreResult;
  }
  async undo(eventUuid: string, studentId: number): Promise<UndoScoreResult> {
    return await this.client.callTool("undo_score", { event_uuid: eventUuid, student_id: studentId }) as UndoScoreResult;
  }
  async listTools(): Promise<unknown> { return this.client.listTools(); }
}
