import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { app, BrowserWindow } from "electron";

const modelName = "sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23";
let worker: ChildProcessWithoutNullStreams | undefined;

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

export function startSpeech(window: BrowserWindow | undefined): { ok: true } {
  if (worker) return { ok: true };
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
  });
  return { ok: true };
}

export function sendSpeechAudio(samples: Float32Array): void {
  if (!worker || worker.stdin.destroyed) return;
  const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");
  worker.stdin.write(JSON.stringify({ type: "audio", pcm }) + "\n");
}

export function stopSpeech(): void {
  if (!worker || worker.stdin.destroyed) return;
  worker.stdin.write(JSON.stringify({ type: "stop" }) + "\n");
  worker.stdin.end();
}
