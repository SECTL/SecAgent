import os from "node:os";
import path from "node:path";

export const DEFAULT_WORKSPACE = path.join(os.homedir(), "SecAgentWorkspace");

export function expandPath(input: string, base = process.cwd()): string {
  const expanded = input === "~" || input.startsWith("~/")
    ? path.join(os.homedir(), input.slice(2))
    : input;
  return path.resolve(base, expanded);
}
