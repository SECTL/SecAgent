import type { SecAgentConfig, ConfirmationMode } from "./types.js";

export function confirmationFor(config: SecAgentConfig, action: string): ConfirmationMode {
  return config.policy.confirmation[action] ?? "denied";
}

export function ensureAllowed(config: SecAgentConfig, tool: string): void {
  const alias = tool.replaceAll(".", "_");
  const allowed = config.policy.allowlist.some((pattern) => pattern.endsWith("*") ? alias.startsWith(pattern.slice(0, -1)) : alias === pattern);
  if (!allowed) throw new Error(`策略拒绝工具调用：${tool} 不在 allowlist 中`);
}
