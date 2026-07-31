import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { expandPath } from "./paths.js";
import type { ModelProfile, SecAgentConfig } from "./types.js";

const template = (workspace: string): SecAgentConfig => ({
  version: 1,
  workspace,
  agent: {
    provider: "openai-compatible",
    model: "gpt-5",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    endpoint: "/chat/completions",
    maxTokens: 800,
    systemPromptFile: "./prompts/agent-system.md"
  } as SecAgentConfig["agent"],
  mcp: { servers: {
    secscore: { transport: "http", url: "http://127.0.0.1:3901/mcp", enabled: true },
    classisland: { transport: "http", url: "http://127.0.0.1:18789/mcp", enabled: false }
  } },
  policy: {
    execution: "bypass",
    confirmation: { "score.add": "required", "score.subtract": "required", "schedule.change": "required", "settings.write": "required", "random.pick": "none" },
    allowlist: ["secscore_*", "classisland_*", "random_picker_*"],
    audit: { enabled: true, redactSensitiveFields: true }
  }
});

export function configPath(workspace: string): string { return path.join(workspace, "secagent.yaml"); }

export function initializeWorkspace(workspace: string): void {
  fs.mkdirSync(workspace, { recursive: true });
  for (const part of ["skills/secscore", "skills/class-schedule", "skills/random-picker", "mcp", "plugins", "sessions", "audit", "prompts"]) {
    fs.mkdirSync(path.join(workspace, part), { recursive: true });
  }
  const file = configPath(workspace);
  if (!fs.existsSync(file)) fs.writeFileSync(file, YAML.stringify(template(workspace)), "utf8");
  const skills: Record<string, string> = {
    secscore: "---\nname: SecScore\ndescription: 处理学生查询、积分加减分和撤销。\n---\n# SecScore\n\n使用已提供的 MCP 工具获取真实结果；当前运行策略为 bypass，工具调用将直接执行并由 SecAgent 审计。\n\n隐藏工具说明：`secscore__add_score` 用于给指定学生增加或扣减积分；`secscore__undo_score` 用于撤销一条已完成的积分操作。调用前请确认学生、变更数值和原因。\n",
    "class-schedule": "---\nname: Class Schedule\ndescription: 处理课程查询和换课。\n---\n# Class Schedule\n\n使用已提供的 MCP 工具获取真实结果；当前运行策略为 bypass，工具调用将直接执行并由 SecAgent 审计。\n",
    "random-picker": "---\nname: Random Picker\ndescription: 在指定班级或范围内随机抽取学生。\n---\n# Random Picker\n\n结果不修改外部系统。\n"
  };
  for (const [name, content] of Object.entries(skills)) {
    const filePath = path.join(workspace, "skills", name, "SKILL.md");
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, content, "utf8");
  }
  const promptFile = path.join(workspace, "prompts", "agent-system.md");
  if (!fs.existsSync(promptFile)) fs.writeFileSync(promptFile, "你是 SecAgent，一个教育场景操作助手。\n\n根据教师指令，从提供的 MCP 工具中选择合适的工具并调用。工具调用已被 SecAgent 审计并直接执行；不要询问是否确认，不要编造工具结果。完成后用中文简洁说明真实结果。\n\n系统会提供可用 Skills 的名称和摘要，不会预加载完整内容。需要某个 Skill 的流程、约束或示例时，通常先调用 secagent__read_skill，并使用目录中给出的准确名称。Skill 声明的隐藏工具不会提供 MCP schema；如果已知工具名称和契约，可直接通过 secagent__call_hidden_tool 调用，否则先读取相关 Skill 获取说明。\n", "utf8");
  const mcpFile = path.join(workspace, "mcp", "secscore-server.json");
  if (!fs.existsSync(mcpFile)) fs.writeFileSync(mcpFile, JSON.stringify({ name: "secscore", transport: "http", url: "http://127.0.0.1:3901/mcp", tools: ["list_students", "find_students", "add_score", "undo_score"] }, null, 2) + "\n");
  const envFile = path.join(workspace, ".env");
  if (!fs.existsSync(envFile)) fs.writeFileSync(envFile, "# 填入密钥；不要提交或分享此文件。\nOPENAI_API_KEY=\nANTHROPIC_API_KEY=\n", "utf8");
}

export function loadConfig(workspaceInput: string): { workspace: string; config: SecAgentConfig } {
  const workspace = expandPath(workspaceInput);
  const file = configPath(workspace);
  if (!fs.existsSync(file)) throw new Error(`未找到配置：${file}。请先执行 secagent init。`);
  const envFile = path.join(workspace, ".env");
  if (fs.existsSync(envFile)) loadWorkspaceEnv(envFile);
  const raw = YAML.parse(fs.readFileSync(file, "utf8")) as SecAgentConfig;
  return { workspace, config: normalizeAndValidate(raw, workspace) };
}

/** Workspace values intentionally override inherited shell values, but blank template entries do not. */
function loadWorkspaceEnv(envFile: string): void {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || !match[2]) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
    if (value) process.env[match[1]] = value;
  }
}

export function normalizeAndValidate(raw: SecAgentConfig, workspace: string): SecAgentConfig {
  const errors: string[] = [];
  if (raw?.version !== 1) errors.push("version 必须为 1");
  // 兼容首版配置的 `openai:gpt-5` 写法，并迁移到明确的协议配置。
  const legacyAgent = raw?.agent as unknown as Record<string, unknown> | undefined;
  if (raw?.agent && !raw.agent.provider && typeof legacyAgent?.model === "string" && legacyAgent.model.startsWith("openai:")) {
    raw.agent = {
      provider: "openai-compatible",
      model: legacyAgent.model.slice("openai:".length),
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.com/v1",
      endpoint: "/chat/completions",
      maxTokens: 800,
      systemPrompt: typeof legacyAgent.systemPrompt === "string" ? legacyAgent.systemPrompt : "你是 SecAgent，一个教育场景操作助手。"
    };
  }
  if (raw?.agent?.systemPromptFile) {
    const promptFile = expandPath(raw.agent.systemPromptFile, workspace);
    if (!fs.existsSync(promptFile)) errors.push(`agent.systemPromptFile 不存在：${promptFile}`);
    else {
      raw.agent.systemPrompt = fs.readFileSync(promptFile, "utf8").trim();
      raw.agent.systemPromptFile = promptFile;
    }
  }
  if (!raw?.agent?.provider || !["openai-compatible", "anthropic"].includes(raw.agent.provider)) errors.push("agent.provider 必须是 openai-compatible 或 anthropic");
  if (!raw?.agent?.model) errors.push("agent.model 缺失");
  if (!raw?.agent?.apiKeyEnv) errors.push("agent.apiKeyEnv 缺失");
  if (!raw?.agent?.baseUrl) errors.push("agent.baseUrl 缺失");
  if (!raw?.agent?.systemPrompt) errors.push("agent.systemPrompt 或 agent.systemPromptFile 缺失");
  if (raw?.agent?.models !== undefined && !Array.isArray(raw.agent.models)) errors.push("agent.models 必须为数组");
  if (!raw?.mcp?.servers || typeof raw.mcp.servers !== "object") errors.push("mcp.servers 缺失");
  if (!raw?.policy?.confirmation) errors.push("policy.confirmation 缺失");
  if (errors.length) throw new Error(`配置校验失败：${errors.join("；")}`);
  raw.agent.baseUrl = raw.agent.baseUrl.replace(/\/$/, "");
  raw.agent.maxTokens = raw.agent.maxTokens || 800;
  for (const model of raw.agent.models ?? []) validateModelProfile(model, errors);
  if (raw.agent.models?.length) {
    const ids = new Set<string>();
    for (const model of raw.agent.models) {
      if (ids.has(model.id)) errors.push(`agent.models.id 重复：${model.id}`);
      ids.add(model.id);
      model.name = model.name?.trim() || model.model;
      model.baseUrl = model.baseUrl.replace(/\/$/, "");
      model.maxTokens = model.maxTokens || raw.agent.maxTokens;
    }
  }
  if (errors.length) throw new Error(`配置校验失败：${errors.join("；")}`);
  raw.workspace = workspace;
  return raw;
}

function validateModelProfile(model: ModelProfile, errors: string[]): void {
  if (!model?.id) errors.push("agent.models[].id 缺失");
  if (!model?.model) errors.push(`agent.models[${model?.id || "?"}].model 缺失`);
  if (!model?.provider || !["openai-compatible", "anthropic"].includes(model.provider)) errors.push(`agent.models[${model?.id || "?"}].provider 无效`);
  if (!model?.apiKeyEnv) errors.push(`agent.models[${model?.id || "?"}].apiKeyEnv 缺失`);
  if (!model?.baseUrl) errors.push(`agent.models[${model?.id || "?"}].baseUrl 缺失`);
}

export interface ModelOption {
  id: string;
  name: string;
  model: string;
  provider: SecAgentConfig["agent"]["provider"];
}

export function configuredModels(config: SecAgentConfig): ModelOption[] {
  if (config.agent.models?.length) return config.agent.models.map((model) => ({ id: model.id, name: model.name || model.model, model: model.model, provider: model.provider }));
  return [{ id: "default", name: config.agent.model, model: config.agent.model, provider: config.agent.provider }];
}

export function useConfiguredModel(config: SecAgentConfig, id?: string): void {
  if (!id || id === "default" || !config.agent.models?.length) return;
  const selected = config.agent.models.find((model) => model.id === id);
  if (!selected) throw new Error(`未找到配置模型：${id}`);
  config.agent = { ...config.agent, ...selected, maxTokens: selected.maxTokens || config.agent.maxTokens, systemPrompt: config.agent.systemPrompt, systemPromptFile: config.agent.systemPromptFile, models: config.agent.models };
}
