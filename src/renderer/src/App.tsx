import { Fragment, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent as ReactClipboardEvent, DragEvent as ReactDragEvent } from "react";
import { ArrowUp, LoaderCircle, Square, Volume2 } from "lucide-react";
import { SettingsApp } from "./components/SettingsApp.js";
import { WakeOverlay } from "./components/WakeOverlay.js";
import { VoiceWakeListener } from "./components/VoiceWakeListener.js";
import { MessageActivities } from "./components/MessageActivities.js";
import { AttachmentStrip } from "./components/AttachmentStrip.js";
import { MarkdownContent } from "./components/MarkdownContent.js";
import { WorkspaceFileStrip } from "./components/WorkspaceFileStrip.js";
import { stripWorkspaceFilesMarkup } from "../../workspace-file-contract.js";
import { reasoningEffortLabels, traceLabel } from "./constants.js";
import type { TraceEvent } from "./constants.js";
import { isOfficialModel, isOfficialTierModel, reasoningEffortsForModel } from "./utils.js";
import { officialTiers, tierDefaultId } from "./constants.js";
import { buildQuotedUserMessage, parseQuotedUserMessage, webSearchUrl } from "../../quoted-message.js";

function selectionInElement(element: HTMLElement): string {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return "";
  const range = selection.getRangeAt(0);
  if (!element.contains(range.commonAncestorContainer)) return "";
  return selection.toString().trim();
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const input = document.createElement("textarea");
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
}

function UserQuotedContent({ content }: { content: string }) {
  const parsed = parseQuotedUserMessage(content);
  if (!parsed.quote) return <>{content}</>;
  return <>
    <blockquote className="message-quote">{parsed.quote}</blockquote>
    {parsed.body ? parsed.body : null}
  </>;
}

export function App() {
  const bridge = window.secagent;
  const route = new URLSearchParams(window.location.search);
  if (route.has("settings")) return <SettingsApp />;
  if (route.has("wake")) return <WakeOverlay />;
  if (route.has("voice-wake")) return <VoiceWakeListener />;
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [sessionMenuDismissed, setSessionMenuDismissed] = useState(false);
  const [allSessionsOpen, setAllSessionsOpen] = useState(false);
  const [session, setSession] = useState<SessionData | null>(null);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [previewAttachment, setPreviewAttachment] = useState<ChatAttachment | null>(null);
  const [attachmentError, setAttachmentError] = useState("");
  const [composerDragging, setComposerDragging] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelSubmenu, setModelSubmenu] = useState<"model" | "effort" | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("high");
  const [defaultEffort, setDefaultEffort] = useState<ReasoningEffort>("high");
  const [customModelMode, setCustomModelMode] = useState(false);
  const [sending, setSending] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [speechStatus, setSpeechStatus] = useState("");
  const [messageMenu, setMessageMenu] = useState<{ x: number; y: number; messageId: string; text: string; role: SessionMessage["role"]; selection: string } | null>(null);
  const [quotedText, setQuotedText] = useState("");
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [readingStatus, setReadingStatus] = useState<"loading" | "playing" | null>(null);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const messagesRef = useRef<HTMLDivElement>(null);
  const answerContentRef = useRef<HTMLDivElement>(null);
  const executionSummaryRef = useRef<HTMLButtonElement>(null);
  const answerScrollPhase = useRef<"follow-bottom" | "settling" | "locked">("follow-bottom");
  const answerScrollLockTimer = useRef<number | undefined>(undefined);
  const answerStartScrollPending = useRef(false);
  const modelMenuEnd = useRef<HTMLDivElement>(null);
  const orderedModels = useMemo(() => [...models.filter(isOfficialModel), ...models.filter((model) => !isOfficialModel(model))], [models]);
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const reasoningEfforts = useMemo(() => reasoningEffortsForModel(selectedModel), [selectedModel]);
  useEffect(() => {
    bridge.setWakeContext({ sessionId: session?.meta.id, modelId: selectedModelId || undefined, reasoningEffort: customModelMode ? reasoningEffort : defaultEffort });
  }, [bridge, session?.meta.id, selectedModelId, reasoningEffort, defaultEffort, customModelMode]);
  useEffect(() => {
    if (!reasoningEfforts.includes(reasoningEffort)) setReasoningEffort("high");
  }, [reasoningEffort, reasoningEfforts]);
  const initializing = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<{ context: AudioContext; stream: MediaStream; source: MediaStreamAudioSourceNode; processor: ScriptProcessorNode } | undefined>(undefined);
  const speechInsert = useRef({ start: 0, end: 0 });
  const speechAnchor = useRef(0);
  const speechAudio = useRef<HTMLAudioElement | null>(null);
  const speechRun = useRef(0);

  useEffect(() => {
    if (!bridge || initializing.current) return;
    initializing.current = true;
    void (async () => {
      // The remote official model catalog can be slow or temporarily unavailable.
      // Start it in the background so restoring the session remains responsive.
      const modelsPromise = bridge.listModels()
        .then((configured) => {
          setModels(configured);
          return configured;
        })
        .catch(() => [] as ModelOption[]);
      const list = await bridge.listSessions();
      const [active, savedSettings] = await Promise.all([
        list[0] ? bridge.getSession(list[0].id) : bridge.createSession(),
        bridge.getSettings()
      ]);
      const customMode = Boolean(savedSettings.customModelMode);
      setCustomModelMode(customMode);
      const defaultReasoning = (savedSettings.defaultReasoningEffort || "high") as ReasoningEffort;
      setDefaultEffort(defaultReasoning);
      setReasoningEffort(defaultReasoning);
      setSessions(list);
      setSession(active);
      requestAnimationFrame(() => textareaRef.current?.focus());
      const configured = await modelsPromise;
      const preferred = configured.find((model) => model.id === savedSettings.defaultModelId)
        || configured.find((model) => isOfficialTierModel(model) && model.model === tierDefaultId)
        || configured[0];
      setSelectedModelId(preferred?.id || "");
    })();
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onSettingsChanged(() => {
      void bridge.listModels().then((models) => {
        setModels(models);
        void bridge.getSettings().then((settings) => {
          const customMode = Boolean(settings.customModelMode);
          setCustomModelMode(customMode);
          setDefaultEffort((settings.defaultReasoningEffort || "high") as ReasoningEffort);
          setSelectedModelId((current) => {
            if (models.some((model) => model.id === (settings.defaultModelId || current))) return settings.defaultModelId || current;
            const tier = models.find((model) => isOfficialTierModel(model) && model.model === tierDefaultId);
            if (tier) return tier.id;
            return models[0]?.id || "";
          });
          setReasoningEffort(settings.defaultReasoningEffort || "high");
        });
      });
    });
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onSpeechEvent((event) => {
      const data = event as { type?: string; text?: string; message?: string };
      if (data.type === "ready") setSpeechStatus("正在聆听…");
      if (data.type === "optimizing") setSpeechStatus("识别优化中…");
      if (data.type === "partial" || data.type === "final" || data.type === "enhanced") {
        const text = data.text || "";
        // Capture the range before queueing the React update. The updater runs later;
        // reading speechInsert.current inside it would otherwise see the advanced
        // insertion point from the final-event bookkeeping and append the same text twice.
        const insertion = data.type === "enhanced" ? { start: speechAnchor.current, end: speechInsert.current.end } : speechInsert.current;
        setDraft((current) => {
          const next = current.slice(0, insertion.start) + text + current.slice(insertion.end);
          const nextPoint = insertion.start + text.length;
          speechInsert.current = data.type === "final" || data.type === "enhanced"
            ? { start: nextPoint, end: nextPoint }
            : { start: insertion.start, end: nextPoint };
          return next;
        });
        if (data.type === "final" || data.type === "enhanced") {
          setSpeechStatus("正在聆听…");
        }
      }
      if (data.type === "enhance_error") setSpeechStatus("增强识别失败，已使用流式结果");
      if (data.type === "error") {
        setSpeechStatus(data.message || "语音识别失败");
        setRecording(false);
      }
      if (data.type === "stopped") setSpeechStatus("");
    });
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onRuntimeEvent((event) => {
      const item = event as TraceEvent;
      setTrace((current) => [...current, item]);
    });
  }, [bridge]);

  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!modelMenuEnd.current?.contains(event.target as Node)) { setModelMenuOpen(false); setModelSubmenu(null); }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, []);

  useEffect(() => {
    const closeMenu = () => setMessageMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") { closeMenu(); setPreviewAttachment(null); } };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", closeMenu); document.removeEventListener("keydown", closeOnEscape); };
  }, []);

  const stopReading = () => {
    speechRun.current += 1;
    speechAudio.current?.pause();
    speechAudio.current = null;
    setSpeakingMessageId(null);
    setReadingStatus(null);
  };

  const readMessage = async (messageId: string, content: string) => {
    stopReading();
    const run = speechRun.current;
    const plain = content.replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-z]*\n?/i, "").replace(/```$/, ""))
      .replace(/!\[([^]]*)\]\([^)]*\)/g, "$1").replace(/\[([^]]+)\]\([^)]*\)/g, "$1")
      .replace(/[#*_>`~-]/g, "").replace(/\s+/g, " ").trim();
    const chunks = plain.match(/[^。！？!?；;，,：:\n]+[。！？!?；;，,：:]?|[^。！？!?；;，,：:]+$/g)?.map((item) => item.trim()).filter(Boolean) || [];
    if (!chunks.length) return;
    setSpeakingMessageId(messageId);
    setReadingStatus("loading");
    try {
      let nextBuffer = await bridge.synthesizeSpeech(chunks[0]);
      for (let index = 0; index < chunks.length && speechRun.current === run; index += 1) {
        const following = index + 1 < chunks.length ? bridge.synthesizeSpeech(chunks[index + 1]) : undefined;
        const audio = new Audio(`data:audio/mpeg;base64,${nextBuffer}`);
        setReadingStatus("playing");
        speechAudio.current = audio;
        const ended = new Promise<void>((resolve, reject) => { audio.onended = () => resolve(); audio.onerror = () => reject(new Error("音频播放失败")); });
        await audio.play();
        await ended;
        speechAudio.current = null;
        if (following) nextBuffer = await following;
      }
    } catch (error) {
      if (speechRun.current === run) console.warn("TTS failed", error);
    } finally {
      if (speechRun.current === run) { setSpeakingMessageId(null); setReadingStatus(null); }
    }
  };

  const activeTrace = useMemo(() => trace.filter((item) => item.sessionId === session?.meta.id), [trace, session?.meta.id]);
  const manuallyStopped = useMemo(() => activeTrace.some((item) => item.stage === "runtime.stopped"), [activeTrace]);
  const finalStreamStart = useMemo(() => activeTrace.reduce((start, item, index) => item.stage === "model.output.reset" ? index + 1 : start, 0), [activeTrace]);
  const streamingOutput = useMemo(() => activeTrace.slice(finalStreamStart).filter((item) => item.stage === "model.output.delta")
    .map((item) => { const data = item.data as { text?: string; kind?: string }; return data.kind === "answer" || !data.kind ? data.text || "" : ""; }).join(""), [activeTrace, finalStreamStart]);
  useEffect(() => {
    if (!sending || !streamingOutput || !messagesRef.current || !executionSummaryRef.current) return;
    const messages = messagesRef.current;
    const summary = executionSummaryRef.current;
    const target = messages.scrollTop + summary.getBoundingClientRect().top - messages.getBoundingClientRect().top;
    const maxScrollTop = Math.max(0, messages.scrollHeight - messages.clientHeight);
    if (target > maxScrollTop) {
      if (answerScrollLockTimer.current !== undefined) {
        window.clearTimeout(answerScrollLockTimer.current);
        answerScrollLockTimer.current = undefined;
      }
      answerScrollPhase.current = "follow-bottom";
      messages.scrollTo({ top: maxScrollTop, behavior: "auto" });
      console.debug("[SecAgent scroll] follow-bottom", { outputLength: streamingOutput.length, targetScrollTop: target, maxScrollTop, scrollTop: messages.scrollTop });
      return;
    }

    if (answerScrollPhase.current !== "follow-bottom") return;
    answerScrollPhase.current = "settling";
    messages.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    console.debug("[SecAgent scroll] settle-summary", { outputLength: streamingOutput.length, targetScrollTop: target, maxScrollTop, scrollTop: messages.scrollTop });
    answerScrollLockTimer.current = window.setTimeout(() => {
      answerScrollPhase.current = "locked";
      answerScrollLockTimer.current = undefined;
      console.debug("[SecAgent scroll] summary-locked", { scrollTop: messages.scrollTop });
    }, 320);
  }, [streamingOutput, sending]);
  useEffect(() => {
    if (finishing || !answerStartScrollPending.current || !messagesRef.current || !answerContentRef.current) return;
    answerStartScrollPending.current = false;
    if (answerScrollLockTimer.current !== undefined) window.clearTimeout(answerScrollLockTimer.current);
    answerScrollLockTimer.current = undefined;
    answerScrollPhase.current = "locked";
    const messages = messagesRef.current;
    const answer = answerContentRef.current;
    requestAnimationFrame(() => {
      const target = Math.max(0, messages.scrollTop + answer.getBoundingClientRect().top - messages.getBoundingClientRect().top - 12);
      messages.scrollTo({ top: target, behavior: "auto" });
      console.debug("[SecAgent scroll] completed-answer-start", { targetScrollTop: target, scrollTop: messages.scrollTop });
    });
  }, [finishing]);
  const timelineTrace = useMemo(() => activeTrace.filter((item) => item.stage !== "model.output.delta"), [activeTrace]);
  const executionSeconds = useMemo(() => {
    const start = activeTrace.find((item) => item.stage === "user.request");
    const end = [...activeTrace].reverse().find((item) => item.stage === "assistant.response" || item.stage === "runtime.error");
    if (!start) return undefined;
    const endAt = end ? new Date(end.at).getTime() : Date.now();
    return Math.max(1, Math.round((endAt - new Date(start.at).getTime()) / 1000));
  }, [activeTrace]);
  const traceActivities = useMemo(() => {
    const activities: AssistantActivity[] = [];
    for (const item of activeTrace) {
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
      if (item.stage === "secagent.skills/auto-load") {
        const skills = Array.isArray(item.data) ? item.data as Array<{ name?: unknown; path?: unknown }> : [];
        for (const skill of skills) if (typeof skill.name === "string" && typeof skill.path === "string") activities.push({ kind: "skill-auto-load", name: skill.name, path: skill.path });
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
  }, [activeTrace]);
  const activeStepKind = useMemo(() => {
    const last = [...activeTrace].reverse().find((item) => item.stage === "model.output.delta" || item.stage === "mcp.tools/call" || item.stage === "mcp.tools/result" || item.stage === "secagent.tools/call" || item.stage === "secagent.tools/result");
    if (!last) return undefined;
    if (last.stage === "model.output.delta") return (last.data as { kind?: string }).kind || "answer";
    return "tool";
  }, [activeTrace]);
  const latestAssistantId = useMemo(() => session?.messages.filter((message) => message.role === "assistant").at(-1)?.id, [session?.messages]);
  const changeSession = async (id: string) => {
    if (!bridge) return;
    const [next, runtimeEvents] = await Promise.all([bridge.getSession(id), bridge.getRuntimeEvents(id)]);
    setSession(next);
    setTrace((current) => {
      const merged = new Map(current.map((item) => [`${item.sessionId}:${item.sequence}`, item]));
      for (const item of runtimeEvents) merged.set(`${item.sessionId}:${item.sequence}`, item);
      return [...merged.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId) || left.sequence - right.sequence);
    });
  };
  const createSession = async () => { if (bridge) { const next = await bridge.createSession(); setSessions(await bridge.listSessions()); setSession(next); setTrace([]); requestAnimationFrame(() => textareaRef.current?.focus()); } };
  const deleteSession = async (id: string) => {
    if (!bridge) return;
    const remaining = await bridge.deleteSession(id);
    if (id === session?.meta.id) {
      const next = remaining[0] ? await bridge.getSession(remaining[0].id) : await bridge.createSession();
      setSession(next);
      setTrace([]);
      setSessions(await bridge.listSessions());
    } else {
      setSessions(remaining);
    }
  };
  const addImageFiles = async (files: File[] | FileList) => {
    const imageFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (!imageFiles.length) {
      setAttachmentError("这里只支持图片文件");
      return;
    }
    const available = Math.max(0, 4 - attachments.length);
    if (!available) {
      setAttachmentError("最多添加 4 张图片");
      return;
    }
    const accepted = imageFiles.slice(0, available);
    const tooLarge = accepted.filter((file) => file.size > 12 * 1024 * 1024);
    if (tooLarge.length) setAttachmentError("单张图片不能超过 12 MB");
    const readable = accepted.filter((file) => file.size <= 12 * 1024 * 1024);
    const next = await Promise.all(readable.map((file) => new Promise<ChatAttachment | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, name: file.name || "图片", mimeType: file.type, dataUrl: reader.result, size: file.size } : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    })));
    const valid = next.filter((item): item is ChatAttachment => Boolean(item));
    if (valid.length) {
      setAttachments((current) => [...current, ...valid].slice(0, 4));
      setDraft((current) => current || "\u200b");
      setAttachmentError(tooLarge.length ? "部分图片因大小限制未添加" : "");
    }
  };
  const handlePaste = (event: ReactClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    void addImageFiles(files);
  };
  const handleDrop = (event: ReactDragEvent<HTMLFormElement>) => {
    event.preventDefault();
    setComposerDragging(false);
    void addImageFiles(Array.from(event.dataTransfer.files));
  };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = buildQuotedUserMessage(quotedText, draft);
    if ((!text && !attachments.length) || !session || sending) return;
    const sentAttachments = attachments;
    const optimisticMessage: SessionMessage = { id: `pending-${Date.now()}`, role: "user", content: text, attachments: sentAttachments, createdAt: new Date().toISOString() };
    setSession((current) => current ? { ...current, messages: [...current.messages, optimisticMessage] } : current);
    if (answerScrollLockTimer.current !== undefined) window.clearTimeout(answerScrollLockTimer.current);
    answerScrollLockTimer.current = undefined;
    answerScrollPhase.current = "follow-bottom";
    requestAnimationFrame(() => {
      const messages = messagesRef.current;
      if (!messages) return;
      const nextScrollTop = Math.max(0, messages.scrollHeight - messages.clientHeight);
      console.debug("[SecAgent scroll] user-message", { currentScrollTop: messages.scrollTop, nextScrollTop, maxScrollTop: nextScrollTop });
      messages.scrollTo({ top: nextScrollTop, behavior: "smooth" });
    });
    setDraft(""); setQuotedText(""); setAttachments([]); setAttachmentError(""); setTrace([]); setFinishing(false); setSending(true);
    let completed = false;
    try {
      if (bridge) {
        // 关闭自定义模型模式：下拉只有三个虚拟档位、无推理强度选项，一律使用默认推理强度。
        // 开启模式：档位顺序只是后端的 fallback 顺序，与推理强度无关，使用用户选择的推理强度。
        const effort = customModelMode ? reasoningEffort : defaultEffort;
        const response = await bridge.sendMessage(session.meta.id, text, selectedModelId, effort, sentAttachments);
        setSession(response);
        setSessions(await bridge.listSessions());
        completed = true;
        answerStartScrollPending.current = true;
        setFinishing(true);
      }
    } finally {
      if (completed) await new Promise((resolve) => setTimeout(resolve, 260));
      setFinishing(false);
      setSending(false);
    }
  };
  const stop = async () => {
    if (!bridge || !session || !sending) return;
    await bridge.stopMessage(session.meta.id);
  };

  const stopRecording = async () => {
    const audio = audioRef.current;
    audioRef.current = undefined;
    audio?.processor.disconnect();
    audio?.source.disconnect();
    audio?.stream.getTracks().forEach((track) => track.stop());
    await audio?.context.close();
    await bridge.stopSpeech();
    setRecording(false);
    setSpeechStatus("");
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const toggleRecording = async () => {
    if (recording) { await stopRecording(); return; }
    if (!navigator.mediaDevices?.getUserMedia) { setSpeechStatus("当前环境不支持麦克风"); return; }
    try {
      const textArea = textareaRef.current;
      const start = textArea?.selectionStart ?? draft.length;
      const end = textArea?.selectionEnd ?? start;
      speechInsert.current = { start, end };
      speechAnchor.current = start;
      setRecording(true);
      setSpeechStatus("正在启动语音识别…");
      await bridge.startSpeech();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const context = new AudioContext({ sampleRate: 16000 });
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (event) => bridge.sendSpeechAudio(new Float32Array(event.inputBuffer.getChannelData(0)));
      source.connect(processor);
      processor.connect(context.destination);
      audioRef.current = { context, stream, source, processor };
      requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (error) {
      setSpeechStatus(`无法打开麦克风：${error instanceof Error ? error.message : String(error)}`);
      setRecording(false);
      await bridge.stopSpeech();
    }
  };

  if (!bridge) {
    return <main className="app-shell"><section className="connection-error"><h1>SecAgent 桌面桥接未加载</h1><p>请退出应用后重新运行 <code>pnpm dev</code>。若仍出现此提示，请检查 Electron 的 preload 启动日志。</p></section></main>;
  }

  return <main className="app-shell">
    <header className={`topbar ${bridge.platform === "darwin" ? "macos" : ""}`}>
      <div className="brand"><span>SecAgent</span></div>
      <div className={`session-menu ${bridge.platform === "win32" ? "windows" : ""}`}>
        <div className={`session-options ${sessionMenuDismissed ? "dismissed" : ""}`} onMouseEnter={() => setSessionMenuDismissed(false)}>
          <button className="session-trigger" aria-label="选择历史会话"><img className="session-chevron" src="/session-chevron.svg" alt="" /> <span>{session?.meta.title || "问候"}</span></button>
          <div className="session-list" role="menu">
            {sessions.filter((item) => item.id !== session?.meta.id).slice(0, 10).map((item) => <button className="session-option" role="menuitem" key={item.id} onClick={() => { setSessionMenuDismissed(true); void changeSession(item.id); }}>{item.title}</button>)}
            <button className="session-option all-sessions-option" role="menuitem" onClick={() => { setSessionMenuDismissed(true); setAllSessionsOpen(true); }}>全部会话...</button>
          </div>
        </div>
        <button className="new-session-button" type="button" aria-label="新建会话" title="新建会话" onClick={() => void createSession()}>+</button>
      </div>
    </header>
    {allSessionsOpen && <div className="session-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAllSessionsOpen(false); }}>
      <section className="session-modal" role="dialog" aria-modal="true" aria-labelledby="all-sessions-title">
        <div className="session-modal-header"><div><p className="eyebrow">SECAGENT</p><h2 id="all-sessions-title">全部会话</h2></div><button className="modal-close" type="button" aria-label="关闭" onClick={() => setAllSessionsOpen(false)}>×</button></div>
        <div className="all-session-list">
          {sessions.length === 0 && <p className="all-session-empty">还没有会话</p>}
          {sessions.map((item) => <div className={`all-session-item ${item.id === session?.meta.id ? "active" : ""}`} key={item.id}>
            <button className="all-session-title" type="button" onClick={() => { setAllSessionsOpen(false); void changeSession(item.id); }}>{item.title}</button>
            <time>{new Date(item.updatedAt).toLocaleString()}</time>
            <button className="delete-session-button" type="button" aria-label={`删除会话 ${item.title}`} onClick={() => { if (window.confirm(`确定删除会话“${item.title}”吗？`)) void deleteSession(item.id); }}>删除</button>
          </div>)}
        </div>
        <button className="modal-new-session" type="button" onClick={() => { setAllSessionsOpen(false); void createSession(); }}>+ 新建会话</button>
      </section>
    </div>}
    {messageMenu && <div className="message-context-menu" role="menu" style={{ left: messageMenu.x, top: messageMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
      {messageMenu.role !== "user" && <button type="button" role="menuitem" onClick={() => { const item = messageMenu; setMessageMenu(null); if (speakingMessageId === item.messageId) stopReading(); else void readMessage(item.messageId, item.text); }}>{speakingMessageId === messageMenu.messageId ? "停止朗读" : "朗读"}</button>}
      <button type="button" role="menuitem" onClick={() => { const text = messageMenu.selection || messageMenu.text; setMessageMenu(null); void copyText(text); }}>复制</button>
      {messageMenu.selection && <button type="button" role="menuitem" onClick={() => { const query = messageMenu.selection; setMessageMenu(null); void bridge.openExternal(webSearchUrl(query)); }}>搜索</button>}
      {messageMenu.selection && <button type="button" role="menuitem" onClick={() => { setQuotedText(messageMenu.selection); setMessageMenu(null); requestAnimationFrame(() => textareaRef.current?.focus()); }}>引用</button>}
    </div>}
    {previewAttachment && <div className="image-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewAttachment(null); }}>
      <section className="image-preview" role="dialog" aria-modal="true" aria-label={`预览 ${previewAttachment.name}`} onMouseDown={(event) => event.stopPropagation()}>
        <button type="button" className="image-preview-close" aria-label="关闭图片预览" onClick={() => setPreviewAttachment(null)}>×</button>
        <img src={previewAttachment.dataUrl} alt={previewAttachment.name} />
      </section>
    </div>}
    <section className="workspace">
      <section className="conversation" aria-label="当前会话">
        <div className="messages" ref={messagesRef}>
          {session?.messages.length === 0 && <div className="empty-state"><h2>开始一个课堂操作</h2><p>例如：查询张三积分，或给张三加 2 分。</p></div>}
          {session?.messages.map((message) => {
            const activities = message.activities?.length ? message.activities : message.toolCalls?.length ? message.toolCalls.map((call) => ({ kind: "tool" as const, ...call })) : message.id === latestAssistantId ? traceActivities : [];
            const reading = speakingMessageId === message.id;
            const visibleContent = message.role === "assistant" ? stripWorkspaceFilesMarkup(message.content) : message.content;
            return <article className={`message ${message.role}`} key={message.id}><div className="message-content"><div className="message-meta">{message.role === "user" ? "教师" : "SecAgent"} · {new Date(message.createdAt).toLocaleTimeString()}</div>{message.role === "assistant" && <MessageActivities activities={activities} elapsedSeconds={message.id === latestAssistantId ? executionSeconds : undefined} stopped={message.stopped || (message.id === latestAssistantId && manuallyStopped)} isExecuting={finishing && message.id === latestAssistantId} activeStepKind={message.id === latestAssistantId ? activeStepKind : undefined} summaryRef={finishing && message.id === latestAssistantId ? executionSummaryRef : undefined} />}{message.role === "user" && message.attachments?.length ? <AttachmentStrip attachments={message.attachments} onOpen={setPreviewAttachment} /> : null}<div className="bubble-row"><div className="avatar">{message.role === "user" ? "你" : <img src="/icon.svg" alt="SecAgent" />}</div><div ref={message.role === "assistant" && message.id === latestAssistantId ? answerContentRef : undefined} className={`bubble ${message.role === "assistant" ? "markdown-bubble" : ""}`} onContextMenu={(event) => { event.preventDefault(); const selection = selectionInElement(event.currentTarget); setMessageMenu({ x: Math.min(event.clientX, window.innerWidth - 180), y: Math.min(event.clientY, window.innerHeight - 176), messageId: message.id, text: message.content, role: message.role, selection }); }}>{message.role === "assistant" ? <MarkdownContent>{visibleContent}</MarkdownContent> : <UserQuotedContent content={message.content} />}</div>{message.role === "assistant" && <WorkspaceFileStrip content={message.content} />}{reading && (readingStatus === "loading" ? <LoaderCircle className="reading-icon loading" aria-label="正在生成语音" /> : <Volume2 className="reading-icon" aria-label="正在朗读" />)}</div></div></article>;
          })}
          {sending && !finishing && <article className="message assistant"><div className="message-content"><div className="message-meta">SecAgent · 正在生成</div><MessageActivities activities={traceActivities} elapsedSeconds={executionSeconds} isExecuting activeStepKind={activeStepKind} summaryRef={executionSummaryRef} /><div className="bubble-row"><div className="avatar"><img src="/icon.svg" alt="SecAgent" /></div><div className="bubble loading markdown-bubble">{streamingOutput ? <MarkdownContent>{stripWorkspaceFilesMarkup(streamingOutput)}</MarkdownContent> : "正在调用模型与工具…"}</div><WorkspaceFileStrip content={streamingOutput} /></div></div></article>}
          <div />
        </div>
        <form ref={formRef} className={`composer ${composerDragging ? "dragging" : ""}`} onSubmit={send} onClick={(event) => { if ((event.target as Element).closest('.icon-button img[src="/image-icon.svg"]')) fileInputRef.current?.click(); }} onPaste={handlePaste} onDragEnter={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setComposerDragging(true); } }} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setComposerDragging(false); }} onDrop={handleDrop}><input ref={fileInputRef} className="visually-hidden" type="file" accept="image/*" multiple onChange={(event) => { void addImageFiles(event.target.files || []); event.target.value = ""; }} />{attachments.length > 0 && <div className="composer-attachments"><AttachmentStrip attachments={attachments} removable onRemove={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))} /></div>}{quotedText && <div className="composer-quote"><div><strong>引用</strong><p>{quotedText}</p></div><button type="button" aria-label="取消引用" onClick={() => setQuotedText("")}>×</button></div>}{attachmentError && <div className="attachment-error">{attachmentError}</div>}
          <div className="composer-actions"><button type="button" className="icon-button" aria-label="添加图片"><img className="composer-icon" src="/image-icon.svg" alt="" /></button><button type="button" className={`icon-button mic-button ${recording ? "recording" : ""}`} aria-label={recording ? "停止语音输入" : "语音输入"} aria-pressed={recording} onClick={() => void toggleRecording()}><img className="composer-icon" src="/mic-icon.svg" alt="" /></button></div>
          <textarea ref={textareaRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !event.currentTarget.readOnly) { event.preventDefault(); formRef.current?.requestSubmit(); } }} placeholder={speechStatus || "问任何问题..."} rows={1} readOnly={recording} disabled={!session || sending} />
          <div className={`model-menu ${customModelMode ? "" : "virtual-model-menu"}`} ref={modelMenuEnd}>
            <button type="button" className={`model-picker ${customModelMode ? "" : "virtual-model-picker"}`} aria-label={customModelMode ? "选择模型和推理强度" : "选择虚拟模型"} aria-expanded={modelMenuOpen} onClick={() => { setModelMenuOpen((open) => !open); setModelSubmenu(null); }}>
              <span className="model-picker-copy"><strong>{selectedModel?.name || "未配置模型"}</strong>{customModelMode && <small>推理强度 · {reasoningEffortLabels[reasoningEffort]}</small>}</span>
              <img className={`model-chevron ${modelMenuOpen ? "open" : ""}`} src="/session-chevron.svg" alt="" />
            </button>
            {modelMenuOpen && <div className="model-options" role="menu">
              {customModelMode ? <Fragment>
                <button type="button" className={`model-setting-row ${modelSubmenu === "model" ? "selected" : ""}`} onClick={() => setModelSubmenu((current) => current === "model" ? null : "model")}><span>模型</span><span className="model-setting-value">{selectedModel?.name || "未配置模型"}<span className="model-row-chevron">›</span></span></button>
                {modelSubmenu === "model" && <div className="model-submenu" role="listbox">{orderedModels.map((model, index) => <Fragment key={model.id}>{index > 0 && isOfficialModel(orderedModels[index - 1]) !== isOfficialModel(model) && <div className="model-divider" role="separator" /> }<button type="button" className={`model-option ${model.id === selectedModelId ? "selected" : ""}`} role="option" aria-selected={model.id === selectedModelId} onClick={() => { setSelectedModelId(model.id); setModelSubmenu(null); }}>{model.name}</button></Fragment>)}</div>}
                <button type="button" className={`model-setting-row ${modelSubmenu === "effort" ? "selected" : ""}`} onClick={() => setModelSubmenu((current) => current === "effort" ? null : "effort")}><span>推理强度</span><span className="model-setting-value">{reasoningEffortLabels[reasoningEffort]}<span className="model-row-chevron">›</span></span></button>
                {modelSubmenu === "effort" && <div className="model-submenu" role="listbox">{reasoningEfforts.map((effort) => <button type="button" className={`model-option ${effort === reasoningEffort ? "selected" : ""}`} role="option" aria-selected={effort === reasoningEffort} key={effort} onClick={() => { setReasoningEffort(effort); setModelSubmenu(null); }}>{reasoningEffortLabels[effort]}</button>)}</div>}
              </Fragment> : orderedModels.map((model) => (
                <button type="button" className={`model-option ${model.id === selectedModelId ? "selected" : ""}`} role="option" aria-selected={model.id === selectedModelId} onClick={() => { setSelectedModelId(model.id); setModelSubmenu(null); }} key={model.id}>{model.name}</button>
              ))}
            </div>}
          </div>
          {sending ? <button className="send-button stop-button" type="button" aria-label="停止生成" title="停止生成" onClick={() => void stop()}><Square aria-hidden="true" /></button> : <button className="send-button" type="submit" aria-label="发送" disabled={!session || !(draft.replace(/\u200b/g, "").trim() || quotedText || attachments.length)}><ArrowUp aria-hidden="true" /></button>}
        </form>
      </section>
      <aside className="trace-panel">
        <div className="trace-heading"><p className="eyebrow">运行轨迹</p><h2>本轮与本会话事件</h2></div>
        <div className="trace-list">
          {activeTrace.length === 0 && <p className="trace-empty">发送消息后，模型请求、响应、工具调用和返回结果会实时显示并保存到会话目录。</p>}
          {timelineTrace.map((item) => <details key={`${item.sequence}-${item.stage}`} className={`trace-item ${item.stage.startsWith("mcp.tools/") ? "tool-event" : ""}`}>
            <summary><span className="trace-order">{item.sequence}</span><span>{traceLabel[item.stage] || item.stage}</span><time>{new Date(item.at).toLocaleTimeString()}</time></summary>
            <pre>{JSON.stringify(item.data, null, 2)}</pre>
          </details>)}
        </div>
      </aside>
    </section>
  </main>;
}
