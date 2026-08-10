import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginManager } from "./plugin-manager.js";

export interface MarketplaceVersion { version: string; minHostApiVersion: number; assetUrl: string; sha256: string; signature?: string; permissions: string[]; platforms: string[] }
export interface MarketplacePlugin { id: string; name: string; description: string; repository: string; readme?: string; versions: MarketplaceVersion[] }
export interface MarketplaceIndex { schemaVersion: 1; generatedAt: string; plugins: MarketplacePlugin[]; signature?: string }

/** Fetches the signed marketplace index and installs release assets after SHA-256 verification. */
export const DEFAULT_MARKETPLACE_INDEX_URL = "https://raw.githubusercontent.com/SECTL/secagent-plugin-marketplace/main/index.json";

export class MarketplaceClient {
  constructor(private readonly indexUrl = process.env.SECAGENT_PLUGIN_MARKET_URL || DEFAULT_MARKETPLACE_INDEX_URL, private readonly publicKey = process.env.SECAGENT_MARKET_PUBLIC_KEY || "") {}
  async list(): Promise<MarketplacePlugin[]> {
    if (!this.indexUrl) throw new Error("未配置插件市场地址。请设置 SECAGENT_PLUGIN_MARKET_URL。");
    if (!isAllowedMarketUrl(this.indexUrl)) throw new Error("插件市场必须使用 HTTPS 地址；本地测试仅允许回环地址");
    const response = await fetch(this.indexUrl, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`无法读取插件市场：HTTP ${response.status}`);
    const index = await response.json() as MarketplaceIndex;
    if (index.schemaVersion !== 1 || !Array.isArray(index.plugins)) throw new Error("插件市场索引格式无效");
    this.verifyIndex(index);
    return index.plugins.filter((plugin) => plugin.versions.some((version) => version.minHostApiVersion <= 1 && version.platforms.includes(process.platform)));
  }
  async install(manager: PluginManager, version: MarketplaceVersion): Promise<void> {
    if (!isAllowedMarketUrl(version.assetUrl) || !/^[a-fA-F0-9]{64}$/.test(version.sha256)) throw new Error("市场插件资产信息无效");
    const response = await fetch(version.assetUrl, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`下载插件失败：HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = crypto.createHash("sha256").update(bytes).digest("hex");
    if (actual.toLowerCase() !== version.sha256.toLowerCase()) throw new Error("插件 SHA-256 校验失败，已拒绝安装");
    const temporary = path.join(os.tmpdir(), `secagent-plugin-${crypto.randomUUID()}.zip`);
    try { fs.writeFileSync(temporary, bytes); await manager.install(temporary); } finally { fs.rmSync(temporary, { force: true }); }
  }
  private verifyIndex(index: MarketplaceIndex): void {
    if (!this.publicKey) return; // Local/private development markets may opt out; production config supplies the pinned public key.
    if (!index.signature) throw new Error("市场索引缺少签名");
    const unsigned = { ...index }; delete unsigned.signature;
    const valid = crypto.verify(null, Buffer.from(JSON.stringify(unsigned)), this.publicKey, Buffer.from(index.signature, "base64"));
    if (!valid) throw new Error("市场索引签名校验失败");
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
