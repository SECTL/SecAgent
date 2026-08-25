import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { expandPath } from "./paths.js";
import type { McpServerConfig, ModelProfile, ProviderConfig, ReasoningEffort, SecAgentConfig } from "./types.js";
import type { GoogleModelInfo } from "./google-models.js";
import { DEFAULT_WAKE_HOTKEY, normalizeWakeHotkey } from "./wake-hotkey.js";

export const DEFAULT_GOOGLE_MODEL = "gemini-2.5-flash";
export const DEFAULT_MAX_TOKENS = 16_384;
const ONBOARDING_MARKER = ".oobe-complete";
const OOBE_PROGRESS_FILE = ".oobe-progress.json";
const LEGACY_AGENT_MODEL_FIELDS = ["provider", "model", "apiKeyEnv", "baseUrl", "endpoint", "anthropicVersion", "maxTokens"] as const;
const WORKSPACE_RUNTIME_ENV_KEYS = new Set(["SECTL_OFFICIAL_TOKEN", "SECTL_OFFICIAL_EMAIL", "SECTL_OFFICIAL_SECTL_TOKEN", "SECTL_OFFICIAL_USER_ID"]);
/** The packaged app ships public service defaults; development uses the project .env. */
const BUNDLED_ENV_FILES = process.resourcesPath
  ? [path.join(process.resourcesPath, "official.env"), path.join(process.resourcesPath, ".env")]
  : [];
export const PROJECT_ENV_FILE = BUNDLED_ENV_FILES.find((file) => fs.existsSync(file))
  ?? path.resolve(process.cwd(), ".env");

if (fs.existsSync(PROJECT_ENV_FILE)) loadEnvFile(PROJECT_ENV_FILE, "project");
export const DEFAULT_SYSTEM_PROMPT = `你是 SecAgent，一个教育场景操作助手。

根据用户指令选择并使用可用工具，完成任务后用中文简洁说明真实结果。

当讲解数学、推导公式，或需要绘制 2D/3D 数学图示时，先读取系统提示词中列出的 math-visualization Skill，并严格遵循其中的图示格式和教学要求。只要图示有助于理解，就必须在最终正文中实际输出图示标签。`;
export const DEFAULT_TTS_VOICE = "zh-CN-XiaoxiaoNeural";
export const DEFAULT_TTS_RATE = "+0%";
export const DEFAULT_WAKE_PHRASE = "小泽同学";

const template = (workspace: string): SecAgentConfig => ({
  version: 1,
  workspace,
  agent: {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
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
  tts: { voice: DEFAULT_TTS_VOICE, rate: DEFAULT_TTS_RATE },
  wake: { hotkey: DEFAULT_WAKE_HOTKEY, voiceEnabled: false, voicePhrase: DEFAULT_WAKE_PHRASE },
  mcp: { servers: {} }
});

export function configPath(workspace: string): string { return path.join(workspace, "secagent.yaml"); }

export function isOnboardingComplete(workspaceInput: string): boolean {
  return fs.existsSync(path.join(expandPath(workspaceInput), ONBOARDING_MARKER));
}

export function markOnboardingComplete(workspaceInput: string): void {
  const workspace = expandPath(workspaceInput);
  ensureWorkspaceDirectories(workspace);
  fs.writeFileSync(path.join(workspace, ONBOARDING_MARKER), "1\n", "utf8");
  clearOobeProgress(workspace);
}

export type OobeStep = "source" | "config" | "plugins";
export type OobeSource = "official" | "custom";
export interface OobeProgress {
  step: OobeStep;
  source?: OobeSource;
  provider?: Omit<ProviderConfig, "apiKey">;
}

export function oobeProgressPath(workspace: string): string { return path.join(expandPath(workspace), OOBE_PROGRESS_FILE); }

export function readOobeProgress(workspaceInput: string): OobeProgress | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(oobeProgressPath(workspaceInput), "utf8")) as Partial<OobeProgress>;
    if (raw.step !== "source" && raw.step !== "config" && raw.step !== "plugins") return undefined;
    const source = raw.source === "official" || raw.source === "custom" ? raw.source : undefined;
    const provider = raw.provider && typeof raw.provider === "object" ? raw.provider : undefined;
    return { step: raw.step, ...(source ? { source } : {}), ...(provider ? { provider } : {}) };
  } catch {
    return undefined;
  }
}

export function saveOobeProgress(workspaceInput: string, progress: OobeProgress): void {
  const workspace = expandPath(workspaceInput);
  ensureWorkspaceDirectories(workspace);
  const provider = progress.provider
    ? Object.fromEntries(Object.entries(progress.provider).filter(([key]) => key !== "apiKey")) as Omit<ProviderConfig, "apiKey">
    : undefined;
  const safeProgress: OobeProgress = {
    step: progress.step,
    ...(progress.source ? { source: progress.source } : {}),
    ...(provider ? { provider } : {})
  };
  fs.writeFileSync(oobeProgressPath(workspace), `${JSON.stringify(safeProgress, null, 2)}\n`, "utf8");
}

export function clearOobeProgress(workspaceInput: string): void {
  try { fs.rmSync(oobeProgressPath(workspaceInput), { force: true }); } catch { /* Best effort cleanup. */ }
}

/**
 * Prepare only the directory structure needed by the app.
 *
 * This is intentionally non-destructive: it never recreates deleted workspace
 * files or restores default Skills.
 */
export function ensureWorkspaceDirectories(workspace: string): void {
  fs.mkdirSync(workspace, { recursive: true });
  for (const part of ["skills", "mcp", "plugins", "sessions", "audit"]) {
    fs.mkdirSync(path.join(workspace, part), { recursive: true });
  }
}

export function initializeWorkspace(workspace: string): void {
  ensureWorkspaceDirectories(workspace);
  const file = configPath(workspace);
  if (!fs.existsSync(file)) fs.writeFileSync(file, YAML.stringify(template(workspace)), "utf8");
  const envFile = path.join(workspace, ".env");
  if (!fs.existsSync(envFile)) fs.writeFileSync(envFile, "# 本地密钥和官方服务连接配置，不要提交或分享此文件。\nOPENAI_API_KEY=\nANTHROPIC_API_KEY=\nGEMINI_API_KEY=\nSECTL_OFFICIAL_API_URL=\nSECTL_OAUTH_API_URL=https://appwrite.sectl.cn\nSECTL_OAUTH_CALLBACK_PORT=49152\nSECTL_OFFICIAL_PLATFORM_ID=\nSECTL_OFFICIAL_CLIENT_ID=\nSECTL_OFFICIAL_TOKEN=\nSECTL_OFFICIAL_EMAIL=\nSECTL_OFFICIAL_SECTL_TOKEN=\nSECTL_OFFICIAL_USER_ID=\n", "utf8");
  removeReservedWorkspaceEnvEntries(envFile);
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
  loadEnvFile(envFile, "workspace");
}

function loadEnvFile(envFile: string, source: "project" | "workspace"): void {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || !match[2]) continue;
    if (source === "workspace" && match[1].startsWith("SECTL_") && !WORKSPACE_RUNTIME_ENV_KEYS.has(match[1])) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
    if (value) process.env[match[1]] = value;
  }
}

function removeReservedWorkspaceEnvEntries(envFile: string): void {
  if (!fs.existsSync(envFile)) return;
  const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !match || !match[1].startsWith("SECTL_") || WORKSPACE_RUNTIME_ENV_KEYS.has(match[1]);
  });
  fs.writeFileSync(envFile, filtered.join("\n"), "utf8");
}

export function normalizeAndValidate(raw: SecAgentConfig, workspace: string): SecAgentConfig {
  const errors: string[] = [];
  if (raw?.version !== 1) errors.push("version 必须为 1");
  // Multi-model configuration is canonical. Populate the legacy top-level fields in memory
  // so the runtime can keep using one normalized AgentConfig shape.
  if (raw?.agent?.providers?.length) {
    raw.agent.models = raw.agent.providers.flatMap((provider) => provider.models.map((model) => ({
      id: `${provider.id}:${model.id}`,
      name: model.name || model.id,
      enabled: model.enabled,
      provider: provider.provider,
      model: model.id,
      apiKeyEnv: provider.apiKeyEnv,
      baseUrl: provider.baseUrl,
      endpoint: provider.endpoint,
      anthropicVersion: provider.anthropicVersion,
      maxTokens: provider.maxTokens
    })));
  }
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
  if (typeof raw.agent.systemPrompt !== "string" || !raw.agent.systemPrompt.trim()) {
    raw.agent.systemPrompt = DEFAULT_SYSTEM_PROMPT;
  }
  raw.tts = { voice: raw.tts?.voice || DEFAULT_TTS_VOICE, rate: raw.tts?.rate || DEFAULT_TTS_RATE };
  try { raw.wake = { hotkey: normalizeWakeHotkey(raw.wake?.hotkey || DEFAULT_WAKE_HOTKEY), ...(raw.wake?.modelId ? { modelId: raw.wake.modelId } : {}), voiceEnabled: raw.wake?.voiceEnabled === true, voicePhrase: typeof raw.wake?.voicePhrase === "string" && raw.wake.voicePhrase.trim() ? raw.wake.voicePhrase.trim() : DEFAULT_WAKE_PHRASE }; }
  catch (error) { errors.push(error instanceof Error ? error.message : "随时唤醒快捷键无效"); }
  delete (raw.agent as { systemPromptFile?: unknown }).systemPromptFile;
  if (!raw?.agent?.provider || !["openai-compatible", "openai-responses", "anthropic", "google"].includes(raw.agent.provider)) errors.push("agent.provider 必须是 openai-compatible、openai-responses、anthropic 或 google");
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
  if (!model?.provider || !["openai-compatible", "openai-responses", "anthropic", "google"].includes(model.provider)) errors.push(`agent.models[${model?.id || "?"}].provider 无效`);
  if (!model?.apiKeyEnv) errors.push(`agent.models[${model?.id || "?"}].apiKeyEnv 缺失`);
  if (!model?.baseUrl) errors.push(`agent.models[${model?.id || "?"}].baseUrl 缺失`);
}

export interface ModelOption {
  id: string;
  name: string;
  model: string;
  provider: SecAgentConfig["agent"]["provider"];
}

function commaValues(value: string | undefined): string[] {
  return (value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function configuredModels(config: SecAgentConfig, googleModels: GoogleModelInfo[] = []): ModelOption[] {
  const profiles = config.agent.models?.length ? config.agent.models : [{ id: "default", name: config.agent.model, model: config.agent.model, provider: config.agent.provider, apiKeyEnv: config.agent.apiKeyEnv, baseUrl: config.agent.baseUrl } as ModelProfile];
  const options: ModelOption[] = [];
  let googleSeen = false;
  for (const profile of profiles) {
    if (profile.enabled === false) continue;
    if (profile.provider === "google" && googleSeen) continue;
    if (profile.provider === "google") googleSeen = true;
    const configuredNames = commaValues(profile.name);
    const configuredModelNames = commaValues(profile.model);
    if (profile.provider !== "google" || !googleModels.length) {
      const modelNames = configuredModelNames.length ? configuredModelNames : [""];
      modelNames.forEach((modelName, index) => options.push({ id: index ? `${profile.id}#${index}` : profile.id, name: configuredNames[index] || configuredNames[0] || modelName || "Google Gemini（自动选择）", model: modelName, provider: profile.provider }));
      continue;
    }
    if (configuredModelNames.length) {
      configuredModelNames.forEach((modelName, index) => options.push({ id: index ? `${profile.id}#${index}` : profile.id, name: configuredNames[index] || configuredNames[0] || modelName, model: modelName, provider: profile.provider }));
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
  const dynamicPrefix = id.startsWith("google:") ? "google:" : id.startsWith("official:") ? "official:" : "";
  const separator = dynamicPrefix ? id.indexOf(":", dynamicPrefix.length) : -1;
  const dynamicModel = separator > 0 ? id.slice(separator + 1) : undefined;
  const profileId = separator > 0 ? id.slice(dynamicPrefix.length, separator) : id.split("#")[0];
  const profileIndex = id.includes("#") ? Number(id.slice(id.indexOf("#") + 1)) : 0;
  const selected = config.agent.models.find((model) => model.id === profileId) ?? (profileId ? config.agent.models.find((model) => model.id.startsWith(`${profileId}:`)) : undefined) ?? (id === "default" ? config.agent.models[0] : undefined);
  if (!selected) throw new Error(`未找到配置模型：${id}`);
  const selectedModels = commaValues(selected.model);
  config.agent = { ...config.agent, ...selected, model: dynamicModel || selectedModels[profileIndex] || selectedModels[0] || DEFAULT_GOOGLE_MODEL, maxTokens: selected.maxTokens || config.agent.maxTokens, systemPrompt: config.agent.systemPrompt, models: config.agent.models };
}

export interface SettingsPayload {
  providers: Array<ProviderConfig & { apiKey?: string; apiKeyConfigured?: boolean }>;
  /** Compatibility field for older IPC callers; the settings UI uses providers. */
  models: Array<ModelProfile & { apiKey?: string; apiKeyConfigured?: boolean }>;
  tts: { voice: string; rate: string };
  wake: { hotkey: string; modelId?: string; voiceEnabled?: boolean; voicePhrase?: string };
  speech: { betterRecognition?: boolean };
  mcp: { servers: Record<string, McpServerConfig> };
  defaultModelId?: string;
  defaultReasoningEffort?: ReasoningEffort;
  /** Off by default: custom providers are ignored and the official service (login) is required. */
  customModelMode?: boolean;
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
  const providers = config.agent.providers?.length ? config.agent.providers : groupLegacyModels(configured);
  return { providers: providers.map((provider) => ({ ...provider, apiKeyConfigured: Boolean(process.env[provider.apiKeyEnv]) })), models: configured.map((model) => ({ ...model, apiKeyConfigured: Boolean(process.env[model.apiKeyEnv]) })), tts: { voice: config.tts?.voice || DEFAULT_TTS_VOICE, rate: config.tts?.rate || DEFAULT_TTS_RATE }, wake: { hotkey: config.wake?.hotkey || DEFAULT_WAKE_HOTKEY, ...(config.wake?.modelId ? { modelId: config.wake.modelId } : {}), voiceEnabled: config.wake?.voiceEnabled === true, voicePhrase: config.wake?.voicePhrase || DEFAULT_WAKE_PHRASE }, speech: { betterRecognition: config.speech?.betterRecognition === true }, mcp: config.mcp, defaultModelId: config.defaults?.modelId, defaultReasoningEffort: config.defaults?.reasoningEffort, customModelMode: config.defaults?.customModelMode ?? false };
}

function groupLegacyModels(models: ModelProfile[]): ProviderConfig[] {
  const groups = new Map<string, ProviderConfig>();
  for (const model of models) {
    const id = model.id.includes(":") ? model.id.split(":")[0] : model.id;
    const existing = groups.get(id);
    const provider = existing || { id, name: model.name || id, provider: model.provider, apiKeyEnv: model.apiKeyEnv, baseUrl: model.baseUrl, endpoint: model.endpoint, anthropicVersion: model.anthropicVersion, maxTokens: model.maxTokens, models: [] };
    provider.models.push({ id: model.model, name: model.name || model.model });
    groups.set(id, provider);
  }
  return [...groups.values()];
}

export function saveSettings(workspaceInput: string, payload: SettingsPayload): SettingsPayload {
  const workspace = expandPath(workspaceInput);
  const file = configPath(workspace);
  const raw = YAML.parse(fs.readFileSync(file, "utf8")) as SecAgentConfig;
  const inputProviders: Array<ProviderConfig & { apiKey?: string; apiKeyConfigured?: boolean }> = Array.isArray(payload?.providers) && payload.providers.length ? payload.providers : groupLegacyModels(payload?.models || []);
  if (!inputProviders.length) throw new Error("至少需要配置一个提供商");
  if (!payload.mcp?.servers || typeof payload.mcp.servers !== "object") throw new Error("MCP 服务配置无效");
  const providers = inputProviders.map(({ apiKey, apiKeyConfigured: _apiKeyConfigured, ...provider }) => {
    if (typeof apiKey === "string" && apiKey.trim()) writeWorkspaceEnv(workspace, provider.apiKeyEnv, apiKey.trim());
    return provider;
  });
  const models = providers.flatMap((provider) => provider.models.map((model) => ({ id: `${provider.id}:${model.id}`, name: model.name || model.id, enabled: model.enabled, provider: provider.provider, model: model.id, apiKeyEnv: provider.apiKeyEnv, baseUrl: provider.baseUrl, endpoint: provider.endpoint, anthropicVersion: provider.anthropicVersion, maxTokens: provider.maxTokens })));
  const nextTts = { voice: payload.tts?.voice || DEFAULT_TTS_VOICE, rate: payload.tts?.rate || DEFAULT_TTS_RATE };
  const nextWake = { hotkey: normalizeWakeHotkey(payload.wake?.hotkey || DEFAULT_WAKE_HOTKEY), ...(payload.wake?.modelId ? { modelId: payload.wake.modelId } : {}), voiceEnabled: payload.wake?.voiceEnabled === true, voicePhrase: payload.wake?.voicePhrase?.trim() || DEFAULT_WAKE_PHRASE };
  const canonicalAgent = { ...(raw.agent as unknown as Record<string, unknown>), providers, models } as SecAgentConfig["agent"];
  for (const field of LEGACY_AGENT_MODEL_FIELDS) delete (canonicalAgent as unknown as Record<string, unknown>)[field];
  const candidateAgent = { ...canonicalAgent, models: models.map((model) => ({ ...model })) } as SecAgentConfig["agent"];
  const nextSpeech = { betterRecognition: payload.speech?.betterRecognition === true };
  const candidate: SecAgentConfig = { ...raw, agent: candidateAgent, tts: nextTts, wake: nextWake, speech: nextSpeech, mcp: payload.mcp };
  delete (candidate as SecAgentConfig & { policy?: unknown }).policy;
  // Validate a normalized copy, then persist only the canonical multi-model fields.
  normalizeAndValidate(candidate, workspace);
  canonicalAgent.models = candidate.agent.models;
  raw.agent = canonicalAgent;
  raw.tts = nextTts;
  raw.wake = nextWake;
  raw.speech = nextSpeech;
  raw.mcp = payload.mcp;
  raw.defaults = { modelId: payload.defaultModelId || undefined, reasoningEffort: payload.defaultReasoningEffort || undefined, customModelMode: Boolean(payload.customModelMode) };
  delete (raw as SecAgentConfig & { policy?: unknown }).policy;
  fs.writeFileSync(file, YAML.stringify(raw), "utf8");
  return readSettings(workspace);
}

export function writeWorkspaceEnv(workspace: string, name: string, value: string): void {
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
