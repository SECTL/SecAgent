export interface McpServerConfig {
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
}

export interface ModelProfile {
  id: string;
  name?: string;
  enabled?: boolean;
  provider: "openai-compatible" | "openai-responses" | "anthropic" | "google";
  model: string;
  apiKeyEnv: string;
  baseUrl: string;
  endpoint?: string;
  anthropicVersion?: string;
  maxTokens?: number;
}

export interface ProviderConfig {
  id: string;
  name: string;
  preset?: string;
  provider: ModelProfile["provider"];
  apiKeyEnv: string;
  baseUrl: string;
  endpoint?: string;
  anthropicVersion?: string;
  maxTokens?: number;
  models: Array<{ id: string; name?: string; enabled?: boolean }>;
}

export interface AgentConfig {
  provider: "openai-compatible" | "openai-responses" | "anthropic" | "google";
  model: string;
  apiKeyEnv: string;
  baseUrl: string;
  endpoint?: string;
  anthropicVersion?: string;
  maxTokens: number;
  systemPrompt: string;
  models?: ModelProfile[];
  providers?: ProviderConfig[];
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type UpdateChannel = "stable" | "preview";

export interface UpdatePreferences {
  channel: UpdateChannel;
  autoCheck: boolean;
  autoDownload: boolean;
  autoInstallOnQuit: boolean;
}

export interface TelemetrySettings {
  /** Master switch. When false, the client must not send telemetry requests. */
  enabled: boolean;
}

export type UpdateStatus = "unsupported" | "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "installing" | "error";

export interface UpdateRelease {
  version: string;
  tag: string;
  releaseType?: "alpha" | "beta";
  channel: UpdateChannel;
  htmlUrl: string;
  body: string;
  publishedAt?: string;
  assetName: string;
  assetUrl: string;
  checksumUrl?: string;
  sha256?: string;
  size?: number;
}

export interface UpdateState {
  currentVersion: string;
  channel: UpdateChannel;
  status: UpdateStatus;
  release?: UpdateRelease;
  downloadedVersion?: string;
  downloadedBytes: number;
  totalBytes?: number;
  checkedAt?: string;
  error?: string;
}

/** An image selected in the desktop composer, persisted with the user message. */
export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  size: number;
}

export interface SecAgentConfig {
  version: number;
  workspace: string;
  agent: AgentConfig;
  tts?: { voice?: string; rate?: string };
  wake?: { hotkey?: string; modelId?: string; voiceEnabled?: boolean; voicePhrase?: string };
  speech?: { betterRecognition?: boolean };
  updates?: UpdatePreferences;
  telemetry?: TelemetrySettings;
  mcp: { servers: Record<string, McpServerConfig> };
  defaults?: { modelId?: string; reasoningEffort?: ReasoningEffort; customModelMode?: boolean; autostart?: boolean };
}

/** A tool supplied by a locally installed SecAgent plugin. */
export interface PluginToolDefinition {
  key: string;
  description: string;
  inputSchema: Record<string, unknown>;
  hidden?: boolean;
}

export interface PluginStatus {
  id: string;
  format?: "secagent" | "agent";
  name: string;
  version: string;
  icon?: string;
  enabled: boolean;
  state: "inactive" | "starting" | "ready" | "error";
  message?: string;
  description?: string;
  author?: string;
  repository?: string;
  permissions?: string[];
  readme?: string;
  settingsPages: Array<{ id: string; title: string; description?: string }>;
}

export interface Student { id: number; name: string; class: string; balance: number }

export interface Preview {
  tool: "score.preview_adjust";
  student: Student;
  delta: number;
  reason: string;
  before: number;
  after: number;
}

export interface AuditRecord {
  id: string;
  createdAt: string;
  status: string;
  tool: string;
  request: string | null;
  params: string | null;
  result: string | null;
  confirmationId: string | null;
  undoOf: string | null;
}
