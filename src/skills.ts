import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { SecAgentConfig } from "./types.js";

export interface SkillAutoLoadPattern { source: string; flags: string }
export interface LoadedSkill { name: string; description: string; path: string; relativePath?: string; content: string; autoLoadPattern?: SkillAutoLoadPattern }

const MAX_SCAN_DEPTH = 3;
const BUILTIN_SKILL_FILES = [path.resolve(process.cwd(), "src/skills/math-visualization/SKILL.md")];
const MATH_VISUALIZATION_AUTO_LOAD_PATTERN: SkillAutoLoadPattern = {
  source: "(?:数学|算术|代数|几何|三角|解析几何|离散数学|数论|集合|逻辑|复数|方程|不等式|函数|数列|级数|极限|导数|微分|积分|微积分|矩阵|向量|线性代数|概率|统计|排列组合|圆|圆柱|圆锥|球|多面体|面积|体积|长度|角度|距离|斜率|曲率|拓扑|画图|绘图|作图|图示|图解|可视化|示意图|坐标图|函数图像|曲线|散点图|柱状图|直方图|饼图|概率分布|统计图|几何图形|立体图|二维|三维|2D|3D|动画|旋转|轨迹|向量场|坐标系|数轴|math(?:ematics)?|equation|inequality|function|sequence|series|limit|derivative|differential|integral|calculus|matrix|vector|linear algebra|probability|statistics|geometry|trigonometry|algebra|arithmetic|number theory|complex number|set theory|logic|topology|plot|graph|chart|diagram|visuali[sz]e|draw|sketch|curve|coordinate|shape|area|volume|length|angle|distance|slope|curvature|surface|solid|3d|2d)",
  flags: "iu"
};

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
  const files = [...discoverSkillFiles(config.workspace), ...BUILTIN_SKILL_FILES, ...additionalFiles].filter((file, index, all) => fs.existsSync(file) && all.indexOf(file) === index);
  const names = new Map<string, string>();
  return files.map((file) => {
    const baseName = path.basename(path.dirname(file));
    const content = fs.readFileSync(file, "utf8");
    const metadata = skillMetadata(content, file);
    const requestedName = metadata.name || baseName;
    const name = names.has(requestedName) ? path.relative(config.workspace, path.dirname(file)) : requestedName;
    names.set(name, file);
    return { name, description: metadata.description, path: file, relativePath: path.relative(config.workspace, file).replace(/\\/g, "/"), content, ...(file === BUILTIN_SKILL_FILES[0] ? { autoLoadPattern: MATH_VISUALIZATION_AUTO_LOAD_PATTERN } : {}) };
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
