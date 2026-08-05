interface SessionMeta { id: string; title: string; createdAt: string; updatedAt: string }
interface ToolCallRecord { name: string; arguments: unknown; result?: unknown }
type AssistantActivity = { kind: "thinking" | "summary" | "text"; content: string; turn?: number } | { kind: "tool"; name: string; arguments: unknown; result?: unknown }
interface ChatAttachment { id: string; name: string; mimeType: string; dataUrl: string; size: number }
interface SessionMessage { id: string; role: "user" | "assistant"; content: string; createdAt: string; attachments?: ChatAttachment[]; toolCalls?: ToolCallRecord[]; activities?: AssistantActivity[] }
interface SessionData { meta: SessionMeta; messages: SessionMessage[] }
type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
interface ModelOption { id: string; name: string; model: string; provider: string }
interface ModelProfile { id: string; name?: string; provider: "openai-compatible" | "openai-responses" | "anthropic" | "google"; model: string; apiKeyEnv: string; apiKey?: string; apiKeyConfigured?: boolean; baseUrl: string; endpoint?: string; anthropicVersion?: string; maxTokens?: number }
interface McpServerConfig { transport: "stdio" | "http"; command?: string; args?: string[]; url?: string; enabled: boolean }
interface SettingsPayload { models: ModelProfile[]; tts: { voice: string; rate: string }; mcp: { servers: Record<string, McpServerConfig> } }
interface SkillSummary { name: string; description: string; path: string }
interface PluginStatus { id: string; name: string; version: string; icon?: string; enabled: boolean; state: "inactive" | "starting" | "error" | "ready"; message?: string; description?: string; author?: string; repository?: string; permissions?: string[]; readme?: string; settingsPages: Array<{ id: string; title: string; description?: string }> }
interface MarketplaceVersion { version: string; minHostApiVersion: number; assetUrl: string; sha256: string; permissions: string[]; platforms: string[] }
interface MarketplacePlugin { id: string; name: string; description: string; repository: string; icon?: string; readme?: string; versions: MarketplaceVersion[] }
interface Window {
  secagent: {
    platform: NodeJS.Platform;
    listSessions(): Promise<SessionMeta[]>;
    listModels(): Promise<ModelOption[]>;
    getSettings(): Promise<SettingsPayload>;
    officialStatus(): Promise<{ loggedIn: boolean; email: string }>;
    officialBalance(): Promise<{ points: number | null }>;
    officialOAuthLogin(): Promise<SettingsPayload>;
    officialLogout(): Promise<{ loggedIn: boolean }>;
    saveSettings(payload: SettingsPayload): Promise<SettingsPayload>;
    listSkills(): Promise<SkillSummary[]>;
    openSkillsDirectory(): Promise<string>;
    listPlugins(): Promise<PluginStatus[]>;
    setPluginEnabled(id: string, enabled: boolean): Promise<PluginStatus[]>;
    reloadPlugin(id: string): Promise<PluginStatus[]>;
    uninstallPlugin(id: string): Promise<PluginStatus[]>;
    installPlugin(): Promise<PluginStatus[]>;
    listMarketplace(): Promise<MarketplacePlugin[]>;
    installMarketplaceVersion(version: MarketplaceVersion): Promise<PluginStatus[]>;
    createSession(): Promise<SessionData>;
    deleteSession(id: string): Promise<SessionMeta[]>;
    getSession(id: string): Promise<SessionData>;
    sendMessage(id: string, text: string, modelId?: string, reasoningEffort?: ReasoningEffort, attachments?: ChatAttachment[]): Promise<SessionData>;
    onRuntimeEvent(listener: (event: unknown) => void): () => void;
    startSpeech(): Promise<{ ok: true }>;
    sendSpeechAudio(samples: Float32Array): void;
    stopSpeech(): Promise<{ ok: true }>;
    synthesizeSpeech(text: string): Promise<string>;
    onSpeechEvent(listener: (event: unknown) => void): () => void;
    onSettingsChanged(listener: (settings: SettingsPayload) => void): () => void;
    onPluginsChanged(listener: (plugins: PluginStatus[]) => void): () => void;
  };
}
