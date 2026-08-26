import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compareVersions, marketplaceRequestUrls } from "./marketplace.js";
import { startCompanionProcess, writeCompanionPackage, type CompanionLogger } from "./companion-package.js";

export const ICCCE_PLUGIN_REPOSITORY = "SECTL/ICC-CE-SecAgent-Plugin";
export const ICCCE_PLUGIN_ID = "inkcanvas.iccce.secagent";
export const ICCCE_PLUGIN_ASSET_NAME = "inkcanvas.iccce.secagent.icpx";
export const ICCCE_RELEASE_API_URL = `https://api.github.com/repos/${ICCCE_PLUGIN_REPOSITORY}/releases/latest`;
const ICCCE_RELEASE_PAGE_URL = `https://github.com/${ICCCE_PLUGIN_REPOSITORY}/releases/latest`;

const ICCCE_PLUGIN_VERSION_PATTERN = /["']?Version["']?\s*:\s*["']([^"']+)["']/i;
const ICCCE_PLUGIN_ID_PATTERN = /["']?Id["']?\s*:\s*["']([^"']+)["']/i;
const WINDOWS_ICCCE_EXECUTABLES = ["InkCanvasForClass.exe", "Ink Canvas.exe", "InkCanvas.exe", "ICC-CE.exe"];
const MAX_ICCCE_PLUGIN_BYTES = 100 * 1024 * 1024;

type SupportedPlatform = NodeJS.Platform;
type PathApi = typeof path.win32;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
type CommandRunner = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface IccceInstallCandidate {
  id: string;
  executablePath: string;
  rootPath: string;
  pluginPackagesPath: string;
  pluginsPath: string;
  version?: string;
  installedPluginVersion?: string;
  packageType?: string;
  isRunning: boolean;
  pid?: number;
  launchArgs: string[];
  source: string;
  compatible: boolean;
  reason?: string;
}

export interface IccceInstallResult {
  targetId: string;
  ok: boolean;
  action: "installed" | "already-installed" | "skipped" | "failed";
  message: string;
  version?: string;
}

export type IccceInstallPhase = "downloading" | "verifying" | "installing" | "restarting";
export interface IccceInstallProgress {
  phase: IccceInstallPhase;
  targetIds: string[];
  message?: string;
}

export interface IccceRunningProcess {
  executablePath: string;
  pid: number;
  commandLine?: string;
  version?: string;
}

export interface IccceDiscoveryOptions {
  platform?: SupportedPlatform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  executablePaths?: string[];
  runningProcesses?: IccceRunningProcess[];
  commandRunner?: CommandRunner;
  versionOf?: (executablePath: string) => Promise<string | undefined> | string | undefined;
  exists?: (candidate: string) => boolean;
  readFile?: (filePath: string) => string;
}

export interface IccceInstallerOptions extends IccceDiscoveryOptions {
  fetcher?: Fetcher;
  requestGracefulClose?: (pid: number) => Promise<void>;
  forceTerminateProcess?: (pid: number) => Promise<void>;
  isProcessRunning?: (pid: number) => Promise<boolean>;
  restartProcess?: (executablePath: string, args: string[]) => Promise<void>;
  waitForExitTimeoutMs?: number;
  waitForExitPollMs?: number;
  waitForPluginTimeoutMs?: number;
  waitForPluginPollMs?: number;
  now?: () => number;
  writePackage?: (filePath: string, bytes: Buffer) => Promise<string> | string;
  log?: CompanionLogger;
}

export interface ResolvedIccceLayout {
  packageRoot: string;
  pluginPackagesPath: string;
  pluginsPath: string;
  packageType?: string;
}

interface CachedCandidate extends IccceInstallCandidate {
  canonicalExecutablePath: string;
  canonicalRootPath: string;
}

interface ReleaseMetadata {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: Array<{ name: string; browser_download_url: string; digest?: string; size?: number }>;
}

const execFileAsync = promisify(execFile);

function platformPath(platform: SupportedPlatform): PathApi {
  return platform === "win32" ? path.win32 : path.posix;
}

function normalizePath(value: string, platform: SupportedPlatform): string {
  const api = platformPath(platform);
  const normalized = api.normalize(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function hashId(executablePath: string, rootPath: string, platform: SupportedPlatform): string {
  return crypto.createHash("sha256").update(`${normalizePath(executablePath, platform)}\0${normalizePath(rootPath, platform)}`).digest("hex").slice(0, 20);
}

function defaultExists(candidate: string): boolean {
  try { return fs.existsSync(candidate); } catch { return false; }
}

function defaultReadFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function defaultCommandRunner(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(file, args, { encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024 }).then((result) => ({ stdout: result.stdout, stderr: result.stderr }));
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseJsonList(output: string): string[] {
  if (!output.trim()) return [];
  try {
    const parsed = JSON.parse(output) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
    return typeof parsed === "string" ? [parsed] : [];
  } catch {
    return [];
  }
}

async function discoverWindowsExternalPaths(commandRunner: CommandRunner, env: NodeJS.ProcessEnv): Promise<string[]> {
  const registryScript = String.raw`
$keys = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$result = Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -and $_.DisplayName -match '(?i)(ICC\s*[- ]?CE|Ink\s*Canvas)' } |
  ForEach-Object { @($_.InstallLocation, ($_.DisplayIcon -replace ',\d+$', '')) } |
  Where-Object { $_ -and $_.ToString().Trim() }
@($result) | ConvertTo-Json -Compress
`;
  const shortcutRoots = [
    path.win32.join(env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs"),
    path.win32.join(env.ProgramData || "C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"),
    path.win32.join(env.USERPROFILE || "", "Desktop")
  ];
  const shortcutScript = String.raw`
$roots = @(${shortcutRoots.map(quotePowerShell).join(",")})
$shell = New-Object -ComObject WScript.Shell
$result = Get-ChildItem -Path $roots -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue |
  ForEach-Object {
    try {
      $shortcut = $shell.CreateShortcut($_.FullName)
      if ($shortcut.TargetPath -match '(?i)(InkCanvasForClass|Ink Canvas|ICC[- ]?CE)') { $shortcut.TargetPath }
    } catch { }
  }
@($result) | ConvertTo-Json -Compress
`;
  const paths: string[] = [];
  try {
    const result = await commandRunner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", registryScript]);
    paths.push(...parseJsonList(result.stdout));
  } catch { /* Registry access is best effort. */ }
  try {
    const result = await commandRunner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", shortcutScript]);
    paths.push(...parseJsonList(result.stdout));
  } catch { /* Shortcut access is best effort. */ }
  return paths;
}

async function discoverRunningProcesses(platform: SupportedPlatform, commandRunner: CommandRunner): Promise<IccceRunningProcess[]> {
  if (platform !== "win32") return [];
  const names = WINDOWS_ICCCE_EXECUTABLES.map((name) => `'${name}'`).join(",");
  const script = String.raw`
$names = @(${names})
Get-CimInstance Win32_Process |
  Where-Object { $names -contains $_.Name } |
  ForEach-Object {
    $version = $null
    try { $version = (Get-Item -LiteralPath $_.ExecutablePath).VersionInfo.ProductVersion } catch { }
    [pscustomobject]@{
      executablePath = $_.ExecutablePath
      pid = [int]$_.ProcessId
      commandLine = $_.CommandLine
      version = $version
    }
  } | ConvertTo-Json -Compress
`;
  try {
    const result = await commandRunner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    if (!result.stdout.trim()) return [];
    const raw = JSON.parse(result.stdout) as unknown;
    const items = Array.isArray(raw) ? raw : [raw];
    return items.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      if (typeof record.executablePath !== "string" || typeof record.pid !== "number") return [];
      return [{ executablePath: record.executablePath, pid: record.pid, ...(typeof record.commandLine === "string" ? { commandLine: record.commandLine } : {}), ...(typeof record.version === "string" ? { version: record.version } : {}) }];
    });
  } catch {
    return [];
  }
}

function parseWindowsCommandLine(commandLine: string | undefined): string[] {
  if (!commandLine?.trim()) return [];
  const args: string[] = [];
  let current = "";
  let quoted = false;
  let slashCount = 0;
  const pushSlashes = (count: number) => { current += "\\".repeat(count); };
  for (let index = 0; index < commandLine.length; index++) {
    const char = commandLine[index];
    if (char === "\\") { slashCount++; continue; }
    if (char === '"') {
      pushSlashes(Math.floor(slashCount / 2));
      if (slashCount % 2 === 1) current += '"';
      else quoted = !quoted;
      slashCount = 0;
      continue;
    }
    pushSlashes(slashCount);
    slashCount = 0;
    if (/\s/.test(char) && !quoted) {
      if (current) { args.push(current); current = ""; }
    } else current += char;
  }
  pushSlashes(slashCount);
  if (current) args.push(current);
  return args;
}

function executableCandidates(input: string, platform: SupportedPlatform): string[] {
  const api = platformPath(platform);
  const normalized = input.trim().replace(/,\d+$/, "").replace(/^"(.*)"$/, "$1");
  if (platform !== "win32") return [normalized];
  if (api.extname(normalized).toLowerCase() === ".exe") return [normalized];
  return WINDOWS_ICCCE_EXECUTABLES.map((name) => api.join(normalized, name));
}

function isKnownIccceExecutable(candidate: string, platform: SupportedPlatform): boolean {
  if (platform !== "win32") return true;
  const name = path.win32.basename(candidate).toLowerCase();
  return WINDOWS_ICCCE_EXECUTABLES.some((executable) => executable.toLowerCase() === name);
}

function staticExecutablePaths(platform: SupportedPlatform, home: string, env: NodeJS.ProcessEnv): string[] {
  const api = platformPath(platform);
  if (platform !== "win32") return [];
  const local = env.LOCALAPPDATA || api.join(home, "AppData", "Local");
  const programFiles = env.PROGRAMFILES || "C:\\Program Files";
  const programFilesX86 = env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const roots = [
    local,
    api.join(local, "Programs"),
    programFiles,
    programFilesX86,
    home,
    api.join(home, "Desktop"),
    api.join(home, "Downloads")
  ];
  const directories = ["", "InkCanvasForClass CE", "InkCanvasForClass", "ICC-CE", "Ink Canvas"];
  return roots.flatMap((root) => directories.flatMap((directory) => WINDOWS_ICCCE_EXECUTABLES.map((name) => api.join(root, directory, name))));
}

function inferPackageType(rootPath: string, platform: SupportedPlatform, home: string, env: NodeJS.ProcessEnv): string | undefined {
  if (platform !== "win32") return undefined;
  const api = path.win32;
  const local = env.LOCALAPPDATA || api.join(home, "AppData", "Local");
  return normalizePath(rootPath, platform).startsWith(`${normalizePath(api.join(local, "InkCanvasForClass CE"), platform)}\\`) ? "installer" : "portable";
}

export function resolveIccceLayout(executablePath: string, options: { platform?: SupportedPlatform; home?: string; env?: NodeJS.ProcessEnv } = {}): ResolvedIccceLayout {
  const platform = options.platform || process.platform;
  const api = platformPath(platform);
  const rootPath = api.resolve(api.dirname(executablePath));
  const packageType = inferPackageType(rootPath, platform, options.home || os.homedir(), options.env || process.env);
  return {
    packageRoot: rootPath,
    pluginPackagesPath: api.join(rootPath, "PluginPackages"),
    pluginsPath: api.join(rootPath, "Plugins"),
    ...(packageType ? { packageType } : {})
  };
}

function installedPluginVersion(layout: ResolvedIccceLayout, platform: SupportedPlatform, exists: (candidate: string) => boolean, readFile: (filePath: string) => string): string | undefined {
  const manifestPath = platformPath(platform).join(layout.pluginsPath, ICCCE_PLUGIN_ID, "manifest.json");
  if (!exists(manifestPath)) return undefined;
  try {
    const raw = readFile(manifestPath);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const id = typeof parsed.Id === "string" ? parsed.Id : typeof parsed.id === "string" ? parsed.id : ICCCE_PLUGIN_ID;
    if (id.toLowerCase() !== ICCCE_PLUGIN_ID.toLowerCase()) return undefined;
    const version = typeof parsed.Version === "string" ? parsed.Version : typeof parsed.version === "string" ? parsed.version : undefined;
    return version?.trim() || ICCCE_PLUGIN_VERSION_PATTERN.exec(raw)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

async function waitForInstalledPlugin(
  readVersion: () => string | undefined,
  expectedVersion: string,
  timeoutMs = 15_000,
  pollMs = 250
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const current = readVersion();
    if (current && compareVersions(current, expectedVersion) >= 0) return current;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function defaultVersionOf(executablePath: string, platform: SupportedPlatform, commandRunner: CommandRunner): Promise<string | undefined> {
  if (platform !== "win32") return undefined;
  const script = `$item = Get-Item -LiteralPath ${quotePowerShell(executablePath)}; $item.VersionInfo.ProductVersion`;
  try {
    const result = await commandRunner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return result.stdout.trim() || undefined;
  } catch { return undefined; }
}

export async function discoverIccceInstallations(options: IccceDiscoveryOptions = {}): Promise<IccceInstallCandidate[]> {
  const platform = options.platform || process.platform;
  const api = platformPath(platform);
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const exists = options.exists || defaultExists;
  const readFile = options.readFile || defaultReadFile;
  const commandRunner = options.commandRunner || defaultCommandRunner;
  const running = options.runningProcesses || await discoverRunningProcesses(platform, commandRunner);
  const externalPaths = platform === "win32" && !options.executablePaths?.length && !options.runningProcesses ? await discoverWindowsExternalPaths(commandRunner, env) : [];
  const inputPaths = [
    ...staticExecutablePaths(platform, home, env),
    ...(options.executablePaths || []),
    ...externalPaths,
    ...running.map((item) => item.executablePath)
  ].flatMap((item) => executableCandidates(item, platform));
  const runningByPath = new Map(running.map((item) => [normalizePath(item.executablePath, platform), item]));
  const candidates = new Map<string, CachedCandidate>();
  const versionOf = options.versionOf || ((executablePath: string) => defaultVersionOf(executablePath, platform, commandRunner));
  for (const executablePath of [...new Set(inputPaths.map((item) => api.normalize(item)))].filter((item) => isKnownIccceExecutable(item, platform))) {
    if (!exists(executablePath)) continue;
    const processInfo = runningByPath.get(normalizePath(executablePath, platform));
    const version = processInfo?.version || await versionOf(executablePath);
    const layout = resolveIccceLayout(executablePath, { platform, home, env });
    const candidate: CachedCandidate = {
      id: hashId(executablePath, layout.packageRoot, platform),
      executablePath,
      rootPath: layout.packageRoot,
      pluginPackagesPath: layout.pluginPackagesPath,
      pluginsPath: layout.pluginsPath,
      ...(version ? { version } : {}),
      ...(installedPluginVersion(layout, platform, exists, readFile) ? { installedPluginVersion: installedPluginVersion(layout, platform, exists, readFile) } : {}),
      ...(layout.packageType ? { packageType: layout.packageType } : {}),
      isRunning: Boolean(processInfo),
      ...(processInfo ? { pid: processInfo.pid, launchArgs: parseWindowsCommandLine(processInfo.commandLine).slice(1) } : { launchArgs: [] }),
      source: processInfo ? "running-process" : options.executablePaths?.some((item) => normalizePath(item, platform) === normalizePath(executablePath, platform)) ? "manual-or-explicit" : "discovery",
      compatible: true,
      ...(version ? {} : { reason: "无法读取 ICC-CE 版本，将按当前插件兼容性继续安装" }),
      canonicalExecutablePath: normalizePath(executablePath, platform),
      canonicalRootPath: normalizePath(layout.packageRoot, platform)
    };
    const key = `${candidate.canonicalExecutablePath}\0${candidate.canonicalRootPath}`;
    const previous = candidates.get(key);
    if (!previous || (!previous.isRunning && candidate.isRunning)) candidates.set(key, candidate);
  }
  return [...candidates.values()].map(({ canonicalExecutablePath: _executable, canonicalRootPath: _root, ...candidate }) => candidate);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function releaseTagFromPage(url: string | undefined, html: string): string | undefined {
  const candidates = [url || "", ...(html.match(/\/releases\/tag\/[^\s"'<]+/gi) || [])];
  for (const candidate of candidates) {
    const match = candidate.match(/\/releases\/tag\/([^/?#"'<]+)/i);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

function releaseAssetFromExpandedPage(html: string): ReleaseMetadata["assets"][number] | undefined {
  const blocks = html.match(/<li\b[\s\S]*?<\/li>/gi) || [];
  for (const block of blocks) {
    if (!new RegExp(`>${escapeRegExp(ICCCE_PLUGIN_ASSET_NAME)}<`, "i").test(block)) continue;
    const href = block.match(/href=["']([^"']+\/releases\/download\/[^"']+)["']/i)?.[1]?.replaceAll("&amp;", "&");
    const digest = block.match(/sha256:([a-f0-9]{64})/i)?.[1];
    if (!href || !digest) continue;
    const browserDownloadUrl = new URL(href, "https://github.com").toString();
    if (new URL(browserDownloadUrl).hostname !== "github.com") continue;
    return { name: ICCCE_PLUGIN_ASSET_NAME, browser_download_url: browserDownloadUrl, digest: `sha256:${digest}` };
  }
  return undefined;
}

async function fetchReleasePageMetadata(fetcher: Fetcher, now: () => number): Promise<ReleaseMetadata | undefined> {
  let lastError: unknown;
  for (const pageUrl of marketplaceRequestUrls(`${ICCCE_RELEASE_PAGE_URL}?secagent_cache=${now()}`)) {
    try {
      const response = await fetcher(pageUrl, { signal: AbortSignal.timeout(12_000), headers: { Accept: "text/html", "User-Agent": "SecAgent" } });
      if (!response.ok) { lastError = new Error(`HTTP ${response.status}`); continue; }
      const html = await response.text();
      const tag = releaseTagFromPage(response.url, html);
      if (!tag) { lastError = new Error("GitHub Release 页面缺少版本标签"); continue; }
      const expandedUrl = `https://github.com/${ICCCE_PLUGIN_REPOSITORY}/releases/expanded_assets/${encodeURIComponent(tag)}?secagent_cache=${now()}`;
      for (const assetsUrl of marketplaceRequestUrls(expandedUrl)) {
        try {
          const assetsResponse = await fetcher(assetsUrl, { signal: AbortSignal.timeout(12_000), headers: { Accept: "text/html", "User-Agent": "SecAgent" } });
          if (!assetsResponse.ok) { lastError = new Error(`HTTP ${assetsResponse.status}`); continue; }
          const asset = releaseAssetFromExpandedPage(await assetsResponse.text());
          if (asset) return { tag_name: tag, assets: [asset] };
          lastError = new Error(`Release 页面缺少 ${ICCCE_PLUGIN_ASSET_NAME} 或 SHA-256`);
        } catch (error) { lastError = error; }
      }
    } catch (error) { lastError = error; }
  }
  return undefined;
}

async function downloadLatestIcccePlugin(fetcher: Fetcher, now: () => number, onProgress?: (phase: IccceInstallPhase, message?: string) => void): Promise<{ bytes: Buffer; version: string; sha256: string }> {
  onProgress?.("downloading", "正在通过 ghproxy.sectl.cn 下载最新 ICC-CE 插件");
  let release: ReleaseMetadata | undefined;
  let lastError: unknown;
  for (const candidate of marketplaceRequestUrls(`${ICCCE_RELEASE_API_URL}?secagent_cache=${now()}`)) {
    try {
      const response = await fetcher(candidate, { signal: AbortSignal.timeout(12_000), headers: { Accept: "application/vnd.github+json", "User-Agent": "SecAgent" } });
      if (!response.ok) { lastError = new Error(`HTTP ${response.status}`); continue; }
      const payload = await response.json() as ReleaseMetadata;
      if (!payload || typeof payload.tag_name !== "string" || payload.draft === true || payload.prerelease === true || !Array.isArray(payload.assets)) throw new Error("GitHub 最新 Release 信息无效");
      release = payload;
      break;
    } catch (error) { lastError = error; }
  }
  if (!release) release = await fetchReleasePageMetadata(fetcher, now);
  if (!release) throw new Error(`无法读取 ICC-CE 侧插件最新 Release：${lastError instanceof Error ? lastError.message : String(lastError)}`);
  const asset = release.assets.find((item) => item.name === ICCCE_PLUGIN_ASSET_NAME && typeof item.browser_download_url === "string");
  if (!asset) throw new Error(`最新 ICC-CE Release 缺少 ${ICCCE_PLUGIN_ASSET_NAME}；该仓库需要先发布编译后的 .icpx 插件包`);
  const digest = typeof asset.digest === "string" ? asset.digest.replace(/^sha256:/i, "") : "";
  if (!/^[a-f0-9]{64}$/i.test(digest)) throw new Error("ICC-CE Release 缺少有效的 SHA-256 校验值");
  if (typeof asset.size === "number" && asset.size > MAX_ICCCE_PLUGIN_BYTES) throw new Error("ICC-CE 插件包过大，已停止安装");
  try {
    if (new URL(asset.browser_download_url).hostname.toLowerCase() !== "github.com") throw new Error("ICC-CE Release 资产地址无效");
  } catch {
    throw new Error("ICC-CE Release 资产地址无效");
  }
  for (const candidate of marketplaceRequestUrls(asset.browser_download_url)) {
    try {
      const response = await fetcher(candidate, { signal: AbortSignal.timeout(60_000), headers: { "User-Agent": "SecAgent" } });
      if (!response.ok) { lastError = new Error(`HTTP ${response.status}`); continue; }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_ICCCE_PLUGIN_BYTES) { lastError = new Error("ICC-CE 插件包过大"); continue; }
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) { lastError = new Error("ICC-CE 插件包不是有效的 .icpx 压缩包"); continue; }
      onProgress?.("verifying", "正在校验 ICC-CE 插件 SHA-256");
      const actual = crypto.createHash("sha256").update(bytes).digest("hex");
      if (actual.toLowerCase() !== digest.toLowerCase()) { lastError = new Error("ICC-CE 插件 SHA-256 校验失败"); continue; }
      return { bytes, version: release.tag_name.replace(/^v/i, ""), sha256: actual };
    } catch (error) { lastError = error; }
  }
  throw new Error(`下载 ICC-CE 插件失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function defaultRequestGracefulClose(pid: number, platform: SupportedPlatform, commandRunner: CommandRunner): Promise<void> {
  if (platform === "win32") {
    const script = `$process = Get-Process -Id ${pid} -ErrorAction Stop; [void]$process.CloseMainWindow()`;
    await commandRunner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return;
  }
  process.kill(pid, "SIGTERM");
}

async function defaultForceTerminate(pid: number, platform: SupportedPlatform, commandRunner: CommandRunner): Promise<void> {
  if (platform === "win32") {
    const script = `Stop-Process -Id ${pid} -Force -ErrorAction Stop`;
    await commandRunner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return;
  }
  process.kill(pid, "SIGKILL");
}

async function defaultIsProcessRunning(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForProcessExit(pid: number, isProcessRunning: (pid: number) => Promise<boolean>, timeoutMs = 10_000, pollMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isProcessRunning(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !(await isProcessRunning(pid));
}

export class IccceInstaller {
  private candidates = new Map<string, IccceInstallCandidate>();
  private readonly platform: SupportedPlatform;
  private readonly fetcher: Fetcher;
  private readonly commandRunner: CommandRunner;
  private readonly options: IccceInstallerOptions;

  constructor(options: IccceInstallerOptions = {}) {
    this.options = options;
    this.platform = options.platform || process.platform;
    this.fetcher = options.fetcher || fetch;
    this.commandRunner = options.commandRunner || defaultCommandRunner;
  }

  async detect(): Promise<IccceInstallCandidate[]> {
    const discovered = await discoverIccceInstallations({ ...this.options, commandRunner: this.commandRunner, platform: this.platform, executablePaths: [...(this.options.executablePaths || []), ...[...this.candidates.values()].map((candidate) => candidate.executablePath)] });
    this.candidates = new Map(discovered.map((candidate) => [candidate.id, candidate]));
    return discovered;
  }

  async inspect(executablePath: string): Promise<IccceInstallCandidate | undefined> {
    const discovered = await discoverIccceInstallations({ ...this.options, commandRunner: this.commandRunner, platform: this.platform, executablePaths: [executablePath] });
    const candidate = discovered[0];
    if (candidate) this.candidates.set(candidate.id, candidate);
    return candidate;
  }

  async install(targetIds: string[], onProgress?: (progress: IccceInstallProgress) => void): Promise<IccceInstallResult[]> {
    const latestCandidates = await this.detect();
    const selected = latestCandidates.filter((candidate) => targetIds.includes(candidate.id));
    const missing = targetIds.filter((id) => !selected.some((candidate) => candidate.id === id)).map((targetId) => ({ targetId, ok: false, action: "failed" as const, message: "找不到 ICC-CE 安装目标，请重新检测" }));
    if (!selected.length) return missing;
    const valid = selected.filter((candidate) => candidate.compatible);
    const results: IccceInstallResult[] = selected.filter((candidate) => !candidate.compatible).map((candidate) => ({ targetId: candidate.id, ok: false, action: "skipped" as const, message: candidate.reason || "ICC-CE 版本不兼容" }));
    if (!valid.length) return [...results, ...missing];

    const report = (phase: IccceInstallPhase, message?: string) => onProgress?.({ phase, targetIds, ...(message ? { message } : {}) });
    const log = (stage: string, data: unknown = {}) => this.options.log?.(`companion.iccce.${stage}`, data);
    log("install.begin", { targetIds, candidates: selected.map((candidate) => ({ id: candidate.id, executablePath: candidate.executablePath, rootPath: candidate.rootPath, pluginPackagesPath: candidate.pluginPackagesPath, pluginsPath: candidate.pluginsPath, version: candidate.version, installedPluginVersion: candidate.installedPluginVersion, isRunning: candidate.isRunning, pid: candidate.pid })) });
    const packageData = await downloadLatestIcccePlugin(this.fetcher, this.options.now || Date.now, (phase, message) => report(phase, message));
    log("download.success", { version: packageData.version, bytes: packageData.bytes.length, sha256: packageData.sha256 });
    const groups = new Map<string, IccceInstallCandidate[]>();
    for (const candidate of valid) {
      const key = normalizePath(candidate.rootPath, this.platform);
      groups.set(key, [...(groups.get(key) || []), candidate]);
    }
    const restart = this.options.restartProcess || ((executablePath: string, args: string[]) => startCompanionProcess(executablePath, args, this.platform, (stage, data) => log(stage, data)));
    const isRunning = this.options.isProcessRunning || defaultIsProcessRunning;
    const requestClose = this.options.requestGracefulClose || ((pid: number) => defaultRequestGracefulClose(pid, this.platform, this.commandRunner));
    const forceTerminate = this.options.forceTerminateProcess || ((pid: number) => defaultForceTerminate(pid, this.platform, this.commandRunner));
    const exists = this.options.exists || defaultExists;
    const readFile = this.options.readFile || defaultReadFile;
    const writePackage = this.options.writePackage || ((filePath: string, bytes: Buffer) => writeCompanionPackage(filePath, bytes, this.platform, (stage, data) => log(stage, data)));
    for (const group of groups.values()) {
      log("group.begin", { rootPath: group[0].rootPath, targets: group.map((candidate) => candidate.id), pluginPackagesPath: group[0].pluginPackagesPath, pluginsPath: group[0].pluginsPath });
      const alreadyInstalled = group.every((candidate) => candidate.installedPluginVersion && compareVersions(candidate.installedPluginVersion, packageData.version) >= 0);
      if (alreadyInstalled) {
        for (const candidate of group) results.push({ targetId: candidate.id, ok: true, action: "already-installed", message: `已安装 ICC-CE 插件 v${packageData.version}`, version: packageData.version });
        continue;
      }
      const running = group.filter((candidate) => candidate.isRunning && candidate.pid !== undefined);
      const closed: IccceInstallCandidate[] = [];
      let closeFailed = false;
      for (const candidate of running) {
        let exited = false;
        try {
          await requestClose(candidate.pid!);
          exited = await waitForProcessExit(candidate.pid!, isRunning, this.options.waitForExitTimeoutMs, this.options.waitForExitPollMs);
        } catch { /* Fall through to the force-terminate path. */ }
        if (!exited) {
          report("restarting", `ICC-CE 未能优雅退出，正在强制结束进程 ${candidate.pid}`);
          try {
            await forceTerminate(candidate.pid!);
            exited = await waitForProcessExit(candidate.pid!, isRunning, this.options.waitForExitTimeoutMs, this.options.waitForExitPollMs);
          } catch { /* The process may be protected or already gone. */ }
        }
        if (!exited) { closeFailed = true; break; }
        closed.push(candidate);
      }
      if (closeFailed) {
        for (const candidate of closed) await restart(candidate.executablePath, candidate.launchArgs).catch(() => undefined);
        for (const candidate of group) results.push({ targetId: candidate.id, ok: false, action: "failed", message: "ICC-CE 无法退出，强制结束也失败，未安装插件；请手动关闭后重试" });
        continue;
      }
      const packagePath = platformPath(this.platform).join(group[0].pluginPackagesPath, ICCCE_PLUGIN_ASSET_NAME);
      try {
        report("installing", "正在写入 ICC-CE 插件包");
        const actualPackagePath = await writePackage(packagePath, packageData.bytes);
        log("package.write.result", { requestedPath: packagePath, actualPackagePath });
        const launchCandidate = closed[0] || group[0];
        const restarting = closed.length > 0;
        report("restarting", restarting ? "正在重新启动 ICC-CE" : "正在启动 ICC-CE");
        log("process.restart.begin", { executablePath: launchCandidate.executablePath, args: launchCandidate.launchArgs, wasRunning: restarting });
        let launchFailed = false;
        try { await restart(launchCandidate.executablePath, launchCandidate.launchArgs); log("process.restart.success", { executablePath: launchCandidate.executablePath }); }
        catch (error) { launchFailed = true; log("process.restart.failed", { executablePath: launchCandidate.executablePath, error: error instanceof Error ? error.message : String(error) }); }
        const installedLayout: ResolvedIccceLayout = {
          packageRoot: group[0].rootPath,
          pluginPackagesPath: group[0].pluginPackagesPath,
          pluginsPath: group[0].pluginsPath,
          ...(group[0].packageType ? { packageType: group[0].packageType } : {})
        };
        const verifiedVersion = launchFailed ? undefined : await waitForInstalledPlugin(
          () => installedPluginVersion(installedLayout, this.platform, exists, readFile),
          packageData.version,
          this.options.waitForPluginTimeoutMs,
          this.options.waitForPluginPollMs
        );
        const verified = Boolean(verifiedVersion);
        log("verification.result", { expectedVersion: packageData.version, verifiedVersion, verified, launchFailed });
        for (const candidate of group) {
          results.push({
            targetId: candidate.id,
            ok: !launchFailed && verified,
            action: !launchFailed && verified ? "installed" : "failed",
            message: launchFailed
              ? `插件包已写入，但 ICC-CE 自动${restarting ? "重启" : "启动"}失败，请手动启动`
              : verified
                ? restarting ? `已安装 ICC-CE 插件 v${verifiedVersion}，ICC-CE 已自动重启` : `已安装 ICC-CE 插件 v${verifiedVersion}，ICC-CE 已自动启动`
                : "插件包已写入并启动，但等待 ICC-CE 解包后未检测到插件，请稍后重试",
            ...(verifiedVersion ? { version: verifiedVersion } : {})
          });
        }
      } catch (error) {
        log("install.failed", { error: error instanceof Error ? error.message : String(error) });
        for (const candidate of closed) await restart(candidate.executablePath, candidate.launchArgs).catch(() => undefined);
        for (const candidate of group) results.push({ targetId: candidate.id, ok: false, action: "failed", message: `写入 ICC-CE 插件失败：${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return [...results, ...missing];
  }
}
