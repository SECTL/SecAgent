import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, DEFAULT_MARKETPLACE_INDEX_URL, DEFAULT_MARKETPLACE_PROXY_URL, MarketplaceClient, marketplaceRequestUrls } from "./marketplace.js";

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

test("marketplace falls back to direct access when the proxy is unavailable", async () => {
  const calls: string[] = [];
  const fetcher = async (input: string | URL): Promise<Response> => {
    calls.push(String(input));
    if (calls.length === 1) throw new Error("proxy unavailable");
    return new Response(JSON.stringify({ schemaVersion: 1, generatedAt: "2026-08-23T00:00:00.000Z", plugins: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const client = new MarketplaceClient(DEFAULT_MARKETPLACE_INDEX_URL, "", fetcher);
  assert.deepEqual(await client.list(), []);
  assert.match(calls[0], new RegExp(`^${DEFAULT_MARKETPLACE_PROXY_URL.replaceAll(".", "\\.")}/`));
  assert.match(calls[1], new RegExp(`^${DEFAULT_MARKETPLACE_INDEX_URL.replaceAll(".", "\\.")}`));
});
