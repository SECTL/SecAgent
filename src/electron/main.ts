import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_WORKSPACE } from "../paths.js";
import { configuredModels, configPath, initializeWorkspace, isOnboardingComplete, loadConfig, markOnboardingComplete, readSettings, saveSettings, useConfiguredModel, type SettingsPayload } from "../config.js";
import { loadEnabledSkills } from "../skills.js";
import { AuditStore } from "../audit.js";
import { SecAgentRuntime, type TraceEvent } from "../runtime.js";
import type { ConversationMessage } from "../model-provider.js";
import { SessionStore, type AssistantActivity, type SessionData, type ToolCallRecord } from "../session-store.js";
import { sendSpeechAudio, startSpeech, stopSpeech } from "./speech.js";
import type { ChatAttachment, ReasoningEffort } from "../types.js";
import { listGoogleModels } from "../google-models.js";
import { synthesizeSpeech } from "./tts.js";
import { PluginManager } from "../plugin-manager.js";
import { MarketplaceClient, type MarketplacePlugin, type MarketplaceVersion } from "../marketplace.js";
import { SecAgentHttpServer } from "../secagent-http.js";

let windowRef: BrowserWindow | undefined;
let settingsWindow: BrowserWindow | undefined;
let pluginManager: PluginManager | undefined;
let secAgentHttpServer: SecAgentHttpServer | undefined;
const marketplace = new MarketplaceClient();

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

function createWindow(): void {
  windowRef = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: "",
    titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 16, y: 21 } } : {}),
    icon: appIconPath(),
    webPreferences: { preload: path.join(__dirname, "../preload/preload.cjs"), contextIsolation: true, nodeIntegration: false }
  });
  logMain("window.created");
  if (process.env.ELECTRON_RENDERER_URL) windowRef.loadURL(process.env.ELECTRON_RENDERER_URL);
  else windowRef.loadFile(path.join(__dirname, "../renderer/index.html"));
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
    title: "设置",
    parent: windowRef,
    modal: false,
    icon: appIconPath(),
    webPreferences: { preload: path.join(__dirname, "../preload/preload.cjs"), contextIsolation: true, nodeIntegration: false }
  });
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
ipcMain.handle("models:list", async () => {
  const { config } = loadConfig(DEFAULT_WORKSPACE);
  const googleProfile = config.agent.models?.find((model) => model.provider === "google");
  const googleModels = googleProfile ? await listGoogleModels(process.env[googleProfile.apiKeyEnv] || "", googleProfile.baseUrl).catch(() => []) : [];
  return configuredModels(config, googleModels);
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
ipcMain.handle("plugins:list", () => pluginManager?.list() || []);
ipcMain.handle("plugins:set-enabled", async (_event, id: string, enabled: boolean) => { await pluginManager?.setEnabled(id, enabled); return pluginManager?.list() || []; });
ipcMain.handle("plugins:reload", async (_event, id: string) => { await pluginManager?.reload(id); return pluginManager?.list() || []; });
ipcMain.handle("plugins:install", async () => {
  const result = await dialog.showOpenDialog(settingsWindow || windowRef!, { properties: ["openFile"], filters: [{ name: "SecAgent plugin", extensions: ["zip"] }] });
  if (result.canceled || !result.filePaths[0]) return pluginManager?.list() || [];
  await pluginManager?.install(result.filePaths[0]);
  return pluginManager?.list() || [];
});
ipcMain.handle("marketplace:list", () => marketplace.list());
ipcMain.handle("marketplace:install", async (_event, version: MarketplaceVersion) => { if (!pluginManager) throw new Error("插件管理器尚未启动"); await marketplace.install(pluginManager, version); return pluginManager.list(); });
ipcMain.handle("settings:save", (_event, payload: SettingsPayload) => {
  const saved = saveSettings(DEFAULT_WORKSPACE, payload);
  markOnboardingComplete(DEFAULT_WORKSPACE);
  windowRef?.webContents.send("settings:changed", saved);
  return saved;
});
ipcMain.handle("speech:start", () => startSpeech(windowRef));
ipcMain.handle("speech:stop", () => { stopSpeech(); return { ok: true }; });
ipcMain.handle("tts:synthesize", async (_event, text: string) => {
  if (typeof text !== "string" || !text.trim()) return "";
  const { config } = loadConfig(DEFAULT_WORKSPACE);
  const audio = await synthesizeSpeech(text.slice(0, 1800), config.tts);
  return audio.toString("base64");
});
ipcMain.on("speech:audio", (_event, samples: Float32Array) => sendSpeechAudio(samples));
ipcMain.handle("sessions:send", async (_event, id: string, text: string, modelId?: string, reasoningEffort: ReasoningEffort = "high", rawAttachments?: unknown) => {
  const attachments = normalizeAttachments(rawAttachments);
  if (typeof text !== "string" || (!text.trim() && !attachments.length)) throw new Error("消息不能为空");
  const sessionStore = store();
  const before = sessionStore.get(id);
  sessionStore.appendMessage(id, "user", text, undefined, undefined, attachments);
  const { workspace, config } = loadConfig(DEFAULT_WORKSPACE);
  useConfiguredModel(config, modelId);
  const selectedReasoningEffort: ReasoningEffort = ["none", "low", "medium", "high"].includes(reasoningEffort) ? reasoningEffort : "high";
  const audit = new AuditStore(workspace);
  let traceSequence = 0;
  const toolCalls: ToolCallRecord[] = [];
  const activities: AssistantActivity[] = [];
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
    windowRef?.webContents.send("sessions:runtime-event", { sessionId: id, ...ordered });
  };
  try {
    logMain("ipc.sessions.send", { sessionId: id, text });
    trace({ stage: "user.request", data: { text } });
    const skills = [...loadEnabledSkills(config), ...(pluginManager?.getSkills() || [])];
    const runtime = new SecAgentRuntime(config, audit, skills, trace, pluginManager);
    const result = await runtime.run(historyInput(before, text), selectedReasoningEffort, conversationInput(before, text, attachments));
    sessionStore.appendMessage(id, "assistant", result.message, toolCalls, activities);
    trace({ stage: "assistant.response", data: { text: result.message } });
    return sessionStore.get(id);
  } catch (error) {
    const message = `执行失败：${error instanceof Error ? error.message : String(error)}`;
    sessionStore.appendMessage(id, "assistant", message, toolCalls, activities);
    trace({ stage: "runtime.error", data: { message } });
    return sessionStore.get(id);
  } finally { audit.close(); }
});

app.whenReady().then(async () => {
  const needsOnboarding = !fs.existsSync(configPath(DEFAULT_WORKSPACE)) || !isOnboardingComplete(DEFAULT_WORKSPACE);
  initializeWorkspace(DEFAULT_WORKSPACE);
  pluginManager = new PluginManager(DEFAULT_WORKSPACE);
  await pluginManager.initialize();
  secAgentHttpServer = new SecAgentHttpServer(pluginManager, marketplace);
  try { await secAgentHttpServer.start(); }
  catch (error) { logMain("secagent-http.error", { message: error instanceof Error ? error.message : String(error), port: 42189 }); }
  pluginManager.onChanged(() => {
    const list = pluginManager?.list() || [];
    windowRef?.webContents.send("plugins:changed", list);
    settingsWindow?.webContents.send("plugins:changed", list);
  });
  // Electron otherwise rejects getUserMedia requests in some desktop environments.
  // Speech audio is only used by the local recognizer and is never sent to a server.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
  installFileRendererAssetFallback();
  createApplicationMenu();
  if (process.platform === "darwin") app.dock?.setIcon(appIconPath());
  logMain("app.ready");
  createWindow();
  if (needsOnboarding) openSettings(true);
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("before-quit", () => { void secAgentHttpServer?.stop(); void pluginManager?.shutdown(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
