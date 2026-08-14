import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, screen, session, shell } from "electron";
import { createServer } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_WORKSPACE } from "../paths.js";
import { configuredModels, configPath, initializeWorkspace, isOnboardingComplete, loadConfig, markOnboardingComplete, readSettings, saveSettings, useConfiguredModel, writeWorkspaceEnv, type SettingsPayload } from "../config.js";
import { loadEnabledSkills } from "../skills.js";
import { AuditStore } from "../audit.js";
import { SecAgentRuntime, type TraceEvent } from "../runtime.js";
import type { ConversationMessage } from "../model-provider.js";
import { SessionStore, type AssistantActivity, type SessionData, type ToolCallRecord } from "../session-store.js";
import { sendSpeechAudio, sendVoiceWakeAudio, startSpeech, startVoiceWake, stopSpeech, stopVoiceWake } from "./speech.js";
import type { ChatAttachment, ReasoningEffort } from "../types.js";
import { listGoogleModels } from "../google-models.js";
import { synthesizeSpeech } from "./tts.js";
import { PluginManager, type SvgPreviewRequest } from "../plugin-manager.js";
import { MarketplaceClient, type MarketplacePlugin, type MarketplaceVersion } from "../marketplace.js";
import { SecAgentHttpServer } from "../secagent-http.js";
import { Models } from "@opencode-ai/models";
import { DEFAULT_WAKE_HOTKEY, normalizeWakeHotkey } from "../wake-hotkey.js";

let windowRef: BrowserWindow | undefined;
let settingsWindow: BrowserWindow | undefined;
let wakeWindow: BrowserWindow | undefined;
let voiceWakeWindow: BrowserWindow | undefined;
let pluginManager: PluginManager | undefined;
let secAgentHttpServer: SecAgentHttpServer | undefined;
let activeWakeShortcut: string | undefined;
let activeWakeContext: { sessionId?: string; modelId?: string; reasoningEffort?: ReasoningEffort } = {};
let wakeAbortController: AbortController | undefined;
const marketplace = new MarketplaceClient();
const activeSessionRuns = new Map<string, AbortController>();
const MARKETPLACE_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let marketplaceUpdateTimer: NodeJS.Timeout | undefined;

async function updateInstalledPlugins(): Promise<void> {
  if (!pluginManager) return;
  try {
    const updates = await marketplace.updateInstalled(pluginManager);
    if (updates.length) logMain("marketplace.plugins.updated", { updates });
    else logMain("marketplace.plugins.checked", { updated: 0 });
  } catch (error) {
    logMain("marketplace.plugins.update.failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

function appIconPath(): string {
  const bundledIcon = path.join(__dirname, "../renderer/icon.png");
  return fs.existsSync(bundledIcon) ? bundledIcon : path.join(process.cwd(), "src/renderer/public/icon.png");
}

function installFileRendererAssetFallback(): void {
  const publicAssets = new Set(["icon.svg", "icon.png", "session-chevron.svg", "image-icon.svg", "mic-icon.svg"]);
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
  fs.appendFileSync(path.join(logDir, "electron-main.jsonl"), JSON.stringify({ at: new Date().toISOString(), stage, data }) + "\n", "utf8");
}

function windowChromeOptions(): Electron.BrowserWindowConstructorOptions {
  if (process.platform === "darwin") {
    return { titleBarStyle: "hidden", trafficLightPosition: { x: 16, y: 21 } };
  }
  if (process.platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#ffffff", symbolColor: "#171717", height: 57 },
      autoHideMenuBar: true
    };
  }
  return {};
}

function configureWindowChrome(window: BrowserWindow): void {
  if (process.platform !== "win32") return;
  // Keep the application menu alive for CmdOrCtrl+, and Ctrl+Shift+I while hiding its UI.
  window.setAutoHideMenuBar(true);
  window.setMenuBarVisibility(false);
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
  for (const target of [windowRef, wakeWindow]) {
    if (!target || target.isDestroyed() || target.webContents.isDestroyed()) continue;
    try {
      target.webContents.send(channel, payload);
    } catch {
      // A renderer may close between the destroyed check and send().
    }
  }
}

function closeWakeWindow(): void {
  wakeAbortController?.abort();
  wakeAbortController = undefined;
  stopSpeech();
  if (wakeWindow && !wakeWindow.isDestroyed()) wakeWindow.close();
  wakeWindow = undefined;
}

function closeVoiceWakeWindow(): void {
  stopVoiceWake();
  if (voiceWakeWindow && !voiceWakeWindow.isDestroyed()) voiceWakeWindow.close();
  voiceWakeWindow = undefined;
}

async function startConfiguredVoiceWake(): Promise<void> {
  const settings = readSettings(DEFAULT_WORKSPACE);
  if (!settings.wake.voiceEnabled) { closeVoiceWakeWindow(); return; }
  if (voiceWakeWindow && !voiceWakeWindow.isDestroyed()) return;
  const phrase = settings.wake.voicePhrase || "小泽同学";
  voiceWakeWindow = new BrowserWindow({
    width: 1, height: 1, show: false, frame: false, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, "../preload/preload.cjs"), contextIsolation: true, nodeIntegration: false, autoplayPolicy: "no-user-gesture-required" }
  });
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
  wakeWindow.setAlwaysOnTop(true, "floating");
  // The overlay should not block the application below. Mouse-move events are
  // still forwarded to the renderer so it can temporarily enable interaction
  // when the pointer is over the visible response card.
  wakeWindow.setIgnoreMouseEvents(true, { forward: true });
  wakeWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") closeWakeWindow();
  });
  const showWakeWindow = () => {
    if (!wakeWindow || wakeWindow.isDestroyed()) return;
    if (!wakeWindow.isVisible()) wakeWindow.show();
    wakeWindow.focus();
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

function createWindow(): void {
  windowRef = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: "SecAgent",
    ...windowChromeOptions(),
    icon: appIconPath(),
    webPreferences: { preload: path.join(__dirname, "../preload/preload.cjs"), contextIsolation: true, nodeIntegration: false }
  });
  configureWindowChrome(windowRef);
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
    parent: windowRef,
    modal: false,
    ...windowChromeOptions(),
    icon: appIconPath(),
    webPreferences: { preload: path.join(__dirname, "../preload/preload.cjs"), contextIsolation: true, nodeIntegration: false }
  });
  configureWindowChrome(settingsWindow);
  settingsWindow.on("page-title-updated", (event) => { event.preventDefault(); });
  settingsWindow.setTitle("SecAgent设置");
  const query = oobe ? "?settings=1&oobe=1" : "?settings=1";
  if (process.env.ELECTRON_RENDERER_URL) settingsWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}${query}`);
  else settingsWindow.loadFile(path.join(__dirname, "../renderer/index.html"), { query: oobe ? { settings: "1", oobe: "1" } : { settings: "1" } });
  settingsWindow.on("closed", () => { settingsWindow = undefined; });
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

function historyInput(session: SessionData, current: string): string {
  const history = session.messages.slice(-20).map((message) => `${message.role === "user" ? "教师" : "SecAgent"}：${message.content}`).join("\n");
  return history ? `以下是当前会话的历史，请结合上下文理解最后一条新消息。\n\n${history}\n\n教师的新消息：${current}` : current;
}

function conversationInput(session: SessionData, current: string, attachments: ChatAttachment[] = []): ConversationMessage[] {
  const history = session.messages.slice(-20).map((message) => ({ role: message.role, content: message.content, ...(message.attachments?.length ? { attachments: message.attachments } : {}) }));
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
    const response = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${token}` } });
    const payload = await response.json() as { data?: Array<{ id?: string; name?: string }> };
    const remote = (payload.data || []).filter((model) => model.id).map((model) => ({ id: `official:sectl-official:${model.id}`, name: model.name || model.id || "官方模型", model: model.id || "", provider: "openai-responses" }));
    // 低延迟档位暂不开放（回头再用）。
    const visibleRemote = remote.filter((model) => model.model !== "virtual-latency");
    if (customModelMode) {
      // 自定义模型模式开启：官方模型（含虚拟档位）与自定义模型全部可选。
      return [...visibleRemote, ...options];
    }
    // 关闭：官方档位模式 —— 下拉只有快速/标准/深度三个虚拟档位，看不到具体模型。
    return visibleRemote.filter((model) => (OFFICIAL_TIER_IDS as readonly string[]).includes(model.model));
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
ipcMain.handle("settings:get", () => readSettings(DEFAULT_WORKSPACE));
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
  if (!token || !baseUrl) return { points: null, expired: false };
  const response = await fetch(`${baseUrl}/account`, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await response.json().catch(() => ({})) as { points?: number; detail?: string };
  if (response.status === 401) return { points: null, expired: true };
  if (!response.ok || typeof payload.points !== "number") throw new Error(payload.detail || "无法获取 Points 余额");
  return { points: payload.points, expired: false };
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
  const response = await fetch(`${oauthUrl}/api/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code: callback.code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier, device_uuid: crypto.randomUUID() }) });
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
  const tokenResponse = await fetch(`${oauthUrl}/api/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code: callback.code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier, device_uuid: crypto.randomUUID() }) });
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
ipcMain.handle("plugins:settings-call", async (_event, pluginId: string, pageId: string, action: string, args: Record<string, unknown> = {}) => pluginManager?.callSettings(pluginId, pageId, action, args));
ipcMain.handle("plugins:set-enabled", async (_event, id: string, enabled: boolean) => { await pluginManager?.setEnabled(id, enabled); return pluginManager?.list() || []; });
ipcMain.handle("plugins:reload", async (_event, id: string) => { await pluginManager?.reload(id); return pluginManager?.list() || []; });
ipcMain.handle("plugins:uninstall", async (_event, id: string) => { await pluginManager?.uninstall(id); return pluginManager?.list() || []; });
ipcMain.handle("plugins:install", async () => {
  const result = await dialog.showOpenDialog(settingsWindow || windowRef!, { properties: ["openFile"], filters: [{ name: "SecAgent plugin", extensions: ["zip"] }] });
  if (result.canceled || !result.filePaths[0]) return pluginManager?.list() || [];
  await pluginManager?.install(result.filePaths[0]);
  return pluginManager?.list() || [];
});
ipcMain.handle("marketplace:list", () => marketplace.list());
ipcMain.handle("marketplace:install", async (_event, version: MarketplaceVersion) => { if (!pluginManager) throw new Error("插件管理器尚未启动"); await marketplace.install(pluginManager, version); return pluginManager.list(); });
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
  if (wakeShortcutChanged) {
    if (!globalShortcut.register(nextWakeHotkey, () => { void openWakeWindow().catch((error) => logMain("wake.open.failed", { error: String(error) })); })) throw new Error(`快捷键 ${nextWakeHotkey} 已被其它应用占用`);
  }
  let saved: SettingsPayload;
  try {
    saved = saveSettings(DEFAULT_WORKSPACE, { ...payload, providers, wake: { hotkey: nextWakeHotkey, ...(payload.wake?.modelId ? { modelId: payload.wake.modelId } : {}), voiceEnabled: payload.wake?.voiceEnabled === true, voicePhrase: payload.wake?.voicePhrase } });
  } catch (error) {
    if (wakeShortcutChanged) globalShortcut.unregister(nextWakeHotkey);
    throw error;
  }
  if (wakeShortcutChanged) {
    if (previousWakeHotkey) globalShortcut.unregister(previousWakeHotkey);
    activeWakeShortcut = nextWakeHotkey;
  }
  markOnboardingComplete(DEFAULT_WORKSPACE);
  sendToAppWindows("settings:changed", saved);
  closeVoiceWakeWindow();
  if (saved.wake.voiceEnabled) void startConfiguredVoiceWake().catch((error) => logMain("voice-wake.start.failed", { error: String(error) }));
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
ipcMain.handle("speech:start", (event) => startSpeech(wakeWindow?.webContents.id === event.sender.id ? wakeWindow : windowRef, { betterRecognition: readSettings(DEFAULT_WORKSPACE).speech.betterRecognition === true }));
ipcMain.handle("speech:stop", () => { stopSpeech(); return { ok: true }; });
ipcMain.handle("voice-wake:start", (event, phrase: string) => startVoiceWake(voiceWakeWindow?.webContents.id === event.sender.id ? voiceWakeWindow : undefined, phrase, () => {
  closeVoiceWakeWindow();
  void openWakeWindow().catch((error) => logMain("wake.open.failed", { error: String(error), reason: "voice" }));
}));
ipcMain.handle("voice-wake:stop", () => { stopVoiceWake(); return { ok: true }; });
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
  const selectedReasoningEffort: ReasoningEffort = ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(reasoningEffort) ? reasoningEffort : "high";
  const audit = new AuditStore(workspace);
  const abortController = new AbortController();
  activeSessionRuns.set(id, abortController);
  let traceSequence = 0;
  const toolCalls: ToolCallRecord[] = [];
  const activities: AssistantActivity[] = [];
  let runtime: SecAgentRuntime | undefined;
  const isWakeRequest = Boolean(wakeWindow && wakeWindow.webContents.id === _event.sender.id);
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
    logMain("session.runtime", { sessionId: id, ...ordered });
    sendToAppWindows("sessions:runtime-event", { sessionId: id, ...ordered });
  };
  try {
    logMain("ipc.sessions.send", { sessionId: id, text });
    trace({ stage: "user.request", data: { text } });
    const skills = [...loadEnabledSkills(config), ...(pluginManager?.getSkills() || [])];
    const runtimeConfig = isWakeRequest
      ? { ...config, agent: { ...config.agent, systemPrompt: `${config.agent.systemPrompt}\n\n## 快速唤起输出协议\n${QUICK_WAKE_OUTPUT_PROMPT}` } }
      : config;
    runtime = new SecAgentRuntime(runtimeConfig, audit, skills, trace, pluginManager);
    const previousReadSkillNames = before.messages.flatMap((message) => message.toolCalls || []).filter((call) => call.name === "secagent__read_skill" || call.name === "read_skill").map((call) => typeof (call.arguments as { name?: unknown })?.name === "string" ? (call.arguments as { name: string }).name : "");
    const result = await runtime.run(historyInput(before, text), selectedReasoningEffort, conversationInput(before, text, attachments), abortController.signal, { previousAutoLoadedSkills: before.autoLoadedSkills, previousReadSkillNames });
    if (result.autoLoadedSkills?.length) {
      const current = sessionStore.get(id);
      current.autoLoadedSkills = [...new Set([...(current.autoLoadedSkills || []), ...result.autoLoadedSkills])];
      // Reuse the store's normal persistence path without adding a visible message.
      sessionStore.setAutoLoadedSkills(id, current.autoLoadedSkills);
    }
    sessionStore.appendMessage(id, "assistant", result.message, toolCalls, activities);
    trace({ stage: "assistant.response", data: { text: result.message } });
    return sessionStore.get(id);
  } catch (error) {
    if (abortController.signal.aborted) {
      sessionStore.appendMessage(id, "assistant", "", toolCalls, activities, undefined, true);
      trace({ stage: "runtime.stopped", data: { toolCount: toolCalls.length } });
      return sessionStore.get(id);
    }
    const message = `执行失败：${error instanceof Error ? error.message : String(error)}`;
    sessionStore.appendMessage(id, "assistant", message, toolCalls, activities);
    trace({ stage: "runtime.error", data: { message } });
    return sessionStore.get(id);
  } finally {
    if (activeSessionRuns.get(id) === abortController) activeSessionRuns.delete(id);
    if (wakeAbortController === abortController) wakeAbortController = undefined;
    await runtime?.close().catch(() => undefined);
    audit.close();
  }
});

app.whenReady().then(async () => {
  const needsOnboarding = !fs.existsSync(configPath(DEFAULT_WORKSPACE)) || !isOnboardingComplete(DEFAULT_WORKSPACE);
  initializeWorkspace(DEFAULT_WORKSPACE);
  pluginManager = new PluginManager(DEFAULT_WORKSPACE, {
    getSession: async () => {
      loadConfig(DEFAULT_WORKSPACE);
      const accessToken = process.env.SECTL_OFFICIAL_TOKEN || "";
      return accessToken ? { accessToken, userId: process.env.SECTL_OFFICIAL_USER_ID || undefined, email: process.env.SECTL_OFFICIAL_EMAIL || undefined } : null;
    },
    oauthLogin: runSectlOAuthLogin,
  }, openPluginSvgPreview);
  await pluginManager.initialize();
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
  // Electron otherwise rejects getUserMedia requests in some desktop environments.
  // Speech audio is streamed to the official cloud ASR service.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
  installFileRendererAssetFallback();
  createApplicationMenu();
  if (process.platform === "darwin") app.dock?.setIcon(appIconPath());
  logMain("app.ready");
  createWindow();
  try {
    const initialSettings = readSettings(DEFAULT_WORKSPACE);
    registerWakeShortcut(initialSettings.wake.hotkey || DEFAULT_WAKE_HOTKEY);
    if (initialSettings.wake.voiceEnabled) void startConfiguredVoiceWake().catch((error) => logMain("voice-wake.start.failed", { error: String(error) }));
  }
  catch (error) { logMain("wake.shortcut.register.failed", { error: error instanceof Error ? error.message : String(error) }); }
  if (needsOnboarding) openSettings(true);
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("before-quit", () => { closeWakeWindow(); closeVoiceWakeWindow(); globalShortcut.unregisterAll(); if (marketplaceUpdateTimer) clearInterval(marketplaceUpdateTimer); void secAgentHttpServer?.stop(); void pluginManager?.shutdown(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
