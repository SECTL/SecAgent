import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { compareVersions } from "../marketplace.js";
import { clearPendingUpdate, downloadUpdate, findLatestUpdate, pendingUpdateFile, readPendingUpdate, writePendingUpdate, type PendingUpdate } from "../update.js";
import type { UpdatePreferences, UpdateState } from "../types.js";

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
    this.state = {
      currentVersion: options.currentVersion,
      channel: this.preferences.channel,
      status: this.isSupported() ? "idle" : "unsupported",
      downloadedBytes: 0
    };
    this.loadPending();
  }

  getState(): UpdateState {
    return { ...this.state, ...(this.state.release ? { release: { ...this.state.release } } : {}) };
  }

  setPreferences(preferences: UpdatePreferences): void {
    const previousChannel = this.preferences.channel;
    this.preferences = { ...preferences };
    if (previousChannel !== this.preferences.channel) {
      if (this.pending && this.pending.channel !== this.preferences.channel) {
        clearPendingUpdate(this.pendingFile, this.pending);
        this.pending = undefined;
      }
      this.state = { currentVersion: this.state.currentVersion, channel: this.preferences.channel, status: this.isSupported() ? "idle" : "unsupported", downloadedBytes: 0 };
    } else {
      this.state.channel = this.preferences.channel;
    }
    this.publish();
  }

  async check(automatic = false): Promise<UpdateState> {
    if (!this.isSupported()) return this.getState();
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
    this.installRequested = true;
    this.state = { ...this.state, status: "installing", error: undefined };
    this.publish();
    this.options.quit();
    return this.getState();
  }

  handleBeforeQuit(): void {
    if (!this.isSupported() || this.installerLaunched || !this.pending) return;
    if (!this.installRequested && !this.preferences.autoInstallOnQuit) return;
    if (!this.isPendingValid()) {
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

  private async performCheck(automatic: boolean): Promise<UpdateState> {
    this.state = { ...this.state, status: "checking", error: undefined, downloadedBytes: 0 };
    this.publish();
    try {
      const release = await findLatestUpdate(this.preferences.channel, this.state.currentVersion);
      const checkedAt = new Date().toISOString();
      if (!release) {
        this.state = { ...this.state, release: undefined, status: this.pending ? "downloaded" : "up-to-date", downloadedVersion: this.pending?.version, checkedAt, error: undefined };
        this.publish();
        this.options.log("updates.checked", { channel: this.preferences.channel, available: false });
        return this.getState();
      }
      this.state = { ...this.state, status: this.pending?.version === release.version ? "downloaded" : "available", release, checkedAt, downloadedVersion: this.pending?.version, error: undefined, downloadedBytes: 0 };
      this.publish();
      this.options.log("updates.checked", { channel: this.preferences.channel, version: release.version, automatic });
      if (automatic && this.preferences.autoDownload && this.state.status === "available") return this.download();
      return this.getState();
    } catch (error) {
      this.state = { ...this.state, status: "error", error: error instanceof Error ? error.message : String(error) };
      this.publish();
      this.options.log("updates.check.failed", { error: this.state.error });
      return this.getState();
    }
  }

  private async performDownload(): Promise<UpdateState> {
    const release = this.state.release;
    if (!release) throw new Error("请先检查更新");
    this.state = { ...this.state, status: "downloading", downloadedBytes: 0, totalBytes: release.size, error: undefined };
    this.publish();
    try {
      const result = await downloadUpdate(release, this.cacheDirectory, undefined, (progress) => {
        this.state = { ...this.state, status: "downloading", downloadedBytes: progress.downloadedBytes, ...(progress.totalBytes ? { totalBytes: progress.totalBytes } : {}) };
        this.publish();
      });
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
    try {
      const actual = crypto.createHash("sha256").update(fs.readFileSync(this.pending.path)).digest("hex");
      return actual.toLowerCase() === this.pending.sha256.toLowerCase();
    } catch {
      return false;
    }
  }

  private publish(): void {
    this.options.publish(this.getState());
  }
}
