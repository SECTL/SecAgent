import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compareVersions, describeDownloadAttempt, marketplaceRequestUrls, type DownloadAttemptLogger } from "./marketplace.js";
import { closeHostProcesses, enumerateHostProcesses, installCompanionPackage, startCompanionProcessWithSameElevation, type CompanionExecutor, type CompanionLogger, type CompanionPackageSpec, type HostProcessFilter, type HostProcessInfo } from "./companion-package.js";

export const SECRANDOM_PLUGIN_REPOSITORY = "SECTL/SecRandom-SecAgent-Plugin";
export const SECRANDOM_PLUGIN_ID = "secrandom.secagent";
export const SECRANDOM_PLUGIN_ASSET_NAME = "SecRandom.SecAgentPlugin.srpx";
export const MIN_SECRANDOM_VERSION = "3.0.0-alpha.1";
export const SECRANDOM_PLUGIN_HEALTH_URL = "http://127.0.0.1:3910/api/secagent/v1/students";
// The companion plugin is pinned to a known-good release instead of "latest".
// The released SecRandom v3.0.0-alpha.2 host (master 8f990fd3) removed all
// SecAgent integration and ships no IExternalStudentDrawService, so plugin
// v1.0.1 could not load on it and v1.0.2 bound nothing on 3910. v1.0.3
// restores the loopback transport, draws through the host's IPluginDrawService
// facade, and is compiled against exactly 8f990fd3. Move the pin forward only
// after verifying a newer release still loads on the alpha.2 host.
export const SECRANDOM_PLUGIN_RELEASE_TAG = "v1.0.3";
export const SECRANDOM_RELEASE_API_URL = `https://api.github.com/repos/${SECRANDOM_PLUGIN_REPOSITORY}/releases/tags/${SECRANDOM_PLUGIN_RELEASE_TAG}`;
const SECRANDOM_RELEASE_PAGE_URL = `https://github.com/${SECRANDOM_PLUGIN_REPOSITORY}/releases/tag/${SECRANDOM_PLUGIN_RELEASE_TAG}`;

const SECRANDOM_PLUGIN_VERSION_PATTERN = /^version\s*:\s*["']?([^"'\r\n#]+)["']?/im;
const SECRANDOM_PLUGIN_ID_PATTERN = /^id\s*:\s*["']?([^"'\r\n#]+)["']?/im;
const SECRANDOM_PLUGIN_ENTRANCE_PATTERN = /^entranceAssembly\s*:\s*["']?([^"'\r\n#]+)["']?/im;
const WINDOWS_SECRANDOM_EXE = "SecRandom.Desktop.exe";
const WINDOWS_SECRANDOM_LAUNCHER = "SecRandomLauncher.exe";
const MAX_SECRANDOM_PLUGIN_BYTES = 100 * 1024 * 1024;

type SupportedPlatform = NodeJS.Platform;
type PathApi = typeof path.win32;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
type CommandRunner = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface SecRandomInstallCandidate {
  id: string;
  executablePath: string;
  rootPath: string;
  dataRoot: string;
  pluginPackagesPath: string;
  pluginPackagesPaths?: string[];
  version?: string;
  installedPluginVersion?: string;
  pluginHealthy?: boolean;
  healthReason?: string;
  packageType?: string;
  isRunning: boolean;
  pid?: number;
  launchArgs: string[];
  source: string;
  compatible: boolean;
  reason?: string;
}

export interface SecRandomInstallResult {
  targetId: string;
  ok: boolean;
  action: "installed" | "already-installed" | "skipped" | "failed";
  message: string;
  version?: string;
}

export type SecRandomInstallPhase = "downloading" | "verifying" | "installing" | "closing" | "restarting";
export interface SecRandomInstallProgress {
  phase: SecRandomInstallPhase;
  targetIds: string[];
  /** Determinate progress for the companion half (0-100). */
  percent?: number;
  message?: string;
}

export interface SecRandomRunningProcess {
  executablePath: string;
  pid: number;
  commandLine?: string;
  version?: string;
}

export interface SecRandomDiscoveryOptions {
  platform?: SupportedPlatform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  executablePaths?: string[];
  runningProcesses?: SecRandomRunningProcess[];
  commandRunner?: CommandRunner;
  fetcher?: Fetcher;
  versionOf?: (executablePath: string) => Promise<string | undefined> | string | undefined;
  exists?: (candidate: string) => boolean;
  readFile?: (filePath: string) => string;
}

export interface SecRandomInstallerOptions extends SecRandomDiscoveryOptions {
  fetcher?: Fetcher;
  requestGracefulClose?: (pid: number) => Promise<void | boolean>;
  forceTerminateProcess?: (pid: number) => Promise<void>;
  isProcessRunning?: (pid: number) => Promise<boolean>;
  /** Process query used while closing; defaults to the elevated worker when one
   *  is available, so elevated host instances are visible to the kill list. */
  listProcesses?: (filter: HostProcessFilter) => Promise<HostProcessInfo[]>;
  restartProcess?: (executablePath: string, args: string[]) => Promise<void>;
  /** Graceful close is only a brief opportunity; force termination follows. */
  gracefulCloseTimeoutMs?: number;
  waitForExitTimeoutMs?: number;
  waitForExitPollMs?: number;
  /** Delay between post-kill re-checks for relaunched processes. */
  closeSettlePollMs?: number;
  waitForPluginTimeoutMs?: number;
  waitForPluginPollMs?: number;
  installPackage?: (destinationPath: string, bytes: Buffer, spec: CompanionPackageSpec) => Promise<string> | string;
  now?: () => number;
  log?: CompanionLogger;
}

interface ResolvedSecRandomLayout {
  packageRoot: string;
  dataRoot: string;
  pluginPackagesPath: string;
  pluginPackagesPaths: string[];
  packageType?: string;
}

interface CachedCandidate extends SecRandomInstallCandidate {
  canonicalExecutablePath: string;
  canonicalDataRoot: string;
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
  Where-Object { $_.DisplayName -like '*SecRandom*' } |
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
      if ($shortcut.TargetPath -match '(?i)SecRandom') { $shortcut.TargetPath }
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

async function discoverRunningProcesses(platform: SupportedPlatform, commandRunner: CommandRunner): Promise<SecRandomRunningProcess[]> {
  if (platform !== "win32") return [];
  const script = String.raw`
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -ieq 'SecRandom.Desktop.exe' -or $_.Name -ieq 'secrandom.exe' } |
  ForEach-Object {
    $version = $null
    try { $version = (Get-Item -LiteralPath $_.ExecutablePath).VersionInfo.ProductVersion } catch { }
    [pscustomobject]@{
      executablePath = if ($_.ExecutablePath) { [string]$_.ExecutablePath } else { [string]$_.Name }
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

function localAppData(platform: SupportedPlatform, home: string, env: NodeJS.ProcessEnv, api: PathApi): string {
  if (platform === "win32") return env.LOCALAPPDATA || api.join(home, "AppData", "Local");
  if (platform === "darwin") return api.join(home, "Library", "Application Support");
  return env.XDG_DATA_HOME || api.join(home, ".local", "share");
}

function readPackageMarker(executablePath: string, platform: SupportedPlatform, env: NodeJS.ProcessEnv, exists: (candidate: string) => boolean, readFile: (filePath: string) => string): { packageRoot: string; packageType?: string } {
  const api = platformPath(platform);
  const executableDirectory = api.dirname(executablePath);
  const overrideRoot = env.SECRANDOM_PACKAGE_ROOT?.trim();
  const directories = overrideRoot ? [api.resolve(overrideRoot)] : [executableDirectory, api.dirname(executableDirectory)];
  for (const directory of directories) {
    const markerPath = api.join(directory, "SecRandom.package.json");
    if (!exists(markerPath)) continue;
    try {
      const marker = JSON.parse(readFile(markerPath)) as Record<string, unknown>;
      const packageType = typeof marker.packageKind === "string" ? marker.packageKind : undefined;
      if (packageType === "portable-zip" && directory === executableDirectory) {
        const directoryName = api.basename(directory).toLowerCase();
        return { packageRoot: directoryName.startsWith("app-") ? api.dirname(directory) : directory, packageType };
      }
      return { packageRoot: api.resolve(directory), ...(packageType ? { packageType } : {}) };
    } catch {
      return { packageRoot: api.resolve(directory) };
    }
  }
  const executableDirectoryName = api.basename(executableDirectory).toLowerCase();
  if (executableDirectoryName.startsWith("app-")) return { packageRoot: api.dirname(executableDirectory), packageType: "portable-zip" };
  return { packageRoot: api.resolve(executableDirectory) };
}

export function resolveSecRandomLayout(executablePath: string, options: { platform?: SupportedPlatform; home?: string; env?: NodeJS.ProcessEnv; exists?: (candidate: string) => boolean; readFile?: (filePath: string) => string } = {}): ResolvedSecRandomLayout {
  const platform = options.platform || process.platform;
  const api = platformPath(platform);
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const exists = options.exists || defaultExists;
  const readFile = options.readFile || defaultReadFile;
  const marker = readPackageMarker(executablePath, platform, env, exists, readFile);
  const portable = marker.packageType?.toLowerCase() === "portable-zip";
  const packageDataRoot = api.join(marker.packageRoot, "data");
  const fallbackDataRoot = api.join(localAppData(platform, home, env, api), "SecRandom", "data");
  const packageDataRootWritable = canWriteDirectory(packageDataRoot) || (!exists(packageDataRoot) && canWriteDirectory(marker.packageRoot));
  const dataRoot = portable ? packageDataRoot : packageDataRootWritable ? packageDataRoot : fallbackDataRoot;
  const pluginPackagesPath = api.join(dataRoot, "cache", "plugin-packages");
  const pluginPackagesPaths = [pluginPackagesPath];
  return { packageRoot: marker.packageRoot, dataRoot, pluginPackagesPath, pluginPackagesPaths, ...(marker.packageType ? { packageType: marker.packageType } : {}) };
}

function canWriteDirectory(directory: string): boolean {
  try {
    fs.accessSync(directory, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function installedPluginVersion(dataRoot: string, platform: SupportedPlatform, exists: (candidate: string) => boolean, readFile: (filePath: string) => string): string | undefined {
  const api = platformPath(platform);
  const pluginPath = api.join(dataRoot, "plugins", SECRANDOM_PLUGIN_ID);
  const manifestPath = api.join(pluginPath, "manifest.yml");
  if (!exists(manifestPath)) return undefined;
  if (exists(api.join(pluginPath, ".disabled")) || exists(api.join(pluginPath, ".uninstall"))) return undefined;
  try {
    const manifest = readFile(manifestPath);
    if (SECRANDOM_PLUGIN_ID_PATTERN.exec(manifest)?.[1]?.trim().toLowerCase() !== SECRANDOM_PLUGIN_ID) return undefined;
    const entranceAssembly = SECRANDOM_PLUGIN_ENTRANCE_PATTERN.exec(manifest)?.[1]?.trim();
    if (!entranceAssembly || entranceAssembly.includes("..") || entranceAssembly.includes("/") || entranceAssembly.includes("\\")) return undefined;
    if (!exists(api.join(pluginPath, entranceAssembly))) return undefined;
    return SECRANDOM_PLUGIN_VERSION_PATTERN.exec(manifest)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function isSecRandomPluginReady(candidate: SecRandomInstallCandidate): boolean {
  return Boolean(candidate.installedPluginVersion && (!candidate.isRunning || candidate.pluginHealthy === true));
}

interface SecRandomPluginHealthResult {
  healthy: boolean;
  reason: string;
  status?: number;
}

async function probeSecRandomPluginDetailed(fetcher: Fetcher): Promise<SecRandomPluginHealthResult> {
  try {
    const response = await fetcher(SECRANDOM_PLUGIN_HEALTH_URL, { signal: AbortSignal.timeout(1_500), headers: { Accept: "application/json" } });
    if (!response.ok) return { healthy: false, reason: `SecRandom 插件接口返回 HTTP ${response.status}`, status: response.status };
    const payload = await response.json() as { students?: unknown };
    if (payload && Array.isArray(payload.students)) return { healthy: true, reason: "ok", status: response.status };
    return { healthy: false, reason: "SecRandom 插件接口返回内容不匹配", status: response.status };
  } catch { return { healthy: false, reason: "SecRandom 插件接口未响应" }; }
}

// A slow VM can need well over 15s from restart to a responsive plugin
// interface, and the plugin itself is known-good in that scenario.
async function waitForSecRandomHealth(fetcher: Fetcher, timeoutMs = 45_000, pollMs = 250): Promise<SecRandomPluginHealthResult> {
  const deadline = Date.now() + timeoutMs;
  let last: SecRandomPluginHealthResult = { healthy: false, reason: "SecRandom 插件接口未响应" };
  while (true) {
    last = await probeSecRandomPluginDetailed(fetcher);
    if (last.healthy) return last;
    if (Date.now() >= deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
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

export function isCompatibleSecRandomVersion(version: string | undefined): boolean {
  return Boolean(version && compareVersions(version, MIN_SECRANDOM_VERSION) >= 0);
}

function executableCandidates(input: string, platform: SupportedPlatform): string[] {
  const api = platformPath(platform);
  const normalized = input.trim().replace(/,\d+$/, "").replace(/^"(.*)"$/, "$1");
  if (platform !== "win32") return [normalized];
  if (api.extname(normalized).toLowerCase() === ".exe") {
    const directory = api.dirname(normalized);
    const name = api.basename(normalized).toLowerCase();
    if (name === WINDOWS_SECRANDOM_LAUNCHER.toLowerCase()) {
      const candidates = [api.join(directory, WINDOWS_SECRANDOM_EXE), normalized];
      try {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.toLowerCase().startsWith("app-")) candidates.unshift(api.join(directory, entry.name, WINDOWS_SECRANDOM_EXE));
        }
      } catch { /* The direct candidate is still useful. */ }
      return candidates;
    }
    return [normalized];
  }
  const candidates = [api.join(normalized, WINDOWS_SECRANDOM_EXE), api.join(normalized, WINDOWS_SECRANDOM_LAUNCHER)];
  try {
    for (const entry of fs.readdirSync(normalized, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.toLowerCase().startsWith("app-")) candidates.unshift(api.join(normalized, entry.name, WINDOWS_SECRANDOM_EXE));
    }
  } catch { /* Best effort. */ }
  return candidates;
}

function staticExecutablePaths(platform: SupportedPlatform, home: string, env: NodeJS.ProcessEnv): string[] {
  const api = platformPath(platform);
  if (platform === "darwin") return [api.join("/Applications", "SecRandom.app", "Contents", "MacOS", WINDOWS_SECRANDOM_EXE), api.join(home, "Applications", "SecRandom.app", "Contents", "MacOS", WINDOWS_SECRANDOM_EXE)];
  if (platform !== "win32") return [api.join("/usr", "lib", "secrandom", "SecRandom.Desktop"), api.join(home, "SecRandom", "SecRandom.Desktop")];
  const local = env.LOCALAPPDATA || api.join(home, "AppData", "Local");
  const programFiles = env.PROGRAMFILES || "C:\\Program Files";
  const programFilesX86 = env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const roots = [local, api.join(local, "Programs"), programFiles, programFilesX86, home, api.join(home, "Desktop"), api.join(home, "Downloads")];
  return roots.flatMap((root) => [
    api.join(root, WINDOWS_SECRANDOM_EXE),
    api.join(root, WINDOWS_SECRANDOM_LAUNCHER),
    api.join(root, "SecRandom", WINDOWS_SECRANDOM_EXE),
    api.join(root, "SecRandom", WINDOWS_SECRANDOM_LAUNCHER),
    api.join(root, "SECTL", "SecRandom", WINDOWS_SECRANDOM_EXE),
    api.join(root, "SECTL", "SecRandom", WINDOWS_SECRANDOM_LAUNCHER)
  ]);
}

export async function discoverSecRandomInstallations(options: SecRandomDiscoveryOptions = {}): Promise<SecRandomInstallCandidate[]> {
  const platform = options.platform || process.platform;
  const api = platformPath(platform);
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const exists = options.exists || defaultExists;
  const readFile = options.readFile || defaultReadFile;
  const commandRunner = options.commandRunner || defaultCommandRunner;
  const fetcher = options.fetcher;
  const running = options.runningProcesses || await discoverRunningProcesses(platform, commandRunner);
  const externalPaths = platform === "win32" && !options.executablePaths?.length && !options.runningProcesses ? await discoverWindowsExternalPaths(commandRunner, env) : [];
  const inputPaths = [
    ...staticExecutablePaths(platform, home, env),
    ...(options.executablePaths || []),
    ...externalPaths,
    ...running.map((item) => item.executablePath)
  ].flatMap((item) => executableCandidates(item, platform));
  const candidates = new Map<string, CachedCandidate>();
  const runningByPath = new Map(running.map((item) => [normalizePath(item.executablePath, platform), item]));
  const runningByName = new Map(running.filter((item) => !/[\\/]/.test(item.executablePath)).map((item) => [api.basename(item.executablePath).toLowerCase(), item]));
  const versionOf = options.versionOf || ((executablePath: string) => defaultVersionOf(executablePath, platform, commandRunner));
  for (const executablePath of [...new Set(inputPaths.map((item) => api.normalize(item)))]) {
    if (!exists(executablePath)) continue;
    const processInfo = runningByPath.get(normalizePath(executablePath, platform)) || runningByName.get(api.basename(executablePath).toLowerCase());
    const version = processInfo?.version || await versionOf(executablePath);
    const layout = resolveSecRandomLayout(executablePath, { platform, home, env, exists, readFile });
    const compatible = isCompatibleSecRandomVersion(version);
    const installed = installedPluginVersion(layout.dataRoot, platform, exists, readFile);
    const pluginHealth = processInfo && fetcher ? await probeSecRandomPluginDetailed(fetcher) : undefined;
    const candidate: CachedCandidate = {
      id: hashId(executablePath, layout.dataRoot, platform),
      executablePath,
      rootPath: layout.packageRoot,
      dataRoot: layout.dataRoot,
      pluginPackagesPath: layout.pluginPackagesPath,
      ...(layout.pluginPackagesPaths.length > 1 ? { pluginPackagesPaths: layout.pluginPackagesPaths } : {}),
      ...(version ? { version } : {}),
      ...(installed ? { installedPluginVersion: installed } : {}),
      ...(pluginHealth ? { pluginHealthy: pluginHealth.healthy, healthReason: pluginHealth.reason } : {}),
      ...(layout.packageType ? { packageType: layout.packageType } : {}),
      isRunning: Boolean(processInfo),
      ...(processInfo ? { pid: processInfo.pid, launchArgs: parseWindowsCommandLine(processInfo.commandLine).slice(1) } : { launchArgs: [] }),
      source: processInfo ? "running-process" : options.executablePaths?.includes(executablePath) ? "manual-or-explicit" : "discovery",
      compatible,
      ...(compatible ? {} : { reason: version ? `SecRandom 版本过低，需要 ${MIN_SECRANDOM_VERSION} 及以上` : "无法确认 SecRandom 版本，请选择可识别的 SecRandom.Desktop.exe" }),
      canonicalExecutablePath: normalizePath(executablePath, platform),
      canonicalDataRoot: normalizePath(layout.dataRoot, platform)
    };
    const key = `${candidate.canonicalExecutablePath}\0${candidate.canonicalDataRoot}`;
    const previous = candidates.get(key);
    if (!previous || (!previous.isRunning && candidate.isRunning)) candidates.set(key, candidate);
  }
  return [...candidates.values()].map(({ canonicalExecutablePath: _executable, canonicalDataRoot: _data, ...candidate }) => candidate);
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
    if (!new RegExp(`>${escapeRegExp(SECRANDOM_PLUGIN_ASSET_NAME)}<`, "i").test(block)) continue;
    const href = block.match(/href=["']([^"']+\/releases\/download\/[^"']+)["']/i)?.[1]?.replaceAll("&amp;", "&");
    const digest = block.match(/sha256:([a-f0-9]{64})/i)?.[1];
    if (!href || !digest) continue;
    const browserDownloadUrl = new URL(href, "https://github.com").toString();
    if (new URL(browserDownloadUrl).hostname !== "github.com") continue;
    return { name: SECRANDOM_PLUGIN_ASSET_NAME, browser_download_url: browserDownloadUrl, digest: `sha256:${digest}` };
  }
  return undefined;
}

async function fetchReleasePageMetadata(fetcher: Fetcher, now: () => number): Promise<ReleaseMetadata | undefined> {
  let lastError: unknown;
  for (const pageUrl of marketplaceRequestUrls(`${SECRANDOM_RELEASE_PAGE_URL}?secagent_cache=${now()}`)) {
    try {
      const response = await fetcher(pageUrl, { signal: AbortSignal.timeout(12_000), headers: { Accept: "text/html", "User-Agent": "SecAgent" } });
      if (!response.ok) { lastError = new Error(`HTTP ${response.status}`); continue; }
      const html = await response.text();
      const tag = releaseTagFromPage(response.url, html);
      if (!tag) { lastError = new Error("GitHub Release 页面缺少版本标签"); continue; }
      const expandedUrl = `https://github.com/${SECRANDOM_PLUGIN_REPOSITORY}/releases/expanded_assets/${encodeURIComponent(tag)}?secagent_cache=${now()}`;
      for (const assetsUrl of marketplaceRequestUrls(expandedUrl)) {
        try {
          const assetsResponse = await fetcher(assetsUrl, { signal: AbortSignal.timeout(12_000), headers: { Accept: "text/html", "User-Agent": "SecAgent" } });
          if (!assetsResponse.ok) { lastError = new Error(`HTTP ${assetsResponse.status}`); continue; }
          const asset = releaseAssetFromExpandedPage(await assetsResponse.text());
          if (asset) return { tag_name: tag, assets: [asset] };
          lastError = new Error(`Release 页面缺少 ${SECRANDOM_PLUGIN_ASSET_NAME} 或 SHA-256`);
        } catch (error) { lastError = error; }
      }
    } catch (error) { lastError = error; }
  }
  return undefined;
}

async function downloadLatestSecRandomPlugin(fetcher: Fetcher, now: () => number, onProgress?: (phase: SecRandomInstallPhase, message?: string) => void, onRoute?: DownloadAttemptLogger): Promise<{ bytes: Buffer; version: string; sha256: string }> {
  onProgress?.("downloading", `正在通过 ghproxy.sectl.cn 下载 SecRandom 插件 ${SECRANDOM_PLUGIN_RELEASE_TAG}`);
  let release: ReleaseMetadata | undefined;
  let lastError: unknown;
  const metadataCandidates = marketplaceRequestUrls(`${SECRANDOM_RELEASE_API_URL}?secagent_cache=${now()}`);
  for (let index = 0; index < metadataCandidates.length; index++) {
    const candidate = metadataCandidates[index];
    const startedAt = Date.now();
    try {
      const response = await fetcher(candidate, { signal: AbortSignal.timeout(12_000), headers: { Accept: "application/vnd.github+json", "User-Agent": "SecAgent" } });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        onRoute?.(describeDownloadAttempt("release-metadata", candidate, startedAt, { status: response.status, error: `HTTP ${response.status}` }, metadataCandidates.slice(index + 1)));
        continue;
      }
      const payload = await response.json() as ReleaseMetadata;
      if (!payload || typeof payload.tag_name !== "string" || payload.draft === true || payload.prerelease === true || !Array.isArray(payload.assets)) {
        lastError = new Error(`GitHub Release（${SECRANDOM_PLUGIN_RELEASE_TAG}）信息无效`);
        onRoute?.(describeDownloadAttempt("release-metadata", candidate, startedAt, { status: response.status, error: `GitHub Release（${SECRANDOM_PLUGIN_RELEASE_TAG}）信息无效` }, metadataCandidates.slice(index + 1)));
        continue;
      }
      onRoute?.(describeDownloadAttempt("release-metadata", candidate, startedAt, { status: response.status }, []));
      release = payload;
      break;
    } catch (error) {
      lastError = error;
      onRoute?.(describeDownloadAttempt("release-metadata", candidate, startedAt, { error: error instanceof Error ? error.message : String(error) }, metadataCandidates.slice(index + 1)));
    }
  }
  if (!release) release = await fetchReleasePageMetadata(fetcher, now);
  if (!release) throw new Error(`无法读取 SecRandom Release（${SECRANDOM_PLUGIN_RELEASE_TAG}）：${lastError instanceof Error ? lastError.message : String(lastError)}`);
  const asset = release.assets.find((item) => item.name === SECRANDOM_PLUGIN_ASSET_NAME && typeof item.browser_download_url === "string");
  if (!asset) throw new Error(`SecRandom Release（${SECRANDOM_PLUGIN_RELEASE_TAG}）缺少 ${SECRANDOM_PLUGIN_ASSET_NAME}`);
  const digest = typeof asset.digest === "string" ? asset.digest.replace(/^sha256:/i, "") : "";
  if (!/^[a-f0-9]{64}$/i.test(digest)) throw new Error("SecRandom Release 缺少有效的 SHA-256 校验值");
  if (typeof asset.size === "number" && asset.size > MAX_SECRANDOM_PLUGIN_BYTES) throw new Error("SecRandom 插件包过大，已停止安装");
  try {
    if (new URL(asset.browser_download_url).hostname.toLowerCase() !== "github.com") throw new Error("SecRandom Release 资产地址无效");
  } catch {
    throw new Error("SecRandom Release 资产地址无效");
  }
  const packageCandidates = marketplaceRequestUrls(asset.browser_download_url);
  for (let index = 0; index < packageCandidates.length; index++) {
    const candidate = packageCandidates[index];
    const startedAt = Date.now();
    try {
      const response = await fetcher(candidate, { signal: AbortSignal.timeout(60_000), headers: { "User-Agent": "SecAgent" } });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        onRoute?.(describeDownloadAttempt("plugin-package", candidate, startedAt, { status: response.status, error: `HTTP ${response.status}` }, packageCandidates.slice(index + 1)));
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_SECRANDOM_PLUGIN_BYTES) {
        lastError = new Error("SecRandom 插件包过大");
        onRoute?.(describeDownloadAttempt("plugin-package", candidate, startedAt, { status: response.status, bytes: bytes.length, error: "SecRandom 插件包过大" }, packageCandidates.slice(index + 1)));
        continue;
      }
      onProgress?.("verifying", "正在校验 SecRandom 插件 SHA-256");
      const actual = crypto.createHash("sha256").update(bytes).digest("hex");
      if (actual.toLowerCase() !== digest.toLowerCase()) {
        lastError = new Error("SecRandom 插件 SHA-256 校验失败");
        onRoute?.(describeDownloadAttempt("plugin-package", candidate, startedAt, { status: response.status, bytes: bytes.length, sha256: actual, error: `SHA-256 校验失败，期望 ${digest}` }, packageCandidates.slice(index + 1)));
        continue;
      }
      onRoute?.(describeDownloadAttempt("plugin-package", candidate, startedAt, { status: response.status, bytes: bytes.length, sha256: actual }, []));
      return { bytes, version: release.tag_name, sha256: actual };
    } catch (error) {
      lastError = error;
      onRoute?.(describeDownloadAttempt("plugin-package", candidate, startedAt, { error: error instanceof Error ? error.message : String(error) }, packageCandidates.slice(index + 1)));
    }
  }
  throw new Error(`下载 SecRandom 插件失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function defaultRequestGracefulClose(pid: number, platform: SupportedPlatform, commandRunner: CommandRunner): Promise<boolean> {
  if (platform === "win32") {
    const script = `$process = Get-Process -Id ${pid} -ErrorAction Stop; [bool]$process.CloseMainWindow()`;
    const result = await commandRunner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return result.stdout.trim().toLowerCase() !== "false";
  }
  process.kill(pid, "SIGTERM");
  return true;
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

export class SecRandomInstaller {
  private candidates = new Map<string, SecRandomInstallCandidate>();
  private readonly platform: SupportedPlatform;
  private readonly fetcher: Fetcher;
  private readonly commandRunner: CommandRunner;
  private readonly options: SecRandomInstallerOptions;

  constructor(options: SecRandomInstallerOptions = {}) {
    this.options = options;
    this.platform = options.platform || process.platform;
    this.fetcher = options.fetcher || fetch;
    this.commandRunner = options.commandRunner || defaultCommandRunner;
  }

  async detect(): Promise<SecRandomInstallCandidate[]> {
    const discovered = await discoverSecRandomInstallations({ ...this.options, fetcher: this.fetcher, commandRunner: this.commandRunner, platform: this.platform, executablePaths: [...(this.options.executablePaths || []), ...[...this.candidates.values()].map((candidate) => candidate.executablePath)] });
    this.candidates = new Map(discovered.map((candidate) => [candidate.id, candidate]));
    return discovered;
  }

  async inspect(executablePath: string): Promise<SecRandomInstallCandidate | undefined> {
    const discovered = await discoverSecRandomInstallations({ ...this.options, fetcher: this.fetcher, commandRunner: this.commandRunner, platform: this.platform, executablePaths: [executablePath] });
    const candidate = discovered[0];
    if (candidate) this.candidates.set(candidate.id, candidate);
    return candidate;
  }

  async install(targetIds: string[], onProgress?: (progress: SecRandomInstallProgress) => void, executor?: CompanionExecutor): Promise<SecRandomInstallResult[]> {
    const latestCandidates = await this.detect();
    const selected = latestCandidates.filter((candidate) => targetIds.includes(candidate.id));
    const missing = targetIds.filter((id) => !selected.some((candidate) => candidate.id === id)).map((targetId) => ({ targetId, ok: false, action: "failed" as const, message: "找不到 SecRandom 安装目标，请重新检测" }));
    if (!selected.length) return missing;
    const invalid = selected.filter((candidate) => !candidate.compatible);
    const valid = selected.filter((candidate) => candidate.compatible);
    const results: SecRandomInstallResult[] = invalid.map((candidate) => ({ targetId: candidate.id, ok: false, action: "skipped", message: candidate.reason || "SecRandom 版本不兼容" }));
    if (!valid.length) return [...results, ...missing];

    const report = (phase: SecRandomInstallPhase, message?: string, percent?: number) => {
      const phasePercent = percent ?? ({ downloading: 18, verifying: 38, installing: 62, closing: 72, restarting: 80 } as const)[phase];
      onProgress?.({ phase, targetIds, percent: phasePercent, ...(message ? { message } : {}) });
    };
    const log = (stage: string, data: unknown = {}) => this.options.log?.(`companion.secrandom.${stage}`, data);
    log("install.begin", { targetIds, candidates: selected.map((candidate) => ({ id: candidate.id, executablePath: candidate.executablePath, rootPath: candidate.rootPath, dataRoot: candidate.dataRoot, pluginPackagesPath: candidate.pluginPackagesPath, pluginPackagesPaths: candidate.pluginPackagesPaths, version: candidate.version, installedPluginVersion: candidate.installedPluginVersion, pluginHealthy: candidate.pluginHealthy, healthReason: candidate.healthReason, isRunning: candidate.isRunning, pid: candidate.pid })) });
    const packageData = await downloadLatestSecRandomPlugin(this.fetcher, this.options.now || Date.now, (phase, message) => report(phase, message), (attempt) => log("download.attempt", attempt));
    log("download.success", { version: packageData.version, bytes: packageData.bytes.length, sha256: packageData.sha256, repository: SECRANDOM_PLUGIN_REPOSITORY, asset: SECRANDOM_PLUGIN_ASSET_NAME });
    const api = platformPath(this.platform);
    const groups = new Map<string, SecRandomInstallCandidate[]>();
    for (const candidate of valid) {
      const key = normalizePath(candidate.dataRoot, this.platform);
      groups.set(key, [...(groups.get(key) || []), candidate]);
    }
    const restart = this.options.restartProcess || ((executablePath: string, args: string[]) =>
      startCompanionProcessWithSameElevation(executablePath, args, this.platform, (stage, data) => log(stage, data)));
    const isRunning = this.options.isProcessRunning || ((pid: number) => executor ? executor.isProcessRunning(pid, (stage, data) => log(stage, data)) : defaultIsProcessRunning(pid));
    const requestClose = this.options.requestGracefulClose || ((pid: number) => executor ? executor.requestGracefulClose(pid, (stage, data) => log(stage, data)) : defaultRequestGracefulClose(pid, this.platform, this.commandRunner));
    const forceTerminate = this.options.forceTerminateProcess || ((pid: number) => executor ? executor.forceTerminate(pid, (stage, data) => log(stage, data)) : defaultForceTerminate(pid, this.platform, this.commandRunner));
    const gracefulCloseTimeoutMs = this.options.gracefulCloseTimeoutMs ?? 2_000;
    const exists = this.options.exists || defaultExists;
    const readFile = this.options.readFile || defaultReadFile;
    const installPackage = this.options.installPackage || ((destinationPath: string, bytes: Buffer, spec: CompanionPackageSpec) =>
      installCompanionPackage(destinationPath, bytes, spec, this.platform, executor, (stage, data) => log(stage, data)));
    for (const group of groups.values()) {
      log("group.begin", { dataRoot: group[0].dataRoot, targets: group.map((candidate) => candidate.id), pluginPackagesPaths: group[0].pluginPackagesPaths || [group[0].pluginPackagesPath] });
      const alreadyInstalled = group.every((candidate) => isSecRandomPluginReady(candidate) && compareVersions(candidate.installedPluginVersion!, packageData.version) >= 0);
      if (alreadyInstalled) {
        for (const candidate of group) results.push({ targetId: candidate.id, ok: true, action: "already-installed", message: `已安装 SecRandom 插件 v${packageData.version}`, version: packageData.version });
        continue;
      }
      // Write the plugin BEFORE closing SecRandom (it only scans the plugin
      // directory at startup). If the write fails — typically because the
      // currently-loaded plugin files are locked — fall back to the
      // close-then-write order below.
      const dataRoot = group[0].dataRoot;
      const pluginPath = api.join(dataRoot, "plugins", SECRANDOM_PLUGIN_ID);
      let preinstalled = false;
      try {
        report("installing", "正在写入 SecRandom 插件文件");
        const actualPluginPath = await installPackage(pluginPath, packageData.bytes, { pluginId: SECRANDOM_PLUGIN_ID, manifestFileName: "manifest.yml" });
        preinstalled = true;
        log("package.preinstall.result", { requestedDataRoot: dataRoot, actualPluginPath, hostRunning: group.some((candidate) => candidate.isRunning) });
      } catch (error) {
        log("package.preinstall.failed", { requestedDataRoot: dataRoot, requestedPath: pluginPath, error: error instanceof Error ? error.message : String(error) });
      }
      const running = group.filter((candidate) => candidate.isRunning && candidate.pid !== undefined);
      // Close EVERY process of the installation, not only the single pid
      // detection attached (an elevated SecRandom is invisible to the
      // non-elevated scan and would keep the single-instance lock alive).
      const processFilter: HostProcessFilter = {
        names: [WINDOWS_SECRANDOM_EXE, "SecRandom.exe"],
        roots: [...new Set(group.map((candidate) => api.dirname(candidate.executablePath)))]
      };
      const listProcesses = this.options.listProcesses
        ? (filter: HostProcessFilter) => this.options.listProcesses!(filter)
        : (filter: HostProcessFilter) => enumerateHostProcesses(filter, this.platform, executor, this.commandRunner, (stage, data) => log(stage, data));
      const closeOutcome = await closeHostProcesses({
        hostLabel: "SecRandom",
        initialPids: running.map((candidate) => candidate.pid!),
        filter: processFilter,
        platform: this.platform,
        listProcesses,
        isProcessRunning: isRunning,
        requestGracefulClose: requestClose,
        forceTerminate,
        gracefulCloseTimeoutMs,
        waitForExitTimeoutMs: this.options.waitForExitTimeoutMs,
        waitForExitPollMs: this.options.waitForExitPollMs,
        settlePollMs: this.options.closeSettlePollMs,
        onProgress: (message) => report("closing", message),
        logger: (stage, data) => log(stage, data)
      });
      log("process.close.summary", { closedPids: closeOutcome.closedPids, remaining: closeOutcome.remaining, failed: closeOutcome.failed, rounds: closeOutcome.rounds });
      const closed = running.filter((candidate) => closeOutcome.closedPids.includes(candidate.pid!));
      if (closeOutcome.failed) {
        for (const candidate of closed) await restart(candidate.executablePath, candidate.launchArgs).catch(() => undefined);
        for (const candidate of group) results.push({
          targetId: candidate.id,
          ok: false,
          action: "failed",
          message: closeOutcome.remaining.length
            ? `SecRandom 进程 ${closeOutcome.remaining.map((item) => item.pid).join("、")} 无法退出，请手动关闭后重试`
            : preinstalled
              ? "插件文件已写入，但 SecRandom 无法自动退出；请手动重启 SecRandom 后重新检测"
              : "SecRandom 无法退出，强制结束也失败，未安装插件；请手动关闭后重试"
        });
        continue;
      }
      try {
        if (!preinstalled) {
          report("installing", "正在解压安装 SecRandom 插件");
          const actualPluginPath = await installPackage(pluginPath, packageData.bytes, { pluginId: SECRANDOM_PLUGIN_ID, manifestFileName: "manifest.yml" });
          log("package.install.result", { requestedDataRoot: dataRoot, actualPluginPath, detectedPackageDirectory: group[0].pluginPackagesPath });
        }
        const launchCandidate = closed[0] || group[0];
        // "重启" vs "启动": the host was running when we started, even if its
        // process died between detection and the close loop.
        const restarting = running.length > 0;
        report("restarting", restarting ? "正在重新启动 SecRandom" : "正在启动 SecRandom");
        log("process.restart.begin", { executablePath: launchCandidate.executablePath, args: launchCandidate.launchArgs, wasRunning: restarting });
        let launchFailed = false;
        try { await restart(launchCandidate.executablePath, launchCandidate.launchArgs); log("process.restart.success", { executablePath: launchCandidate.executablePath }); }
        catch (error) { launchFailed = true; log("process.restart.failed", { executablePath: launchCandidate.executablePath, error: error instanceof Error ? error.message : String(error) }); }
        if (!launchFailed) report("verifying", "正在等待 SecRandom 插件响应", 94);
        const writtenVersion = installedPluginVersion(dataRoot, this.platform, exists, readFile);
        const verifiedVersion = launchFailed ? undefined : await waitForInstalledPlugin(
          () => installedPluginVersion(dataRoot, this.platform, exists, readFile),
          packageData.version,
          this.options.waitForPluginTimeoutMs,
          this.options.waitForPluginPollMs
        );
        const health = launchFailed
          ? { healthy: false, reason: "对方软件未成功启动" }
          : await waitForSecRandomHealth(this.fetcher, this.options.waitForPluginTimeoutMs, this.options.waitForPluginPollMs);
        const pluginHealthy = health.healthy;
        const verified = Boolean(verifiedVersion) && pluginHealthy;
        const detectedVersion = verified ? verifiedVersion : writtenVersion;
        // Diagnostic snapshot: which SecRandom processes exist after the restart.
        try {
          const snapshot = await listProcesses(processFilter);
          log("process.post-restart.snapshot", { processes: snapshot });
        } catch { /* Diagnostic only. */ }
        log("verification.result", { expectedVersion: packageData.version, writtenVersion, verifiedVersion, detectedVersion, pluginHealthy, healthReason: health.reason, healthStatus: health.status, healthUrl: SECRANDOM_PLUGIN_HEALTH_URL, verified, launchFailed });
        for (const candidate of group) {
          results.push({
            targetId: candidate.id,
            ok: !launchFailed && verified,
            action: !launchFailed && verified ? "installed" : "failed",
            message: launchFailed
              ? `插件包已写入，但 SecRandom 自动${restarting ? "重启" : "启动"}失败，请手动启动`
              : verified
                ? restarting ? `已安装 SecRandom 插件 v${verifiedVersion}，SecRandom 已自动重启` : `已安装 SecRandom 插件 v${verifiedVersion}，SecRandom 已自动启动`
                : verifiedVersion
                  ? `插件文件已写入，但 SecRandom 尚未加载插件（${health.reason}），可重试或手动重启 SecRandom`
                  : `插件已解压并启动，但未检测到 SecRandom 插件（${health.reason}），请查看诊断日志后重试`,
            ...(detectedVersion ? { version: detectedVersion } : {})
          });
        }
      } catch (error) {
        log("install.failed", { error: error instanceof Error ? error.message : String(error) });
        for (const candidate of closed) await restart(candidate.executablePath, candidate.launchArgs).catch(() => undefined);
        for (const candidate of group) results.push({ targetId: candidate.id, ok: false, action: "failed", message: `安装 SecRandom 插件失败：${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return [...results, ...missing];
  }
}
