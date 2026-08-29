import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import AdmZip from "adm-zip";

type SupportedPlatform = NodeJS.Platform;
export type CompanionLogger = (stage: string, data?: unknown) => void;
const execFileAsync = promisify(execFile);
let windowsElevationPromise: Promise<boolean | undefined> | undefined;

export interface CompanionExecutor {
  writePackage(filePath: string, bytes: Buffer, logger?: CompanionLogger): Promise<string>;
  installPackage(destinationPath: string, bytes: Buffer, spec: CompanionPackageSpec, logger?: CompanionLogger): Promise<string>;
  requestGracefulClose(pid: number, logger?: CompanionLogger): Promise<boolean>;
  forceTerminate(pid: number, logger?: CompanionLogger): Promise<void>;
  isProcessRunning(pid: number, logger?: CompanionLogger): Promise<boolean>;
  startProcess(executablePath: string, args: string[], logger?: CompanionLogger): Promise<void>;
  /** Lists host processes by executable name or installation root. Optional so
   *  older executors keep working; callers fall back to a direct query. */
  enumerateProcesses?(filter: HostProcessFilter, logger?: CompanionLogger): Promise<HostProcessInfo[]>;
  close(): Promise<void>;
}

export interface HostProcessFilter {
  names: string[];
  roots: string[];
}

export interface HostProcessInfo {
  pid: number;
  name?: string;
  executablePath?: string;
  commandLine?: string;
}

export interface CompanionPackageSpec {
  pluginId: string;
  manifestFileName: string;
}

function writeLog(logger: CompanionLogger | undefined, stage: string, data: unknown = {}): void {
  try { logger?.(stage, data); } catch { /* Logging must never break installation. */ }
}

function pathApi(platform: SupportedPlatform): typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function encodePowerShell(command: string): string {
  return Buffer.from(command, "utf16le").toString("base64");
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function compactProcessError(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const record = error as { message?: unknown; stderr?: unknown };
  const message = typeof record.message === "string" ? record.message : String(error);
  const stderr = typeof record.stderr === "string" ? record.stderr.trim() : "";
  // PowerShell can put a full CLIXML error document in stderr. Keep the useful
  // tail, otherwise the OOBE error banner becomes several screens tall.
  const detail = stderr.replace(/<Objs[\s\S]*?<\/Objs>/gi, "").replace(/\s+/g, " ").trim();
  const safeMessage = message.startsWith("Command failed:") ? "PowerShell 命令执行失败" : message;
  const text = detail && !safeMessage.includes(detail) ? `${safeMessage}: ${detail}` : safeMessage;
  return text.slice(0, 2_000);
}

/**
 * Returns the elevation state of the current Electron process. The result is
 * cached because the token cannot change while this process is running. An
 * unknown result is deliberately kept distinct from false: a restart must
 * never silently downgrade an administrator-launched SecAgent process.
 */
export async function getWindowsProcessElevation(logger?: CompanionLogger): Promise<boolean | undefined> {
  if (process.platform !== "win32") return false;
  if (!windowsElevationPromise) {
    const command = [
      "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
      "$principal = New-Object Security.Principal.WindowsPrincipal($identity)",
      "$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"
    ].join(";\n");
    windowsElevationPromise = execFileAsync("powershell.exe", [
      "-NoProfile", "-NoLogo", "-NonInteractive", "-WindowStyle", "Hidden",
      "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(command)
    ], { encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024 })
      .then((result) => {
        const match = result.stdout.trim().match(/(true|false)\s*$/i);
        if (!match) throw new Error("无法解析当前进程权限状态");
        const elevated = match[1].toLowerCase() === "true";
        writeLog(logger, "process.elevation.detected", { elevated });
        return elevated;
      })
      .catch((error) => {
        writeLog(logger, "process.elevation.failed", { error: compactProcessError(error) });
        return undefined;
      });
  }
  return windowsElevationPromise;
}

export async function isWindowsProcessElevated(logger?: CompanionLogger): Promise<boolean> {
  return (await getWindowsProcessElevation(logger)) === true;
}

function isPathInside(candidate: string, root: string, platform: SupportedPlatform): boolean {
  const api = pathApi(platform);
  const normalizedCandidate = api.normalize(candidate).replace(/[\\/]$/, "").toLowerCase();
  const normalizedRoot = api.normalize(root).replace(/[\\/]$/, "").toLowerCase();
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${api.sep}`);
}

function likelyProtectedWindowsPath(filePath: string): boolean {
  const roots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.WINDIR,
    process.env.SystemRoot
  ].filter((value): value is string => Boolean(value));
  return roots.some((root) => isPathInside(filePath, root, "win32"));
}

function manifestValue(text: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.match(new RegExp(`^\\s*${escaped}\\s*:\\s*["']?([^"'\\r\\n#]+)`, "im"))?.[1]?.trim();
}

function validateCompanionPackage(bytes: Buffer, spec: CompanionPackageSpec): AdmZip {
  if (!spec.pluginId || /[\\/]/.test(spec.pluginId) || spec.pluginId === "." || spec.pluginId === "..")
    throw new Error("插件 ID 无效");
  const zip = new AdmZip(bytes);
  const entries = zip.getEntries();
  if (!entries.length) throw new Error("插件包为空");
  for (const entry of entries) {
    const name = entry.entryName.replaceAll("\\", "/");
    if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").includes(".."))
      throw new Error(`插件包包含不安全路径: ${entry.entryName}`);
  }
  const manifestEntry = zip.getEntry(spec.manifestFileName);
  if (!manifestEntry) throw new Error(`插件包缺少 ${spec.manifestFileName}`);
  const manifestText = manifestEntry.getData().toString("utf8");
  let id: string | undefined;
  let entranceAssembly: string | undefined;
  if (spec.manifestFileName.toLowerCase().endsWith(".json")) {
    const parsed = JSON.parse(manifestText) as Record<string, unknown>;
    const readString = (...keys: string[]) => keys.map((key) => parsed[key]).find((value): value is string => typeof value === "string")?.trim();
    id = readString("Id", "id");
    entranceAssembly = readString("EntranceAssembly", "entranceAssembly");
  } else {
    id = manifestValue(manifestText, "id");
    entranceAssembly = manifestValue(manifestText, "entranceAssembly");
  }
  if (!id || id.toLowerCase() !== spec.pluginId.toLowerCase()) throw new Error(`插件包清单 ID 不匹配: ${id || "缺失"}`);
  if (!entranceAssembly) throw new Error("插件包清单缺少入口程序集");
  const normalizedEntrance = entranceAssembly.replaceAll("\\", "/");
  if (!entries.some((entry) => entry.entryName.replaceAll("\\", "/") === normalizedEntrance))
    throw new Error(`插件包缺少入口程序集: ${entranceAssembly}`);
  return zip;
}

function installDirectPackage(destinationPath: string, bytes: Buffer, spec: CompanionPackageSpec, platform: SupportedPlatform, logger?: CompanionLogger): string {
  const api = pathApi(platform);
  const destination = api.resolve(destinationPath);
  const parent = api.dirname(destination);
  const staging = api.join(parent, `.${api.basename(destination)}.${crypto.randomUUID()}.installing`);
  const backup = api.join(parent, `.${api.basename(destination)}.${crypto.randomUUID()}.backup`);
  const zip = validateCompanionPackage(bytes, spec);
  let movedExisting = false;
  writeLog(logger, "package.install.direct.begin", { destination, pluginId: spec.pluginId, bytes: bytes.length });
  try {
    fs.mkdirSync(parent, { recursive: true });
    zip.extractAllTo(staging, true);
    const disabledPath = api.join(destination, ".disabled");
    const wasDisabled = fs.existsSync(disabledPath);
    if (fs.existsSync(destination)) {
      fs.renameSync(destination, backup);
      movedExisting = true;
    }
    fs.renameSync(staging, destination);
    if (wasDisabled) fs.writeFileSync(api.join(destination, ".disabled"), "", "utf8");
    if (movedExisting) fs.rmSync(backup, { recursive: true, force: true });
    writeLog(logger, "package.install.direct.success", { destination, pluginId: spec.pluginId });
    return destination;
  } catch (error) {
    try {
      if (fs.existsSync(destination) && movedExisting) fs.rmSync(destination, { recursive: true, force: true });
      if (movedExisting && fs.existsSync(backup)) fs.renameSync(backup, destination);
    } catch (restoreError) {
      writeLog(logger, "package.install.direct.restore.failed", { destination, error: restoreError instanceof Error ? restoreError.message : String(restoreError) });
    }
    writeLog(logger, "package.install.direct.failed", { destination, pluginId: spec.pluginId, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    if (movedExisting && fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
  }
}

function writeDirect(filePath: string, bytes: Buffer, platform: SupportedPlatform, logger?: CompanionLogger): string {
  const api = pathApi(platform);
  const directory = api.dirname(filePath);
  writeLog(logger, "package.write.direct.begin", { filePath, bytes: bytes.length });
  fs.mkdirSync(directory, { recursive: true });
  const temporary = api.join(directory, `.${api.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    try {
      fs.rmSync(filePath, { force: true });
      fs.renameSync(temporary, filePath);
      writeLog(logger, "package.write.direct.success", { filePath });
      return filePath;
    } catch (error) {
      // ICC-CE and SecRandom both scan every package with the expected extension.
      // If an older package is still held by an antivirus/plugin process, leave it
      // alone and submit a second package instead of losing the new download.
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (!(["EBUSY", "EPERM", "EACCES"].includes(code))) throw error;
      const extension = api.extname(filePath);
      const fallback = api.join(directory, `${api.basename(filePath, extension)}.${crypto.randomUUID()}${extension}`);
      fs.copyFileSync(temporary, fallback);
      writeLog(logger, "package.write.fallback", { filePath, fallback, errorCode: code });
      return fallback;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * Shared PowerShell body that collects host processes into $matched. A process
 * matches when its executable lives under one of $roots (installation root,
 * including versioned subfolders like ClassIsland's app-2.1.1.1-0), or when its
 * executable path is unreadable and its name equals one of $names. The
 * name-only fallback is what makes elevated host processes visible to a
 * non-elevated SecAgent: Win32_Process hides their ExecutablePath, so a
 * path-based match alone would miss exactly the instances that must be closed
 * before a plugin can be loaded.
 * $roots and $names must be defined by the caller; $matched is the output.
 *
 * PowerShell variables are CASE-INSENSITIVE: `$root` and the worker script's
 * `$Root` parameter are the same variable. Every local here is $enum-prefixed
 * so nothing can clobber the worker's protocol paths — an early alpha shipped
 * a `foreach ($root in $roots)` that silently redirected the worker's request
 * loop into the ClassIsland install directory, leaving every later elevated
 * operation to time out.
 */
const ENUMERATE_PROCESSES_PS = String.raw`
$matched = @()
foreach ($enumProcess in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
  $enumExePath = [string]$enumProcess.ExecutablePath
  $isMatch = $false
  if ($enumExePath) {
    foreach ($enumRoot in $roots) {
      if ($enumExePath.Equals($enumRoot, [System.StringComparison]::OrdinalIgnoreCase) -or $enumExePath.StartsWith($enumRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) { $isMatch = $true; break }
    }
  } else {
    $isMatch = $names -contains ([string]$enumProcess.Name)
  }
  if ($isMatch) {
    $matched += @{ pid = [int]$enumProcess.ProcessId; name = [string]$enumProcess.Name; executablePath = $enumExePath; commandLine = [string]$enumProcess.CommandLine }
  }
}
`;

export const ELEVATED_WORKER_SCRIPT = String.raw`
param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
$readyPath = Join-Path $Root 'ready'
$utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false

function Write-JsonFile([string]$Path, [object]$Value) {
  $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    [System.IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Compress -Depth 8), $utf8)
    [System.IO.File]::Move($temporary, $Path)
  } finally {
    if ([System.IO.File]::Exists($temporary)) { [System.IO.File]::Delete($temporary) }
  }
}

function Write-Result([string]$Id, [object]$Value) {
  Write-JsonFile (Join-Path $Root "result-$Id.json") $Value
}

New-Item -ItemType Directory -Force -Path $Root | Out-Null
[System.IO.File]::WriteAllText($readyPath, [DateTime]::UtcNow.ToString('o'), $utf8)

while ($true) {
  $requests = @(Get-ChildItem -LiteralPath $Root -Filter 'request-*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name)
  foreach ($request in $requests) {
    $id = [System.IO.Path]::GetFileNameWithoutExtension($request.Name).Substring(8)
    $response = $null
    $shutdown = $false
    try {
      $body = Get-Content -LiteralPath $request.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
      switch ([string]$body.action) {
        'write' {
          $source = [string]$body.data.source
          $destination = [string]$body.data.destination
          $directory = [System.IO.Path]::GetDirectoryName($destination)
          if ([string]::IsNullOrWhiteSpace($directory)) { throw '目标目录无效' }
          [System.IO.Directory]::CreateDirectory($directory) | Out-Null
          $staged = [System.IO.Path]::Combine($directory, '.' + [System.IO.Path]::GetFileName($destination) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
          [System.IO.File]::Copy($source, $staged, $true)
          $installed = $false
          for ($attempt = 0; $attempt -lt 20; $attempt++) {
            try {
              if ([System.IO.File]::Exists($destination)) { [System.IO.File]::Delete($destination) }
              [System.IO.File]::Move($staged, $destination)
              $installed = $true
              break
            } catch {
              if ($attempt -eq 19) { break }
              Start-Sleep -Milliseconds (250 + ($attempt * 250))
            }
          }
          if ($installed) {
            $response = @{ ok = $true; actualPath = $destination }
          } else {
            $extension = [System.IO.Path]::GetExtension($destination)
            $fallback = [System.IO.Path]::Combine($directory, [System.IO.Path]::GetFileNameWithoutExtension($destination) + '.' + [guid]::NewGuid().ToString('N') + $extension)
            [System.IO.File]::Copy($source, $fallback, $false)
            $response = @{ ok = $true; actualPath = $fallback; fallback = $true }
          }
          if ([System.IO.File]::Exists($staged)) { [System.IO.File]::Delete($staged) }
        }
        'install-package' {
          Add-Type -AssemblyName System.IO.Compression.FileSystem
          $source = [string]$body.data.source
          $destination = [System.IO.Path]::GetFullPath([string]$body.data.destination)
          $manifestName = [string]$body.data.manifestFileName
          $directory = [System.IO.Path]::GetDirectoryName($destination)
          if ([string]::IsNullOrWhiteSpace($directory)) { throw '目标插件目录无效' }
          [System.IO.Directory]::CreateDirectory($directory) | Out-Null
          $staged = [System.IO.Path]::Combine($directory, '.' + [System.IO.Path]::GetFileName($destination) + '.' + [guid]::NewGuid().ToString('N') + '.installing')
          $backup = [System.IO.Path]::Combine($directory, '.' + [System.IO.Path]::GetFileName($destination) + '.' + [guid]::NewGuid().ToString('N') + '.backup')
          $movedExisting = $false
          try {
            [System.IO.Directory]::CreateDirectory($staged) | Out-Null
            [System.IO.Compression.ZipFile]::ExtractToDirectory($source, $staged)
            $manifestPath = [System.IO.Path]::Combine($staged, $manifestName)
            if (-not [System.IO.File]::Exists($manifestPath)) { throw "插件包缺少 $manifestName" }
            $disabledPath = [System.IO.Path]::Combine($destination, '.disabled')
            $wasDisabled = [System.IO.File]::Exists($disabledPath)
            if ([System.IO.Directory]::Exists($destination)) {
              [System.IO.Directory]::Move($destination, $backup)
              $movedExisting = $true
            } elseif ([System.IO.File]::Exists($destination)) {
              throw '插件目标路径不是目录'
            }
            [System.IO.Directory]::Move($staged, $destination)
            if ($wasDisabled) { [System.IO.File]::WriteAllText([System.IO.Path]::Combine($destination, '.disabled'), '') }
            if ($movedExisting -and [System.IO.Directory]::Exists($backup)) { [System.IO.Directory]::Delete($backup, $true) }
            $response = @{ ok = $true; actualPath = $destination }
          } catch {
            try {
              if ([System.IO.Directory]::Exists($destination) -and $movedExisting) { [System.IO.Directory]::Delete($destination, $true) }
              if ($movedExisting -and [System.IO.Directory]::Exists($backup)) { [System.IO.Directory]::Move($backup, $destination) }
            } catch { }
            throw
          } finally {
            if ([System.IO.Directory]::Exists($staged)) { [System.IO.Directory]::Delete($staged, $true) }
            if ($movedExisting -and [System.IO.Directory]::Exists($backup)) { [System.IO.Directory]::Delete($backup, $true) }
          }
        }
        'close' {
          $process = Get-Process -Id ([int]$body.data.pid) -ErrorAction Stop
          $response = @{ ok = $true; accepted = [bool]$process.CloseMainWindow() }
        }
        'terminate' {
          Stop-Process -Id ([int]$body.data.pid) -Force -ErrorAction Stop
          $response = @{ ok = $true }
        }
        'is-running' {
          $running = $true
          try { Get-Process -Id ([int]$body.data.pid) -ErrorAction Stop | Out-Null } catch { $running = $false }
          $response = @{ ok = $true; running = $running }
        }
        'enumerate' {
          $roots = @($body.data.roots | ForEach-Object { [string]$_ } | Where-Object { $_ })
          $names = @($body.data.names | ForEach-Object { [string]$_ } | Where-Object { $_ })
{{ENUMERATE_PROCESSES_PS}}
          $response = @{ ok = $true; processes = $matched }
        }
        'start' {
          $executablePath = [string]$body.data.executablePath
          $workingDirectory = [System.IO.Path]::GetDirectoryName($executablePath)
          $arguments = @($body.data.args | ForEach-Object { [string]$_ })
          $process = if ($arguments.Count -gt 0) {
            Start-Process -FilePath $executablePath -WorkingDirectory $workingDirectory -ArgumentList $arguments -PassThru -ErrorAction Stop
          } else {
            Start-Process -FilePath $executablePath -WorkingDirectory $workingDirectory -PassThru -ErrorAction Stop
          }
          # GUI applications may take several seconds to replace a launcher
          # process or acquire their single-instance mutex. Do not report a
          # startup failure after the old 250ms probe; wait for either the
          # original process or a same-path replacement to appear.
          $running = $false
          $deadline = [DateTime]::UtcNow.AddSeconds(12)
          while ([DateTime]::UtcNow -lt $deadline) {
            try {
              Get-Process -Id $process.Id -ErrorAction Stop | Out-Null
              $running = $true
              break
            } catch {
              try {
                $samePath = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and ([string]$_.ExecutablePath).Equals($executablePath, [System.StringComparison]::OrdinalIgnoreCase) })
                if ($samePath.Count -gt 0) { $running = $true; break }
              } catch { }
            }
            Start-Sleep -Milliseconds 250
          }
          $response = @{ ok = $true; pid = [int]$process.Id; running = $running }
        }
        'shutdown' {
          $response = @{ ok = $true }
          $shutdown = $true
        }
        default { throw "未知的提权操作: $($body.action)" }
      }
    } catch {
      $response = @{ ok = $false; error = $_.Exception.Message }
    }
    Write-Result $id $response
    Remove-Item -LiteralPath $request.FullName -Force -ErrorAction SilentlyContinue
    if ($shutdown) { exit 0 }
  }
  Start-Sleep -Milliseconds 80
}
`.replace("{{ENUMERATE_PROCESSES_PS}}", () => ENUMERATE_PROCESSES_PS);

/** PowerShell 5.1 reads a BOM-less .ps1 with the system ANSI codepage. On
 *  Western locales the UTF-8 continuation bytes of the Chinese diagnostics
 *  decode to smart quotes (0x91-0x94 are U+2018-U+201D, valid PowerShell
 *  string delimiters) which close the literals early and abort parsing at
 *  startup — the worker never becomes ready. The UTF-8 BOM makes every
 *  locale read the script as UTF-8. */
export function elevatedWorkerScriptFileContents(): string {
  return String.fromCharCode(0xfeff) + ELEVATED_WORKER_SCRIPT;
}

/** Per-action response ceilings. write/install-package retry locked files for
 *  up to ~45s inside the worker and start waits up to 12s for the spawned
 *  process, so they get generous budgets; everything else answers in well
 *  under a second, so a long wait there means the worker loop is gone. */
const WORKER_ACTION_TIMEOUT_MS: Record<string, number> = {
  write: 120_000,
  "install-package": 120_000,
  start: 30_000,
  enumerate: 45_000,
  close: 15_000,
  terminate: 15_000,
  "is-running": 15_000,
  shutdown: 15_000
};
const WORKER_REQUEST_TIMEOUT_DEFAULT_MS = 30_000;

function workerStartCommand(scriptPath: string, root: string): string {
  const scriptArgument = `-NoProfile -NoLogo -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${scriptPath}" -Root "${root}"`;
  return [
    "$ErrorActionPreference = 'Stop'",
    `$arguments = ${quotePowerShell(scriptArgument)}`,
    `$worker = Start-Process -FilePath ${quotePowerShell("powershell.exe")} -Verb RunAs -WindowStyle Hidden -ArgumentList $arguments -PassThru -ErrorAction Stop`,
    "$worker.Id"
  ].join(";\n");
}

export class WindowsCompanionExecutor implements CompanionExecutor {
  private readonly logger?: CompanionLogger;
  private readonly root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-companion-elevated-"));
  private readonly scriptPath: string;
  private workerStarted = false;
  private workerClosed = false;
  /** Latched after one unanswered request: the worker loop is gone, so every
   *  later operation fails instantly instead of stalling for its full
   *  timeout. Cleared only by creating a new executor (one per batch). */
  private workerBroken = false;
  private workerBrokenReason?: string;
  private workerPid?: number;

  constructor(logger?: CompanionLogger) {
    this.logger = logger;
    this.scriptPath = path.join(this.root, "worker.ps1");
    fs.writeFileSync(this.scriptPath, elevatedWorkerScriptFileContents(), { encoding: "utf8", flag: "wx" });
  }

  private log(stage: string, data: unknown = {}): void {
    writeLog(this.logger, `elevated.${stage}`, data);
  }

  private async ensureStarted(): Promise<void> {
    if (this.workerClosed) throw new Error("提权执行器已经关闭");
    if (this.workerStarted) return;
    this.workerStarted = true;
    this.log("start.begin", { root: this.root });
    try {
      const result = await execFileAsync("powershell.exe", [
        "-NoProfile", "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", encodePowerShell(workerStartCommand(this.scriptPath, this.root))
      ], { encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      const pidMatch = result.stdout.match(/(\d+)\s*$/m);
      this.workerPid = pidMatch ? Number(pidMatch[1]) : undefined;
      this.log("start.success", { pid: this.workerPid, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
    } catch (error) {
      const message = compactProcessError(error);
      this.log("start.failed", { error: message });
      throw new Error(`需要管理员权限执行联动插件安装；如果取消 UAC，请重试：${message}`);
    }

    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(path.join(this.root, "ready"))) {
      if (Date.now() >= deadline) {
        this.log("ready.timeout", { pid: this.workerPid });
        throw new Error("管理员权限执行器启动超时，请确认已接受 UAC 并重试");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.log("ready", { pid: this.workerPid });
  }

  private async request(action: string, data: Record<string, unknown> = {}, logger?: CompanionLogger): Promise<Record<string, unknown>> {
    if (this.workerBroken) {
      const error = new Error(`提权执行器已失效（${this.workerBrokenReason}），已跳过 ${action}`);
      writeLog(logger, "elevated.operation.skipped", { action, reason: this.workerBrokenReason });
      throw error;
    }
    await this.ensureStarted();
    const id = crypto.randomUUID();
    const requestPath = path.join(this.root, `request-${id}.json`);
    const resultPath = path.join(this.root, `result-${id}.json`);
    writeLog(logger, "elevated.operation.begin", { action, id, data: action === "write" ? { destination: data.destination, bytes: data.bytes } : data });
    const temporary = `${requestPath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ id, action, data }), { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, requestPath);
    try {
      const timeoutMs = WORKER_ACTION_TIMEOUT_MS[action] ?? WORKER_REQUEST_TIMEOUT_DEFAULT_MS;
      const deadline = Date.now() + timeoutMs;
      while (true) {
        if (fs.existsSync(resultPath)) {
          const response = JSON.parse(fs.readFileSync(resultPath, "utf8")) as Record<string, unknown>;
          fs.rmSync(resultPath, { force: true });
          if (response.ok !== true) throw new Error(typeof response.error === "string" ? response.error : "管理员权限操作失败");
          writeLog(logger, "elevated.operation.success", { action, id, response });
          return response;
        }
        if (Date.now() >= deadline) {
          // One unanswered request means the worker loop is gone (crashed,
          // killed, or watching the wrong directory). Latch it so every later
          // operation fails instantly instead of stalling again.
          this.workerBroken = true;
          this.workerBrokenReason = `操作 ${action} 超时`;
          throw new Error(`管理员权限操作超时：${action}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      const message = compactProcessError(error);
      writeLog(logger, "elevated.operation.failed", { action, id, error: message });
      throw new Error(message);
    } finally {
      fs.rmSync(requestPath, { force: true });
      fs.rmSync(temporary, { force: true });
    }
  }

  async writePackage(filePath: string, bytes: Buffer, logger?: CompanionLogger): Promise<string> {
    const source = path.join(this.root, `package-${crypto.randomUUID()}.bin`);
    fs.writeFileSync(source, bytes, { flag: "wx" });
    try {
      const response = await this.request("write", { source, destination: filePath, bytes: bytes.length }, logger);
      return typeof response.actualPath === "string" ? response.actualPath : filePath;
    } finally {
      fs.rmSync(source, { force: true });
    }
  }

  async installPackage(destinationPath: string, bytes: Buffer, spec: CompanionPackageSpec, logger?: CompanionLogger): Promise<string> {
    const source = path.join(this.root, `package-${crypto.randomUUID()}.zip`);
    fs.writeFileSync(source, bytes, { flag: "wx" });
    try {
      const response = await this.request("install-package", { source, destination: destinationPath, manifestFileName: spec.manifestFileName, pluginId: spec.pluginId }, logger);
      return typeof response.actualPath === "string" ? response.actualPath : destinationPath;
    } finally {
      fs.rmSync(source, { force: true });
    }
  }

  async requestGracefulClose(pid: number, logger?: CompanionLogger): Promise<boolean> {
    const response = await this.request("close", { pid }, logger);
    return response.accepted !== false;
  }

  async forceTerminate(pid: number, logger?: CompanionLogger): Promise<void> {
    await this.request("terminate", { pid }, logger);
  }

  async isProcessRunning(pid: number, logger?: CompanionLogger): Promise<boolean> {
    const response = await this.request("is-running", { pid }, logger);
    return response.running === true;
  }

  async enumerateProcesses(filter: HostProcessFilter, logger?: CompanionLogger): Promise<HostProcessInfo[]> {
    const response = await this.request("enumerate", { names: filter.names, roots: filter.roots }, logger);
    const processes = Array.isArray(response.processes) ? response.processes : [];
    return processes.flatMap((item): HostProcessInfo[] => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      if (typeof record.pid !== "number") return [];
      return [{
        pid: record.pid,
        ...(typeof record.name === "string" && record.name ? { name: record.name } : {}),
        ...(typeof record.executablePath === "string" && record.executablePath ? { executablePath: record.executablePath } : {}),
        ...(typeof record.commandLine === "string" && record.commandLine ? { commandLine: record.commandLine } : {})
      }];
    });
  }

  async startProcess(executablePath: string, args: string[], logger?: CompanionLogger): Promise<void> {
    const response = await this.request("start", { executablePath, args }, logger);
    if (response.running === false) throw new Error("对方软件启动后立即退出，请检查软件本体日志");
  }

  async close(): Promise<void> {
    if (this.workerClosed) return;
    if (this.workerStarted && fs.existsSync(path.join(this.root, "ready"))) {
      try { await this.request("shutdown"); } catch (error) { this.log("stop.failed", { error: compactProcessError(error), pid: this.workerPid }); }
    }
    this.workerClosed = true;
    this.log("stop", { pid: this.workerPid });
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

type ProcessCommandRunner = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

function parseHostProcessList(stdout: string): HostProcessInfo[] {
  if (!stdout.trim()) return [];
  try {
    const raw = JSON.parse(stdout) as unknown;
    const items = Array.isArray(raw) ? raw : [raw];
    return items.flatMap((item): HostProcessInfo[] => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      if (typeof record.pid !== "number") return [];
      return [{
        pid: record.pid,
        ...(typeof record.name === "string" && record.name ? { name: record.name } : {}),
        ...(typeof record.executablePath === "string" && record.executablePath ? { executablePath: record.executablePath } : {}),
        ...(typeof record.commandLine === "string" && record.commandLine ? { commandLine: record.commandLine } : {})
      }];
    });
  } catch {
    return [];
  }
}

/**
 * Lists the processes belonging to a companion installation. Prefers the
 * elevated worker: its admin token can read every process path, while a
 * non-elevated query cannot see the ExecutablePath of an elevated host process
 * — exactly the instances that dodge detection and keep single-instance
 * mutexes held after a restart. The direct fallback still catches pathless
 * processes by name.
 */
export async function enumerateHostProcesses(
  filter: HostProcessFilter,
  platform: SupportedPlatform = process.platform,
  executor?: CompanionExecutor,
  commandRunner?: ProcessCommandRunner,
  logger?: CompanionLogger
): Promise<HostProcessInfo[]> {
  if (platform !== "win32") return [];
  if (executor?.enumerateProcesses) {
    try {
      return await executor.enumerateProcesses(filter, logger);
    } catch (error) {
      writeLog(logger, "process.enumerate.elevated.failed", { ...filter, error: compactProcessError(error) });
    }
  }
  if (!commandRunner) return [];
  const script = [
    `$roots = @(${filter.roots.map(quotePowerShell).join(", ")})`,
    `$names = @(${filter.names.map(quotePowerShell).join(", ")})`,
    ENUMERATE_PROCESSES_PS,
    "$matched | ConvertTo-Json -Compress"
  ].join("\n");
  try {
    const result = await commandRunner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return parseHostProcessList(result.stdout);
  } catch (error) {
    writeLog(logger, "process.enumerate.direct.failed", { ...filter, error: compactProcessError(error) });
    return [];
  }
}

export interface CloseHostProcessesOptions {
  hostLabel: string;
  /** Pids that detection already attached to the installation. */
  initialPids: number[];
  filter: HostProcessFilter;
  platform?: SupportedPlatform;
  /** Process query used for every re-check; injects the elevated worker. */
  listProcesses?: (filter: HostProcessFilter) => Promise<HostProcessInfo[]>;
  isProcessRunning: (pid: number) => Promise<boolean>;
  requestGracefulClose: (pid: number) => Promise<void | boolean>;
  forceTerminate: (pid: number) => Promise<void>;
  gracefulCloseTimeoutMs?: number;
  waitForExitTimeoutMs?: number;
  waitForExitPollMs?: number;
  /** Consecutive empty re-checks required before the host counts as fully
   *  closed. Watchdog-style hosts need a wider window. Default 2. */
  quietChecks?: number;
  /** Delay between re-checks, watching for a watchdog relaunch. Default 750ms. */
  settlePollMs?: number;
  /** Maximum kill rounds; each round closes everything currently found. Default 4. */
  maxRounds?: number;
  onProgress?: (message: string) => void;
  logger?: CompanionLogger;
}

export interface CloseHostProcessesOutcome {
  closedPids: number[];
  remaining: HostProcessInfo[];
  failed: boolean;
  rounds: number;
}

/** ICC-CE runs a watchdog copy of its own executable (`--watchdog <pid> ...`)
 *  that relaunches the main app ~2s after it disappears. */
const HOST_WATCHDOG_MARKER = "--watchdog";

function delayHostClose(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHostProcessExit(pid: number, isRunning: (pid: number) => Promise<boolean>, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isRunning(pid))) return true;
    await delayHostClose(pollMs);
  }
  return !(await isRunning(pid));
}

/**
 * Closes every process belonging to a companion installation, not just the pids
 * detection happened to attach. Detection runs non-elevated, cannot enumerate
 * elevated host processes (their Win32_Process ExecutablePath is null), and for
 * ICC-CE/SecRandom keeps only one pid per candidate — so a detection-pid-only
 * kill list leaves the real application (or its watchdog) alive, holding the
 * single-instance mutex; anything restarted afterwards then blocks on a
 * wait-mutex argument or dies on a singleton check, and the freshly written
 * plugin is never loaded.
 *
 * The loop re-enumerates after every round so watchdog relaunches are killed
 * too, until `quietChecks` consecutive re-checks come back empty. Processes
 * flagged "--watchdog" on their command line are terminated first, before they
 * can undo the round.
 */
export async function closeHostProcesses(options: CloseHostProcessesOptions): Promise<CloseHostProcessesOutcome> {
  const log = (stage: string, data: unknown = {}) => writeLog(options.logger, stage, data);
  const quietChecks = options.quietChecks ?? 2;
  const settlePollMs = options.settlePollMs ?? 750;
  const maxRounds = options.maxRounds ?? 4;
  const gracefulCloseTimeoutMs = options.gracefulCloseTimeoutMs ?? 2_000;
  const waitForExitTimeoutMs = options.waitForExitTimeoutMs ?? 10_000;
  const waitForExitPollMs = options.waitForExitPollMs ?? 250;
  const isWindows = (options.platform || process.platform) === "win32";
  const initialPids = options.initialPids.filter((pid) => Number.isInteger(pid) && pid > 0);

  const enumerate = async (): Promise<HostProcessInfo[]> => {
    if (!isWindows || !options.listProcesses) return [];
    try {
      return await options.listProcesses(options.filter);
    } catch (error) {
      log("process.enumerate.failed", { error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  };
  const isWatchdog = (process: HostProcessInfo) => Boolean(process.commandLine?.includes(HOST_WATCHDOG_MARKER));

  const closeOne = async (pid: number): Promise<boolean> => {
    options.onProgress?.(`正在关闭 ${options.hostLabel}（进程 ${pid}）`);
    log("process.close.begin", { pid });
    let exited = false;
    try {
      const closeAccepted = (await options.requestGracefulClose(pid)) !== false;
      exited = closeAccepted && await waitForHostProcessExit(pid, options.isProcessRunning, gracefulCloseTimeoutMs, waitForExitPollMs);
      log("process.close.result", { pid, accepted: closeAccepted, exited, method: "graceful" });
    } catch (error) {
      log("process.close.failed", { pid, method: "graceful", error: error instanceof Error ? error.message : String(error) });
    }
    if (!exited) {
      options.onProgress?.(`${options.hostLabel} 未能优雅退出，正在强制结束进程 ${pid}`);
      log("process.terminate.begin", { pid });
      try {
        await options.forceTerminate(pid);
        exited = await waitForHostProcessExit(pid, options.isProcessRunning, waitForExitTimeoutMs, waitForExitPollMs);
        log("process.terminate.result", { pid, exited });
      } catch (error) {
        log("process.terminate.failed", { pid, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return exited;
  };

  const enumerated = await enumerate();
  log("process.enumerate.result", { ...options.filter, initialPids, processes: enumerated });

  let known = enumerated;
  let failed = false;
  let quietCount = 0;
  let rounds = 0;
  const closedPids = new Set<number>();
  while (rounds < maxRounds) {
    // Detection pids that enumeration missed stay in the kill list as a safety
    // net; a failing liveness probe must not silently drop them either.
    const targets: HostProcessInfo[] = [...known];
    for (const pid of initialPids) {
      if (targets.some((item) => item.pid === pid)) continue;
      try {
        if (await options.isProcessRunning(pid)) targets.push({ pid });
      } catch {
        targets.push({ pid });
      }
    }
    if (!targets.length) {
      quietCount += 1;
      if (quietCount >= quietChecks) break;
    } else {
      quietCount = 0;
      rounds += 1;
      targets.sort((left, right) => Number(isWatchdog(right)) - Number(isWatchdog(left)));
      log("process.close.round", { round: rounds, targets });
      for (const target of targets) {
        if (await closeOne(target.pid)) closedPids.add(target.pid);
        else { failed = true; break; }
      }
      if (failed) break;
    }
    // Give a surviving watchdog time to fire before the next check, so its
    // relaunch is caught here instead of racing the package write or restart.
    await delayHostClose(settlePollMs);
    known = await enumerate();
    log("process.settle.check", { round: rounds, quietCount, processes: known });
  }

  const remaining = await enumerate();
  if (remaining.length) {
    failed = true;
    log("process.close.incomplete", { remaining, closedPids: [...closedPids] });
  }
  return { closedPids: [...closedPids], remaining, failed, rounds };
}

async function writeWithWindowsUac(filePath: string, bytes: Buffer, logger?: CompanionLogger): Promise<string> {
  writeLog(logger, "package.write.uac.begin", { filePath, bytes: bytes.length });
  const executor = new WindowsCompanionExecutor(logger);
  try {
    const actualPath = await executor.writePackage(filePath, bytes, logger);
    writeLog(logger, "package.write.uac.success", { filePath, actualPath });
    return actualPath;
  } catch (error) {
    const message = compactProcessError(error);
    writeLog(logger, "package.write.uac.failed", { filePath, error: message });
    throw new Error(`需要管理员权限写入对方软件插件目录；如果取消 UAC，请重试：${message}`);
  } finally {
    await executor.close();
  }
}

/**
 * Places a package where a companion host will discover it. Protected Windows
 * installation directories are written through a RunAs helper, which produces
 * the normal UAC prompt. A locked old package is retained and a second package
 * with the same extension is submitted for the host's package scanner.
 */
export async function writeCompanionPackage(filePath: string, bytes: Buffer, platform: SupportedPlatform = process.platform, logger?: CompanionLogger): Promise<string> {
  writeLog(logger, "package.write.begin", { filePath, bytes: bytes.length, platform });
  if (platform === "win32" && likelyProtectedWindowsPath(filePath)) {
    if (await isWindowsProcessElevated(logger)) return writeDirect(filePath, bytes, platform, logger);
    return writeWithWindowsUac(filePath, bytes, logger);
  }

  try {
    return writeDirect(filePath, bytes, platform, logger);
  } catch (error) {
    const errorCode = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    writeLog(logger, "package.write.failed", { filePath, errorCode, error: error instanceof Error ? error.message : String(error) });
    if (platform !== "win32" || !["EACCES", "EPERM"].includes(errorCode))
      throw error;
    if (await isWindowsProcessElevated(logger)) return writeDirect(filePath, bytes, platform, logger);
    return writeWithWindowsUac(filePath, bytes, logger);
  }
}

/**
 * Validates a companion package and installs its extracted contents into the
 * host's final plugin directory. Protected Windows directories use the single
 * already-running elevated worker, so a batch install does not show one UAC
 * prompt per application.
 */
export async function installCompanionPackage(
  destinationPath: string,
  bytes: Buffer,
  spec: CompanionPackageSpec,
  platform: SupportedPlatform = process.platform,
  executor?: CompanionExecutor,
  logger?: CompanionLogger
): Promise<string> {
  // Validate before asking for elevation or touching the existing plugin.
  validateCompanionPackage(bytes, spec);
  writeLog(logger, "package.install.begin", { destinationPath, pluginId: spec.pluginId, manifestFileName: spec.manifestFileName, bytes: bytes.length, platform });
  if (platform === "win32" && likelyProtectedWindowsPath(destinationPath)) {
    if (executor) return executor.installPackage(destinationPath, bytes, spec, logger);
    if (await isWindowsProcessElevated(logger)) return installDirectPackage(destinationPath, bytes, spec, platform, logger);
    const elevated = new WindowsCompanionExecutor(logger);
    try { return await elevated.installPackage(destinationPath, bytes, spec, logger); }
    finally { await elevated.close(); }
  }
  try {
    return installDirectPackage(destinationPath, bytes, spec, platform, logger);
  } catch (error) {
    const errorCode = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (platform === "win32" && ["EACCES", "EPERM"].includes(errorCode)) {
      if (executor) return executor.installPackage(destinationPath, bytes, spec, logger);
      if (await isWindowsProcessElevated(logger)) return installDirectPackage(destinationPath, bytes, spec, platform, logger);
      const elevated = new WindowsCompanionExecutor(logger);
      try { return await elevated.installPackage(destinationPath, bytes, spec, logger); }
      finally { await elevated.close(); }
    }
    throw error;
  }
}

/**
 * Starts a companion host with the same elevation as the current SecAgent
 * process. A normal SecAgent process uses the interactive shell broker so the
 * companion remains a normal user process after the one installer UAC prompt;
 * an administrator-launched SecAgent starts it directly and keeps the admin
 * token. The PowerShell broker is hidden and never creates a console window.
 */
export async function startCompanionProcessWithSameElevation(executablePath: string, args: string[], platform: SupportedPlatform = process.platform, logger?: CompanionLogger): Promise<void> {
  const elevation = platform === "win32" ? await getWindowsProcessElevation(logger) : false;
  const elevated = elevation === true;
  writeLog(logger, "process.start.begin", { executablePath, args, platform, elevated: elevation === undefined ? "unknown" : elevated });
  if (platform === "win32" && elevation === false) {
    // A normal SecAgent process must not elevate the companion or change its
    // user profile. PowerShell is only the hidden COM bridge; no console
    // window is created and no second UAC prompt is shown.
    const workingDirectory = path.win32.dirname(executablePath);
    const argumentList = args.map(quoteWindowsArgument).join(" ");
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "$shell = New-Object -ComObject Shell.Application",
      `$shell.ShellExecute(${quotePowerShell(executablePath)}, ${quotePowerShell(argumentList)}, ${quotePowerShell(workingDirectory)}, 'open', 1)`
    ].join(";\n");
    try {
      await execFileAsync("powershell.exe", ["-NoProfile", "-NoLogo", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(command)], {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024
      });
      writeLog(logger, "process.start.success", { executablePath, args, workingDirectory, elevated: false, launchMode: "interactive-shell" });
      return;
    } catch (error) {
      const message = compactProcessError(error);
      writeLog(logger, "process.start.broker.failed", { executablePath, args, workingDirectory, error: message });
      // A shell broker can be unavailable in a service/session-less context.
      // Fall back to the direct hidden launch so manual installs still work.
    }
  }
  const { spawn } = await import("node:child_process");
  const workingDirectory = platform === "win32" ? path.win32.dirname(executablePath) : path.dirname(executablePath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executablePath, args, {
      cwd: workingDirectory,
      detached: true,
      stdio: "ignore",
      windowsHide: platform === "win32"
    });
    child.once("error", (error) => {
      writeLog(logger, "process.start.failed", { executablePath, args, workingDirectory, elevated: elevation === undefined ? "unknown" : elevated, error: error instanceof Error ? error.message : String(error) });
      reject(error);
    });
    child.once("spawn", () => {
      child.unref();
      writeLog(logger, "process.start.success", { executablePath, args, workingDirectory, elevated: elevation === undefined ? "unknown" : elevated, launchMode: elevated ? "same-process-token" : "direct-fallback", ...(child.pid ? { pid: child.pid } : {}) });
      resolve();
    });
    child.once("exit", (code, signal) => {
      writeLog(logger, "process.exit", { executablePath, args, elevated: elevation === undefined ? "unknown" : elevated, code, signal });
    });
  });
}

/** @deprecated Kept for callers compiled against alpha.10; the implementation now preserves elevation. */
export const startCompanionProcessUnelevated = startCompanionProcessWithSameElevation;

function quoteWindowsArgument(value: string): string {
  if (!value.length) return '""';
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

/** Starts a companion host elevated so it can unpack into a protected install directory. */
export async function startCompanionProcess(executablePath: string, args: string[], platform: SupportedPlatform = process.platform, logger?: CompanionLogger): Promise<void> {
  writeLog(logger, "process.start.begin", { executablePath, args, platform, elevated: platform === "win32" });
  if (platform !== "win32") {
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executablePath, args, { detached: true, stdio: "ignore" });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); writeLog(logger, "process.start.success", { executablePath, pid: child.pid }); resolve(); });
    });
    return;
  }

  const argumentList = args.length ? ` -ArgumentList @(${args.map(quotePowerShell).join(", ")})` : "";
  const workingDirectory = path.win32.dirname(executablePath);
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$process = Start-Process -FilePath ${quotePowerShell(executablePath)} -WorkingDirectory ${quotePowerShell(workingDirectory)}${argumentList} -Verb RunAs -PassThru`,
    "if ($null -eq $process) { throw '无法启动对方软件' }"
  ].join(";\n");
  try {
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(command)], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });
    const pid = result.stdout.match(/(\d+)\s*$/m)?.[1];
    writeLog(logger, "process.start.success", { executablePath, args, workingDirectory, ...(pid ? { pid: Number(pid) } : {}), stdout: result.stdout.trim(), stderr: result.stderr.trim() });
  } catch (error) {
    const message = compactProcessError(error);
    writeLog(logger, "process.start.failed", { executablePath, args, workingDirectory, error: message });
    throw new Error(`需要管理员权限启动对方软件；如果取消 UAC，请重试：${message}`);
  }
}
