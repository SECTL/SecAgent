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
import type { ResolvedPluginPreRule } from "./plugin-manager.js";
import { summarizeToolResult } from "./tool-content.js";

export type RunResult =
  | { kind: "completed"; message: string; actionId?: string; autoLoadedSkills?: string[] }
  | { kind: "needs-disambiguation"; message: string; autoLoadedSkills?: string[] };

export type TraceEvent = { sequence: number; at: string; stage: string; data: unknown };

/** Resolve both fully-qualified plugin Skill names and legacy unqualified names. */
export function resolveSkill(skills: LoadedSkill[], name: string): LoadedSkill | undefined {
  const exact = skills.find((item) => item.name === name);
  if (exact || name.includes("/")) return exact;

  const candidates = skills.filter((item) => item.name.endsWith(`/${name}`));
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function selectAutoLoadedSkills(skills: LoadedSkill[], content: string, previousAutoLoadedSkills: string[] = [], previousReadSkillNames: string[] = []): LoadedSkill[] {
  const alreadyLoaded = new Set(previousAutoLoadedSkills);
  const alreadyRead = new Set(previousReadSkillNames.map((name) => resolveSkill(skills, name)?.name || name));
  return skills.filter((skill) => {
    if (!skill.autoLoadPattern || alreadyLoaded.has(skill.name) || alreadyRead.has(skill.name)) return false;
    try { return new RegExp(skill.autoLoadPattern.source, skill.autoLoadPattern.flags).test(content); }
    catch { return false; }
  });
}

/**
 * Hidden MCP tools are omitted from the model schema but remain callable through the generic
 * hidden-tool entry point. Local Pi tools are always available.
 */
export class SecAgentRuntime {
  private registry: McpRegistry;
  private agent: ModelToolAgent;
  private sequence = 0;
  constructor(private config: SecAgentConfig, private audit: AuditStore, private skills: LoadedSkill[], private trace?: (event: TraceEvent) => void, private plugins?: PluginManager) {
    this.registry = new McpRegistry(config, plugins?.getMcpServers());
    this.agent = new ModelToolAgent(config, skills, (stage, data) => this.emit(stage, data), () => this.plugins?.getPromptContributions() ?? Promise.resolve([]));
  }
  async run(input: string, reasoningEffort: ReasoningEffort = "high", conversation?: ConversationMessage[], signal?: AbortSignal, state: { previousAutoLoadedSkills?: string[]; previousReadSkillNames?: string[]; preRule?: ResolvedPluginPreRule } = {}): Promise<RunResult> {
    signal?.throwIfAborted();
    const currentUserMessage = [...(conversation || [])].reverse().find((message) => message.role === "user")?.content || input;
    const preRule = state.preRule || await this.plugins?.matchPreRule(currentUserMessage);
    if (preRule) {
      this.emit("secagent.pre-rule/match", { pluginId: preRule.pluginId, name: preRule.name, tool: preRule.toolKey, arguments: preRule.arguments });
      const result = await this.callTool(input, preRule.toolKey, preRule.arguments);
      const message = preRule.render ? await preRule.render(result) : this.renderPreRuleResult(result);
      this.emit("secagent.pre-rule/result", { pluginId: preRule.pluginId, name: preRule.name, tool: preRule.toolKey, result: summarizeToolResult(result) });
      return { kind: "completed", message: message || this.renderPreRuleResult(result) };
    }
    const mcpTools = await this.registry.discover();
    for (const error of this.registry.getDiscoveryErrors()) this.emit("mcp.tools/error", error);
    const pluginTools = this.plugins?.getTools() || [];
    const hiddenTools = new Set([...mcpTools, ...pluginTools].filter((tool) => tool.hidden).map((tool) => tool.key));
    const tools = [
      ...mcpTools.filter((tool) => !hiddenTools.has(tool.key)),
      ...pluginTools.filter((tool) => !hiddenTools.has(tool.key)),
      ...piTools,
      { key: "secagent__read_skill", description: "读取指定 Skill 或其 Skill 目录内专题 Markdown 的完整操作说明。仅当需要该 Skill 的详细流程、约束或示例时调用。", inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", description: "Skill 名称，必须来自系统提示词中的可用 Skills 目录。" }, file: { type: "string", description: "可选；Skill 目录内的相对 Markdown 文件名，例如 components.md。" } } } },
      { key: "secagent__call_hidden_tool", description: "调用 Skill 约定的隐藏 MCP 工具。工具名称和参数格式应严格遵循 Skill 正文或模型已知的其他契约。", inputSchema: { type: "object", additionalProperties: false, required: ["name", "arguments"], properties: { name: { type: "string", description: "隐藏工具的完整 key，例如 secscore-connector__list_students。" }, arguments: { type: "object", description: "按照工具契约填写的参数。" } } } }
    ];
    this.emit("mcp.tools/list", [...mcpTools.map((tool) => ({ key: tool.key, server: tool.server, name: tool.name, description: tool.description, hidden: tool.hidden, inputSchema: tool.inputSchema })), ...pluginTools.map((tool) => ({ ...tool, source: "plugin" }))]);
    this.emit("secagent.skills/list", this.skills.map((skill) => ({ name: skill.name, description: skill.description })));
    const prepared = this.prepareAutoLoadedSkills(conversation, state);
    this.emit("secagent.skills/auto-load", prepared.loaded.map((skill) => ({ name: skill.name, path: skill.path })));
    this.emit("model.agent.request", { provider: this.config.agent.provider, model: this.config.agent.model, baseUrl: this.config.agent.baseUrl, instruction: input });
    const message = await this.agent.run(input, tools, async (key, args) => this.callTool(input, key, args, hiddenTools), reasoningEffort, prepared.conversation, signal);
    this.emit("model.agent.result", { message });
    return { kind: "completed", message, autoLoadedSkills: prepared.loaded.map((skill) => skill.name) };
  }
  async close(): Promise<void> { await this.registry.close(); }
  private prepareAutoLoadedSkills(conversation: ConversationMessage[] | undefined, state: { previousAutoLoadedSkills?: string[]; previousReadSkillNames?: string[] }): { conversation?: ConversationMessage[]; loaded: LoadedSkill[] } {
    const history = conversation?.slice() || [];
    const current = [...history].reverse().find((message) => message.role === "user");
    if (!current) return { conversation: history, loaded: [] };
    const loaded = selectAutoLoadedSkills(this.skills, current.content, state.previousAutoLoadedSkills, state.previousReadSkillNames);
    if (!loaded.length) return { conversation: history, loaded };
    const messages = loaded.map((skill) => ({ role: "system" as const, content: `已自动加载 Skill，以下是完整内容。你不需要也不应再次调用 secagent__read_skill 读取这个 Skill；请直接按照以下内容执行。\n名称：${skill.name}\n路径：${skill.path}\n\n${skill.content}` }));
    const index = history.lastIndexOf(current);
    history.splice(index + 1, 0, ...messages);
    return { conversation: history, loaded };
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
        const summary = summarizeToolResult(result);
        this.emit("secagent.tools/result", { name: key, result: summary });
        this.audit.log({ id: randomUUID(), status: "completed", tool: key, request, params: args, result: summary });
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
    const summary = summarizeToolResult(result);
    this.emit("mcp.tools/result", { name: key, result: summary });
    const id = randomUUID();
    this.audit.log({ id, status: "completed", tool: key, request, params: args, result: summary });
    return result;
  }
  private readSkill(request: string, args: Record<string, unknown>): unknown {
    const name = typeof args.name === "string" ? args.name : "";
    const skill = resolveSkill(this.skills, name);
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
  private renderPreRuleResult(result: unknown): string {
    if (typeof result === "string") return result;
    try { return JSON.stringify(result); } catch { return String(result); }
  }
}
