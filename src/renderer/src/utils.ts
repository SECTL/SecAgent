export function isDeepSeekV4Model(modelName?: string): boolean {
  return /^(?:deepseek-v4-flash|deepseek-v4-pro)(?:[-_].*)?$/i.test((modelName || "").trim());
}

export function isDoubaoModel(modelName?: string): boolean {
  return /^(?:doubao|seed)[-_.]/i.test((modelName || "").trim());
}

export function reasoningEffortsForModel(model?: ModelOption): ReasoningEffort[] {
  if (isDeepSeekV4Model(model?.model)) return ["none", "low", "high", "max"];
  // Volcengine Ark (Doubao) only supports none/low/medium/high.
  if (isDoubaoModel(model?.model)) return ["none", "low", "medium", "high"];
  return ["none", "minimal", "low", "medium", "high", "xhigh"];
}

export function isOfficialModel(model: ModelOption): boolean {
  return model.id === "sectl-official" || model.id.startsWith("official:");
}

/** Tier model ids as returned by the relay for the official service (低延迟档位暂缓开放). */
export const OFFICIAL_TIER_IDS = ["virtual-fast", "virtual-standard", "virtual-deep"] as const;
export const TIER_REASONING_EFFORT: Record<string, ReasoningEffort> = { "virtual-fast": "low", "virtual-standard": "high", "virtual-deep": "max" };

export function isOfficialTierModel(model?: ModelOption | null): boolean {
  return Boolean(model && model.id.startsWith("official:") && (OFFICIAL_TIER_IDS as readonly string[]).includes(model.model));
}

export function tierEffortForModel(model?: ModelOption | null): ReasoningEffort {
  if (!model || !isOfficialTierModel(model)) return "high";
  return TIER_REASONING_EFFORT[model.model] || "high";
}

export function toolTitle(name: string): string {
  return name.replace(/__/g, " · ").replace(/_/g, " ");
}

export const emptyModel = (): ModelProfile => ({ id: `model-${Date.now()}`, name: "新模型", provider: "openai-compatible", model: "", apiKeyEnv: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1", endpoint: "/chat/completions", maxTokens: 16384 });
export const emptyProvider = (): ProviderConfig => ({ id: `provider-${Date.now()}`, name: "新提供商", preset: "custom", provider: "openai-compatible", apiKeyEnv: "CUSTOM_API_KEY", baseUrl: "https://api.example.com/v1", endpoint: "/chat/completions", maxTokens: 16384, models: [] });
export const emptyMcp = (): McpServerConfig => ({ transport: "http", url: "http://127.0.0.1:3901/mcp", enabled: true });

export function pluginStateLabel(plugin: PluginStatus): string {
  return plugin.state === "ready" ? "已加载" : plugin.state === "error" ? "错误" : plugin.state === "starting" ? "启动中" : "已禁用";
}
