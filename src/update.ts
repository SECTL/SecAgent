import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { compareVersions, marketplaceRequestUrls, DEFAULT_MARKETPLACE_PROXY_URL } from "./marketplace.js";
import { OFFICIAL_UPDATE_PUBLIC_KEY as EMBEDDED_UPDATE_PUBLIC_KEY } from "./update-public-key.js";
import type { UpdateChannel, UpdateRelease, UpdateRequestAttempt } from "./types.js";

export const UPDATE_REPOSITORY = "SECTL/SecAgent";
export const UPDATE_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=100`;
export const UPDATE_METADATA_URL = `https://raw.githubusercontent.com/${UPDATE_REPOSITORY}/refs/heads/master/updates.json`;
export const UPDATE_METADATA_SCHEMA_VERSION = 1;

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface GitHubReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
  digest?: unknown;
  size?: unknown;
}

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  body?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
}

interface UpdateMetadataEntry {
  channel: UpdateChannel;
  version: string;
  tag: string;
  assetName: string;
  assetUrl: string;
  htmlUrl: string;
  sha256: string;
  size?: number;
  body?: string;
  publishedAt?: string;
}

interface UpdateMetadata {
  schemaVersion: typeof UPDATE_METADATA_SCHEMA_VERSION;
  product: "SecAgent";
  generatedAt: string;
  channels: Partial<Record<UpdateChannel, UpdateMetadataEntry>>;
  signature: string;
}

export interface UpdateRequestHooks {
  onAttempt?: (attempt: UpdateRequestAttempt) => void;
  onEvent?: (event: { name: string; data?: Record<string, unknown> }) => void;
  publicKey?: string;
  /** Deadline overrides used by deterministic request tests. */
  timeoutMs?: Partial<UpdateRequestTimeouts>;
}

export class UpdateRequestError extends Error {
  constructor(
    message: string,
    public readonly attempts: UpdateRequestAttempt[],
    public readonly lastStatus?: number
  ) {
    super(message);
    this.name = "UpdateRequestError";
  }
}

class UpdateMetadataSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateMetadataSignatureError";
  }
}

export interface PendingUpdate {
  path: string;
  version: string;
  channel: UpdateChannel;
  sha256: string;
  assetName: string;
  downloadedAt: string;
}

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes?: number;
}

export interface DownloadedUpdate {
  pending: PendingUpdate;
  bytes: number;
}

const VERSION_PATTERN = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const UPDATE_HEADER_TIMEOUT_MS = 12_000;
/** Installers stream for minutes; bound the silence between chunks, not the total transfer. */
const UPDATE_BODY_IDLE_TIMEOUT_MS = 60_000;

export interface UpdateRequestTimeouts {
  /** Deadline for receiving response headers on each route. */
  headerMs: number;
  /** Maximum silence between body chunks while consuming an installer download. */
  bodyIdleMs: number;
}

export const UPDATE_REQUEST_TIMEOUTS: UpdateRequestTimeouts = { headerMs: UPDATE_HEADER_TIMEOUT_MS, bodyIdleMs: UPDATE_BODY_IDLE_TIMEOUT_MS };

function resolveRequestTimeouts(hooks: UpdateRequestHooks): UpdateRequestTimeouts {
  return { ...UPDATE_REQUEST_TIMEOUTS, ...hooks.timeoutMs };
}

export function normalizeReleaseVersion(tag: string): string | undefined {
  return VERSION_PATTERN.exec(tag.trim())?.[1];
}

export function releaseAssetName(version: string): string {
  return `SecAgent-Setup-${version}.exe`;
}

export function pendingUpdateFile(storageDirectory: string): string {
  return path.join(storageDirectory, "pending-update.json");
}

export function readPendingUpdate(filePath: string): PendingUpdate | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<PendingUpdate>;
    if (typeof value.path !== "string" || typeof value.version !== "string" || (value.channel !== "stable" && value.channel !== "preview") || typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256) || typeof value.assetName !== "string" || typeof value.downloadedAt !== "string") return undefined;
    return { path: value.path, version: value.version, channel: value.channel, sha256: value.sha256.toLowerCase(), assetName: value.assetName, downloadedAt: value.downloadedAt };
  } catch {
    return undefined;
  }
}

export function writePendingUpdate(filePath: string, value: PendingUpdate): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.rmSync(filePath, { force: true });
  fs.renameSync(temporary, filePath);
}

export function clearPendingUpdate(filePath: string, pending?: PendingUpdate): void {
  if (pending?.path) fs.rmSync(pending.path, { force: true });
  fs.rmSync(filePath, { force: true });
}

export async function findLatestUpdate(
  channel: UpdateChannel,
  currentVersion: string,
  fetcher: Fetcher = fetch,
  hooks: UpdateRequestHooks = {}
): Promise<UpdateRelease | undefined> {
  try {
    const response = await requestGitHub(appendCacheBust(UPDATE_METADATA_URL), fetcher, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache", "User-Agent": "SecAgent" }
    }, "metadata", hooks);
    const metadata = verifyUpdateMetadata(await response.text(), hooks.publicKey || EMBEDDED_UPDATE_PUBLIC_KEY);
    const entry = metadata.channels[channel];
    if (!entry) throw new Error(`更新清单缺少 ${channel} 通道`);
    const release = metadataEntryToRelease(entry, channel);
    hooks.onEvent?.({ name: "metadata.accepted", data: { channel, version: release.version, tag: release.tag } });
    return compareVersions(release.version, currentVersion) > 0 ? release : undefined;
  } catch (error) {
    if (error instanceof UpdateMetadataSignatureError) throw error;
    hooks.onEvent?.({ name: "metadata.fallback", data: { error: errorMessage(error) } });
  }

  const response = await requestGitHub(appendCacheBust(UPDATE_API_URL), fetcher, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "SecAgent" }
  }, "release-api", hooks);
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) throw new Error("GitHub Release 列表格式无效");
  const candidates = payload
    .map((item) => toUpdateRelease(item as GitHubRelease, channel))
    .filter((item): item is UpdateRelease => Boolean(item))
    .filter((item) => compareVersions(item.version, currentVersion) > 0)
    .sort((left, right) => compareVersions(right.version, left.version));
  return candidates[0];
}

export async function downloadUpdate(
  release: UpdateRelease,
  storageDirectory: string,
  fetcher: Fetcher = fetch,
  onProgress?: (progress: DownloadProgress) => void,
  hooks: UpdateRequestHooks = {}
): Promise<DownloadedUpdate> {
  const expectedSha = await expectedSha256(release, fetcher, hooks);
  if (!expectedSha) throw new Error("GitHub Release 缺少有效的 SHA-256 校验值");
  const response = await requestGitHub(release.assetUrl, fetcher, { headers: { "User-Agent": "SecAgent" } }, "asset", hooks);
  const bytes = await readResponseBytes(response, resolveRequestTimeouts(hooks).bodyIdleMs, onProgress);
  const actualSha = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actualSha.toLowerCase() !== expectedSha.toLowerCase()) throw new Error("更新安装包 SHA-256 校验失败");

  fs.mkdirSync(storageDirectory, { recursive: true });
  const destination = path.join(storageDirectory, release.assetName);
  const temporary = `${destination}.${crypto.randomUUID()}.download`;
  fs.writeFileSync(temporary, bytes);
  fs.rmSync(destination, { force: true });
  fs.renameSync(temporary, destination);
  return {
    pending: {
      path: destination,
      version: release.version,
      channel: release.channel,
      sha256: actualSha,
      assetName: release.assetName,
      downloadedAt: new Date().toISOString()
    },
    bytes: bytes.length
  };
}

function verifyUpdateMetadata(value: string, publicKey: string): UpdateMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("SecAgent 更新清单不是有效 JSON");
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== UPDATE_METADATA_SCHEMA_VERSION || parsed.product !== "SecAgent" || typeof parsed.generatedAt !== "string" || !isRecord(parsed.channels) || typeof parsed.signature !== "string") {
    throw new Error("SecAgent 更新清单格式无效");
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(parsed.signature, "base64");
  } catch {
    throw new UpdateMetadataSignatureError("SecAgent 更新清单签名编码无效");
  }
  const unsigned = { schemaVersion: parsed.schemaVersion, product: parsed.product, generatedAt: parsed.generatedAt, channels: parsed.channels };
  let valid = false;
  try {
    valid = crypto.verify(null, Buffer.from(canonicalizeUpdateJson(unsigned), "utf8"), publicKey, signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new UpdateMetadataSignatureError("SecAgent 更新清单签名校验失败");

  const channels: Partial<Record<UpdateChannel, UpdateMetadataEntry>> = {};
  for (const channel of ["stable", "preview"] as const) {
    const entry = parsed.channels[channel];
    if (entry === undefined) continue;
    channels[channel] = validateMetadataEntry(entry, channel);
  }
  return { schemaVersion: UPDATE_METADATA_SCHEMA_VERSION, product: "SecAgent", generatedAt: parsed.generatedAt, channels, signature: parsed.signature };
}

function validateMetadataEntry(value: unknown, channel: UpdateChannel): UpdateMetadataEntry {
  if (!isRecord(value) || value.channel !== channel || typeof value.version !== "string" || typeof value.tag !== "string" || typeof value.assetName !== "string" || typeof value.assetUrl !== "string" || typeof value.htmlUrl !== "string" || typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256) || !isGitHubUrl(value.assetUrl) || !isGitHubUrl(value.htmlUrl)) {
    throw new Error(`SecAgent ${channel} 更新清单内容无效`);
  }
  const version = normalizeReleaseVersion(value.version);
  const tagVersion = normalizeReleaseVersion(value.tag);
  if (!version || !tagVersion || version !== tagVersion || value.assetName !== releaseAssetName(version)) throw new Error(`SecAgent ${channel} 更新清单版本信息不一致`);
  if (typeof value.size !== "undefined" && (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size <= 0)) throw new Error(`SecAgent ${channel} 更新清单文件大小无效`);
  if (typeof value.body !== "undefined" && typeof value.body !== "string") throw new Error(`SecAgent ${channel} 更新清单更新说明无效`);
  if (typeof value.publishedAt !== "undefined" && typeof value.publishedAt !== "string") throw new Error(`SecAgent ${channel} 更新清单发布时间无效`);
  return {
    channel,
    version,
    tag: value.tag,
    assetName: value.assetName,
    assetUrl: value.assetUrl,
    htmlUrl: value.htmlUrl,
    sha256: value.sha256.toLowerCase(),
    ...(typeof value.size === "number" ? { size: value.size } : {}),
    ...(typeof value.body === "string" ? { body: value.body } : {}),
    ...(typeof value.publishedAt === "string" ? { publishedAt: value.publishedAt } : {})
  };
}

function metadataEntryToRelease(entry: UpdateMetadataEntry, channel: UpdateChannel): UpdateRelease {
  const releaseType = releaseTypeFromVersion(entry.version);
  return {
    version: entry.version,
    tag: entry.tag,
    ...(releaseType ? { releaseType } : {}),
    channel,
    htmlUrl: entry.htmlUrl,
    body: entry.body || "",
    ...(entry.publishedAt ? { publishedAt: entry.publishedAt } : {}),
    assetName: entry.assetName,
    assetUrl: entry.assetUrl,
    sha256: entry.sha256,
    ...(entry.size !== undefined ? { size: entry.size } : {})
  };
}

async function expectedSha256(release: UpdateRelease, fetcher: Fetcher, hooks: UpdateRequestHooks): Promise<string | undefined> {
  const digest = release.sha256 && SHA256_PATTERN.test(release.sha256) ? release.sha256.toLowerCase() : undefined;
  let sidecarDigest: string | undefined;
  if (release.checksumUrl) {
    const response = await requestGitHub(release.checksumUrl, fetcher, { headers: { "User-Agent": "SecAgent" } }, "checksum", hooks);
    sidecarDigest = parseChecksum(await response.text());
  }
  if (digest && sidecarDigest && digest !== sidecarDigest) throw new Error("Release SHA-256 校验文件与资源摘要不一致");
  return digest || sidecarDigest;
}

function toUpdateRelease(raw: GitHubRelease, channel: UpdateChannel): UpdateRelease | undefined {
  if (raw.draft === true || raw.prerelease !== (channel === "preview") || typeof raw.tag_name !== "string" || !Array.isArray(raw.assets)) return undefined;
  const version = normalizeReleaseVersion(raw.tag_name);
  if (!version) return undefined;
  const assetName = releaseAssetName(version);
  const assets = raw.assets as GitHubReleaseAsset[];
  const asset = assets.find((item) => item.name === assetName && typeof item.browser_download_url === "string");
  if (!asset || !isGitHubUrl(asset.browser_download_url as string)) return undefined;
  const checksum = assets.find((item) => item.name === `${assetName}.sha256` && typeof item.browser_download_url === "string" && isGitHubUrl(item.browser_download_url as string));
  const digest = typeof asset.digest === "string" ? asset.digest.match(/^sha256:([a-f0-9]{64})$/i)?.[1].toLowerCase() : undefined;
  const releaseType = releaseTypeFromVersion(version);
  return {
    version,
    tag: raw.tag_name,
    ...(releaseType ? { releaseType } : {}),
    channel,
    htmlUrl: typeof raw.html_url === "string" ? raw.html_url : `https://github.com/${UPDATE_REPOSITORY}/releases/tag/${encodeURIComponent(raw.tag_name)}`,
    body: typeof raw.body === "string" ? raw.body : "",
    ...(typeof raw.published_at === "string" ? { publishedAt: raw.published_at } : {}),
    assetName,
    assetUrl: asset.browser_download_url as string,
    ...(digest ? { sha256: digest } : {}),
    ...(checksum ? { checksumUrl: checksum.browser_download_url as string } : {}),
    ...(typeof asset.size === "number" ? { size: asset.size } : {})
  };
}

function releaseTypeFromVersion(version: string): "alpha" | "beta" | undefined {
  if (/-alpha(?:[0-9.-]|$)/i.test(version)) return "alpha";
  if (/-beta(?:[0-9.-]|$)/i.test(version)) return "beta";
  return undefined;
}

async function requestGitHub(url: string, fetcher: Fetcher, init: RequestInit, phase: UpdateRequestAttempt["phase"], hooks: UpdateRequestHooks): Promise<Response> {
  const attempts: UpdateRequestAttempt[] = [];
  let lastError: unknown;
  let lastStatus: number | undefined;
  for (const candidate of marketplaceRequestUrls(url)) {
    const startedAt = Date.now();
    const route = candidate.startsWith(`${DEFAULT_MARKETPLACE_PROXY_URL}/`) ? "proxy" : "direct";
    // The deadline only covers the wait for response headers: AbortSignal.timeout
    // would stay attached to the returned Response.body and abort a large
    // installer mid-stream long after a healthy 200 arrived.
    const controller = new AbortController();
    const headerTimer = setTimeout(() => controller.abort(), resolveRequestTimeouts(hooks).headerMs);
    try {
      const response = await fetcher(candidate, { ...init, signal: controller.signal });
      const attempt: UpdateRequestAttempt = {
        phase,
        route,
        url: redactUrl(candidate),
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get("content-type") || undefined,
        responseBytes: parseContentLength(response.headers.get("content-length")),
        durationMs: Date.now() - startedAt,
        ...(response.ok ? {} : { error: `HTTP ${response.status}` })
      };
      attempts.push(attempt);
      hooks.onAttempt?.(attempt);
      if (response.ok) return response;
      lastStatus = response.status;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      const attempt: UpdateRequestAttempt = {
        phase,
        route,
        url: redactUrl(candidate),
        ok: false,
        durationMs: Date.now() - startedAt,
        error: errorMessage(error)
      };
      attempts.push(attempt);
      hooks.onAttempt?.(attempt);
      lastError = error;
    } finally {
      clearTimeout(headerTimer);
    }
  }
  throw new UpdateRequestError(`无法访问 GitHub 更新服务：${errorMessage(lastError)}`, attempts, lastStatus);
}

async function readResponseBytes(response: Response, bodyIdleMs: number, onProgress?: (progress: DownloadProgress) => void): Promise<Buffer> {
  const totalHeader = response.headers.get("content-length");
  const totalBytes = totalHeader && Number.isFinite(Number(totalHeader)) ? Number(totalHeader) : undefined;
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    onProgress?.({ downloadedBytes: bytes.length, ...(totalBytes ? { totalBytes } : {}) });
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let downloadedBytes = 0;
  while (true) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      // Bound the silence between chunks instead of the total transfer: a slow
      // but steadily moving installer download must be allowed to finish.
      result = await raceWithTimer(reader.read(), bodyIdleMs);
    } catch (error) {
      // Resolves (never rejects) the pending read, so no unhandled rejection.
      await reader.cancel(error).catch(() => undefined);
      throw error;
    }
    if (result.done) break;
    const chunk = Buffer.from(result.value);
    chunks.push(chunk);
    downloadedBytes += chunk.length;
    onProgress?.({ downloadedBytes, ...(totalBytes ? { totalBytes } : {}) });
  }
  return Buffer.concat(chunks);
}

function readResponseTimeoutError(): Error {
  return new Error(`更新下载中断：连接超过 ${Math.round(UPDATE_BODY_IDLE_TIMEOUT_MS / 1000)} 秒没有传输数据`);
}

async function raceWithTimer<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        // Reject first: cancelling the reader afterwards settles the losing
        // read promise with {done: true}; rejecting last would let that
        // resolution win the race and swallow the timeout.
        timer = setTimeout(() => reject(readResponseTimeoutError()), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function parseChecksum(value: string): string | undefined {
  const line = value.split(/\r?\n/).find((item) => SHA256_PATTERN.test(item.trim().split(/\s+/)[0] || ""));
  return line?.trim().split(/\s+/)[0]?.toLowerCase();
}

function appendCacheBust(url: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}secagent_cache=${Date.now()}`;
}

export function canonicalizeUpdateJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalizeUpdateJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeUpdateJson(item)}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("无法规范化未定义 JSON 值");
  return serialized;
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isGitHubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "github.com" || url.hostname === "api.github.com" || url.hostname === "raw.githubusercontent.com");
  } catch {
    return false;
  }
}
