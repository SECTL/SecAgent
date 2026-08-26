import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startCompanionProcess, writeCompanionPackage, type CompanionLogger } from "./companion-package.js";
import { DEFAULT_MARKETPLACE_PROXY_URL, marketplaceRequestUrls } from "./marketplace.js";

export const CLASSISLAND_PLUGIN_REPOSITORY = "SECTL/ClassIsland-SecAgent-Plugin";
export const CLASSISLAND_PLUGIN_ID = "classisland.secagent";
export const CLASSISLAND_PLUGIN_ASSET_NAME = "ClassIsland.SecAgent.Plugin.cipx";
export const MIN_CLASSISLAND_VERSION = "2.1.1.0";
export const CLASSISLAND_RELEASE_API_URL = `https://api.github.com/repos/${CLASSISLAND_PLUGIN_REPOSITORY}/releases/latest`;
const CLASSISLAND_RELEASE_PAGE_URL = `https://github.com/${CLASSISLAND_PLUGIN_REPOSITORY}/releases/latest`;

const CLASSISLAND_PLUGIN_VERSION_PATTERN = /^version\s*:\s*["']?([^"'\r\n#]+)["']?/im;
const WINDOWS_CLASSISLAND_EXE = "ClassIsland.exe";
const MAX_CLASSISLAND_PLUGIN_BYTES = 100 * 1024 * 1024;

type SupportedPlatform = NodeJS.Platform;
type PathApi = typeof path.win32;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
type CommandRunner = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface ClassIslandInstallCandidate {
  id: string;
  executablePath: string;
  rootPath: string;
  dataRoot: string;
  pluginPackagesPath: string;
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

export interface ClassIslandInstallResult {
  targetId: string;
  ok: boolean;
  action: "installed" | "already-installed" | "skipped" | "failed";
  message: string;
  version?: string;
}

export type ClassIslandInstallPhase = "downloading" | "verifying" | "installing" | "restarting";
export interface ClassIslandInstallProgress {
  phase: ClassIslandInstallPhase;
  targetIds: string[];
  message?: string;
}

export interface ClassIslandRunningProcess {
  executablePath: string;
  pid: number;
  commandLine?: string;
  version?: string;
}

export interface ClassIslandDiscoveryOptions {
  platform?: SupportedPlatform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  executablePaths?: string[];
  runningProcesses?: ClassIslandRunningProcess[];
  commandRunner?: CommandRunner;
  versionOf?: (executablePath: string) => Promise<string | undefined> | string | undefined;
  exists?: (candidate: string) => boolean;
  readFile?: (filePath: string) => string;
}

export interface ClassIslandInstallerOptions extends ClassIslandDiscoveryOptions {
  fetcher?: Fetcher;
  requestGracefulClose?: (pid: number) => Promise<void>;
  forceTerminateProcess?: (pid: number) => Promise<void>;
  isProcessRunning?: (pid: number) => Promise<boolean>;
  restartProcess?: (executablePath: string, args: string[]) => Promise<void>;
  waitForExitTimeoutMs?: number;
  waitForExitPollMs?: number;
  waitForPluginTimeoutMs?: number;
  waitForPluginPollMs?: number;
  writePackage?: (filePath: string, bytes: Buffer) => Promise<string> | string;
  log?: CompanionLogger;
  now?: () => number;
}

interface ResolvedClassIslandLayout {
  packageRoot: string;
  dataRoot: string;
  pluginPackagesPath: string;
  packageType?: string;
}

interface CachedCandidate extends ClassIslandInstallCandidate {
  canonicalExecutablePath: string;
  canonicalDataRoot: string;
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

function hashId(executablePath: string, dataRoot: string, platform: SupportedPlatform): string {
  return crypto.createHash("sha256").update(`${normalizePath(executablePath, platform)}\0${normalizePath(dataRoot, platform)}`).digest("hex").slice(0, 20);
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
  Where-Object { $_.DisplayName -like '*ClassIsland*' } |
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
      if ($shortcut.TargetPath -match '(?i)ClassIsland') { $shortcut.TargetPath }
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

async function discoverRunningProcesses(platform: SupportedPlatform, commandRunner: CommandRunner): Promise<ClassIslandRunningProcess[]> {
  if (platform !== "win32") return [];
  const script = String.raw`
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -ieq 'ClassIsland.exe' } |
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

interface ClassIslandReleaseMetadata {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string; digest: string }>;
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

function releaseAssetFromExpandedPage(html: string): ClassIslandReleaseMetadata["assets"][number] | undefined {
  const blocks = html.match(/<li\b[\s\S]*?<\/li>/gi) || [];
  for (const block of blocks) {
    if (!new RegExp(`>${escapeRegExp(CLASSISLAND_PLUGIN_ASSET_NAME)}<`, "i").test(block)) continue;
    const href = block.match(/href=["']([^"']+\/releases\/download\/[^"']+)["']/i)?.[1]?.replaceAll("&amp;", "&");
    const digest = block.match(/sha256:([a-f0-9]{64})/i)?.[1];
    if (!href || !digest) continue;
    const browserDownloadUrl = new URL(href, "https://github.com").toString();
    if (new URL(browserDownloadUrl).hostname !== "github.com") continue;
    return { name: CLASSISLAND_PLUGIN_ASSET_NAME, browser_download_url: browserDownloadUrl, digest: `sha256:${digest}` };
  }
  return undefined;
}

async function fetchReleasePageMetadata(fetcher: Fetcher, now: () => number): Promise<ClassIslandReleaseMetadata | undefined> {
  let lastError: unknown;
  for (const pageUrl of marketplaceRequestUrls(`${CLASSISLAND_RELEASE_PAGE_URL}?secagent_cache=${now()}`)) {
    try {
      const response = await fetcher(pageUrl, { signal: AbortSignal.timeout(12_000), headers: { Accept: "text/html", "User-Agent": "SecAgent" } });
      if (!response.ok) { lastError = new Error(`HTTP ${response.status}`); continue; }
      const html = await response.text();
      const tag = releaseTagFromPage(response.url, html);
      if (!tag) { lastError = new Error("GitHub Release 页面缺少版本标签"); continue; }
      const expandedUrl = `https://github.com/${CLASSISLAND_PLUGIN_REPOSITORY}/releases/expanded_assets/${encodeURIComponent(tag)}?secagent_cache=${now()}`;
      for (const assetsUrl of marketplaceRequestUrls(expandedUrl)) {
        try {
          const assetsResponse = await fetcher(assetsUrl, { signal: AbortSignal.timeout(12_000), headers: { Accept: "text/html", "User-Agent": "SecAgent" } });
          if (!assetsResponse.ok) { lastError = new Error(`HTTP ${assetsResponse.status}`); continue; }
          const asset = releaseAssetFromExpandedPage(await assetsResponse.text());
          if (asset) return { tag_name: tag, assets: [asset] };
          lastError = new Error(`Release 页面缺少 ${CLASSISLAND_PLUGIN_ASSET_NAME} 或 SHA-256`);
        } catch (error) { lastError = error; }
      }
    } catch (error) { lastError = error; }
  }
  return undefined;
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

function potentialExecutablePaths(input: string, platform: SupportedPlatform): string[] {
  const api = platformPath(platform);
  const normalizedInput = input.trim().replace(/,\d+$/, "").replace(/^"(.*)"$/, "$1");
  if (api.extname(normalizedInput).toLowerCase() === (platform === "win32" ? ".exe" : "")) return [normalizedInput];
  if (platform === "darwin" && normalizedInput.endsWith(".app")) return [api.join(normalizedInput, "Contents", "MacOS", "ClassIsland")];
  return platform === "win32" ? [api.join(normalizedInput, WINDOWS_CLASSISLAND_EXE), api.join(normalizedInput, "ClassIsland", WINDOWS_CLASSISLAND_EXE)] : [api.join(normalizedInput, "ClassIsland")];
}

function staticExecutablePaths(platform: SupportedPlatform, home: string, env: NodeJS.ProcessEnv): string[] {
  const api = platformPath(platform);
  if (platform === "darwin") {
    return [
      "/Applications/ClassIsland.app/Contents/MacOS/ClassIsland",
      api.join(home, "Applications", "ClassIsland.app", "Contents", "MacOS", "ClassIsland")
    ];
  }
  if (platform !== "win32") return [api.join(home, "ClassIsland", "ClassIsland")];
  const local = env.LOCALAPPDATA || api.join(home, "AppData", "Local");
  const roaming = env.APPDATA || api.join(home, "AppData", "Roaming");
  const programFiles = env.PROGRAMFILES || "C:\\Program Files";
  const programFilesX86 = env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const roots = [
    local,
    api.join(local, "Programs"),
    roaming,
    programFiles,
    programFilesX86,
    home,
    api.join(home, "Desktop"),
    api.join(home, "Downloads")
  ];
  return roots.flatMap((root) => [
    api.join(root, WINDOWS_CLASSISLAND_EXE),
    api.join(root, "ClassIsland", WINDOWS_CLASSISLAND_EXE),
    api.join(root, "ClassIsland", "ClassIsland", WINDOWS_CLASSISLAND_EXE)
  ]);
}

function readPackageType(executablePath: string, platform: SupportedPlatform, env: NodeJS.ProcessEnv, readFile: (filePath: string) => string): { packageRoot: string; packageType?: string } {
  const api = platformPath(platform);
  const executableDirectory = api.dirname(executablePath);
  const overrideRoot = env.ClassIsland_PackageRoot?.trim();
  if (overrideRoot) {
    const typePath = api.join(overrideRoot, "PackageType");
    try { return { packageRoot: api.resolve(overrideRoot), packageType: readFile(typePath).trim() || undefined }; } catch { return { packageRoot: api.resolve(overrideRoot) }; }
  }
  for (const [packageRoot, typePath] of [[executableDirectory, api.join(executableDirectory, "PackageType")], [api.dirname(executableDirectory), api.join(api.dirname(executableDirectory), "PackageType")]] as const) {
    try {
      const packageType = readFile(typePath).replace(/[\r\n]/g, "").trim();
      if (packageType) return { packageRoot: api.resolve(packageRoot), packageType };
    } catch { /* Try the other packaging marker. */ }
  }
  return { packageRoot: api.resolve(executableDirectory) };
}

export function resolveClassIslandLayout(executablePath: string, options: { platform?: SupportedPlatform; home?: string; env?: NodeJS.ProcessEnv; readFile?: (filePath: string) => string } = {}): ResolvedClassIslandLayout {
  const platform = options.platform || process.platform;
  const api = platformPath(platform);
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const readFile = options.readFile || defaultReadFile;
  const marker = readPackageType(executablePath, platform, env, readFile);
  const portable = marker.packageType?.toLowerCase() === "folder";
  const appData = platform === "win32"
    ? env.APPDATA || api.join(home, "AppData", "Roaming")
    : platform === "darwin"
      ? api.join(home, "Library", "Application Support")
      : env.XDG_CONFIG_HOME || api.join(home, ".config");
  const dataRoot = portable
    ? api.join(marker.packageRoot, "data")
    : ["installer", "deb", "appimage", "pkg", "msix"].includes(marker.packageType?.toLowerCase() || "") || platform === "darwin"
      ? api.join(appData, "ClassIsland", "Data")
      : marker.packageRoot;
  return { packageRoot: marker.packageRoot, dataRoot, pluginPackagesPath: api.join(dataRoot, "Cache", "PluginPackages"), ...(marker.packageType ? { packageType: marker.packageType } : {}) };
}

function installedPluginVersion(dataRoot: string, platform: SupportedPlatform, exists: (candidate: string) => boolean, readFile: (filePath: string) => string): string | undefined {
  const api = platformPath(platform);
  const manifestPath = api.join(dataRoot, "Plugins", CLASSISLAND_PLUGIN_ID, "manifest.yml");
  if (!exists(manifestPath)) return undefined;
  try { return CLASSISLAND_PLUGIN_VERSION_PATTERN.exec(readFile(manifestPath))?.[1]?.trim(); } catch { return undefined; }
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
    if (current && compareClassIslandVersions(current, expectedVersion) >= 0) return current;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function defaultVersionOf(executablePath: string, platform: SupportedPlatform, commandRunner: CommandRunner): Promise<string | undefined> {
  if (platform === "win32") {
    const script = `$item = Get-Item -LiteralPath ${quotePowerShell(executablePath)}; $item.VersionInfo.ProductVersion`;
    try {
      const result = await commandRunner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
      return result.stdout.trim() || undefined;
    } catch { return undefined; }
  }
  if (platform === "darwin") {
    const api = path.posix;
    const appPath = executablePath.match(/^(.*?\.app)\/Contents\/MacOS\//i)?.[1];
    if (!appPath) return undefined;
    try {
      const result = await commandRunner("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", api.join(appPath, "Contents", "Info.plist")]);
      return result.stdout.trim() || undefined;
    } catch { return undefined; }
  }
  return undefined;
}

export function compareClassIslandVersions(left: string, right: string): number {
  const parse = (value: string) => value.trim().replace(/^v/i, "").split(/[.+-]/).map((part) => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference > 0 ? 1 : -1;
  }
  return 0;
}

export function isCompatibleClassIslandVersion(version: string | undefined): boolean {
  return Boolean(version && compareClassIslandVersions(version, MIN_CLASSISLAND_VERSION) >= 0);
}

export async function discoverClassIslandInstallations(options: ClassIslandDiscoveryOptions = {}): Promise<ClassIslandInstallCandidate[]> {
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
    ...externalPaths.flatMap((item) => potentialExecutablePaths(item, platform)),
    ...running.map((item) => item.executablePath)
  ];
  const candidates = new Map<string, CachedCandidate>();
  const runningByPath = new Map(running.map((item) => [normalizePath(item.executablePath, platform), item]));
  const versionOf = options.versionOf || ((executablePath: string) => defaultVersionOf(executablePath, platform, commandRunner));
  for (const executablePath of [...new Set(inputPaths.map((item) => api.normalize(item)))]) {
    if (!exists(executablePath)) continue;
    const processInfo = runningByPath.get(normalizePath(executablePath, platform));
    const version = processInfo?.version || await versionOf(executablePath);
    const layout = resolveClassIslandLayout(executablePath, { platform, home, env, readFile });
    const compatible = isCompatibleClassIslandVersion(version);
    const candidate: CachedCandidate = {
      id: hashId(executablePath, layout.dataRoot, platform),
      executablePath,
      rootPath: layout.packageRoot,
      dataRoot: layout.dataRoot,
      pluginPackagesPath: layout.pluginPackagesPath,
      ...(version ? { version } : {}),
      ...(installedPluginVersion(layout.dataRoot, platform, exists, readFile) ? { installedPluginVersion: installedPluginVersion(layout.dataRoot, platform, exists, readFile) } : {}),
      ...(layout.packageType ? { packageType: layout.packageType } : {}),
      isRunning: Boolean(processInfo),
      ...(processInfo ? { pid: processInfo.pid, launchArgs: parseWindowsCommandLine(processInfo.commandLine).slice(1) } : { launchArgs: [] }),
      source: processInfo ? "running-process" : options.executablePaths?.includes(executablePath) ? "manual-or-explicit" : "discovery",
      compatible,
      ...(compatible ? {} : { reason: version ? `ClassIsland 版本过低，需要 ${MIN_CLASSISLAND_VERSION} 及以上` : "无法确认 ClassIsland 版本，请选择可识别的 ClassIsland.exe" }),
      canonicalExecutablePath: normalizePath(executablePath, platform),
      canonicalDataRoot: normalizePath(layout.dataRoot, platform)
    };
    const key = `${candidate.canonicalExecutablePath}\0${candidate.canonicalDataRoot}`;
    const previous = candidates.get(key);
    if (!previous || (!previous.isRunning && candidate.isRunning)) candidates.set(key, candidate);
  }
  return [...candidates.values()].map(({ canonicalExecutablePath: _executable, canonicalDataRoot: _data, ...candidate }) => candidate);
}

async function downloadLatestClassIslandPlugin(fetcher: Fetcher, now: () => number, onProgress?: (phase: ClassIslandInstallPhase, message?: string) => void): Promise<{ bytes: Buffer; version: string; sha256: string }> {
  onProgress?.("downloading", "正在通过 ghproxy.sectl.cn 下载最新 ClassIsland 插件");
  let release: { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown } | undefined;
  let lastError: unknown;
  for (const directUrl of [CLASSISLAND_RELEASE_API_URL]) {
    for (const candidate of marketplaceRequestUrls(`${directUrl}?secagent_cache=${now()}`)) {
      try {
        const response = await fetcher(candidate, { signal: AbortSignal.timeout(12_000), headers: { Accept: "application/vnd.github+json", "User-Agent": "SecAgent" } });
        if (!response.ok) { lastError = new Error(`HTTP ${response.status}`); continue; }
        const payload = await response.json() as typeof release;
        if (!payload || typeof payload.tag_name !== "string" || payload.draft === true || payload.prerelease === true || !Array.isArray(payload.assets)) throw new Error("GitHub 最新 Release 信息无效");
        release = payload;
        break;
      } catch (error) { lastError = error; }
    }
  }
  if (!release) {
    const pageRelease = await fetchReleasePageMetadata(fetcher, now);
    if (pageRelease) release = pageRelease;
  }
  if (!release) throw new Error(`无法读取 ClassIsland 最新 Release：${lastError instanceof Error ? lastError.message : String(lastError)}`);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find((item: unknown) => {
    if (!item || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    return record.name === CLASSISLAND_PLUGIN_ASSET_NAME && typeof record.browser_download_url === "string";
  }) as Record<string, unknown> | undefined;
  if (!asset) throw new Error(`最新 ClassIsland Release 缺少 ${CLASSISLAND_PLUGIN_ASSET_NAME}`);
  const size = typeof asset.size === "number" ? asset.size : 0;
  if (size > MAX_CLASSISLAND_PLUGIN_BYTES) throw new Error("ClassIsland 插件包过大，已停止安装");
  const digest = typeof asset.digest === "string" ? asset.digest.replace(/^sha256:/i, "") : "";
  if (!/^[a-f0-9]{64}$/i.test(digest)) throw new Error("ClassIsland Release 缺少有效的 SHA-256 校验值");
  const downloadUrl = asset.browser_download_url as string;
  for (const candidate of marketplaceRequestUrls(downloadUrl)) {
    try {
      const response = await fetcher(candidate, { signal: AbortSignal.timeout(60_000), headers: { "User-Agent": "SecAgent" } });
      if (!response.ok) { lastError = new Error(`HTTP ${response.status}`); continue; }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_CLASSISLAND_PLUGIN_BYTES) { lastError = new Error("ClassIsland 插件包过大"); continue; }
      onProgress?.("verifying", "正在校验 ClassIsland 插件 SHA-256");
      const actual = crypto.createHash("sha256").update(bytes).digest("hex");
      if (actual.toLowerCase() !== digest.toLowerCase()) { lastError = new Error("ClassIsland 插件 SHA-256 校验失败"); continue; }
      return { bytes, version: typeof release.tag_name === "string" ? release.tag_name : "unknown", sha256: actual };
    } catch (error) { lastError = error; }
  }
  throw new Error(`下载 ClassIsland 插件失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
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

export class ClassIslandInstaller {
  private candidates = new Map<string, ClassIslandInstallCandidate>();
  private readonly platform: SupportedPlatform;
  private readonly fetcher: Fetcher;
  private readonly commandRunner: CommandRunner;
  private readonly options: ClassIslandInstallerOptions;

  constructor(options: ClassIslandInstallerOptions = {}) {
    this.options = options;
    this.platform = options.platform || process.platform;
    this.fetcher = options.fetcher || fetch;
    this.commandRunner = options.commandRunner || defaultCommandRunner;
  }

  async detect(): Promise<ClassIslandInstallCandidate[]> {
    const discovered = await discoverClassIslandInstallations({ ...this.options, commandRunner: this.commandRunner, platform: this.platform, executablePaths: [...(this.options.executablePaths || []), ...[...this.candidates.values()].map((candidate) => candidate.executablePath)] });
    this.candidates = new Map(discovered.map((candidate) => [candidate.id, candidate]));
    return discovered;
  }

  async inspect(executablePath: string): Promise<ClassIslandInstallCandidate | undefined> {
    const discovered = await discoverClassIslandInstallations({ ...this.options, commandRunner: this.commandRunner, platform: this.platform, executablePaths: [executablePath] });
    const candidate = discovered[0];
    if (candidate) this.candidates.set(candidate.id, candidate);
    return candidate;
  }

  async install(targetIds: string[], onProgress?: (progress: ClassIslandInstallProgress) => void): Promise<ClassIslandInstallResult[]> {
    const latestCandidates = await this.detect();
    const selected = latestCandidates.filter((candidate) => targetIds.includes(candidate.id));
    const missing = targetIds.filter((id) => !selected.some((candidate) => candidate.id === id)).map((targetId) => ({ targetId, ok: false, action: "failed" as const, message: "找不到 ClassIsland 安装目标，请重新检测" }));
    if (!selected.length) return missing;
    const invalid = selected.filter((candidate) => !candidate.compatible);
    const valid = selected.filter((candidate) => candidate.compatible);
    const results: ClassIslandInstallResult[] = invalid.map((candidate) => ({ targetId: candidate.id, ok: false, action: "skipped", message: candidate.reason || "ClassIsland 版本不兼容" }));
    if (!valid.length) return [...results, ...missing];

    const report = (phase: ClassIslandInstallPhase, message?: string) => onProgress?.({ phase, targetIds, ...(message ? { message } : {}) });
    const log = (stage: string, data: unknown = {}) => this.options.log?.(`companion.classisland.${stage}`, data);
    log("install.begin", { targetIds, candidates: selected.map((candidate) => ({ id: candidate.id, executablePath: candidate.executablePath, dataRoot: candidate.dataRoot, pluginPackagesPath: candidate.pluginPackagesPath, version: candidate.version, installedPluginVersion: candidate.installedPluginVersion, isRunning: candidate.isRunning, pid: candidate.pid })) });
    const packageData = await downloadLatestClassIslandPlugin(this.fetcher, this.options.now || Date.now, (phase, message) => report(phase, message));
    log("download.success", { version: packageData.version, bytes: packageData.bytes.length, sha256: packageData.sha256 });
    const api = platformPath(this.platform);
    const groups = new Map<string, ClassIslandInstallCandidate[]>();
    for (const candidate of valid) {
      const key = normalizePath(candidate.dataRoot, this.platform);
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
      log("group.begin", { dataRoot: group[0].dataRoot, targets: group.map((candidate) => candidate.id), pluginPackagesPath: group[0].pluginPackagesPath });
      const alreadyInstalled = group.every((candidate) => candidate.installedPluginVersion && compareClassIslandVersions(candidate.installedPluginVersion, packageData.version) >= 0);
      if (alreadyInstalled) {
        for (const candidate of group) results.push({ targetId: candidate.id, ok: true, action: "already-installed", message: `已安装 ClassIsland 插件 v${packageData.version}`, version: packageData.version });
        continue;
      }
      const running = group.filter((candidate) => candidate.isRunning && candidate.pid !== undefined);
      const closed: ClassIslandInstallCandidate[] = [];
      let closeFailed = false;
      for (const candidate of running) {
        let exited = false;
        try {
          await requestClose(candidate.pid!);
          exited = await waitForProcessExit(candidate.pid!, isRunning, this.options.waitForExitTimeoutMs, this.options.waitForExitPollMs);
        } catch { /* Fall through to the force-terminate path. */ }
        if (!exited) {
          report("restarting", `ClassIsland 未能优雅退出，正在强制结束进程 ${candidate.pid}`);
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
        for (const candidate of group) results.push({ targetId: candidate.id, ok: false, action: "failed", message: "ClassIsland 无法退出，强制结束也失败，未安装插件；请手动关闭后重试" });
        continue;
      }
      const packagePath = api.join(group[0].pluginPackagesPath, CLASSISLAND_PLUGIN_ASSET_NAME);
      try {
        report("installing", "正在写入 ClassIsland 插件包");
        const actualPackagePath = await writePackage(packagePath, packageData.bytes);
        log("package.write.result", { requestedPath: packagePath, actualPackagePath });
        const launchCandidate = closed[0] || group[0];
        const restarting = closed.length > 0;
        report("restarting", restarting ? "正在重新启动 ClassIsland" : "正在启动 ClassIsland");
        log("process.restart.begin", { executablePath: launchCandidate.executablePath, args: launchCandidate.launchArgs, wasRunning: restarting });
        let launchFailed = false;
        try { await restart(launchCandidate.executablePath, launchCandidate.launchArgs); log("process.restart.success", { executablePath: launchCandidate.executablePath }); }
        catch (error) { launchFailed = true; log("process.restart.failed", { executablePath: launchCandidate.executablePath, error: error instanceof Error ? error.message : String(error) }); }
        const verifiedVersion = launchFailed ? undefined : await waitForInstalledPlugin(
          () => installedPluginVersion(group[0].dataRoot, this.platform, exists, readFile),
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
              ? `插件包已写入，但 ClassIsland 自动${restarting ? "重启" : "启动"}失败，请手动启动`
              : verified
                ? restarting ? `已安装 ClassIsland 插件 v${verifiedVersion}，ClassIsland 已自动重启` : `已安装 ClassIsland 插件 v${verifiedVersion}，ClassIsland 已自动启动`
                : "插件包已写入并启动，但等待 ClassIsland 解包后未检测到插件，请稍后重试",
            ...(verifiedVersion ? { version: verifiedVersion } : {})
          });
        }
      } catch (error) {
        log("install.failed", { error: error instanceof Error ? error.message : String(error) });
        for (const candidate of closed) await restart(candidate.executablePath, candidate.launchArgs).catch(() => undefined);
        for (const candidate of group) results.push({ targetId: candidate.id, ok: false, action: "failed", message: `写入 ClassIsland 插件失败：${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return [...results, ...missing];
  }
}

export { DEFAULT_MARKETPLACE_PROXY_URL, parseWindowsCommandLine };
