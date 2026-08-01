import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { expandPath } from "./paths.js";
import type { McpServerConfig, ModelProfile, SecAgentConfig } from "./types.js";
import type { GoogleModelInfo } from "./google-models.js";

export const DEFAULT_GOOGLE_MODEL = "gemini-2.5-flash";
export const DEFAULT_MAX_TOKENS = 16_384;
export const DEFAULT_SYSTEM_PROMPT = "你是 SecAgent，一个教育场景操作助手。\n\n根据用户指令选择并使用可用工具，完成任务后用中文简洁说明真实结果。";

const template = (workspace: string): SecAgentConfig => ({
  version: 1,
  workspace,
  agent: {
    models: [{
      id: "default",
      name: "gpt-5",
      provider: "openai-compatible",
      model: "gpt-5",
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.com/v1",
      endpoint: "/chat/completions",
      maxTokens: DEFAULT_MAX_TOKENS
    }]
  } as SecAgentConfig["agent"],
  mcp: { servers: {
    secscore: { transport: "http", url: "http://127.0.0.1:3901/mcp", enabled: true },
    classisland: { transport: "http", url: "http://127.0.0.1:18789/mcp", enabled: false }
  } }
});

export function configPath(workspace: string): string { return path.join(workspace, "secagent.yaml"); }

export function initializeWorkspace(workspace: string): void {
  fs.mkdirSync(workspace, { recursive: true });
  for (const part of ["skills/secscore", "skills/class-schedule", "skills/random-picker", "mcp", "plugins", "sessions", "audit"]) {
    fs.mkdirSync(path.join(workspace, part), { recursive: true });
  }
  const file = configPath(workspace);
  if (!fs.existsSync(file)) fs.writeFileSync(file, YAML.stringify(template(workspace)), "utf8");
  const skills: Record<string, string> = {
    secscore: "---\nname: SecScore\ndescription: 处理学生查询、积分加减分和撤销。\n---\n# SecScore\n\n使用已提供的 MCP 工具获取真实结果。\n",
    "class-schedule": "---\nname: Class Schedule\ndescription: 处理课程查询和换课。\n---\n# Class Schedule\n\n使用已提供的 MCP 工具获取真实结果。\n",
    "random-picker": "---\nname: Random Picker\ndescription: 在指定班级或范围内随机抽取学生。\n---\n# Random Picker\n\n结果不修改外部系统。\n"
  };
  for (const [name, content] of Object.entries(skills)) {
    const filePath = path.join(workspace, "skills", name, "SKILL.md");
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, content, "utf8");
  }
  const mcpFile = path.join(workspace, "mcp", "secscore-server.json");
  if (!fs.existsSync(mcpFile)) fs.writeFileSync(mcpFile, JSON.stringify({ name: "secscore", transport: "http", url: "http://127.0.0.1:3901/mcp", tools: ["list_students", "find_students", "add_score", "undo_score"] }, null, 2) + "\n");
  const envFile = path.join(workspace, ".env");
  if (!fs.existsSync(envFile)) fs.writeFileSync(envFile, "# 填入密钥；不要提交或分享此文件。\nOPENAI_API_KEY=\nANTHROPIC_API_KEY=\nGEMINI_API_KEY=\n", "utf8");
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
  // Multi-model configuration is canonical. Populate the legacy top-level fields in memory
  // so the runtime can keep using one normalized AgentConfig shape.
  if (raw?.agent?.models?.length) {
    const first = raw.agent.models[0];
    raw.agent = {
      ...raw.agent,
      provider: raw.agent.provider ?? first.provider,
      model: raw.agent.model ?? first.model,
      apiKeyEnv: raw.agent.apiKeyEnv ?? first.apiKeyEnv,
      baseUrl: raw.agent.baseUrl ?? first.baseUrl,
      endpoint: raw.agent.endpoint ?? first.endpoint,
      anthropicVersion: raw.agent.anthropicVersion ?? first.anthropicVersion,
      maxTokens: raw.agent.maxTokens ?? first.maxTokens ?? DEFAULT_MAX_TOKENS
    };
  }
  // 兼容首版配置的 `openai:gpt-5` 写法，并迁移到明确的协议配置。
  const legacyAgent = raw?.agent as unknown as Record<string, unknown> | undefined;
  if (raw?.agent && !raw.agent.provider && typeof legacyAgent?.model === "string" && legacyAgent.model.startsWith("openai:")) {
    raw.agent = {
      provider: "openai-compatible",
      model: legacyAgent.model.slice("openai:".length),
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.com/v1",
      endpoint: "/chat/completions",
      maxTokens: DEFAULT_MAX_TOKENS,
      systemPrompt: DEFAULT_SYSTEM_PROMPT
    };
  }
  raw.agent.systemPrompt = DEFAULT_SYSTEM_PROMPT;
  delete (raw.agent as { systemPromptFile?: unknown }).systemPromptFile;
  if (!raw?.agent?.provider || !["openai-compatible", "anthropic", "google"].includes(raw.agent.provider)) errors.push("agent.provider 必须是 openai-compatible、anthropic 或 google");
  if (!raw?.agent?.model && raw?.agent?.provider !== "google") errors.push("agent.model 缺失");
  if (!raw?.agent?.apiKeyEnv) errors.push("agent.apiKeyEnv 缺失");
  if (!raw?.agent?.baseUrl) errors.push("agent.baseUrl 缺失");
  if (raw?.agent?.models !== undefined && !Array.isArray(raw.agent.models)) errors.push("agent.models 必须为数组");
  if (!raw?.mcp?.servers || typeof raw.mcp.servers !== "object") errors.push("mcp.servers 缺失");
  if (errors.length) throw new Error(`配置校验失败：${errors.join("；")}`);
  raw.agent.baseUrl = raw.agent.baseUrl.replace(/\/$/, "");
  raw.agent.maxTokens = raw.agent.maxTokens || DEFAULT_MAX_TOKENS;
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
  delete (raw as SecAgentConfig & { policy?: unknown }).policy;
  raw.workspace = workspace;
  return raw;
}

function validateModelProfile(model: ModelProfile, errors: string[]): void {
  if (!model?.id) errors.push("agent.models[].id 缺失");
  if (!model?.model && model?.provider !== "google") errors.push(`agent.models[${model?.id || "?"}].model 缺失`);
  if (!model?.provider || !["openai-compatible", "anthropic", "google"].includes(model.provider)) errors.push(`agent.models[${model?.id || "?"}].provider 无效`);
  if (!model?.apiKeyEnv) errors.push(`agent.models[${model?.id || "?"}].apiKeyEnv 缺失`);
  if (!model?.baseUrl) errors.push(`agent.models[${model?.id || "?"}].baseUrl 缺失`);
}

export interface ModelOption {
  id: string;
  name: string;
  model: string;
  provider: SecAgentConfig["agent"]["provider"];
}

export function configuredModels(config: SecAgentConfig, googleModels: GoogleModelInfo[] = []): ModelOption[] {
  const profiles = config.agent.models?.length ? config.agent.models : [{ id: "default", name: config.agent.model, model: config.agent.model, provider: config.agent.provider, apiKeyEnv: config.agent.apiKeyEnv, baseUrl: config.agent.baseUrl } as ModelProfile];
  const options: ModelOption[] = [];
  let googleSeen = false;
  for (const profile of profiles) {
    if (profile.provider === "google" && googleSeen) continue;
    if (profile.provider === "google") googleSeen = true;
    if (profile.provider !== "google" || !googleModels.length) {
      options.push({ id: profile.id, name: profile.name || profile.model || "Google Gemini（自动选择）", model: profile.model, provider: profile.provider });
      continue;
    }
    for (const model of googleModels) {
      const modelName = model.name?.replace(/^models\//, "");
      if (!modelName) continue;
      options.push({ id: `google:${profile.id}:${modelName}`, name: model.displayName || modelName, model: modelName, provider: "google" });
    }
  }
  return options;
}

export function useConfiguredModel(config: SecAgentConfig, id?: string): void {
  if (!id || !config.agent.models?.length) return;
  const dynamicPrefix = "google:";
  const separator = id.startsWith(dynamicPrefix) ? id.indexOf(":", dynamicPrefix.length) : -1;
  const dynamicModel = separator > 0 ? id.slice(separator + 1) : undefined;
  const profileId = separator > 0 ? id.slice(dynamicPrefix.length, separator) : id;
  const selected = config.agent.models.find((model) => model.id === profileId) ?? (id === "default" ? config.agent.models[0] : undefined);
  if (!selected) throw new Error(`未找到配置模型：${id}`);
  config.agent = { ...config.agent, ...selected, model: dynamicModel || selected.model || DEFAULT_GOOGLE_MODEL, maxTokens: selected.maxTokens || config.agent.maxTokens, systemPrompt: config.agent.systemPrompt, models: config.agent.models };
}

export interface SettingsPayload {
  models: Array<ModelProfile & { apiKey?: string; apiKeyConfigured?: boolean }>;
  mcp: { servers: Record<string, McpServerConfig> };
}

export function readSettings(workspaceInput: string): SettingsPayload {
  const { config } = loadConfig(workspaceInput);
  const configured = config.agent.models?.length
    ? config.agent.models
    : [{
      id: "default",
      name: config.agent.model,
      provider: config.agent.provider,
      model: config.agent.model,
      apiKeyEnv: config.agent.apiKeyEnv,
      baseUrl: config.agent.baseUrl,
      endpoint: config.agent.endpoint,
      anthropicVersion: config.agent.anthropicVersion,
      maxTokens: config.agent.maxTokens
    }];
  const google = configured.find((model) => model.provider === "google");
  const models = [...configured.filter((model) => model.provider !== "google"), ...(google ? [google] : [])];
  return { models: models.map((model) => ({ ...model, apiKeyConfigured: Boolean(process.env[model.apiKeyEnv]) })), mcp: config.mcp };
}

export function saveSettings(workspaceInput: string, payload: SettingsPayload): SettingsPayload {
  const workspace = expandPath(workspaceInput);
  const file = configPath(workspace);
  const raw = YAML.parse(fs.readFileSync(file, "utf8")) as SecAgentConfig;
  if (!payload || !Array.isArray(payload.models) || !payload.models.length) throw new Error("至少需要配置一个模型");
  if (!payload.mcp?.servers || typeof payload.mcp.servers !== "object") throw new Error("MCP 服务配置无效");
  const google = payload.models.find((model) => model.provider === "google");
  const editableModels = [...payload.models.filter((model) => model.provider !== "google"), ...(google ? [google] : [])];
  const models = editableModels.map(({ apiKey, apiKeyConfigured: _apiKeyConfigured, ...model }) => {
    if (typeof apiKey === "string" && apiKey.trim()) writeWorkspaceEnv(workspace, model.apiKeyEnv, apiKey.trim());
    return model;
  });
  raw.agent = { models } as SecAgentConfig["agent"];
  raw.mcp = payload.mcp;
  delete (raw as SecAgentConfig & { policy?: unknown }).policy;
  // Validate before replacing the user's file, then write the exact editable model/MCP values.
  normalizeAndValidate(raw, workspace);
  fs.writeFileSync(file, YAML.stringify(raw), "utf8");
  return readSettings(workspace);
}

function writeWorkspaceEnv(workspace: string, name: string, value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`API Key 环境变量名无效：${name}`);
  if (/[\r\n]/.test(value)) throw new Error("API Key 不能包含换行符");
  const file = path.join(workspace, ".env");
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  const next = `${name}=${value}`;
  const index = lines.findIndex((line) => line.match(new RegExp(`^\\s*${name}\\s*=`)));
  if (index >= 0) lines[index] = next;
  else lines.push(next);
  fs.writeFileSync(file, `${lines.filter((line, item) => item !== lines.length - 1 || line).join("\n").replace(/\n*$/, "\n")}`, "utf8");
  process.env[name] = value;
}
