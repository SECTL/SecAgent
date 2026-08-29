import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginManager } from "./plugin-manager.js";

export interface MarketplaceVersion {
  version: string;
  minHostApiVersion: number;
  assetUrl: string;
  sha256: string;
  permissions: string[];
  platforms: string[];
}

export interface MarketplacePlugin {
  id: string;
  format?: "secagent" | "agent";
  name: string;
  description: string;
  repository: string;
  icon?: string;
  readme?: string;
  latest?: MarketplaceVersion;
  releaseError?: string;
}

export interface MarketplacePluginReference {
  id: string;
  path: string;
  sha256: string;
  /** Release metadata resolved by the signed marketplace generator. */
  latest?: MarketplaceVersion;
}

export interface MarketplaceIndex {
  schemaVersion: 2;
  generatedAt: string;
  plugins: MarketplacePluginReference[];
  signature: string;
}

export interface MarketplaceReleaseSpec {
  provider: "github";
  owner: string;
  repo: string;
  assetName: string;
  includePrerelease?: boolean;
}

export interface MarketplacePluginMetadata {
  schemaVersion: 1;
  id: string;
  format?: "secagent" | "agent";
  name: string;
  description: string;
  repository: string;
  icon?: string;
  readme?: string;
  minHostApiVersion: number;
  permissions: string[];
  platforms: string[];
  release: MarketplaceReleaseSpec;
}

export interface MarketplaceUpdate { id: string; from: string; to: string }

export interface MarketplaceUpdateCandidate extends MarketplaceUpdate {
  /** Resolved release entry from the signed index, ready to install. */
  version: MarketplaceVersion;
}

export interface MarketplaceUpdateResult {
  updates: MarketplaceUpdate[];
  /** Per-plugin failures; one bad asset no longer aborts the whole round. */
  errors: Array<{ id: string; error: string }>;
}

type MarketplaceFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** The official market trust root. Rotate this with a matching signed index. */
export const OFFICIAL_MARKETPLACE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAVDhccL78MVtRDCXjUXiYRwdXhnCJDCAvyDsQduJdC8s=
-----END PUBLIC KEY-----`;
export const DEFAULT_MARKETPLACE_INDEX_URL = "https://raw.githubusercontent.com/SECTL/secagent-plugin-marketplace/refs/heads/main/index.json";
export const DEFAULT_MARKETPLACE_PROXY_URL = "https://ghproxy.sectl.cn";
const HOST_API_VERSION = 1;
const RELEASE_CACHE_TTL_MS = 10 * 60 * 1000;

interface GithubReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
  digest?: unknown;
}

interface GithubRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
}

interface CachedRelease {
  expiresAt: number;
  result: MarketplaceVersion | undefined;
  error?: string;
}

/** Fetches the signed marketplace index and installs release assets after SHA-256 verification. */
export class MarketplaceClient {
  private readonly releaseCache = new Map<string, CachedRelease>();
  private readonly releaseRequests = new Map<string, Promise<CachedRelease>>();
  private updateOperation: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly indexUrl = process.env.SECAGENT_PLUGIN_MARKET_URL || DEFAULT_MARKETPLACE_INDEX_URL,
    private readonly publicKey = OFFICIAL_MARKETPLACE_PUBLIC_KEY,
    private readonly fetcher: MarketplaceFetch = fetch
  ) {}

  async list(): Promise<MarketplacePlugin[]> {
    const index = await this.fetchVerifiedIndex();
    const metadata = await Promise.all(index.plugins.map(async (reference) => ({
      reference,
      plugin: await this.fetchPluginMetadata(reference)
    })));
    const compatible = metadata.filter(({ plugin }) => isCompatibleMetadata(plugin));

    return Promise.all(compatible.map(async ({ reference, plugin }) => {
      const base: MarketplacePlugin = {
        id: plugin.id,
        format: plugin.format,
        name: plugin.name,
        description: plugin.description,
        repository: plugin.repository,
        icon: plugin.icon,
        readme: await resolveMarketplaceReadme(plugin.readme, this.fetcher)
      };

      try {
        // New indexes carry the resolved release inside the signed index. This keeps
        // normal clients independent from GitHub's unauthenticated API quota. Keep
        // the old resolver as a compatibility fallback for older indexes.
        const latest = reference.latest
          ? validateMarketplaceVersion(reference.latest)
          : await this.resolveRelease(plugin);
        return latest ? { ...base, latest } : { ...base, releaseError: "暂无可用 Release" };
      } catch (error) {
        return { ...base, releaseError: error instanceof Error ? error.message : String(error) };
      }
    }));
  }

  async install(manager: PluginManager, version: MarketplaceVersion): Promise<void> {
    if (!isAllowedMarketUrl(version.assetUrl) || !/^[a-fA-F0-9]{64}$/.test(version.sha256)) {
      throw new Error("市场插件资产信息无效");
    }
    const bytes = await downloadMarketplaceAsset(version.assetUrl, version.sha256, this.fetcher);
    const temporary = path.join(os.tmpdir(), `secagent-plugin-${crypto.randomUUID()}.zip`);
    try {
      fs.writeFileSync(temporary, bytes);
      await manager.install(temporary);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  /**
   * Lightweight update check for the background poll: reads only the signed
   * index (one request) instead of the full catalog, keeping a 10-minute
   * cadence friendly to the shared proxy. References without embedded release
   * data (older indexes) are skipped; the market tab still resolves those via
   * {@link list}.
   */
  async checkUpdates(installed: Array<{ id: string; version: string }>): Promise<MarketplaceUpdateCandidate[]> {
    const index = await this.fetchVerifiedIndex();
    const candidates: MarketplaceUpdateCandidate[] = [];
    for (const entry of installed) {
      const reference = index.plugins.find((candidate) => candidate.id === entry.id);
      if (!reference?.latest) continue;
      let latest: MarketplaceVersion;
      try {
        latest = validateMarketplaceVersion(reference.latest);
      } catch {
        continue;
      }
      if (!isCompatibleVersion(latest) || compareVersions(latest.version, entry.version) <= 0) continue;
      candidates.push({ id: entry.id, from: entry.version, to: latest.version, version: latest });
    }
    return candidates;
  }

  /** Hot-swaps every installed plugin that lags behind the signed index. */
  async installUpdates(manager: PluginManager): Promise<MarketplaceUpdateResult> {
    return this.runUpdateOperation(async () => {
      const candidates = await this.checkUpdates(manager.list());
      const updates: MarketplaceUpdate[] = [];
      const errors: MarketplaceUpdateResult["errors"] = [];
      // Sequential on purpose: the shared proxy is rate limited, so plugins
      // download one at a time.
      for (const candidate of candidates) {
        try {
          await this.install(manager, candidate.version);
          updates.push({ id: candidate.id, from: candidate.from, to: candidate.to });
        } catch (error) {
          errors.push({ id: candidate.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { updates, errors };
    });
  }

  /**
   * Single-plugin variant for the manual "check for updates" action. Returns
   * {@link updated} false when the plugin already matches the signed index.
   */
  async updatePlugin(manager: PluginManager, id: string): Promise<MarketplaceUpdate & { updated: boolean }> {
    return this.runUpdateOperation(async () => {
      const installed = manager.list().find((plugin) => plugin.id === id);
      if (!installed) throw new Error(`未安装插件：${id}`);
      const candidate = (await this.checkUpdates([installed])).find((item) => item.id === id);
      if (!candidate) return { id, from: installed.version, to: installed.version, updated: false };
      await this.install(manager, candidate.version);
      return { id, from: candidate.from, to: candidate.to, updated: true };
    });
  }

  /** Serializes update rounds so a slow download cannot overlap the next poll. */
  private runUpdateOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.updateOperation.then(() => operation());
    this.updateOperation = result.then(() => undefined, () => undefined);
    return result;
  }

  private async fetchVerifiedIndex(): Promise<MarketplaceIndex> {
    if (!this.indexUrl) throw new Error("未配置插件市场地址，请设置 SECAGENT_PLUGIN_MARKET_URL");
    if (!isAllowedMarketUrl(this.indexUrl)) throw new Error("插件市场必须使用 HTTPS 地址；本地测试仅允许回环地址");
    const index = await fetchMarketplaceIndex(this.indexUrl, this.fetcher);
    this.verifyIndex(index);
    return index;
  }

  private async fetchPluginMetadata(reference: MarketplacePluginReference): Promise<MarketplacePluginMetadata> {
    const pluginUrl = resolvePluginPath(this.indexUrl, reference.path);
    const bytes = await fetchMarketplaceBytes(pluginUrl, this.fetcher, 12_000, undefined, reference.sha256);
    const actualSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (actualSha256.toLowerCase() !== reference.sha256.toLowerCase()) {
      throw new Error(`插件索引文件校验失败：${reference.id}`);
    }

    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
    } catch {
      throw new Error(`插件索引文件不是有效 JSON：${reference.id}`);
    }
    if (!isMarketplacePluginMetadata(value) || value.id !== reference.id) {
      throw new Error(`插件索引文件格式无效：${reference.id}`);
    }
    return value;
  }

  private async resolveRelease(plugin: MarketplacePluginMetadata): Promise<MarketplaceVersion | undefined> {
    const spec = plugin.release;
    const key = `${spec.provider}:${spec.owner}/${spec.repo}:${spec.assetName}:${spec.includePrerelease === true}`;
    const cached = this.releaseCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.error) throw new Error(cached.error);
      return cached.result;
    }

    const inFlight = this.releaseRequests.get(key);
    if (inFlight) {
      const result = await inFlight;
      if (result.error) throw new Error(result.error);
      return result.result;
    }

    const request = this.loadRelease(plugin).then((result) => {
      this.releaseCache.set(key, { ...result, expiresAt: Date.now() + RELEASE_CACHE_TTL_MS });
      return result;
    }).finally(() => this.releaseRequests.delete(key));
    this.releaseRequests.set(key, request);
    const result = await request;
    if (result.error) throw new Error(result.error);
    return result.result;
  }

  private async loadRelease(plugin: MarketplacePluginMetadata): Promise<CachedRelease> {
    try {
      if (plugin.release.provider !== "github") throw new Error("不支持的 Release 提供方");
      const apiUrl = `https://api.github.com/repos/${encodeURIComponent(plugin.release.owner)}/${encodeURIComponent(plugin.release.repo)}/releases/latest`;
      const response = await fetchMarketplaceResource(apiUrl, this.fetcher, 12_000, {
        Accept: "application/vnd.github+json",
        "User-Agent": "SecAgent"
      });
      const release = await response.json() as GithubRelease;
      if (release.draft === true || (release.prerelease === true && plugin.release.includePrerelease !== true)) {
        throw new Error("最新 Release 是 draft 或 prerelease");
      }
      const rawTag = typeof release.tag_name === "string" ? release.tag_name : "";
      const version = normalizeReleaseVersion(rawTag);
      if (!version || (version.pre.length && plugin.release.includePrerelease !== true)) {
        throw new Error("最新 Release tag 不是可用的 SemVer");
      }
      const assets = Array.isArray(release.assets) ? release.assets.filter(isGithubReleaseAsset) : [];
      const asset = findReleaseAsset(assets, plugin.release.assetName, version.value, rawTag);
      if (!asset) throw new Error(`Release 缺少匹配资产：${plugin.release.assetName}`);
      const assetUrl = typeof asset.browser_download_url === "string" ? asset.browser_download_url : "";
      if (!isAllowedMarketUrl(assetUrl)) throw new Error("Release 资产地址无效");
      const sha256 = await resolveReleaseSha256(asset, assets, this.fetcher);
      return {
        expiresAt: 0,
        result: {
          version: version.value,
          minHostApiVersion: plugin.minHostApiVersion,
          assetUrl,
          sha256,
          permissions: plugin.permissions,
          platforms: plugin.platforms
        }
      };
    } catch (error) {
      return { expiresAt: 0, result: undefined, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private verifyIndex(index: MarketplaceIndex): void {
    if (!this.publicKey || this.publicKey.startsWith("REPLACE_WITH_")) {
      throw new Error("未配置插件市场公钥");
    }
    if (!index.signature) throw new Error("市场索引缺少签名");
    const unsigned = { schemaVersion: index.schemaVersion, generatedAt: index.generatedAt, plugins: index.plugins };
    let signature: Buffer;
    try {
      signature = Buffer.from(index.signature, "base64");
    } catch {
      throw new Error("市场索引签名编码无效");
    }
    const valid = crypto.verify(null, Buffer.from(canonicalizeMarketplaceJson(unsigned), "utf8"), this.publicKey, signature);
    if (!valid) throw new Error("市场索引签名校验失败");
  }
}

/** Canonical JSON used by both the client and the marketplace index generator. */
export function canonicalizeMarketplaceJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalizeMarketplaceJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeMarketplaceJson(item)}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("无法规范化未定义 JSON 值");
  return serialized;
}

/** Returns proxy-first URLs for GitHub resources and direct-only URLs otherwise. */
export function marketplaceRequestUrls(directUrl: string): string[] {
  if (!/^https:\/\/(?:api\.github\.com|github\.com|raw\.githubusercontent\.com)\//i.test(directUrl)) return [directUrl];
  return [`${DEFAULT_MARKETPLACE_PROXY_URL}/${directUrl}`, directUrl];
}

/** Which network route a request URL uses: the ghproxy mirror or the origin host. */
export function downloadRouteOfUrl(url: string): "proxy" | "direct" {
  return url.startsWith(DEFAULT_MARKETPLACE_PROXY_URL) ? "proxy" : "direct";
}

export interface DownloadAttemptRecord {
  /** Download stage: release metadata lookup or the plugin package itself. */
  stage: "release-metadata" | "plugin-package";
  route: "proxy" | "direct";
  url: string;
  status?: number;
  bytes?: number;
  sha256?: string;
  durationMs: number;
  error?: string;
  /** Present when this attempt failed and another route will be tried. */
  fallbackTo?: "proxy" | "direct";
}

export type DownloadAttemptLogger = (attempt: DownloadAttemptRecord) => void;

/**
 * Logs one download attempt against the candidate list. Callers invoke this for
 * every candidate result so failures record the route that broke and the fallback.
 */
export function describeDownloadAttempt(stage: DownloadAttemptRecord["stage"], url: string, startedAt: number, outcome: { status?: number; bytes?: number; sha256?: string; error?: string }, remainingCandidates: string[]): DownloadAttemptRecord {
  const record: DownloadAttemptRecord = {
    stage,
    route: downloadRouteOfUrl(url),
    url,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...(outcome.status !== undefined ? { status: outcome.status } : {}),
    ...(outcome.bytes !== undefined ? { bytes: outcome.bytes } : {}),
    ...(outcome.sha256 !== undefined ? { sha256: outcome.sha256 } : {}),
    ...(outcome.error !== undefined ? { error: outcome.error } : {})
  };
  const next = remainingCandidates[0];
  if (outcome.error !== undefined && next) record.fallbackTo = downloadRouteOfUrl(next);
  return record;
}

function addCacheBust(url: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}secagent_cache=${Date.now()}`;
}

async function fetchMarketplaceIndex(url: string, fetcher: MarketplaceFetch): Promise<MarketplaceIndex> {
  const bytes = await fetchMarketplaceBytes(url, fetcher, 12_000, { "Cache-Control": "no-cache" });
  let index: unknown;
  try {
    index = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("插件市场索引不是有效 JSON");
  }
  if (!isMarketplaceIndex(index)) {
    if (isRecord(index) && index.schemaVersion === 1) throw new Error("不支持插件市场索引版本 1，请使用 schemaVersion 2");
    if (isRecord(index) && index.schemaVersion === 2 && !index.signature) throw new Error("市场索引缺少签名");
    throw new Error("插件市场索引格式无效");
  }
  return index;
}

async function fetchMarketplaceResource(url: string, fetcher: MarketplaceFetch, timeoutMs: number, headers?: HeadersInit): Promise<Response> {
  let lastError: unknown;
  for (const candidate of marketplaceRequestUrls(url)) {
    try {
      const response = await fetcher(candidate, { signal: AbortSignal.timeout(timeoutMs), headers });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`无法请求 ${url}：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function fetchMarketplaceBytes(url: string, fetcher: MarketplaceFetch, timeoutMs: number, headers?: HeadersInit, expectedSha256?: string): Promise<Buffer> {
  let lastError: unknown;
  for (const candidate of marketplaceRequestUrls(url).map(addCacheBust)) {
    try {
      const response = await fetcher(candidate, { signal: AbortSignal.timeout(timeoutMs), headers });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!expectedSha256 || crypto.createHash("sha256").update(bytes).digest("hex").toLowerCase() === expectedSha256.toLowerCase()) return bytes;
      lastError = new Error("SHA-256 校验失败");
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`无法请求 ${url}：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function downloadMarketplaceAsset(url: string, expectedSha256: string, fetcher: MarketplaceFetch): Promise<Buffer> {
  return fetchMarketplaceBytes(url, fetcher, 60_000, undefined, expectedSha256);
}

function resolvePluginPath(indexUrl: string, pluginPath: string): string {
  if (!pluginPath || pluginPath.startsWith("/") || pluginPath.includes("://") || pluginPath.split("/").includes("..")) {
    throw new Error(`插件索引路径无效：${pluginPath}`);
  }
  const url = new URL(pluginPath, indexUrl).toString();
  if (!isAllowedMarketUrl(url)) throw new Error(`插件索引地址无效：${pluginPath}`);
  return url;
}

function findReleaseAsset(assets: GithubReleaseAsset[], template: string, version: string, rawTag: string): GithubReleaseAsset | undefined {
  if (!template.includes("{version}")) return undefined;
  const names = new Set([template.replace("{version}", version), template.replace("{version}", rawTag)]);
  return assets.find((asset) => typeof asset.name === "string" && names.has(asset.name));
}

async function resolveReleaseSha256(asset: GithubReleaseAsset, assets: GithubReleaseAsset[], fetcher: MarketplaceFetch): Promise<string> {
  const digest = parseSha256(asset.digest);
  if (digest) return digest;
  const assetName = typeof asset.name === "string" ? asset.name : "";
  const sidecar = assets.find((candidate) => candidate.name === `${assetName}.sha256`);
  const sidecarUrl = sidecar && typeof sidecar.browser_download_url === "string" ? sidecar.browser_download_url : undefined;
  if (!sidecarUrl || !isAllowedMarketUrl(sidecarUrl)) throw new Error("Release 资产缺少 GitHub digest 或 .sha256 sidecar");
  const response = await fetchMarketplaceResource(sidecarUrl, fetcher, 12_000);
  const match = (await response.text()).match(/\b[a-fA-F0-9]{64}\b/);
  if (!match) throw new Error(".sha256 sidecar 内容无效");
  return match[0].toLowerCase();
}

function normalizeReleaseVersion(tag: string): { value: string; pre: string[] } | undefined {
  const value = tag.trim().replace(/^v/i, "");
  const parsed = parseVersion(value);
  return parsed ? { value, pre: parsed.pre } : undefined;
}

function isCompatibleMetadata(plugin: MarketplacePluginMetadata): boolean {
  return plugin.minHostApiVersion <= HOST_API_VERSION && plugin.platforms.includes(process.platform);
}

function isCompatibleVersion(version: MarketplaceVersion): boolean {
  return version.minHostApiVersion <= HOST_API_VERSION && version.platforms.includes(process.platform);
}

function parseVersion(value: string): { core: number[]; pre: string[] } | undefined {
  const match = value.trim().replace(/^v/i, "").match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return undefined;
  return { core: match[1].split(".").map(Number), pre: match[2] ? match[2].split(".") : [] };
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return left === right ? 0 : left.localeCompare(right, undefined, { numeric: true });
  for (let i = 0; i < Math.max(a.core.length, b.core.length); i++) {
    const difference = (a.core[i] || 0) - (b.core[i] || 0);
    if (difference) return difference > 0 ? 1 : -1;
  }
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    if (a.pre[i] === b.pre[i]) continue;
    const aNumber = /^\d+$/.test(a.pre[i]);
    const bNumber = /^\d+$/.test(b.pre[i]);
    if (aNumber && bNumber) return Number(a.pre[i]) > Number(b.pre[i]) ? 1 : -1;
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return a.pre[i].localeCompare(b.pre[i]);
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMarketplaceIndex(value: unknown): value is MarketplaceIndex {
  if (!isRecord(value) || value.schemaVersion !== 2 || typeof value.generatedAt !== "string" || typeof value.signature !== "string" || !Array.isArray(value.plugins)) return false;
  return value.plugins.every((plugin) => isRecord(plugin)
    && typeof plugin.id === "string"
    && typeof plugin.path === "string"
    && typeof plugin.sha256 === "string"
    && /^[a-fA-F0-9]{64}$/.test(plugin.sha256)
    && (plugin.latest === undefined || isMarketplaceVersion(plugin.latest)));
}

function isMarketplaceVersion(value: unknown): value is MarketplaceVersion {
  return isRecord(value)
    && typeof value.version === "string"
    && typeof value.minHostApiVersion === "number"
    && typeof value.assetUrl === "string"
    && isAllowedMarketUrl(value.assetUrl)
    && typeof value.sha256 === "string"
    && /^[a-fA-F0-9]{64}$/.test(value.sha256)
    && Array.isArray(value.permissions)
    && value.permissions.every((permission) => typeof permission === "string")
    && Array.isArray(value.platforms)
    && value.platforms.every((platform) => typeof platform === "string");
}

function validateMarketplaceVersion(value: MarketplaceVersion): MarketplaceVersion {
  if (!isMarketplaceVersion(value)) throw new Error("市场索引中的 Release 数据无效");
  return value;
}

function isMarketplacePluginMetadata(value: unknown): value is MarketplacePluginMetadata {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.description !== "string" || typeof value.repository !== "string" || typeof value.minHostApiVersion !== "number" || !Array.isArray(value.permissions) || !value.permissions.every((permission) => typeof permission === "string") || !Array.isArray(value.platforms) || !value.platforms.every((platform) => typeof platform === "string") || !isRecord(value.release)) return false;
  const release = value.release;
  return release.provider === "github" && typeof release.owner === "string" && /^[A-Za-z0-9_.-]+$/.test(release.owner) && typeof release.repo === "string" && /^[A-Za-z0-9_.-]+$/.test(release.repo) && typeof release.assetName === "string" && release.assetName.includes("{version}") && (release.includePrerelease === undefined || typeof release.includePrerelease === "boolean");
}

function isGithubReleaseAsset(value: unknown): value is GithubReleaseAsset {
  return isRecord(value) && typeof value.name === "string" && typeof value.browser_download_url === "string";
}

function parseSha256(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^sha256:([a-fA-F0-9]{64})$/i);
  return match?.[1].toLowerCase();
}

async function resolveMarketplaceReadme(value: string | undefined, fetcher: MarketplaceFetch): Promise<string | undefined> {
  if (!value || !/^https:\/\//i.test(value) || !isAllowedMarketUrl(value)) return value;
  try {
    const response = await fetchMarketplaceResource(value, fetcher, 12_000);
    const readme = await response.text();
    return readme.length <= 1024 * 1024 ? readme : undefined;
  } catch {
    return undefined;
  }
}

function isAllowedMarketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}
