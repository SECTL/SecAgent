import { app, BrowserWindow, ipcMain, Menu, session } from "electron";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_WORKSPACE } from "../paths.js";
import { configuredModels, initializeWorkspace, loadConfig, readSettings, saveSettings, useConfiguredModel, type SettingsPayload } from "../config.js";
import { loadEnabledSkills } from "../skills.js";
import { AuditStore } from "../audit.js";
import { SecAgentRuntime, type TraceEvent } from "../runtime.js";
import { SessionStore, type AssistantActivity, type SessionData, type ToolCallRecord } from "../session-store.js";
import { sendSpeechAudio, startSpeech, stopSpeech } from "./speech.js";
import { listGoogleModels } from "../google-models.js";

let windowRef: BrowserWindow | undefined;
let settingsWindow: BrowserWindow | undefined;

function appIconPath(): string {
  const bundledIcon = path.join(__dirname, "../renderer/icon.png");
  return fs.existsSync(bundledIcon) ? bundledIcon : path.join(process.cwd(), "src/renderer/public/icon.png");
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

function openSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    title: "设置",
    parent: windowRef,
    modal: false,
    icon: appIconPath(),
    webPreferences: { preload: path.join(__dirname, "../preload/preload.cjs"), contextIsolation: true, nodeIntegration: false }
  });
  if (process.env.ELECTRON_RENDERER_URL) settingsWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}?settings=1`);
  else settingsWindow.loadFile(path.join(__dirname, "../renderer/index.html"), { query: { settings: "1" } });
  settingsWindow.on("closed", () => { settingsWindow = undefined; });
}

function createApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    { label: "文件", submenu: [{ label: "设置…", accelerator: "CmdOrCtrl+,", click: openSettings }, { type: "separator" }, { role: "quit" }] },
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function store(): SessionStore { return new SessionStore(DEFAULT_WORKSPACE); }

function historyInput(session: SessionData, current: string): string {
  const history = session.messages.slice(-20).map((message) => `${message.role === "user" ? "教师" : "SecAgent"}：${message.content}`).join("\n");
  return history ? `以下是当前会话的历史，请结合上下文理解最后一条新消息。\n\n${history}\n\n教师的新消息：${current}` : current;
}

ipcMain.handle("sessions:list", () => { logMain("ipc.sessions.list"); return store().list(); });
ipcMain.handle("sessions:create", () => { const session = store().create(); logMain("ipc.sessions.create", { sessionId: session.meta.id }); return session; });
ipcMain.handle("sessions:get", (_event, id: string) => { logMain("ipc.sessions.get", { sessionId: id }); return store().get(id); });
ipcMain.handle("models:list", async () => {
  const { config } = loadConfig(DEFAULT_WORKSPACE);
  const googleProfile = config.agent.models?.find((model) => model.provider === "google");
  const googleModels = googleProfile ? await listGoogleModels(process.env[googleProfile.apiKeyEnv] || "", googleProfile.baseUrl).catch(() => []) : [];
  return configuredModels(config, googleModels);
});
ipcMain.handle("settings:get", () => readSettings(DEFAULT_WORKSPACE));
ipcMain.handle("settings:save", (_event, payload: SettingsPayload) => {
  const saved = saveSettings(DEFAULT_WORKSPACE, payload);
  windowRef?.webContents.send("settings:changed", saved);
  return saved;
});
ipcMain.handle("speech:start", () => startSpeech(windowRef));
ipcMain.handle("speech:stop", () => { stopSpeech(); return { ok: true }; });
ipcMain.on("speech:audio", (_event, samples: Float32Array) => sendSpeechAudio(samples));
ipcMain.handle("sessions:send", async (_event, id: string, text: string, modelId?: string) => {
  const sessionStore = store();
  const before = sessionStore.get(id);
  sessionStore.appendMessage(id, "user", text);
  const { workspace, config } = loadConfig(DEFAULT_WORKSPACE);
  useConfiguredModel(config, modelId);
  const audit = new AuditStore(workspace);
  let traceSequence = 0;
  const toolCalls: ToolCallRecord[] = [];
  const activities: AssistantActivity[] = [];
  const streamedTurns = new Map<number, string>();
  const trace = (event: Omit<TraceEvent, "sequence" | "at"> | TraceEvent) => {
    // The main process owns the sequence so its own request/error events and runtime events share
    // one strictly ordered timeline.
    const ordered: TraceEvent = { ...event, sequence: ++traceSequence, at: new Date().toISOString() };
    if (ordered.stage === "model.output.delta") {
      const data = ordered.data as { text?: unknown; turn?: unknown };
      if (typeof data.text === "string" && typeof data.turn === "number") streamedTurns.set(data.turn, (streamedTurns.get(data.turn) || "") + data.text);
    }
    if (ordered.stage === "model.output.reset") {
      const data = ordered.data as { turn?: unknown };
      const content = typeof data.turn === "number" ? streamedTurns.get(data.turn) : undefined;
      if (content) activities.push({ kind: "text", content });
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
    const runtime = new SecAgentRuntime(config, audit, loadEnabledSkills(config), trace);
    const result = await runtime.run(historyInput(before, text));
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

app.whenReady().then(() => {
  // Electron otherwise rejects getUserMedia requests in some desktop environments.
  // Speech audio is only used by the local recognizer and is never sent to a server.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
  initializeWorkspace(DEFAULT_WORKSPACE);
  createApplicationMenu();
  if (process.platform === "darwin") app.dock?.setIcon(appIconPath());
  logMain("app.ready");
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
