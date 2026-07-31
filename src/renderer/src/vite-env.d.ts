interface SessionMeta { id: string; title: string; createdAt: string; updatedAt: string }
interface ToolCallRecord { name: string; arguments: unknown; result?: unknown }
type AssistantActivity = { kind: "text"; content: string } | { kind: "tool"; name: string; arguments: unknown; result?: unknown }
interface SessionMessage { id: string; role: "user" | "assistant"; content: string; createdAt: string; toolCalls?: ToolCallRecord[]; activities?: AssistantActivity[] }
interface SessionData { meta: SessionMeta; messages: SessionMessage[] }
interface ModelOption { id: string; name: string; model: string; provider: string }
interface Window {
  secagent: {
    listSessions(): Promise<SessionMeta[]>;
    listModels(): Promise<ModelOption[]>;
    createSession(): Promise<SessionData>;
    getSession(id: string): Promise<SessionData>;
    sendMessage(id: string, text: string, modelId?: string): Promise<SessionData>;
    onRuntimeEvent(listener: (event: unknown) => void): () => void;
    startSpeech(): Promise<{ ok: true }>;
    sendSpeechAudio(samples: Float32Array): void;
    stopSpeech(): Promise<{ ok: true }>;
    onSpeechEvent(listener: (event: unknown) => void): () => void;
  };
}
