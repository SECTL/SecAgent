import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { app, BrowserWindow } from "electron";

const modelName = "sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23";
let worker: ChildProcessWithoutNullStreams | undefined;
let remoteSocket: WebSocket | undefined;
let speechWindow: BrowserWindow | undefined;
let pendingRemoteAudio: ArrayBuffer[] = [];
/** "remote" = backend relay /asr/ws; "local" = bundled sherpa-onnx worker; "idle" = none. */
let mode: "remote" | "local" | "idle" = "idle";

function projectPath(...parts: string[]): string {
  const candidates = [
    path.join(process.cwd(), ...parts),
    path.join(app.getAppPath(), ...parts),
    path.join(__dirname, "../../", ...parts)
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`找不到语音资源：${parts.join("/")}`);
  return found;
}

function send(window: BrowserWindow | undefined, payload: unknown): void {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  try { window.webContents.send("speech:event", payload); } catch { /* Window may close during an async callback. */ }
}

/** Remote ASR endpoint on the official relay. */
function remoteAsrUrl(): string | null {
  const token = process.env.SECTL_OFFICIAL_TOKEN || "";
  const baseUrl = (process.env.SECTL_OFFICIAL_API_URL || "").replace(/\/$/, "");
  if (!token || !baseUrl) return null;
  const wsBase = baseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  return `${wsBase}/asr/ws?token=${encodeURIComponent(token)}`;
}

function remoteAsrLogTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

export function startSpeech(window: BrowserWindow | undefined): { ok: true } {
  speechWindow = window;
  if (worker) return { ok: true };
  if (remoteSocket && (remoteSocket.readyState === WebSocket.OPEN || remoteSocket.readyState === WebSocket.CONNECTING)) {
    // The main chat window and the wake overlay share one ASR connection. If the
    // other window started it first, route subsequent events to the latest caller.
    if (remoteSocket.readyState === WebSocket.OPEN) send(speechWindow, { type: "ready" });
    return { ok: true };
  }

  const url = remoteAsrUrl();
  if (url && typeof WebSocket !== "undefined") {
    console.info(`[speech] connecting to ${remoteAsrLogTarget(url)}`);
    try {
      const socket = new WebSocket(url);
      remoteSocket = socket;
      mode = "remote";
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        console.info("[speech] ASR WebSocket opened");
        if (remoteSocket === socket && socket.readyState === WebSocket.OPEN) {
          for (const pcm of pendingRemoteAudio) socket.send(pcm);
          pendingRemoteAudio = [];
        }
        send(speechWindow, { type: "ready" });
      };
      socket.onmessage = (event) => {
        try { send(speechWindow, typeof event.data === "string" ? JSON.parse(event.data) : event.data); }
        catch { send(speechWindow, { type: "log", message: String(event.data ?? "") }); }
      };
      socket.onerror = (event) => {
        console.error("[speech] ASR WebSocket error", event);
        if (mode === "remote") send(speechWindow, { type: "error", message: "云端语音识别连接失败" });
      };
      socket.onclose = (event) => {
        console.warn(`[speech] ASR WebSocket closed (code=${event.code}, reason=${event.reason || ""})`);
        const wasRemote = mode === "remote";
        if (remoteSocket === socket) { remoteSocket = undefined; mode = "idle"; }
        pendingRemoteAudio = [];
        if (wasRemote) send(speechWindow, { type: "stopped" });
      };
      return { ok: true };
    } catch {
      remoteSocket = undefined;
      mode = "idle";
    }
  }

  mode = "local";
  const model = projectPath("models", modelName);
  const script = projectPath("speech-worker.py");
  worker = spawn(process.env.PYTHON || "python3", [
    script,
    "--tokens", path.join(model, "tokens.txt"),
    "--encoder", path.join(model, "encoder-epoch-99-avg-1.int8.onnx"),
    "--decoder", path.join(model, "decoder-epoch-99-avg-1.onnx"),
    "--joiner", path.join(model, "joiner-epoch-99-avg-1.int8.onnx")
  ], { stdio: "pipe" });
  const output = readline.createInterface({ input: worker.stdout });
  output.on("line", (line) => { try { send(speechWindow, JSON.parse(line)); } catch { /* Ignore malformed worker output. */ } });
  worker.stderr.on("data", (chunk) => send(speechWindow, { type: "log", message: String(chunk) }));
  worker.on("error", (error) => send(speechWindow, { type: "error", message: error.message }));
  worker.on("exit", (code) => {
    if (worker) send(speechWindow, { type: "stopped", code });
    worker = undefined;
    mode = "idle";
    speechWindow = undefined;
  });
  return { ok: true };
}

export function sendSpeechAudio(samples: Float32Array): void {
  const pcm = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength) as ArrayBuffer;
  if (remoteSocket?.readyState === WebSocket.OPEN) {
    try { remoteSocket.send(pcm); } catch { /* Socket may close between the state check and send. */ }
    return;
  }
  if (remoteSocket?.readyState === WebSocket.CONNECTING) {
    if (pendingRemoteAudio.length >= 32) pendingRemoteAudio.shift();
    pendingRemoteAudio.push(pcm);
    return;
  }
  if (!worker || worker.stdin.destroyed) return;
  worker.stdin.write(JSON.stringify({ type: "audio", pcm: Buffer.from(pcm).toString("base64") }) + "\n");
}

export function stopSpeech(): void {
  if (remoteSocket) {
    pendingRemoteAudio = [];
    if (remoteSocket.readyState === WebSocket.OPEN) {
      try { remoteSocket.send("Done"); } catch { /* Socket may already be closing. */ }
    } else if (remoteSocket.readyState === WebSocket.CONNECTING) remoteSocket.close();
    return;
  }
  if (!worker || worker.stdin.destroyed) return;
  worker.stdin.write(JSON.stringify({ type: "stop" }) + "\n");
  worker.stdin.end();
}
