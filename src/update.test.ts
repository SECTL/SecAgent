import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalizeUpdateJson, downloadUpdate, findLatestUpdate, normalizeReleaseVersion, readPendingUpdate, releaseAssetName, writePendingUpdate } from "./update.js";

test("normalizes release versions and labels alpha/beta versions", () => {
  assert.equal(normalizeReleaseVersion("v1.2.3"), "1.2.3");
  assert.equal(normalizeReleaseVersion("1.2.3-beta.2"), "1.2.3-beta.2");
  assert.equal(normalizeReleaseVersion("release-1.2.3"), undefined);
});

test("selects the newest release from the requested channel", async () => {
  const bytes = Buffer.from("installer");
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const fetcher = async (input: string | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("api.github.com")) return new Response(JSON.stringify([
      { tag_name: "v1.0.0", prerelease: false, draft: false, assets: [] },
      { tag_name: "v1.2.0-alpha.1", prerelease: true, draft: false, assets: [{ name: releaseAssetName("1.2.0-alpha.1"), browser_download_url: "https://github.com/SECTL/SecAgent/releases/download/v1.2.0-alpha.1/SecAgent-Setup-1.2.0-alpha.1.exe", digest: `sha256:${digest}` }] },
      { tag_name: "v1.3.0-beta.1", prerelease: true, draft: false, assets: [{ name: releaseAssetName("1.3.0-beta.1"), browser_download_url: "https://github.com/SECTL/SecAgent/releases/download/v1.3.0-beta.1/SecAgent-Setup-1.3.0-beta.1.exe", digest: `sha256:${digest}` }] },
      { tag_name: "v9.0.0-alpha.1", prerelease: true, draft: true, assets: [] }
    ]));
    throw new Error(`unexpected URL ${url}`);
  };
  const release = await findLatestUpdate("preview", "1.0.0", fetcher);
  assert.equal(release?.version, "1.3.0-beta.1");
  assert.equal(release?.releaseType, "beta");
  const stable = await findLatestUpdate("stable", "1.0.0", fetcher);
  assert.equal(stable, undefined);
});

test("downloads and verifies an installer with the release checksum", async () => {
  const bytes = Buffer.from("installer bytes");
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const release = {
    version: "1.2.0-alpha.1",
    tag: "v1.2.0-alpha.1",
    releaseType: "alpha" as const,
    channel: "preview" as const,
    htmlUrl: "https://github.com/SECTL/SecAgent/releases/tag/v1.2.0-alpha.1",
    body: "notes",
    assetName: releaseAssetName("1.2.0-alpha.1"),
    assetUrl: "https://github.com/SECTL/SecAgent/releases/download/v1.2.0-alpha.1/SecAgent-Setup-1.2.0-alpha.1.exe",
    checksumUrl: "https://github.com/SECTL/SecAgent/releases/download/v1.2.0-alpha.1/SecAgent-Setup-1.2.0-alpha.1.exe.sha256",
    sha256: digest
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-update-"));
  try {
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith(".sha256")) return new Response(`${digest}  ${release.assetName}\n`);
      if (url.endsWith(".exe")) return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
      throw new Error(`unexpected URL ${url}`);
    };
    const progress: number[] = [];
    const result = await downloadUpdate(release, root, fetcher, (item) => progress.push(item.downloadedBytes));
    assert.equal(fs.readFileSync(result.pending.path).toString(), bytes.toString());
    assert.equal(result.pending.sha256, digest);
    assert.ok(progress.length >= 1);
    const stateFile = path.join(root, "pending.json");
    writePendingUpdate(stateFile, result.pending);
    assert.deepEqual(readPendingUpdate(stateFile), result.pending);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("falls back from the GitHub proxy to direct access", async () => {
  const calls: string[] = [];
  const fetcher = async (input: string | URL): Promise<Response> => {
    calls.push(String(input));
    if (calls.length === 1) throw new Error("proxy unavailable");
    return new Response(JSON.stringify([{ tag_name: "v1.1.0", prerelease: false, draft: false, assets: [{ name: releaseAssetName("1.1.0"), browser_download_url: "https://github.com/SECTL/SecAgent/releases/download/v1.1.0/SecAgent-Setup-1.1.0.exe", digest: `sha256:${"a".repeat(64)}` }] }]));
  };
  const release = await findLatestUpdate("stable", "1.0.0", fetcher);
  assert.equal(release?.version, "1.1.0");
  assert.match(calls[0], /ghproxy\.sectl\.cn/);
  assert.equal(calls.some((url) => url.includes("api.github.com")), true);
});

test("prefers a signed channel metadata document over the GitHub releases API", async () => {
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const unsigned = {
    schemaVersion: 1,
    product: "SecAgent",
    generatedAt: "2026-08-27T00:00:00.000Z",
    channels: {
      preview: {
        channel: "preview",
        version: "1.2.0-alpha.1",
        tag: "v1.2.0-alpha.1",
        assetName: releaseAssetName("1.2.0-alpha.1"),
        assetUrl: "https://github.com/SECTL/SecAgent/releases/download/v1.2.0-alpha.1/SecAgent-Setup-1.2.0-alpha.1.exe",
        htmlUrl: "https://github.com/SECTL/SecAgent/releases/tag/v1.2.0-alpha.1",
        sha256: "a".repeat(64),
        size: 123
      }
    }
  } as const;
  const metadata = {
    ...unsigned,
    signature: crypto.sign(null, Buffer.from(canonicalizeUpdateJson(unsigned), "utf8"), keyPair.privateKey).toString("base64")
  };
  const calls: string[] = [];
  const fetcher = async (input: string | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url.includes("updates.json")) return new Response(JSON.stringify(metadata), { status: 200 });
    throw new Error(`unexpected URL ${url}`);
  };
  const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const release = await findLatestUpdate("preview", "1.0.0", fetcher, { publicKey });
  assert.equal(release?.version, "1.2.0-alpha.1");
  assert.equal(calls.every((url) => url.includes("updates.json")), true);
});

test("records both update routes when the metadata and releases API are unavailable", async () => {
  const attempts: Array<{ phase: string; route: string; status?: number }> = [];
  const fetcher = async (): Promise<Response> => new Response("unavailable", { status: 503 });
  await assert.rejects(
    findLatestUpdate("stable", "1.0.0", fetcher, { onAttempt: (attempt) => attempts.push(attempt) }),
    /无法访问 GitHub 更新服务/
  );
  assert.deepEqual(attempts.map((attempt) => `${attempt.phase}:${attempt.route}:${attempt.status}`), [
    "metadata:proxy:503",
    "metadata:direct:503",
    "release-api:proxy:503",
    "release-api:direct:503"
  ]);
});
