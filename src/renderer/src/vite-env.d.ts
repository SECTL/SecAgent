interface SessionMeta { id: string; title: string; createdAt: string; updatedAt: string }
interface ToolCallRecord { name: string; arguments: unknown; result?: unknown }
type AssistantActivity = { kind: "thinking" | "summary" | "text"; content: string; turn?: number } | { kind: "tool"; name: string; arguments: unknown; result?: unknown }
interface SessionMessage { id: string; role: "user" | "assistant"; content: string; createdAt: string; toolCalls?: ToolCallRecord[]; activities?: AssistantActivity[] }
interface SessionData { meta: SessionMeta; messages: SessionMessage[] }
type ReasoningEffort = "none" | "low" | "medium" | "high";
interface ModelOption { id: string; name: string; model: string; provider: string }
interface ModelProfile { id: string; name?: string; provider: "openai-compatible" | "openai-responses" | "anthropic" | "google"; model: string; apiKeyEnv: string; apiKey?: string; apiKeyConfigured?: boolean; baseUrl: string; endpoint?: string; anthropicVersion?: string; maxTokens?: number }
interface McpServerConfig { transport: "stdio" | "http"; command?: string; args?: string[]; url?: string; enabled: boolean }
interface SettingsPayload { models: ModelProfile[]; tts: { voice: string; rate: string }; mcp: { servers: Record<string, McpServerConfig> } }
interface SkillSummary { name: string; description: string; path: string }
interface Window {
  secagent: {
    listSessions(): Promise<SessionMeta[]>;
    listModels(): Promise<ModelOption[]>;
    getSettings(): Promise<SettingsPayload>;
    saveSettings(payload: SettingsPayload): Promise<SettingsPayload>;
    listSkills(): Promise<SkillSummary[]>;
    openSkillsDirectory(): Promise<string>;
    createSession(): Promise<SessionData>;
    deleteSession(id: string): Promise<SessionMeta[]>;
    getSession(id: string): Promise<SessionData>;
    sendMessage(id: string, text: string, modelId?: string, reasoningEffort?: ReasoningEffort): Promise<SessionData>;
    onRuntimeEvent(listener: (event: unknown) => void): () => void;
    startSpeech(): Promise<{ ok: true }>;
    sendSpeechAudio(samples: Float32Array): void;
    stopSpeech(): Promise<{ ok: true }>;
    synthesizeSpeech(text: string): Promise<string>;
    onSpeechEvent(listener: (event: unknown) => void): () => void;
    onSettingsChanged(listener: (settings: SettingsPayload) => void): () => void;
  };
}
