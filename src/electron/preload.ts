import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("secagent", {
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  listModels: () => ipcRenderer.invoke("models:list"),
  createSession: () => ipcRenderer.invoke("sessions:create"),
  getSession: (id: string) => ipcRenderer.invoke("sessions:get", id),
  sendMessage: (id: string, text: string, modelId?: string) => ipcRenderer.invoke("sessions:send", id, text, modelId),
  startSpeech: () => ipcRenderer.invoke("speech:start"),
  sendSpeechAudio: (samples: Float32Array) => ipcRenderer.send("speech:audio", samples),
  stopSpeech: () => ipcRenderer.invoke("speech:stop"),
  onSpeechEvent: (listener: (event: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on("speech:event", wrapped);
    return () => ipcRenderer.removeListener("speech:event", wrapped);
  },
  onRuntimeEvent: (listener: (event: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on("sessions:runtime-event", wrapped);
    return () => ipcRenderer.removeListener("sessions:runtime-event", wrapped);
  }
});
