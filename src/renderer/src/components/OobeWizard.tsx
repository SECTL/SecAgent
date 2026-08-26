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
  const [iccceTargets, setIccceTargets] = useState<IccceInstallCandidate[]>([]);
  const [iccceSelectedIds, setIccceSelectedIds] = useState<string[]>([]);
  const [iccceResults, setIccceResults] = useState<Record<string, IccceInstallResult>>({});
  const [icccePhase, setIcccePhase] = useState<IccceInstallProgress["phase"] | "idle">("idle");
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
    void bridge.detectIccceInstallations().then((targets) => {
      if (disposed) return;
      setIccceTargets(targets);
      setIccceSelectedIds((current) => {
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

  useEffect(() => bridge.onIccceProgress((progress) => {
    if (progress?.phase) setIcccePhase(progress.phase);
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

  const installPlugin = async (plugin: MarketplacePlugin | undefined): Promise<boolean> => {
    if (!plugin) {
      setError("市场暂无兼容的 SecAgent 侧插件");
      return false;
    }
    const version = latestCompatibleVersion(plugin, bridge.platform);
    if (!version) {
      setError(`市场暂无兼容的 ${plugin.name} SecAgent 侧插件`);
      return false;
    }
    setInstallingId(plugin.id);
    setError("");
    try {
      setPlugins(await bridge.installMarketplaceVersion(version));
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
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

  const pickIccceExecutable = async () => {
    setError("");
    try {
      const candidate = await bridge.pickIccceExecutable();
      if (!candidate) return;
      setIccceTargets((current) => current.some((item) => item.id === candidate.id) ? current.map((item) => item.id === candidate.id ? candidate : item) : [...current, candidate]);
      if (candidate.compatible) setIccceSelectedIds((current) => current.includes(candidate.id) ? current : [...current, candidate.id]);
      if (!candidate.compatible) setError(candidate.reason || "选择的 ICC-CE 版本不兼容");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const installClassIslandPlugin = async (_market: MarketplacePlugin | undefined): Promise<boolean> => {
    const selectedTargets = classIslandTargets.filter((target) => classIslandSelectedIds.includes(target.id));
    if (!selectedTargets.length) {
      setError("请先选择一个或多个 ClassIsland 安装目标");
      return false;
    }
    if (selectedTargets.some((target) => !target.compatible)) {
      setError("所选 ClassIsland 版本低于 2.1.1.0，无法安装联动插件");
      return false;
    }
    setInstallingId("classisland-connector:companion");
    setClassIslandPhase("downloading");
    setError("");
    try {
      const results = await bridge.installClassIslandCompanion(selectedTargets.map((target) => target.id));
      setClassIslandResults((current) => ({ ...current, ...Object.fromEntries(results.map((result) => [result.targetId, result])) }));
      setClassIslandTargets((current) => current.map((target) => {
        const result = results.find((item) => item.targetId === target.id);
        return result?.ok && result.version ? { ...target, installedPluginVersion: result.version } : target;
      }));
      const failures = results.filter((result) => !result.ok);
      if (failures.length) setError(failures.map((result) => result.message).join("；"));
      return failures.length === 0;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setInstallingId("");
      setClassIslandPhase("idle");
    }
  };

  const installSecRandomPlugin = async (_market: MarketplacePlugin | undefined): Promise<boolean> => {
    const selectedTargets = secRandomTargets.filter((target) => secRandomSelectedIds.includes(target.id));
    if (!selectedTargets.length) {
      setError("请先选择一个或多个 SecRandom 安装目标");
      return false;
    }
    if (selectedTargets.some((target) => !target.compatible)) {
      setError("所选 SecRandom 版本低于 3.0.0-alpha.1，无法安装联动插件");
      return false;
    }
    setInstallingId("secrandom:companion");
    setSecRandomPhase("downloading");
    setError("");
    try {
      const results = await bridge.installSecRandomCompanion(selectedTargets.map((target) => target.id));
      setSecRandomResults((current) => ({ ...current, ...Object.fromEntries(results.map((result) => [result.targetId, result])) }));
      setSecRandomTargets((current) => current.map((target) => {
        const result = results.find((item) => item.targetId === target.id);
        return result?.ok && result.version ? { ...target, installedPluginVersion: result.version } : target;
      }));
      const failures = results.filter((result) => !result.ok);
      if (failures.length) setError(failures.map((result) => result.message).join("；"));
      return failures.length === 0;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setInstallingId("");
      setSecRandomPhase("idle");
    }
  };

  const installIcccePlugin = async (_market: MarketplacePlugin | undefined): Promise<boolean> => {
    const selectedTargets = iccceTargets.filter((target) => iccceSelectedIds.includes(target.id));
    if (!selectedTargets.length) {
      setError("请先选择一个或多个 ICC-CE 安装目标");
      return false;
    }
    if (selectedTargets.some((target) => !target.compatible)) {
      setError("所选 ICC-CE 安装目标不兼容");
      return false;
    }
    setInstallingId("iccce-connector:companion");
    setIcccePhase("downloading");
    setError("");
    try {
      const results = await bridge.installIccceCompanion(selectedTargets.map((target) => target.id));
      setIccceResults((current) => ({ ...current, ...Object.fromEntries(results.map((result) => [result.targetId, result])) }));
      setIccceTargets((current) => current.map((target) => {
        const result = results.find((item) => item.targetId === target.id);
        return result?.ok && result.version ? { ...target, installedPluginVersion: result.version } : target;
      }));
      const failures = results.filter((result) => !result.ok);
      if (failures.length) setError(failures.map((result) => result.message).join("；"));
      return failures.length === 0;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setInstallingId("");
      setIcccePhase("idle");
    }
  };

  const installAllPlugins = async () => {
    if (installingId) return;
    setError("");
    const tasks: Array<() => Promise<void>> = [];
    const classIslandMarket = marketPlugins.find((plugin) => plugin.id === "classisland-connector");
    const secRandomMarket = marketPlugins.find((plugin) => plugin.id === "secrandom");
    const iccceMarket = marketPlugins.find((plugin) => plugin.id === "iccce-connector");
    const selectedClassIslandTargets = classIslandTargets.filter((target) => classIslandSelectedIds.includes(target.id));
    const selectedSecRandomTargets = secRandomTargets.filter((target) => secRandomSelectedIds.includes(target.id));
    const selectedIccceTargets = iccceTargets.filter((target) => iccceSelectedIds.includes(target.id));
    const classIslandCompanionInstalled = selectedClassIslandTargets.length > 0 && selectedClassIslandTargets.every((target) => Boolean(target.installedPluginVersion));
    const secRandomCompanionInstalled = selectedSecRandomTargets.length > 0 && selectedSecRandomTargets.every((target) => Boolean(target.installedPluginVersion));
    const iccceCompanionInstalled = selectedIccceTargets.length > 0 && selectedIccceTargets.every((target) => Boolean(target.installedPluginVersion));
    const installSpecial = (app: DetectedCompanionApp | undefined, pluginId: string, market: MarketplacePlugin | undefined, targetIds: string[], companionInstalled: boolean, installCompanion: (market: MarketplacePlugin | undefined) => Promise<boolean>) => {
      if (!app?.detected && !targetIds.length) return;
      tasks.push(async () => {
        let connectorReady = plugins.some((plugin) => plugin.id === pluginId);
        if (!connectorReady) connectorReady = await installPlugin(market);
        if (connectorReady && targetIds.length && !companionInstalled) await installCompanion(market);
      });
    };
    installSpecial(apps.find((app) => app.pluginId === "classisland-connector"), "classisland-connector", classIslandMarket, classIslandSelectedIds, classIslandCompanionInstalled, installClassIslandPlugin);
    installSpecial(apps.find((app) => app.pluginId === "secrandom"), "secrandom", secRandomMarket, secRandomSelectedIds, secRandomCompanionInstalled, installSecRandomPlugin);
    installSpecial(apps.find((app) => app.pluginId === "iccce-connector"), "iccce-connector", iccceMarket, iccceSelectedIds, iccceCompanionInstalled, installIcccePlugin);
    for (const app of apps.filter((item) => item.detected)) {
      if (app.pluginId === "classisland-connector" || app.pluginId === "secrandom" || app.pluginId === "iccce-connector") continue;
      if (plugins.some((plugin) => plugin.id === app.pluginId)) continue;
      tasks.push(async () => { await installPlugin(marketPlugins.find((plugin) => plugin.id === app.pluginId)); });
    }
    if (!tasks.length) {
      setError("没有可安装的课堂联动插件，请先选择安装目标或等待检测完成");
      return;
    }
    for (const task of tasks) await task();
  };

  const recommended = useMemo(() => apps.filter((app) => app.detected || app.pluginId === "classisland-connector" || app.pluginId === "secrandom" || app.pluginId === "iccce-connector"), [apps]);

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
      {step === "plugins" ? <div className="oobe-plugin-heading"><h1>安装课堂联动插件</h1><button className="secondary-button oobe-install-all-button" type="button" disabled={Boolean(installingId) || busy} onClick={() => void installAllPlugins()}>一键安装所有</button></div> : <h1>{step === "source" ? "选择模型服务" : "配置模型服务"}</h1>}
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
          const isClassIsland = app.pluginId === "classisland-connector";
          const isSecRandom = app.pluginId === "secrandom";
          const isIccce = app.pluginId === "iccce-connector";
          const companionInstalling = installingId === `${app.pluginId}:companion`;
          const saInstalling = installingId === app.pluginId;
          const installing = saInstalling || companionInstalling;
          const selectedClassIslandTargets = classIslandTargets.filter((target) => classIslandSelectedIds.includes(target.id));
          const classIslandInstalledTargetCount = selectedClassIslandTargets.filter((target) => Boolean(target.installedPluginVersion)).length;
          const classIslandCompanionInstalled = selectedClassIslandTargets.length > 0 && selectedClassIslandTargets.every((target) => Boolean(target.installedPluginVersion));
          const classIslandCanInstall = selectedClassIslandTargets.length > 0 && selectedClassIslandTargets.every((target) => target.compatible) && !classIslandCompanionInstalled;
          const classIslandPhaseLabel = classIslandPhase === "downloading" ? "下载中…" : classIslandPhase === "verifying" ? "校验中…" : classIslandPhase === "installing" ? "安装中…" : classIslandPhase === "restarting" ? "重启中…" : "安装 ClassIsland 端插件";
          const selectedSecRandomTargets = secRandomTargets.filter((target) => secRandomSelectedIds.includes(target.id));
          const secRandomInstalledTargetCount = selectedSecRandomTargets.filter((target) => Boolean(target.installedPluginVersion)).length;
          const secRandomCompanionInstalled = selectedSecRandomTargets.length > 0 && selectedSecRandomTargets.every((target) => Boolean(target.installedPluginVersion));
          const secRandomCanInstall = selectedSecRandomTargets.length > 0 && selectedSecRandomTargets.every((target) => target.compatible) && !secRandomCompanionInstalled;
          const secRandomPhaseLabel = secRandomPhase === "downloading" ? "下载中…" : secRandomPhase === "verifying" ? "校验中…" : secRandomPhase === "installing" ? "安装中…" : secRandomPhase === "restarting" ? "重启中…" : "安装 SecRandom 端插件";
          const selectedIccceTargets = iccceTargets.filter((target) => iccceSelectedIds.includes(target.id));
          const iccceInstalledTargetCount = selectedIccceTargets.filter((target) => Boolean(target.installedPluginVersion)).length;
          const iccceCompanionInstalled = selectedIccceTargets.length > 0 && selectedIccceTargets.every((target) => Boolean(target.installedPluginVersion));
          const iccceCanInstall = selectedIccceTargets.length > 0 && selectedIccceTargets.every((target) => target.compatible) && !iccceCompanionInstalled;
          const icccePhaseLabel = icccePhase === "downloading" ? "下载中…" : icccePhase === "verifying" ? "校验中…" : icccePhase === "installing" ? "安装中…" : icccePhase === "restarting" ? "重启中…" : "安装 ICC-CE 端插件";
          return <article className={`settings-card oobe-plugin-card${isClassIsland ? " oobe-plugin-card-classisland" : isSecRandom ? " oobe-plugin-card-secrandom" : isIccce ? " oobe-plugin-card-iccce" : ""}${installing ? " is-installing" : ""}`} aria-busy={installing} style={{ animationDelay: `${index * 70}ms` }} key={app.pluginId}>
            <div className="oobe-plugin-main">
              <span className={`oobe-plugin-icon${installed?.icon ? " has-plugin-icon" : ""}`} aria-hidden="true">
                <img className="oobe-plugin-icon-app" src={app.icon} alt="" />
                {installed?.icon && <img className="oobe-plugin-icon-plugin" key={installed.icon} src={installed.icon} alt="" />}
              </span>
              <div className="oobe-plugin-copy">
                <strong>{app.appName}</strong>
                <span>{isClassIsland ? `${classIslandTargets.length ? app.description : "未自动找到安装目录，可手动选择"} · 需要配置两端插件` : isSecRandom ? `${secRandomTargets.length ? app.description : "未自动找到安装目录，可手动选择"} · 需要配置两端插件` : isIccce ? `${iccceTargets.length ? app.description : "未自动找到安装目录，可手动选择"} · 需要配置两端插件` : `${app.description} · 已在本机找到`}</span>
              </div>
            </div>
            {(isClassIsland || isSecRandom || isIccce) ? <div className="oobe-plugin-side-actions oobe-plugin-side-actions-dual">
              <div className="oobe-plugin-side-action">
                <span className="oobe-plugin-side-label">SecAgent 端</span>
                {installed ? <span className="oobe-plugin-side-state is-installed" aria-label={`SecAgent 端已安装 v${installed.version}`} title={`SecAgent 端已安装 v${installed.version}`}><Check aria-hidden="true" size={17} strokeWidth={2.5} />已安装{installed.version ? ` v${installed.version}` : ""}</span> : market && version ? <button className="primary-button" type="button" disabled={installing} onClick={() => void installPlugin(market)}>{saInstalling ? "安装中…" : "安装 SecAgent 端插件"}</button> : <span className="oobe-plugin-side-state is-unavailable">暂无可用版本</span>}
              </div>
              <div className="oobe-plugin-side-action">
                <span className="oobe-plugin-side-label">{app.appName} 端</span>
                {isClassIsland ? classIslandCompanionInstalled ? <span className="oobe-plugin-side-state is-installed" aria-label={`ClassIsland 端已安装 ${classIslandInstalledTargetCount}/${selectedClassIslandTargets.length}`}><Check aria-hidden="true" size={17} strokeWidth={2.5} />已安装 {classIslandInstalledTargetCount}/{selectedClassIslandTargets.length}</span> : !selectedClassIslandTargets.length ? <span className="oobe-plugin-side-state is-unavailable">未选择安装目标</span> : <button className="primary-button" type="button" disabled={installing || !classIslandCanInstall} onClick={() => void installClassIslandPlugin(market)}>{companionInstalling ? classIslandPhaseLabel : classIslandInstalledTargetCount ? "安装剩余 ClassIsland 端插件" : "安装 ClassIsland 端插件"}</button>
                  : isSecRandom ? secRandomCompanionInstalled ? <span className="oobe-plugin-side-state is-installed" aria-label={`SecRandom 端已安装 ${secRandomInstalledTargetCount}/${selectedSecRandomTargets.length}`}><Check aria-hidden="true" size={17} strokeWidth={2.5} />已安装 {secRandomInstalledTargetCount}/{selectedSecRandomTargets.length}</span> : !selectedSecRandomTargets.length ? <span className="oobe-plugin-side-state is-unavailable">未选择安装目标</span> : <button className="primary-button" type="button" disabled={installing || !secRandomCanInstall} onClick={() => void installSecRandomPlugin(market)}>{companionInstalling ? secRandomPhaseLabel : secRandomInstalledTargetCount ? "安装剩余 SecRandom 端插件" : "安装 SecRandom 端插件"}</button>
                    : iccceCompanionInstalled ? <span className="oobe-plugin-side-state is-installed" aria-label={`ICC-CE 端已安装 ${iccceInstalledTargetCount}/${selectedIccceTargets.length}`}><Check aria-hidden="true" size={17} strokeWidth={2.5} />已安装 {iccceInstalledTargetCount}/{selectedIccceTargets.length}</span> : !selectedIccceTargets.length ? <span className="oobe-plugin-side-state is-unavailable">未选择安装目标</span> : <button className="primary-button" type="button" disabled={installing || !iccceCanInstall} onClick={() => void installIcccePlugin(market)}>{companionInstalling ? icccePhaseLabel : iccceInstalledTargetCount ? "安装剩余 ICC-CE 端插件" : "安装 ICC-CE 端插件"}</button>}
              </div>
            </div> : <div className="oobe-plugin-side-actions oobe-plugin-side-actions-single">
              <span className="oobe-plugin-side-label">SecAgent 端</span>
              {installed ? <span className="oobe-plugin-side-state is-installed" aria-label={`SecAgent 端已安装 v${installed.version}`} title={`SecAgent 端已安装 v${installed.version}`}><Check aria-hidden="true" size={17} strokeWidth={2.5} />已安装{installed.version ? ` v${installed.version}` : ""}</span> : market && version ? <button className="primary-button" type="button" disabled={installing} onClick={() => void installPlugin(market)}>{saInstalling ? "安装中…" : "安装 SecAgent 端插件"}</button> : <span className="oobe-plugin-side-state is-unavailable">暂无可用版本</span>}
            </div>}
            {isClassIsland && <div className="oobe-classisland-targets">
              <div className="oobe-classisland-target-heading"><strong>选择 ClassIsland 安装目标</strong><button className="secondary-button" type="button" disabled={installing} onClick={() => void pickClassIslandExecutable()}>选择 ClassIsland.exe</button></div>
              {!classIslandTargets.length && <p className="empty-list">未找到 ClassIsland，可选择其可执行文件。</p>}
              {classIslandTargets.map((target) => {
                const result = classIslandResults[target.id];
                return <label className={`oobe-classisland-target${target.compatible ? "" : " is-incompatible"}`} key={target.id}>
                  <input type="checkbox" checked={classIslandSelectedIds.includes(target.id)} disabled={!target.compatible || installing} onChange={() => setClassIslandSelectedIds((current) => current.includes(target.id) ? current.filter((id) => id !== target.id) : [...current, target.id])} />
                  <span><strong>ClassIsland {target.version ? `v${target.version}` : "版本未知"}{target.isRunning ? " · 正在运行" : ""}</strong><small>{target.executablePath} · {target.installedPluginVersion ? `ClassIsland 端插件已安装 v${target.installedPluginVersion}` : "ClassIsland 端插件未安装"}</small>{!target.compatible && <em>{target.reason}</em>}{result && <em className={result.ok ? "is-success" : "is-error"}>{result.message}</em>}</span>
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
                  <span><strong>SecRandom {target.version ? `v${target.version}` : "版本未知"}{target.isRunning ? " · 正在运行" : ""}</strong><small>{target.executablePath} · {target.installedPluginVersion ? `SecRandom 端插件已安装 v${target.installedPluginVersion}` : "SecRandom 端插件未安装"}</small>{!target.compatible && <em>{target.reason}</em>}{result && <em className={result.ok ? "is-success" : "is-error"}>{result.message}</em>}</span>
                </label>;
              })}
            </div>}
            {isIccce && <div className="oobe-classisland-targets">
              <div className="oobe-classisland-target-heading"><strong>选择 ICC-CE 安装目标</strong><button className="secondary-button" type="button" disabled={installing} onClick={() => void pickIccceExecutable()}>选择 ICC-CE 可执行文件</button></div>
              {!iccceTargets.length && <p className="empty-list">未找到 ICC-CE，可选择其可执行文件。</p>}
              {iccceTargets.map((target) => {
                const result = iccceResults[target.id];
                return <label className={`oobe-classisland-target${target.compatible ? "" : " is-incompatible"}`} key={target.id}>
                  <input type="checkbox" checked={iccceSelectedIds.includes(target.id)} disabled={!target.compatible || installing} onChange={() => setIccceSelectedIds((current) => current.includes(target.id) ? current.filter((id) => id !== target.id) : [...current, target.id])} />
                  <span><strong>ICC-CE {target.version ? `v${target.version}` : "版本未知"}{target.isRunning ? " · 正在运行" : ""}</strong><small>{target.executablePath} · {target.installedPluginVersion ? `ICC-CE 端插件已安装 v${target.installedPluginVersion}` : "ICC-CE 端插件未安装"}</small>{!target.compatible && <em>{target.reason}</em>}{result && <em className={result.ok ? "is-success" : "is-error"}>{result.message}</em>}</span>
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
