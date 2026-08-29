interface SessionMeta { id: string; title: string; createdAt: string; updatedAt: string }
interface ToolCallRecord { name: string; arguments: unknown; result?: unknown }
type AssistantActivity = { kind: "thinking" | "summary" | "text"; content: string; turn?: number } | { kind: "skill-auto-load"; name: string; path: string } | { kind: "tool"; name: string; arguments: unknown; result?: unknown }
interface ChatAttachment { id: string; name: string; mimeType: string; dataUrl: string; size: number }
interface SessionMessage { id: string; role: "user" | "assistant"; content: string; createdAt: string; attachments?: ChatAttachment[]; toolCalls?: ToolCallRecord[]; activities?: AssistantActivity[]; stopped?: boolean }
interface SessionData { meta: SessionMeta; messages: SessionMessage[] }
interface SessionRuntimeEvent { sessionId: string; sequence: number; at: string; stage: string; data: unknown }
type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type UpdateChannel = "stable" | "preview";
type UpdateStatus = "unsupported" | "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "installing" | "error";
interface UpdatePreferences { channel: UpdateChannel; autoCheck: boolean; autoDownload: boolean; autoInstallOnQuit: boolean }
interface UpdateRelease { version: string; tag: string; releaseType?: "alpha" | "beta"; channel: UpdateChannel; htmlUrl: string; body: string; publishedAt?: string; assetName: string; assetUrl: string; checksumUrl?: string; sha256?: string; size?: number }
interface UpdateRequestAttempt { phase: "metadata" | "release-api" | "checksum" | "asset"; route: "proxy" | "direct"; url: string; ok: boolean; status?: number; contentType?: string; responseBytes?: number; durationMs: number; error?: string }
interface UpdateState { currentVersion: string; channel: UpdateChannel; status: UpdateStatus; release?: UpdateRelease; downloadedVersion?: string; downloadedBytes: number; totalBytes?: number; checkedAt?: string; error?: string; operationId?: string; attempts?: UpdateRequestAttempt[]; supportReason?: string }
interface ModelOption { id: string; name: string; model: string; provider: string; virtual?: boolean }
interface ModelProfile { id: string; name?: string; enabled?: boolean; provider: "openai-compatible" | "openai-responses" | "anthropic" | "google"; model: string; apiKeyEnv: string; apiKey?: string; apiKeyConfigured?: boolean; baseUrl: string; endpoint?: string; anthropicVersion?: string; maxTokens?: number }
interface McpServerConfig { transport: "stdio" | "http"; command?: string; args?: string[]; url?: string; enabled: boolean }
interface ProviderModel { id: string; name?: string; enabled?: boolean }
interface ProviderConfig { id: string; name: string; preset?: string; provider: ModelProfile["provider"]; apiKeyEnv: string; apiKey?: string; apiKeyConfigured?: boolean; baseUrl: string; endpoint?: string; anthropicVersion?: string; maxTokens?: number; models: ProviderModel[] }
interface ProviderPreset { id: string; name: string; env: string[]; api: string; models: ProviderModel[] }
interface TelemetrySettings { enabled: boolean }
interface SettingsPayload { providers: ProviderConfig[]; models: ModelProfile[]; tts: { voice: string; rate: string }; wake: { hotkey: string; modelId?: string; voiceEnabled?: boolean; voicePhrase?: string }; speech: { betterRecognition?: boolean }; updates: UpdatePreferences; telemetry: TelemetrySettings; mcp: { servers: Record<string, McpServerConfig> }; defaultModelId?: string; defaultReasoningEffort?: ReasoningEffort; autostart?: boolean; autostartHidden?: boolean; customModelMode?: boolean }
interface SkillSummary { name: string; description: string; path: string }
interface PluginStatus { id: string; format?: "secagent" | "agent"; name: string; version: string; icon?: string; enabled: boolean; state: "inactive" | "starting" | "error" | "ready"; message?: string; description?: string; author?: string; repository?: string; permissions?: string[]; readme?: string; settingsPages: Array<{ id: string; title: string; description?: string }> }
interface MarketplaceVersion { version: string; minHostApiVersion: number; assetUrl: string; sha256: string; permissions: string[]; platforms: string[] }
interface MarketplacePlugin { id: string; format?: "secagent" | "agent"; name: string; description: string; repository: string; icon?: string; readme?: string; latest?: MarketplaceVersion; releaseError?: string }
interface DetectedCompanionApp { pluginId: string; appName: string; description: string; icon: string; detected: boolean; evidence?: string }
interface ClassIslandInstallCandidate { id: string; executablePath: string; rootPath: string; dataRoot: string; pluginPackagesPath: string; version?: string; installedPluginVersion?: string; pluginHealthy?: boolean; packageType?: string; isRunning: boolean; pid?: number; processIds?: number[]; launchArgs: string[]; source: string; compatible: boolean; reason?: string }
interface ClassIslandInstallResult { targetId: string; ok: boolean; action: "installed" | "already-installed" | "skipped" | "failed"; message: string; version?: string }
type ClassIslandInstallPhase = "downloading" | "verifying" | "installing" | "closing" | "restarting";
interface ClassIslandInstallProgress { phase: "downloading" | "verifying" | "installing" | "closing" | "restarting"; targetIds: string[]; percent?: number; message?: string }
interface SecRandomInstallCandidate { id: string; executablePath: string; rootPath: string; dataRoot: string; pluginPackagesPath: string; version?: string; installedPluginVersion?: string; pluginHealthy?: boolean; healthReason?: string; packageType?: string; isRunning: boolean; pid?: number; launchArgs: string[]; source: string; compatible: boolean; reason?: string }
interface SecRandomInstallResult { targetId: string; ok: boolean; action: "installed" | "already-installed" | "skipped" | "failed"; message: string; version?: string }
interface SecRandomInstallProgress { phase: "downloading" | "verifying" | "installing" | "closing" | "restarting"; targetIds: string[]; percent?: number; message?: string }
interface IccceInstallCandidate { id: string; executablePath: string; rootPath: string; pluginPackagesPath: string; pluginsPath: string; version?: string; installedPluginVersion?: string; pluginHealthy?: boolean; packageType?: string; isRunning: boolean; pid?: number; launchArgs: string[]; source: string; compatible: boolean; reason?: string }
interface IccceInstallResult { targetId: string; ok: boolean; action: "installed" | "already-installed" | "skipped" | "failed"; message: string; version?: string }
interface IccceInstallProgress { phase: "downloading" | "verifying" | "installing" | "closing" | "restarting"; targetIds: string[]; percent?: number; message?: string }
interface OobeProgress { step: "source" | "config" | "plugins"; source?: "official" | "custom"; provider?: Omit<ProviderConfig, "apiKey"> }
interface Window {
  secagent: {
    platform: NodeJS.Platform;
  telemetryConfig: { sentryDsn?: string; enabled: boolean };
    listSessions(): Promise<SessionMeta[]>;
    listModels(): Promise<ModelOption[]>;
    listProviders(): Promise<ProviderPreset[]>;
    getSettings(): Promise<SettingsPayload>;
    openSettings(): Promise<{ ok: true }>;
    getUpdateState(): Promise<UpdateState>;
    checkForUpdate(): Promise<UpdateState>;
    downloadUpdate(): Promise<UpdateState>;
    installUpdate(): Promise<UpdateState>;
    openDiagnosticLogs(): Promise<string>;
    exportDiagnosticLogs(): Promise<{ canceled: boolean; path?: string }>;
    officialStatus(): Promise<{ loggedIn: boolean; email: string }>;
    officialBalance(): Promise<{ points: number | null; balances: Array<{ points: number; expiresAt: string | null }>; expired: boolean }>;
    officialRedeem(code: string): Promise<{ pointsAdded: number; expiresAt: string | null; balance: number | null; balances: Array<{ points: number; expiresAt: string | null }> }>;
    officialOAuthLogin(): Promise<SettingsPayload>;
    officialLogout(): Promise<{ loggedIn: boolean }>;
    saveSettings(payload: SettingsPayload): Promise<SettingsPayload>;
    listSkills(): Promise<SkillSummary[]>;
    openSkillsDirectory(): Promise<string>;
    listPlugins(): Promise<PluginStatus[]>;
    callPluginSettings(pluginId: string, pageId: string, action: string, args?: unknown): Promise<any>;
    setPluginEnabled(id: string, enabled: boolean): Promise<PluginStatus[]>;
    reloadPlugin(id: string): Promise<PluginStatus[]>;
    uninstallPlugin(id: string): Promise<PluginStatus[]>;
    installPlugin(): Promise<PluginStatus[]>;
    listMarketplace(): Promise<MarketplacePlugin[]>;
    installMarketplaceVersion(version: MarketplaceVersion): Promise<PluginStatus[]>;
    updatePlugin(id: string): Promise<{ id: string; from: string; to: string; updated: boolean }>;
    detectInstalledApps(): Promise<DetectedCompanionApp[]>;
    detectClassIslandInstallations(): Promise<ClassIslandInstallCandidate[]>;
    pickClassIslandExecutable(): Promise<ClassIslandInstallCandidate | undefined>;
    installClassIslandCompanion(targetIds: string[]): Promise<ClassIslandInstallResult[]>;
    onClassIslandProgress(listener: (progress: ClassIslandInstallProgress) => void): () => void;
    detectSecRandomInstallations(): Promise<SecRandomInstallCandidate[]>;
    pickSecRandomExecutable(): Promise<SecRandomInstallCandidate | undefined>;
    installSecRandomCompanion(targetIds: string[]): Promise<SecRandomInstallResult[]>;
    onSecRandomProgress(listener: (progress: SecRandomInstallProgress) => void): () => void;
    detectIccceInstallations(): Promise<IccceInstallCandidate[]>;
    pickIccceExecutable(): Promise<IccceInstallCandidate | undefined>;
    installIccceCompanion(targetIds: string[]): Promise<IccceInstallResult[]>;
    installAllCompanions(payload: { classIsland?: string[]; secRandom?: string[]; iccce?: string[] }): Promise<{ classIsland: ClassIslandInstallResult[]; secRandom: SecRandomInstallResult[]; iccce: IccceInstallResult[] }>;
    onIccceProgress(listener: (progress: IccceInstallProgress) => void): () => void;
    getOobeProgress(): Promise<OobeProgress | undefined>;
    saveOobeProgress(progress: OobeProgress): Promise<OobeProgress | undefined>;
    openExternal(url: string): Promise<{ ok: true }>;
    completeOnboarding(): Promise<{ ok: true }>;
    createSession(): Promise<SessionData>;
    deleteSession(id: string): Promise<SessionMeta[]>;
    getSession(id: string): Promise<SessionData>;
    getRuntimeEvents(id: string): Promise<SessionRuntimeEvent[]>;
    uploadDiagnostic(id: string): Promise<{ bytes: number }>;
    previewWorkspaceFile(relativePath: string): Promise<{ ok: true }>;
    sendMessage(id: string, text: string, modelId?: string, reasoningEffort?: ReasoningEffort, attachments?: ChatAttachment[]): Promise<SessionData>;
    stopMessage(id: string): Promise<{ ok: true; stopped: boolean }>;
    onRuntimeEvent(listener: (event: unknown) => void): () => void;
    startSpeech(hotwords?: string[]): Promise<{ ok: true; remote?: boolean }>;
    startVoiceWake(phrase: string): Promise<{ ok: true }>;
    sendVoiceWakeAudio(samples: Float32Array): void;
    stopVoiceWake(): Promise<{ ok: true }>;
    logVoiceWake(event: unknown): void;
    sendSpeechAudio(samples: Float32Array): void;
    stopSpeech(): Promise<{ ok: true }>;
    cancelSpeech(): Promise<{ ok: true }>;
    synthesizeSpeech(text: string): Promise<string>;
    logWakeTts(event: unknown): void;
    setWakeContext(context: { sessionId?: string; modelId?: string; reasoningEffort?: ReasoningEffort }): void;
    closeWake(): Promise<{ ok: true }>;
    setWakeInteractive(interactive: boolean): void;
    onSpeechEvent(listener: (event: unknown) => void): () => void;
    onVoiceWakeResume(listener: () => void): () => void;
    onSettingsChanged(listener: (settings: SettingsPayload) => void): () => void;
    onUpdateState(listener: (state: UpdateState) => void): () => void;
    onPluginsChanged(listener: (plugins: PluginStatus[]) => void): () => void;
  };
}
