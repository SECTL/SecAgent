import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { app, BrowserWindow } from "electron";

const modelName = "sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23";
let worker: ChildProcessWithoutNullStreams | undefined;
let remoteSocket: WebSocket | undefined;
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
  window?.webContents.send("speech:event", payload);
}

/**
 * Remote ASR endpoint on the official relay, reachable on the same origin/port
 * as the chat API (secagent-api.sectl.cn:443 -> /asr/ws). Only used when the
 * user is logged in to the official service; otherwise we fall back to the
 * bundled local model so voice input keeps working offline.
 */
function remoteAsrUrl(): string | null {
  const token = process.env.SECTL_OFFICIAL_TOKEN || "";
  const baseUrl = (process.env.SECTL_OFFICIAL_API_URL || "").replace(/\/$/, "");
  if (!token || !baseUrl) return null;
  const wsBase = baseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  return `${wsBase}/asr/ws?token=${encodeURIComponent(token)}`;
}

export function startSpeech(window: BrowserWindow | undefined): { ok: true } {
  if (worker) return { ok: true };
  if (remoteSocket && (remoteSocket.readyState === WebSocket.OPEN || remoteSocket.readyState === WebSocket.CONNECTING)) return { ok: true };

  const url = remoteAsrUrl();
  if (url && typeof WebSocket !== "undefined") {
    try {
      const socket = new WebSocket(url);
      remoteSocket = socket;
      mode = "remote";
      socket.binaryType = "arraybuffer";
      socket.onopen = () => send(window, { type: "ready" });
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
        if (wasRemote) send(window, { type: "stopped" });
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
  output.on("line", (line) => {
    try { send(window, JSON.parse(line)); } catch { /* Ignore malformed worker output. */ }
  });
  worker.stderr.on("data", (chunk) => send(window, { type: "log", message: String(chunk) }));
  worker.on("error", (error) => send(window, { type: "error", message: error.message }));
  worker.on("exit", (code) => {
    if (worker) send(window, { type: "stopped", code });
    worker = undefined;
    mode = "idle";
  });
  return { ok: true };
}

export function sendSpeechAudio(samples: Float32Array): void {
  if (remoteSocket && (remoteSocket.readyState === WebSocket.OPEN || remoteSocket.readyState === WebSocket.CONNECTING)) {
    // float32 LE PCM @16kHz mono — same wire format the relay expects.
    const pcm = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength) as ArrayBuffer;
    remoteSocket.send(pcm);
    return;
  }
  if (!worker || worker.stdin.destroyed) return;
  const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");
  worker.stdin.write(JSON.stringify({ type: "audio", pcm }) + "\n");
}

export function stopSpeech(): void {
  if (remoteSocket && remoteSocket.readyState === WebSocket.OPEN) {
    try { remoteSocket.send("Done"); } catch { /* Socket may already be closing. */ }
    return;
  }
  if (!worker || worker.stdin.destroyed) return;
  worker.stdin.write(JSON.stringify({ type: "stop" }) + "\n");
  worker.stdin.end();
}
