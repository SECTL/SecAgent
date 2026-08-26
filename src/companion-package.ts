import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

type SupportedPlatform = NodeJS.Platform;
const execFileAsync = promisify(execFile);

function pathApi(platform: SupportedPlatform): typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function encodePowerShell(command: string): string {
  return Buffer.from(command, "utf16le").toString("base64");
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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

function writeDirect(filePath: string, bytes: Buffer, platform: SupportedPlatform): string {
  const api = pathApi(platform);
  const directory = api.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = api.join(directory, `.${api.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    try {
      fs.rmSync(filePath, { force: true });
      fs.renameSync(temporary, filePath);
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
      return fallback;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function writeWithWindowsUac(filePath: string, bytes: Buffer): Promise<string> {
  const api = path.win32;
  const directory = api.dirname(filePath);
  const source = path.join(os.tmpdir(), `secagent-companion-${crypto.randomUUID()}.bin`);
  fs.writeFileSync(source, bytes, { flag: "wx" });

  const innerCommand = [
    "$ErrorActionPreference = 'Stop'",
    `$source = ${quotePowerShell(source)}`,
    `$directory = ${quotePowerShell(directory)}`,
    `$destination = ${quotePowerShell(filePath)}`,
    "[System.IO.Directory]::CreateDirectory($directory) | Out-Null",
    "$staged = [System.IO.Path]::Combine($directory, '.' + [System.IO.Path]::GetFileName($destination) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')",
    "[System.IO.File]::Copy($source, $staged, $true)",
    "$installed = $false",
    "for ($attempt = 0; $attempt -lt 12; $attempt++) {",
    "  try {",
    "    if ([System.IO.File]::Exists($destination)) { [System.IO.File]::Delete($destination) }",
    "    [System.IO.File]::Move($staged, $destination)",
    "    Write-Output $destination",
    "    $installed = $true",
    "    break",
    "  } catch { Start-Sleep -Milliseconds (250 + ($attempt * 250)) }",
    "}",
    "if (-not $installed) {",
    "  $extension = [System.IO.Path]::GetExtension($destination)",
    "  $fallback = [System.IO.Path]::Combine($directory, [System.IO.Path]::GetFileNameWithoutExtension($destination) + '.' + [guid]::NewGuid().ToString('N') + $extension)",
    "  [System.IO.File]::Copy($source, $fallback, $false)",
    "  Write-Output $fallback",
    "}",
    "if ([System.IO.File]::Exists($staged)) { [System.IO.File]::Delete($staged) }"
  ].join(";\n");
  const innerEncoded = encodePowerShell(innerCommand);
  const outerCommand = [
    "$ErrorActionPreference = 'Stop'",
    `$child = Start-Process -FilePath ${quotePowerShell("powershell.exe")} -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ${quotePowerShell(innerEncoded)})`,
    "if ($child.ExitCode -ne 0) { exit $child.ExitCode }"
  ].join(";\n");

  try {
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(outerCommand)], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });
    const output = result.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
    return output || filePath;
  } catch (error) {
    throw new Error(`需要管理员权限写入对方软件插件目录；如果取消 UAC，请重试（${error instanceof Error ? error.message : String(error)}）`);
  } finally {
    fs.rmSync(source, { force: true });
  }
}

/**
 * Places a package where a companion host will discover it. Protected Windows
 * installation directories are written through a RunAs helper, which produces
 * the normal UAC prompt. A locked old package is retained and a second package
 * with the same extension is submitted for the host's package scanner.
 */
export async function writeCompanionPackage(filePath: string, bytes: Buffer, platform: SupportedPlatform = process.platform): Promise<string> {
  if (platform === "win32" && likelyProtectedWindowsPath(filePath))
    return writeWithWindowsUac(filePath, bytes);

  try {
    return writeDirect(filePath, bytes, platform);
  } catch (error) {
    if (platform !== "win32" || !["EACCES", "EPERM"].includes(error && typeof error === "object" && "code" in error ? String(error.code) : ""))
      throw error;
    return writeWithWindowsUac(filePath, bytes);
  }
}

/** Starts a companion host elevated so it can unpack into a protected install directory. */
export async function startCompanionProcess(executablePath: string, args: string[], platform: SupportedPlatform = process.platform): Promise<void> {
  if (platform !== "win32") {
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executablePath, args, { detached: true, stdio: "ignore" });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    });
    return;
  }

  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$process = Start-Process -FilePath ${quotePowerShell(executablePath)} -ArgumentList @(${args.map(quotePowerShell).join(", ")}) -Verb RunAs -PassThru`,
    "if ($null -eq $process) { throw '无法启动对方软件' }"
  ].join(";\n");
  try {
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(command)], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });
  } catch (error) {
    throw new Error(`需要管理员权限启动对方软件；如果取消 UAC，请重试（${error instanceof Error ? error.message : String(error)}）`);
  }
}
