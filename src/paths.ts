import os from "node:os";
import path from "node:path";

export const WORKSPACE_ENV = "SECTL_WORKSPACE";

/** Resolve the default workspace, allowing the host process to override it. */
export function resolveDefaultWorkspace(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[WORKSPACE_ENV]?.trim();
  return configured ? expandPath(configured) : path.join(os.homedir(), "SecAgentWorkspace");
}

export const DEFAULT_WORKSPACE = resolveDefaultWorkspace();

export function expandPath(input: string, base = process.cwd()): string {
  const expanded = input === "~" || input.startsWith("~/")
    ? path.join(os.homedir(), input.slice(2))
    : input;
  return path.resolve(base, expanded);
}
