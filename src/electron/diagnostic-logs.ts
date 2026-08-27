import AdmZip from "adm-zip";
import fs from "node:fs";
import path from "node:path";

const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
const SECRET_KEY = /^(?:password|secret|token|accessToken|apiKey|authorization|cookie|email|dataUrl|text|content)$/i;

export interface DiagnosticContext {
  appVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  isPackaged: boolean;
}

export function diagnosticLogDirectory(workspace: string): string {
  return path.join(workspace, "logs");
}

export function exportDiagnosticLogs(workspace: string, destination: string, context: DiagnosticContext): string {
  const logDirectory = diagnosticLogDirectory(workspace);
  fs.mkdirSync(logDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const archive = new AdmZip();
  const files = collectFiles(logDirectory);
  for (const file of files) {
    const relative = path.relative(logDirectory, file).split(path.sep).join("/");
    archive.addFile(`logs/${relative}`, sanitizeLogFile(fs.readFileSync(file)));
  }

  archive.addFile("diagnostic.json", Buffer.from(`${JSON.stringify({
    ...context,
    generatedAt: new Date().toISOString(),
    logFiles: files.map((file) => ({ name: path.relative(logDirectory, file).split(path.sep).join("/"), bytes: fs.statSync(file).size }))
  }, null, 2)}\n`, "utf8"));
  if (files.length === 0) archive.addFile("logs/README.txt", Buffer.from("当前没有可用日志。\n", "utf8"));
  archive.writeZip(destination);
  return destination;
}

function collectFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...collectFiles(fullPath));
    else if (entry.isFile()) result.push(fullPath);
  }
  return result.sort();
}

function sanitizeLogFile(bytes: Buffer): Buffer {
  const input = bytes.length > MAX_LOG_FILE_BYTES ? bytes.subarray(bytes.length - MAX_LOG_FILE_BYTES) : bytes;
  const text = input.toString("utf8");
  const sanitized = text.split(/\r?\n/).map((line) => {
    try {
      return JSON.stringify(sanitize(JSON.parse(line)));
    } catch {
      return line;
    }
  }).join("\n");
  const prefix = bytes.length > MAX_LOG_FILE_BYTES ? "[日志过大，仅导出最后 10 MB]\n" : "";
  return Buffer.from(prefix + sanitized, "utf8");
}

function sanitize(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey)]));
  return value;
}
