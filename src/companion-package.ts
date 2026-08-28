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

export interface CompanionExecutor {
  writePackage(filePath: string, bytes: Buffer, logger?: CompanionLogger): Promise<string>;
  installPackage(destinationPath: string, bytes: Buffer, spec: CompanionPackageSpec, logger?: CompanionLogger): Promise<string>;
  requestGracefulClose(pid: number, logger?: CompanionLogger): Promise<void>;
  forceTerminate(pid: number, logger?: CompanionLogger): Promise<void>;
  isProcessRunning(pid: number, logger?: CompanionLogger): Promise<boolean>;
  startProcess(executablePath: string, args: string[], logger?: CompanionLogger): Promise<void>;
  close(): Promise<void>;
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

const ELEVATED_WORKER_SCRIPT = String.raw`
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
`;

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
  private workerPid?: number;

  constructor(logger?: CompanionLogger) {
    this.logger = logger;
    this.scriptPath = path.join(this.root, "worker.ps1");
    fs.writeFileSync(this.scriptPath, ELEVATED_WORKER_SCRIPT, { encoding: "utf8", flag: "wx" });
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
    await this.ensureStarted();
    const id = crypto.randomUUID();
    const requestPath = path.join(this.root, `request-${id}.json`);
    const resultPath = path.join(this.root, `result-${id}.json`);
    writeLog(logger, "elevated.operation.begin", { action, id, data: action === "write" ? { destination: data.destination, bytes: data.bytes } : data });
    const temporary = `${requestPath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ id, action, data }), { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, requestPath);
    try {
      const deadline = Date.now() + 90_000;
      while (true) {
        if (fs.existsSync(resultPath)) {
          const response = JSON.parse(fs.readFileSync(resultPath, "utf8")) as Record<string, unknown>;
          fs.rmSync(resultPath, { force: true });
          if (response.ok !== true) throw new Error(typeof response.error === "string" ? response.error : "管理员权限操作失败");
          writeLog(logger, "elevated.operation.success", { action, id, response });
          return response;
        }
        if (Date.now() >= deadline) throw new Error(`管理员权限操作超时：${action}`);
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

  async requestGracefulClose(pid: number, logger?: CompanionLogger): Promise<void> {
    await this.request("close", { pid }, logger);
  }

  async forceTerminate(pid: number, logger?: CompanionLogger): Promise<void> {
    await this.request("terminate", { pid }, logger);
  }

  async isProcessRunning(pid: number, logger?: CompanionLogger): Promise<boolean> {
    const response = await this.request("is-running", { pid }, logger);
    return response.running === true;
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
  if (platform === "win32" && likelyProtectedWindowsPath(filePath))
    return writeWithWindowsUac(filePath, bytes, logger);

  try {
    return writeDirect(filePath, bytes, platform, logger);
  } catch (error) {
    const errorCode = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    writeLog(logger, "package.write.failed", { filePath, errorCode, error: error instanceof Error ? error.message : String(error) });
    if (platform !== "win32" || !["EACCES", "EPERM"].includes(errorCode))
      throw error;
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
      const elevated = new WindowsCompanionExecutor(logger);
      try { return await elevated.installPackage(destinationPath, bytes, spec, logger); }
      finally { await elevated.close(); }
    }
    throw error;
  }
}

/**
 * Starts a companion host as the current user without invoking PowerShell or
 * another UAC prompt. The installer may still have used an elevated executor
 * to write the plugin files, but the host itself should keep its normal user
 * context and profile.
 */
export async function startCompanionProcessUnelevated(executablePath: string, args: string[], platform: SupportedPlatform = process.platform, logger?: CompanionLogger): Promise<void> {
  writeLog(logger, "process.start.begin", { executablePath, args, platform, elevated: false });
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
      writeLog(logger, "process.start.failed", { executablePath, args, workingDirectory, elevated: false, error: error instanceof Error ? error.message : String(error) });
      reject(error);
    });
    child.once("spawn", () => {
      child.unref();
      writeLog(logger, "process.start.success", { executablePath, args, workingDirectory, elevated: false, ...(child.pid ? { pid: child.pid } : {}) });
      resolve();
    });
    child.once("exit", (code, signal) => {
      writeLog(logger, "process.exit", { executablePath, args, elevated: false, code, signal });
    });
  });
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
