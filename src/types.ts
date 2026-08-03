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
  provider: "openai-compatible" | "openai-responses" | "anthropic" | "google";
  model: string;
  apiKeyEnv: string;
  baseUrl: string;
  endpoint?: string;
  anthropicVersion?: string;
  maxTokens?: number;
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
}

export type ReasoningEffort = "none" | "low" | "medium" | "high";

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
  mcp: { servers: Record<string, McpServerConfig> };
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
