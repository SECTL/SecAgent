import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { SecAgentConfig } from "./types.js";

export interface LoadedSkill { name: string; description: string; path: string; relativePath?: string; content: string }

const MAX_SCAN_DEPTH = 3;

function fallbackDescription(content: string): string {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  return lines.find((line) => line && !line.startsWith("#") && !line.startsWith("---")) || "未提供描述。";
}

function skillMetadata(content: string, file: string): { name?: string; description: string } {
  if (!content.startsWith("---")) return { description: fallbackDescription(content) };
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) throw new Error(`Skill frontmatter 格式无效：${file}`);
  const metadata = YAML.parse(match[1]) as { name?: unknown; description?: unknown } | null;
  if (metadata?.name !== undefined && typeof metadata.name !== "string") throw new Error(`Skill name 必须是字符串：${file}`);
  if (metadata?.description !== undefined && typeof metadata.description !== "string") throw new Error(`Skill description 必须是字符串：${file}`);
  return { name: metadata?.name?.trim() || undefined, description: metadata?.description?.trim() || "未提供描述。" };
}

export function loadEnabledSkills(config: SecAgentConfig, additionalFiles: string[] = []): LoadedSkill[] {
  const files = [...discoverSkillFiles(config.workspace), ...additionalFiles].filter((file, index, all) => all.indexOf(file) === index);
  const names = new Map<string, string>();
  return files.map((file) => {
    const baseName = path.basename(path.dirname(file));
    const content = fs.readFileSync(file, "utf8");
    const metadata = skillMetadata(content, file);
    const requestedName = metadata.name || baseName;
    const name = names.has(requestedName) ? path.relative(config.workspace, path.dirname(file)) : requestedName;
    names.set(name, file);
    return { name, description: metadata.description, path: file, relativePath: path.relative(config.workspace, file).replace(/\\/g, "/"), content };
  });
}

/** Discover SKILL.md files in the workspace and its first three directory levels. */
export function discoverSkillFiles(workspace: string): string[] {
  const files: string[] = [];
  const visit = (directory: string, directoryDepth: number): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === "skill.md") files.push(entryPath);
      else if (entry.isDirectory() && directoryDepth < MAX_SCAN_DEPTH) visit(entryPath, directoryDepth + 1);
    }
  };
  visit(workspace, 0);
  return files.sort((left, right) => path.relative(workspace, left).localeCompare(path.relative(workspace, right)));
}
