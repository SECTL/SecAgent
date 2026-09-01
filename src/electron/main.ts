import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, Notification, screen, session, shell, Tray } from "electron";
import * as Sentry from "@sentry/electron/main";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { isIPv4 } from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_WORKSPACE } from "../paths.js";
import { configuredModels, configPath, DEFAULT_TELEMETRY_SETTINGS, initializeWorkspace, isOnboardingComplete, loadConfig, markOnboardingComplete, OFFICIAL_VISION_MODEL, readOobeProgress, readSettings, resolveVisionAgentConfig, saveOobeProgress, saveSettings, useConfiguredModel, writeWorkspaceEnv, type OobeProgress, type SettingsPayload } from "../config.js";
import { loadEnabledSkills } from "../skills.js";
import { AuditStore } from "../audit.js";
import { SecAgentRuntime, type TraceEvent } from "../runtime.js";
import type { ConversationMessage } from "../model-provider.js";
import { SessionStore, type AssistantActivity, type SessionData, type ToolCallRecord } from "../session-store.js";
import { cancelSpeech, sendSpeechAudio, sendVoiceWakeAudio, startSpeech, startVoiceWake, stopSpeech, stopVoiceWake } from "./speech.js";
import type { ChatAttachment, ReasoningEffort, UpdateState } from "../types.js";
import { listGoogleModels } from "../google-models.js";
import { synthesizeSpeech } from "./tts.js";
import { PluginManager, type SvgPreviewRequest } from "../plugin-manager.js";
import { MarketplaceClient, type MarketplaceVersion } from "../marketplace.js";
import { detectCompanionApps } from "../companion-apps.js";
import { ClassIslandInstaller } from "../classisland.js";
import { SecRandomInstaller } from "../secrandom.js";
import { IccceInstaller } from "../iccce.js";
import { ClassWidgetsInstaller } from "../classwidgets.js";
import { getWindowsProcessElevation, WindowsCompanionExecutor } from "../companion-package.js";
import { SecAgentHttpServer } from "../secagent-http.js";
import { Models } from "@opencode-ai/models";
import { DEFAULT_WAKE_HOTKEY, normalizeWakeHotkey } from "../wake-hotkey.js";
import { generateSessionTitle } from "../session-title.js";
import { normalizeReasoningEffort } from "../reasoning.js";
import { WindowsUpdateManager } from "./update-manager.js";
import { diagnosticLogDirectory, exportDiagnosticLogs } from "./diagnostic-logs.js";
import { TelemetryClient, hashIdentifier, normalizeMessage, sanitizeStack, type TelemetryFailure } from "../telemetry.js";

const SENTRY_DSN = process.env.SENTRY_DSN?.trim() || "";
function readInitialTelemetryEnabled(): boolean {
  if (!fs.existsSync(configPath(DEFAULT_WORKSPACE))) return DEFAULT_TELEMETRY_SETTINGS.enabled;
  try { return readSettings(DEFAULT_WORKSPACE).telemetry.enabled; }
  catch { return false; }
}

// Fail closed for an existing opt-out and avoid starting Sentry's native
// minidump/session integrations until the user has opted in.
let sentryTelemetryEnabled = readInitialTelemetryEnabled();
let sentryInitialized = false;
function initializeSentry(): void {
  if (!SENTRY_DSN || !sentryTelemetryEnabled || sentryInitialized) return;
  Sentry.init({
    dsn: SENTRY_DSN,
    sendDefaultPii: false,
    integrations: (defaults) => defaults.filter((integration) => integration.name !== "MainProcessSession"),
    beforeSend: (event) => {
      if (!sentryTelemetryEnabled) return null;
      if (event.request) {
        delete event.request.headers;
        delete event.request.cookies;
        delete event.request.data;
        delete event.request.query_string;
        if (event.request.url) event.request.url = event.request.url.replace(/[?&](?:token|key|code|state)=[^&]*/gi, "");
      }
      delete event.user;
      delete event.extra;
      delete event.breadcrumbs;
      if (event.message) event.message = normalizeMessage(event.message);
      if (event.transaction) event.transaction = normalizeMessage(event.transaction);
      for (const exception of event.exception?.values || []) {
        if (exception.value) exception.value = normalizeMessage(exception.value);
        if (exception.stacktrace?.frames) for (const frame of exception.stacktrace.frames) {
          if (frame.filename) frame.filename = frame.filename.replace(/[A-Za-z]:\\[^ )]+/g, "<path>");
        }
      }
      return event;
    }
  });
  sentryInitialized = true;
}
initializeSentry();

let windowRef: BrowserWindow | undefined;
let settingsWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let isQuitting = false;
let onboardingCompletionRequested = false;
let wakeWindow: BrowserWindow | undefined;
let voiceWakeWindow: BrowserWindow | undefined;
let pluginManager: PluginManager | undefined;
let secAgentHttpServer: SecAgentHttpServer | undefined;
let updateManager: WindowsUpdateManager | undefined;
let activeWakeShortcut: string | undefined;
let activeWakeContext: { sessionId?: string; modelId?: string; reasoningEffort?: ReasoningEffort } = {};
let wakeAbortController: AbortController | undefined;
const marketplace = new MarketplaceClient();
const classIslandInstaller = new ClassIslandInstaller({ log: logMain });
const secRandomInstaller = new SecRandomInstaller({ log: logMain });
const iccceInstaller = new IccceInstaller({ log: logMain });
const classWidgetsInstaller = new ClassWidgetsInstaller({ log: logMain });
const activeSessionRuns = new Map<string, AbortController>();
// Plugin updates hot-swap as soon as they download, but the poll itself only
// reads the signed index (one request), so a 10-minute cadence stays friendly
// to the shared proxy.
const MARKETPLACE_UPDATE_INTERVAL_MS = 10 * 60 * 1000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const AUTO_START_ARG = "--autostart";
const AUTO_START_ARGS = [AUTO_START_ARG];
const execFileAsync = promisify(execFile);
let marketplaceUpdateTimer: NodeJS.Timeout | undefined;
let updateCheckTimer: NodeJS.Timeout | undefined;
let telemetry: TelemetryClient | undefined;

function captureSafeException(error: unknown): Error {
  const source = error instanceof Error ? error : new Error(String(error));
  const safe = new Error(normalizeMessage(source.message));
  safe.name = source.name.slice(0, 120);
  if (source.stack) safe.stack = sanitizeStack(source.stack);
  return safe;
}

function recordTelemetryFailure(failure: TelemetryFailure): void {
  telemetry?.recordFailure(failure);
  if (SENTRY_DSN && telemetry?.isEnabled()) Sentry.captureException(captureSafeException(failure.error || failure.type));
}

function isAutostartLaunch(): boolean {
  return process.argv.includes(AUTO_START_ARG);
}

const LINUX_AUTOSTART_DESKTOP_FILE = "secagent-autostart.desktop";

function autostartExecutablePath(): string {
  // Inside an AppImage, process.execPath is the transient /tmp/.mount_* mount;
  // APPIMAGE points at the durable file the user actually launched.
  if (process.platform === "linux" && process.env.APPIMAGE) return process.env.APPIMAGE;
  return process.execPath;
}

function linuxAutostartFilePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "autostart", LINUX_AUTOSTART_DESKTOP_FILE);
}

function readAutostart(): boolean {
  try {
    if (process.platform === "linux") return fs.existsSync(linuxAutostartFilePath());
    // Elevated autostart is a scheduled task; the plain fallback is the
    // HKCU Run key (also what the installer writes on first install).
    if (windowsAutostartTaskExists()) return true;
    const loginItem = app.getLoginItemSettings({ path: autostartExecutablePath(), args: AUTO_START_ARGS });
    // executableWillLaunchAtLogin also recognizes entries created by older
    // installers that did not include the current argument list.
    return loginItem.openAtLogin || loginItem.executableWillLaunchAtLogin;
  } catch (error) {
    logMain("autostart.read.failed", { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

const WINDOWS_AUTOSTART_TASK_NAME = "SecAgent Autostart";
const AUTOSTART_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

function runSchtasks(args: string[]): { status: number; stdout: string } {
  const result = spawnSync("schtasks.exe", args, { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  return { status: result.status ?? -1, stdout: `${result.stdout || ""}` };
}

function windowsAutostartTaskExists(): boolean {
  // status 1 = task does not exist; anything else (or a throw) is treated as
  // "unknown" and reported as absent so settings show the fallback state.
  return runSchtasks(["/Query", "/TN", WINDOWS_AUTOSTART_TASK_NAME]).status === 0;
}

function createElevatedAutostartTask(): boolean {
  // /RL HIGHEST launches SecAgent with the admin token, so later in-app
  // updates inherit it and never trigger another UAC.
  const create = runSchtasks(["/Create", "/TN", WINDOWS_AUTOSTART_TASK_NAME, "/TR", `"${autostartExecutablePath()} ${AUTO_START_ARG}"`, "/SC", "ONLOGON", "/RL", "HIGHEST", "/F"]);
  if (create.status === 0) return true;
  logMain("autostart.task.create.failed", { status: create.status, stdout: create.stdout.slice(0, 300) });
  return false;
}

function removeAutostartTask(): void {
  runSchtasks(["/Delete", "/TN", WINDOWS_AUTOSTART_TASK_NAME, "/F"]);
}

/** Runs one schtasks command inside an elevated PowerShell (one UAC prompt).
 *  Returns false when the user declines the prompt or the command fails. */
async function runSchtasksElevated(args: string[]): Promise<boolean> {
  const quoted = args.map((a) => (a.includes(" ") || a.includes('"') ? `'${a.replaceAll("'", "''").replaceAll('"', '`"')}'` : a)).join(" ");
  const script = `Start-Process -FilePath schtasks.exe -ArgumentList '${quoted.replaceAll("'", "''")}' -Verb RunAs -Wait -WindowStyle Hidden -PassThru | ForEach-Object { exit $_.ExitCode }`;
  try {
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
    return true;
  } catch (error) {
    logMain("autostart.elevated.failed", { error: error instanceof Error ? error.message : String(error), args: args[0] });
    return false;
  }
}

function writeAutostart(enabled: boolean): void {
  if (process.platform === "linux") {
    // Write the XDG autostart entry directly: Electron's Linux login-item
    // helper records process.execPath, which is a transient path for AppImages.
    const entry = linuxAutostartFilePath();
    if (!enabled) { fs.rmSync(entry, { force: true }); return; }
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, `[Desktop Entry]\nType=Application\nName=SecAgent\nExec=${JSON.stringify(autostartExecutablePath())} ${AUTO_START_ARG}\nTerminal=false\n`, "utf8");
    return;
  }
  if (!enabled) {
    logMain("autostart.disable.begin", { taskExists: windowsAutostartTaskExists() });
    removeAutostartTask();
    // also clear the plain fallback / installer-written Run key
    app.setLoginItemSettings({ openAtLogin: false, path: autostartExecutablePath(), args: AUTO_START_ARGS });
    logMain("autostart.disable.done", { taskExists: windowsAutostartTaskExists() });
    return;
  }
  const autostartTaskArgs = ["/Create", "/TN", WINDOWS_AUTOSTART_TASK_NAME, "/TR", `"${autostartExecutablePath()} ${AUTO_START_ARG}"`, "/SC", "ONLOGON", "/RL", "HIGHEST", "/F"];
  logMain("autostart.enable.begin", { elevated: getWindowsProcessElevationSync(), exe: autostartExecutablePath() });
  const create = runSchtasks(autostartTaskArgs);
  if (create.status === 0 && windowsAutostartTaskExists()) {
    logMain("autostart.task.created.direct");
    // task in place; make sure no stale Run-key entry also starts the app
    app.setLoginItemSettings({ openAtLogin: false, path: autostartExecutablePath(), args: AUTO_START_ARGS });
    return;
  }
  logMain("autostart.task.create.failed", { status: create.status, stdout: create.stdout.slice(0, 300) });
  // Could not create the task directly (non-elevated): try once via UAC, and
  // fall back to a plain Run-key autostart when the user declines.
  void (async () => {
    const elevated = await runSchtasksElevated(autostartTaskArgs);
    if (elevated && windowsAutostartTaskExists()) {
      logMain("autostart.task.created.elevated");
      app.setLoginItemSettings({ openAtLogin: false, path: autostartExecutablePath(), args: AUTO_START_ARGS });
      return;
    }
    logMain("autostart.elevated.declined", { elevatedRan: elevated });
    app.setLoginItemSettings({ openAtLogin: true, path: autostartExecutablePath(), args: AUTO_START_ARGS });
    logMain("autostart.fallback.runkey");
  })();
}

/** Sync elevation probe (registry read, no spawn). reg.exe exits 0 for
 *  admins (HKU\S-1-5-20 is admin-readable) and 1 for standard users. */
function getWindowsProcessElevationSync(): boolean {
  if (process.platform !== "win32") return false;
  try {
    const probe = spawnSync("reg.exe", ["Query", "HKU\\S-1-5-20"], { windowsHide: true, timeout: 5_000 });
    return (probe.status ?? 1) === 0;
  } catch {
    return false;
  }
}

function launchWindowsInstaller(installerPath: string): void {
  if (process.platform !== "win32") throw new Error("更新安装仅支持 Windows");
  // /FORCECLOSEAPPLICATIONS is essential: without it a still-running SecAgent
  // (e.g. the user reopening the app while the elevated setup waits at UAC)
  // makes Restart Manager's RmShutdown fail, and the suppressed prompt in
  // very-silent mode answers with its default (Abort) - the installer exits
  // silently having installed nothing. Force the close, and let Restart
  // Manager bring the app back when the files are in place.
  const child = spawn(installerPath, ["/SP-", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS", "/FORCECLOSEAPPLICATIONS", "/RESTARTAPPLICATIONS"], { detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", (error) => {
    logMain("updates.install.process.failed", { error: error.message, path: installerPath });
    recordTelemetryFailure({ type: "update.failed", error, context: { phase: "launch" } });
  });
  child.unref();
}

async function updateInstalledPlugins(): Promise<void> {
  if (!pluginManager) return;
  try {
    const { updates, errors } = await marketplace.installUpdates(pluginManager);
    if (updates.length) logMain("marketplace.plugins.updated", { updates });
    else logMain("marketplace.plugins.checked", { updated: 0 });
    if (errors.length) logMain("marketplace.plugins.update.errors", { errors });
  } catch (error) {
    logMain("marketplace.plugins.update.failed", { error: error instanceof Error ? error.message : String(error) });
    recordTelemetryFailure({ type: "plugin.start.failed", error, context: { phase: "marketplace-update" } });
  }
}

function appIconPath(): string {
  const bundledIcon = path.join(__dirname, "../renderer/icon.png");
  return fs.existsSync(bundledIcon) ? bundledIcon : path.join(process.cwd(), "src/renderer/public/icon.png");
}

function installFileRendererAssetFallback(): void {
  const publicAssets = new Set(["icon.svg", "icon.png", "session-chevron.svg", "image-icon.svg", "mic-icon.svg", "classisland-icon.png", "cw-icon.png", "secrandom-logo.png", "SecScore.png", "iccce-logo.png"]);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["file:///*"] }, (details, callback) => {
    try {
      const requestedPath = new URL(details.url).pathname;
      const assetName = path.basename(requestedPath);
      if (!publicAssets.has(assetName)) return callback({});
      if (requestedPath !== `/${assetName}`) return callback({});
      const assetPath = path.join(__dirname, "../renderer", assetName);
      if (fs.existsSync(assetPath)) return callback({ redirectURL: pathToFileURL(assetPath).href });
    } catch { /* Let Chromium report the original request if it cannot be parsed. */ }
    callback({});
  });
}

function logMain(stage: string, data: unknown = {}): void {
  const logDir = path.join(DEFAULT_WORKSPACE, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), stage, data }) + "\n";
  fs.appendFileSync(path.join(logDir, "electron-main.jsonl"), line, "utf8");
  if (stage.startsWith("companion.")) fs.appendFileSync(path.join(logDir, "companion-install.jsonl"), line, "utf8");
}

async function createCompanionExecutor(): Promise<WindowsCompanionExecutor | undefined> {
  if (process.platform !== "win32") return undefined;
  const elevation = await getWindowsProcessElevation(logMain);
  // An administrator-launched SecAgent already has permission to write the
  // protected companion directories. Reusing that token avoids a second UAC
  // worker and lets restarted companions keep the same privilege level.
  if (elevation === true) {
    logMain("companion.executor.same-token", { elevated: true });
    return undefined;
  }
  // The executor logs its own startup stages ("elevated.start.*", "elevated.ready")
  // unprefixed; route them under "companion." so they land in
  // companion-install.jsonl next to the operations they explain.
  const executor = new WindowsCompanionExecutor((stage, data) => logMain(stage.startsWith("companion.") ? stage : `companion.${stage}`, data));
  logMain("companion.executor.created", { elevated: elevation === false ? false : "unknown" });
  return executor;
}

// A batch install and a manually clicked install can arrive through different
// IPC calls. They must not close/restart the same companion concurrently: that
// creates duplicate UAC workers, singleton dialogs and competing package scans.
let companionInstallQueue: Promise<void> = Promise.resolve();
function withCompanionInstallLock<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const queuedAt = Date.now();
  logMain("companion.install.queue.wait", { label });
  const run = companionInstallQueue.then(async () => {
    const startedAt = Date.now();
    logMain("companion.install.queue.begin", { label, waitMs: startedAt - queuedAt });
    try {
      return await operation();
    } finally {
      logMain("companion.install.queue.end", { label, durationMs: Date.now() - startedAt });
    }
  });
  companionInstallQueue = run.then(() => undefined, () => undefined);
  return run;
}

process.on("uncaughtException", (error) => {
  logMain("process.uncaught", { error: normalizeMessage(error instanceof Error ? error.message : String(error)) });
  recordTelemetryFailure({ type: "main.uncaught", error });
});
process.on("unhandledRejection", (reason) => {
  logMain("process.unhandled-rejection", { error: normalizeMessage(reason instanceof Error ? reason.message : String(reason)) });
  recordTelemetryFailure({ type: "unhandled.rejection", error: reason });
});

async function ensureMacDockVisible(): Promise<void> {
  if (process.platform !== "darwin") return;
  app.setActivationPolicy("regular");
  await app.dock?.show();
}

function windowChromeOptions(overlayColor = "#ffffff"): Electron.BrowserWindowConstructorOptions {
  if (process.platform === "darwin") {
    return { titleBarStyle: "hidden", trafficLightPosition: { x: 16, y: 21 } };
  }
  // Windows and Linux share the Window Controls Overlay. A native frame on
  // Linux would stack the system title bar on top of the in-app draggable topbar.
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: { color: overlayColor, symbolColor: "#171717", height: 57 },
    autoHideMenuBar: true
  };
}

function configureWindowChrome(window: BrowserWindow): void {
  if (process.platform !== "win32") return;
  // Keep the application menu alive for its fallback shortcuts while hiding its UI.
  window.setAutoHideMenuBar(true);
  window.setMenuBarVisibility(false);
}

function isOpenSettingsShortcut(input: Electron.Input): boolean {
  const primaryModifier = process.platform === "darwin" ? input.meta : input.control;
  return input.type === "keyDown" && primaryModifier && !input.alt && input.code === "Comma";
}

function installWindowShortcuts(window: BrowserWindow): void {
  window.webContents.on("before-input-event", (event, input) => {
    if (!isOpenSettingsShortcut(input)) return;
    event.preventDefault();
    openSettings();
  });
}

function rendererPath(): string { return path.join(__dirname, "../renderer/index.html"); }

function workspaceFilePath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error("预览文件路径必须是工作区内的相对路径");
  const root = path.resolve(DEFAULT_WORKSPACE);
  const filePath = path.resolve(root, normalized);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) throw new Error("预览文件必须位于当前工作区内");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`找不到工作区文件：${normalized}`);
  const extension = path.extname(filePath).toLowerCase();
  if (![".html", ".htm", ".svg", ".md", ".markdown"].includes(extension)) throw new Error("只支持预览 HTML、SVG 和 Markdown 文件");
  return filePath;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function openWorkspaceFilePreview(relativePath: string): Promise<{ ok: true }> {
  const filePath = workspaceFilePath(relativePath);
  const extension = path.extname(filePath).toLowerCase();
  const previewWindow = new BrowserWindow({ width: 1080, height: 820, minWidth: 640, minHeight: 480, title: path.basename(filePath), backgroundColor: "#fff", autoHideMenuBar: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  previewWindow.on("page-title-updated", (event) => event.preventDefault());
  previewWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  let server: ReturnType<typeof createServer> | undefined;
  try {
    if (extension === ".html" || extension === ".htm") {
      const root = path.resolve(DEFAULT_WORKSPACE);
      server = createServer((request, response) => {
        try {
          const requested = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname);
          const target = path.resolve(root, `.${requested}`);
          if (target !== root && !target.startsWith(`${root}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { response.writeHead(404); response.end("Not found"); return; }
          const mimeByExtension: Record<string, string> = { ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2" };
          const mime = mimeByExtension[path.extname(target).toLowerCase()] || "application/octet-stream";
          response.writeHead(200, { "Content-Type": `${mime}; charset=utf-8` }); fs.createReadStream(target).pipe(response);
        } catch { response.writeHead(400); response.end("Bad request"); }
      });
      await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("无法启动本地预览服务器");
      const urlPath = "/" + path.relative(root, filePath).split(path.sep).map(encodeURIComponent).join("/");
      await previewWindow.loadURL(`http://127.0.0.1:${address.port}${urlPath}`);
    } else if (extension === ".svg") {
      await previewWindow.loadFile(filePath);
    } else {
      const markdown = escapeHtml(fs.readFileSync(filePath, "utf8"));
      await previewWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html><head><meta charset="utf-8"><style>body{font:15px/1.7 system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 24px;color:#222}pre{white-space:pre-wrap}</style></head><body><pre>${markdown}</pre></body></html>`)}`);
    }
    previewWindow.setTitle(path.basename(filePath));
    if (!previewWindow.isDestroyed()) previewWindow.show();
    previewWindow.on("closed", () => server?.close());
    return { ok: true };
  } catch (error) {
    server?.close();
    if (!previewWindow.isDestroyed()) previewWindow.close();
    throw error;
  }
}

function sendToAppWindows(channel: string, payload: unknown): void {
  for (const target of [windowRef, settingsWindow, wakeWindow, voiceWakeWindow]) {
    if (!target || target.isDestroyed() || target.webContents.isDestroyed()) continue;
    try {
      target.webContents.send(channel, payload);
    } catch {
      // A renderer may close between the destroyed check and send().
    }
  }
}

function installWindowDiagnostics(target: BrowserWindow, kind: string): void {
  target.webContents.on("render-process-gone", (_event, details) => {
    recordTelemetryFailure({ type: "renderer.crashed", error: new Error(details.reason || "renderer process gone"), context: { window: kind, exitCode: details.exitCode } });
  });
  target.webContents.on("unresponsive", () => {
    recordTelemetryFailure({ type: "renderer.unresponsive", context: { window: kind } });
  });
}

function closeWakeWindow(): void {
  wakeAbortController?.abort();
  wakeAbortController = undefined;
  stopSpeech();
  if (wakeWindow && !wakeWindow.isDestroyed()) wakeWindow.close();
  wakeWindow = undefined;
  resumeVoiceWake();
}

function closeVoiceWakeWindow(): void {
  stopVoiceWake();
  if (voiceWakeWindow && !voiceWakeWindow.isDestroyed()) voiceWakeWindow.close();
  voiceWakeWindow = undefined;
}

function resumeVoiceWake(): void {
  const settings = readSettings(DEFAULT_WORKSPACE);
  if (!settings.wake.voiceEnabled || !voiceWakeWindow || voiceWakeWindow.isDestroyed()) return;
  voiceWakeWindow.webContents.send("voice-wake:resume");
}

async function startConfiguredVoiceWake(): Promise<void> {
  const settings = readSettings(DEFAULT_WORKSPACE);
  if (!settings.wake.voiceEnabled) { closeVoiceWakeWindow(); return; }
  if (voiceWakeWindow && !voiceWakeWindow.isDestroyed()) return;
  const phrase = settings.wake.voicePhrase || "小泽同学";
  voiceWakeWindow = new BrowserWindow({
    width: 1, height: 1, show: false, frame: false, skipTaskbar: true,
    // This window owns the continuous microphone graph. It must keep processing
    // audio while the visible wake overlay is open in front of it.
    webPreferences: { preload: path.join(__dirname, "../preload/preload.cjs"), contextIsolation: true, nodeIntegration: false, autoplayPolicy: "no-user-gesture-required", backgroundThrottling: false }
  });
  installWindowDiagnostics(voiceWakeWindow, "voice-wake");
  voiceWakeWindow.on("closed", () => { stopVoiceWake(); voiceWakeWindow = undefined; });
  const query = new URLSearchParams({ "voice-wake": "1", phrase }).toString();
  if (process.env.ELECTRON_RENDERER_URL) await voiceWakeWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${query}`);
  else await voiceWakeWindow.loadFile(rendererPath(), { query: { "voice-wake": "1", phrase } });
}

async function openWakeWindow(): Promise<void> {
  if (wakeWindow && !wakeWindow.isDestroyed()) {
    closeWakeWindow();
    return;
  }
  await ensureMacDockVisible();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const workArea = display.workArea;
  // Every wake invocation gets an isolated, unlisted session. It remains
  // available to the overlay while never entering the main session index.
  const wakeSettings = readSettings(DEFAULT_WORKSPACE);
  const sessionId = store().create("随时唤醒", { listed: false }).meta.id;
  const wakeModelId = wakeSettings.wake.modelId || activeWakeContext.modelId;
  const query = new URLSearchParams({
    wake: "1",
    sessionId,
    ...(wakeModelId ? { modelId: wakeModelId } : {}),
    ...(activeWakeContext.reasoningEffort ? { reasoningEffort: activeWakeContext.reasoningEffort } : {})
  }).toString();
  wakeWindow = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    show: false,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, "../preload/preload.cjs"), contextIsolation: true, nodeIntegration: false, autoplayPolicy: "no-user-gesture-required" }
  });
  installWindowDiagnostics(wakeWindow, "wake");
  if (process.platform === "darwin") {
    // Keep the overlay in the current macOS Space, including a separate
    // full-screen app Space. Without visibleOnFullScreen, focusing this
    // window makes macOS switch back to SecAgent's normal window Space.
    // The floating level is still below another app's full-screen window, so
    // use the screen-saver level for this transient overlay.
    wakeWindow.setAlwaysOnTop(true, "screen-saver", 1);
    wakeWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else {
    wakeWindow.setAlwaysOnTop(true, "floating");
  }
  // The overlay should not block the application below. Mouse-move events are
  // still forwarded to the renderer so it can temporarily enable interaction
  // when the pointer is over the visible response card.
  wakeWindow.setIgnoreMouseEvents(true, { forward: true });
  wakeWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") closeWakeWindow();
  });
  const showWakeWindow = () => {
    if (!wakeWindow || wakeWindow.isDestroyed()) return;
    // Do not activate the Electron app here. On macOS, activating an app from
    // a different full-screen Space switches to that app's normal Space even
    // when the window is visible on all workspaces.
    wakeWindow.showInactive();
  };
  wakeWindow.once("ready-to-show", showWakeWindow);
  wakeWindow.on("closed", () => {
    wakeAbortController?.abort();
    wakeAbortController = undefined;
    stopSpeech();
    wakeWindow = undefined;
  });
  if (process.env.ELECTRON_RENDERER_URL) await wakeWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${query}`);
  else await wakeWindow.loadFile(rendererPath(), { query: { wake: "1", sessionId, ...(wakeModelId ? { modelId: wakeModelId } : {}), ...(activeWakeContext.reasoningEffort ? { reasoningEffort: activeWakeContext.reasoningEffort } : {}) } });
  // Transparent windows do not consistently emit ready-to-show on every
  // platform, so make the post-load path an additional safe fallback.
  showWakeWindow();
}

function registerWakeShortcut(shortcut: string): void {
  const normalized = normalizeWakeHotkey(shortcut);
  if (activeWakeShortcut === normalized) return;
  if (!globalShortcut.register(normalized, () => { void openWakeWindow().catch((error) => logMain("wake.open.failed", { error: String(error) })); })) throw new Error(`快捷键 ${normalized} 已被其它应用占用`);
  if (activeWakeShortcut) globalShortcut.unregister(activeWakeShortcut);
  activeWakeShortcut = normalized;
}

function createWindow(visible = true): void {
  windowRef = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: "SecAgent",
    show: visible,
    skipTaskbar: false,
    ...windowChromeOptions(),
    icon: appIconPath(),
    webPreferences: { preload: path.join(__dirname, "../preload/preload.cjs"), contextIsolation: true, nodeIntegration: false }
  });
  configureWindowChrome(windowRef);
  installWindowDiagnostics(windowRef, "main");
  installWindowShortcuts(windowRef);
  windowRef.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    windowRef?.hide();
    notifyHiddenMainWindow();
  });
  windowRef.on("closed", () => {
    windowRef = undefined;
  });
  logMain("window.created");
  if (process.env.ELECTRON_RENDERER_URL) windowRef.loadURL(process.env.ELECTRON_RENDERER_URL);
  else windowRef.loadFile(path.join(__dirname, "../renderer/index.html"));
}

async function openPluginSvgPreview(request: SvgPreviewRequest): Promise<boolean> {
  const previewWindow = new BrowserWindow({
    width: 1080,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    title: request.title,
    backgroundColor: "#fffdf6",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  previewWindow.on("page-title-updated", (event) => event.preventDefault());
  previewWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  try {
    await previewWindow.loadFile(request.filePath);
    const isSvgDocument = await previewWindow.webContents.executeJavaScript("document.documentElement?.namespaceURI === 'http://www.w3.org/2000/svg'", true);
    if (!isSvgDocument) throw new Error("SVG XML 解析失败，预览窗口未加载 SVG 文档");
    previewWindow.setTitle(request.title);
    if (!previewWindow.isDestroyed()) previewWindow.show();
    return true;
  } catch (error) {
    logMain("plugin.preview.failed", { path: request.filePath, error: error instanceof Error ? error.message : String(error) });
    if (!previewWindow.isDestroyed()) previewWindow.close();
    return false;
  }
}

function openSettings(oobeOrMenuItem: boolean | Electron.MenuItem = false, _window?: Electron.BaseWindow, _event?: Electron.KeyboardEvent): void {
  const oobe = typeof oobeOrMenuItem === "boolean" ? oobeOrMenuItem : false;
  if (oobe) onboardingCompletionRequested = false;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    title: "SecAgent设置",
    parent: windowRef && !windowRef.isDestroyed() && windowRef.isVisible() ? windowRef : undefined,
    modal: false,
    ...windowChromeOptions("#fafafa"),
    icon: appIconPath(),
    webPreferences: { preload: path.join(__dirname, "../preload/preload.cjs"), contextIsolation: true, nodeIntegration: false }
  });
  configureWindowChrome(settingsWindow);
  installWindowDiagnostics(settingsWindow, "settings");
  settingsWindow.on("page-title-updated", (event) => { event.preventDefault(); });
  settingsWindow.setTitle("SecAgent设置");
  const query = oobe ? "?settings=1&oobe=1" : "?settings=1";
  if (process.env.ELECTRON_RENDERER_URL) settingsWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}${query}`);
  else settingsWindow.loadFile(path.join(__dirname, "../renderer/index.html"), { query: oobe ? { settings: "1", oobe: "1" } : { settings: "1" } });
  settingsWindow.on("closed", () => {
    settingsWindow = undefined;
    if (oobe) {
      if (!onboardingCompletionRequested) app.quit();
      return;
    }
    if (windowRef && !windowRef.isDestroyed() && !windowRef.isVisible()) windowRef.show();
  });
}

function showMainWindow(): void {
  if (!windowRef || windowRef.isDestroyed()) {
    createWindow();
  }
  if (!windowRef || windowRef.isDestroyed()) return;
  if (windowRef.isMinimized()) windowRef.restore();
  windowRef.show();
  windowRef.focus();
  void ensureMacDockVisible();
}

let linuxHiddenNoticeShown = false;
/** GNOME ships no legacy system tray, so a window hidden on close would have no tray icon to restore it. */
function notifyHiddenMainWindow(): void {
  if (process.platform !== "linux" || linuxHiddenNoticeShown || !Notification.isSupported()) return;
  linuxHiddenNoticeShown = true;
  try {
    const hotkey = activeWakeShortcut || DEFAULT_WAKE_HOTKEY;
    const notice = new Notification({ title: "SecAgent 已在后台运行", body: `点击此通知重新打开主窗口，或按 ${hotkey} 唤起。` });
    notice.on("click", () => showMainWindow());
    notice.show();
  } catch (error) {
    logMain("main-window.hidden-notify.failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

function restartApplication(): void {
  isQuitting = true;
  app.relaunch();
  app.exit(0);
}

function createTray(): void {
  if (tray && !tray.isDestroyed()) return;
  tray = new Tray(appIconPath());
  tray.setToolTip("SecAgent");
  const trayMenu = Menu.buildFromTemplate([
    { label: "打开主窗口", click: showMainWindow },
    { label: "打开设置", click: () => openSettings() },
    { type: "separator" },
    { label: "重启应用", click: restartApplication },
    { label: "退出应用", click: () => { isQuitting = true; app.quit(); } }
  ]);
  const showTrayMenu = () => tray?.popUpContextMenu(trayMenu);
  // Explicitly handle both buttons. On Windows this also covers the usual
  // touch interaction, which is delivered as a tray click event.
  tray.on("click", showTrayMenu);
  tray.on("right-click", showTrayMenu);
}

function createApplicationMenu(): void {
  const developerToolsAccelerator = process.platform === "darwin" ? "Alt+Cmd+I" : "Ctrl+Shift+I";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    { label: "文件", submenu: [{ label: "设置…", accelerator: "CmdOrCtrl+,", click: openSettings }, { type: "separator" }, { role: "quit" }] },
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }] },
    { label: "开发", submenu: [{ label: "切换开发者工具", role: "toggleDevTools", accelerator: developerToolsAccelerator }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function store(): SessionStore { return new SessionStore(DEFAULT_WORKSPACE); }

function classifyAgentFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/empty|invalid|malformed.*response|empty response|空响应|返回为空|模型返回|格式错误/i.test(message)) return "model.response.invalid";
  if (/timeout|timed out|超时/i.test(message)) return "model.timeout";
  if (/401|403|unauthorized|forbidden|密钥|token|认证/i.test(message)) return "model.auth_failed";
  if (/429|rate.?limit|限流/i.test(message)) return "model.rate_limited";
  if (/mcp|工具发现|discovery/i.test(message)) return "mcp.discovery.failed";
  if (/tool|工具|插件/i.test(message)) return "tool.call.failed";
  if (/模型|model|endpoint|连接|connect|network|fetch/i.test(message)) return "model.request.failed";
  return "agent.run.failed";
}

function historyInput(session: SessionData, current: string): string {
  const history = session.messages.slice(-20).map((message) => `${message.role === "user" ? "教师" : "SecAgent"}：${message.content}`).join("\n");
  return history ? `以下是当前会话的历史，请结合上下文理解最后一条新消息。\n\n${history}\n\n教师的新消息：${current}` : current;
}

function conversationInput(session: SessionData, current: string, attachments: ChatAttachment[] = []): ConversationMessage[] {
  const history = session.messages.slice(-20).map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    ...(message.toolCalls?.length ? {
      toolCalls: message.toolCalls.map((call, index) => ({
        id: `history-${message.id}-${index}`,
        name: call.name,
        arguments: call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments) ? call.arguments as Record<string, unknown> : {},
        ...(call.result !== undefined ? { result: call.result } : {})
      }))
    } : {})
  }));
  // Anthropic requires a conversation to start with a user turn. A 20-message window can
  // otherwise start at an assistant turn when older messages were truncated.
  if (history[0]?.role === "assistant") history.shift();
  return [
    ...history,
    { role: "user", content: current, ...(attachments.length ? { attachments } : {}) }
  ];
}

const QUICK_WAKE_OUTPUT_PROMPT = `这是一次快速唤起请求。最终回答必须严格以 XML 标签块开头：<tts listen_after="true|false">简短的一句话</tts>。如果你的回答是一个问题、需要用户继续回答或确认，就设置 listen_after="true"；如果回答结束后不需要继续聆听，就设置 listen_after="false"。标签内只写给用户朗读的简短口语，不要 Markdown、代码、列表、链接、表格或复杂标点，尽量简洁。必须先完整输出并闭合 <tts> 标签，再输出给屏幕显示的正式回答；正式回答不要重复 TTS 文本。`;

function normalizeAttachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ChatAttachment[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<ChatAttachment>;
    if (typeof candidate.id !== "string" || typeof candidate.name !== "string" || typeof candidate.mimeType !== "string" || !candidate.mimeType.startsWith("image/") || typeof candidate.dataUrl !== "string" || !candidate.dataUrl.startsWith("data:image/")) return [];
    const size = typeof candidate.size === "number" && Number.isFinite(candidate.size) ? candidate.size : 0;
    if (size > 12 * 1024 * 1024 || candidate.dataUrl.length > 16 * 1024 * 1024) return [];
    return [{ id: candidate.id, name: candidate.name, mimeType: candidate.mimeType, dataUrl: candidate.dataUrl, size }];
  }).slice(0, 4);
}

ipcMain.handle("sessions:list", () => { logMain("ipc.sessions.list"); return store().list(); });
ipcMain.handle("sessions:create", () => { const session = store().create(); logMain("ipc.sessions.create", { sessionId: session.meta.id }); return session; });
ipcMain.handle("sessions:delete", (_event, id: string) => { store().delete(id); logMain("ipc.sessions.delete", { sessionId: id }); return store().list(); });
ipcMain.handle("sessions:get", (_event, id: string) => { logMain("ipc.sessions.get", { sessionId: id }); return store().get(id); });
ipcMain.handle("sessions:runtime-events", (_event, id: string) => { logMain("ipc.sessions.runtime-events", { sessionId: id }); return store().getRuntimeEvents(id).map((item) => ({ sessionId: id, ...item })); });
ipcMain.handle("sessions:diagnostic-upload", async (_event, id: string) => {
  if (!telemetry?.isEnabled()) throw new Error("请先在设置中开启匿名诊断数据上传");
  const sessionStore = store();
  const result = await telemetry.uploadDiagnostic(sessionStore.get(id), sessionStore.getRuntimeEvents(id));
  logMain("telemetry.diagnostic.uploaded", { sessionId: hashIdentifier(id), bytes: result.bytes });
  return result;
});
ipcMain.handle("workspace:preview-file", (_event, relativePath: string) => openWorkspaceFilePreview(relativePath));
function officialProvider(baseUrl: string) {
  return { id: "sectl-official", name: "SecAgent 官方服务", preset: "custom", provider: "openai-responses" as const, apiKeyEnv: "SECTL_OFFICIAL_TOKEN", baseUrl: `${baseUrl}/v1`, endpoint: "/responses", maxTokens: 16384, models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }] };
}

/** Client-facing virtual tiers served by the relay. Latency tier is deferred (回头再用). */
const OFFICIAL_TIER_IDS = ["virtual-fast", "virtual-standard", "virtual-deep"] as const;

ipcMain.handle("models:list", async () => {
  const { config } = loadConfig(DEFAULT_WORKSPACE);
  const googleProfile = config.agent.models?.find((model) => model.provider === "google");
  const googleModels = googleProfile ? await listGoogleModels(process.env[googleProfile.apiKeyEnv] || "", googleProfile.baseUrl).catch(() => []) : [];
  const options = configuredModels(config, googleModels).filter((option) => option.id !== "sectl-official" && !option.id.startsWith("sectl-official:"));
  const customModelMode = Boolean(config.defaults?.customModelMode);
  const token = process.env.SECTL_OFFICIAL_TOKEN;
  const baseUrl = (process.env.SECTL_OFFICIAL_API_URL || "").replace(/\/$/, "");
  // 自定义模型模式关闭时只能使用官方服务（必须登录），自定义提供商不生效。
  if (!token || !baseUrl) return customModelMode ? options : [];
  try {
    const current = readSettings(DEFAULT_WORKSPACE);
    if (!current.providers.some((provider) => provider.id === "sectl-official")) {
      saveSettings(DEFAULT_WORKSPACE, { ...current, providers: [...current.providers, officialProvider(baseUrl)] });
    }
  } catch { /* 自愈失败不阻塞模型列表 */ }
  try {
    const query = new URLSearchParams({ custom_model_mode: String(customModelMode) });
    const response = await fetch(`${baseUrl}/models?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    const payload = await response.json() as { data?: Array<{ id?: string; name?: string; virtual?: boolean }> };
    const remote = (payload.data || []).filter((model) => model.id).map((model) => ({ id: `official:sectl-official:${model.id}`, name: model.name || model.id || "官方模型", model: model.id || "", provider: "openai-responses", virtual: model.virtual === true }));
    // 低延迟档位暂不开放（回头再用）。
    // 自定义模型模式永远不显示中转服务的虚拟档位；后端也会按后台 allow-list 过滤真实模型。
    const visibleRemote = remote.filter((model) => model.model !== "virtual-latency" && (!customModelMode || (!model.virtual && !model.model.startsWith("virtual-"))));
    if (customModelMode) {
      // 自定义模型模式开启：只加入后台允许的官方真实模型与本地自定义模型。
      return [...visibleRemote, ...options];
    }
    // 关闭：官方档位模式 —— 下拉只有快速/标准/深度三个虚拟档位，看不到具体模型；
    // 另外提供一个识图虚拟模型（virtual-vision），它只作为识图工具的后端模型，
    // 不作为主 Agent 模型出现在前端下拉中（前端按 vision 标记过滤）。
    return visibleRemote.filter((model) => (OFFICIAL_TIER_IDS as readonly string[]).includes(model.model) || model.model === OFFICIAL_VISION_MODEL)
      .map((model) => ({ ...model, vision: model.model === OFFICIAL_VISION_MODEL }));
  } catch { return customModelMode ? options : []; }
});
ipcMain.handle("providers:list", async () => {
  try {
    const catalog = await Models.make().providers();
    return Object.values(catalog).map((provider) => ({
      id: provider.id,
      name: provider.name || provider.id,
      env: provider.env || [],
      api: provider.api || "",
      models: Object.values(provider.models || {}).map((model) => ({ id: model.id, name: model.name || model.id }))
    }));
  } catch (error) {
    logMain("providers.list.failed", { error: String(error) });
    return [];
  }
});
ipcMain.handle("settings:get", () => {
  const settings = readSettings(DEFAULT_WORKSPACE);
  return { ...settings, autostart: readAutostart() };
});
ipcMain.on("telemetry:dsn", (event) => { event.returnValue = SENTRY_DSN; });
ipcMain.on("telemetry:enabled", (event) => {
  try {
    // Preload runs before app.ready. An existing workspace has the persisted
    // choice; a fresh workspace follows the default opt-in setting.
    event.returnValue = !fs.existsSync(configPath(DEFAULT_WORKSPACE)) || readSettings(DEFAULT_WORKSPACE).telemetry.enabled;
  } catch {
    event.returnValue = false;
  }
});
ipcMain.handle("settings:open", () => { openSettings(); return { ok: true }; });
ipcMain.handle("updates:get-state", () => updateManager?.getState() || ({ currentVersion: app.getVersion(), channel: "stable", status: "unsupported", downloadedBytes: 0 } satisfies UpdateState));
ipcMain.handle("updates:check", () => updateManager?.check(false) || ({ currentVersion: app.getVersion(), channel: "stable", status: "unsupported", downloadedBytes: 0 } satisfies UpdateState));
ipcMain.handle("updates:download", async () => {
  if (!updateManager) throw new Error("更新服务尚未启动");
  return updateManager.download();
});
ipcMain.handle("updates:install", () => {
  if (!updateManager) throw new Error("更新服务尚未启动");
  return updateManager.install();
});
ipcMain.handle("diagnostics:open-logs", async () => {
  const directory = diagnosticLogDirectory(DEFAULT_WORKSPACE);
  fs.mkdirSync(directory, { recursive: true });
  const error = await shell.openPath(directory);
  if (error) throw new Error(error);
  logMain("diagnostics.logs.opened");
  return directory;
});
ipcMain.handle("diagnostics:export-logs", async () => {
  const defaultPath = path.join(app.getPath("documents"), `SecAgent-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`);
  const result = await dialog.showSaveDialog({
    title: "导出 SecAgent 诊断日志",
    defaultPath,
    filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true as const };
  const archivePath = exportDiagnosticLogs(DEFAULT_WORKSPACE, result.filePath, {
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged
  });
  logMain("diagnostics.logs.exported", { path: archivePath });
  return { canceled: false as const, path: archivePath };
});
ipcMain.handle("settings:skills", () => {
  const { config } = loadConfig(DEFAULT_WORKSPACE);
  return loadEnabledSkills(config).map((skill) => ({ name: skill.name, description: skill.description, path: skill.path }));
});
ipcMain.handle("settings:open-skills", async () => {
  const directory = path.join(DEFAULT_WORKSPACE, "skills");
  fs.mkdirSync(directory, { recursive: true });
  const error = await shell.openPath(directory);
  if (error) throw new Error(error);
  return directory;
});
ipcMain.handle("official:status", () => { loadConfig(DEFAULT_WORKSPACE); return { loggedIn: Boolean(process.env.SECTL_OFFICIAL_TOKEN), email: process.env.SECTL_OFFICIAL_EMAIL || "" }; });
ipcMain.handle("official:balance", async () => {
  loadConfig(DEFAULT_WORKSPACE);
  const token = process.env.SECTL_OFFICIAL_TOKEN;
  const baseUrl = (process.env.SECTL_OFFICIAL_API_URL || "").replace(/\/$/, "");
  if (!token || !baseUrl) return { points: null, balances: [], expired: false };
  const response = await fetch(`${baseUrl}/account`, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await response.json().catch(() => ({})) as { points?: number; point_balances?: Array<{ points?: number; expires_at?: string | null }>; detail?: string };
  if (response.status === 401) return { points: null, balances: [], expired: true };
  if (!response.ok || typeof payload.points !== "number") throw new Error(payload.detail || "无法获取 Points 余额");
  return { points: payload.points, balances: (payload.point_balances || []).filter((item) => typeof item.points === "number").map((item) => ({ points: item.points as number, expiresAt: item.expires_at ?? null })), expired: false };
});
ipcMain.handle("official:redeem", async (_event, code: string) => {
  loadConfig(DEFAULT_WORKSPACE);
  const token = process.env.SECTL_OFFICIAL_TOKEN;
  const baseUrl = (process.env.SECTL_OFFICIAL_API_URL || "").replace(/\/$/, "");
  if (!token || !baseUrl) throw new Error("尚未登录 SecAgent 官方服务");
  const response = await fetch(`${baseUrl}/redeem`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ code }) });
  const payload = await response.json().catch(() => ({})) as { points_added?: number; expires_at?: string | null; balance?: number; point_balances?: Array<{ points?: number; expires_at?: string | null }>; detail?: string };
  if (!response.ok || typeof payload.points_added !== "number") throw new Error(payload.detail || "兑换失败，请稍后重试");
  return { pointsAdded: payload.points_added, expiresAt: payload.expires_at ?? null, balance: typeof payload.balance === "number" ? payload.balance : null, balances: (payload.point_balances || []).filter((item) => typeof item.points === "number").map((item) => ({ points: item.points as number, expiresAt: item.expires_at ?? null })) };
});
ipcMain.handle("official:login", async (_event, email: string, password: string) => {
  loadConfig(DEFAULT_WORKSPACE);
  const baseUrl = (process.env.SECTL_OFFICIAL_API_URL || "").replace(/\/$/, "");
  if (!baseUrl) throw new Error("请先在 SecAgent 代码目录 .env 配置 SECTL_OFFICIAL_API_URL");
  const response = await fetch(`${baseUrl}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, platform_id: process.env.SECTL_OFFICIAL_PLATFORM_ID || "secagent", client_id: process.env.SECTL_OFFICIAL_CLIENT_ID || "secagent-desktop" }) });
  const payload = await response.json().catch(() => ({})) as { access_token?: string; user?: { email?: string }; detail?: string };
  if (!response.ok || !payload.access_token) throw new Error(payload.detail || "SECTL 登录失败");
  writeWorkspaceEnv(DEFAULT_WORKSPACE, "SECTL_OFFICIAL_TOKEN", payload.access_token);
  writeWorkspaceEnv(DEFAULT_WORKSPACE, "SECTL_OFFICIAL_EMAIL", payload.user?.email || email);
  const current = readSettings(DEFAULT_WORKSPACE);
  const providers = current.providers.some((provider) => provider.id === "sectl-official") ? current.providers : [...current.providers, officialProvider(baseUrl)];
  return saveSettings(DEFAULT_WORKSPACE, { ...current, providers });
});
const PUBLIC_IP_ENDPOINTS = [
  "https://api.ipify.org?format=json",
  "https://httpbin.org/ip",
  "https://api64.ipify.org?format=json"
];

async function resolvePublicIpv4(): Promise<string> {
  for (const endpoint of PUBLIC_IP_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) continue;
      const payload = await response.json().catch(() => ({})) as { ip?: unknown; origin?: unknown };
      const candidate = String(payload.ip ?? payload.origin ?? "").split(",")[0].trim();
      if (isIPv4(candidate)) return candidate;
    } catch {
      // Try the next public-IP provider.
    }
  }
  throw new Error("无法获取本机公网 IPv4，请检查网络连接后重试");
}

async function runSectlOAuthLogin(): Promise<{ accessToken: string; userId?: string; email?: string; name?: string }> {
  loadConfig(DEFAULT_WORKSPACE);
  const relayUrl = (process.env.SECTL_OFFICIAL_API_URL || "").replace(/\/$/, "");
  const oauthUrl = (process.env.SECTL_OAUTH_API_URL || "https://appwrite.sectl.cn").replace(/\/$/, "");
  const oauthWebUrl = (process.env.SECTL_OAUTH_WEB_URL || "https://sectl.cn").replace(/\/$/, "");
  const clientId = process.env.SECTL_OFFICIAL_CLIENT_ID || "";
  const port = Number(process.env.SECTL_OAUTH_CALLBACK_PORT || 49152);
  if (!relayUrl) throw new Error("请在 SecAgent .env 配置 SECTL_OFFICIAL_API_URL");
  if (!clientId) throw new Error("请在 SecAgent .env 配置 SECTL_OFFICIAL_CLIENT_ID");
  if (!Number.isInteger(port) || port < 49152 || port > 65535) throw new Error("SECTL_OAUTH_CALLBACK_PORT 必须是 49152-65535 的固定端口");
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
  const state = crypto.randomBytes(24).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${oauthWebUrl}/oauth/authorize`);
  authorize.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "user:read", state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
  const callback = await new Promise<{ code: string }>((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/oauth/callback") { response.writeHead(404); response.end("Not found"); return; }
      if (url.searchParams.get("state") !== state) { response.writeHead(400); response.end("Invalid state"); reject(new Error("OAuth state validation failed")); server.close(); return; }
      const error = url.searchParams.get("error");
      if (error) { response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }); response.end("<h2>Login failed. You can close this page.</h2>"); reject(new Error(url.searchParams.get("error_description") || error)); server.close(); return; }
      const code = url.searchParams.get("code");
      if (!code) { response.writeHead(400); response.end("Missing code"); reject(new Error("OAuth callback missing code")); server.close(); return; }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end("<h2>Login successful. You can close this page.</h2>"); resolve({ code }); server.close();
    });
    server.on("error", (error) => reject(new Error(`无法监听 OAuth 回调端口 ${port}: ${error.message}`)));
    server.listen(port, "127.0.0.1", () => { void shell.openExternal(authorize.toString()); });
    setTimeout(() => { server.close(); reject(new Error("OAuth 登录超时，请重试")); }, 5 * 60 * 1000).unref();
  });
  const ipAddress = await resolvePublicIpv4();
  const response = await fetch(`${oauthUrl}/api/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code: callback.code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier, device_uuid: crypto.randomUUID(), ip_address: ipAddress }) });
  const payload = await response.json().catch(() => ({})) as { access_token?: string; error_description?: string };
  if (!response.ok || !payload.access_token) throw new Error(payload.error_description || "SECTL OAuth 换取令牌失败");
  const relayResponse = await fetch(`${relayUrl}/auth/oauth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: payload.access_token, client_id: clientId, platform_id: process.env.SECTL_OFFICIAL_PLATFORM_ID || clientId }) });
  const relayPayload = await relayResponse.json().catch(() => ({})) as { access_token?: string; user?: { id?: string; email?: string; name?: string }; detail?: string };
  if (!relayResponse.ok || !relayPayload.access_token) throw new Error(relayPayload.detail || "官方服务 OAuth 登录失败");
  return { accessToken: relayPayload.access_token, userId: relayPayload.user?.id, email: relayPayload.user?.email, name: relayPayload.user?.name };
}

ipcMain.handle("sectl:oauth-login", () => runSectlOAuthLogin());
ipcMain.handle("official:oauth-login", async () => {
  loadConfig(DEFAULT_WORKSPACE);
  const relayUrl = (process.env.SECTL_OFFICIAL_API_URL || "").replace(/\/$/, "");
  const oauthUrl = (process.env.SECTL_OAUTH_API_URL || "https://appwrite.sectl.cn").replace(/\/$/, "");
  const oauthWebUrl = (process.env.SECTL_OAUTH_WEB_URL || "https://sectl.cn").replace(/\/$/, "");
  const clientId = process.env.SECTL_OFFICIAL_CLIENT_ID || "";
  const port = Number(process.env.SECTL_OAUTH_CALLBACK_PORT || 49152);
  if (!relayUrl) throw new Error("请在 SecAgent 代码目录 .env 配置 SECTL_OFFICIAL_API_URL");
  if (!clientId) throw new Error("请在 SecAgent 代码目录 .env 配置 SECTL_OFFICIAL_CLIENT_ID");
  if (!Number.isInteger(port) || port < 49152 || port > 65535) throw new Error("SECTL_OAUTH_CALLBACK_PORT 必须是 49152-65535 的固定端口");
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
  const state = crypto.randomBytes(24).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${oauthWebUrl}/oauth/authorize`);
  authorize.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "user:read", state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
  const callback = await new Promise<{ code: string }>((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/oauth/callback") { response.writeHead(404); response.end("Not found"); return; }
      if (url.searchParams.get("state") !== state) { response.writeHead(400); response.end("Invalid state"); reject(new Error("OAuth state 校验失败")); server.close(); return; }
      const error = url.searchParams.get("error");
      if (error) { response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }); response.end("<h2>登录未完成，请返回 SecAgent 重试。</h2>"); reject(new Error(url.searchParams.get("error_description") || error)); server.close(); return; }
      const code = url.searchParams.get("code");
      if (!code) { response.writeHead(400); response.end("Missing code"); reject(new Error("OAuth 回调缺少 code")); server.close(); return; }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end("<h2>SecAgent 登录成功，可以关闭此页面。</h2>"); resolve({ code }); server.close();
    });
    server.on("error", (error) => reject(new Error(`无法监听 OAuth 回调端口 ${port}: ${error.message}`)));
    server.listen(port, "127.0.0.1", () => { void shell.openExternal(authorize.toString()); });
    setTimeout(() => { server.close(); reject(new Error("OAuth 登录超时，请重试")); }, 5 * 60 * 1000).unref();
  });
  const ipAddress = await resolvePublicIpv4();
  const tokenResponse = await fetch(`${oauthUrl}/api/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code: callback.code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier, device_uuid: crypto.randomUUID(), ip_address: ipAddress }) });
  const tokenPayload = await tokenResponse.json().catch(() => ({})) as { access_token?: string; error_description?: string };
  if (!tokenResponse.ok || !tokenPayload.access_token) throw new Error(tokenPayload.error_description || "SECTL OAuth 换取令牌失败");
  const relayResponse = await fetch(`${relayUrl}/auth/oauth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: tokenPayload.access_token, client_id: clientId, platform_id: process.env.SECTL_OFFICIAL_PLATFORM_ID || clientId }) });
  const relayPayload = await relayResponse.json().catch(() => ({})) as { access_token?: string; user?: { id?: string; email?: string; name?: string }; detail?: string };
  if (!relayResponse.ok || !relayPayload.access_token) throw new Error(relayPayload.detail || "官方服务登录失败");
  writeWorkspaceEnv(DEFAULT_WORKSPACE, "SECTL_OFFICIAL_TOKEN", relayPayload.access_token);
  writeWorkspaceEnv(DEFAULT_WORKSPACE, "SECTL_OFFICIAL_SECTL_TOKEN", "");
  writeWorkspaceEnv(DEFAULT_WORKSPACE, "SECTL_OFFICIAL_USER_ID", relayPayload.user?.id || "");
  writeWorkspaceEnv(DEFAULT_WORKSPACE, "SECTL_OFFICIAL_EMAIL", relayPayload.user?.email || "SECTL 用户");
  const current = readSettings(DEFAULT_WORKSPACE);
  const providers = current.providers.some((provider) => provider.id === "sectl-official") ? current.providers : [...current.providers, officialProvider(relayUrl)];
  return saveSettings(DEFAULT_WORKSPACE, { ...current, providers });
});
ipcMain.handle("official:logout", () => { loadConfig(DEFAULT_WORKSPACE); writeWorkspaceEnv(DEFAULT_WORKSPACE, "SECTL_OFFICIAL_TOKEN", ""); writeWorkspaceEnv(DEFAULT_WORKSPACE, "SECTL_OFFICIAL_SECTL_TOKEN", ""); writeWorkspaceEnv(DEFAULT_WORKSPACE, "SECTL_OFFICIAL_USER_ID", ""); writeWorkspaceEnv(DEFAULT_WORKSPACE, "SECTL_OFFICIAL_EMAIL", ""); return { loggedIn: false }; });
ipcMain.handle("plugins:list", () => pluginManager?.list() || []);
ipcMain.handle("plugins:settings-call", async (_event, pluginId: string, pageId: string, action: string, args: Record<string, unknown> = {}) => {
  try { return await pluginManager?.callSettings(pluginId, pageId, action, args); }
  catch (error) { recordTelemetryFailure({ type: "plugin.call.failed", error, context: { pluginId, pageId, action } }); throw error; }
});
ipcMain.handle("plugins:set-enabled", async (_event, id: string, enabled: boolean) => {
  try { await pluginManager?.setEnabled(id, enabled); return pluginManager?.list() || []; }
  catch (error) { recordTelemetryFailure({ type: "plugin.start.failed", error, context: { pluginId: id, enabled } }); throw error; }
});
ipcMain.handle("plugins:reload", async (_event, id: string) => {
  try { await pluginManager?.reload(id); return pluginManager?.list() || []; }
  catch (error) { recordTelemetryFailure({ type: "plugin.start.failed", error, context: { pluginId: id, phase: "reload" } }); throw error; }
});
ipcMain.handle("plugins:uninstall", async (_event, id: string) => { await pluginManager?.uninstall(id); return pluginManager?.list() || []; });
ipcMain.handle("plugins:install", async () => {
  const result = await dialog.showOpenDialog(settingsWindow || windowRef!, { properties: ["openFile"], filters: [{ name: "SecAgent plugin", extensions: ["zip"] }] });
  if (result.canceled || !result.filePaths[0]) return pluginManager?.list() || [];
  try { await pluginManager?.install(result.filePaths[0]); return pluginManager?.list() || []; }
  catch (error) { recordTelemetryFailure({ type: "plugin.start.failed", error, context: { phase: "install" } }); throw error; }
});
ipcMain.handle("marketplace:list", async () => {
  const operationId = crypto.randomUUID();
  logMain("marketplace.list.started", { operationId });
  try {
    const entries = await marketplace.list();
    logMain("marketplace.list.completed", {
      operationId,
      count: entries.length,
      available: entries.filter((entry) => Boolean(entry.latest)).map((entry) => ({ id: entry.id, version: entry.latest?.version })),
      unavailable: entries.filter((entry) => !entry.latest).map((entry) => ({ id: entry.id, error: entry.releaseError }))
    });
    return entries;
  } catch (error) {
    logMain("marketplace.list.failed", { operationId, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
});
ipcMain.handle("marketplace:install", async (_event, version: MarketplaceVersion) => {
  if (!pluginManager) throw new Error("插件管理器尚未启动");
  try { await marketplace.install(pluginManager, version); return pluginManager.list(); }
  catch (error) { recordTelemetryFailure({ type: "plugin.start.failed", error, context: { phase: "marketplace-install", version: version.version } }); throw error; }
});
ipcMain.handle("plugins:update", async (_event, id: string) => {
  if (!pluginManager) throw new Error("插件管理器尚未启动");
  try {
    const result = await marketplace.updatePlugin(pluginManager, id);
    logMain("marketplace.plugins.manual-update", result);
    return result;
  } catch (error) {
    recordTelemetryFailure({ type: "plugin.start.failed", error, context: { pluginId: id, phase: "manual-update" } });
    throw error;
  }
});
ipcMain.handle("apps:detect", () => detectCompanionApps());
ipcMain.handle("classisland:detect", async () => {
  const candidates = await classIslandInstaller.detect();
  logMain("companion.classisland.detect", { candidates: candidates.map((candidate) => ({ id: candidate.id, executablePath: candidate.executablePath, dataRoot: candidate.dataRoot, pluginPackagesPath: candidate.pluginPackagesPath, version: candidate.version, installedPluginVersion: candidate.installedPluginVersion, pluginHealthy: candidate.pluginHealthy, isRunning: candidate.isRunning, pid: candidate.pid, processIds: candidate.processIds, compatible: candidate.compatible, source: candidate.source })) });
  return candidates;
});
ipcMain.handle("classisland:pick", async () => {
  const result = await dialog.showOpenDialog(settingsWindow || windowRef!, {
    properties: ["openFile"],
    filters: process.platform === "win32" ? [{ name: "ClassIsland", extensions: ["exe"] }] : undefined
  });
  if (result.canceled || !result.filePaths[0]) return undefined;
  return classIslandInstaller.inspect(result.filePaths[0]);
});
ipcMain.handle("classisland:install", async (event, targetIds: unknown) => {
  if (!Array.isArray(targetIds) || targetIds.some((item) => typeof item !== "string")) throw new Error("ClassIsland 安装目标无效");
  return withCompanionInstallLock("classisland", async () => {
    const executor = await createCompanionExecutor();
    try {
      return await classIslandInstaller.install(targetIds, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send("classisland:progress", progress);
      }, executor);
    } finally {
      await executor?.close();
    }
  });
});
ipcMain.handle("secrandom:detect", async () => {
  const candidates = await secRandomInstaller.detect();
  logMain("companion.secrandom.detect", { candidates: candidates.map((candidate) => ({ id: candidate.id, executablePath: candidate.executablePath, dataRoot: candidate.dataRoot, pluginPackagesPath: candidate.pluginPackagesPath, version: candidate.version, installedPluginVersion: candidate.installedPluginVersion, isRunning: candidate.isRunning, compatible: candidate.compatible, source: candidate.source })) });
  return candidates;
});
ipcMain.handle("secrandom:pick", async () => {
  const result = await dialog.showOpenDialog(settingsWindow || windowRef!, {
    properties: ["openFile"],
    filters: process.platform === "win32" ? [{ name: "SecRandom", extensions: ["exe"] }] : undefined
  });
  if (result.canceled || !result.filePaths[0]) return undefined;
  return secRandomInstaller.inspect(result.filePaths[0]);
});
ipcMain.handle("secrandom:install", async (event, targetIds: unknown) => {
  if (!Array.isArray(targetIds) || targetIds.some((item) => typeof item !== "string")) throw new Error("SecRandom 安装目标无效");
  return withCompanionInstallLock("secrandom", async () => {
    const executor = await createCompanionExecutor();
    try {
      return await secRandomInstaller.install(targetIds, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send("secrandom:progress", progress);
      }, executor);
    } finally {
      await executor?.close();
    }
  });
});
ipcMain.handle("iccce:detect", async () => {
  const candidates = await iccceInstaller.detect();
  logMain("companion.iccce.detect", { candidates: candidates.map((candidate) => ({ id: candidate.id, executablePath: candidate.executablePath, rootPath: candidate.rootPath, pluginPackagesPath: candidate.pluginPackagesPath, pluginsPath: candidate.pluginsPath, version: candidate.version, installedPluginVersion: candidate.installedPluginVersion, pluginHealthy: candidate.pluginHealthy, isRunning: candidate.isRunning, compatible: candidate.compatible, source: candidate.source })) });
  return candidates;
});
ipcMain.handle("iccce:pick", async () => {
  const result = await dialog.showOpenDialog(settingsWindow || windowRef!, {
    properties: ["openFile"],
    filters: process.platform === "win32" ? [{ name: "ICC-CE", extensions: ["exe"] }] : undefined
  });
  if (result.canceled || !result.filePaths[0]) return undefined;
  return iccceInstaller.inspect(result.filePaths[0]);
});
ipcMain.handle("iccce:install", async (event, targetIds: unknown) => {
  if (!Array.isArray(targetIds) || targetIds.some((item) => typeof item !== "string")) throw new Error("ICC-CE 安装目标无效");
  return withCompanionInstallLock("iccce", async () => {
    const executor = await createCompanionExecutor();
    try {
      return await iccceInstaller.install(targetIds, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send("iccce:progress", progress);
      }, executor);
    } finally {
      await executor?.close();
    }
  });
});
ipcMain.handle("cw:detect", async () => {
  const candidates = await classWidgetsInstaller.detect();
  logMain("companion.classwidgets.detect", { candidates: candidates.map((candidate) => ({ id: candidate.id, executablePath: candidate.executablePath, pluginsPath: candidate.pluginsPath, version: candidate.version, installedPluginVersion: candidate.installedPluginVersion, isRunning: candidate.isRunning, pid: candidate.pid, processIds: candidate.processIds, compatible: candidate.compatible, source: candidate.source })) });
  return candidates;
});
ipcMain.handle("cw:pick", async () => {
  const result = await dialog.showOpenDialog(settingsWindow || windowRef!, {
    properties: ["openFile"],
    filters: process.platform === "win32" ? [{ name: "Class Widgets", extensions: ["exe"] }] : undefined
  });
  if (result.canceled || !result.filePaths[0]) return undefined;
  return classWidgetsInstaller.inspect(result.filePaths[0]);
});
ipcMain.handle("cw:install", async (event, targetIds: unknown) => {
  if (!Array.isArray(targetIds) || targetIds.some((item) => typeof item !== "string")) throw new Error("Class Widgets 安装目标无效");
  return withCompanionInstallLock("classwidgets", async () => {
    const executor = await createCompanionExecutor();
    try {
      return await classWidgetsInstaller.install(targetIds, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send("cw:progress", progress);
      }, executor);
    } finally {
      await executor?.close();
    }
  });
});
ipcMain.handle("companions:install-all", async (event, payload: unknown) => {
  if (!payload || typeof payload !== "object") throw new Error("联动插件安装目标无效");
  const input = payload as Record<string, unknown>;
  const readIds = (key: string): string[] => {
    const value = input[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${key} 安装目标无效`);
    return value;
  };
  const classIslandIds = readIds("classIsland");
  const secRandomIds = readIds("secRandom");
  const iccceIds = readIds("iccce");
  const cwIds = readIds("cw");
  const sendProgress = (channel: string) => (progress: unknown) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, progress);
  };
  const failureResults = (targetIds: string[], error: unknown) => targetIds.map((targetId) => ({
    targetId,
    ok: false,
    action: "failed" as const,
    message: error instanceof Error ? error.message : String(error)
  }));
  return withCompanionInstallLock("batch", async () => {
    const executor = await createCompanionExecutor();
    logMain("companion.batch.begin", { classIslandIds, secRandomIds, iccceIds, cwIds, elevatedExecutor: Boolean(executor) });
    try {
      // The four installers run concurrently: each has its own download/
      // package/decompress phases, and the long "waiting for the host app to
      // come back" health polls overlap instead of adding up. The shared
      // elevated worker serialises the actually-privileged file operations
      // through its request directory, so one UAC still covers everything.
      const runInstaller = async (label: string, ids: string[], install: () => Promise<unknown[]>): Promise<unknown[]> => {
        if (!ids.length) return [];
        try { return await install(); }
        catch (error) {
          logMain(`companion.batch.${label}.failed`, { error: error instanceof Error ? error.message : String(error) });
          return failureResults(ids, error);
        }
      };
      const [classIsland, secRandom, iccce, cw] = await Promise.all([
        runInstaller("classisland", classIslandIds, () => classIslandInstaller.install(classIslandIds, sendProgress("classisland:progress"), executor)),
        runInstaller("secrandom", secRandomIds, () => secRandomInstaller.install(secRandomIds, sendProgress("secrandom:progress"), executor)),
        runInstaller("iccce", iccceIds, () => iccceInstaller.install(iccceIds, sendProgress("iccce:progress"), executor)),
        runInstaller("classwidgets", cwIds, () => classWidgetsInstaller.install(cwIds, sendProgress("cw:progress"), executor))
      ]);
      const allResults = [...classIsland, ...secRandom, ...iccce, ...cw];
      const failed = allResults.filter((item) => !item || (item as { ok?: unknown }).ok !== true);
      logMain(failed.length ? "companion.batch.completed-with-failures" : "companion.batch.success", {
        classIsland: classIsland.length,
        secRandom: secRandom.length,
        iccce: iccce.length,
        cw: cw.length,
        ok: allResults.length - failed.length,
        failed: failed.length,
        failedTargets: failed.map((item) => (item as { targetId?: unknown }).targetId).filter((item): item is string => typeof item === "string")
      });
      return { classIsland, secRandom, iccce, cw };
    } finally {
      await executor?.close();
      logMain("companion.batch.end", { classIslandIds, secRandomIds, iccceIds, cwIds });
    }
  });
});
ipcMain.handle("oobe:progress:get", () => readOobeProgress(DEFAULT_WORKSPACE));
ipcMain.handle("oobe:progress:save", (_event, progress: OobeProgress) => {
  saveOobeProgress(DEFAULT_WORKSPACE, progress);
  return readOobeProgress(DEFAULT_WORKSPACE);
});
ipcMain.handle("shell:open-external", async (_event, url: string) => {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("无效的链接"); }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname))) throw new Error("只允许打开 http(s) 链接");
  await shell.openExternal(parsed.toString());
  return { ok: true };
});
ipcMain.handle("oobe:complete", (event) => {
  onboardingCompletionRequested = true;
  markOnboardingComplete(DEFAULT_WORKSPACE);
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (senderWindow && !senderWindow.isDestroyed() && senderWindow === settingsWindow) senderWindow.close();
  if (windowRef && !windowRef.isDestroyed()) { windowRef.show(); windowRef.focus(); }
  return { ok: true };
});
ipcMain.handle("settings:save", (_event, payload: SettingsPayload) => {
  const customModelMode = Boolean(payload?.customModelMode);
  let providers = Array.isArray(payload?.providers) ? payload.providers : [];
  if (!customModelMode) {
    // 自定义模型模式关闭：自定义供应商不生效，仅保留官方服务；必须登录才能使用。
    providers = providers.filter((provider) => provider.id === "sectl-official");
    if (!providers.length) {
      const baseUrl = (process.env.SECTL_OFFICIAL_API_URL || "").replace(/\/$/, "");
      if (!baseUrl) throw new Error("自定义模型模式已关闭：请先配置 SECTL_OFFICIAL_API_URL 或登录 SecAgent 官方服务");
      providers = [officialProvider(baseUrl)];
    }
  }
  const nextWakeHotkey = normalizeWakeHotkey(payload.wake?.hotkey || DEFAULT_WAKE_HOTKEY);
  const previousWakeHotkey = activeWakeShortcut;
  const wakeShortcutChanged = previousWakeHotkey !== nextWakeHotkey;
  let registeredNewShortcut = false;
  if (wakeShortcutChanged) {
    registeredNewShortcut = globalShortcut.register(nextWakeHotkey, () => { void openWakeWindow().catch((error) => logMain("wake.open.failed", { error: String(error) })); });
    if (!registeredNewShortcut) {
      if (previousWakeHotkey) throw new Error(`快捷键 ${nextWakeHotkey} 已被其它应用占用`);
      logMain("wake.hotkey.occupied", { hotkey: nextWakeHotkey });
    }
  }
  let saved: SettingsPayload;
  const previousAutostart = readAutostart();
  const nextAutostart = payload.autostart === true;
  const autostartChanged = previousAutostart !== nextAutostart;
  try {
    if (autostartChanged) writeAutostart(nextAutostart);
    saved = saveSettings(DEFAULT_WORKSPACE, { ...payload, providers, autostart: nextAutostart, wake: { hotkey: nextWakeHotkey, ...(payload.wake?.modelId ? { modelId: payload.wake.modelId } : {}), voiceEnabled: payload.wake?.voiceEnabled === true, voicePhrase: payload.wake?.voicePhrase } });
  } catch (error) {
    if (autostartChanged) {
      try { writeAutostart(previousAutostart); } catch { /* Keep the original save error visible. */ }
    }
    if (registeredNewShortcut) globalShortcut.unregister(nextWakeHotkey);
    throw error;
  }
  if (registeredNewShortcut) {
    if (previousWakeHotkey) globalShortcut.unregister(previousWakeHotkey);
    activeWakeShortcut = nextWakeHotkey;
  }
  sentryTelemetryEnabled = saved.telemetry.enabled;
  initializeSentry();
  telemetry?.setEnabled(saved.telemetry.enabled);
  sendToAppWindows("settings:changed", saved);
  updateManager?.setPreferences(saved.updates);
  closeVoiceWakeWindow();
  if (saved.wake.voiceEnabled) void startConfiguredVoiceWake().catch((error) => {
    logMain("voice-wake.start.failed", { error: String(error) });
    recordTelemetryFailure({ type: "speech.failed", error, context: { phase: "voice-wake-start" } });
  });
  return saved;
});
ipcMain.on("wake:context", (_event, payload: unknown) => {
  if (!payload || typeof payload !== "object") return;
  const candidate = payload as Record<string, unknown>;
  activeWakeContext = {
    ...(typeof candidate.sessionId === "string" ? { sessionId: candidate.sessionId } : {}),
    ...(typeof candidate.modelId === "string" ? { modelId: candidate.modelId } : {}),
    ...(typeof candidate.reasoningEffort === "string" ? { reasoningEffort: candidate.reasoningEffort as ReasoningEffort } : {})
  };
});
ipcMain.handle("wake:close", () => { closeWakeWindow(); return { ok: true }; });
ipcMain.on("wake:interactive", (_event, interactive: boolean) => { if (wakeWindow && !wakeWindow.isDestroyed()) wakeWindow.setIgnoreMouseEvents(!interactive); });
ipcMain.handle("speech:start", (event) => {
  const target = wakeWindow?.webContents.id === event.sender.id ? wakeWindow : windowRef;
  logMain("speech.start", { window: target === wakeWindow ? "wake" : "main" });
  try {
    const result = startSpeech(target);
    logMain("speech.start.ready", { window: target === wakeWindow ? "wake" : "main", remote: result.remote });
    return result;
  }
  catch (error) { recordTelemetryFailure({ type: "speech.failed", error, context: { phase: "start" } }); throw error; }
});
ipcMain.handle("speech:stop", () => { logMain("speech.stop"); stopSpeech(); return { ok: true }; });
ipcMain.handle("speech:cancel", () => { logMain("speech.cancel"); cancelSpeech(); return { ok: true }; });
ipcMain.handle("voice-wake:start", (event, phrase: string) => {
  try {
    return startVoiceWake(voiceWakeWindow?.webContents.id === event.sender.id ? voiceWakeWindow : undefined, phrase, () => {
      // Keep the hidden microphone window alive so the listener can be resumed
      // after the one-shot wake overlay closes.
      stopVoiceWake();
      void openWakeWindow().catch((error) => logMain("wake.open.failed", { error: String(error), reason: "voice" }));
    });
  } catch (error) { recordTelemetryFailure({ type: "speech.failed", error, context: { phase: "voice-wake-start" } }); throw error; }
});
ipcMain.handle("voice-wake:stop", () => { stopVoiceWake(); return { ok: true }; });
ipcMain.on("voice-wake:log", (_event, payload: unknown) => {
  const data = payload && typeof payload === "object" ? payload : { detail: String(payload) };
  console.info("[voice-wake] renderer", data);
  logMain("voice-wake.renderer", data);
});
ipcMain.on("speech:log", (_event, payload: unknown) => {
  const data = payload && typeof payload === "object" ? payload : { detail: String(payload) };
  console.info("[speech] renderer", data);
  logMain("speech.renderer", data);
});
ipcMain.handle("tts:synthesize", async (_event, text: string) => {
  if (typeof text !== "string" || !text.trim()) return "";
  const clean = text.slice(0, 1800);
  logMain("tts.synthesize.start", { characters: clean.length });
  try {
    const { config } = loadConfig(DEFAULT_WORKSPACE);
    const audio = await synthesizeSpeech(clean, config.tts);
    const encoded = audio.toString("base64");
    logMain("tts.synthesize.success", { bytes: audio.length, base64Characters: encoded.length, voice: config.tts?.voice, rate: config.tts?.rate });
    return encoded;
  } catch (error) {
    logMain("tts.synthesize.failed", { characters: clean.length, message: error instanceof Error ? error.message : String(error) });
    recordTelemetryFailure({ type: "speech.failed", error, context: { phase: "tts", inputLength: clean.length } });
    throw error;
  }
});
ipcMain.on("wake:tts-log", (_event, payload: unknown) => logMain("wake.tts.playback", payload));
ipcMain.on("speech:audio", (_event, samples: Float32Array) => sendSpeechAudio(samples));
ipcMain.on("voice-wake:audio", (_event, samples: Float32Array) => sendVoiceWakeAudio(samples));
ipcMain.handle("sessions:stop", (_event, id: string) => {
  const controller = activeSessionRuns.get(id);
  if (!controller) return { ok: true, stopped: false };
  controller.abort();
  return { ok: true, stopped: true };
});
ipcMain.handle("sessions:send", async (_event, id: string, text: string, modelId?: string, reasoningEffort: ReasoningEffort = "high", rawAttachments?: unknown) => {
  const attachments = normalizeAttachments(rawAttachments);
  if (typeof text !== "string" || (!text.trim() && !attachments.length)) throw new Error("消息不能为空");
  const sessionStore = store();
  const before = sessionStore.get(id);
  sessionStore.appendMessage(id, "user", text, undefined, undefined, attachments);
  const { workspace, config } = loadConfig(DEFAULT_WORKSPACE);
  useConfiguredModel(config, modelId);
  const requestedReasoningEffort: ReasoningEffort = ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(reasoningEffort) ? reasoningEffort : "high";
  const selectedReasoningEffort = normalizeReasoningEffort(config.agent, requestedReasoningEffort);
  const audit = new AuditStore(workspace);
  const abortController = new AbortController();
  activeSessionRuns.set(id, abortController);
  let traceSequence = 0;
  const toolCalls: ToolCallRecord[] = [];
  const activities: AssistantActivity[] = [];
  let runtime: SecAgentRuntime | undefined;
  const isWakeRequest = Boolean(wakeWindow && wakeWindow.webContents.id === _event.sender.id);
  const shouldGenerateTitle = !before.messages.some((message) => message.role === "user");
  const preRule = await pluginManager?.matchPreRule(text);
  const titlePromise = shouldGenerateTitle && !preRule
    ? generateSessionTitle(config, text, attachments, abortController.signal).catch((error) => {
      logMain("session.title.failed", { sessionId: id, error: error instanceof Error ? error.message : String(error) });
      return "";
    })
    : Promise.resolve("");
  if (isWakeRequest) wakeAbortController = abortController;
  const trace = (event: Omit<TraceEvent, "sequence" | "at"> | TraceEvent) => {
    // The main process owns the sequence so its own request/error events and runtime events share
    // one strictly ordered timeline.
    const ordered: TraceEvent = { ...event, sequence: ++traceSequence, at: new Date().toISOString() };
    if (ordered.stage === "model.output.delta") {
      const data = ordered.data as { text?: unknown; kind?: unknown; turn?: unknown };
      const kind = data.kind === "thinking" || data.kind === "summary" ? data.kind : undefined;
      if (kind && typeof data.text === "string") {
        const last = activities.at(-1);
        if (last?.kind === kind) last.content += data.text;
        else activities.push({ kind, content: data.text, ...(typeof data.turn === "number" ? { turn: data.turn } : {}) });
      }
    }
    if (ordered.stage === "mcp.tools/call" || ordered.stage === "secagent.tools/call") {
      const data = ordered.data as { name?: unknown; arguments?: unknown };
      if (typeof data.name === "string") {
        toolCalls.push({ name: data.name, arguments: data.arguments ?? {} });
        activities.push({ kind: "tool", name: data.name, arguments: data.arguments ?? {} });
      }
    }
    if (ordered.stage === "secagent.skills/auto-load") {
      const skills = Array.isArray(ordered.data) ? ordered.data as Array<{ name?: unknown; path?: unknown }> : [];
      for (const skill of skills) if (typeof skill.name === "string" && typeof skill.path === "string") activities.push({ kind: "skill-auto-load", name: skill.name, path: skill.path });
    }
    if (ordered.stage === "mcp.tools/result" || ordered.stage === "secagent.tools/result") {
      const data = ordered.data as { name?: unknown; result?: unknown };
      if (typeof data.name === "string") {
        const call = [...toolCalls].reverse().find((item) => item.name === data.name && !("result" in item));
        if (call) call.result = data.result;
        const activity = [...activities].reverse().find((item): item is Extract<AssistantActivity, { kind: "tool" }> => item.kind === "tool" && item.name === data.name && !("result" in item));
        if (activity) activity.result = data.result;
      }
    }
    sessionStore.appendRuntimeEvent(id, ordered);
    telemetry?.addBreadcrumb(ordered);
    const data = ordered.data && typeof ordered.data === "object" ? ordered.data as Record<string, unknown> : {};
    if (ordered.stage === "mcp.tools/error") recordTelemetryFailure({ type: "mcp.discovery.failed", context: { sessionId: hashIdentifier(id), stage: ordered.stage } });
    if ((ordered.stage === "mcp.tools/result" || ordered.stage === "secagent.tools/result") && data.result && typeof data.result === "object" && "error" in (data.result as Record<string, unknown>)) {
      recordTelemetryFailure({ type: "tool.call.failed", error: new Error("tool returned an error"), context: { sessionId: hashIdentifier(id), tool: typeof data.name === "string" ? data.name : undefined } });
    }
    if (ordered.stage === "model.response" && typeof data.status === "number" && data.status >= 400) {
      recordTelemetryFailure({ type: data.status === 408 || data.status === 504 ? "model.timeout" : data.status === 429 ? "model.rate_limited" : data.status === 401 || data.status === 403 ? "model.auth_failed" : data.status === 400 ? "model.response.invalid" : "model.request.failed", context: { sessionId: hashIdentifier(id), status: data.status } });
    }
    logMain("session.runtime", { sessionId: id, ...ordered });
    sendToAppWindows("sessions:runtime-event", { sessionId: id, ...ordered });
  };
  try {
    logMain("ipc.sessions.send", { sessionId: id, text });
    trace({ stage: "user.request", data: { text } });
    const skills = [...loadEnabledSkills(config), ...(pluginManager?.getSkills() || [])];
    const visionConfig = resolveVisionAgentConfig(config);
    if (visionConfig) logMain("session.vision-model", { model: visionConfig.agent.model, provider: visionConfig.agent.provider, baseUrl: visionConfig.agent.baseUrl });
    const runtimeConfig = isWakeRequest
      ? { ...config, agent: { ...config.agent, systemPrompt: `${config.agent.systemPrompt}\n\n## 快速唤起输出协议\n${QUICK_WAKE_OUTPUT_PROMPT}` } }
      : config;
    runtime = new SecAgentRuntime(runtimeConfig, audit, skills, trace, pluginManager, visionConfig);
    const previousReadSkillNames = before.messages.flatMap((message) => message.toolCalls || []).filter((call) => call.name === "secagent__read_skill" || call.name === "read_skill").map((call) => typeof (call.arguments as { name?: unknown })?.name === "string" ? (call.arguments as { name: string }).name : "");
    const result = await runtime.run(historyInput(before, text), selectedReasoningEffort, conversationInput(before, text, attachments), abortController.signal, { previousAutoLoadedSkills: before.autoLoadedSkills, previousReadSkillNames, preRule });
    if (result.autoLoadedSkills?.length) {
      const current = sessionStore.get(id);
      current.autoLoadedSkills = [...new Set([...(current.autoLoadedSkills || []), ...result.autoLoadedSkills])];
      // Reuse the store's normal persistence path without adding a visible message.
      sessionStore.setAutoLoadedSkills(id, current.autoLoadedSkills);
    }
    sessionStore.appendMessage(id, "assistant", result.message, toolCalls, activities);
    const title = await titlePromise;
    if (title) sessionStore.setTitle(id, title);
    trace({ stage: "assistant.response", data: { text: result.message } });
    return sessionStore.get(id);
  } catch (error) {
    const title = await titlePromise;
    if (title) sessionStore.setTitle(id, title);
    if (abortController.signal.aborted) {
      sessionStore.appendMessage(id, "assistant", "", toolCalls, activities, undefined, true);
      trace({ stage: "runtime.stopped", data: { toolCount: toolCalls.length } });
      return sessionStore.get(id);
    }
    const message = `执行失败：${error instanceof Error ? error.message : String(error)}`;
    sessionStore.appendMessage(id, "assistant", message, toolCalls, activities);
    trace({ stage: "runtime.error", data: { message } });
    recordTelemetryFailure({ type: classifyAgentFailure(error), error, context: { sessionId: hashIdentifier(id), model: config.agent.model, provider: config.agent.provider, inputLength: text.length, attachmentCount: attachments.length, toolCount: toolCalls.length } });
    return sessionStore.get(id);
  } finally {
    if (activeSessionRuns.get(id) === abortController) activeSessionRuns.delete(id);
    if (wakeAbortController === abortController) wakeAbortController = undefined;
    await runtime?.close().catch(() => undefined);
    audit.close();
  }
});

// A second launch focuses the running instance instead of competing for the
// wake shortcut, the tray, and the local HTTP server port.
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => showMainWindow());
app.whenReady().then(async () => {
  if (!app.hasSingleInstanceLock()) return;
  const needsOnboarding = !fs.existsSync(configPath(DEFAULT_WORKSPACE)) || !isOnboardingComplete(DEFAULT_WORKSPACE);
  initializeWorkspace(DEFAULT_WORKSPACE);
  const initialSettings = readSettings(DEFAULT_WORKSPACE);
  sentryTelemetryEnabled = initialSettings.telemetry.enabled;
  telemetry = new TelemetryClient({
    baseUrl: process.env.SECTL_OFFICIAL_API_URL || "",
    storageDirectory: app.getPath("userData"),
    appVersion: app.getVersion(),
    enabled: initialSettings.telemetry.enabled,
    getAuthToken: () => process.env.SECTL_OFFICIAL_TOKEN || undefined
  });
  telemetry.start();
  if (SENTRY_DSN) Sentry.getCurrentScope().setTags({ app_version: app.getVersion(), platform: process.platform, arch: process.arch });
  updateManager = new WindowsUpdateManager({
    currentVersion: app.getVersion(),
    preferences: initialSettings.updates,
    platform: process.platform,
    isPackaged: app.isPackaged,
    storageDirectory: app.getPath("userData"),
    publish: (state) => {
      sendToAppWindows("updates:state", state);
      if (state.status === "error") recordTelemetryFailure({ type: "update.failed", error: new Error(state.error || "update failed"), context: { channel: state.channel } });
    },
    quit: () => app.quit(),
    launchInstaller: launchWindowsInstaller,
    log: logMain
  });
  // An autostart launch that finds a fully downloaded update installs it
  // immediately and exits; the installer's /RESTARTAPPLICATIONS brings the
  // (updated) app back without the --autostart argument, so the fresh session
  // shows the main window normally. Manual launches are not interrupted.
  if (isAutostartLaunch() && updateManager.hasPendingInstall()) {
    logMain("updates.install.on.autostart", { version: updateManager.getState().downloadedVersion });
    void updateManager.verifyPendingChecksum().then((valid) => {
      if (valid) {
        try {
          updateManager?.install();
          return;
        } catch (error) {
          logMain("updates.install.on.autostart.failed", { error: error instanceof Error ? error.message : String(error) });
        }
      }
      // Nothing to install (or checksum failed) - continue the normal startup.
      void startApplication();
    });
    return;
  }
  await startApplication();
});
async function startApplication(): Promise<void> {
  const needsOnboarding = !fs.existsSync(configPath(DEFAULT_WORKSPACE)) || !isOnboardingComplete(DEFAULT_WORKSPACE);
  const initialSettings = readSettings(DEFAULT_WORKSPACE);
  pluginManager = new PluginManager(DEFAULT_WORKSPACE, {
    getSession: async () => {
      loadConfig(DEFAULT_WORKSPACE);
      const accessToken = process.env.SECTL_OFFICIAL_TOKEN || "";
      return accessToken ? { accessToken, userId: process.env.SECTL_OFFICIAL_USER_ID || undefined, email: process.env.SECTL_OFFICIAL_EMAIL || undefined } : null;
    },
    oauthLogin: runSectlOAuthLogin,
  }, openPluginSvgPreview);
  try { await pluginManager.initialize(); }
  catch (error) {
    recordTelemetryFailure({ type: "plugin.start.failed", error, context: { phase: "initialize" } });
    throw error;
  }
  secAgentHttpServer = new SecAgentHttpServer(pluginManager, marketplace);
  try { await secAgentHttpServer.start(); }
  catch (error) { logMain("secagent-http.error", { message: error instanceof Error ? error.message : String(error), port: 42189 }); }
  pluginManager.onChanged(() => {
    const list = pluginManager?.list() || [];
    windowRef?.webContents.send("plugins:changed", list);
    settingsWindow?.webContents.send("plugins:changed", list);
  });
  const initialMarketplaceUpdate = setTimeout(() => { void updateInstalledPlugins(); }, 5_000);
  initialMarketplaceUpdate.unref?.();
  marketplaceUpdateTimer = setInterval(() => { void updateInstalledPlugins(); }, MARKETPLACE_UPDATE_INTERVAL_MS);
  marketplaceUpdateTimer.unref?.();
  const initialUpdateCheck = setTimeout(() => { void updateManager?.check(true); }, 5_000);
  initialUpdateCheck.unref?.();
  updateCheckTimer = setInterval(() => { void updateManager?.check(true); }, UPDATE_CHECK_INTERVAL_MS);
  updateCheckTimer.unref?.();
  // Electron otherwise rejects getUserMedia requests in some desktop environments.
  // Speech audio is streamed to the official cloud ASR service.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
  installFileRendererAssetFallback();
  createApplicationMenu();
  createTray();
  if (process.platform === "darwin") {
    // The wake overlay skips the Dock, but SecAgent itself remains a regular
    // application while the overlay is visible over full-screen Spaces.
    await ensureMacDockVisible();
    app.dock?.setIcon(appIconPath());
  }
  logMain("app.ready");
  // An autostart launch stays in the tray (voice wake and shortcuts keep running)
  // unless the user turned the "hide the main window after autostart" option off.
  createWindow(!needsOnboarding && (!isAutostartLaunch() || initialSettings.autostartHidden === false));
  try {
    registerWakeShortcut(initialSettings.wake.hotkey || DEFAULT_WAKE_HOTKEY);
    if (initialSettings.wake.voiceEnabled) void startConfiguredVoiceWake().catch((error) => {
      logMain("voice-wake.start.failed", { error: String(error) });
      recordTelemetryFailure({ type: "speech.failed", error, context: { phase: "voice-wake-start" } });
    });
  }
  catch (error) { logMain("wake.shortcut.register.failed", { error: error instanceof Error ? error.message : String(error) }); }
  if (needsOnboarding) openSettings(true);
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}
app.on("before-quit", () => { updateManager?.handleBeforeQuit(); isQuitting = true; closeWakeWindow(); closeVoiceWakeWindow(); globalShortcut.unregisterAll(); if (marketplaceUpdateTimer) clearInterval(marketplaceUpdateTimer); if (updateCheckTimer) clearInterval(updateCheckTimer); void secAgentHttpServer?.stop(); void pluginManager?.shutdown(); telemetry?.stop(); });
app.on("window-all-closed", () => { /* Keep the process alive so the tray can reopen the main window. */ });
