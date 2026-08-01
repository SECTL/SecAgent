import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("secagent", {
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  listModels: () => ipcRenderer.invoke("models:list"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (payload: unknown) => ipcRenderer.invoke("settings:save", payload),
  createSession: () => ipcRenderer.invoke("sessions:create"),
  deleteSession: (id: string) => ipcRenderer.invoke("sessions:delete", id),
  getSession: (id: string) => ipcRenderer.invoke("sessions:get", id),
  sendMessage: (id: string, text: string, modelId?: string, reasoningEffort?: string) => ipcRenderer.invoke("sessions:send", id, text, modelId, reasoningEffort),
  startSpeech: () => ipcRenderer.invoke("speech:start"),
  sendSpeechAudio: (samples: Float32Array) => ipcRenderer.send("speech:audio", samples),
  stopSpeech: () => ipcRenderer.invoke("speech:stop"),
  synthesizeSpeech: (text: string) => ipcRenderer.invoke("tts:synthesize", text),
  onSpeechEvent: (listener: (event: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on("speech:event", wrapped);
    return () => ipcRenderer.removeListener("speech:event", wrapped);
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
  }
});
