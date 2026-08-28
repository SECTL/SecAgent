import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowRight, Check, ChevronDown, ChevronRight } from "lucide-react";
import { PresetCombobox } from "./PresetCombobox.js";
import { emptyProvider } from "../utils.js";

type SourcePath = "official" | "custom";
type OobeStep = "source" | "config" | "plugins";
type OobePageDirection = "forward" | "back";

const OOBE_STEP_ORDER: OobeStep[] = ["source", "config", "plugins"];

function latestCompatibleVersion(plugin: MarketplacePlugin | undefined, platform: NodeJS.Platform): MarketplaceVersion | undefined {
  const latest = plugin?.latest;
  return latest && latest.minHostApiVersion <= 1 && latest.platforms.includes(platform) ? latest : undefined;
}

function isClassIslandTargetReady(target: ClassIslandInstallCandidate): boolean {
  return Boolean(target.installedPluginVersion && (!target.isRunning || target.pluginHealthy === true));
}

function isSecRandomTargetReady(target: SecRandomInstallCandidate): boolean {
  return Boolean(target.installedPluginVersion);
}

function isIccceTargetReady(target: IccceInstallCandidate): boolean {
  return Boolean(target.installedPluginVersion && (!target.isRunning || target.pluginHealthy === true));
}

function companionPluginStatus(
  appName: string,
  target: { installedPluginVersion?: string; isRunning: boolean; pluginHealthy?: boolean }
): string {
  if (!target.installedPluginVersion) return `${appName} 端插件未安装`;
  if (target.isRunning && target.pluginHealthy === false) return `${appName} 端插件文件已安装，但当前进程尚未加载`;
  return `${appName} 端插件已安装 v${target.installedPluginVersion}`;
}

function companionProgressForPhase(phase: string, appName: string, percent?: number): { value: number; label: string } {
  const value = Math.max(0, Math.min(100, percent ?? ({ downloading: 18, verifying: 38, installing: 62, restarting: 80 } as Record<string, number>)[phase] ?? 0));
  switch (phase) {
    case "downloading": return { value, label: `正在下载 ${appName} 端插件…` };
    case "verifying": return { value, label: `正在校验 ${appName} 端插件…` };
    case "installing": return { value, label: `正在写入 ${appName} 端插件…` };
    case "restarting": return { value, label: `正在重启 ${appName}…` };
    default: return { value, label: `等待安装 ${appName} 端插件…` };
  }
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
  const [companionDetectionReady, setCompanionDetectionReady] = useState(false);
  const [plugins, setPlugins] = useState<PluginStatus[]>([]);
  const [marketPlugins, setMarketPlugins] = useState<MarketplacePlugin[]>([]);
  const [marketError, setMarketError] = useState("");
  const [installingId, setInstallingId] = useState("");
  const [saProgress, setSaProgress] = useState<Record<string, number>>({});
  const [batchSecAgentTargets, setBatchSecAgentTargets] = useState<Record<string, boolean>>({});
  const [batchCompanionTargets, setBatchCompanionTargets] = useState<{ classIsland?: string[]; secRandom?: string[]; iccce?: string[] }>({});
  const [classIslandTargets, setClassIslandTargets] = useState<ClassIslandInstallCandidate[]>([]);
  const [classIslandSelectedIds, setClassIslandSelectedIds] = useState<string[]>([]);
  const [classIslandTargetsExpanded, setClassIslandTargetsExpanded] = useState(true);
  const [classIslandResults, setClassIslandResults] = useState<Record<string, ClassIslandInstallResult>>({});
  const [classIslandPhase, setClassIslandPhase] = useState<ClassIslandInstallPhase | "idle">("idle");
  const [classIslandProgressPercent, setClassIslandProgressPercent] = useState(0);
  const [secRandomTargets, setSecRandomTargets] = useState<SecRandomInstallCandidate[]>([]);
  const [secRandomSelectedIds, setSecRandomSelectedIds] = useState<string[]>([]);
  const [secRandomTargetsExpanded, setSecRandomTargetsExpanded] = useState(true);
  const [secRandomResults, setSecRandomResults] = useState<Record<string, SecRandomInstallResult>>({});
  const [secRandomPhase, setSecRandomPhase] = useState<SecRandomInstallProgress["phase"] | "idle">("idle");
  const [secRandomProgressPercent, setSecRandomProgressPercent] = useState(0);
  const [iccceTargets, setIccceTargets] = useState<IccceInstallCandidate[]>([]);
  const [iccceSelectedIds, setIccceSelectedIds] = useState<string[]>([]);
  const [iccceTargetsExpanded, setIccceTargetsExpanded] = useState(true);
  const [iccceResults, setIccceResults] = useState<Record<string, IccceInstallResult>>({});
  const [icccePhase, setIcccePhase] = useState<IccceInstallProgress["phase"] | "idle">("idle");
  const [iccceProgressPercent, setIccceProgressPercent] = useState(0);
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
    // Keep the plugin list hidden until every local-app probe has settled.
    // Each probe has a safe empty fallback so one unavailable detector cannot
    // leave the OOBE spinner running forever.
    void Promise.all([
      bridge.detectInstalledApps().catch(() => [] as DetectedCompanionApp[]),
      bridge.detectClassIslandInstallations().catch(() => [] as ClassIslandInstallCandidate[]),
      bridge.detectSecRandomInstallations().catch(() => [] as SecRandomInstallCandidate[]),
      bridge.detectIccceInstallations().catch(() => [] as IccceInstallCandidate[])
    ]).then(([detectedApps, classIslandTargets, secRandomTargets, iccceTargets]) => {
      if (disposed) return;
      setApps(detectedApps);
      setClassIslandTargets(classIslandTargets);
      setClassIslandTargetsExpanded(classIslandTargets.length !== 1);
      setClassIslandSelectedIds((current) => {
        const validCurrent = current.filter((id) => classIslandTargets.some((target) => target.id === id && target.compatible));
        if (validCurrent.length) return validCurrent;
        const running = classIslandTargets.filter((target) => target.compatible && target.isRunning).map((target) => target.id);
        if (running.length) return running;
        const compatible = classIslandTargets.filter((target) => target.compatible);
        return compatible.length === 1 ? [compatible[0].id] : [];
      });
      setSecRandomTargets(secRandomTargets);
      setSecRandomTargetsExpanded(secRandomTargets.length !== 1);
      setSecRandomSelectedIds((current) => {
        const validCurrent = current.filter((id) => secRandomTargets.some((target) => target.id === id && target.compatible));
        if (validCurrent.length) return validCurrent;
        const running = secRandomTargets.filter((target) => target.compatible && target.isRunning).map((target) => target.id);
        if (running.length) return running;
        const compatible = secRandomTargets.filter((target) => target.compatible);
        return compatible.length === 1 ? [compatible[0].id] : [];
      });
      setIccceTargets(iccceTargets);
      setIccceTargetsExpanded(iccceTargets.length !== 1);
      setIccceSelectedIds((current) => {
        const validCurrent = current.filter((id) => iccceTargets.some((target) => target.id === id && target.compatible));
        if (validCurrent.length) return validCurrent;
        const running = iccceTargets.filter((target) => target.compatible && target.isRunning).map((target) => target.id);
        if (running.length) return running;
        const compatible = iccceTargets.filter((target) => target.compatible);
        return compatible.length === 1 ? [compatible[0].id] : [];
      });
    }).finally(() => {
      if (!disposed) setCompanionDetectionReady(true);
    });
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
    if (typeof progress?.percent === "number") setClassIslandProgressPercent(progress.percent);
  }), [bridge]);

  useEffect(() => bridge.onSecRandomProgress((progress) => {
    if (progress?.phase) setSecRandomPhase(progress.phase);
    if (typeof progress?.percent === "number") setSecRandomProgressPercent(progress.percent);
  }), [bridge]);

  useEffect(() => bridge.onIccceProgress((progress) => {
    if (progress?.phase) setIcccePhase(progress.phase);
    if (typeof progress?.percent === "number") setIccceProgressPercent(progress.percent);
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
    const companionPending = plugin.id === "classisland-connector"
      ? classIslandTargets.some((target) => classIslandSelectedIds.includes(target.id) && !isClassIslandTargetReady(target))
      : plugin.id === "secrandom"
        ? secRandomTargets.some((target) => secRandomSelectedIds.includes(target.id) && !isSecRandomTargetReady(target))
        : plugin.id === "iccce-connector"
          ? iccceTargets.some((target) => iccceSelectedIds.includes(target.id) && !isIccceTargetReady(target))
          : false;
    const progressCap = companionPending ? 46 : 94;
    setInstallingId(plugin.id);
    setSaProgress((current) => ({ ...current, [plugin.id]: 10 }));
    const progressTimer = window.setInterval(() => setSaProgress((current) => ({
      ...current,
      [plugin.id]: Math.min(progressCap, (current[plugin.id] || 10) + 3)
    })), 180);
    setError("");
    try {
      setPlugins(await bridge.installMarketplaceVersion(version));
      setSaProgress((current) => ({ ...current, [plugin.id]: companionPending ? 46 : 100 }));
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      window.clearInterval(progressTimer);
      setInstallingId("");
      setSaProgress((current) => {
        const next = { ...current };
        delete next[plugin.id];
        return next;
      });
    }
  };

  const pickClassIslandExecutable = async () => {
    setError("");
    try {
      const candidate = await bridge.pickClassIslandExecutable();
      if (!candidate) return;
      setClassIslandTargetsExpanded(true);
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
      setSecRandomTargetsExpanded(true);
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
      setIccceTargetsExpanded(true);
      setIccceTargets((current) => current.some((item) => item.id === candidate.id) ? current.map((item) => item.id === candidate.id ? candidate : item) : [...current, candidate]);
      if (candidate.compatible) setIccceSelectedIds((current) => current.includes(candidate.id) ? current : [...current, candidate.id]);
      if (!candidate.compatible) setError(candidate.reason || "选择的 ICC-CE 版本不兼容");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const refreshCompanionTargets = async () => {
    try {
      const [classIsland, secRandom, iccce] = await Promise.all([
        bridge.detectClassIslandInstallations(),
        bridge.detectSecRandomInstallations(),
        bridge.detectIccceInstallations()
      ]);
      const merge = <T extends { id: string }>(current: T[], refreshed: T[]): T[] => {
        if (!refreshed.length) return current;
        const currentById = new Map(current.map((target) => [target.id, target]));
        return refreshed.map((target) => currentById.get(target.id) ? { ...currentById.get(target.id), ...target } : target);
      };
      setClassIslandTargets((current) => merge(current, classIsland));
      setSecRandomTargets((current) => merge(current, secRandom));
      setIccceTargets((current) => merge(current, iccce));
    } catch {
      // The installation result is still useful if a companion is in the
      // middle of its own shutdown/startup transition.
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
    setClassIslandProgressPercent(10);
    setError("");
    try {
      const results = await bridge.installClassIslandCompanion(selectedTargets.map((target) => target.id));
      setClassIslandResults((current) => ({ ...current, ...Object.fromEntries(results.map((result) => [result.targetId, result])) }));
      setClassIslandTargets((current) => current.map((target) => {
        const result = results.find((item) => item.targetId === target.id);
        return result?.ok && result.version ? { ...target, installedPluginVersion: result.version } : target;
      }));
      await refreshCompanionTargets();
      const failures = results.filter((result) => !result.ok);
      if (failures.length) setError(failures.map((result) => result.message).join("；"));
      return failures.length === 0;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setInstallingId("");
      setClassIslandPhase("idle");
      setClassIslandProgressPercent(0);
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
    setSecRandomProgressPercent(10);
    setError("");
    try {
      const results = await bridge.installSecRandomCompanion(selectedTargets.map((target) => target.id));
      setSecRandomResults((current) => ({ ...current, ...Object.fromEntries(results.map((result) => [result.targetId, result])) }));
      setSecRandomTargets((current) => current.map((target) => {
        const result = results.find((item) => item.targetId === target.id);
        return result?.ok && result.version ? { ...target, installedPluginVersion: result.version } : target;
      }));
      await refreshCompanionTargets();
      const failures = results.filter((result) => !result.ok);
      if (failures.length) setError(failures.map((result) => result.message).join("；"));
      return failures.length === 0;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setInstallingId("");
      setSecRandomPhase("idle");
      setSecRandomProgressPercent(0);
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
    setIccceProgressPercent(10);
    setError("");
    try {
      const results = await bridge.installIccceCompanion(selectedTargets.map((target) => target.id));
      setIccceResults((current) => ({ ...current, ...Object.fromEntries(results.map((result) => [result.targetId, result])) }));
      setIccceTargets((current) => current.map((target) => {
        const result = results.find((item) => item.targetId === target.id);
        return result?.ok && result.version ? { ...target, installedPluginVersion: result.version } : target;
      }));
      await refreshCompanionTargets();
      const failures = results.filter((result) => !result.ok);
      if (failures.length) setError(failures.map((result) => result.message).join("；"));
      return failures.length === 0;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setInstallingId("");
      setIcccePhase("idle");
      setIccceProgressPercent(0);
    }
  };

  const installAllPlugins = async () => {
    if (!companionDetectionReady || installingId || allDetectedCompanionsInstalled) return;
    setError("");
    const tasks: Array<() => Promise<void>> = [];
    const batchTargets: { classIsland?: string[]; secRandom?: string[]; iccce?: string[] } = {};
    const batchSecAgentTargets: Record<string, boolean> = {};
    const classIslandMarket = marketPlugins.find((plugin) => plugin.id === "classisland-connector");
    const secRandomMarket = marketPlugins.find((plugin) => plugin.id === "secrandom");
    const iccceMarket = marketPlugins.find((plugin) => plugin.id === "iccce-connector");
    const selectedClassIslandTargets = classIslandTargets.filter((target) => classIslandSelectedIds.includes(target.id));
    const selectedSecRandomTargets = secRandomTargets.filter((target) => secRandomSelectedIds.includes(target.id));
    const selectedIccceTargets = iccceTargets.filter((target) => iccceSelectedIds.includes(target.id));
    const classIslandCompanionInstalled = selectedClassIslandTargets.length > 0 && selectedClassIslandTargets.every(isClassIslandTargetReady);
    const secRandomCompanionInstalled = selectedSecRandomTargets.length > 0 && selectedSecRandomTargets.every(isSecRandomTargetReady);
    const iccceCompanionInstalled = selectedIccceTargets.length > 0 && selectedIccceTargets.every(isIccceTargetReady);
    const installSpecial = (app: DetectedCompanionApp | undefined, pluginId: string, market: MarketplacePlugin | undefined, targetIds: string[], companionInstalled: boolean) => {
      if (!app?.detected && !targetIds.length) return;
      if (!plugins.some((plugin) => plugin.id === pluginId)) batchSecAgentTargets[pluginId] = true;
      tasks.push(async () => {
        let connectorReady = plugins.some((plugin) => plugin.id === pluginId);
        if (!connectorReady) connectorReady = await installPlugin(market);
        if (connectorReady && targetIds.length && !companionInstalled) {
          if (pluginId === "classisland-connector") batchTargets.classIsland = targetIds;
          if (pluginId === "secrandom") batchTargets.secRandom = targetIds;
          if (pluginId === "iccce-connector") batchTargets.iccce = targetIds;
        }
      });
    };
    installSpecial(apps.find((app) => app.pluginId === "classisland-connector"), "classisland-connector", classIslandMarket, classIslandSelectedIds, classIslandCompanionInstalled);
    installSpecial(apps.find((app) => app.pluginId === "secrandom"), "secrandom", secRandomMarket, secRandomSelectedIds, secRandomCompanionInstalled);
    installSpecial(apps.find((app) => app.pluginId === "iccce-connector"), "iccce-connector", iccceMarket, iccceSelectedIds, iccceCompanionInstalled);
    for (const app of apps.filter((item) => item.detected)) {
      if (app.pluginId === "classisland-connector" || app.pluginId === "secrandom" || app.pluginId === "iccce-connector") continue;
      if (plugins.some((plugin) => plugin.id === app.pluginId)) continue;
      batchSecAgentTargets[app.pluginId] = true;
      tasks.push(async () => { await installPlugin(marketPlugins.find((plugin) => plugin.id === app.pluginId)); });
    }
    if (!tasks.length) {
      setError("没有可安装的课堂联动插件，请先选择安装目标或等待检测完成");
      return;
    }
    setBatchSecAgentTargets(batchSecAgentTargets);
    for (const task of tasks) await task();
    if (!Object.values(batchTargets).some((targetIds) => targetIds?.length)) {
      setBatchSecAgentTargets({});
      return;
    }
    setInstallingId("companions:batch");
    setBatchCompanionTargets(batchTargets);
    setClassIslandPhase(batchTargets.classIsland ? "downloading" : "idle");
    setSecRandomPhase(batchTargets.secRandom ? "downloading" : "idle");
    setIcccePhase(batchTargets.iccce ? "downloading" : "idle");
    try {
      const result = await bridge.installAllCompanions(batchTargets);
      const applyResults = <T extends { targetId: string }>(
        results: T[],
        setResults: (value: (current: Record<string, T>) => Record<string, T>) => void
      ) => {
        setResults((current) => ({ ...current, ...Object.fromEntries(results.map((item) => [item.targetId, item])) }));
      };
      applyResults(result.classIsland, setClassIslandResults);
      applyResults(result.secRandom, setSecRandomResults);
      applyResults(result.iccce, setIccceResults);
      setClassIslandTargets((current) => current.map((target) => {
        const item = result.classIsland.find((candidate) => candidate.targetId === target.id);
        return item?.ok && item.version ? { ...target, installedPluginVersion: item.version } : target;
      }));
      setSecRandomTargets((current) => current.map((target) => {
        const item = result.secRandom.find((candidate) => candidate.targetId === target.id);
        return item?.ok && item.version ? { ...target, installedPluginVersion: item.version } : target;
      }));
      setIccceTargets((current) => current.map((target) => {
        const item = result.iccce.find((candidate) => candidate.targetId === target.id);
        return item?.ok && item.version ? { ...target, installedPluginVersion: item.version } : target;
      }));
      await refreshCompanionTargets();
      const failures = [...result.classIsland, ...result.secRandom, ...result.iccce].filter((item) => !item.ok);
      if (failures.length) setError(failures.map((item) => item.message).join("；"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setInstallingId("");
      setBatchSecAgentTargets({});
      setBatchCompanionTargets({});
      setClassIslandPhase("idle");
      setSecRandomPhase("idle");
      setIcccePhase("idle");
    }
  };

  const recommended = useMemo(() => apps.filter((app) => app.detected || app.pluginId === "classisland-connector" || app.pluginId === "secrandom" || app.pluginId === "iccce-connector"), [apps]);
  const allDetectedCompanionsInstalled = useMemo(() => {
    const detectedApps = apps.filter((app) => app.detected);
    if (!detectedApps.length) return false;
    return detectedApps.every((app) => {
      // "All installed" must cover both halves of a linkage: the SecAgent
      // connector and the companion application's plugin. Previously this
      // only checked the companion side, so the button could claim success
      // while the SecAgent side was unavailable.
      if (!plugins.some((plugin) => plugin.id === app.pluginId)) return false;
      if (app.pluginId === "classisland-connector") {
        const targets = classIslandTargets.filter((target) => target.compatible);
        return targets.length > 0 && targets.every(isClassIslandTargetReady);
      }
      if (app.pluginId === "secrandom") {
        const targets = secRandomTargets.filter((target) => target.compatible);
        return targets.length > 0 && targets.every(isSecRandomTargetReady);
      }
      if (app.pluginId === "iccce-connector") {
        const targets = iccceTargets.filter((target) => target.compatible);
        return targets.length > 0 && targets.every(isIccceTargetReady);
      }
      return true;
    });
  }, [apps, classIslandTargets, iccceTargets, plugins, secRandomTargets]);

  if (!settings || !progressReady) return <main className="settings-shell oobe-shell has-window-title"><p>正在读取配置…</p></main>;

  return <main className={`settings-shell oobe-shell has-window-title ${introPhase === "intro" ? "oobe-intro-active" : ""} ${bridge.platform === "darwin" ? "macos-settings" : ""} ${bridge.platform !== "darwin" ? "windows-settings" : ""}`}>
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
      {step === "plugins" ? <div className="oobe-plugin-heading"><h1>安装课堂联动插件</h1><button className="secondary-button oobe-install-all-button" type="button" disabled={!companionDetectionReady || Boolean(installingId) || busy || allDetectedCompanionsInstalled} onClick={() => void installAllPlugins()}>{!companionDetectionReady ? "检测本机应用中…" : allDetectedCompanionsInstalled ? <><Check aria-hidden="true" size={16} strokeWidth={2.5} />已安装所有</> : "一键安装所有"}</button></div> : <h1>{step === "source" ? "选择模型服务" : "配置模型服务"}</h1>}
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
      {!companionDetectionReady ? <div className="oobe-plugin-detection-loading" role="status" aria-live="polite">
        <span className="oobe-plugin-detection-spinner" aria-hidden="true" />
        <span className="visually-hidden">正在检测本机课堂软件…</span>
      </div> : <section className="oobe-plugin-list">
        <h2>本机已检测到</h2>
        {!apps.some((app) => app.detected) && <p className="empty-list">没有自动检测到已适配的课堂应用。你可以在 ClassIsland 卡片中手动选择安装位置，或稍后在设置里处理。</p>}
        {recommended.map((app, index) => {
          const market = marketPlugins.find((plugin) => plugin.id === app.pluginId);
          const installed = plugins.find((plugin) => plugin.id === app.pluginId);
          const version = latestCompatibleVersion(market, bridge.platform);
          const isClassIsland = app.pluginId === "classisland-connector";
          const isSecRandom = app.pluginId === "secrandom";
          const isIccce = app.pluginId === "iccce-connector";
          const batchCompanionInstalling = installingId === "companions:batch";
          const selectedClassIslandTargets = classIslandTargets.filter((target) => classIslandSelectedIds.includes(target.id));
          const selectedSecRandomTargets = secRandomTargets.filter((target) => secRandomSelectedIds.includes(target.id));
          const selectedIccceTargets = iccceTargets.filter((target) => iccceSelectedIds.includes(target.id));
          const companionInstalling = installingId === `${app.pluginId}:companion` || (batchCompanionInstalling && (
            (isClassIsland && Boolean(batchCompanionTargets.classIsland?.length)) ||
            (isSecRandom && Boolean(batchCompanionTargets.secRandom?.length)) ||
            (isIccce && Boolean(batchCompanionTargets.iccce?.length))
          ));
          const saInstalling = installingId === app.pluginId;
          const installing = saInstalling || companionInstalling;
          const classIslandInstalledTargetCount = selectedClassIslandTargets.filter(isClassIslandTargetReady).length;
          const classIslandCompanionInstalled = selectedClassIslandTargets.length > 0 && selectedClassIslandTargets.every(isClassIslandTargetReady);
          const classIslandCanInstall = selectedClassIslandTargets.length > 0 && selectedClassIslandTargets.every((target) => target.compatible) && !classIslandCompanionInstalled;
          const classIslandPhaseLabel = classIslandPhase === "downloading" ? "下载中…" : classIslandPhase === "verifying" ? "校验中…" : classIslandPhase === "installing" ? "安装中…" : classIslandPhase === "restarting" ? "重启中…" : "安装 ClassIsland 端插件";
          const secRandomInstalledTargetCount = selectedSecRandomTargets.filter(isSecRandomTargetReady).length;
          const secRandomCompanionInstalled = selectedSecRandomTargets.length > 0 && selectedSecRandomTargets.every(isSecRandomTargetReady);
          const secRandomCanInstall = selectedSecRandomTargets.length > 0 && selectedSecRandomTargets.every((target) => target.compatible) && !secRandomCompanionInstalled;
          const secRandomPhaseLabel = secRandomPhase === "downloading" ? "下载中…" : secRandomPhase === "verifying" ? "校验中…" : secRandomPhase === "installing" ? "安装中…" : secRandomPhase === "restarting" ? "重启中…" : "安装 SecRandom 端插件";
           const iccceInstalledTargetCount = selectedIccceTargets.filter(isIccceTargetReady).length;
           const iccceCompanionInstalled = selectedIccceTargets.length > 0 && selectedIccceTargets.every(isIccceTargetReady);
          const iccceCanInstall = selectedIccceTargets.length > 0 && selectedIccceTargets.every((target) => target.compatible) && !iccceCompanionInstalled;
          const icccePhaseLabel = icccePhase === "downloading" ? "下载中…" : icccePhase === "verifying" ? "校验中…" : icccePhase === "installing" ? "安装中…" : icccePhase === "restarting" ? "重启中…" : "安装 ICC-CE 端插件";
          const companionPhase = isClassIsland ? classIslandPhase : isSecRandom ? secRandomPhase : icccePhase;
          const companionPercent = isClassIsland ? classIslandProgressPercent : isSecRandom ? secRandomProgressPercent : iccceProgressPercent;
          const companionProgress = companionInstalling
            ? companionProgressForPhase(companionPhase, app.appName, companionPercent > 0 ? companionPercent : undefined)
            : undefined;
          const companionPending = isClassIsland
            ? selectedClassIslandTargets.length > 0 && !classIslandCompanionInstalled
            : isSecRandom
              ? selectedSecRandomTargets.length > 0 && !secRandomCompanionInstalled
              : isIccce
                ? selectedIccceTargets.length > 0 && !iccceCompanionInstalled
                : false;
          // When both halves are part of this batch, reserve 0-50% for the
          // SecAgent connector and 50-100% for the companion plugin. If only
          // one half is being installed it uses the full card background.
          const bothSidesInOperation = Boolean(batchSecAgentTargets[app.pluginId] && companionPending);
          const saProgressValue = saProgress[app.pluginId] || 10;
          const overallProgress = installing
            ? saInstalling
              ? bothSidesInOperation ? saProgressValue / 2 : saProgressValue
              : companionProgress
                ? bothSidesInOperation ? 50 + companionProgress.value / 2 : companionProgress.value
                : undefined
            : undefined;
          const cardStyle = {
            animationDelay: `${index * 70}ms`,
            ...(overallProgress !== undefined ? { "--oobe-plugin-progress": `${overallProgress}%` } : {})
          } as CSSProperties;
          return <article className={`settings-card oobe-plugin-card${isClassIsland ? " oobe-plugin-card-classisland" : isSecRandom ? " oobe-plugin-card-secrandom" : isIccce ? " oobe-plugin-card-iccce" : ""}${installing ? " is-installing" : ""}`} aria-busy={installing} style={cardStyle} key={app.pluginId}>
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
                {installed ? <span className="oobe-plugin-side-state is-installed" aria-label={`SecAgent 端已安装 v${installed.version}`} title={`SecAgent 端已安装 v${installed.version}`}><Check aria-hidden="true" size={17} strokeWidth={2.5} />已安装{installed.version ? ` v${installed.version}` : ""}</span> : market && version ? <button className="primary-button" type="button" disabled={installing} onClick={() => void installPlugin(market)}>{saInstalling ? "安装中…" : "安装 SecAgent 端插件"}</button> : <span className="oobe-plugin-side-state is-unavailable">{market?.releaseError ? "暂不可用" : "暂无可用版本"}</span>}
              </div>
              <div className="oobe-plugin-side-action">
                <span className="oobe-plugin-side-label">{app.appName} 端</span>
                {isClassIsland ? classIslandCompanionInstalled ? <span className="oobe-plugin-side-state is-installed" aria-label={`ClassIsland 端已安装 ${classIslandInstalledTargetCount}/${selectedClassIslandTargets.length}`}><Check aria-hidden="true" size={17} strokeWidth={2.5} />已安装 {classIslandInstalledTargetCount}/{selectedClassIslandTargets.length}</span> : !selectedClassIslandTargets.length ? <span className="oobe-plugin-side-state is-unavailable">未选择安装目标</span> : <button className="primary-button" type="button" disabled={installing || !classIslandCanInstall} onClick={() => void installClassIslandPlugin(market)}>{companionInstalling ? classIslandPhaseLabel : classIslandInstalledTargetCount ? "安装剩余 ClassIsland 端插件" : "安装 ClassIsland 端插件"}</button>
                  : isSecRandom ? secRandomCompanionInstalled ? <span className="oobe-plugin-side-state is-installed" aria-label={`SecRandom 端已安装 ${secRandomInstalledTargetCount}/${selectedSecRandomTargets.length}`}><Check aria-hidden="true" size={17} strokeWidth={2.5} />已安装 {secRandomInstalledTargetCount}/{selectedSecRandomTargets.length}</span> : !selectedSecRandomTargets.length ? <span className="oobe-plugin-side-state is-unavailable">未选择安装目标</span> : <button className="primary-button" type="button" disabled={installing || !secRandomCanInstall} onClick={() => void installSecRandomPlugin(market)}>{companionInstalling ? secRandomPhaseLabel : secRandomInstalledTargetCount ? "安装剩余 SecRandom 端插件" : "安装 SecRandom 端插件"}</button>
                    : iccceCompanionInstalled ? <span className="oobe-plugin-side-state is-installed" aria-label={`ICC-CE 端已安装 ${iccceInstalledTargetCount}/${selectedIccceTargets.length}`}><Check aria-hidden="true" size={17} strokeWidth={2.5} />已安装 {iccceInstalledTargetCount}/{selectedIccceTargets.length}</span> : !selectedIccceTargets.length ? <span className="oobe-plugin-side-state is-unavailable">未选择安装目标</span> : <button className="primary-button" type="button" disabled={installing || !iccceCanInstall} onClick={() => void installIcccePlugin(market)}>{companionInstalling ? icccePhaseLabel : iccceInstalledTargetCount ? "安装剩余 ICC-CE 端插件" : "安装 ICC-CE 端插件"}</button>}
              </div>
            </div> : <div className="oobe-plugin-side-actions oobe-plugin-side-actions-single">
              <span className="oobe-plugin-side-label">SecAgent 端</span>
              {installed ? <span className="oobe-plugin-side-state is-installed" aria-label={`SecAgent 端已安装 v${installed.version}`} title={`SecAgent 端已安装 v${installed.version}`}><Check aria-hidden="true" size={17} strokeWidth={2.5} />已安装{installed.version ? ` v${installed.version}` : ""}</span> : market && version ? <button className="primary-button" type="button" disabled={installing} onClick={() => void installPlugin(market)}>{saInstalling ? "安装中…" : "安装 SecAgent 端插件"}</button> : <span className="oobe-plugin-side-state is-unavailable">{market?.releaseError ? "暂不可用" : "暂无可用版本"}</span>}
            </div>}
            {isClassIsland && <div className="oobe-classisland-targets">
              <div className="oobe-classisland-target-heading">
                <button className="oobe-target-toggle" type="button" disabled={installing} aria-expanded={classIslandTargetsExpanded} aria-controls="oobe-classisland-target-list" onClick={() => setClassIslandTargetsExpanded((expanded) => !expanded)}><strong>选择 ClassIsland 安装目标</strong>{classIslandTargetsExpanded ? <ChevronDown aria-hidden="true" size={17} /> : <ChevronRight aria-hidden="true" size={17} />}</button>
                {classIslandTargetsExpanded && <button className="secondary-button" type="button" disabled={installing} onClick={() => void pickClassIslandExecutable()}>选择 ClassIsland.exe</button>}
              </div>
              {classIslandTargetsExpanded && <div id="oobe-classisland-target-list">
                {!classIslandTargets.length && <p className="empty-list">未找到 ClassIsland，可选择其可执行文件。</p>}
                {classIslandTargets.map((target) => {
                  const result = classIslandResults[target.id];
                  return <label className={`oobe-classisland-target${target.compatible ? "" : " is-incompatible"}`} key={target.id}>
                    <input type="checkbox" checked={classIslandSelectedIds.includes(target.id)} disabled={!target.compatible || installing} onChange={() => setClassIslandSelectedIds((current) => current.includes(target.id) ? current.filter((id) => id !== target.id) : [...current, target.id])} />
                    <span><strong>ClassIsland {target.version ? `v${target.version}` : "版本未知"}{target.isRunning ? " · 正在运行" : ""}</strong><small>{target.executablePath} · {companionPluginStatus("ClassIsland", target)}</small>{!target.compatible && <em>{target.reason}</em>}{result && <em className={result.ok ? "is-success" : "is-error"}>{result.message}</em>}</span>
                  </label>;
                })}
              </div>}
            </div>}
            {isSecRandom && <div className="oobe-classisland-targets">
              <div className="oobe-classisland-target-heading">
                <button className="oobe-target-toggle" type="button" disabled={installing} aria-expanded={secRandomTargetsExpanded} aria-controls="oobe-secrandom-target-list" onClick={() => setSecRandomTargetsExpanded((expanded) => !expanded)}><strong>选择 SecRandom 安装目标</strong>{secRandomTargetsExpanded ? <ChevronDown aria-hidden="true" size={17} /> : <ChevronRight aria-hidden="true" size={17} />}</button>
                {secRandomTargetsExpanded && <button className="secondary-button" type="button" disabled={installing} onClick={() => void pickSecRandomExecutable()}>选择 SecRandom 可执行文件</button>}
              </div>
              {secRandomTargetsExpanded && <div id="oobe-secrandom-target-list">
                {!secRandomTargets.length && <p className="empty-list">未找到 SecRandom，可选择其可执行文件。</p>}
                {secRandomTargets.map((target) => {
                  const result = secRandomResults[target.id];
                  return <label className={`oobe-classisland-target${target.compatible ? "" : " is-incompatible"}`} key={target.id}>
                    <input type="checkbox" checked={secRandomSelectedIds.includes(target.id)} disabled={!target.compatible || installing} onChange={() => setSecRandomSelectedIds((current) => current.includes(target.id) ? current.filter((id) => id !== target.id) : [...current, target.id])} />
                    <span><strong>SecRandom {target.version ? `v${target.version}` : "版本未知"}{target.isRunning ? " · 正在运行" : ""}</strong><small>{target.executablePath} · {companionPluginStatus("SecRandom", target)}</small>{!target.compatible && <em>{target.reason}</em>}{result && <em className={result.ok ? "is-success" : "is-error"}>{result.message}</em>}</span>
                  </label>;
                })}
              </div>}
            </div>}
            {isIccce && <div className="oobe-classisland-targets">
              <div className="oobe-classisland-target-heading">
                <button className="oobe-target-toggle" type="button" disabled={installing} aria-expanded={iccceTargetsExpanded} aria-controls="oobe-iccce-target-list" onClick={() => setIccceTargetsExpanded((expanded) => !expanded)}><strong>选择 ICC-CE 安装目标</strong>{iccceTargetsExpanded ? <ChevronDown aria-hidden="true" size={17} /> : <ChevronRight aria-hidden="true" size={17} />}</button>
                {iccceTargetsExpanded && <button className="secondary-button" type="button" disabled={installing} onClick={() => void pickIccceExecutable()}>选择 ICC-CE 可执行文件</button>}
              </div>
              {iccceTargetsExpanded && <div id="oobe-iccce-target-list">
                {!iccceTargets.length && <p className="empty-list">未找到 ICC-CE，可选择其可执行文件。</p>}
                {iccceTargets.map((target) => {
                  const result = iccceResults[target.id];
                  return <label className={`oobe-classisland-target${target.compatible ? "" : " is-incompatible"}`} key={target.id}>
                    <input type="checkbox" checked={iccceSelectedIds.includes(target.id)} disabled={!target.compatible || installing} onChange={() => setIccceSelectedIds((current) => current.includes(target.id) ? current.filter((id) => id !== target.id) : [...current, target.id])} />
                    <span><strong>ICC-CE {target.version ? `v${target.version}` : "版本未知"}{target.isRunning ? " · 正在运行" : ""}</strong><small>{target.executablePath} · {companionPluginStatus("ICC-CE", target)}</small>{!target.compatible && <em>{target.reason}</em>}{result && <em className={result.ok ? "is-success" : "is-error"}>{result.message}</em>}</span>
                  </label>;
                })}
              </div>}
            </div>}
          </article>;
        })}
      </section>}
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
