import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginManager } from "./plugin-manager.js";

export interface MarketplaceVersion { version: string; minHostApiVersion: number; assetUrl: string; sha256: string; signature?: string; permissions: string[]; platforms: string[] }
export interface MarketplacePlugin { id: string; format?: "secagent" | "agent"; name: string; description: string; repository: string; icon?: string; readme?: string; versions: MarketplaceVersion[] }
export interface MarketplaceIndex { schemaVersion: 1; generatedAt: string; plugins: MarketplacePlugin[]; signature?: string }
export interface MarketplaceUpdate { id: string; from: string; to: string }

type MarketplaceFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Fetches the signed marketplace index and installs release assets after SHA-256 verification. */
export const DEFAULT_MARKETPLACE_INDEX_URL = "https://raw.githubusercontent.com/SECTL/secagent-plugin-marketplace/refs/heads/main/index.json";
export const DEFAULT_MARKETPLACE_PROXY_URL = "https://ghproxy.sectl.cn";

export class MarketplaceClient {
  constructor(
    private readonly indexUrl = process.env.SECAGENT_PLUGIN_MARKET_URL || DEFAULT_MARKETPLACE_INDEX_URL,
    private readonly publicKey = process.env.SECAGENT_MARKET_PUBLIC_KEY || "",
    private readonly fetcher: MarketplaceFetch = fetch
  ) {}

  async list(): Promise<MarketplacePlugin[]> {
    if (!this.indexUrl) throw new Error("未配置插件市场地址。请设置 SECAGENT_PLUGIN_MARKET_URL。");
    if (!isAllowedMarketUrl(this.indexUrl)) throw new Error("插件市场必须使用 HTTPS 地址；本地测试仅允许回环地址");
    const index = await fetchMarketplaceIndex(this.indexUrl, this.fetcher);
    this.verifyIndex(index);
    const compatible = index.plugins.filter((plugin) => plugin.versions.some((version) => version.minHostApiVersion <= 1 && version.platforms.includes(process.platform)));
    return Promise.all(compatible.map(async (plugin) => {
      const readme = await resolveMarketplaceReadme(plugin.readme, this.fetcher);
      return readme === plugin.readme ? plugin : { ...plugin, readme };
    }));
  }

  async install(manager: PluginManager, version: MarketplaceVersion): Promise<void> {
    if (!isAllowedMarketUrl(version.assetUrl) || !/^[a-fA-F0-9]{64}$/.test(version.sha256)) throw new Error("市场插件资产信息无效");
    const bytes = await downloadMarketplaceAsset(version.assetUrl, version.sha256, this.fetcher);
    const temporary = path.join(os.tmpdir(), `secagent-plugin-${crypto.randomUUID()}.zip`);
    try {
      fs.writeFileSync(temporary, bytes);
      await manager.install(temporary);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  async updateInstalled(manager: PluginManager): Promise<MarketplaceUpdate[]> {
    const catalog = await this.list();
    const updates: MarketplaceUpdate[] = [];
    for (const installed of manager.list()) {
      const plugin = catalog.find((candidate) => candidate.id === installed.id);
      const latest = plugin ? latestCompatibleVersion(plugin) : undefined;
      if (!latest || compareVersions(latest.version, installed.version) <= 0) continue;
      await this.install(manager, latest);
      updates.push({ id: installed.id, from: installed.version, to: latest.version });
    }
    return updates;
  }

  private verifyIndex(index: MarketplaceIndex): void {
    if (!this.publicKey) return;
    if (!index.signature) throw new Error("市场索引缺少签名");
    const unsigned = { ...index };
    delete unsigned.signature;
    const valid = crypto.verify(null, Buffer.from(JSON.stringify(unsigned)), this.publicKey, Buffer.from(index.signature, "base64"));
    if (!valid) throw new Error("市场索引签名校验失败");
  }
}

/** Returns proxy-first URLs for GitHub resources and direct-only URLs otherwise. */
export function marketplaceRequestUrls(directUrl: string): string[] {
  if (!/^https:\/\/(?:github\.com|raw\.githubusercontent\.com)\//i.test(directUrl)) return [directUrl];
  return [`${DEFAULT_MARKETPLACE_PROXY_URL}/${directUrl}`, directUrl];
}

function addCacheBust(url: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}secagent_cache=${Date.now()}`;
}

async function fetchMarketplaceIndex(url: string, fetcher: MarketplaceFetch): Promise<MarketplaceIndex> {
  let lastError: unknown;
  for (const candidate of marketplaceRequestUrls(url).map(addCacheBust)) {
    try {
      const response = await fetcher(candidate, { signal: AbortSignal.timeout(12_000), headers: { "Cache-Control": "no-cache" } });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      const index = await response.json() as MarketplaceIndex;
      if (index.schemaVersion !== 1 || !Array.isArray(index.plugins)) throw new Error("插件市场索引格式无效");
      return index;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`无法读取插件市场：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function fetchMarketplaceResource(url: string, fetcher: MarketplaceFetch, timeoutMs: number): Promise<Response> {
  let lastError: unknown;
  for (const candidate of marketplaceRequestUrls(url)) {
    try {
      const response = await fetcher(candidate, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`无法请求 ${url}：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function downloadMarketplaceAsset(url: string, expectedSha256: string, fetcher: MarketplaceFetch): Promise<Buffer> {
  let lastError: unknown;
  for (const candidate of marketplaceRequestUrls(url)) {
    try {
      const response = await fetcher(candidate, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const actual = crypto.createHash("sha256").update(bytes).digest("hex");
      if (actual.toLowerCase() === expectedSha256.toLowerCase()) return bytes;
      lastError = new Error("SHA-256 校验失败");
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`下载插件失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
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

function latestCompatibleVersion(plugin: MarketplacePlugin): MarketplaceVersion | undefined {
  return plugin.versions
    .filter((version) => version.minHostApiVersion <= 1 && version.platforms.includes(process.platform))
    .sort((left, right) => compareVersions(right.version, left.version))[0];
}

function parseVersion(value: string): { core: number[]; pre: string[] } | undefined {
  const match = value.trim().replace(/^v/i, "").match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return undefined;
  return { core: match[1].split(".").map(Number), pre: match[2] ? match[2].split(".") : [] };
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

async function resolveMarketplaceReadme(value: string | undefined, fetcher: MarketplaceFetch): Promise<string | undefined> {
  if (!value || !/^https:\/\//i.test(value)) return value;
  if (!isAllowedMarketUrl(value)) return undefined;
  try {
    const response = await fetchMarketplaceResource(value, fetcher, 12_000);
    const readme = await response.text();
    return readme.length <= 1024 * 1024 ? readme : undefined;
  } catch {
    return undefined;
  }
}
