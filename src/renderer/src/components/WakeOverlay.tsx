import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MessageActivities } from "./MessageActivities.js";
import type { TraceEvent } from "../constants.js";

type WakeStatus = "listening" | "transcribing" | "submitting" | "streaming" | "completed" | "error";

function collectActivities(events: TraceEvent[]): AssistantActivity[] {
  const activities: AssistantActivity[] = [];
  for (const item of events) {
    if (item.stage === "model.output.delta") {
      const data = item.data as { text?: unknown; kind?: unknown; turn?: unknown };
      const kind = data.kind === "thinking" || data.kind === "summary" ? data.kind : undefined;
      if (kind && typeof data.text === "string") {
        const last = activities.at(-1);
        if (last?.kind === kind) last.content += data.text;
        else activities.push({ kind, content: data.text, ...(typeof data.turn === "number" ? { turn: data.turn } : {}) });
      }
    }
    if (item.stage === "mcp.tools/call" || item.stage === "secagent.tools/call") {
      const data = item.data as { name?: unknown; arguments?: unknown };
      if (typeof data.name === "string") activities.push({ kind: "tool", name: data.name, arguments: data.arguments ?? {} });
    }
    if (item.stage === "mcp.tools/result" || item.stage === "secagent.tools/result") {
      const data = item.data as { name?: unknown; result?: unknown };
      if (typeof data.name === "string") {
        const activity = [...activities].reverse().find((entry): entry is Extract<AssistantActivity, { kind: "tool" }> => entry.kind === "tool" && entry.name === data.name && !("result" in entry));
        if (activity) activity.result = data.result;
      }
    }
  }
  return activities;
}

function finalAnswer(events: TraceEvent[]): string {
  let start = 0;
  events.forEach((item, index) => { if (item.stage === "model.output.reset") start = index + 1; });
  return events.slice(start).filter((item) => item.stage === "model.output.delta")
    .map((item) => {
      const data = item.data as { text?: string; kind?: string };
      return data.kind === "answer" || !data.kind ? data.text || "" : "";
    }).join("");
}

function isVoiceActive(samples: Float32Array): boolean {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  return Math.sqrt(energy / Math.max(1, samples.length)) > 0.015;
}

function takeCompleteSentences(value: string): { complete: string; remainder: string } {
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

  const assistantText = useMemo(() => finalAnswer(events), [events]);
  const activities = useMemo(() => collectActivities(events), [events]);
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
        const buffer = await bridge.synthesizeSpeech(text);
        if (!buffer || ttsRunRef.current !== run) break;
        const audio = new Audio(`data:audio/mpeg;base64,${buffer}`);
        ttsAudioRef.current = audio;
        await audio.play();
        await new Promise<void>((resolve) => { audio.onended = () => resolve(); audio.onerror = () => resolve(); });
        ttsAudioRef.current = null;
      }
    } catch (reason) {
      console.warn("Wake TTS failed", reason);
    } finally {
      ttsRunningRef.current = false;
    }
  };

  const enqueueTts = (text: string) => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return;
    ttsQueueRef.current.push(clean);
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
    setError("");
    try {
      const result = await bridge.sendMessage(sessionId, finalText, modelId, reasoningEffort);
      setSession(result);
      setStatus("completed");
      const answer = result.messages.filter((message) => message.role === "assistant").at(-1)?.content || "";
      if (answer && !finalTtsFlushedRef.current) {
        const remainder = answer.slice(spokenTextRef.current.length);
        if (remainder) enqueueTts(remainder);
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
      }
    });
    void startRecording();
    return () => {
      document.body.classList.remove("wake-mode");
      removeSpeech();
      removeRuntime();
      void stopRecording();
      stopTts();
    };
  }, []);

  useEffect(() => {
    if (!agentStarted || !assistantText) return;
    if (assistantText.length < spokenTextRef.current.length) {
      stopTts();
      spokenTextRef.current = "";
      finalTtsFlushedRef.current = false;
    }
    const pending = assistantText.slice(spokenTextRef.current.length);
    const { complete } = takeCompleteSentences(pending);
    if (complete) {
      enqueueTts(complete);
      spokenTextRef.current += complete.length;
    }
  }, [assistantText, agentStarted]);

  useEffect(() => {
    bridge.setWakeInteractive(agentStarted);
    return () => bridge.setWakeInteractive(false);
  }, [bridge, agentStarted]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") void bridge.closeWake(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [bridge]);

  return <main className="wake-root" aria-label="随时唤醒">
    <div className="wake-edge wake-edge-soft" />
    <div className="wake-edge wake-edge-pulse" />
    <div className="wake-edge wake-edge-sharp" />
    <div className={`wake-stack ${agentStarted ? "agent-started" : ""}`}>
      <div className={`wake-user-bubble ${agentStarted ? "submitted" : ""}`}>
        <span className={!transcript ? "wake-listening" : "wake-transcript"}>{transcript || (status === "error" ? "语音识别失败" : "聆听中...")}</span>
      </div>
      {agentStarted && <div className="wake-agent-bubble">
        <div className="wake-agent-avatar"><img src="/icon.svg" alt="SecAgent" /></div>
        <div className="wake-agent-content">
          <MessageActivities activities={activities} isExecuting={status === "submitting" || status === "streaming"} activeStepKind={activities.at(-1)?.kind} />
          <div className={`wake-answer ${!assistantText ? "wake-answer-pending" : ""}`}>
            {assistantText ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{assistantText}</ReactMarkdown> : "···"}
          </div>
        </div>
      </div>}
      {error && <div className="wake-error">{error}</div>}
    </div>
  </main>;
}
