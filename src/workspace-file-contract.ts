export type WorkspaceFileKind = "html" | "svg" | "markdown";

export interface WorkspaceFileReference {
  path: string;
  kind: WorkspaceFileKind;
  name: string;
}

const FILE_PATTERN = /<file\b([^>]*)>([\s\S]*?)<\/file\s*>|<file\b([^>]*)\/\s*>/gi;
const BLOCK_PATTERN = /<workspace-files\b[^>]*>([\s\S]*?)<\/workspace-files\s*>/gi;

function decodeXml(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function attr(attrs: string, name: string): string | undefined {
  return decodeXml(attrs.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1] || "").trim() || undefined;
}

export function extractWorkspaceFiles(text: string): WorkspaceFileReference[] {
  const result: WorkspaceFileReference[] = [];
  for (const block of text.matchAll(BLOCK_PATTERN)) {
    for (const file of block[1].matchAll(FILE_PATTERN)) {
      const pathValue = attr(file[1] || file[3] || "", "path") || decodeXml(file[2] || "").trim();
      if (!pathValue) continue;
      const lower = pathValue.toLowerCase();
      const kind: WorkspaceFileKind | undefined = lower.endsWith(".html") || lower.endsWith(".htm") ? "html" : lower.endsWith(".svg") ? "svg" : lower.endsWith(".md") || lower.endsWith(".markdown") ? "markdown" : undefined;
      if (!kind) continue;
      const normalized = pathValue.replaceAll("\\", "/").replace(/^\.\//, "");
      if (normalized.startsWith("/") || normalized.split("/").includes("..")) continue;
      if (!result.some((item) => item.path === normalized)) result.push({ path: normalized, kind, name: normalized.split("/").at(-1) || normalized });
    }
  }
  return result;
}

export function stripWorkspaceFilesMarkup(text: string): string {
  return text.replace(BLOCK_PATTERN, "").trimEnd();
}
