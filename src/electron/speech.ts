import { BrowserWindow } from "electron";

let remoteSocket: WebSocket | undefined;
let pendingRemoteAudio: ArrayBuffer[] = [];
let mode: "remote" | "idle" = "idle";

function send(window: BrowserWindow | undefined, payload: unknown): void {
  window?.webContents.send("speech:event", payload);
}

/**
 * Remote ASR endpoint on the official relay, reachable on the same origin/port
 * as the chat API (secagent-api.sectl.cn:443 -> /asr/ws).
 */
function remoteAsrUrl(): string {
  const token = process.env.SECTL_OFFICIAL_TOKEN || "";
  const baseUrl = (process.env.SECTL_OFFICIAL_API_URL || "").replace(/\/$/, "");
  if (!token || !baseUrl) throw new Error("云端语音识别未配置，请先登录 SecAgent 官方服务");
  const wsBase = baseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  return `${wsBase}/asr/ws?token=${encodeURIComponent(token)}`;
}

export function startSpeech(window: BrowserWindow | undefined): { ok: true } {
  if (remoteSocket && (remoteSocket.readyState === WebSocket.OPEN || remoteSocket.readyState === WebSocket.CONNECTING)) return { ok: true };

  const url = remoteAsrUrl();
  if (typeof WebSocket === "undefined") throw new Error("当前环境不支持云端语音识别");
  try {
    const socket = new WebSocket(url);
    remoteSocket = socket;
    mode = "remote";
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (remoteSocket === socket && socket.readyState === WebSocket.OPEN) {
        for (const pcm of pendingRemoteAudio) socket.send(pcm);
        pendingRemoteAudio = [];
      }
      send(window, { type: "ready" });
    };
    socket.onmessage = (event) => {
      try {
        const payload = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        send(window, payload);
      } catch {
        send(window, { type: "log", message: String(event.data ?? "") });
      }
    };
    socket.onerror = () => {
      if (mode === "remote") send(window, { type: "error", message: "云端语音识别连接失败" });
    };
    socket.onclose = () => {
      const wasRemote = mode === "remote";
      if (remoteSocket === socket) {
        remoteSocket = undefined;
        mode = "idle";
      }
      pendingRemoteAudio = [];
      if (wasRemote) send(window, { type: "stopped" });
    };
    return { ok: true };
  } catch (error) {
    remoteSocket = undefined;
    mode = "idle";
    throw error;
  }
}

export function sendSpeechAudio(samples: Float32Array): void {
  if (remoteSocket?.readyState === WebSocket.OPEN) {
    // float32 LE PCM @16kHz mono — same wire format the relay expects.
    const pcm = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength) as ArrayBuffer;
    try { remoteSocket.send(pcm); } catch { /* Socket may have closed between the state check and send. */ }
    return;
  }
  if (remoteSocket?.readyState === WebSocket.CONNECTING) {
    const pcm = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength) as ArrayBuffer;
    // Keep at most roughly 0.5s while the cloud connection is handshaking.
    if (pendingRemoteAudio.length >= 32) pendingRemoteAudio.shift();
    pendingRemoteAudio.push(pcm);
    return;
  }
}

export function stopSpeech(): void {
  if (remoteSocket) {
    pendingRemoteAudio = [];
    if (remoteSocket.readyState === WebSocket.OPEN) {
      try { remoteSocket.send("Done"); } catch { /* Socket may already be closing. */ }
    } else if (remoteSocket.readyState === WebSocket.CONNECTING) {
      remoteSocket.close();
    }
    return;
  }
}
