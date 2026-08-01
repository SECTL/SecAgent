import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
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

const emptyModel = (): ModelProfile => ({ id: `model-${Date.now()}`, name: "新模型", provider: "openai-compatible", model: "", apiKeyEnv: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1", endpoint: "/chat/completions", maxTokens: 16384 });
const emptyMcp = (): McpServerConfig => ({ transport: "http", url: "http://127.0.0.1:3901/mcp", enabled: true });

function SettingsApp() {
  const bridge = window.secagent;
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => { void bridge.getSettings().then(setSettings).catch((reason) => setError(String(reason))); }, [bridge]);
  if (!settings) return <main className="settings-shell"><p>正在读取配置…</p></main>;
  const updateModel = (index: number, patch: Partial<ModelProfile>) => setSettings((current) => current && { ...current, models: current.models.map((model, item) => item === index ? { ...model, ...patch } : model) });
  const selectProvider = (index: number, provider: ModelProfile["provider"]) => updateModel(index, provider === "google"
    ? { provider, apiKey: "", apiKeyConfigured: false, apiKeyEnv: "GEMINI_API_KEY", baseUrl: "https://generativelanguage.googleapis.com/v1beta", endpoint: "", model: "" }
    : provider === "anthropic"
      ? { provider, apiKey: "", apiKeyConfigured: false, apiKeyEnv: "ANTHROPIC_API_KEY", baseUrl: "https://api.anthropic.com", endpoint: "/v1/messages" }
      : { provider, apiKey: "", apiKeyConfigured: false, apiKeyEnv: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1", endpoint: "/chat/completions" });
  const updateServer = (name: string, patch: Partial<McpServerConfig>) => setSettings((current) => current && { ...current, mcp: { servers: Object.fromEntries(Object.entries(current.mcp.servers).map(([key, server]) => [key, key === name ? { ...server, ...patch } : server])) } });
  const renameServer = (oldName: string, newName: string) => {
    const name = newName.trim();
    if (!name || (name !== oldName && settings.mcp.servers[name])) return;
    setSettings((current) => current && { ...current, mcp: { servers: Object.fromEntries(Object.entries(current.mcp.servers).map(([key, server]) => [key === oldName ? name : key, server])) } });
  };
  const save = async () => {
    setError(""); setSaved(false);
    try { const result = await bridge.saveSettings(settings); setSettings(result); setSaved(true); setTimeout(() => setSaved(false), 2200); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <main className="settings-shell">
    <header className="settings-header"><div><p className="eyebrow">SECAGENT</p><h1>设置</h1><p>修改后立即写入工作目录的 secagent.yaml。</p></div><button className="primary-button" onClick={() => void save()}>保存设置</button></header>
    {error && <div className="settings-error">{error}</div>}{saved && <div className="settings-success">设置已保存，下一次请求立即生效。</div>}
    <section className="settings-section"><div className="section-title"><div><h2>模型</h2><p>Google Gemini 填写 API Key 即可自动获取常用文本模型；模型名称可留空。</p></div><button className="secondary-button" onClick={() => setSettings((current) => current && { ...current, models: [...current.models, emptyModel()] })}>+ 添加模型</button></div>
      <div className="settings-cards">{settings.models.map((model, index) => <article className="settings-card" key={model.id}>
        <div className="card-heading"><strong>{model.name || model.model || "未命名模型"}</strong>{settings.models.length > 1 && <button className="text-button danger" onClick={() => setSettings((current) => current && { ...current, models: current.models.filter((_, item) => item !== index) })}>删除</button>}</div>
        <div className="form-grid"><label>显示名称<input value={model.name || ""} onChange={(event) => updateModel(index, { name: event.target.value })} /></label><label>模型 ID<input value={model.id} onChange={(event) => updateModel(index, { id: event.target.value })} /></label><label>协议<select value={model.provider} onChange={(event) => selectProvider(index, event.target.value as ModelProfile["provider"])}><option value="openai-compatible">OpenAI 兼容</option><option value="anthropic">Anthropic</option><option value="google">Google Gemini</option></select></label><label>{model.provider === "google" ? "模型名称（可选，留空自动获取）" : "模型名称"}<input value={model.model} placeholder={model.provider === "google" ? "保存后自动使用可用 Gemini 文本模型" : ""} onChange={(event) => updateModel(index, { model: event.target.value })} /></label><label>{model.provider === "google" ? "Google AI Studio API Key" : "API Key"}<input type="password" placeholder={model.apiKeyConfigured ? "已配置（留空则保持不变）" : "粘贴你的 key"} value={model.apiKey || ""} onChange={(event) => updateModel(index, { apiKey: event.target.value })} /></label><label>API Key 环境变量<input value={model.apiKeyEnv} onChange={(event) => updateModel(index, { apiKeyEnv: event.target.value })} /></label><label>Base URL<input value={model.baseUrl} onChange={(event) => updateModel(index, { baseUrl: event.target.value })} /></label><label>Endpoint<input value={model.endpoint || ""} onChange={(event) => updateModel(index, { endpoint: event.target.value })} /></label><label>最大 Tokens<input type="number" min="1" value={model.maxTokens || 16384} onChange={(event) => updateModel(index, { maxTokens: Number(event.target.value) })} /></label></div>
      </article>)}</div>
    </section>
    <section className="settings-section"><div className="section-title"><div><h2>MCP 服务</h2><p>管理可被 SecAgent 发现和调用的 MCP 服务。</p></div><button className="secondary-button" onClick={() => setSettings((current) => current && { ...current, mcp: { servers: { ...current.mcp.servers, [`mcp-${Object.keys(current.mcp.servers).length + 1}`]: emptyMcp() } } })}>+ 添加服务</button></div>
      <div className="settings-cards">{Object.entries(settings.mcp.servers).map(([name, server]) => <article className="settings-card" key={name}><div className="card-heading"><input className="server-name" value={name} onChange={(event) => renameServer(name, event.target.value)} />{Object.keys(settings.mcp.servers).length > 1 && <button className="text-button danger" onClick={() => setSettings((current) => { if (!current) return current; const servers = { ...current.mcp.servers }; delete servers[name]; return { ...current, mcp: { servers } }; })}>删除</button>}</div><div className="form-grid"><label>传输方式<select value={server.transport} onChange={(event) => updateServer(name, { transport: event.target.value as McpServerConfig["transport"] })}><option value="http">HTTP</option><option value="stdio">stdio</option></select></label><label className="checkbox-label"><input type="checkbox" checked={server.enabled} onChange={(event) => updateServer(name, { enabled: event.target.checked })} /> 启用</label>{server.transport === "http" ? <label>服务 URL<input value={server.url || ""} onChange={(event) => updateServer(name, { url: event.target.value })} /></label> : <><label>启动命令<input value={server.command || ""} onChange={(event) => updateServer(name, { command: event.target.value })} /></label><label>参数（每行一个）<textarea value={(server.args || []).join("\n")} onChange={(event) => updateServer(name, { args: event.target.value.split(/\r?\n/).filter(Boolean) })} rows={3} /></label></>}</div></article>)}</div>
    </section>
  </main>;
}

function AnimatedDetails({ className, summary, children, autoOpen = false, summaryRef }: { className: string; summary: ReactNode; children: ReactNode; autoOpen?: boolean; summaryRef?: { current: HTMLButtonElement | null } }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (autoOpen) setOpen(true);
    else setOpen(false);
  }, [autoOpen]);

  const expanded = autoOpen || open;
  return <div className={`${className} animated-details ${expanded ? "is-open" : ""}`}>
    <button ref={summaryRef} type="button" className="details-summary" aria-expanded={expanded} onClick={() => { if (!autoOpen) setOpen((current) => !current); }}>
      {summary}
    </button>
    <div className="details-panel" aria-hidden={!expanded}><div className="details-panel-inner">{children}</div></div>
  </div>;
}

function MessageActivities({ activities, elapsedSeconds, isExecuting = false, summaryRef }: { activities: AssistantActivity[]; elapsedSeconds?: number; isExecuting?: boolean; summaryRef?: { current: HTMLButtonElement | null } }) {
  if (!activities.length && !isExecuting) return null;
  const toolCount = activities.filter((activity) => activity.kind === "tool").length;
  const pending = activities.some((activity) => activity.kind === "tool" && !("result" in activity));
  const toolCountLabel = toolCount === 1 ? "一个" : `${toolCount}`;
  return <AnimatedDetails className="execution-summary" autoOpen={isExecuting} summaryRef={summaryRef} summary={<><span>{isExecuting || pending ? "正在执行" : elapsedSeconds ? `用时${elapsedSeconds}秒` : "本轮完成"}，共调用了{toolCountLabel}个工具</span><img className="execution-chevron" src="/session-chevron.svg" alt="" /></>}>
    <div className="message-tool-calls">
      {activities.map((activity, index) => activity.kind === "text"
        ? <AnimatedDetails className="intermediate-output" key={`text-${index}`} autoOpen summary={<><span className="activity-dot">·</span><span>模型思考</span><img className="details-chevron" src="/session-chevron.svg" alt="" /></>}><div className="activity-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{activity.content}</ReactMarkdown></div></AnimatedDetails>
        : <AnimatedDetails className="message-tool" key={`${activity.name}-${index}`} summary={<><span className="activity-dot">·</span><span className="tool-name">{toolTitle(activity.name)}</span><span className="tool-state">{"result" in activity ? "已完成" : "调用中"}</span><img className="details-chevron" src="/session-chevron.svg" alt="" /></>}>
          <div className="tool-detail"><div><p>参数</p><pre>{JSON.stringify(activity.arguments, null, 2)}</pre></div><div><p>工具结果</p><pre>{"result" in activity ? JSON.stringify(activity.result, null, 2) : "正在等待返回…"}</pre></div></div>
        </AnimatedDetails>)}
    </div>
  </AnimatedDetails>;
}

export function App() {
  const bridge = window.secagent;
  if (new URLSearchParams(window.location.search).has("settings")) return <SettingsApp />;
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [sessionMenuDismissed, setSessionMenuDismissed] = useState(false);
  const [allSessionsOpen, setAllSessionsOpen] = useState(false);
  const [session, setSession] = useState<SessionData | null>(null);
  const [draft, setDraft] = useState("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [speechStatus, setSpeechStatus] = useState("");
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const messagesRef = useRef<HTMLDivElement>(null);
  const executionSummaryRef = useRef<HTMLButtonElement>(null);
  const answerScrollPhase = useRef<"follow-bottom" | "settling" | "locked">("follow-bottom");
  const answerScrollLockTimer = useRef<number | undefined>(undefined);
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
    return bridge.onSettingsChanged(() => {
      void bridge.listModels().then((models) => {
        setModels(models);
        setSelectedModelId((current) => models.some((model) => model.id === current) ? current : models[0]?.id || "");
      });
    });
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
  }, [activeTrace]);
  const latestAssistantId = useMemo(() => session?.messages.filter((message) => message.role === "assistant").at(-1)?.id, [session?.messages]);
  const changeSession = async (id: string) => { if (bridge) { setSession(await bridge.getSession(id)); setTrace([]); } };
  const createSession = async () => { if (bridge) { const next = await bridge.createSession(); setSessions(await bridge.listSessions()); setSession(next); setTrace([]); } };
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
  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !session || sending) return;
    const optimisticMessage: SessionMessage = { id: `pending-${Date.now()}`, role: "user", content: text, createdAt: new Date().toISOString() };
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
    setDraft(""); setTrace([]); setFinishing(false); setSending(true);
    let completed = false;
    try {
      if (bridge) {
        const response = await bridge.sendMessage(session.meta.id, text, selectedModelId);
        setSession(response);
        setSessions(await bridge.listSessions());
        completed = true;
        setFinishing(true);
      }
    } finally {
      if (completed) await new Promise((resolve) => setTimeout(resolve, 260));
      setFinishing(false);
      setSending(false);
    }
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
    <section className="workspace">
      <section className="conversation" aria-label="当前会话">
        <div className="messages" ref={messagesRef}>
          {session?.messages.length === 0 && <div className="empty-state"><h2>开始一个课堂操作</h2><p>例如：查询张三积分，或给张三加 2 分。</p></div>}
          {session?.messages.map((message) => {
            const activities = message.activities?.length ? message.activities : message.toolCalls?.length ? message.toolCalls.map((call) => ({ kind: "tool" as const, ...call })) : message.id === latestAssistantId ? traceActivities : [];
            return <article className={`message ${message.role}`} key={message.id}><div className="message-content"><div className="message-meta">{message.role === "user" ? "教师" : "SecAgent"} · {new Date(message.createdAt).toLocaleTimeString()}</div>{message.role === "assistant" && <MessageActivities activities={activities} elapsedSeconds={message.id === latestAssistantId ? executionSeconds : undefined} isExecuting={finishing && message.id === latestAssistantId} summaryRef={finishing && message.id === latestAssistantId ? executionSummaryRef : undefined} />}<div className="bubble-row"><div className="avatar">{message.role === "user" ? "你" : <img src="/icon.svg" alt="SecAgent" />}</div><div className="bubble">{message.role === "assistant" ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown> : message.content}</div></div></div></article>;
          })}
          {sending && !finishing && <article className="message assistant"><div className="message-content"><div className="message-meta">SecAgent · 正在生成</div><MessageActivities activities={traceActivities} elapsedSeconds={executionSeconds} isExecuting summaryRef={executionSummaryRef} /><div className="bubble-row"><div className="avatar"><img src="/icon.svg" alt="SecAgent" /></div><div className="bubble loading">{streamingOutput ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingOutput}</ReactMarkdown> : "正在调用模型与工具…"}</div></div></div></article>}
          <div />
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
