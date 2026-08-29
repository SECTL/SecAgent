import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { createKws, createOnlineRecognizer } from "sherpa-onnx";
import { pinyin } from "pinyin-pro";

const modelName = "sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23";
/** Local offline ASR via the bundled WASM build; the model stays loaded for the app lifetime. */
let localRecognizer: ReturnType<typeof createOnlineRecognizer> | undefined;
let localStream: ReturnType<NonNullable<typeof localRecognizer>["createStream"]> | undefined;
let remoteSocket: WebSocket | undefined;
let speechWindow: BrowserWindow | undefined;
let pendingRemoteAudio: ArrayBuffer[] = [];
/** "remote" = backend relay /asr/ws; "local" = bundled sherpa-onnx WASM recognizer; "idle" = none. */
let mode: "remote" | "local" | "idle" = "idle";
let voiceWakeKws: ReturnType<typeof createKws> | undefined;
let voiceWakeStream: ReturnType<NonNullable<typeof voiceWakeKws>["createStream"]> | undefined;
let voiceWakePhrase = "";
let voiceWakeDetected: (() => void) | undefined;
let voiceWakeStartedAt = 0;
let voiceWakeAudioFrames = 0;
let voiceWakeAwaitingFirstAudio = false;
let voiceWakeLastHeartbeatAt = 0;
let voiceWakeLastInactiveAudioLogAt = 0;
let remoteSocketSequence = 0;

function projectPath(...parts: string[]): string {
  const candidates = [
    path.join(process.resourcesPath, ...parts),
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

/** Load the bundled streaming transducer once and give each utterance a fresh stream. */
function startLocalRecognizer(): void {
  if (localRecognizer) {
    // A stream that has seen inputFinished() cannot accept more audio.
    localStream?.free();
    localStream = localRecognizer.createStream();
    return;
  }
  const model = projectPath("models", modelName);
  localRecognizer = createOnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(model, "encoder-epoch-99-avg-1.int8.onnx"),
        decoder: path.join(model, "decoder-epoch-99-avg-1.onnx"),
        joiner: path.join(model, "joiner-epoch-99-avg-1.int8.onnx")
      },
      tokens: path.join(model, "tokens.txt"), provider: "cpu", numThreads: 1
    },
    enableEndpoint: 1,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20
  });
  localStream = localRecognizer.createStream();
  console.info(`[speech] local WASM recognizer ready model=${modelName}`);
}

function keywordTokens(phrase: string): string {
  const syllables = pinyin(phrase.replace(/\s+/g, ""), { toneType: "symbol", type: "array" }) as string[];
  const initials = ["zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r", "z", "c", "s", "y", "w"];
  return syllables.map((syllable) => {
    const initial = initials.find((candidate) => syllable.startsWith(candidate)) || "";
    return `${initial} ${syllable.slice(initial.length)}`;
  }).join(" ");
}

export function startVoiceWake(window: BrowserWindow | undefined, phrase: string, onDetected: () => void): { ok: true } {
  void window;
  voiceWakePhrase = phrase.trim();
  voiceWakeDetected = onDetected;
  if (voiceWakeKws) {
    console.info(`[voice-wake] local KWS already active phrase=${voiceWakePhrase}`);
    return { ok: true };
  }
  const model = projectPath("models", "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20");
  voiceWakeKws = createKws({
    featConfig: { samplingRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(model, "encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx"),
        decoder: path.join(model, "decoder-epoch-13-avg-2-chunk-16-left-64.onnx"),
        joiner: path.join(model, "joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx")
      },
      tokens: path.join(model, "tokens.txt"), provider: "cpu", numThreads: 1, modelingUnit: "ppinyin"
    },
    maxActivePaths: 4, numTrailingBlanks: 1, keywordsScore: 1.5, keywordsThreshold: 0.55,
    keywords: `${keywordTokens(voiceWakePhrase)} @${voiceWakePhrase}`
  });
  voiceWakeStream = voiceWakeKws.createStream();
  voiceWakeStartedAt = Date.now();
  voiceWakeAudioFrames = 0;
  voiceWakeAwaitingFirstAudio = true;
  voiceWakeLastHeartbeatAt = voiceWakeStartedAt;
  console.info(`[voice-wake] local KWS ready phrase=${voiceWakePhrase}`);
  return { ok: true };
}

export function sendVoiceWakeAudio(samples: Float32Array): void {
  const kws = voiceWakeKws;
  const stream = voiceWakeStream;
  const now = Date.now();
  if (!kws || !stream) {
    if (now - voiceWakeLastInactiveAudioLogAt >= 15000) {
      voiceWakeLastInactiveAudioLogAt = now;
      console.info(`[voice-wake] audio ignored kws=${Boolean(kws)} stream=${Boolean(stream)}`);
    }
    return;
  }
  voiceWakeAudioFrames += 1;
  if (voiceWakeAwaitingFirstAudio) {
    voiceWakeAwaitingFirstAudio = false;
    console.info(`[voice-wake] local KWS received first audio elapsed=${now - voiceWakeStartedAt}ms`);
  } else if (now - voiceWakeLastHeartbeatAt >= 15000) {
    voiceWakeLastHeartbeatAt = now;
    console.info(`[voice-wake] local KWS audio heartbeat frames=${voiceWakeAudioFrames} elapsed=${now - voiceWakeStartedAt}ms`);
  }
  stream.acceptWaveform(16000, samples);
  while (kws.isReady(stream)) kws.decode(stream);
  const result = kws.getResult(stream);
  if (result.keyword) {
    console.info(`[voice-wake] local KWS detected keyword=${result.keyword} frames=${voiceWakeAudioFrames}`);
    // Reset before invoking the callback. The callback closes the hidden
    // window and releases the KWS instance immediately.
    kws.reset(stream);
    const detected = voiceWakeDetected;
    detected?.();
  }
}

export function stopVoiceWake(): void {
  if (voiceWakeKws || voiceWakeStream) console.info(`[voice-wake] local KWS stopping frames=${voiceWakeAudioFrames} activeFor=${voiceWakeStartedAt ? Date.now() - voiceWakeStartedAt : 0}ms`);
  voiceWakeDetected = undefined;
  voiceWakeStream = undefined;
  voiceWakeKws?.free();
  voiceWakeKws = undefined;
  voiceWakeStartedAt = 0;
  voiceWakeAudioFrames = 0;
  voiceWakeAwaitingFirstAudio = false;
}

export function startSpeech(window: BrowserWindow | undefined): { ok: true; remote: boolean } {
  speechWindow = window;
  if (mode === "local" && localRecognizer) return { ok: true, remote: false };
  if (remoteSocket && (remoteSocket.readyState === WebSocket.OPEN || remoteSocket.readyState === WebSocket.CONNECTING)) {
    // The main chat window and the wake overlay share one ASR connection. If the
    // other window started it first, route subsequent events to the latest caller.
    if (remoteSocket.readyState === WebSocket.OPEN) send(speechWindow, { type: "ready" });
    return { ok: true, remote: true };
  }

  const url = remoteAsrUrl();
  if (url && typeof WebSocket !== "undefined") {
    const connectionId = ++remoteSocketSequence;
    const connectedAt = Date.now();
    console.info(`[speech] connecting id=${connectionId} to ${remoteAsrLogTarget(url)}`);
    try {
      const socket = new WebSocket(url);
      remoteSocket = socket;
      mode = "remote";
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        console.info(`[speech] ASR WebSocket opened id=${connectionId} elapsed=${Date.now() - connectedAt}ms`);
        if (remoteSocket === socket && socket.readyState === WebSocket.OPEN) {
          // The relay must receive the start control message before binary
          // audio. Sending the buffered audio first makes the relay discard
          // everything spoken while the WebSocket was connecting.
          try { socket.send(JSON.stringify({ type: "start" })); } catch { /* Socket may close during startup. */ }
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
        const errorEvent = event as ErrorEvent;
        const error = errorEvent.error as { message?: string; code?: string } | undefined;
        console.error("[speech] ASR WebSocket error", {
          id: connectionId,
          elapsed: Date.now() - connectedAt,
          readyState: socket.readyState,
          readyStateName: ["CONNECTING", "OPEN", "CLOSING", "CLOSED"][socket.readyState] || "UNKNOWN",
          message: errorEvent.message || error?.message || "",
          errorCode: error?.code || "",
          eventType: errorEvent.type
        });
        if (mode === "remote") send(speechWindow, { type: "error", message: "云端语音识别连接失败" });
      };
      socket.onclose = (event) => {
        console.warn("[speech] ASR WebSocket closed", {
          id: connectionId,
          code: event.code,
          reason: event.reason || "",
          wasClean: event.wasClean,
          elapsed: Date.now() - connectedAt,
          hadCurrentSocket: remoteSocket === socket
        });
        const wasRemote = mode === "remote";
        if (remoteSocket === socket) { remoteSocket = undefined; mode = "idle"; }
        pendingRemoteAudio = [];
        if (wasRemote) send(speechWindow, { type: "stopped" });
      };
      return { ok: true, remote: true };
    } catch {
      remoteSocket = undefined;
      mode = "idle";
    }
  }

  mode = "local";
  try {
    startLocalRecognizer();
  } catch (error) {
    mode = "idle";
    send(speechWindow, { type: "error", message: error instanceof Error ? error.message : String(error) });
    return { ok: true, remote: false };
  }
  send(speechWindow, { type: "ready" });
  return { ok: true, remote: false };
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
  const recognizer = localRecognizer;
  const stream = localStream;
  if (!recognizer || !stream) return;
  try {
    stream.acceptWaveform(16000, samples);
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    const text = (recognizer.getResult(stream).text || "").trim();
    if (text) send(speechWindow, { type: "partial", text });
    if (recognizer.isEndpoint(stream)) {
      // The endpoint fires with the segment's full text; reset starts a new segment.
      recognizer.reset(stream);
      if (text) send(speechWindow, { type: "final", text });
    }
  } catch (error) {
    send(speechWindow, { type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

export function stopSpeech(): void {
  if (remoteSocket) {
    pendingRemoteAudio = [];
    if (remoteSocket.readyState === WebSocket.OPEN) {
      try { remoteSocket.send("Done"); } catch { /* Socket may already be closing. */ }
    } else if (remoteSocket.readyState === WebSocket.CONNECTING) remoteSocket.close();
    return;
  }
  const recognizer = localRecognizer;
  const stream = localStream;
  if (!recognizer || !stream) return;
  try {
    // Flush the tail of the utterance so the last segment is not lost.
    stream.inputFinished();
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    const text = (recognizer.getResult(stream).text || "").trim();
    if (text) send(speechWindow, { type: "final", text });
  } catch (error) {
    send(speechWindow, { type: "error", message: error instanceof Error ? error.message : String(error) });
  }
  // A stream that has seen inputFinished() cannot be reused.
  stream.free();
  localStream = recognizer.createStream();
  mode = "idle";
  send(speechWindow, { type: "stopped" });
  speechWindow = undefined;
}

/** Abort the current utterance without waiting for recognition or enhancement. */
export function cancelSpeech(): void {
  pendingRemoteAudio = [];
  if (remoteSocket) {
    const socket = remoteSocket;
    remoteSocket = undefined;
    mode = "idle";
    try { socket.close(1000, "cancelled"); } catch { /* Socket may already be closed. */ }
    return;
  }
  if (localRecognizer) {
    try { localStream?.free(); } catch { /* Stream may already be freed. */ }
    localStream = undefined;
    mode = "idle";
  }
}
