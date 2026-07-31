import fs from "node:fs";
import path from "node:path";
import type { SecAgentConfig } from "./types.js";

export interface LoadedSkill { name: string; description: string; path: string; content: string }

function skillDescription(content: string): string {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  return lines.find((line) => line && !line.startsWith("#") && !line.startsWith("---")) || "未提供描述。";
}

export function loadEnabledSkills(config: SecAgentConfig): LoadedSkill[] {
  return config.skills.filter((item) => item.enabled).map((item) => {
    const file = path.join(item.path, "SKILL.md");
    if (!fs.existsSync(file)) throw new Error(`已启用 Skill 缺少 SKILL.md：${file}`);
    const content = fs.readFileSync(file, "utf8");
    return { name: path.basename(item.path), description: skillDescription(content), path: file, content };
  });
}
