export type ConfirmationMode = "required" | "none" | "denied";

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
  provider: "openai-compatible" | "anthropic";
  model: string;
  apiKeyEnv: string;
  baseUrl: string;
  endpoint?: string;
  anthropicVersion?: string;
  maxTokens?: number;
}

export interface AgentConfig {
  provider: "openai-compatible" | "anthropic";
  model: string;
  apiKeyEnv: string;
  baseUrl: string;
  endpoint?: string;
  anthropicVersion?: string;
  maxTokens: number;
  systemPrompt: string;
  systemPromptFile?: string;
  models?: ModelProfile[];
}

export interface SecAgentConfig {
  version: number;
  workspace: string;
  agent: AgentConfig;
  mcp: { servers: Record<string, McpServerConfig> };
  policy: {
    execution?: "bypass" | "confirm";
    confirmation: Record<string, ConfirmationMode>;
    allowlist: string[];
    audit: { enabled: boolean; redactSensitiveFields: boolean };
  };
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

export interface PendingAction {
  id: string;
  action: "score.adjust";
  payload: { studentId: string; delta: number; reason: string };
  preview: Preview;
  createdAt: string;
  expiresAt: string;
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
