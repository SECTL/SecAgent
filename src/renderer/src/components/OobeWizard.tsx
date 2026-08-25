import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import { PresetCombobox } from "./PresetCombobox.js";
import { emptyProvider } from "../utils.js";

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
  const [classIslandTargets, setClassIslandTargets] = useState<ClassIslandInstallCandidate[]>([]);
  const [classIslandSelectedIds, setClassIslandSelectedIds] = useState<string[]>([]);
  const [classIslandResults, setClassIslandResults] = useState<Record<string, ClassIslandInstallResult>>({});
  const [classIslandPhase, setClassIslandPhase] = useState<ClassIslandInstallPhase | "idle">("idle");
  const [secRandomTargets, setSecRandomTargets] = useState<SecRandomInstallCandidate[]>([]);
  const [secRandomSelectedIds, setSecRandomSelectedIds] = useState<string[]>([]);
  const [secRandomResults, setSecRandomResults] = useState<Record<string, SecRandomInstallResult>>({});
  const [secRandomPhase, setSecRandomPhase] = useState<SecRandomInstallProgress["phase"] | "idle">("idle");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progressReady, setProgressReady] = useState(false);
  const [pluginsReveal, setPluginsReveal] = useState(false);

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
    let disposed = false;
    void bridge.detectInstalledApps().then((detectedApps) => {
      if (!disposed) setApps(detectedApps);
    }).catch(() => undefined);
    void bridge.detectClassIslandInstallations().then((targets) => {
      if (disposed) return;
      setClassIslandTargets(targets);
      setClassIslandSelectedIds((current) => {
        const validCurrent = current.filter((id) => targets.some((target) => target.id === id && target.compatible));
        if (validCurrent.length) return validCurrent;
        const running = targets.filter((target) => target.compatible && target.isRunning).map((target) => target.id);
        if (running.length) return running;
        const compatible = targets.filter((target) => target.compatible);
        return compatible.length === 1 ? [compatible[0].id] : [];
      });
    }).catch(() => undefined);
    void bridge.detectSecRandomInstallations().then((targets) => {
      if (disposed) return;
      setSecRandomTargets(targets);
      setSecRandomSelectedIds((current) => {
        const validCurrent = current.filter((id) => targets.some((target) => target.id === id && target.compatible));
        if (validCurrent.length) return validCurrent;
        const running = targets.filter((target) => target.compatible && target.isRunning).map((target) => target.id);
        if (running.length) return running;
        const compatible = targets.filter((target) => target.compatible);
        return compatible.length === 1 ? [compatible[0].id] : [];
      });
    }).catch(() => undefined);
    void Promise.all([
      bridge.getSettings(),
      bridge.listProviders(),
      bridge.officialStatus(),
      bridge.getOobeProgress()
    ]).then(([loadedSettings, loadedPresets, status, savedProgress]) => {
      if (disposed) return;
      setSettings(loadedSettings);
      setPresets(loadedPresets);
      setOfficialLoggedIn(status.loggedIn);
      setOfficialEmail(status.email);

      // Older builds already persisted the login token but did not persist OOBE progress.
      // Treat that state as the official service configuration page when onboarding resumes.
      const progress = savedProgress || (status.loggedIn ? { step: "config" as const, source: "official" as const } : undefined);
      if (progress) {
        setStep(progress.step);
        setSource(progress.source || null);
        if (progress.provider) setProvider({ ...emptyProvider(), ...progress.provider, models: progress.provider.models.map((model) => ({ ...model })) });
        setIntroPhase("complete");
      }
      setProgressReady(true);
    }).catch((reason) => {
      if (disposed) return;
      setError(String(reason));
      setProgressReady(true);
    });
    return () => { disposed = true; };
  }, [bridge]);

  useEffect(() => {
    if (step !== "plugins") return;
    let disposed = false;
    void Promise.all([
      bridge.listPlugins(),
      bridge.listMarketplace().catch((reason) => {
        if (!disposed) setMarketError(reason instanceof Error ? reason.message : String(reason));
        return [] as MarketplacePlugin[];
      })
    ]).then(([installed, market]) => {
      if (disposed) return;
      setPlugins(installed);
      setMarketPlugins(market);
    }).catch((reason) => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, [bridge, step]);

  useEffect(() => bridge.onClassIslandProgress((progress) => {
    if (progress?.phase) setClassIslandPhase(progress.phase);
  }), [bridge]);

  useEffect(() => bridge.onSecRandomProgress((progress) => {
    if (progress?.phase) setSecRandomPhase(progress.phase);
  }), [bridge]);

  useEffect(() => {
    setPluginsReveal(false);
    if (step !== "plugins") return;
    const timer = window.setTimeout(() => setPluginsReveal(true), 0);
    return () => window.clearTimeout(timer);
  }, [step]);

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

  const saveProgress = async (progress: OobeProgress) => {
    await bridge.saveOobeProgress(progress);
  };

  const chooseSource = async (nextSource: SourcePath) => {
    setError("");
    try {
      await saveProgress({ step: "config", source: nextSource, ...(nextSource === "custom" ? { provider } : {}) });
      setSource(nextSource);
      goToStep("config");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    if (!progressReady || step !== "config" || source !== "custom") return;
    const timer = window.setTimeout(() => {
      void bridge.saveOobeProgress({ step: "config", source, provider }).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [bridge, progressReady, provider, source, step]);

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
      await saveProgress({ step: "plugins", source, ...(source === "custom" ? { provider } : {}) });
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

  const pickClassIslandExecutable = async () => {
    setError("");
    try {
      const candidate = await bridge.pickClassIslandExecutable();
      if (!candidate) return;
      setClassIslandTargets((current) => current.some((item) => item.id === candidate.id) ? current.map((item) => item.id === candidate.id ? candidate : item) : [...current, candidate]);
      if (candidate.compatible) setClassIslandSelectedIds((current) => current.includes(candidate.id) ? current : [...current, candidate.id]);
      if (!candidate.compatible) setError(candidate.reason || "选择的 ClassIsland 版本不兼容");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const pickSecRandomExecutable = async () => {
    setError("");
    try {
      const candidate = await bridge.pickSecRandomExecutable();
      if (!candidate) return;
      setSecRandomTargets((current) => current.some((item) => item.id === candidate.id) ? current.map((item) => item.id === candidate.id ? candidate : item) : [...current, candidate]);
      if (candidate.compatible) setSecRandomSelectedIds((current) => current.includes(candidate.id) ? current : [...current, candidate.id]);
      if (!candidate.compatible) setError(candidate.reason || "选择的 SecRandom 版本不兼容");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const installClassIslandPlugin = async (market: MarketplacePlugin | undefined) => {
    const selectedTargets = classIslandTargets.filter((target) => classIslandSelectedIds.includes(target.id));
    if (!selectedTargets.length) {
      setError("请先选择一个或多个 ClassIsland 安装目标");
      return;
    }
    if (selectedTargets.some((target) => !target.compatible)) {
      setError("所选 ClassIsland 版本低于 2.1.1.0，无法安装联动插件");
      return;
    }
    const connectorInstalled = plugins.some((plugin) => plugin.id === "classisland-connector");
    const connectorVersion = market ? latestCompatibleVersion(market, bridge.platform) : undefined;
    if (!connectorInstalled && !connectorVersion) {
      setError("市场暂无兼容的 SecAgent ClassIsland 连接器");
      return;
    }
    setInstallingId("classisland-connector");
    setClassIslandPhase("downloading");
    setError("");
    try {
      if (!connectorInstalled && connectorVersion) setPlugins(await bridge.installMarketplaceVersion(connectorVersion));
      const results = await bridge.installClassIslandCompanion(selectedTargets.map((target) => target.id));
      setClassIslandResults((current) => ({ ...current, ...Object.fromEntries(results.map((result) => [result.targetId, result])) }));
      setClassIslandTargets((current) => current.map((target) => {
        const result = results.find((item) => item.targetId === target.id);
        return result?.ok && result.version ? { ...target, installedPluginVersion: result.version } : target;
      }));
      const failures = results.filter((result) => !result.ok);
      if (failures.length) setError(failures.map((result) => result.message).join("；"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setInstallingId("");
      setClassIslandPhase("idle");
    }
  };

  const installSecRandomPlugin = async (market: MarketplacePlugin | undefined) => {
    const selectedTargets = secRandomTargets.filter((target) => secRandomSelectedIds.includes(target.id));
    if (!selectedTargets.length) {
      setError("请先选择一个或多个 SecRandom 安装目标");
      return;
    }
    if (selectedTargets.some((target) => !target.compatible)) {
      setError("所选 SecRandom 版本低于 3.0.0-alpha.1，无法安装联动插件");
      return;
    }
    const connectorInstalled = plugins.some((plugin) => plugin.id === "secrandom");
    const connectorVersion = market ? latestCompatibleVersion(market, bridge.platform) : undefined;
    if (!connectorInstalled && !connectorVersion) {
      setError("市场暂无兼容的 SecRandom 连接器");
      return;
    }
    setInstallingId("secrandom");
    setSecRandomPhase("downloading");
    setError("");
    try {
      if (!connectorInstalled && connectorVersion) setPlugins(await bridge.installMarketplaceVersion(connectorVersion));
      const results = await bridge.installSecRandomCompanion(selectedTargets.map((target) => target.id));
      setSecRandomResults((current) => ({ ...current, ...Object.fromEntries(results.map((result) => [result.targetId, result])) }));
      setSecRandomTargets((current) => current.map((target) => {
        const result = results.find((item) => item.targetId === target.id);
        return result?.ok && result.version ? { ...target, installedPluginVersion: result.version } : target;
      }));
      const failures = results.filter((result) => !result.ok);
      if (failures.length) setError(failures.map((result) => result.message).join("；"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setInstallingId("");
      setSecRandomPhase("idle");
    }
  };

  const recommended = useMemo(() => apps.filter((app) => app.detected || app.pluginId === "classisland-connector" || app.pluginId === "secrandom"), [apps]);

  if (!settings || !progressReady) return <main className="settings-shell oobe-shell has-window-title"><p>正在读取配置…</p></main>;

  return <main className={`settings-shell oobe-shell has-window-title ${introPhase === "intro" ? "oobe-intro-active" : ""} ${bridge.platform === "darwin" ? "macos-settings" : ""} ${bridge.platform === "win32" ? "windows-settings" : ""}`}>
    <div className={`settings-window-title oobe-window-title ${introPhase === "intro" ? "oobe-window-title-intro" : introPhase === "transition" ? "oobe-window-title-transition" : "oobe-window-title-ready"}`}>欢迎使用 SecAgent</div>
    {introPhase !== "complete" && <section className={`oobe-splash ${introPhase === "transition" ? "oobe-splash-exit" : ""}`} aria-label="SecAgent 欢迎页">
      <img className="oobe-splash-icon" src="/icon.svg" alt="SecAgent" />
      <button className="oobe-splash-start" type="button" aria-label="开始配置 SecAgent" onClick={beginIntro}><ArrowRight aria-hidden="true" size={30} strokeWidth={1.8} /></button>
    </section>}
    <div className={`oobe-content ${introPhase === "intro" ? "oobe-content-hidden" : introPhase === "transition" ? "oobe-content-intro-enter" : "oobe-content-ready"}`}>
    <div className={`oobe-page ${pageTransition === "exit" ? "oobe-page-exit" : pageTransition === "enter" ? "oobe-page-enter" : ""} oobe-page-${pageDirection} ${step === "plugins" ? "oobe-page-plugins" : ""} ${pluginsReveal ? "oobe-plugins-reveal" : ""}`}>
    <header className="oobe-header">
      <div className="oobe-progress" role="progressbar" aria-label="OOBE 步骤进度" aria-valuemin={1} aria-valuemax={OOBE_STEP_ORDER.length} aria-valuenow={OOBE_STEP_ORDER.indexOf(step) + 1}>
        {OOBE_STEP_ORDER.map((item, index) => <span className={`oobe-progress-segment ${index <= OOBE_STEP_ORDER.indexOf(step) ? "is-active" : ""}`} key={item} />)}
      </div>
      <p className="oobe-step-label">第 {step === "source" ? "1" : step === "config" ? "2" : "3"} / 3 步</p>
      <h1>{step === "source" ? "选择模型服务" : step === "config" ? "配置模型服务" : "安装课堂联动插件"}</h1>
      {step !== "plugins" && <p>{step === "source"
        ? "先选择使用 SECTL 官方模型服务，还是接入自己的模型提供商。"
        : step === "config"
          ? "完成模型服务的登录或接口配置，之后即可开始使用 SecAgent。"
          : ""}</p>}
    </header>
    {error && <div className="settings-error">{error}</div>}

    {step === "source" && <>
      <div className="oobe-choice-grid">
        <button type="button" className="oobe-choice" onClick={() => void chooseSource("official")}>
          <span className="oobe-choice-copy"><strong>登录官方服务</strong><span>使用 SECTL 账号使用官方模型，不必自己准备 API Key。默认关闭自定义模型模式。</span></span>
          <span className="oobe-choice-arrow" aria-hidden="true"><ArrowRight size={22} strokeWidth={2} /></span>
        </button>
        <button type="button" className="oobe-choice" onClick={() => void chooseSource("custom")}>
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
        <button className="secondary-button" type="button" onClick={() => void saveProgress({ step: "source" }).then(() => { setSource(null); goToStep("source"); }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))}>上一步</button>
        <button className="primary-button" type="button" disabled={!source || busy || (source === "official" && !officialLoggedIn)} onClick={() => void continueFromSource()}>{busy ? "保存中…" : "下一步"}</button>
      </div>
    </>}

    {step === "plugins" && <>
      {marketError && <div className="settings-error">{marketError}</div>}
      <section className="oobe-plugin-list">
        <h2>本机已检测到</h2>
        {!apps.some((app) => app.detected) && <p className="empty-list">没有自动检测到已适配的课堂应用。你可以在 ClassIsland 卡片中手动选择安装位置，或稍后在设置里处理。</p>}
        {recommended.map((app, index) => {
          const market = marketPlugins.find((plugin) => plugin.id === app.pluginId);
          const installed = plugins.find((plugin) => plugin.id === app.pluginId);
          const version = latestCompatibleVersion(market, bridge.platform);
          const installing = installingId === app.pluginId;
          const isClassIsland = app.pluginId === "classisland-connector";
          const isSecRandom = app.pluginId === "secrandom";
          const selectedClassIslandTargets = classIslandTargets.filter((target) => classIslandSelectedIds.includes(target.id));
          const classIslandCompanionInstalled = selectedClassIslandTargets.length > 0 && selectedClassIslandTargets.every((target) => Boolean(target.installedPluginVersion));
          const classIslandCanInstall = selectedClassIslandTargets.length > 0 && selectedClassIslandTargets.every((target) => target.compatible) && !classIslandCompanionInstalled && (Boolean(installed) || Boolean(version));
          const classIslandPhaseLabel = classIslandPhase === "downloading" ? "下载中…" : classIslandPhase === "verifying" ? "校验中…" : classIslandPhase === "installing" ? "安装中…" : classIslandPhase === "restarting" ? "重启中…" : classIslandCompanionInstalled ? "ClassIsland 插件已安装" : installed ? "安装 ClassIsland 插件" : version ? "安装并配置" : "市场暂无连接器";
          const selectedSecRandomTargets = secRandomTargets.filter((target) => secRandomSelectedIds.includes(target.id));
          const secRandomCompanionInstalled = selectedSecRandomTargets.length > 0 && selectedSecRandomTargets.every((target) => Boolean(target.installedPluginVersion));
          const secRandomCanInstall = selectedSecRandomTargets.length > 0 && selectedSecRandomTargets.every((target) => target.compatible) && !secRandomCompanionInstalled && (Boolean(installed) || Boolean(version));
          const secRandomPhaseLabel = secRandomPhase === "downloading" ? "下载中…" : secRandomPhase === "verifying" ? "校验中…" : secRandomPhase === "installing" ? "安装中…" : secRandomPhase === "restarting" ? "重启中…" : secRandomCompanionInstalled ? "SecRandom 插件已安装" : installed ? "安装 SecRandom 插件" : version ? "安装并配置" : "市场暂无连接器";
          return <article className={`settings-card oobe-plugin-card${isClassIsland ? " oobe-plugin-card-classisland" : isSecRandom ? " oobe-plugin-card-secrandom" : ""}${installing ? " is-installing" : ""}`} aria-busy={installing} style={{ animationDelay: `${index * 70}ms` }} key={app.pluginId}>
            <div className="oobe-plugin-main">
              <span className={`oobe-plugin-icon${installed?.icon ? " has-plugin-icon" : ""}`} aria-hidden="true">
                <img className="oobe-plugin-icon-app" src={app.icon} alt="" />
                {installed?.icon && <img className="oobe-plugin-icon-plugin" key={installed.icon} src={installed.icon} alt="" />}
              </span>
              <div className="oobe-plugin-copy">
                <strong>{app.appName}</strong>
                <span>{isClassIsland ? (classIslandTargets.length ? app.description : "未自动找到安装目录，可手动选择") : isSecRandom ? (secRandomTargets.length ? app.description : "未自动找到安装目录，可手动选择") : `${app.description} · 已在本机找到`}</span>
              </div>
            </div>
            {isClassIsland ? <div className="oobe-plugin-side-actions">
              {installed && <span className="oobe-plugin-state" aria-label="SecAgent 连接器已安装" title="SecAgent 连接器已安装"><Check aria-hidden="true" size={20} strokeWidth={2.4} /></span>}
              <button className="primary-button" type="button" disabled={installing || !classIslandCanInstall} onClick={() => void installClassIslandPlugin(market)}>{installing ? classIslandPhaseLabel : classIslandCompanionInstalled ? "ClassIsland 插件已安装" : installed ? "安装 ClassIsland 插件" : version ? "安装并配置" : "市场暂无连接器"}</button>
            </div> : isSecRandom ? <div className="oobe-plugin-side-actions">
              {installed && <span className="oobe-plugin-state" aria-label="SecAgent 连接器已安装" title="SecAgent 连接器已安装"><Check aria-hidden="true" size={20} strokeWidth={2.4} /></span>}
              <button className="primary-button" type="button" disabled={installing || !secRandomCanInstall} onClick={() => void installSecRandomPlugin(market)}>{installing ? secRandomPhaseLabel : secRandomCompanionInstalled ? "SecRandom 插件已安装" : installed ? "安装 SecRandom 插件" : version ? "安装并配置" : "市场暂无连接器"}</button>
            </div> : installed ? <span className="oobe-plugin-state" aria-label="已安装" title="已安装"><Check aria-hidden="true" size={20} strokeWidth={2.4} /></span> : market && version ? <button className="primary-button" type="button" disabled={installing} onClick={() => void installPlugin(market)}>{installing ? "安装中…" : `安装联动插件`}</button> : <span className="oobe-plugin-state">市场暂无该联动插件</span>}
            {isClassIsland && <div className="oobe-classisland-targets">
              <div className="oobe-classisland-target-heading"><strong>选择 ClassIsland 安装目标</strong><button className="secondary-button" type="button" disabled={installing} onClick={() => void pickClassIslandExecutable()}>选择 ClassIsland.exe</button></div>
              {!classIslandTargets.length && <p className="empty-list">未找到 ClassIsland，可选择其可执行文件。</p>}
              {classIslandTargets.map((target) => {
                const result = classIslandResults[target.id];
                return <label className={`oobe-classisland-target${target.compatible ? "" : " is-incompatible"}`} key={target.id}>
                  <input type="checkbox" checked={classIslandSelectedIds.includes(target.id)} disabled={!target.compatible || installing} onChange={() => setClassIslandSelectedIds((current) => current.includes(target.id) ? current.filter((id) => id !== target.id) : [...current, target.id])} />
                  <span><strong>ClassIsland {target.version ? `v${target.version}` : "版本未知"}{target.isRunning ? " · 正在运行" : ""}</strong><small>{target.executablePath}{target.installedPluginVersion ? ` · 已安装 SecAgent 插件 v${target.installedPluginVersion}` : ""}</small>{!target.compatible && <em>{target.reason}</em>}{result && <em className={result.ok ? "is-success" : "is-error"}>{result.message}</em>}</span>
                </label>;
              })}
            </div>}
            {isSecRandom && <div className="oobe-classisland-targets">
              <div className="oobe-classisland-target-heading"><strong>选择 SecRandom 安装目标</strong><button className="secondary-button" type="button" disabled={installing} onClick={() => void pickSecRandomExecutable()}>选择 SecRandom 可执行文件</button></div>
              {!secRandomTargets.length && <p className="empty-list">未找到 SecRandom，可选择其可执行文件。</p>}
              {secRandomTargets.map((target) => {
                const result = secRandomResults[target.id];
                return <label className={`oobe-classisland-target${target.compatible ? "" : " is-incompatible"}`} key={target.id}>
                  <input type="checkbox" checked={secRandomSelectedIds.includes(target.id)} disabled={!target.compatible || installing} onChange={() => setSecRandomSelectedIds((current) => current.includes(target.id) ? current.filter((id) => id !== target.id) : [...current, target.id])} />
                  <span><strong>SecRandom {target.version ? `v${target.version}` : "版本未知"}{target.isRunning ? " · 正在运行" : ""}</strong><small>{target.executablePath}{target.installedPluginVersion ? ` · 已安装 SecAgent 插件 v${target.installedPluginVersion}` : ""}</small>{!target.compatible && <em>{target.reason}</em>}{result && <em className={result.ok ? "is-success" : "is-error"}>{result.message}</em>}</span>
                </label>;
              })}
            </div>}
          </article>;
        })}
      </section>
      <div className="oobe-actions">
        <button className="secondary-button" type="button" onClick={() => void saveProgress({ step: "config", source: source || undefined, ...(source === "custom" ? { provider } : {}) }).then(() => goToStep("config")).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))}>上一步</button>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => void finish()}>暂时跳过</button>
        <button className="primary-button" type="button" disabled={busy} onClick={() => void finish()}>{busy ? "完成中…" : "完成并开始使用"}</button>
      </div>
    </>}
    </div>
    </div>
  </main>;
}
