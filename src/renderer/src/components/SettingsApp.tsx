import { useEffect, useRef, useState } from "react";
import { PluginSettingsPanel } from "./PluginSettingsPanel.js";
import { SecScoreSettingsPage } from "./SecScoreSettingsPage.js";
import { PresetCombobox } from "./PresetCombobox.js";
import { OobeWizard } from "./OobeWizard.js";
import { reasoningEffortLabels, ttsRates, ttsVoices } from "../constants.js";
import { emptyMcp, emptyProvider, reasoningEffortsForModel } from "../utils.js";
import { formatOfficialBalanceExpiry, formatOfficialPoints } from "../official-balance.js";
import { DEFAULT_WAKE_HOTKEY, displayWakeHotkey, wakeHotkeyFromKeyboardEvent } from "../../../wake-hotkey.js";

function WakeHotkeyField({ value, platform, onChange }: { value: string; platform: NodeJS.Platform; onChange: (value: string) => void }) {
  const [capturing, setCapturing] = useState(false);
  return <div className="wake-hotkey-field">
    <label>全局快捷键<input readOnly value={capturing ? "请按下快捷键..." : displayWakeHotkey(value, platform)} onFocus={() => setCapturing(true)} onBlur={() => setCapturing(false)} onKeyDown={(event) => { event.preventDefault(); const hotkey = wakeHotkeyFromKeyboardEvent(event.nativeEvent); if (hotkey) { onChange(hotkey); setCapturing(false); } }} /></label>
    <button type="button" className="secondary-button" onClick={() => onChange(DEFAULT_WAKE_HOTKEY)}>恢复默认</button>
  </div>;
}

function updateReleaseLabel(release: UpdateRelease | undefined, channel: UpdateChannel): string {
  if (release?.releaseType === "alpha") return "内测版";
  if (release?.releaseType === "beta") return "测试版";
  return channel === "preview" ? "预览版" : "稳定版";
}

function formatUpdateBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function SettingsApp() {
  const bridge = window.secagent;
  const isOobe = new URLSearchParams(window.location.search).get("oobe") === "1";
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [providerPresets, setProviderPresets] = useState<ProviderPreset[]>([]);
  const [editingProvider, setEditingProvider] = useState<ProviderConfig | null>(null);
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [plugins, setPlugins] = useState<PluginStatus[]>([]);
  const [marketPlugins, setMarketPlugins] = useState<MarketplacePlugin[]>([]);
  const [marketError, setMarketError] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [officialEmail, setOfficialEmail] = useState("");
  const [officialPoints, setOfficialPoints] = useState<number | null>(null);
  const [officialPointBalances, setOfficialPointBalances] = useState<Array<{ points: number; expiresAt: string | null }>>([]);
  const [officialPointsBusy, setOfficialPointsBusy] = useState(false);
  const [officialLoggedIn, setOfficialLoggedIn] = useState(false);
  const [officialExpired, setOfficialExpired] = useState(false);
  const [officialBusy, setOfficialBusy] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [diagnosticSessions, setDiagnosticSessions] = useState<SessionMeta[]>([]);
  const [diagnosticSessionId, setDiagnosticSessionId] = useState("");
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const settingsLoaded = useRef(false);
  const skipAutosave = useRef(true);
  const [activePage, setActivePage] = useState(() => {
    const hash = window.location.hash.replace(/^#/, "");
    const builtInPage = ["settings-wake", "settings-tts", "settings-speech", "settings-models", "settings-mcp", "settings-plugins", "settings-system", "settings-updates", "settings-telemetry"].includes(hash);
    return isOobe ? "settings-models" : ((builtInPage || hash.startsWith("plugin-")) ? hash : "settings-tts");
  });

  useEffect(() => {
    let disposed = false;
    void bridge.getSettings().then((value) => {
      if (disposed) return;
      settingsLoaded.current = true;
      setSettings(value);
    }).catch((reason) => { if (!disposed) setError(String(reason)); });
    void bridge.listModels().then(setAvailableModels).catch(() => undefined);
    void bridge.listProviders().then(setProviderPresets).catch(() => undefined);
    return () => { disposed = true; };
  }, [bridge]);
  useEffect(() => {
    void bridge.listPlugins().then(setPlugins).catch((reason) => setError(String(reason)));
    return bridge.onPluginsChanged(setPlugins);
  }, [bridge]);
  useEffect(() => {
    void bridge.getUpdateState().then(setUpdateState).catch(() => undefined);
    return bridge.onUpdateState((next) => {
      setUpdateState(next);
      if (next.status === "error") setError(next.error || "更新失败，请查看诊断日志。");
    });
  }, [bridge]);
  useEffect(() => {
    if (isOobe) return;
    void bridge.listSessions().then((sessions) => {
      setDiagnosticSessions(sessions.slice(0, 20));
      setDiagnosticSessionId((current) => current || sessions[0]?.id || "");
    }).catch(() => undefined);
  }, [bridge, isOobe]);
  const refreshOfficialPoints = async () => {
    setOfficialPointsBusy(true);
    try {
      const result = await bridge.officialBalance();
      setOfficialPoints(result.points);
      setOfficialPointBalances(result.balances);
      setOfficialExpired(result.expired);
      if (result.expired) {
        setOfficialLoggedIn(false);
        setError("登录已过期，请重新登录。");
      }
    } catch { setOfficialPoints(null); setOfficialPointBalances([]); setOfficialExpired(false); } finally { setOfficialPointsBusy(false); }
  };
  useEffect(() => { void bridge.officialStatus().then((status) => { setOfficialLoggedIn(status.loggedIn); setOfficialEmail(status.email); if (status.loggedIn) void refreshOfficialPoints(); }).catch(() => undefined); }, [bridge]);
  useEffect(() => {
    if (isOobe || !settings || !settingsLoaded.current) return;
    if (skipAutosave.current) {
      skipAutosave.current = false;
      return;
    }
    // A newly added model is intentionally an incomplete draft. Do not send it
    // through the strict config validator until the required fields are filled.
    const hasIncompleteModel = settings.providers.some((provider) => (
      !provider.id.trim() || !provider.name.trim() || !provider.apiKeyEnv.trim() || !provider.baseUrl.trim() || !provider.models.length
    ));
    if (hasIncompleteModel) {
      setError("");
      return;
    }
    const timer = window.setTimeout(() => {
      setError("");
      void bridge.saveSettings(settings).catch(async (reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        // A conflicting wake shortcut is deliberately not persisted by the
        // main process. Reflect that authoritative value in the editor while
        // preserving unrelated draft changes.
        try {
          const persisted = await bridge.getSettings();
          if (persisted.wake.hotkey !== settings.wake.hotkey) {
            setSettings((current) => current && current.wake.hotkey === settings.wake.hotkey ? { ...current, wake: persisted.wake } : current);
          }
        } catch { /* Keep the original save error visible. */ }
      });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [bridge, isOobe, settings]);
  useEffect(() => {
    const draft = settings?.models.find((model) => model.id.startsWith("model-"));
    if (!draft || providerModalOpen) return;
    setEditingProvider({ id: draft.id, name: draft.name || "新提供商", preset: "custom", provider: draft.provider, apiKeyEnv: draft.apiKeyEnv, apiKey: draft.apiKey, baseUrl: draft.baseUrl, endpoint: draft.endpoint, maxTokens: draft.maxTokens, models: draft.model ? [{ id: draft.model, name: draft.name || draft.model }] : [] });
    setProviderModalOpen(true);
    setSettings((current) => current && { ...current, models: current.models.filter((model) => model.id !== draft.id) });
  }, [settings, providerModalOpen]);
  useEffect(() => {
    const row = document.querySelector<HTMLElement>(".official-balance-row");
    if (!row) {
      document.querySelectorAll(".official-balance-groups").forEach((element) => element.remove());
      return;
    }
    const value = row.querySelector<HTMLElement>(".points-value");
    if (value) value.textContent = officialPointsBusy ? "读取中…" : officialPoints === null ? "暂不可用" : `${formatOfficialPoints(officialPoints)} Points`;
    const host = row.parentElement;
    if (!host) return;
    let groups = host.querySelector<HTMLElement>(".official-balance-groups");
    if (!groups) {
      groups = document.createElement("div");
      groups.className = "official-balance-groups";
      host.insertBefore(groups, row.nextSibling);
    }
    groups.replaceChildren(...(officialPointBalances.length ? officialPointBalances.map((balance) => {
      const item = document.createElement("div");
      item.className = "official-balance-group";
      const points = document.createElement("strong");
      points.textContent = `${formatOfficialPoints(balance.points)} Points`;
      const expiry = document.createElement("span");
      expiry.textContent = formatOfficialBalanceExpiry(balance.expiresAt);
      item.append(points, expiry);
      return item;
    }) : [Object.assign(document.createElement("span"), { textContent: "暂无有效额度" })]));
  });
  if (isOobe) return <OobeWizard />;
  if (!settings) return <main className="settings-shell"><p>正在读取配置…</p></main>;
  const updateProvider = (patch: Partial<ProviderConfig>) => setEditingProvider((current) => current && { ...current, ...patch });
  const presetLocked = !!editingProvider?.preset && editingProvider.preset !== "custom";
  const updateModel = (_index: number, _patch: Partial<ModelProfile>) => undefined;
  const selectProvider = (_index: number, _provider: ModelProfile["provider"]) => undefined;
  const applyProviderPreset = (presetId: string) => {
    if (!editingProvider) return;
    if (presetId === "custom") { updateProvider({ preset: "custom" }); return; }
    const preset = providerPresets.find((item) => item.id === presetId);
    if (!preset) return;
    const env = `${preset.name.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}_API_KEY`;
    const isAnthropic = /anthropic/i.test(preset.id);
    const isGoogle = /google|gemini/i.test(preset.id);
    const baseUrl = isAnthropic || isGoogle || !preset.api || /\/v1(?:beta)?\/?$/i.test(preset.api) ? preset.api : `${preset.api.replace(/\/$/, "")}/v1`;
    updateProvider({ preset: preset.id, name: preset.name, apiKeyEnv: env, baseUrl: baseUrl || editingProvider.baseUrl, provider: isGoogle ? "google" : isAnthropic ? "anthropic" : "openai-compatible", endpoint: isGoogle ? "" : isAnthropic ? "/v1/messages" : "/chat/completions", models: preset.models.map((model) => ({ id: model.id, name: model.name || model.id, enabled: true })) });
  };
  const saveProvider = () => {
    if (!editingProvider || !editingProvider.name.trim() || !editingProvider.apiKeyEnv.trim() || !editingProvider.baseUrl.trim() || !editingProvider.models.length) { setError("请填写提供商信息并至少添加一个模型"); return; }
    setSettings((current) => current && { ...current, providers: current.providers.some((provider) => provider.id === editingProvider.id) ? current.providers.map((provider) => provider.id === editingProvider.id ? editingProvider : provider) : [...current.providers, editingProvider] });
    setProviderModalOpen(false); setEditingProvider(null);
  };
  const removeProvider = (id: string) => setSettings((current) => current && { ...current, providers: current.providers.filter((provider) => provider.id !== id) });
  const updateServer = (name: string, patch: Partial<McpServerConfig>) => setSettings((current) => current && { ...current, mcp: { servers: Object.fromEntries(Object.entries(current.mcp.servers).map(([key, server]) => [key, key === name ? { ...server, ...patch } : server])) } });
  const renameServer = (oldName: string, newName: string) => {
    const name = newName.trim();
    if (!name || (name !== oldName && settings.mcp.servers[name])) return;
    setSettings((current) => current && { ...current, mcp: { servers: Object.fromEntries(Object.entries(current.mcp.servers).map(([key, server]) => [key === oldName ? name : key, server])) } });
  };
  const officialLogin = async () => {
    setError(""); setOfficialBusy(true);
    try { const next = await bridge.officialOAuthLogin(); setSettings(next); setAvailableModels(await bridge.listModels()); setOfficialLoggedIn(true); setOfficialExpired(false); await refreshOfficialPoints(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setOfficialBusy(false); }
  };
  const officialLogout = async () => { await bridge.officialLogout(); setOfficialLoggedIn(false); setOfficialExpired(false); setOfficialPoints(null); setOfficialPointBalances([]); setSettings((current) => current && { ...current, providers: current.providers.filter((provider) => provider.id !== "sectl-official") }); };
  const checkForUpdate = async () => {
    setError("");
    try {
      const next = await bridge.checkForUpdate();
      setUpdateState(next);
      if (next.status === "error") setError(next.error || "更新检查失败，请查看诊断日志。");
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const downloadUpdate = async () => {
    setError("");
    try {
      const next = await bridge.downloadUpdate();
      setUpdateState(next);
      if (next.status === "error") setError(next.error || "更新下载失败，请查看诊断日志。");
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const installUpdate = async () => {
    setError("");
    try {
      const next = await bridge.installUpdate();
      setUpdateState(next);
      if (next.status === "error") setError(next.error || "更新安装失败，请查看诊断日志。");
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const openUpdateLogs = async () => {
    setError("");
    try {
      const directory = await bridge.openDiagnosticLogs();
      setSuccess(`日志目录已打开：${directory}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const exportUpdateLogs = async () => {
    setError("");
    try {
      const result = await bridge.exportDiagnosticLogs();
      if (!result.canceled && result.path) setSuccess(`诊断日志已导出：${result.path}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const uploadDiagnostic = async () => {
    if (!diagnosticSessionId || !settings.telemetry.enabled) return;
    if (!window.confirm("将上传所选会话的消息内容和脱敏运行 trace，仅用于故障诊断。是否继续？")) return;
    setDiagnosticBusy(true);
    setError(""); setSuccess("");
    try {
      const result = await bridge.uploadDiagnostic(diagnosticSessionId);
      setSuccess(`诊断包已上传（${Math.round(result.bytes / 1024)} KB）`);
    } catch (reason) {
      setSuccess("");
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setDiagnosticBusy(false); }
  };
  const defaultModel = availableModels.find((model) => model.id === settings.defaultModelId) || availableModels.find((model) => model.id === "sectl-official") || availableModels[0];
  const defaultReasoningEfforts = reasoningEffortsForModel(defaultModel);
  const defaultReasoningEffort = defaultReasoningEfforts.includes(settings.defaultReasoningEffort || "high") ? (settings.defaultReasoningEffort || "high") : defaultReasoningEfforts.includes("high") ? "high" : defaultReasoningEfforts[0];
  const updateSupported = bridge.platform === "win32";
  const updateProgress = updateState?.totalBytes ? Math.min(100, Math.round(updateState.downloadedBytes / updateState.totalBytes * 100)) : undefined;
  const updateReleaseType = updateReleaseLabel(updateState?.release, settings.updates.channel);
  return <main className={`settings-shell has-window-title ${isOobe ? "oobe-shell" : ""} ${activePage === "settings-plugins" ? "plugin-settings-shell" : ""} ${bridge.platform === "darwin" ? "macos-settings" : ""} ${bridge.platform !== "darwin" ? "windows-settings" : ""}`}>
    <div className="settings-window-title">SecAgent设置</div>
    {!isOobe && <nav className="settings-nav" aria-label="Settings navigation"><button type="button" className={activePage === "settings-wake" ? "active" : ""} aria-current={activePage === "settings-wake" ? "page" : undefined} onClick={() => { setActivePage("settings-wake"); window.history.replaceState(null, "", "#settings-wake"); }}>随时唤醒</button><button type="button" className={activePage === "settings-system" ? "active" : ""} aria-current={activePage === "settings-system" ? "page" : undefined} onClick={() => { setActivePage("settings-system"); window.history.replaceState(null, "", "#settings-system"); }}>系统</button><button type="button" className={activePage === "settings-updates" ? "active" : ""} aria-current={activePage === "settings-updates" ? "page" : undefined} onClick={() => { setActivePage("settings-updates"); window.history.replaceState(null, "", "#settings-updates"); }}>更新</button><button type="button" className={activePage === "settings-telemetry" ? "active" : ""} aria-current={activePage === "settings-telemetry" ? "page" : undefined} onClick={() => { setActivePage("settings-telemetry"); window.history.replaceState(null, "", "#settings-telemetry"); }}>诊断与隐私</button><button type="button" className={activePage === "settings-tts" ? "active" : ""} aria-current={activePage === "settings-tts" ? "page" : undefined} onClick={() => { setActivePage("settings-tts"); window.history.replaceState(null, "", "#settings-tts"); }}>朗读</button><button type="button" className={activePage === "settings-speech" ? "active" : ""} aria-current={activePage === "settings-speech" ? "page" : undefined} onClick={() => { setActivePage("settings-speech"); window.history.replaceState(null, "", "#settings-speech"); }}>语音识别</button><button type="button" className={activePage === "settings-models" ? "active" : ""} aria-current={activePage === "settings-models" ? "page" : undefined} onClick={() => { setActivePage("settings-models"); window.history.replaceState(null, "", "#settings-models"); }}>模型</button><button type="button" className={activePage === "settings-mcp" ? "active" : ""} aria-current={activePage === "settings-mcp" ? "page" : undefined} onClick={() => { setActivePage("settings-mcp"); window.history.replaceState(null, "", "#settings-mcp"); }}>MCP 服务</button><button type="button" className={activePage === "settings-plugins" ? "active" : ""} aria-current={activePage === "settings-plugins" ? "page" : undefined} onClick={() => { setActivePage("settings-plugins"); window.history.replaceState(null, "", "#settings-plugins"); }}>插件</button>{plugins.flatMap((plugin) => plugin.settingsPages.map((page) => { const pageId = `plugin-${plugin.id}-${page.id}`; return <button type="button" className={activePage === pageId ? "active" : ""} aria-current={activePage === pageId ? "page" : undefined} key={pageId} onClick={() => { setActivePage(pageId); window.history.replaceState(null, "", `#${pageId}`); }}>{page.title}</button>; }))}</nav>}
    {error && <div className="settings-error">{error}</div>}
    {success && <div className="settings-success">{success}</div>}
    <section id="settings-wake" className={`settings-section ${isOobe || activePage === "settings-wake" ? "settings-section-active" : ""}`}><div className="section-title"><div><h2>随时唤醒</h2><p>按下全局快捷键后，在当前显示器工作区唤起语音 Agent。窗口不会覆盖任务栏。</p></div></div>
      <article className="settings-card"><WakeHotkeyField value={settings.wake.hotkey} platform={bridge.platform} onChange={(hotkey) => setSettings((current) => current && { ...current, wake: { ...current.wake, hotkey } })} /><div className="form-grid wake-model-setting"><label>随时唤起使用的模型<select value={settings.wake.modelId || settings.defaultModelId || availableModels[0]?.id || ""} onChange={(event) => setSettings((current) => current && { ...current, wake: { ...current.wake, modelId: event.target.value } })}>{availableModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label></div><label className="toggle-row"><span className="toggle-copy"><strong>语音唤醒</strong><small>开启后持续使用麦克风，识别到唤醒词后等同于按下上面的快捷键。</small></span><input type="checkbox" checked={settings.wake.voiceEnabled === true} onChange={(event) => setSettings((current) => current && { ...current, wake: { ...current.wake, voiceEnabled: event.target.checked } })} /></label><label className="wake-phrase-field">唤醒词<input value={settings.wake.voicePhrase || "小泽同学"} onChange={(event) => setSettings((current) => current && { ...current, wake: { ...current.wake, voicePhrase: event.target.value } })} placeholder="小泽同学" /></label><p className="settings-help">Windows/Linux 默认 Ctrl Alt A；macOS 默认 Ctrl Option A。语音唤醒始终使用随安装包提供的本地模型，无需网络。</p></article>
    </section>
    <section id="settings-updates" className={`settings-section ${activePage === "settings-updates" ? "settings-section-active" : ""}`}><div className="section-title"><div><h2>更新</h2><p>从 GitHub Release 获取 SecAgent 更新。当前仅支持 Windows 安装包更新。</p></div></div>
      <article className="settings-card update-settings-card">
        {!updateSupported ? <p className="settings-help">当前平台暂不支持应用内更新。</p> : <>
          {updateState?.status === "unsupported" && <div className="settings-help update-warning"><strong>暂不支持应用内更新</strong><span>{updateState.supportReason || updateState.error || "当前环境不支持应用内更新。"}</span></div>}
          {updateState?.status === "error" && <div className="settings-error update-error"><strong>更新检查失败</strong><span>{updateState.error || "请查看诊断日志。"}</span><button type="button" className="text-button" onClick={() => void checkForUpdate()}>重试</button></div>}
          <div className="update-version-row"><div><span className="settings-help">当前版本</span><strong>{updateState?.currentVersion || "读取中…"}</strong></div><button type="button" className="secondary-button" disabled={updateState?.status === "checking"} onClick={() => void checkForUpdate()}>{updateState?.status === "checking" ? "检查中…" : "检查更新"}</button></div>
          <div className="form-grid update-channel-grid"><label>更新通道<select value={settings.updates.channel} onChange={(event) => setSettings((current) => current && { ...current, updates: { ...current.updates, channel: event.target.value as UpdateChannel } })}><option value="stable">普通版</option><option value="preview">预览版</option></select></label></div>
          <div className="update-diagnostic-actions"><button type="button" className="secondary-button" onClick={() => void openUpdateLogs()}>打开日志目录</button><button type="button" className="secondary-button" onClick={() => void exportUpdateLogs()}>导出诊断日志</button></div>
          <label className="toggle-row"><span className="toggle-copy"><strong>自动检查更新</strong><small>启动后及每 6 小时检查一次 GitHub Release。</small></span><input type="checkbox" checked={settings.updates.autoCheck} onChange={(event) => setSettings((current) => current && { ...current, updates: { ...current.updates, autoCheck: event.target.checked } })} /></label>
          <label className="toggle-row"><span className="toggle-copy"><strong>自动下载更新</strong><small>自动检查发现新版本后，后台下载完整 Windows 安装包。</small></span><input type="checkbox" checked={settings.updates.autoDownload} onChange={(event) => setSettings((current) => current && { ...current, updates: { ...current.updates, autoDownload: event.target.checked } })} /></label>
          <label className="toggle-row"><span className="toggle-copy"><strong>退出应用后自动安装</strong><small>已有下载完成的更新时，在应用退出过程中静默运行安装程序。</small></span><input type="checkbox" checked={settings.updates.autoInstallOnQuit} onChange={(event) => setSettings((current) => current && { ...current, updates: { ...current.updates, autoInstallOnQuit: event.target.checked } })} /></label>
          {updateState?.status === "downloading" && <div className="update-progress"><div className="update-progress-label"><span>正在下载 {updateState.release?.version || "更新"}</span><span>{updateProgress === undefined ? formatUpdateBytes(updateState.downloadedBytes) : `${updateProgress}%`}</span></div><progress max="100" value={updateProgress ?? 0} /></div>}
          {updateState?.status === "up-to-date" && <p className="settings-help update-success">当前已是最新的{settings.updates.channel === "preview" ? "预览" : "稳定"}版本。</p>}
          {updateState?.release && <div className="update-release-card"><div className="card-heading"><div><strong>{updateState.release.version}</strong><span>{updateReleaseType}{updateState.release.publishedAt ? ` · ${new Date(updateState.release.publishedAt).toLocaleDateString()}` : ""}</span></div><button type="button" className="text-button" onClick={() => void bridge.openExternal(updateState.release!.htmlUrl)}>查看 Release</button></div>{updateState.release.body && <pre className="update-release-notes">{updateState.release.body}</pre>}<div className="update-actions">{updateState.status === "available" && <button type="button" className="primary-button" onClick={() => void downloadUpdate()}>下载更新</button>}{updateState.status === "downloaded" && <><span className="update-downloaded">已下载 {updateState.downloadedVersion}</span><button type="button" className="primary-button" onClick={() => void installUpdate()}>立即安装</button></>}{updateState.status === "installing" && <span className="update-downloaded">正在准备安装，应用即将退出…</span>}</div></div>}
          {updateState?.status === "downloaded" && !updateState.release && <div className="update-release-card"><div className="card-heading"><div><strong>{updateState.downloadedVersion}</strong><span>已下载，等待安装</span></div><button type="button" className="primary-button" onClick={() => void installUpdate()}>立即安装</button></div></div>}
        </>}
      </article>
    </section>
    <section id="settings-tts" className={`settings-section ${isOobe || activePage === "settings-tts" ? "settings-section-active" : ""}`}><div className="section-title"><div><h2>朗读</h2><p>右键助手消息气泡选择“朗读”。语音由 Microsoft Edge 在线生成，不需要 API Key。</p></div></div>
      <article className="settings-card"><div className="form-grid"><label>语音音色<select value={settings.tts.voice} onChange={(event) => setSettings((current) => current && { ...current, tts: { ...current.tts, voice: event.target.value } })}>{ttsVoices.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>语速<select value={settings.tts.rate} onChange={(event) => setSettings((current) => current && { ...current, tts: { ...current.tts, rate: event.target.value } })}>{ttsRates.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div></article>
    </section>
    <section id="settings-models" className={`settings-section ${isOobe || activePage === "settings-models" ? "settings-section-active" : ""}`}><div className="section-title"><div><h2>模型提供商</h2><p>每个提供商可以包含多个模型；预设信息在启动时从 models.dev 更新。</p></div></div>
      <article className="settings-card official-service-card"><div className="card-heading"><strong>SecAgent 官方服务</strong>{officialLoggedIn && <button className="text-button danger" onClick={() => void officialLogout()}>退出登录</button>}</div><p>{officialLoggedIn ? `已登录 ${officialEmail} · 模型列表由后端动态获取` : "使用浏览器打开 SECTL 授权页登录，登录完成后自动返回 SecAgent。"}</p>{!officialLoggedIn && <button className="primary-button" type="button" disabled={officialBusy} onClick={() => void officialLogin()}>{officialBusy ? "等待浏览器授权…" : "打开浏览器登录 SECTL"}</button>}{officialLoggedIn && <div className="official-balance-row"><span>账户余额</span><strong className="points-value">{officialPointsBusy ? "读取中…" : officialPoints === null ? "暂不可用" : `${officialPoints.toFixed(6)} Points`}</strong><button className="secondary-button" type="button" onClick={() => void refreshOfficialPoints()}>刷新余额</button></div>}<label className="toggle-row"><span className="toggle-copy"><strong>自定义模型模式</strong><small>关闭时自定义供应商不生效，必须登录 SecAgent 官方服务后才能使用模型；开启后主界面模型与推理强度合并为「快速 / 标准 / 深度」档位（默认标准）。</small></span><input type="checkbox" checked={Boolean(settings.customModelMode)} onChange={(event) => setSettings((current) => current && { ...current, customModelMode: event.target.checked })} /></label><div className="default-model-settings"><label>默认模型<select value={settings.defaultModelId || defaultModel?.id || ""} onChange={(event) => setSettings((current) => current && { ...current, defaultModelId: event.target.value })}>{availableModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label><label>默认思考强度<select value={defaultReasoningEffort} onChange={(event) => setSettings((current) => current && { ...current, defaultReasoningEffort: event.target.value as ReasoningEffort })}>{defaultReasoningEfforts.map((effort) => <option key={effort} value={effort}>{reasoningEffortLabels[effort]}</option>)}</select></label></div></article>
      {providerModalOpen && editingProvider && <div className="settings-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setProviderModalOpen(false); setEditingProvider(null); } }}><div className="settings-modal"><div className="session-modal-header"><strong>{settings.providers.some((provider) => provider.id === editingProvider.id) ? "编辑提供商" : "添加提供商"}</strong><button type="button" className="text-button" onClick={() => { setProviderModalOpen(false); setEditingProvider(null); }}>关闭</button></div><div className="form-grid"><label>提供商名称<input value={editingProvider.name} disabled={presetLocked} onChange={(event) => updateProvider({ name: event.target.value })} /></label><label>预设<PresetCombobox value={editingProvider.preset || "custom"} presets={providerPresets} onSelect={applyProviderPreset} /></label><label>协议<select value={editingProvider.provider} disabled={presetLocked} onChange={(event) => updateProvider({ provider: event.target.value as ProviderConfig["provider"] })}><option value="openai-compatible">OpenAI Chat 兼容</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic">Anthropic</option><option value="google">Google Gemini</option></select></label><label>API Key 环境变量<input value={editingProvider.apiKeyEnv} disabled={presetLocked} onChange={(event) => updateProvider({ apiKeyEnv: event.target.value })} /></label><label className="wide-field">Base URL<input value={editingProvider.baseUrl} disabled={presetLocked} onChange={(event) => updateProvider({ baseUrl: event.target.value })} /></label><label>Endpoint<input value={editingProvider.endpoint || ""} disabled={presetLocked} onChange={(event) => updateProvider({ endpoint: event.target.value })} /></label><label>API Key<input type="password" placeholder={editingProvider.apiKeyConfigured ? "已配置（留空保持不变）" : "粘贴 API Key"} value={editingProvider.apiKey || ""} onChange={(event) => updateProvider({ apiKey: event.target.value })} /></label></div><div className="provider-model-editor"><div className="card-heading"><strong>模型列表</strong><button type="button" className="secondary-button" disabled={presetLocked} onClick={() => { const id = window.prompt("模型 ID"); if (id?.trim()) updateProvider({ models: [...editingProvider.models, { id: id.trim(), name: id.trim(), enabled: true }] }); }}>+ 添加模型</button></div>{editingProvider.models.map((model, index) => <div className="provider-model-row" key={`${model.id}-${index}`}><input type="checkbox" title="启用后显示在模型列表" disabled={presetLocked} checked={model.enabled !== false} onChange={() => updateProvider({ models: editingProvider.models.map((item, itemIndex) => itemIndex === index ? { ...item, enabled: item.enabled === false } : item) })} /><input value={model.name || ""} disabled={presetLocked} onChange={(event) => updateProvider({ models: editingProvider.models.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) })} /><code>{model.id}</code><button type="button" className="text-button danger" disabled={presetLocked} onClick={() => updateProvider({ models: editingProvider.models.filter((_, itemIndex) => itemIndex !== index) })}>删除</button></div>)}</div><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => { setProviderModalOpen(false); setEditingProvider(null); }}>取消</button><button type="button" className="primary-button" onClick={saveProvider}>保存</button></div></div></div>}
      {settings.customModelMode ? <><div className="section-title provider-add-row"><div><h3>自定义提供商</h3></div><button className="secondary-button" type="button" onClick={() => { setEditingProvider(emptyProvider()); setProviderModalOpen(true); }}>+ 添加提供商</button></div>
      <div className="provider-list settings-cards">{settings.providers.filter((provider) => provider.id !== "sectl-official" && provider.name !== "SecAgent 官方服务").map((provider) => <article className={`settings-card provider-list-item${provider.models.length === 1 ? " single-model" : ""}`} key={provider.id}><div className="card-heading"><div><strong>{provider.name}</strong><span>{provider.models.length} 个模型 · {provider.preset && provider.preset !== "custom" ? `预设：${provider.preset}` : "自定义"}</span></div><div className="item-actions"><button className="secondary-button" type="button" onClick={() => { setEditingProvider({ ...provider, models: provider.models.map((model) => ({ ...model })) }); setProviderModalOpen(true); }}>编辑</button><button className="text-button danger" type="button" onClick={() => removeProvider(provider.id)}>删除</button></div></div></article>)}</div></> : null}
    </section>
    <section id="settings-mcp" className={`settings-section ${isOobe || activePage === "settings-mcp" ? "settings-section-active" : ""}`}><div className="section-title"><div><h2>MCP 服务</h2><p>管理可被 SecAgent 发现和调用的 MCP 服务。</p></div><button className="secondary-button" onClick={() => setSettings((current) => current && { ...current, mcp: { servers: { ...current.mcp.servers, [`mcp-${Object.keys(current.mcp.servers).length + 1}`]: emptyMcp() } } })}>+ 添加服务</button></div>
      <div className="settings-cards">{Object.entries(settings.mcp.servers).map(([name, server]) => <article className="settings-card" key={name}><div className="card-heading"><input className="server-name" value={name} onChange={(event) => renameServer(name, event.target.value)} /><button type="button" className="text-button danger" onClick={() => setSettings((current) => { if (!current) return current; const servers = { ...current.mcp.servers }; delete servers[name]; return { ...current, mcp: { servers } }; })}>删除</button></div><div className="form-grid"><label>传输方式<select value={server.transport} onChange={(event) => updateServer(name, { transport: event.target.value as McpServerConfig["transport"] })}><option value="http">HTTP</option><option value="stdio">stdio</option></select></label><label className="checkbox-label"><input type="checkbox" checked={server.enabled} onChange={(event) => updateServer(name, { enabled: event.target.checked })} /> 启用</label>{server.transport === "http" ? <label>服务 URL<input value={server.url || ""} onChange={(event) => updateServer(name, { url: event.target.value })} /></label> : <><label>启动命令<input value={server.command || ""} onChange={(event) => updateServer(name, { command: event.target.value })} /></label><label>参数（每行一个）<textarea value={(server.args || []).join("\n")} onChange={(event) => updateServer(name, { args: event.target.value.split(/\r?\n/).filter(Boolean) })} rows={3} /></label></>}</div></article>)}</div>
    </section>
    <section id="settings-plugins" className={`settings-section ${isOobe || activePage === "settings-plugins" ? "settings-section-active" : ""}`}>
      <PluginSettingsPanel plugins={plugins} setPlugins={setPlugins} marketPlugins={marketPlugins} setMarketPlugins={setMarketPlugins} marketError={marketError} setMarketError={setMarketError} />
    </section>
    <section id="settings-speech" className={`settings-section ${activePage === "settings-speech" ? "settings-section-active" : ""}`}><div className="section-title"><div><h2>语音识别</h2><p>按住输入区说话，松开后一次性识别并写入输入框；可选用更好的云端识别。</p></div></div>
      <article className="settings-card"><label className="toggle-row"><span className="toggle-copy"><strong>使用更好的语音识别</strong><small>每日前 20 分钟免费；超出部分按 10 Points / 60 分钟计费。优化期间输入框会显示“识别优化中”。</small></span><input type="checkbox" checked={settings.speech.betterRecognition === true} onChange={(event) => setSettings((current) => current && { ...current, speech: { ...current.speech, betterRecognition: event.target.checked } })} /></label></article>
    </section>
    {!isOobe && plugins.flatMap((plugin) => plugin.settingsPages.map((page) => activePage === `plugin-${plugin.id}-${page.id}` && <section className="settings-section settings-section-active plugin-settings-section" key={`${plugin.id}-${page.id}`}>
      <div className="section-title"><h2>{page.title}</h2></div>
      {plugin.id === "secscore-connector" && page.id === "secscore" ? <SecScoreSettingsPage pluginId={plugin.id} pageId={page.id} /> : <article className={`settings-card plugin-service-status ${plugin.state}`}>
        <span>服务状态</span>
        <strong>{plugin.message || (plugin.state === "ready" ? "已就绪" : "未连接")}</strong>
      </article>}
    </section>))}

    <section id="settings-system" className={"settings-section " + (activePage === "settings-system" ? "settings-section-active" : "")}><div className="section-title"><div><h2>系统</h2><p>管理 SecAgent 是否随系统登录自动启动。</p></div></div>
      <article className="settings-card"><label className="toggle-row"><span className="toggle-copy"><strong>开机自启</strong><small>开启后，系统登录时会在后台启动 SecAgent；需要使用时可从托盘打开主窗口。</small></span><input type="checkbox" checked={settings.autostart === true} onChange={(event) => setSettings((current) => current && { ...current, autostart: event.target.checked })} /></label><label className="toggle-row nested-toggle-row"><span className="toggle-copy"><strong>开机自启后隐藏主窗口</strong><small>开机自启动时只在托盘后台运行，语音唤醒和全局快捷键照常可用；关闭后开机自启会直接打开主窗口。</small></span><input type="checkbox" checked={settings.autostartHidden !== false} onChange={(event) => setSettings((current) => current && { ...current, autostartHidden: event.target.checked })} /></label></article>
    </section>
    {!isOobe && <section id="settings-telemetry" className={`settings-section ${activePage === "settings-telemetry" ? "settings-section-active" : ""}`}><div className="section-title"><div><h2>诊断与隐私</h2><p>上传脱敏的错误、崩溃和 Agent 执行失败信息，帮助改进 SecAgent。关闭后不会发送任何遥测。</p></div></div>
      <article className="settings-card"><label className="toggle-row"><span className="toggle-copy"><strong>上传匿名诊断数据</strong><small>包含应用版本、系统、错误类型、网络状态、工具名和脱敏运行阶段；不会上传普通对话内容、API Key 或附件。</small></span><input type="checkbox" checked={settings.telemetry.enabled} onChange={(event) => setSettings((current) => current && { ...current, telemetry: { enabled: event.target.checked } })} /></label><div className="diagnostic-upload-row"><div><strong>上传一次完整诊断包</strong><p className="settings-help">仅在你主动选择会话并确认后上传该会话内容和脱敏 trace，不会自动持续开启。</p></div><div className="diagnostic-upload-controls"><select disabled={!settings.telemetry.enabled || diagnosticBusy || !diagnosticSessions.length} value={diagnosticSessionId} onChange={(event) => setDiagnosticSessionId(event.target.value)}><option value="">选择会话</option>{diagnosticSessions.map((session) => <option key={session.id} value={session.id}>{session.title} · {new Date(session.updatedAt).toLocaleString()}</option>)}</select><button type="button" className="secondary-button" disabled={!settings.telemetry.enabled || diagnosticBusy || !diagnosticSessionId} onClick={() => void uploadDiagnostic()}>{diagnosticBusy ? "上传中…" : "上传诊断包"}</button></div></div></article>
    </section>}
  </main>;
}
