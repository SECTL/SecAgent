import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ReasoningEffort, SecAgentConfig } from "./types.js";
import { AuditStore } from "./audit.js";
import { McpRegistry } from "./mcp-adapter.js";
import { ModelToolAgent } from "./model-provider.js";
import type { ConversationMessage } from "./model-provider.js";
import type { LoadedSkill } from "./skills.js";
import { callPiTool, piTools } from "./pi-tools.js";
import { PluginManager } from "./plugin-manager.js";

export type RunResult =
  | { kind: "completed"; message: string; actionId?: string }
  | { kind: "needs-disambiguation"; message: string };

export type TraceEvent = { sequence: number; at: string; stage: string; data: unknown };

/**
 * Hidden MCP tools are omitted from the model schema but remain callable through the generic
 * hidden-tool entry point. Local Pi tools are always available.
 */
export class SecAgentRuntime {
  private registry: McpRegistry;
  private agent: ModelToolAgent;
  private sequence = 0;
  constructor(private config: SecAgentConfig, private audit: AuditStore, private skills: LoadedSkill[], private trace?: (event: TraceEvent) => void, private plugins?: PluginManager) {
    this.registry = new McpRegistry(config);
    this.agent = new ModelToolAgent(config, skills, (stage, data) => this.emit(stage, data), () => this.plugins?.getPromptContributions() ?? Promise.resolve([]));
  }
  async run(input: string, reasoningEffort: ReasoningEffort = "high", conversation?: ConversationMessage[], signal?: AbortSignal): Promise<RunResult> {
    signal?.throwIfAborted();
    const mcpTools = await this.registry.discover();
    for (const error of this.registry.getDiscoveryErrors()) this.emit("mcp.tools/error", error);
    const pluginTools = this.plugins?.getTools() || [];
    const hiddenTools = new Set([...mcpTools, ...pluginTools].filter((tool) => tool.hidden).map((tool) => tool.key));
    const tools = [
      ...mcpTools.filter((tool) => !hiddenTools.has(tool.key)),
      ...pluginTools.filter((tool) => !hiddenTools.has(tool.key)),
      ...piTools,
      { key: "secagent__read_skill", description: "读取指定 Skill 或其 Skill 目录内专题 Markdown 的完整操作说明。仅当需要该 Skill 的详细流程、约束或示例时调用。", inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", description: "Skill 名称，必须来自系统提示词中的可用 Skills 目录。" }, file: { type: "string", description: "可选；Skill 目录内的相对 Markdown 文件名，例如 components.md。" } } } },
      { key: "secagent__call_hidden_tool", description: "调用 Skill 约定的隐藏 MCP 工具。工具名称和参数格式应严格遵循 Skill 正文或模型已知的其他契约。", inputSchema: { type: "object", additionalProperties: false, required: ["name", "arguments"], properties: { name: { type: "string", description: "隐藏工具的完整 key，例如 secscore__add_score。" }, arguments: { type: "object", description: "按照工具契约填写的参数。" } } } }
    ];
    this.emit("mcp.tools/list", [...mcpTools.map((tool) => ({ key: tool.key, server: tool.server, name: tool.name, description: tool.description, hidden: tool.hidden, inputSchema: tool.inputSchema })), ...pluginTools.map((tool) => ({ ...tool, source: "plugin" }))]);
    this.emit("secagent.skills/list", this.skills.map((skill) => ({ name: skill.name, description: skill.description })));
    this.emit("model.agent.request", { provider: this.config.agent.provider, model: this.config.agent.model, baseUrl: this.config.agent.baseUrl, instruction: input });
    const message = await this.agent.run(input, tools, async (key, args) => this.callTool(input, key, args, hiddenTools), reasoningEffort, conversation, signal);
    this.emit("model.agent.result", { message });
    return { kind: "completed", message };
  }
  async undo(actionId: string): Promise<RunResult> {
    const record = this.audit.getRecord(actionId);
    if (!record?.result) throw new Error("找不到可撤销的审计记录");
    const result = JSON.parse(record.result) as { event_uuid?: string; student_id?: number };
    if (!result.event_uuid || !Number.isInteger(result.student_id)) throw new Error("该记录不是可撤销的 SecScore 积分操作");
    await this.registry.discover();
    const connectorUndoKey = this.plugins?.getTools().find((tool) => tool.key.endsWith("__undo_score"))?.key;
    const response = await this.callTool(`undo ${actionId}`, connectorUndoKey || "secscore__undo_score", { event_uuid: result.event_uuid, student_id: result.student_id });
    return { kind: "completed", message: `已请求撤销 ${actionId}：${JSON.stringify(response)}` };
  }
  private async callTool(request: string, key: string, args: Record<string, unknown>, hiddenTools?: Set<string>): Promise<unknown> {
    if (piTools.some((tool) => tool.key === key)) {
      this.emit("secagent.tools/call", { name: key, arguments: args });
      try {
        const result = await callPiTool(this.config.workspace, key, args);
        this.emit("secagent.tools/result", { name: key, result });
        this.audit.log({ id: randomUUID(), status: "completed", tool: key, request, params: args, result });
        return result;
      } catch (error) {
        const result = { error: error instanceof Error ? error.message : String(error) };
        this.emit("secagent.tools/result", { name: key, result });
        throw error;
      }
    }
    if (key === "secagent__read_skill") return this.readSkill(request, args);
    if (key === "secagent__call_hidden_tool") return this.callHiddenTool(request, args, hiddenTools);
    return this.executeTool(request, key, args);
  }
  private async callHiddenTool(request: string, args: Record<string, unknown>, hiddenTools?: Set<string>): Promise<unknown> {
    const key = typeof args.name === "string" ? args.name : "";
    const toolArgs = args.arguments;
    if (!hiddenTools?.has(key)) throw new Error(`工具 ${key || "?"} 不是已声明的隐藏工具。请使用 Skill 中的完整工具 key。`);
    if (!toolArgs || typeof toolArgs !== "object" || Array.isArray(toolArgs)) throw new Error(`隐藏工具 ${key} 的 arguments 必须是对象。`);
    return this.executeTool(request, key, toolArgs as Record<string, unknown>);
  }
  private async executeTool(request: string, key: string, args: Record<string, unknown>): Promise<unknown> {
    this.emit("mcp.tools/call", { name: key, arguments: args });
    const result = this.plugins?.getTools().some((tool) => tool.key === key) ? await this.plugins.callTool(key, args) : await this.registry.call(key, args);
    this.emit("mcp.tools/result", { name: key, result });
    const id = randomUUID();
    this.audit.log({ id, status: "completed", tool: key, request, params: args, result });
    return result;
  }
  private readSkill(request: string, args: Record<string, unknown>): unknown {
    const name = typeof args.name === "string" ? args.name : "";
    const skill = this.skills.find((item) => item.name === name);
    if (!skill) throw new Error(`未找到已启用的 Skill：${name}`);
    const requestedFile = typeof args.file === "string" ? args.file : "";
    let filePath = skill.path;
    let content = skill.content;
    if (requestedFile) {
      if (!requestedFile.toLowerCase().endsWith(".md") || path.basename(requestedFile) !== requestedFile) throw new Error("Skill 专题文件只能是当前 Skill 目录内的 Markdown 文件名。");
      const candidate = path.resolve(path.dirname(skill.path), requestedFile);
      const skillDirectory = path.resolve(path.dirname(skill.path));
      if (!candidate.startsWith(`${skillDirectory}${path.sep}`) || !fs.existsSync(candidate)) throw new Error(`找不到 Skill 专题文件：${requestedFile}`);
      filePath = candidate;
      content = fs.readFileSync(candidate, "utf8");
    }
    const result = { name: skill.name, path: filePath, content };
    const auditParams = requestedFile ? { name, file: requestedFile } : { name };
    this.emit("secagent.tools/call", { name: "read_skill", arguments: auditParams });
    this.emit("secagent.tools/result", { name: "read_skill", result });
    this.audit.log({ id: randomUUID(), status: "completed", tool: "secagent.read_skill", request, params: auditParams, result: { name: skill.name, path: filePath } });
    return result;
  }
  private emit(stage: string, data: unknown): void {
    this.trace?.({ sequence: ++this.sequence, at: new Date().toISOString(), stage, data });
  }
}
