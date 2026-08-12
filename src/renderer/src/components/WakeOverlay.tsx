import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TraceEvent } from "../constants.js";

type WakeStatus = "listening" | "transcribing" | "submitting" | "streaming" | "completed" | "error";

function isVoiceActive(samples: Float32Array): boolean {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  return Math.sqrt(energy / Math.max(1, samples.length)) > 0.015;
}

function audioBlobUrl(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
}

function completeSentences(value: string): { complete: string; remainder: string } {
  let end = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (/[。！？!?；;\n]/.test(value[index])) end = index + 1;
  }
  return { complete: value.slice(0, end), remainder: value.slice(end) };
}

export function WakeOverlay() {
  const bridge = window.secagent;
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const sessionId = params.get("sessionId") || "";
  const modelId = params.get("modelId") || undefined;
  const reasoningEffort = (params.get("reasoningEffort") || "high") as ReasoningEffort;
  const [session, setSession] = useState<SessionData | null>(null);
  const [transcript, setTranscript] = useState("");
  const [status, setStatus] = useState<WakeStatus>("listening");
  const [recording, setRecording] = useState(false);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [streamingAnswer, setStreamingAnswer] = useState("");
  const [finalAnswerText, setFinalAnswerText] = useState("");
  const [error, setError] = useState("");
  const audioRef = useRef<{ context: AudioContext; stream: MediaStream; source: MediaStreamAudioSourceNode; processor: ScriptProcessorNode } | undefined>(undefined);
  const silenceTimerRef = useRef<number | undefined>(undefined);
  const lastVoiceAtRef = useRef(0);
  const hasVoiceRef = useRef(false);
  const transcriptRef = useRef("");
  const submittingRef = useRef(false);
  const finalWaiterRef = useRef<((text: string) => void) | null>(null);
  const submitTranscriptRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const ttsQueueRef = useRef<string[]>([]);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsRunningRef = useRef(false);
  const ttsRunRef = useRef(0);
  const spokenTextRef = useRef("");
  const finalTtsFlushedRef = useRef(false);
  const wakeInteractiveRef = useRef(false);

  const logTts = (event: Record<string, unknown>) => {
    console.info("[wake-tts]", event);
    bridge.logWakeTts(event);
  };

  const agentStarted = status === "submitting" || status === "streaming" || status === "completed";

  const stopTts = () => {
    ttsRunRef.current += 1;
    ttsQueueRef.current = [];
    ttsAudioRef.current?.pause();
    ttsAudioRef.current = null;
    ttsRunningRef.current = false;
  };

  const playTtsQueue = async () => {
    if (ttsRunningRef.current) return;
    ttsRunningRef.current = true;
    const run = ttsRunRef.current;
    try {
      while (ttsQueueRef.current.length && ttsRunRef.current === run) {
        const text = ttsQueueRef.current.shift() || "";
        logTts({ stage: "synthesize.start", characters: text.length });
        const buffer = await bridge.synthesizeSpeech(text);
        logTts({ stage: "synthesize.returned", base64Characters: buffer.length });
        if (!buffer || ttsRunRef.current !== run) {
          logTts({ stage: "playback.skipped", hasAudio: Boolean(buffer), cancelled: ttsRunRef.current !== run });
          break;
        }
        const audioUrl = audioBlobUrl(buffer);
        logTts({ stage: "audio.url.created", scheme: "blob", characters: audioUrl.length });
        const audio = new Audio(audioUrl);
        audio.autoplay = true;
        audio.muted = false;
        audio.onloadeddata = () => logTts({ stage: "audio.loaded" });
        audio.onplay = () => logTts({ stage: "audio.play" });
        audio.onended = () => logTts({ stage: "audio.ended" });
        audio.onerror = () => logTts({ stage: "audio.error", error: audio.error ? { code: audio.error.code, message: audio.error.message } : "unknown" });
        ttsAudioRef.current = audio;
        try {
          await audio.play();
        } catch (reason) {
          logTts({ stage: "audio.play.rejected", error: reason instanceof Error ? reason.message : String(reason) });
          throw reason;
        }
        await new Promise<void>((resolve) => {
          const finish = () => resolve();
          audio.addEventListener("ended", finish, { once: true });
          audio.addEventListener("error", finish, { once: true });
        });
        URL.revokeObjectURL(audioUrl);
        ttsAudioRef.current = null;
      }
    } catch (reason) {
      console.error("Wake TTS failed", reason);
    } finally {
      ttsRunningRef.current = false;
    }
  };

  const enqueueTts = (text: string) => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return;
    ttsQueueRef.current.push(clean);
    logTts({ stage: "queued", characters: clean.length, queueLength: ttsQueueRef.current.length });
    void playTtsQueue();
  };

  const stopRecording = async () => {
    const audio = audioRef.current;
    audioRef.current = undefined;
    if (silenceTimerRef.current !== undefined) window.clearInterval(silenceTimerRef.current);
    silenceTimerRef.current = undefined;
    audio?.processor.disconnect();
    audio?.source.disconnect();
    audio?.stream.getTracks().forEach((track) => track.stop());
    await audio?.context.close();
    await bridge.stopSpeech();
    setRecording(false);
  };

  const submitTranscript = async () => {
    if (submittingRef.current) return;
    const currentText = transcriptRef.current.trim();
    if (!currentText || !sessionId) return;
    submittingRef.current = true;
    setStatus("transcribing");
    const finalTextPromise = new Promise<string>((resolve) => {
      let settled = false;
      const finish = (text: string) => { if (settled) return; settled = true; finalWaiterRef.current = null; resolve(text); };
      finalWaiterRef.current = finish;
      window.setTimeout(() => finish(transcriptRef.current), 700);
    });
    await stopRecording();
    const finalText = (await finalTextPromise).trim() || currentText;
    if (!finalText) { submittingRef.current = false; setStatus("listening"); return; }
    setStatus("submitting");
    setEvents([]);
    setStreamingAnswer("");
    setFinalAnswerText("");
    stopTts();
    spokenTextRef.current = "";
    finalTtsFlushedRef.current = false;
    setError("");
    try {
      const result = await bridge.sendMessage(sessionId, finalText, modelId, reasoningEffort);
      setSession(result);
      const answer = result.messages.filter((message) => message.role === "assistant").at(-1)?.content || "";
      setFinalAnswerText(answer);
      setStatus("completed");
      if (answer && !finalTtsFlushedRef.current) {
        const remaining = answer.slice(spokenTextRef.current.length);
        if (remaining) enqueueTts(remaining);
        spokenTextRef.current = answer;
        finalTtsFlushedRef.current = true;
      }
    } catch (reason) {
      setStatus("error");
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      submittingRef.current = false;
    }
  };
  submitTranscriptRef.current = submitTranscript;

  useEffect(() => {
    if (status !== "streaming" || !streamingAnswer) return;
    const pending = streamingAnswer.slice(spokenTextRef.current.length);
    const { complete } = completeSentences(pending);
    if (!complete) return;
    enqueueTts(complete);
    spokenTextRef.current += complete.length;
  }, [streamingAnswer, status]);

  const startRecording = async () => {
    if (recording || submittingRef.current) return;
    try {
      setStatus("listening");
      setError("");
      await bridge.startSpeech();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const context = new AudioContext({ sampleRate: 16000 });
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (event) => {
        const samples = new Float32Array(event.inputBuffer.getChannelData(0));
        bridge.sendSpeechAudio(samples);
        if (isVoiceActive(samples)) {
          hasVoiceRef.current = true;
          lastVoiceAtRef.current = Date.now();
        }
      };
      source.connect(processor);
      processor.connect(context.destination);
      audioRef.current = { context, stream, source, processor };
      setRecording(true);
      silenceTimerRef.current = window.setInterval(() => {
        if (hasVoiceRef.current && transcriptRef.current.trim() && Date.now() - lastVoiceAtRef.current >= 1500) void submitTranscriptRef.current();
      }, 100);
    } catch (reason) {
      setStatus("error");
      setError(`无法打开麦克风：${reason instanceof Error ? reason.message : String(reason)}`);
      await bridge.stopSpeech();
    }
  };

  useEffect(() => {
    document.documentElement.classList.add("wake-mode");
    document.body.classList.add("wake-mode");
    void bridge.getSession(sessionId).then(setSession).catch((reason) => { setStatus("error"); setError(String(reason)); });
    const removeSpeech = bridge.onSpeechEvent((event) => {
      const data = event as { type?: string; text?: string; message?: string };
      if (data.type === "ready") setStatus((current) => current === "listening" ? "listening" : current);
      if (data.type === "partial" || data.type === "final") {
        const text = data.text || "";
        transcriptRef.current = text;
        setTranscript(text);
        if (text.trim()) { hasVoiceRef.current = true; lastVoiceAtRef.current = Date.now(); setStatus("transcribing"); }
        if (data.type === "final") finalWaiterRef.current?.(text);
      }
      if (data.type === "error") { setStatus("error"); setError(data.message || "语音识别失败"); }
    });
    const removeRuntime = bridge.onRuntimeEvent((event) => {
      const item = event as TraceEvent & { sessionId?: string };
      if (item.sessionId === sessionId) {
        setStatus((current) => current === "submitting" ? "streaming" : current);
        setEvents((current) => [...current, item]);
        if (item.stage === "model.output.reset") setStreamingAnswer("");
        if (item.stage === "model.output.delta") {
          const data = item.data as { text?: unknown; kind?: unknown };
          if ((data.kind === undefined || data.kind === "answer") && typeof data.text === "string") {
            setStreamingAnswer((current) => current + data.text);
          }
        }
      }
    });
    void startRecording();
    return () => {
      document.documentElement.classList.remove("wake-mode");
      document.body.classList.remove("wake-mode");
      removeSpeech();
      removeRuntime();
      void stopRecording();
      stopTts();
    };
  }, []);

  useEffect(() => {
    const updatePointerMode = (interactive: boolean) => {
      if (wakeInteractiveRef.current === interactive) return;
      wakeInteractiveRef.current = interactive;
      bridge.setWakeInteractive(interactive);
    };
    const onMouseMove = (event: MouseEvent) => {
      const target = event.target;
      updatePointerMode(target instanceof Element && Boolean(target.closest(".wake-stack")));
    };
    document.addEventListener("mousemove", onMouseMove);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      updatePointerMode(false);
    };
  }, [bridge]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") void bridge.closeWake(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [bridge]);

  return <main className="wake-root" aria-label="随时唤醒">
    <svg className="wake-edge-svg" aria-hidden="true" preserveAspectRatio="none">
      <defs>
        <linearGradient id="wake-edge-gradient" x1="0" y1="0" x2="1" y2="0" gradientUnits="objectBoundingBox">
          <stop offset="0%" stopColor="#f86437" /><stop offset="16%" stopColor="#ffb84a" />
          <stop offset="30%" stopColor="#f5eb66" /><stop offset="48%" stopColor="#6ddf88" />
          <stop offset="66%" stopColor="#58b7ff" /><stop offset="80%" stopColor="#8c78ff" /><stop offset="100%" stopColor="#f86437" />
          <animateTransform attributeName="gradientTransform" type="rotate" from="0 .5 .5" to="360 .5 .5" dur="20s" repeatCount="indefinite" />
        </linearGradient>
        <filter id="wake-edge-blur-mid" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="7" /></filter>
        <filter id="wake-edge-blur-near" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="4" /></filter>
      </defs>
      <rect className="wake-edge-svg-mid" x="7" y="7" width="calc(100% - 14px)" height="calc(100% - 14px)" rx="28" fill="none" stroke="url(#wake-edge-gradient)" strokeWidth="7" filter="url(#wake-edge-blur-mid)" />
      <rect className="wake-edge-svg-near" x="7" y="7" width="calc(100% - 14px)" height="calc(100% - 14px)" rx="28" fill="none" stroke="url(#wake-edge-gradient)" strokeWidth="12" filter="url(#wake-edge-blur-near)" />
      <rect className="wake-edge-svg-crisp" x="7" y="7" width="calc(100% - 14px)" height="calc(100% - 14px)" rx="28" fill="none" stroke="url(#wake-edge-gradient)" strokeWidth="7" />
    </svg>
    <div className={`wake-stack ${agentStarted ? "agent-started" : ""}`}>
      <div className={`wake-user-bubble ${agentStarted ? "submitted" : ""}`}>
        <span className={!transcript ? "wake-listening" : "wake-transcript"}>{transcript || (status === "error" ? "语音识别失败" : "聆听中...")}</span>
      </div>
      {agentStarted && <div className="wake-agent-bubble">
        <div className="wake-agent-content">
          <div className={`wake-answer ${!(status === "completed" ? finalAnswerText : streamingAnswer) ? "wake-answer-pending" : ""}`}>
            {status === "completed" && finalAnswerText
              ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{finalAnswerText}</ReactMarkdown>
              : streamingAnswer
                ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingAnswer}</ReactMarkdown>
                : "···"}
          </div>
        </div>
      </div>}
      {error && <div className="wake-error">{error}</div>}
    </div>
  </main>;
}
