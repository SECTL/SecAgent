import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("secagent", {
  platform: process.platform,
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  listModels: () => ipcRenderer.invoke("models:list"),
  listProviders: () => ipcRenderer.invoke("providers:list"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  officialStatus: () => ipcRenderer.invoke("official:status"),
  officialBalance: () => ipcRenderer.invoke("official:balance"),
  officialOAuthLogin: () => ipcRenderer.invoke("official:oauth-login"),
  officialLogout: () => ipcRenderer.invoke("official:logout"),
  listSkills: () => ipcRenderer.invoke("settings:skills"),
  openSkillsDirectory: () => ipcRenderer.invoke("settings:open-skills"),
  saveSettings: (payload: unknown) => ipcRenderer.invoke("settings:save", payload),
  listPlugins: () => ipcRenderer.invoke("plugins:list"),
  callPluginSettings: (pluginId: string, pageId: string, action: string, args?: unknown) => ipcRenderer.invoke("plugins:settings-call", pluginId, pageId, action, args || {}),
  setPluginEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke("plugins:set-enabled", id, enabled),
  reloadPlugin: (id: string) => ipcRenderer.invoke("plugins:reload", id),
  uninstallPlugin: (id: string) => ipcRenderer.invoke("plugins:uninstall", id),
  installPlugin: () => ipcRenderer.invoke("plugins:install"),
  listMarketplace: () => ipcRenderer.invoke("marketplace:list"),
  installMarketplaceVersion: (version: unknown) => ipcRenderer.invoke("marketplace:install", version),
  detectInstalledApps: () => ipcRenderer.invoke("apps:detect"),
  openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url),
  completeOnboarding: () => ipcRenderer.invoke("oobe:complete"),
  createSession: () => ipcRenderer.invoke("sessions:create"),
  deleteSession: (id: string) => ipcRenderer.invoke("sessions:delete", id),
  getSession: (id: string) => ipcRenderer.invoke("sessions:get", id),
  getRuntimeEvents: (id: string) => ipcRenderer.invoke("sessions:runtime-events", id),
  previewWorkspaceFile: (relativePath: string) => ipcRenderer.invoke("workspace:preview-file", relativePath),
  sendMessage: (id: string, text: string, modelId?: string, reasoningEffort?: string, attachments?: unknown[]) => ipcRenderer.invoke("sessions:send", id, text, modelId, reasoningEffort, attachments),
  stopMessage: (id: string) => ipcRenderer.invoke("sessions:stop", id),
  startSpeech: (hotwords?: string[]) => ipcRenderer.invoke("speech:start", hotwords),
  sendSpeechAudio: (samples: Float32Array) => ipcRenderer.send("speech:audio", samples),
  stopSpeech: () => ipcRenderer.invoke("speech:stop"),
  startVoiceWake: (phrase: string) => ipcRenderer.invoke("voice-wake:start", phrase),
  sendVoiceWakeAudio: (samples: Float32Array) => ipcRenderer.send("voice-wake:audio", samples),
  stopVoiceWake: () => ipcRenderer.invoke("voice-wake:stop"),
  logVoiceWake: (event: unknown) => ipcRenderer.send("voice-wake:log", event),
  synthesizeSpeech: (text: string) => ipcRenderer.invoke("tts:synthesize", text),
  logWakeTts: (event: unknown) => ipcRenderer.send("wake:tts-log", event),
  setWakeContext: (context: unknown) => ipcRenderer.send("wake:context", context),
  closeWake: () => ipcRenderer.invoke("wake:close"),
  setWakeInteractive: (interactive: boolean) => ipcRenderer.send("wake:interactive", interactive),
  onSpeechEvent: (listener: (event: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on("speech:event", wrapped);
    return () => ipcRenderer.removeListener("speech:event", wrapped);
  },
  onVoiceWakeResume: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on("voice-wake:resume", wrapped);
    return () => ipcRenderer.removeListener("voice-wake:resume", wrapped);
  },
  onRuntimeEvent: (listener: (event: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on("sessions:runtime-event", wrapped);
    return () => ipcRenderer.removeListener("sessions:runtime-event", wrapped);
  },
  onSettingsChanged: (listener: (settings: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on("settings:changed", wrapped);
    return () => ipcRenderer.removeListener("settings:changed", wrapped);
  },
  onPluginsChanged: (listener: (plugins: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on("plugins:changed", wrapped);
    return () => ipcRenderer.removeListener("plugins:changed", wrapped);
  }
});
