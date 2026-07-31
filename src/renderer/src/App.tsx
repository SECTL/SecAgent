import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type TraceEvent = { sessionId: string; sequence: number; at: string; stage: string; data: unknown };

const traceLabel: Record<string, string> = {
  "user.request": "收到教师指令",
  "mcp.tools/list": "发现 MCP 工具",
  "secagent.skills/list": "发现 Skills",
  "model.agent.request": "准备模型请求",
  "model.request": "发送模型请求",
  "model.output.delta": "模型正在生成",
  "model.output.reset": "开始调用工具",
  "model.response": "收到完整模型响应",
  "mcp.tools/call": "调用 MCP 工具",
  "mcp.tools/result": "MCP 工具返回",
  "secagent.tools/call": "读取 Skill",
  "secagent.tools/result": "Skill 已读取",
  "model.agent.result": "模型任务完成",
  "assistant.response": "回复已保存",
  "runtime.error": "运行出错"
};

function toolTitle(name: string): string {
  return name.replace(/__/g, " · ").replace(/_/g, " ");
}

function MessageActivities({ activities }: { activities: AssistantActivity[] }) {
  if (!activities.length) return null;
  return <div className="message-tool-calls" aria-label="本消息的执行过程">
    {activities.map((activity, index) => activity.kind === "text"
      ? <section className="intermediate-output" key={`text-${index}`}><div className="intermediate-title">模型中间输出</div><ReactMarkdown remarkPlugins={[remarkGfm]}>{activity.content}</ReactMarkdown></section>
      : <details className="message-tool" key={`${activity.name}-${index}`}>
        <summary><span className="tool-icon">⌘</span><span className="tool-name">{toolTitle(activity.name)}</span><span className="tool-state">{"result" in activity ? "已完成" : "调用中"}</span></summary>
        <div className="tool-detail"><p>参数</p><pre>{JSON.stringify(activity.arguments, null, 2)}</pre><p>工具结果</p><pre>{"result" in activity ? JSON.stringify(activity.result, null, 2) : "正在等待返回…"}</pre></div>
      </details>)}
  </div>;
}

export function App() {
  const bridge = window.secagent;
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [sessionMenuDismissed, setSessionMenuDismissed] = useState(false);
  const [session, setSession] = useState<SessionData | null>(null);
  const [draft, setDraft] = useState("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [speechStatus, setSpeechStatus] = useState("");
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const messageEnd = useRef<HTMLDivElement>(null);
  const modelMenuEnd = useRef<HTMLDivElement>(null);
  const initializing = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const audioRef = useRef<{ context: AudioContext; stream: MediaStream; source: MediaStreamAudioSourceNode; processor: ScriptProcessorNode } | undefined>(undefined);
  const speechInsert = useRef({ start: 0, end: 0 });

  useEffect(() => {
    if (!bridge || initializing.current) return;
    initializing.current = true;
    void (async () => {
      const [list, configured] = await Promise.all([bridge.listSessions(), bridge.listModels()]);
      const active = list[0] ? await bridge.getSession(list[0].id) : await bridge.createSession();
      setModels(configured);
      setSelectedModelId(configured[0]?.id || "");
      setSessions(await bridge.listSessions());
      setSession(active);
    })();
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onSpeechEvent((event) => {
      const data = event as { type?: string; text?: string; message?: string };
      if (data.type === "ready") setSpeechStatus("正在聆听…");
      if (data.type === "partial" || data.type === "final") {
        const text = data.text || "";
        // Capture the range before queueing the React update. The updater runs later;
        // reading speechInsert.current inside it would otherwise see the advanced
        // insertion point from the final-event bookkeeping and append the same text twice.
        const insertion = speechInsert.current;
        setDraft((current) => {
          const next = current.slice(0, insertion.start) + text + current.slice(insertion.end);
          const nextPoint = insertion.start + text.length;
          speechInsert.current = data.type === "final"
            ? { start: nextPoint, end: nextPoint }
            : { start: insertion.start, end: nextPoint };
          return next;
        });
        if (data.type === "final") {
          setSpeechStatus("正在聆听…");
        }
      }
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

  useEffect(() => { messageEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [session?.messages.length]);

  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!modelMenuEnd.current?.contains(event.target as Node)) setModelMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, []);

  const activeTrace = useMemo(() => trace.filter((item) => item.sessionId === session?.meta.id), [trace, session?.meta.id]);
  const finalStreamStart = useMemo(() => activeTrace.reduce((start, item, index) => item.stage === "model.output.reset" ? index + 1 : start, 0), [activeTrace]);
  const streamingOutput = useMemo(() => activeTrace.slice(finalStreamStart).filter((item) => item.stage === "model.output.delta")
    .map((item) => (item.data as { text?: string }).text || "").join(""), [activeTrace]);
  const timelineTrace = useMemo(() => activeTrace.filter((item) => item.stage !== "model.output.delta"), [activeTrace]);
  const traceActivities = useMemo(() => {
    const activities: AssistantActivity[] = [];
    const partialTurns = new Map<number, string>();
    for (const item of activeTrace) {
      if (item.stage === "model.output.delta") {
        const data = item.data as { text?: unknown; turn?: unknown };
        if (typeof data.text === "string" && typeof data.turn === "number") partialTurns.set(data.turn, (partialTurns.get(data.turn) || "") + data.text);
      }
      if (item.stage === "model.output.reset") {
        const data = item.data as { turn?: unknown };
        const content = typeof data.turn === "number" ? partialTurns.get(data.turn) : undefined;
        if (content) activities.push({ kind: "text", content });
      }
      if (item.stage === "mcp.tools/call") {
        const data = item.data as { name?: unknown; arguments?: unknown };
        if (typeof data.name === "string") activities.push({ kind: "tool", name: data.name, arguments: data.arguments ?? {} });
      }
      if (item.stage === "mcp.tools/result") {
        const data = item.data as { name?: unknown; result?: unknown };
        if (typeof data.name === "string") {
          const activity = [...activities].reverse().find((entry): entry is Extract<AssistantActivity, { kind: "tool" }> => entry.kind === "tool" && entry.name === data.name && !("result" in entry));
          if (activity) activity.result = data.result;
        }
      }
    }
    return activities;
  }, [activeTrace]);
  const latestAssistantId = useMemo(() => session?.messages.filter((message) => message.role === "assistant").at(-1)?.id, [session?.messages]);
  const changeSession = async (id: string) => { if (bridge) { setSession(await bridge.getSession(id)); setTrace([]); } };
  const createSession = async () => { if (bridge) { const next = await bridge.createSession(); setSessions(await bridge.listSessions()); setSession(next); setTrace([]); } };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !session || sending) return;
    const optimisticMessage: SessionMessage = { id: `pending-${Date.now()}`, role: "user", content: text, createdAt: new Date().toISOString() };
    setSession((current) => current ? { ...current, messages: [...current.messages, optimisticMessage] } : current);
    setDraft(""); setTrace([]); setSending(true);
    try { if (bridge) { setSession(await bridge.sendMessage(session.meta.id, text, selectedModelId)); setSessions(await bridge.listSessions()); } }
    finally { setSending(false); }
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
      setRecording(true);
      setSpeechStatus("正在启动本地模型…");
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
    <header className="topbar">
      <div className="brand"><span>SecAgent</span></div>
      <div className="session-menu">
        <div className={`session-options ${sessionMenuDismissed ? "dismissed" : ""}`} onMouseEnter={() => setSessionMenuDismissed(false)}>
          <button className="session-trigger" aria-label="选择历史会话"><img className="session-chevron" src="/session-chevron.svg" alt="" /> <span>{session?.meta.title || "问候"}</span></button>
          <div className="session-list" role="menu">
            {sessions.filter((item) => item.id !== session?.meta.id).map((item) => <button className="session-option" role="menuitem" key={item.id} onClick={() => { setSessionMenuDismissed(true); void changeSession(item.id); }}>{item.title}</button>)}
            <button className="session-option new-session" role="menuitem" onClick={() => { setSessionMenuDismissed(true); void createSession(); }}>+ 新会话</button>
          </div>
        </div>
      </div>
    </header>
    <section className="workspace">
      <section className="conversation" aria-label="当前会话">
        <div className="messages">
          {session?.messages.length === 0 && <div className="empty-state"><h2>开始一个课堂操作</h2><p>例如：查询张三积分，或给张三加 2 分。</p></div>}
          {session?.messages.map((message) => {
            const activities = message.activities?.length ? message.activities : message.toolCalls?.length ? message.toolCalls.map((call) => ({ kind: "tool" as const, ...call })) : message.id === latestAssistantId ? traceActivities : [];
            return <article className={`message ${message.role}`} key={message.id}><div className="avatar">{message.role === "user" ? "你" : <img src="/icon.svg" alt="SecAgent" />}</div><div><div className="message-meta">{message.role === "user" ? "教师" : "SecAgent"} · {new Date(message.createdAt).toLocaleTimeString()}</div>{message.role === "assistant" && <MessageActivities activities={activities} />}<div className="bubble">{message.role === "assistant" ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown> : message.content}</div></div></article>;
          })}
          {sending && <article className="message assistant"><div className="avatar"><img src="/icon.svg" alt="SecAgent" /></div><div><div className="message-meta">SecAgent · 正在生成</div><MessageActivities activities={traceActivities} /><div className="bubble loading">{streamingOutput ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingOutput}</ReactMarkdown> : "正在调用模型与工具…"}</div></div></article>}
          <div ref={messageEnd} />
        </div>
        <form className="composer" onSubmit={send}>
          <div className="composer-actions"><button type="button" className="icon-button" aria-label="添加图片"><img className="composer-icon" src="/image-icon.svg" alt="" /></button><button type="button" className={`icon-button mic-button ${recording ? "recording" : ""}`} aria-label={recording ? "停止语音输入" : "语音输入"} aria-pressed={recording} onClick={() => void toggleRecording()}><img className="composer-icon" src="/mic-icon.svg" alt="" /></button></div>
          <textarea ref={textareaRef} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={speechStatus || "问任何问题..."} rows={1} readOnly={recording} disabled={!session || sending} />
          <div className="model-menu" ref={modelMenuEnd}>
            <button type="button" className="model-picker" aria-label="选择模型" aria-expanded={modelMenuOpen} onClick={() => setModelMenuOpen((open) => !open)}><span className="model-name">{models.find((model) => model.id === selectedModelId)?.name || "未配置模型"}</span><img className={`model-chevron ${modelMenuOpen ? "open" : ""}`} src="/session-chevron.svg" alt="" /></button>
            <div className={`model-options ${modelMenuOpen ? "open" : ""}`} role="listbox">
              {models.map((model) => <button type="button" className={`model-option ${model.id === selectedModelId ? "selected" : ""}`} role="option" aria-selected={model.id === selectedModelId} key={model.id} onClick={() => { setSelectedModelId(model.id); setModelMenuOpen(false); }}>{model.name}</button>)}
            </div>
          </div>
          <button className="send-button" type="submit" aria-label="发送" disabled={!draft.trim() || !session || sending}>↑</button>
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
