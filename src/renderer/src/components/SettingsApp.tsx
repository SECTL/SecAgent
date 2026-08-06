import { useEffect, useRef, useState } from "react";
import { PluginSettingsPanel } from "./PluginSettingsPanel.js";
import { PresetCombobox } from "./PresetCombobox.js";
import { reasoningEffortLabels, ttsRates, ttsVoices } from "../constants.js";
import { emptyMcp, emptyProvider, reasoningEffortsForModel } from "../utils.js";

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
  const [saved, setSaved] = useState(false);
  const [officialEmail, setOfficialEmail] = useState("");
  const [officialPoints, setOfficialPoints] = useState<number | null>(null);
  const [officialPointsBusy, setOfficialPointsBusy] = useState(false);
  const [officialLoggedIn, setOfficialLoggedIn] = useState(false);
  const [officialBusy, setOfficialBusy] = useState(false);
  const settingsLoaded = useRef(false);
  const skipAutosave = useRef(true);
  const [activePage, setActivePage] = useState(() => {
    const hash = window.location.hash.replace(/^#/, "");
    const builtInPage = ["settings-tts", "settings-models", "settings-mcp", "settings-plugins"].includes(hash);
    return isOobe ? "settings-models" : (builtInPage || hash.startsWith("plugin-") ? hash : "settings-tts");
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
  const refreshOfficialPoints = async () => {
    setOfficialPointsBusy(true);
    try { setOfficialPoints((await bridge.officialBalance()).points); } catch { setOfficialPoints(null); } finally { setOfficialPointsBusy(false); }
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
      void bridge.saveSettings(settings).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
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
  const save = async () => {
    setError(""); setSaved(false);
    try { const result = await bridge.saveSettings(settings); setSettings(result); setSaved(true); setTimeout(() => setSaved(false), 2200); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const officialLogin = async () => {
    setError(""); setOfficialBusy(true);
    try { const next = await bridge.officialOAuthLogin(); setSettings(next); setAvailableModels(await bridge.listModels()); setOfficialLoggedIn(true); setSaved(true); await refreshOfficialPoints(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setOfficialBusy(false); }
  };
  const officialLogout = async () => { await bridge.officialLogout(); setOfficialLoggedIn(false); setOfficialPoints(null); setSettings((current) => current && { ...current, providers: current.providers.filter((provider) => provider.id !== "sectl-official") }); };
  const defaultModel = availableModels.find((model) => model.id === settings.defaultModelId) || availableModels.find((model) => model.id === "sectl-official") || availableModels[0];
  const defaultReasoningEfforts = reasoningEffortsForModel(defaultModel);
  const defaultReasoningEffort = defaultReasoningEfforts.includes(settings.defaultReasoningEffort || "high") ? (settings.defaultReasoningEffort || "high") : defaultReasoningEfforts.includes("high") ? "high" : defaultReasoningEfforts[0];
  return <main className={`settings-shell has-window-title ${isOobe ? "oobe-shell" : ""} ${bridge.platform === "darwin" ? "macos-settings" : ""} ${bridge.platform === "win32" ? "windows-settings" : ""}`}>
    <div className="settings-window-title">SecAgent设置</div>
    {!isOobe && <nav className="settings-nav" aria-label="Settings navigation"><button type="button" className={activePage === "settings-tts" ? "active" : ""} aria-current={activePage === "settings-tts" ? "page" : undefined} onClick={() => { setActivePage("settings-tts"); window.history.replaceState(null, "", "#settings-tts"); }}>朗读</button><button type="button" className={activePage === "settings-models" ? "active" : ""} aria-current={activePage === "settings-models" ? "page" : undefined} onClick={() => { setActivePage("settings-models"); window.history.replaceState(null, "", "#settings-models"); }}>模型</button><button type="button" className={activePage === "settings-mcp" ? "active" : ""} aria-current={activePage === "settings-mcp" ? "page" : undefined} onClick={() => { setActivePage("settings-mcp"); window.history.replaceState(null, "", "#settings-mcp"); }}>MCP 服务</button><button type="button" className={activePage === "settings-plugins" ? "active" : ""} aria-current={activePage === "settings-plugins" ? "page" : undefined} onClick={() => { setActivePage("settings-plugins"); window.history.replaceState(null, "", "#settings-plugins"); }}>插件</button>{plugins.flatMap((plugin) => plugin.settingsPages.map((page) => { const pageId = `plugin-${plugin.id}-${page.id}`; return <button type="button" className={activePage === pageId ? "active" : ""} aria-current={activePage === pageId ? "page" : undefined} key={pageId} onClick={() => { setActivePage(pageId); window.history.replaceState(null, "", `#${pageId}`); }}>{page.title}</button>; }))}</nav>}
    {isOobe && <>
      <header className="oobe-header"><p className="eyebrow">WELCOME TO SECAGENT</p><h1>先配置一个大模型</h1><p>完成模型配置后就可以开始使用。其他设置暂时不用处理，之后随时可以回来修改。</p><button className="primary-button" onClick={() => void save()}>保存并开始使用</button></header>
      <div className="oobe-intro"><strong>只需要完成这一项</strong><span>选择模型协议，填写模型名称和 API Key。MCP、语音及其他高级设置不会影响首次使用。</span></div>
    </>}
    {error && <div className="settings-error">{error}</div>}{isOobe && saved && <div className="settings-success">设置已保存，下一次请求立即生效。</div>}
    <section id="settings-tts" className={`settings-section ${isOobe || activePage === "settings-tts" ? "settings-section-active" : ""}`}><div className="section-title"><div><h2>朗读</h2><p>右键消息气泡选择“朗读”。语音由 Microsoft Edge 在线生成，不需要 API Key。</p></div></div>
      <article className="settings-card"><div className="form-grid"><label>语音音色<select value={settings.tts.voice} onChange={(event) => setSettings((current) => current && { ...current, tts: { ...current.tts, voice: event.target.value } })}>{ttsVoices.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>语速<select value={settings.tts.rate} onChange={(event) => setSettings((current) => current && { ...current, tts: { ...current.tts, rate: event.target.value } })}>{ttsRates.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div></article>
    </section>
    <section id="settings-models" className={`settings-section ${isOobe || activePage === "settings-models" ? "settings-section-active" : ""}`}><div className="section-title"><div><h2>模型提供商</h2><p>每个提供商可以包含多个模型；预设信息在启动时从 models.dev 更新。</p></div></div>
      <article className="settings-card official-service-card"><div className="card-heading"><strong>SecAgent 官方服务</strong>{officialLoggedIn && <button className="text-button danger" onClick={() => void officialLogout()}>退出登录</button>}</div><p>{officialLoggedIn ? `已登录 ${officialEmail} · 模型列表由后端动态获取` : "使用浏览器打开 SECTL 授权页登录，登录完成后自动返回 SecAgent。"}</p>{!officialLoggedIn && <button className="primary-button" type="button" disabled={officialBusy} onClick={() => void officialLogin()}>{officialBusy ? "等待浏览器授权…" : "打开浏览器登录 SECTL"}</button>}{officialLoggedIn && <div className="official-balance-row"><span>账户余额</span><strong className="points-value">{officialPointsBusy ? "读取中…" : officialPoints === null ? "暂不可用" : `${officialPoints.toFixed(6)} Points`}</strong><button className="secondary-button" type="button" onClick={() => void refreshOfficialPoints()}>刷新余额</button></div>}<div className="default-model-settings"><label>默认模型<select value={settings.defaultModelId || defaultModel?.id || ""} onChange={(event) => setSettings((current) => current && { ...current, defaultModelId: event.target.value })}>{availableModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label><label>默认思考强度<select value={defaultReasoningEffort} onChange={(event) => setSettings((current) => current && { ...current, defaultReasoningEffort: event.target.value as ReasoningEffort })}>{defaultReasoningEfforts.map((effort) => <option key={effort} value={effort}>{reasoningEffortLabels[effort]}</option>)}</select></label></div></article>
      {providerModalOpen && editingProvider && <div className="settings-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setProviderModalOpen(false); setEditingProvider(null); } }}><div className="settings-modal"><div className="session-modal-header"><strong>{settings.providers.some((provider) => provider.id === editingProvider.id) ? "编辑提供商" : "添加提供商"}</strong><button type="button" className="text-button" onClick={() => { setProviderModalOpen(false); setEditingProvider(null); }}>关闭</button></div><div className="form-grid"><label>提供商名称<input value={editingProvider.name} disabled={presetLocked} onChange={(event) => updateProvider({ name: event.target.value })} /></label><label>预设<PresetCombobox value={editingProvider.preset || "custom"} presets={providerPresets} onSelect={applyProviderPreset} /></label><label>协议<select value={editingProvider.provider} disabled={presetLocked} onChange={(event) => updateProvider({ provider: event.target.value as ProviderConfig["provider"] })}><option value="openai-compatible">OpenAI Chat 兼容</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic">Anthropic</option><option value="google">Google Gemini</option></select></label><label>API Key 环境变量<input value={editingProvider.apiKeyEnv} disabled={presetLocked} onChange={(event) => updateProvider({ apiKeyEnv: event.target.value })} /></label><label className="wide-field">Base URL<input value={editingProvider.baseUrl} disabled={presetLocked} onChange={(event) => updateProvider({ baseUrl: event.target.value })} /></label><label>Endpoint<input value={editingProvider.endpoint || ""} disabled={presetLocked} onChange={(event) => updateProvider({ endpoint: event.target.value })} /></label><label>API Key<input type="password" placeholder={editingProvider.apiKeyConfigured ? "已配置（留空保持不变）" : "粘贴 API Key"} value={editingProvider.apiKey || ""} onChange={(event) => updateProvider({ apiKey: event.target.value })} /></label></div><div className="provider-model-editor"><div className="card-heading"><strong>模型列表</strong><button type="button" className="secondary-button" disabled={presetLocked} onClick={() => { const id = window.prompt("模型 ID"); if (id?.trim()) updateProvider({ models: [...editingProvider.models, { id: id.trim(), name: id.trim(), enabled: true }] }); }}>+ 添加模型</button></div>{editingProvider.models.map((model, index) => <div className="provider-model-row" key={`${model.id}-${index}`}><input type="checkbox" title="启用后显示在模型列表" disabled={presetLocked} checked={model.enabled !== false} onChange={() => updateProvider({ models: editingProvider.models.map((item, itemIndex) => itemIndex === index ? { ...item, enabled: item.enabled === false } : item) })} /><input value={model.name || ""} disabled={presetLocked} onChange={(event) => updateProvider({ models: editingProvider.models.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) })} /><code>{model.id}</code><button type="button" className="text-button danger" disabled={presetLocked} onClick={() => updateProvider({ models: editingProvider.models.filter((_, itemIndex) => itemIndex !== index) })}>删除</button></div>)}</div><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => { setProviderModalOpen(false); setEditingProvider(null); }}>取消</button><button type="button" className="primary-button" onClick={saveProvider}>保存</button></div></div></div>}
      <div className="section-title provider-add-row"><div><h3>自定义提供商</h3></div><button className="secondary-button" type="button" onClick={() => { setEditingProvider(emptyProvider()); setProviderModalOpen(true); }}>+ 添加提供商</button></div>
      <div className="provider-list settings-cards">{settings.providers.filter((provider) => provider.id !== "sectl-official" && provider.name !== "SecAgent 官方服务").map((provider) => <article className={`settings-card provider-list-item${provider.models.length === 1 ? " single-model" : ""}`} key={provider.id}><div className="card-heading"><div><strong>{provider.name}</strong><span>{provider.models.length} 个模型 · {provider.preset && provider.preset !== "custom" ? `预设：${provider.preset}` : "自定义"}</span></div><div className="item-actions"><button className="secondary-button" type="button" onClick={() => { setEditingProvider({ ...provider, models: provider.models.map((model) => ({ ...model })) }); setProviderModalOpen(true); }}>编辑</button><button className="text-button danger" type="button" onClick={() => removeProvider(provider.id)}>删除</button></div></div></article>)}</div>
    </section>
    <section id="settings-mcp" className={`settings-section ${isOobe || activePage === "settings-mcp" ? "settings-section-active" : ""}`}><div className="section-title"><div><h2>MCP 服务</h2><p>管理可被 SecAgent 发现和调用的 MCP 服务。</p></div><button className="secondary-button" onClick={() => setSettings((current) => current && { ...current, mcp: { servers: { ...current.mcp.servers, [`mcp-${Object.keys(current.mcp.servers).length + 1}`]: emptyMcp() } } })}>+ 添加服务</button></div>
      <div className="settings-cards">{Object.entries(settings.mcp.servers).map(([name, server]) => <article className="settings-card" key={name}><div className="card-heading"><input className="server-name" value={name} onChange={(event) => renameServer(name, event.target.value)} />{Object.keys(settings.mcp.servers).length > 1 && <button className="text-button danger" onClick={() => setSettings((current) => { if (!current) return current; const servers = { ...current.mcp.servers }; delete servers[name]; return { ...current, mcp: { servers } }; })}>删除</button>}</div><div className="form-grid"><label>传输方式<select value={server.transport} onChange={(event) => updateServer(name, { transport: event.target.value as McpServerConfig["transport"] })}><option value="http">HTTP</option><option value="stdio">stdio</option></select></label><label className="checkbox-label"><input type="checkbox" checked={server.enabled} onChange={(event) => updateServer(name, { enabled: event.target.checked })} /> 启用</label>{server.transport === "http" ? <label>服务 URL<input value={server.url || ""} onChange={(event) => updateServer(name, { url: event.target.value })} /></label> : <><label>启动命令<input value={server.command || ""} onChange={(event) => updateServer(name, { command: event.target.value })} /></label><label>参数（每行一个）<textarea value={(server.args || []).join("\n")} onChange={(event) => updateServer(name, { args: event.target.value.split(/\r?\n/).filter(Boolean) })} rows={3} /></label></>}</div></article>)}</div>
    </section>
    <section id="settings-plugins" className={`settings-section ${isOobe || activePage === "settings-plugins" ? "settings-section-active" : ""}`}>
      <PluginSettingsPanel plugins={plugins} setPlugins={setPlugins} marketPlugins={marketPlugins} setMarketPlugins={setMarketPlugins} marketError={marketError} setMarketError={setMarketError} />
    </section>
    {!isOobe && plugins.flatMap((plugin) => plugin.settingsPages.map((page) => activePage === `plugin-${plugin.id}-${page.id}` && <section className="settings-section settings-section-active plugin-settings-section" key={`${plugin.id}-${page.id}`}>
      <div className="section-title"><h2>{page.title}</h2></div>
      <article className={`settings-card plugin-service-status ${plugin.state}`}>
        <span>服务状态</span>
        <strong>{plugin.message || (plugin.state === "ready" ? "已就绪" : "未连接")}</strong>
      </article>
    </section>))}

  </main>;
}
