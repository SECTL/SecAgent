import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { compareVersions, canonicalizeMarketplaceJson, DEFAULT_MARKETPLACE_INDEX_URL, DEFAULT_MARKETPLACE_PROXY_URL, MarketplaceClient, marketplaceRequestUrls, type MarketplaceIndex, type MarketplacePluginReference } from "./marketplace.js";

const keyPair = crypto.generateKeyPairSync("ed25519");
const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();

test("marketplace versions compare numerically and respect prereleases", () => {
  assert.equal(compareVersions("1.0.10", "1.0.2") > 0, true);
  assert.equal(compareVersions("1.0.0", "1.0.0-beta.1") > 0, true);
  assert.equal(compareVersions("2.0.0", "1.9.99") > 0, true);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
});

test("marketplace uses the proxy before the direct GitHub URL", () => {
  assert.deepEqual(marketplaceRequestUrls(DEFAULT_MARKETPLACE_INDEX_URL), [
    `${DEFAULT_MARKETPLACE_PROXY_URL}/${DEFAULT_MARKETPLACE_INDEX_URL}`,
    DEFAULT_MARKETPLACE_INDEX_URL
  ]);
  const githubApiUrl = "https://api.github.com/repos/SECTL/ClassIsland-SecAgent-Plugin/releases/latest";
  assert.deepEqual(marketplaceRequestUrls(githubApiUrl), [
    `${DEFAULT_MARKETPLACE_PROXY_URL}/${githubApiUrl}`,
    githubApiUrl
  ]);
  assert.deepEqual(marketplaceRequestUrls("https://example.com/index.json"), ["https://example.com/index.json"]);
});

test("marketplace verifies a signed v2 index, resolves latest Release and merges concurrent requests", async () => {
  const archive = Buffer.from("plugin zip bytes");
  const fixture = createFixture({
    release: {
      tag_name: "v1.2.3",
      draft: false,
      prerelease: false,
      assets: [{ name: "example-1.2.3.zip", browser_download_url: "https://github.com/example/example/releases/download/v1.2.3/example-1.2.3.zip", digest: `sha256:${sha256(archive)}` }]
    }
  });
  let releaseRequests = 0;
  const calls: string[] = [];
  const fetcher = createFetcher(fixture, (url) => {
    calls.push(url);
    if (url.includes("/releases/latest")) releaseRequests += 1;
  });
  const client = new MarketplaceClient("http://127.0.0.1/index.json", publicKey, fetcher);
  const [first, second] = await Promise.all([client.list(), client.list()]);
  assert.equal(first[0].latest?.version, "1.2.3");
  assert.equal(first[0].latest?.sha256, sha256(archive));
  assert.equal(second[0].latest?.assetUrl.endsWith("example-1.2.3.zip"), true);
  assert.equal(releaseRequests, 1);
  assert.equal(calls.some((url) => url.includes("plugins/example.json")), true);
});

test("marketplace uses resolved Release metadata from the signed index without GitHub API", async () => {
  const fixture = createFixture();
  const resolved = {
    version: "1.0.0",
    minHostApiVersion: 1,
    assetUrl: "https://github.com/example/example/releases/download/v1.0.0/example-1.0.0.zip",
    sha256: sha256(fixture.archive),
    permissions: ["agent.tools"],
    platforms: [process.platform]
  };
  const unsigned = {
    schemaVersion: fixture.index.schemaVersion,
    generatedAt: fixture.index.generatedAt,
    plugins: fixture.index.plugins.map((reference) => ({ ...reference, latest: resolved }))
  } as MarketplaceIndex;
  let releaseApiCalled = false;
  const signedIndex = signIndex(unsigned);
  const fetcher = createFetcher({ ...fixture, index: signedIndex }, (url) => {
    if (url.includes("/releases/latest")) releaseApiCalled = true;
  });
  const [plugin] = await new MarketplaceClient("http://127.0.0.1/index.json", publicKey, fetcher).list();
  assert.equal(plugin.latest?.version, "1.0.0");
  assert.equal(plugin.latest?.sha256, resolved.sha256);
  assert.equal(releaseApiCalled, false);
});

test("marketplace falls back to a .sha256 sidecar when GitHub has no digest", async () => {
  const archive = Buffer.from("sidecar plugin zip");
  const fixture = createFixture({
    release: {
      tag_name: "2.0.0",
      draft: false,
      prerelease: false,
      assets: [
        { name: "example-2.0.0.zip", browser_download_url: "https://github.com/example/example/releases/download/2.0.0/example-2.0.0.zip" },
        { name: "example-2.0.0.zip.sha256", browser_download_url: "https://github.com/example/example/releases/download/2.0.0/example-2.0.0.zip.sha256" }
      ]
    },
    archive,
    sidecar: `${sha256(archive)}  example-2.0.0.zip\n`
  });
  const [plugin] = await new MarketplaceClient("http://127.0.0.1/index.json", publicKey, createFetcher(fixture)).list();
  assert.equal(plugin.latest?.version, "2.0.0");
  assert.equal(plugin.latest?.sha256, sha256(archive));
});

test("draft, prerelease and missing asset releases leave plugin metadata available but unavailable", async () => {
  const fixture = createFixture({
    release: {
      tag_name: "v3.0.0-beta.1",
      draft: false,
      prerelease: true,
      assets: []
    }
  });
  const [plugin] = await new MarketplaceClient("http://127.0.0.1/index.json", publicKey, createFetcher(fixture)).list();
  assert.equal(plugin.name, "Example");
  assert.equal(plugin.latest, undefined);
  assert.match(plugin.releaseError || "", /draft|prerelease/);
});

test("marketplace rejects missing and invalid signatures and rejects schema v1", async () => {
  const fixture = createFixture();
  const fetcher = createFetcher(fixture);
  const missingSignature = { ...fixture.index, signature: "" };
  await assert.rejects(
    new MarketplaceClient("http://127.0.0.1/index.json", publicKey, createFetcher({ ...fixture, index: missingSignature })).list(),
    /缺少签名/
  );

  const otherPair = crypto.generateKeyPairSync("ed25519");
  await assert.rejects(
    new MarketplaceClient("http://127.0.0.1/index.json", otherPair.publicKey.export({ type: "spki", format: "pem" }).toString(), fetcher).list(),
    /签名校验失败/
  );

  await assert.rejects(
    new MarketplaceClient("http://127.0.0.1/index.json", publicKey, createFetcher({ ...fixture, index: { schemaVersion: 1, generatedAt: fixture.index.generatedAt, plugins: [] } })).list(),
    /索引版本 1/
  );
});

test("marketplace rejects a plugin metadata SHA-256 mismatch", async () => {
  const fixture = createFixture();
  const tamperedIndex = {
    ...fixture.index,
    plugins: fixture.index.plugins.map((reference) => ({ ...reference, sha256: "0".repeat(64) }))
  };
  const signedIndex = signIndex({ schemaVersion: 2, generatedAt: tamperedIndex.generatedAt, plugins: tamperedIndex.plugins });
  await assert.rejects(
    new MarketplaceClient("http://127.0.0.1/index.json", publicKey, createFetcher({ ...fixture, index: signedIndex })).list(),
    /校验失败/
  );
});

test("updateInstalled compares the single latest version and verifies the downloaded asset", async () => {
  const archive = Buffer.from("update zip bytes");
  const fixture = createFixture({
    archive,
    release: {
      tag_name: "v2.0.0",
      draft: false,
      prerelease: false,
      assets: [{ name: "example-2.0.0.zip", browser_download_url: "https://github.com/example/example/releases/download/v2.0.0/example-2.0.0.zip", digest: `sha256:${sha256(archive)}` }]
    }
  });
  const installed = [{ id: "example", name: "Example", version: "1.0.0" }];
  let installedPath = "";
  const manager = {
    list: () => installed,
    install: async (filePath: string) => { installedPath = filePath; assert.equal(fs.readFileSync(filePath).toString(), archive.toString()); }
  } as never;
  const updates = await new MarketplaceClient("http://127.0.0.1/index.json", publicKey, createFetcher(fixture)).updateInstalled(manager);
  assert.deepEqual(updates, [{ id: "example", from: "1.0.0", to: "2.0.0" }]);
  assert.equal(fs.existsSync(installedPath), false);
});

function createFixture(options: {
  archive?: Buffer;
  sidecar?: string;
  release?: Record<string, unknown>;
} = {}) {
  const metadata = {
    schemaVersion: 1,
    id: "example",
    name: "Example",
    description: "Example plugin",
    repository: "https://github.com/example/example",
    minHostApiVersion: 1,
    permissions: ["agent.tools"],
    platforms: [process.platform],
    release: {
      provider: "github",
      owner: "example",
      repo: "example",
      assetName: "example-{version}.zip",
      includePrerelease: false
    }
  };
  const metadataBytes = Buffer.from(JSON.stringify(metadata));
  const unsigned: { schemaVersion: 2; generatedAt: string; plugins: MarketplacePluginReference[] } = {
    schemaVersion: 2,
    generatedAt: "2026-08-27T00:00:00.000Z",
    plugins: [{ id: "example", path: "plugins/example.json", sha256: sha256(metadataBytes) }]
  };
  return {
    index: signIndex(unsigned),
    metadataBytes,
    archive: options.archive || Buffer.from("plugin zip bytes"),
    sidecar: options.sidecar,
    release: options.release || {
      tag_name: "v1.0.0",
      draft: false,
      prerelease: false,
      assets: [{ name: "example-1.0.0.zip", browser_download_url: "https://github.com/example/example/releases/download/v1.0.0/example-1.0.0.zip", digest: "sha256:" + "1".repeat(64) }]
    }
  };
}

function signIndex(unsigned: { schemaVersion: 2; generatedAt: string; plugins: MarketplacePluginReference[] }): MarketplaceIndex {
  return {
    ...unsigned,
    signature: crypto.sign(null, Buffer.from(canonicalizeMarketplaceJson(unsigned), "utf8"), keyPair.privateKey).toString("base64")
  };
}

function createFetcher(fixture: { index: unknown; metadataBytes: Buffer; archive: Buffer; sidecar?: string; release: Record<string, unknown> }, onRequest?: (url: string) => void) {
  return async (input: string | URL): Promise<Response> => {
    const url = String(input);
    onRequest?.(url);
    if (url.includes("index.json")) return new Response(JSON.stringify(fixture.index), { status: 200 });
    if (url.includes("plugins/example.json")) return new Response(new Uint8Array(fixture.metadataBytes), { status: 200 });
    if (url.includes("/releases/latest")) return new Response(JSON.stringify(fixture.release), { status: 200 });
    if (url.includes(".sha256")) return new Response(fixture.sidecar || "", { status: 200 });
    if (url.includes("/releases/download/")) return new Response(new Uint8Array(fixture.archive), { status: 200 });
    return new Response("not found", { status: 404 });
  };
}

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
