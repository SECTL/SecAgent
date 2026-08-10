import type { McpServerConfig, SecAgentConfig, Student } from "./types.js";

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

/** Discovers only explicitly enabled HTTP MCP servers and gives every tool a collision-free name. */
export class McpRegistry {
  private clients = new Map<string, HttpMcpClient>();
  private tools = new Map<string, RegisteredMcpTool>();
  private configurationErrors: McpDiscoveryError[] = [];
  private discoveryErrors: McpDiscoveryError[] = [];
  constructor(config: SecAgentConfig) {
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
