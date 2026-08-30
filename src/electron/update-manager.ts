import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { compareVersions } from "../marketplace.js";
import { clearPendingUpdate, downloadUpdate, findLatestUpdate, pendingUpdateFile, readPendingUpdate, writePendingUpdate, type PendingUpdate, type UpdateRequestHooks } from "../update.js";
import type { UpdatePreferences, UpdateRequestAttempt, UpdateState } from "../types.js";

export interface WindowsUpdateManagerOptions {
  currentVersion: string;
  preferences: UpdatePreferences;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  storageDirectory: string;
  publish: (state: UpdateState) => void;
  quit: () => void;
  launchInstaller: (installerPath: string) => void;
  log: (stage: string, data?: unknown) => void;
}

export class WindowsUpdateManager {
  private readonly pendingFile: string;
  private readonly cacheDirectory: string;
  private readonly options: WindowsUpdateManagerOptions;
  private preferences: UpdatePreferences;
  private pending?: PendingUpdate;
  private state: UpdateState;
  private checkPromise?: Promise<UpdateState>;
  private downloadPromise?: Promise<UpdateState>;
  private installRequested = false;
  private installerLaunched = false;

  constructor(options: WindowsUpdateManagerOptions) {
    this.options = options;
    this.preferences = { ...options.preferences };
    this.cacheDirectory = path.join(options.storageDirectory, "updates");
    this.pendingFile = pendingUpdateFile(this.cacheDirectory);
    const supportReason = this.isSupported() ? undefined : this.unsupportedReason();
    this.state = {
      currentVersion: options.currentVersion,
      channel: this.preferences.channel,
      status: this.isSupported() ? "idle" : "unsupported",
      downloadedBytes: 0,
      ...(supportReason ? { error: supportReason, supportReason } : {})
    };
    this.loadPending();
  }

  getState(): UpdateState {
    return {
      ...this.state,
      ...(this.state.release ? { release: { ...this.state.release } } : {}),
      ...(this.state.attempts ? { attempts: this.state.attempts.map((attempt) => ({ ...attempt })) } : {})
    };
  }

  setPreferences(preferences: UpdatePreferences): void {
    const previousChannel = this.preferences.channel;
    this.preferences = { ...preferences };
    if (previousChannel !== this.preferences.channel) {
      if (this.pending && this.pending.channel !== this.preferences.channel) {
        clearPendingUpdate(this.pendingFile, this.pending);
        this.pending = undefined;
      }
      const supportReason = this.isSupported() ? undefined : this.unsupportedReason();
      this.state = { currentVersion: this.state.currentVersion, channel: this.preferences.channel, status: this.isSupported() ? "idle" : "unsupported", downloadedBytes: 0, ...(supportReason ? { error: supportReason, supportReason } : {}) };
    } else {
      this.state.channel = this.preferences.channel;
    }
    this.publish();
  }

  async check(automatic = false): Promise<UpdateState> {
    if (!this.isSupported()) {
      const reason = this.unsupportedReason();
      this.state = { ...this.state, status: "unsupported", error: reason, supportReason: reason };
      this.options.log("updates.check.unsupported", { platform: this.options.platform, isPackaged: this.options.isPackaged, reason });
      this.publish();
      return this.getState();
    }
    if (automatic && !this.preferences.autoCheck) return this.getState();
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = this.performCheck(automatic).finally(() => { this.checkPromise = undefined; });
    return this.checkPromise;
  }

  async download(): Promise<UpdateState> {
    if (!this.isSupported()) return this.getState();
    if (!this.state.release) throw new Error("请先检查更新");
    if (this.downloadPromise) return this.downloadPromise;
    this.downloadPromise = this.performDownload().finally(() => { this.downloadPromise = undefined; });
    return this.downloadPromise;
  }

  install(): UpdateState {
    if (!this.isSupported()) return this.getState();
    if (!this.pending || !fs.existsSync(this.pending.path)) throw new Error("没有可安装的更新");
    if (this.installRequested || this.installerLaunched) {
      this.options.log("updates.install.skipped", { reason: "already-requested", version: this.pending.version });
      return this.getState();
    }
    this.installRequested = true;
    this.state = { ...this.state, status: "installing", error: undefined };
    this.publish();
    this.options.quit();
    return this.getState();
  }

  handleBeforeQuit(): void {
    if (!this.isSupported() || this.installerLaunched || !this.pending) return;
    if (!this.installRequested && !this.preferences.autoInstallOnQuit) return;
    // Must stay fast: this runs inside before-quit while the window is going
    // away. Hashing the 200MB+ installer here froze the UI for seconds, so
    // verification relies on the checksum recorded at download time; a pending
    // entry without one (legacy file) is re-hashed in the background by
    // verifyPendingChecksum() and simply skips the size check here.
    if (this.pending.verifiedSha256 && this.pending.verifiedSha256 !== this.pending.sha256) {
      this.options.log("updates.install.skipped", { reason: "pending installer checksum failed" });
      clearPendingUpdate(this.pendingFile, this.pending);
      this.pending = undefined;
      return;
    }
    try {
      this.options.launchInstaller(this.pending.path);
      this.installerLaunched = true;
      this.state = { ...this.state, status: "installing", error: undefined };
      this.publish();
      this.options.log("updates.install.started", { version: this.pending.version, path: this.pending.path });
    } catch (error) {
      this.state = { ...this.state, status: "error", error: error instanceof Error ? error.message : String(error) };
      this.publish();
      this.options.log("updates.install.failed", { error: this.state.error });
    }
  }

  /** True when a downloaded installer is waiting to be installed. Used by the
   *  autostart launch path to install before showing the app. */
  hasPendingInstall(): boolean {
    return this.isSupported() && !!this.pending && fs.existsSync(this.pending.path);
  }

  /** Recompute the pending file's checksum off the quit path (streamed) and
   *  persist it. Called opportunistically at startup for pending entries
   *  written by older versions without a recorded checksum. */
  async verifyPendingChecksum(): Promise<boolean> {
    const pending = this.pending;
    if (!pending || !fs.existsSync(pending.path)) return false;
    if (pending.verifiedSha256 === pending.sha256) return true;
    try {
      const hash = crypto.createHash("sha256");
      await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(pending.path);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve());
      });
      const actual = hash.digest("hex").toLowerCase();
      if (actual !== pending.sha256.toLowerCase()) {
        this.options.log("updates.pending.checksum.failed", { version: pending.version });
        clearPendingUpdate(this.pendingFile, pending);
        this.pending = undefined;
        this.publish();
        return false;
      }
      pending.verifiedSha256 = actual;
      writePendingUpdate(this.pendingFile, pending);
      return true;
    } catch {
      return false;
    }
  }

  private async performCheck(automatic: boolean): Promise<UpdateState> {
    const operationId = crypto.randomUUID();
    this.state = { ...this.state, status: "checking", error: undefined, supportReason: undefined, downloadedBytes: 0, operationId, attempts: [] };
    this.publish();
    this.options.log("updates.check.started", {
      operationId,
      automatic,
      currentVersion: this.state.currentVersion,
      channel: this.preferences.channel,
      platform: this.options.platform,
      arch: process.arch,
      isPackaged: this.options.isPackaged
    });
    const hooks: UpdateRequestHooks = {
      onAttempt: (attempt) => this.recordAttempt(operationId, attempt),
      onEvent: (event) => this.options.log(`updates.${event.name}`, { operationId, ...(event.data || {}) })
    };
    try {
      const release = await findLatestUpdate(this.preferences.channel, this.state.currentVersion, undefined, hooks);
      const checkedAt = new Date().toISOString();
      if (!release) {
        this.state = { ...this.state, release: undefined, status: this.pending ? "downloaded" : "up-to-date", downloadedVersion: this.pending?.version, checkedAt, error: undefined };
        this.publish();
        this.options.log("updates.checked", { operationId, channel: this.preferences.channel, available: false, attempts: this.state.attempts?.length || 0 });
        return this.getState();
      }
      this.state = { ...this.state, status: this.pending?.version === release.version ? "downloaded" : "available", release, checkedAt, downloadedVersion: this.pending?.version, error: undefined, downloadedBytes: 0 };
      this.publish();
      this.options.log("updates.checked", { operationId, channel: this.preferences.channel, version: release.version, automatic, attempts: this.state.attempts?.length || 0 });
      if (automatic && this.preferences.autoDownload && this.state.status === "available") return this.download();
      return this.getState();
    } catch (error) {
      const message = this.formatCheckError(error);
      this.state = { ...this.state, status: "error", error: message };
      this.publish();
      this.options.log("updates.check.failed", { operationId, error: message, attempts: this.state.attempts?.length || 0 });
      return this.getState();
    }
  }

  private async performDownload(): Promise<UpdateState> {
    const release = this.state.release;
    if (!release) throw new Error("请先检查更新");
    const operationId = this.state.operationId || crypto.randomUUID();
    this.state = { ...this.state, status: "downloading", downloadedBytes: 0, totalBytes: release.size, error: undefined, operationId, attempts: [] };
    this.publish();
    this.options.log("updates.download.started", { operationId, version: release.version, channel: release.channel, assetName: release.assetName });
    const hooks: UpdateRequestHooks = {
      onAttempt: (attempt) => this.recordAttempt(operationId, attempt),
      onEvent: (event) => this.options.log(`updates.${event.name}`, { operationId, ...(event.data || {}) })
    };
    try {
      const result = await downloadUpdate(release, this.cacheDirectory, undefined, (progress) => {
        this.state = { ...this.state, status: "downloading", downloadedBytes: progress.downloadedBytes, ...(progress.totalBytes ? { totalBytes: progress.totalBytes } : {}) };
        this.publish();
      }, hooks);
      this.pending = result.pending;
      writePendingUpdate(this.pendingFile, this.pending);
      this.state = { ...this.state, status: "downloaded", downloadedVersion: release.version, downloadedBytes: result.bytes, totalBytes: result.bytes, error: undefined };
      this.publish();
      this.options.log("updates.downloaded", { version: release.version, bytes: result.bytes });
      return this.getState();
    } catch (error) {
      this.state = { ...this.state, status: "error", error: error instanceof Error ? error.message : String(error) };
      this.publish();
      this.options.log("updates.download.failed", { error: this.state.error });
      return this.getState();
    }
  }

  private recordAttempt(operationId: string, attempt: UpdateRequestAttempt): void {
    const attempts = [...(this.state.attempts || []), attempt];
    this.state = { ...this.state, operationId, attempts };
    this.options.log("updates.request.attempt", { operationId, ...attempt });
    this.publish();
  }

  private unsupportedReason(): string {
    if (this.options.platform !== "win32") return "应用内更新目前仅支持 Windows。";
    if (!this.options.isPackaged) return "当前运行的是开发版本，打包安装版才支持应用内更新。";
    return "当前环境不支持应用内更新。";
  }

  private formatCheckError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (/HTTP 403/.test(message)) return "GitHub 暂时拒绝了更新检查（HTTP 403），请稍后重试或检查网络。";
    if (/HTTP 404/.test(message)) return "没有找到更新清单或 Release，请稍后重试。";
    if (/timeout|timed out|abort/i.test(message)) return "更新检查超时，请检查网络后重试。";
    return message || "更新检查失败，请查看诊断日志。";
  }

  private loadPending(): void {
    const pending = readPendingUpdate(this.pendingFile);
    if (!pending || !fs.existsSync(pending.path) || pending.channel !== this.preferences.channel || compareVersions(pending.version, this.state.currentVersion) <= 0) {
      if (pending) clearPendingUpdate(this.pendingFile, pending);
      return;
    }
    this.pending = pending;
    this.state = { ...this.state, status: this.isSupported() ? "downloaded" : "unsupported", downloadedVersion: pending.version };
  }

  private isSupported(): boolean {
    return this.options.platform === "win32" && this.options.isPackaged;
  }

  private isPendingValid(): boolean {
    if (!this.pending || !fs.existsSync(this.pending.path)) return false;
    // Fast path: trust the checksum recorded at download time. Legacy pending
    // files without a recorded checksum are validated by verifyPendingChecksum()
    // at startup; until then treat them as valid (the file was verified when it
    // was downloaded in that same session).
    if (!this.pending.verifiedSha256) return true;
    return this.pending.verifiedSha256.toLowerCase() === this.pending.sha256.toLowerCase();
  }

  private publish(): void {
    this.options.publish(this.getState());
  }
}
