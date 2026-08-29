import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compareVersions, describeDownloadAttempt, marketplaceRequestUrls, type DownloadAttemptLogger } from "./marketplace.js";
import { closeHostProcesses, enumerateHostProcesses, installCompanionPackage, startCompanionProcess, startCompanionProcessWithSameElevation, type CompanionExecutor, type CompanionLogger, type CompanionPackageSpec, type HostProcessFilter, type HostProcessInfo } from "./companion-package.js";

export const ICCCE_PLUGIN_REPOSITORY = "SECTL/ICC-CE-SecAgent-Plugin";
export const ICCCE_PLUGIN_ID = "inkcanvas.iccce.secagent";
export const ICCCE_PLUGIN_ASSET_NAME = "inkcanvas.iccce.secagent.icpx";
export const ICCCE_RELEASE_API_URL = `https://api.github.com/repos/${ICCCE_PLUGIN_REPOSITORY}/releases/latest`;
const ICCCE_RELEASE_PAGE_URL = `https://github.com/${ICCCE_PLUGIN_REPOSITORY}/releases/latest`;
const ICCCE_PLUGIN_HEALTH_URL = "http://127.0.0.1:18790/health";

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
  pluginHealthy?: boolean;
  /** ICC-CE has the plugin in its disabled list or auto-disabled it after repeated load failures. */
  pluginDisabled?: boolean;
  pluginDisableReason?: string;
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

export type IccceInstallPhase = "downloading" | "verifying" | "installing" | "closing" | "restarting";
export interface IccceInstallProgress {
  phase: IccceInstallPhase;
  targetIds: string[];
  /** Determinate progress for the companion half (0-100). */
  percent?: number;
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
  fetcher?: Fetcher;
}

export interface IccceInstallerOptions extends IccceDiscoveryOptions {
  fetcher?: Fetcher;
  requestGracefulClose?: (pid: number) => Promise<void | boolean>;
  forceTerminateProcess?: (pid: number) => Promise<void>;
  isProcessRunning?: (pid: number) => Promise<boolean>;
  /** Process query used while closing; defaults to the elevated worker when one
   *  is available, so elevated host instances are visible to the kill list. */
  listProcesses?: (filter: HostProcessFilter) => Promise<HostProcessInfo[]>;
  /** Directory listing used for post-install diagnostics (ICC-CE's own logs).
   *  Reading Program Files needs no elevation, so this stays a plain call. */
  listDir?: (directory: string) => string[];
  restartProcess?: (executablePath: string, args: string[]) => Promise<void>;
  /** Replaces the elevated relaunch taken when the host root is write-protected.
   *  Tests use this to observe the launch without a real elevated worker. */
  restartElevatedProcess?: (executablePath: string, args: string[]) => Promise<void>;
  /** Reports whether the current process may create files under a directory.
   *  Defaults to a real write probe; override in tests. */
  isDirectoryWritable?: (directoryPath: string) => boolean;
  /** Graceful close is only a brief opportunity; force termination follows. */
  gracefulCloseTimeoutMs?: number;
  waitForExitTimeoutMs?: number;
  waitForExitPollMs?: number;
  /** Delay between post-kill re-checks for the watchdog relaunch. */
  closeSettlePollMs?: number;
  waitForPluginTimeoutMs?: number;
  waitForPluginPollMs?: number;
  installPackage?: (destinationPath: string, bytes: Buffer, spec: CompanionPackageSpec) => Promise<string> | string;
  now?: () => number;
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

function defaultListDir(directory: string): string[] {
  try { return fs.readdirSync(directory); } catch { return []; }
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

interface PluginHealthResult {
  healthy: boolean;
  reason: string;
  status?: number;
}

async function probeIcccePluginDetailed(fetcher: Fetcher): Promise<PluginHealthResult> {
  try {
    const response = await fetcher(ICCCE_PLUGIN_HEALTH_URL, { signal: AbortSignal.timeout(1_500), headers: { Accept: "application/json" } });
    if (!response.ok) return { healthy: false, reason: `健康检查返回 HTTP ${response.status}`, status: response.status };
    const payload = await response.json() as { apiVersion?: unknown; name?: unknown; status?: unknown };
    if (payload.apiVersion === 1 && payload.name === "iccce" && payload.status === "ok") return { healthy: true, reason: "ok", status: response.status };
    return { healthy: false, reason: "健康检查返回内容不匹配", status: response.status };
  } catch { return { healthy: false, reason: "健康检查服务未响应" }; }
}

async function probeIcccePlugin(fetcher: Fetcher): Promise<boolean> {
  return (await probeIcccePluginDetailed(fetcher)).healthy;
}

async function waitForIcccePluginHealth(fetcher: Fetcher, timeoutMs = 90_000, pollMs = 250): Promise<PluginHealthResult> {
  const deadline = Date.now() + timeoutMs;
  let last: PluginHealthResult = { healthy: false, reason: "健康检查服务未响应" };
  while (true) {
    last = await probeIcccePluginDetailed(fetcher);
    if (last.healthy) return last;
    if (Date.now() >= deadline) return last;
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
  const runningByName = new Map(running.filter((item) => !/[\\/]/.test(item.executablePath)).map((item) => [api.basename(item.executablePath).toLowerCase(), item]));
  const candidates = new Map<string, CachedCandidate>();
  const versionOf = options.versionOf || ((executablePath: string) => defaultVersionOf(executablePath, platform, commandRunner));
  for (const executablePath of [...new Set(inputPaths.map((item) => api.normalize(item)))].filter((item) => isKnownIccceExecutable(item, platform))) {
    if (!exists(executablePath)) continue;
    const processInfo = runningByPath.get(normalizePath(executablePath, platform)) || runningByName.get(api.basename(executablePath).toLowerCase());
    const version = processInfo?.version || await versionOf(executablePath);
    const layout = resolveIccceLayout(executablePath, { platform, home, env });
    const pluginHealthy = processInfo && options.fetcher ? await probeIcccePlugin(options.fetcher) : undefined;
    const disabledState = readIccePluginDisabledState(layout.packageRoot, platform, exists, readFile);
    const pluginDisabled = Boolean(disabledState.disabledByUser || disabledState.autoDisabled);
    const pluginDisableReason = disabledState.autoDisabled
      ? `ICC-CE 已自动禁用此插件（连续加载失败${disabledState.lastErrorMessage ? `：${disabledState.lastErrorMessage}` : ""}）`
      : disabledState.disabledByUser
        ? "ICC-CE 的插件列表已禁用此插件"
        : undefined;
    const candidate: CachedCandidate = {
      id: hashId(executablePath, layout.packageRoot, platform),
      executablePath,
      rootPath: layout.packageRoot,
      pluginPackagesPath: layout.pluginPackagesPath,
      pluginsPath: layout.pluginsPath,
      ...(version ? { version } : {}),
      ...(installedPluginVersion(layout, platform, exists, readFile) ? { installedPluginVersion: installedPluginVersion(layout, platform, exists, readFile) } : {}),
      ...(pluginHealthy !== undefined ? { pluginHealthy } : {}),
      ...(pluginDisabled ? { pluginDisabled, pluginDisableReason } : {}),
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

interface IccePluginDisabledState {
  disabledByUser?: boolean;
  autoDisabled?: boolean;
  autoDisabledAt?: string;
  lastErrorMessage?: string;
}

/**
 * Reads ICC-CE's own plugin-disable bookkeeping (read-only) so SecAgent can tell
 * "files written but host refuses to load" apart from other failure modes.
 * - <root>\Configs\disabled_plugins.json — JSON array of plugin ids (user or auto disable)
 * - <root>\Configs\plugin_error_recovery.json — array of records with PluginId/AutoDisabled
 */
function readIccePluginDisabledState(rootPath: string, platform: SupportedPlatform, exists: (candidate: string) => boolean, readFile: (filePath: string) => string): IccePluginDisabledState {
  const api = platformPath(platform);
  const state: IccePluginDisabledState = {};
  try {
    const disabledPath = api.join(rootPath, "Configs", "disabled_plugins.json");
    if (exists(disabledPath)) {
      const parsed = JSON.parse(readFile(disabledPath)) as unknown;
      if (Array.isArray(parsed) && parsed.some((item) => typeof item === "string" && item.toLowerCase() === ICCCE_PLUGIN_ID)) state.disabledByUser = true;
    }
  } catch { /* Best effort: unreadable bookkeeping must not break detection. */ }
  try {
    const recoveryPath = api.join(rootPath, "Configs", "plugin_error_recovery.json");
    if (exists(recoveryPath)) {
      const parsed = JSON.parse(readFile(recoveryPath)) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== "object") continue;
          const record = item as Record<string, unknown>;
          const pluginId = typeof record.PluginId === "string" ? record.PluginId : typeof record.pluginId === "string" ? record.pluginId : "";
          if (pluginId.toLowerCase() !== ICCCE_PLUGIN_ID) continue;
          if (record.AutoDisabled === true || record.autoDisabled === true) {
            state.autoDisabled = true;
            if (typeof record.LastErrorMessage === "string" && record.LastErrorMessage) state.lastErrorMessage = record.LastErrorMessage;
            if (typeof record.AutoDisabledAt === "string") state.autoDisabledAt = record.AutoDisabledAt;
          }
        }
      }
    }
  } catch { /* Best effort. */ }
  return state;
}

export interface IcceRecoveryRecordSummary {
  pluginId: string;
  pluginName?: string;
  failures: number;
  autoDisabled: boolean;
  autoDisabledAt?: string;
  firstFailureAt?: string;
  lastFailureAt?: string;
  lastErrorMessage?: string;
  lastStackTrace?: string;
}

export interface IcceHostDiagnostics {
  recovery?: IcceRecoveryRecordSummary;
  hostLog?: { file: string; tail: string };
  pluginLog?: { file: string; tail: string };
}

function newestLogFileName(names: string[]): string | undefined {
  // Rotation keeps `<yyyy-MM-dd>.log` plus `<yyyy-MM-dd>.N.log` backups, so the
  // date prefix makes plain lexicographic order pick the newest day.
  const logs = names.filter((name) => /\.log$/i.test(name));
  return logs.length ? logs.sort((left, right) => right.localeCompare(left))[0] : undefined;
}

function tailLines(content: string, lines: number): string {
  const split = content.trimEnd().split(/\r?\n/);
  return split.slice(Math.max(0, split.length - lines)).join("\n");
}

/**
 * Reads ICC-CE's own account of what happened to our plugin, so a failed health
 * check can quote the real error instead of a bare "服务未响应":
 * - <root>\Configs\plugin_error_recovery.json — the host's load-failure bookkeeping
 * - <root>\PluginLogs\host\<yyyy-MM-dd>.log — "Loading plugin …" / "Failed to load plugin …"
 * - <root>\PluginLogs\<plugin-id>\<yyyy-MM-dd>.log — the plugin's own log; its mere
 *   presence proves the assembly loaded and Initialize ran.
 */
function readIcceHostDiagnostics(rootPath: string, platform: SupportedPlatform, exists: (candidate: string) => boolean, readFile: (filePath: string) => string, listDir: (directory: string) => string[]): IcceHostDiagnostics {
  const api = platformPath(platform);
  const diagnostics: IcceHostDiagnostics = {};
  try {
    const recoveryPath = api.join(rootPath, "Configs", "plugin_error_recovery.json");
    if (exists(recoveryPath)) {
      const parsed = JSON.parse(readFile(recoveryPath)) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== "object") continue;
          const record = item as Record<string, unknown>;
          const pluginId = typeof record.PluginId === "string" ? record.PluginId : typeof record.pluginId === "string" ? record.pluginId : "";
          if (pluginId.toLowerCase() !== ICCCE_PLUGIN_ID) continue;
          diagnostics.recovery = {
            pluginId,
            ...(typeof record.PluginName === "string" && record.PluginName ? { pluginName: record.PluginName } : {}),
            failures: Array.isArray(record.FailureTimestamps) ? record.FailureTimestamps.length : 0,
            autoDisabled: record.AutoDisabled === true || record.autoDisabled === true,
            ...(typeof record.AutoDisabledAt === "string" ? { autoDisabledAt: record.AutoDisabledAt } : {}),
            ...(typeof record.FirstFailureAt === "string" ? { firstFailureAt: record.FirstFailureAt } : {}),
            ...(typeof record.LastFailureAt === "string" ? { lastFailureAt: record.LastFailureAt } : {}),
            ...(typeof record.LastErrorMessage === "string" && record.LastErrorMessage ? { lastErrorMessage: record.LastErrorMessage } : {}),
            ...(typeof record.LastStackTrace === "string" && record.LastStackTrace ? { lastStackTrace: record.LastStackTrace } : {})
          };
          break;
        }
      }
    }
  } catch { /* Best-effort diagnostics. */ }
  const readNewestLogTail = (logDir: string, maxLines: number): { file: string; tail: string } | undefined => {
    try {
      const newest = newestLogFileName(listDir(logDir));
      if (!newest) return undefined;
      const file = api.join(logDir, newest);
      if (!exists(file)) return undefined;
      return { file, tail: tailLines(readFile(file), maxLines) };
    } catch { return undefined; }
  };
  diagnostics.hostLog = readNewestLogTail(api.join(rootPath, "PluginLogs", "host"), 120);
  diagnostics.pluginLog = readNewestLogTail(api.join(rootPath, "PluginLogs", ICCCE_PLUGIN_ID), 60);
  return diagnostics;
}

/** Host log lines start with `[yyyy-MM-dd HH:mm:ss.mmm]` in the host's local time. */
const ICCCE_LOG_TIMESTAMP_PATTERN = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\]/;

function iccceLogLineTimeMs(line: string): number | undefined {
  const match = ICCCE_LOG_TIMESTAMP_PATTERN.exec(line);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const time = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime();
  return Number.isNaN(time) ? undefined : time;
}

/**
 * Distills the diagnostics into a short hint for the OOBE failure message.
 * The plugin's own log outranks the host's bookkeeping: if it exists the plugin
 * did load, and whatever it recorded is the actual reason 18790 is silent.
 * Only lines written after this attempt's restart may be quoted: rotation keeps
 * a full day per file, and yesterday's "ALC is still alive" unload errors say
 * nothing about why a freshly started process never loaded the plugin.
 */
function summarizeIcceHostError(diagnostics: IcceHostDiagnostics, restartStartedAtMs: number): string {
  const isError = (line: string): boolean => /error|fail|失败|异常|incompatible|无法/i.test(line);
  // Stack-trace continuation lines carry no timestamp; keep them instead of
  // over-filtering a real error whose first line holds the only stamp. The
  // cutoff drops to whole seconds because log stamps have no sub-second
  // resolution — a line written right after the restart still lands in it.
  const restartSecondMs = Math.floor(restartStartedAtMs / 1000) * 1000;
  const isFresh = (line: string): boolean => {
    const time = iccceLogLineTimeMs(line);
    return time === undefined || time >= restartSecondMs;
  };
  const freshLines = (tail: string | undefined): string[] => (tail ? tail.split("\n").filter(isFresh) : []);
  const pluginLines = freshLines(diagnostics.pluginLog?.tail);
  const hostLines = freshLines(diagnostics.hostLog?.tail);
  const candidates: string[] = [];
  for (const line of pluginLines.filter(isError).slice(0, 2)) candidates.push(`ICC-CE 插件日志：${line.trim()}`);
  if (diagnostics.recovery?.lastErrorMessage && !diagnostics.recovery.autoDisabled) candidates.push(`ICC-CE 记录的加载错误：${diagnostics.recovery.lastErrorMessage}`);
  for (const line of hostLines.filter((line) => isError(line) && /secagent/i.test(line)).slice(0, 2)) candidates.push(`ICC-CE 宿主日志：${line.trim()}`);
  if (!candidates.length && !pluginLines.length && !hostLines.length) candidates.push("ICC-CE 重启后未写入新的插件日志，可能仍在启动或启动受阻");
  return candidates.join("；").slice(0, 400);
}

/**
 * Probes whether this process may create files inside `directoryPath`. A
 * relaunched ICC-CE needs the same capability under its install root: while
 * loading plugins it creates PluginConfigs/<id>/ and writes
 * PluginLogs/host/<date>.log, and its PluginManager catches the failure and
 * silently drops the plugin (field 2026-08-29: a Program Files install
 * restarted without the admin token showed no plugin in settings, no host log
 * for the day, and no health endpoint). A probe failure here therefore means
 * the host must be relaunched elevated.
 */
function iccceRootIsWritable(rootPath: string): boolean {
  try {
    const probePath = path.win32.join(rootPath, `.secagent-write-probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probePath, "");
    fs.rmSync(probePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes our plugin's stale record from ICC-CE's error-recovery bookkeeping
 * before restarting the host. Every failed load inside 30 minutes counts toward
 * the auto-disable threshold (3), and once tripped the host skips the plugin at
 * every startup until the user resets it manually — so OOBE retries would
 * permanently bury even a fixed plugin version. Only our own entry is dropped;
 * other plugins' records are preserved.
 */
async function resetIccePluginErrorRecovery(rootPath: string, platform: SupportedPlatform, executor: CompanionExecutor | undefined, log: (stage: string, data?: unknown) => void, exists: (candidate: string) => boolean, readFile: (filePath: string) => string): Promise<void> {
  const api = platformPath(platform);
  const recoveryPath = api.join(rootPath, "Configs", "plugin_error_recovery.json");
  try {
    if (!exists(recoveryPath)) return;
    const parsed = JSON.parse(readFile(recoveryPath)) as unknown;
    if (!Array.isArray(parsed)) return;
    const isOurs = (item: unknown): boolean => Boolean(item && typeof item === "object" && typeof (item as Record<string, unknown>).PluginId === "string" && ((item as Record<string, unknown>).PluginId as string).toLowerCase() === ICCCE_PLUGIN_ID);
    const ours = parsed.find(isOurs) as Record<string, unknown> | undefined;
    if (!ours) return;
    log("errorrecovery.reset", {
      path: recoveryPath,
      removedRecord: {
        failures: Array.isArray(ours.FailureTimestamps) ? ours.FailureTimestamps.length : 0,
        autoDisabled: ours.AutoDisabled === true,
        ...(typeof ours.LastErrorMessage === "string" && ours.LastErrorMessage ? { lastErrorMessage: ours.LastErrorMessage } : {})
      }
    });
    if (!executor) {
      log("errorrecovery.reset.skipped", { reason: "无可用的管理员权限执行器，无法清理宿主的插件错误记录" });
      return;
    }
    const remaining = parsed.filter((item) => !isOurs(item));
    await executor.writePackage(recoveryPath, Buffer.from(JSON.stringify(remaining, null, 2), "utf8"), (stage, data) => log(stage, data));
    log("errorrecovery.reset.success", { path: recoveryPath, remainingRecords: remaining.length });
  } catch (error) {
    log("errorrecovery.reset.failed", { path: recoveryPath, error: error instanceof Error ? error.message : String(error) });
  }
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

async function downloadLatestIcccePlugin(fetcher: Fetcher, now: () => number, onProgress?: (phase: IccceInstallPhase, message?: string) => void, onRoute?: DownloadAttemptLogger): Promise<{ bytes: Buffer; version: string; sha256: string }> {
  onProgress?.("downloading", "正在通过 ghproxy.sectl.cn 下载最新 ICC-CE 插件");
  let release: ReleaseMetadata | undefined;
  let lastError: unknown;
  const metadataCandidates = marketplaceRequestUrls(`${ICCCE_RELEASE_API_URL}?secagent_cache=${now()}`);
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
        lastError = new Error("GitHub 最新 Release 信息无效");
        onRoute?.(describeDownloadAttempt("release-metadata", candidate, startedAt, { status: response.status, error: "GitHub 最新 Release 信息无效" }, metadataCandidates.slice(index + 1)));
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
      if (bytes.length > MAX_ICCCE_PLUGIN_BYTES) {
        lastError = new Error("ICC-CE 插件包过大");
        onRoute?.(describeDownloadAttempt("plugin-package", candidate, startedAt, { status: response.status, bytes: bytes.length, error: "ICC-CE 插件包过大" }, packageCandidates.slice(index + 1)));
        continue;
      }
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
        lastError = new Error("ICC-CE 插件包不是有效的 .icpx 压缩包");
        onRoute?.(describeDownloadAttempt("plugin-package", candidate, startedAt, { status: response.status, bytes: bytes.length, error: "ICC-CE 插件包不是有效的 .icpx 压缩包" }, packageCandidates.slice(index + 1)));
        continue;
      }
      onProgress?.("verifying", "正在校验 ICC-CE 插件 SHA-256");
      const actual = crypto.createHash("sha256").update(bytes).digest("hex");
      if (actual.toLowerCase() !== digest.toLowerCase()) {
        lastError = new Error("ICC-CE 插件 SHA-256 校验失败");
        onRoute?.(describeDownloadAttempt("plugin-package", candidate, startedAt, { status: response.status, bytes: bytes.length, sha256: actual, error: `SHA-256 校验失败，期望 ${digest}` }, packageCandidates.slice(index + 1)));
        continue;
      }
      onRoute?.(describeDownloadAttempt("plugin-package", candidate, startedAt, { status: response.status, bytes: bytes.length, sha256: actual }, []));
      return { bytes, version: release.tag_name.replace(/^v/i, ""), sha256: actual };
    } catch (error) {
      lastError = error;
      onRoute?.(describeDownloadAttempt("plugin-package", candidate, startedAt, { error: error instanceof Error ? error.message : String(error) }, packageCandidates.slice(index + 1)));
    }
  }
  throw new Error(`下载 ICC-CE 插件失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
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
    const discovered = await discoverIccceInstallations({ ...this.options, fetcher: this.fetcher, commandRunner: this.commandRunner, platform: this.platform, executablePaths: [...(this.options.executablePaths || []), ...[...this.candidates.values()].map((candidate) => candidate.executablePath)] });
    this.candidates = new Map(discovered.map((candidate) => [candidate.id, candidate]));
    return discovered;
  }

  async inspect(executablePath: string): Promise<IccceInstallCandidate | undefined> {
    const discovered = await discoverIccceInstallations({ ...this.options, fetcher: this.fetcher, commandRunner: this.commandRunner, platform: this.platform, executablePaths: [executablePath] });
    const candidate = discovered[0];
    if (candidate) this.candidates.set(candidate.id, candidate);
    return candidate;
  }

  async install(targetIds: string[], onProgress?: (progress: IccceInstallProgress) => void, executor?: CompanionExecutor): Promise<IccceInstallResult[]> {
    const latestCandidates = await this.detect();
    const selected = latestCandidates.filter((candidate) => targetIds.includes(candidate.id));
    const missing = targetIds.filter((id) => !selected.some((candidate) => candidate.id === id)).map((targetId) => ({ targetId, ok: false, action: "failed" as const, message: "找不到 ICC-CE 安装目标，请重新检测" }));
    if (!selected.length) return missing;
    const valid = selected.filter((candidate) => candidate.compatible);
    const results: IccceInstallResult[] = selected.filter((candidate) => !candidate.compatible).map((candidate) => ({ targetId: candidate.id, ok: false, action: "skipped" as const, message: candidate.reason || "ICC-CE 版本不兼容" }));
    if (!valid.length) return [...results, ...missing];

    const report = (phase: IccceInstallPhase, message?: string, percent?: number) => {
      const phasePercent = percent ?? ({ downloading: 18, verifying: 38, installing: 62, closing: 72, restarting: 80 } as const)[phase];
      onProgress?.({ phase, targetIds, percent: phasePercent, ...(message ? { message } : {}) });
    };
    const log = (stage: string, data: unknown = {}) => this.options.log?.(`companion.iccce.${stage}`, data);
    log("install.begin", { targetIds, candidates: selected.map((candidate) => ({ id: candidate.id, executablePath: candidate.executablePath, rootPath: candidate.rootPath, pluginPackagesPath: candidate.pluginPackagesPath, pluginsPath: candidate.pluginsPath, version: candidate.version, installedPluginVersion: candidate.installedPluginVersion, pluginHealthy: candidate.pluginHealthy, pluginDisabled: candidate.pluginDisabled, pluginDisableReason: candidate.pluginDisableReason, isRunning: candidate.isRunning, pid: candidate.pid })) });
    const packageData = await downloadLatestIcccePlugin(this.fetcher, this.options.now || Date.now, (phase, message) => report(phase, message), (attempt) => log("download.attempt", attempt));
    log("download.success", { version: packageData.version, bytes: packageData.bytes.length, sha256: packageData.sha256, repository: ICCCE_PLUGIN_REPOSITORY, asset: ICCCE_PLUGIN_ASSET_NAME });
    const groups = new Map<string, IccceInstallCandidate[]>();
    for (const candidate of valid) {
      const key = normalizePath(candidate.rootPath, this.platform);
      groups.set(key, [...(groups.get(key) || []), candidate]);
    }
    const restart = this.options.restartProcess || ((executablePath: string, args: string[]) =>
      startCompanionProcessWithSameElevation(executablePath, args, this.platform, (stage, data) => log(stage, data)));
    const restartElevated = this.options.restartElevatedProcess
      || ((executablePath: string, args: string[]) => executor
        ? executor.startProcess(executablePath, args, (stage, data) => log(stage, data))
        : startCompanionProcess(executablePath, args, this.platform, (stage, data) => log(stage, data)));
    const isRunning = this.options.isProcessRunning || ((pid: number) => executor ? executor.isProcessRunning(pid, (stage, data) => log(stage, data)) : defaultIsProcessRunning(pid));
    const requestClose = this.options.requestGracefulClose || ((pid: number) => executor ? executor.requestGracefulClose(pid, (stage, data) => log(stage, data)) : defaultRequestGracefulClose(pid, this.platform, this.commandRunner));
    const forceTerminate = this.options.forceTerminateProcess || ((pid: number) => executor ? executor.forceTerminate(pid, (stage, data) => log(stage, data)) : defaultForceTerminate(pid, this.platform, this.commandRunner));
    const gracefulCloseTimeoutMs = this.options.gracefulCloseTimeoutMs ?? 2_000;
    const exists = this.options.exists || defaultExists;
    const readFile = this.options.readFile || defaultReadFile;
    const listDir = this.options.listDir || defaultListDir;
    const installPackage = this.options.installPackage || ((destinationPath: string, bytes: Buffer, spec: CompanionPackageSpec) =>
      installCompanionPackage(destinationPath, bytes, spec, this.platform, executor, (stage, data) => log(stage, data)));
    for (const group of groups.values()) {
      log("group.begin", { rootPath: group[0].rootPath, targets: group.map((candidate) => candidate.id), pluginPackagesPath: group[0].pluginPackagesPath, pluginsPath: group[0].pluginsPath, pluginDisabled: group.some((candidate) => candidate.pluginDisabled) });
      const alreadyInstalled = group.every((candidate) => candidate.installedPluginVersion
        && (!candidate.isRunning || candidate.pluginHealthy === true)
        && compareVersions(candidate.installedPluginVersion, packageData.version) >= 0);
      if (alreadyInstalled) {
        for (const candidate of group) results.push({ targetId: candidate.id, ok: true, action: "already-installed", message: `已安装 ICC-CE 插件 v${packageData.version}`, version: packageData.version });
        continue;
      }
      // Relaunch the host with the privilege its install root demands, not the
      // privilege SecAgent happens to have. While loading plugins the host
      // creates PluginConfigs/<id>/ and writes PluginLogs/host/<date>.log under
      // its root; under a write-protected install (e.g. Program Files) a host
      // relaunched without the admin token fails both silently — its
      // PluginManager catches the failure and drops the plugin without a word
      // (field 2026-08-29: no plugin in settings, no host log for the day, no
      // health endpoint). The elevated worker that wrote the plugin is still
      // alive at this point, so the elevated route restores the token without
      // a second UAC prompt.
      const rootRequiresElevation = this.platform === "win32"
        && !(this.options.isDirectoryWritable?.(group[0].rootPath) ?? iccceRootIsWritable(group[0].rootPath));
      if (rootRequiresElevation) {
        log("process.restart.elevated", { rootPath: group[0].rootPath, viaExecutor: Boolean(executor) });
      }
      const relaunch = rootRequiresElevation ? restartElevated : restart;
      const pluginPath = platformPath(this.platform).join(group[0].pluginsPath, ICCCE_PLUGIN_ID);
      // Write the plugin BEFORE closing ICC-CE. ICC-CE scans Plugins only once at
      // startup, and its watchdog relaunches the app ~2s after a force kill — so a
      // write that happens between kill and relaunch is missed permanently. Files
      // written up front are found by whichever instance starts next. If the write
      // fails (e.g. currently-loaded plugin files are locked), fall back to the
      // close-then-write order below.
      let preinstalled = false;
      try {
        report("installing", "正在写入 ICC-CE 插件文件");
        const actualPluginPath = await installPackage(pluginPath, packageData.bytes, { pluginId: ICCCE_PLUGIN_ID, manifestFileName: "manifest.json" });
        preinstalled = true;
        log("package.preinstall.result", { requestedPath: pluginPath, actualPluginPath, hostRunning: group.some((candidate) => candidate.isRunning) });
      } catch (error) {
        log("package.preinstall.failed", { requestedPath: pluginPath, error: error instanceof Error ? error.message : String(error) });
      }
      const running = group.filter((candidate) => candidate.isRunning && candidate.pid !== undefined);
      // Close EVERY process under the installation root, not only the single
      // pid detection attached. ICC-CE runs a watchdog copy of its own
      // executable (`--watchdog <pid> <signal>`); it relaunches the main app
      // ~2s after a force kill, which races our own restart on the
      // single-instance mutex. The watchdog must die first, and the post-kill
      // settle window must outlast its relaunch.
      const processFilter: HostProcessFilter = {
        names: WINDOWS_ICCCE_EXECUTABLES,
        roots: [...new Set(group.map((candidate) => candidate.rootPath))]
      };
      const listProcesses = this.options.listProcesses
        ? (filter: HostProcessFilter) => this.options.listProcesses!(filter)
        : (filter: HostProcessFilter) => enumerateHostProcesses(filter, this.platform, executor, this.commandRunner, (stage, data) => log(stage, data));
      const closeOutcome = await closeHostProcesses({
        hostLabel: "ICC-CE",
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
        // The watchdog polls its parent every 2s and relaunches on death;
        // require ~6s of quiet before writing/restarting.
        quietChecks: 4,
        settlePollMs: this.options.closeSettlePollMs ?? 1_500,
        onProgress: (message) => report("closing", message),
        logger: (stage, data) => log(stage, data)
      });
      log("process.close.summary", { closedPids: closeOutcome.closedPids, remaining: closeOutcome.remaining, failed: closeOutcome.failed, rounds: closeOutcome.rounds });
      const closed = running.filter((candidate) => closeOutcome.closedPids.includes(candidate.pid!));
      if (closeOutcome.failed) {
        for (const candidate of closed) await relaunch(candidate.executablePath, candidate.launchArgs).catch(() => undefined);
        for (const candidate of group) results.push({
          targetId: candidate.id,
          ok: false,
          action: "failed",
          message: closeOutcome.remaining.length
            ? `ICC-CE 进程 ${closeOutcome.remaining.map((item) => item.pid).join("、")} 无法退出（可能被看门狗反复拉起），请手动关闭后重试`
            : preinstalled
              ? "插件文件已写入，但 ICC-CE 无法自动退出；请手动重启 ICC-CE 后重新检测"
              : "ICC-CE 无法退出，强制结束也失败，未安装插件；请手动关闭后重试"
        });
        continue;
      }
      try {
        if (!preinstalled) {
          report("installing", "正在解压安装 ICC-CE 插件");
          const actualPluginPath = await installPackage(pluginPath, packageData.bytes, { pluginId: ICCCE_PLUGIN_ID, manifestFileName: "manifest.json" });
          log("package.install.result", { requestedPath: pluginPath, actualPluginPath });
        }
        const launchCandidate = closed[0] || group[0];
        // Clear our plugin's stale load-failure record before the restart: the
        // host auto-disables a plugin after 3 failures in 30 minutes and then
        // never tries to load it again, which would bury this fresh install.
        await resetIccePluginErrorRecovery(group[0].rootPath, this.platform, executor, log, exists, readFile);
        // "重启" vs "启动": the host was running when we started, even if its
        // process died between detection and the close loop.
        const restarting = running.length > 0;
        report("restarting", restarting ? "正在重新启动 ICC-CE" : "正在启动 ICC-CE");
        log("process.restart.begin", { executablePath: launchCandidate.executablePath, args: launchCandidate.launchArgs, wasRunning: restarting });
        let launchFailed = false;
        // Freshness cutoff for the host-log hint below: lines older than this
        // restart describe earlier attempts (often earlier days) and must not
        // be quoted as this failure's cause.
        const restartStartedAtMs = Date.now();
        try { await relaunch(launchCandidate.executablePath, launchCandidate.launchArgs); log("process.restart.success", { executablePath: launchCandidate.executablePath }); }
        catch (error) { launchFailed = true; log("process.restart.failed", { executablePath: launchCandidate.executablePath, error: error instanceof Error ? error.message : String(error) }); }
        if (!launchFailed) report("verifying", "正在等待 ICC-CE 插件响应", 94);
        const installedLayout: ResolvedIccceLayout = {
          packageRoot: group[0].rootPath,
          pluginPackagesPath: group[0].pluginPackagesPath,
          pluginsPath: group[0].pluginsPath,
          ...(group[0].packageType ? { packageType: group[0].packageType } : {})
        };
        // ICC-CE defers plugin loading behind its startup tasks and a slow cold
        // start (JIT + native deps), so allow a longer wait than the shared
        // default. 45s proved too short in the field (2026-08-29: 45s after a
        // restart the host had not even created that day's plugin log yet), so
        // keep polling up to 90s before declaring the plugin not loaded.
        const verifyTimeoutMs = this.options.waitForPluginTimeoutMs ?? 90_000;
        const writtenVersion = installedPluginVersion(installedLayout, this.platform, exists, readFile);
        const verifiedVersion = launchFailed ? undefined : await waitForInstalledPlugin(
          () => installedPluginVersion(installedLayout, this.platform, exists, readFile),
          packageData.version,
          verifyTimeoutMs,
          this.options.waitForPluginPollMs
        );
        const health = launchFailed
          ? { healthy: false, reason: "对方软件未成功启动" }
          : await waitForIcccePluginHealth(this.fetcher, verifyTimeoutMs, this.options.waitForPluginPollMs);
        const pluginHealthy = health.healthy;
        const verified = Boolean(verifiedVersion) && pluginHealthy;
        const detectedVersion = verified ? verifiedVersion : writtenVersion;
        // Diagnostic snapshot: which ICC-CE processes exist after the restart
        // (main app plus its watchdog), proving the watchdog race is closed.
        try {
          const snapshot = await listProcesses(processFilter);
          log("process.post-restart.snapshot", { processes: snapshot });
        } catch { /* Diagnostic only. */ }
        // Re-read ICC-CE's disable bookkeeping after the restart: repeated load
        // failures during earlier attempts may have auto-disabled the plugin.
        const postDisabledState = readIccePluginDisabledState(group[0].rootPath, this.platform, exists, readFile);
        const postDisabled = Boolean(postDisabledState.disabledByUser || postDisabledState.autoDisabled);
        const postDisableHint = postDisabled
          ? `；${postDisabledState.autoDisabled ? "ICC-CE 已自动禁用此插件，请在 ICC-CE 设置的插件页重置" : "ICC-CE 的插件列表已禁用此插件，请在 ICC-CE 设置中启用"}后重试`
          : "";
        // Pull ICC-CE's own logs and error bookkeeping: when the health check
        // fails this is the only place the real load error is recorded.
        const hostDiagnostics = readIcceHostDiagnostics(group[0].rootPath, this.platform, exists, readFile, listDir);
        log("host.diagnostics", { recovery: hostDiagnostics.recovery, hostLog: hostDiagnostics.hostLog, pluginLog: hostDiagnostics.pluginLog });
        const hostErrorHint = verified || launchFailed ? "" : summarizeIcceHostError(hostDiagnostics, restartStartedAtMs);
        const hostErrorHintText = hostErrorHint ? `；${hostErrorHint}` : "";
        log("verification.result", { expectedVersion: packageData.version, writtenVersion, verifiedVersion, detectedVersion, pluginHealthy, healthReason: health.reason, healthStatus: health.status, healthUrl: ICCCE_PLUGIN_HEALTH_URL, verified, launchFailed, pluginDisabled: postDisabled, pluginDisableReason: postDisabledState.lastErrorMessage, hostError: hostErrorHint || undefined });
        for (const candidate of group) {
          results.push({
            targetId: candidate.id,
            ok: !launchFailed && verified,
            action: !launchFailed && verified ? "installed" : "failed",
            message: launchFailed
              ? `插件包已写入，但 ICC-CE 自动${restarting ? "重启" : "启动"}失败，请手动启动`
              : verified
                ? restarting ? `已安装 ICC-CE 插件 v${verifiedVersion}，ICC-CE 已自动重启` : `已安装 ICC-CE 插件 v${verifiedVersion}，ICC-CE 已自动启动`
                : verifiedVersion
                  ? `插件文件已写入，但 ICC-CE 尚未加载插件（${health.reason}${postDisableHint}${hostErrorHintText}），请重试或手动重启 ICC-CE`
                  : `插件已解压并启动，但未检测到 ICC-CE 插件（${health.reason}${postDisableHint}${hostErrorHintText}），请查看诊断日志后重试`,
            ...(verified && detectedVersion ? { version: detectedVersion } : {})
          });
        }
      } catch (error) {
        log("install.failed", { error: error instanceof Error ? error.message : String(error) });
        for (const candidate of closed) await relaunch(candidate.executablePath, candidate.launchArgs).catch(() => undefined);
        for (const candidate of group) results.push({ targetId: candidate.id, ok: false, action: "failed", message: `安装 ICC-CE 插件失败：${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return [...results, ...missing];
  }
}
