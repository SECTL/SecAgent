import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { compareVersions, marketplaceRequestUrls } from "./marketplace.js";
import type { UpdateChannel, UpdateRelease } from "./types.js";

export const UPDATE_REPOSITORY = "SECTL/SecAgent";
export const UPDATE_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=100`;

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

export async function findLatestUpdate(channel: UpdateChannel, currentVersion: string, fetcher: Fetcher = fetch): Promise<UpdateRelease | undefined> {
  const response = await requestGitHub(appendCacheBust(UPDATE_API_URL), fetcher, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "SecAgent" }
  });
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) throw new Error("GitHub Release 列表格式无效");
  const candidates = payload
    .map((item) => toUpdateRelease(item as GitHubRelease, channel))
    .filter((item): item is UpdateRelease => Boolean(item))
    .filter((item) => compareVersions(item.version, currentVersion) > 0)
    .sort((left, right) => compareVersions(right.version, left.version));
  return candidates[0];
}

export async function downloadUpdate(release: UpdateRelease, storageDirectory: string, fetcher: Fetcher = fetch, onProgress?: (progress: DownloadProgress) => void): Promise<DownloadedUpdate> {
  const expectedSha = await expectedSha256(release, fetcher);
  if (!expectedSha) throw new Error("GitHub Release 缺少有效的 SHA-256 校验值");
  const response = await requestGitHub(release.assetUrl, fetcher, { headers: { "User-Agent": "SecAgent" } });
  const bytes = await readResponseBytes(response, onProgress);
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

async function expectedSha256(release: UpdateRelease, fetcher: Fetcher): Promise<string | undefined> {
  const digest = release.sha256 && SHA256_PATTERN.test(release.sha256) ? release.sha256.toLowerCase() : undefined;
  let sidecarDigest: string | undefined;
  if (release.checksumUrl) {
    const response = await requestGitHub(release.checksumUrl, fetcher, { headers: { "User-Agent": "SecAgent" } });
    sidecarDigest = parseChecksum(await response.text());
  }
  if (digest && sidecarDigest && digest !== sidecarDigest) throw new Error("Release SHA-256 校验文件与资产摘要不一致");
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
  return {
    version,
    tag: raw.tag_name,
    ...(releaseTypeFromVersion(version) ? { releaseType: releaseTypeFromVersion(version) } : {}),
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

async function requestGitHub(url: string, fetcher: Fetcher, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (const candidate of marketplaceRequestUrls(url)) {
    try {
      const response = await fetcher(candidate, { ...init, signal: AbortSignal.timeout(12_000) });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`无法访问 GitHub Release：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function readResponseBytes(response: Response, onProgress?: (progress: DownloadProgress) => void): Promise<Buffer> {
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
    const result = await reader.read();
    if (result.done) break;
    const chunk = Buffer.from(result.value);
    chunks.push(chunk);
    downloadedBytes += chunk.length;
    onProgress?.({ downloadedBytes, ...(totalBytes ? { totalBytes } : {}) });
  }
  return Buffer.concat(chunks);
}

function parseChecksum(value: string): string | undefined {
  const line = value.split(/\r?\n/).find((item) => SHA256_PATTERN.test(item.trim().split(/\s+/)[0] || ""));
  return line?.trim().split(/\s+/)[0]?.toLowerCase();
}

function appendCacheBust(url: string): string {
  return `${url}&secagent_cache=${Date.now()}`;
}

function isGitHubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "github.com" || url.hostname === "api.github.com");
  } catch {
    return false;
  }
}
