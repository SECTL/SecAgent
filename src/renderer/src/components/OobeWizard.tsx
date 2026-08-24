import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { PresetCombobox } from "./PresetCombobox.js";
import { emptyProvider } from "../utils.js";
import { COMPANION_PLUGIN_IDS } from "../../../companion-catalog.js";

type SourcePath = "official" | "custom";
type OobeStep = "source" | "config" | "plugins";
type OobePageDirection = "forward" | "back";

const OOBE_STEP_ORDER: OobeStep[] = ["source", "config", "plugins"];

function compareMarketVersions(left: string, right: string): number {
  const parse = (value: string) => value.replace(/^v/i, "").split(/[.+-]/).map((part) => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

function latestCompatibleVersion(plugin: MarketplacePlugin | undefined, platform: NodeJS.Platform): MarketplaceVersion | undefined {
  return plugin?.versions
    .filter((version) => version.minHostApiVersion <= 1 && version.platforms.includes(platform))
    .slice()
    .sort((left, right) => compareMarketVersions(right.version, left.version))[0];
}

function isConnectorPlugin(plugin: MarketplacePlugin): boolean {
  return COMPANION_PLUGIN_IDS.has(plugin.id) || /联动/.test(`${plugin.name}${plugin.description}`);
}

export function OobeWizard() {
  const bridge = window.secagent;
  const [step, setStep] = useState<OobeStep>("source");
  const [pageTransition, setPageTransition] = useState<"idle" | "exit" | "enter">("idle");
  const [pageDirection, setPageDirection] = useState<OobePageDirection>("forward");
  const transitionTimer = useRef<number | undefined>(undefined);
  const [introPhase, setIntroPhase] = useState<"intro" | "transition" | "complete">("intro");
  const introTimer = useRef<number | undefined>(undefined);
  const [source, setSource] = useState<SourcePath | null>(null);
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [provider, setProvider] = useState<ProviderConfig>(() => emptyProvider());
  const [newModelId, setNewModelId] = useState("");
  const [officialLoggedIn, setOfficialLoggedIn] = useState(false);
  const [officialEmail, setOfficialEmail] = useState("");
  const [officialBusy, setOfficialBusy] = useState(false);
  const [apps, setApps] = useState<DetectedCompanionApp[]>([]);
  const [plugins, setPlugins] = useState<PluginStatus[]>([]);
  const [marketPlugins, setMarketPlugins] = useState<MarketplacePlugin[]>([]);
  const [marketError, setMarketError] = useState("");
  const [installingId, setInstallingId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => () => {
    if (transitionTimer.current !== undefined) window.clearTimeout(transitionTimer.current);
    if (introTimer.current !== undefined) window.clearTimeout(introTimer.current);
  }, []);

  const beginIntro = () => {
    if (introPhase !== "intro") return;
    setIntroPhase("transition");
    introTimer.current = window.setTimeout(() => {
      setIntroPhase("complete");
      introTimer.current = undefined;
    }, 560);
  };

  const goToStep = (nextStep: OobeStep) => {
    if (nextStep === step || pageTransition !== "idle") return;
    const currentIndex = OOBE_STEP_ORDER.indexOf(step);
    const nextIndex = OOBE_STEP_ORDER.indexOf(nextStep);
    setPageDirection(nextIndex > currentIndex ? "forward" : "back");
    setPageTransition("exit");
    transitionTimer.current = window.setTimeout(() => {
      setStep(nextStep);
      setPageTransition("enter");
      transitionTimer.current = window.setTimeout(() => {
        setPageTransition("idle");
        transitionTimer.current = undefined;
      }, 240);
    }, 160);
  };

  useEffect(() => {
    void bridge.getSettings().then(setSettings).catch((reason) => setError(String(reason)));
    void bridge.listProviders().then(setPresets).catch(() => undefined);
    void bridge.officialStatus().then((status) => {
      setOfficialLoggedIn(status.loggedIn);
      setOfficialEmail(status.email);
    }).catch(() => undefined);
  }, [bridge]);

  useEffect(() => {
    if (step !== "plugins") return;
    let disposed = false;
    void Promise.all([
      bridge.detectInstalledApps(),
      bridge.listPlugins(),
      bridge.listMarketplace().catch((reason) => {
        if (!disposed) setMarketError(reason instanceof Error ? reason.message : String(reason));
        return [] as MarketplacePlugin[];
      })
    ]).then(([detected, installed, market]) => {
      if (disposed) return;
      setApps(detected);
      setPlugins(installed);
      setMarketPlugins(market);
    }).catch((reason) => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, [bridge, step]);

  const updateProvider = (patch: Partial<ProviderConfig>) => setProvider((current) => ({ ...current, ...patch }));
  const applyPreset = (presetId: string) => {
    if (presetId === "custom") { updateProvider({ preset: "custom" }); return; }
    const preset = presets.find((item) => item.id === presetId);
    if (!preset) return;
    const env = `${preset.name.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}_API_KEY`;
    const isAnthropic = /anthropic/i.test(preset.id);
    const isGoogle = /google|gemini/i.test(preset.id);
    const baseUrl = isAnthropic || isGoogle || !preset.api || /\/v1(?:beta)?\/?$/i.test(preset.api) ? preset.api : `${preset.api.replace(/\/$/, "")}/v1`;
    updateProvider({
      preset: preset.id,
      name: preset.name,
      apiKeyEnv: env,
      baseUrl: baseUrl || provider.baseUrl,
      provider: isGoogle ? "google" : isAnthropic ? "anthropic" : "openai-compatible",
      endpoint: isGoogle ? "" : isAnthropic ? "/v1/messages" : "/chat/completions",
      models: preset.models.map((model) => ({ id: model.id, name: model.name || model.id, enabled: true }))
    });
  };

  const persist = async (payload: SettingsPayload) => {
    const saved = await bridge.saveSettings(payload);
    setSettings(saved);
    return saved;
  };

  const loginOfficial = async () => {
    setError("");
    setOfficialBusy(true);
    try {
      const next = await bridge.officialOAuthLogin();
      await persist({ ...next, customModelMode: false });
      const status = await bridge.officialStatus();
      setOfficialLoggedIn(status.loggedIn);
      setOfficialEmail(status.email);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setOfficialBusy(false);
    }
  };

  const continueFromSource = async () => {
    if (!settings || !source) return;
    setError("");
    setBusy(true);
    try {
      if (source === "official") {
        if (!officialLoggedIn) throw new Error("请先登录 SECTL 账号");
        await persist({ ...settings, customModelMode: false });
      } else {
        if (!provider.name.trim() || !provider.apiKeyEnv.trim() || !provider.baseUrl.trim() || !provider.models.length) {
          throw new Error("请填写提供商信息并至少添加一个模型");
        }
        const providers = settings.providers.some((item) => item.id === provider.id)
          ? settings.providers.map((item) => item.id === provider.id ? provider : item)
          : [...settings.providers.filter((item) => item.id !== "sectl-official"), provider, ...settings.providers.filter((item) => item.id === "sectl-official")];
        await persist({ ...settings, customModelMode: true, providers });
      }
      goToStep("plugins");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setError("");
    setBusy(true);
    try {
      await bridge.completeOnboarding();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  const installPlugin = async (plugin: MarketplacePlugin) => {
    const version = latestCompatibleVersion(plugin, bridge.platform);
    if (!version) return;
    setInstallingId(plugin.id);
    setError("");
    try {
      setPlugins(await bridge.installMarketplaceVersion(version));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setInstallingId("");
    }
  };

  const recommended = useMemo(() => apps.filter((app) => app.detected), [apps]);
  const otherConnectors = useMemo(() => {
    const recommendedIds = new Set(recommended.map((app) => app.pluginId));
    return marketPlugins.filter((plugin) => isConnectorPlugin(plugin) && !recommendedIds.has(plugin.id));
  }, [marketPlugins, recommended]);

  if (!settings) return <main className="settings-shell oobe-shell has-window-title"><p>正在读取配置…</p></main>;

  return <main className={`settings-shell oobe-shell has-window-title ${introPhase === "intro" ? "oobe-intro-active" : ""} ${bridge.platform === "darwin" ? "macos-settings" : ""} ${bridge.platform === "win32" ? "windows-settings" : ""}`}>
    <div className={`settings-window-title oobe-window-title ${introPhase === "intro" ? "oobe-window-title-intro" : introPhase === "transition" ? "oobe-window-title-transition" : "oobe-window-title-ready"}`}>欢迎使用 SecAgent</div>
    {introPhase !== "complete" && <section className={`oobe-splash ${introPhase === "transition" ? "oobe-splash-exit" : ""}`} aria-label="SecAgent 欢迎页">
      <img className="oobe-splash-icon" src="/icon.svg" alt="SecAgent" />
      <button className="oobe-splash-start" type="button" aria-label="开始配置 SecAgent" onClick={beginIntro}><ArrowRight aria-hidden="true" size={30} strokeWidth={1.8} /></button>
    </section>}
    <div className={`oobe-content ${introPhase === "intro" ? "oobe-content-hidden" : introPhase === "transition" ? "oobe-content-intro-enter" : "oobe-content-ready"}`}>
    <div className={`oobe-page ${pageTransition === "exit" ? "oobe-page-exit" : pageTransition === "enter" ? "oobe-page-enter" : ""} oobe-page-${pageDirection}`}>
    <header className="oobe-header">
      <p className="eyebrow">WELCOME TO SECAGENT</p>
      <p className="oobe-step-label">第 {step === "source" ? "1" : step === "config" ? "2" : "3"} / 3 步</p>
      <h1>{step === "source" ? "选择模型服务" : step === "config" ? "配置模型服务" : "安装课堂联动插件"}</h1>
      <p>{step === "source"
        ? "先选择使用 SECTL 官方模型服务，还是接入自己的模型提供商。"
        : step === "config"
          ? "完成模型服务的登录或接口配置，之后即可开始使用 SecAgent。"
          : "先看看本机已经装了哪些适配应用，再安装对应的联动插件。这一步也可以跳过。"}</p>
    </header>
    {error && <div className="settings-error">{error}</div>}

    {step === "source" && <>
      <div className="oobe-choice-grid">
        <button type="button" className="oobe-choice" onClick={() => { setSource("official"); goToStep("config"); }}>
          <span className="oobe-choice-copy"><strong>登录官方服务</strong><span>使用 SECTL 账号使用官方模型，不必自己准备 API Key。默认关闭自定义模型模式。</span></span>
          <span className="oobe-choice-arrow" aria-hidden="true"><ArrowRight size={22} strokeWidth={2} /></span>
        </button>
        <button type="button" className="oobe-choice" onClick={() => { setSource("custom"); goToStep("config"); }}>
          <span className="oobe-choice-copy"><strong>设置自定义模型提供商</strong><span>接入 OpenAI 兼容、Anthropic、Gemini 等自备供应商，并开启自定义模型模式。</span></span>
          <span className="oobe-choice-arrow" aria-hidden="true"><ArrowRight size={22} strokeWidth={2} /></span>
        </button>
      </div>

    </>}

    {step === "config" && <>
      {source === "official" && <article className="settings-card oobe-panel">
        <p>{officialLoggedIn ? `已登录 ${officialEmail || "SECTL 账号"}。继续后将使用官方模型服务。` : "将打开浏览器登录 SECTL。登录完成后会自动返回，并使用官方模型服务。"}</p>
        {!officialLoggedIn && <button className="primary-button" type="button" disabled={officialBusy} onClick={() => void loginOfficial()}>{officialBusy ? "等待浏览器授权…" : "打开浏览器登录 SECTL"}</button>}
      </article>}

      {source === "custom" && <article className="settings-card oobe-panel">
        <div className="form-grid">
          <label>提供商名称<input value={provider.name} onChange={(event) => updateProvider({ name: event.target.value })} /></label>
          <label>预设<PresetCombobox value={provider.preset || "custom"} presets={presets} onSelect={applyPreset} /></label>
          <label>协议<select value={provider.provider} onChange={(event) => updateProvider({ provider: event.target.value as ProviderConfig["provider"] })}><option value="openai-compatible">OpenAI Chat 兼容</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic">Anthropic</option><option value="google">Google Gemini</option></select></label>
          <label>API Key 环境变量<input value={provider.apiKeyEnv} onChange={(event) => updateProvider({ apiKeyEnv: event.target.value })} /></label>
          <label className="wide-field">Base URL<input value={provider.baseUrl} onChange={(event) => updateProvider({ baseUrl: event.target.value })} /></label>
          <label>Endpoint<input value={provider.endpoint || ""} onChange={(event) => updateProvider({ endpoint: event.target.value })} /></label>
          <label>API Key<input type="password" placeholder={provider.apiKeyConfigured ? "已配置（留空保持不变）" : "粘贴 API Key"} value={provider.apiKey || ""} onChange={(event) => updateProvider({ apiKey: event.target.value })} /></label>
        </div>
        <div className="provider-model-editor">
          <div className="card-heading">
            <strong>模型列表</strong>
            <div className="oobe-model-add">
              <input value={newModelId} placeholder="模型 ID" onChange={(event) => setNewModelId(event.target.value)} />
              <button type="button" className="secondary-button" onClick={() => {
                const id = newModelId.trim();
                if (!id || provider.models.some((model) => model.id === id)) return;
                updateProvider({ models: [...provider.models, { id, name: id, enabled: true }] });
                setNewModelId("");
              }}>+ 添加模型</button>
            </div>
          </div>
          {provider.models.map((model, index) => <div className="provider-model-row" key={`${model.id}-${index}`}>
            <input value={model.name || ""} onChange={(event) => updateProvider({ models: provider.models.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) })} />
            <code>{model.id}</code>
            <button type="button" className="text-button danger" onClick={() => updateProvider({ models: provider.models.filter((_, itemIndex) => itemIndex !== index) })}>删除</button>
          </div>)}
          {!provider.models.length && <p className="empty-list">至少添加一个模型 ID 才能继续。</p>}
        </div>
      </article>}

      <div className="oobe-actions">
        <button className="secondary-button" type="button" onClick={() => { setSource(null); goToStep("source"); }}>上一步</button>
        <button className="primary-button" type="button" disabled={!source || busy || (source === "official" && !officialLoggedIn)} onClick={() => void continueFromSource()}>{busy ? "保存中…" : "下一步"}</button>
      </div>
    </>}

    {step === "plugins" && <>
      {marketError && <div className="settings-error">{marketError}</div>}
      <section className="oobe-plugin-list">
        <h2>本机已检测到</h2>
        {!recommended.length && <p className="empty-list">没有检测到已适配的课堂应用。你仍可安装下面的联动插件，或稍后在设置里处理。</p>}
        {recommended.map((app) => {
          const market = marketPlugins.find((plugin) => plugin.id === app.pluginId);
          const installed = plugins.find((plugin) => plugin.id === app.pluginId);
          const version = latestCompatibleVersion(market, bridge.platform);
          return <article className="settings-card oobe-plugin-card" key={app.pluginId}>
            <div>
              <strong>{app.appName}</strong>
              <span>{app.description} · 已在本机找到</span>
            </div>
            {installed ? <span className="oobe-plugin-state">已安装</span> : market && version ? <button className="primary-button" type="button" disabled={installingId === app.pluginId} onClick={() => void installPlugin(market)}>{installingId === app.pluginId ? "安装中…" : `安装联动插件`}</button> : <span className="oobe-plugin-state">市场暂无该联动插件</span>}
          </article>;
        })}
      </section>
      {otherConnectors.length > 0 && <section className="oobe-plugin-list">
        <h2>其他联动插件</h2>
        {otherConnectors.map((plugin) => {
          const installed = plugins.find((item) => item.id === plugin.id);
          const version = latestCompatibleVersion(plugin, bridge.platform);
          return <article className="settings-card oobe-plugin-card" key={plugin.id}>
            <div>
              <strong>{plugin.name}</strong>
              <span>{plugin.description}</span>
            </div>
            {installed ? <span className="oobe-plugin-state">已安装</span> : version ? <button className="secondary-button" type="button" disabled={installingId === plugin.id} onClick={() => void installPlugin(plugin)}>{installingId === plugin.id ? "安装中…" : "安装"}</button> : <span className="oobe-plugin-state">当前系统暂无可用版本</span>}
          </article>;
        })}
      </section>}
      <div className="oobe-actions">
        <button className="secondary-button" type="button" onClick={() => goToStep("config")}>上一步</button>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => void finish()}>暂时跳过</button>
        <button className="primary-button" type="button" disabled={busy} onClick={() => void finish()}>{busy ? "完成中…" : "完成并开始使用"}</button>
      </div>
    </>}
    </div>
    </div>
  </main>;
}
