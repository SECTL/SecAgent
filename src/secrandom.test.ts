import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SECRANDOM_PLUGIN_ASSET_NAME,
  SECRANDOM_PLUGIN_RELEASE_TAG,
  SecRandomInstaller,
  discoverSecRandomInstallations,
  isCompatibleSecRandomVersion,
  resolveSecRandomLayout
} from "./secrandom.js";
import { DEFAULT_MARKETPLACE_PROXY_URL } from "./marketplace.js";

function writeSecRandomManifest(root: string, version = "1.0.3"): void {
  const manifestPath = path.win32.join(root, "data", "plugins", "secrandom.secagent", "manifest.yml");
  fs.mkdirSync(path.win32.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `id: secrandom.secagent\nentranceAssembly: SecRandom.SecAgentPlugin.dll\nversion: ${version}\n`);
  fs.writeFileSync(path.win32.join(path.win32.dirname(manifestPath), "SecRandom.SecAgentPlugin.dll"), "test assembly");
}

test("resolves portable and installed SecRandom data directories", () => {
  const home = "C:\\Users\\teacher";
  const env = { LOCALAPPDATA: "C:\\Users\\teacher\\AppData\\Local" };
  const portableExe = "D:\\Apps\\SecRandom\\app-v3.0.0-0\\SecRandom.Desktop.exe";
  const portable = resolveSecRandomLayout(portableExe, {
    platform: "win32",
    home,
    env,
    exists: (candidate) => candidate.endsWith("\\SecRandom.package.json"),
    readFile: () => JSON.stringify({ packageKind: "portable-zip" })
  });
  assert.equal(portable.dataRoot, "D:\\Apps\\SecRandom\\data");
  assert.equal(portable.pluginPackagesPath, "D:\\Apps\\SecRandom\\data\\cache\\plugin-packages");

  const installedExe = "C:\\Program Files\\SECTL\\SecRandom\\SecRandom.Desktop.exe";
  const installed = resolveSecRandomLayout(installedExe, {
    platform: "win32",
    home,
    env,
    exists: (candidate) => candidate.endsWith("\\SecRandom.package.json"),
    readFile: () => JSON.stringify({ packageKind: "windows-exe" })
  });
  assert.equal(installed.dataRoot, "C:\\Users\\teacher\\AppData\\Local\\SecRandom\\data");
});

test("does not use a stale package data directory when the active root is the fallback", async () => {
  const exe = "C:\\Program Files\\SECTL\\SecRandom\\SecRandom.Desktop.exe";
  const markerPath = "C:\\Program Files\\SECTL\\SecRandom\\SecRandom.package.json";
  const staleManifestPath = "C:\\Program Files\\SECTL\\SecRandom\\data\\plugins\\secrandom.secagent\\manifest.yml";
  const found = await discoverSecRandomInstallations({
    platform: "win32",
    home: "C:\\Users\\teacher",
    env: { LOCALAPPDATA: "C:\\Users\\teacher\\AppData\\Local" },
    executablePaths: [exe],
    runningProcesses: [],
    exists: (candidate) => candidate === exe || candidate === markerPath || candidate === staleManifestPath,
    versionOf: () => "3.0.0-alpha.2",
    readFile: (filePath) => filePath === markerPath
      ? JSON.stringify({ packageKind: "windows-exe" })
      : "id: secrandom.secagent\nentranceAssembly: SecRandom.SecAgentPlugin.dll\nversion: 1.0.2\n"
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].installedPluginVersion, undefined);
});

test("enforces the SecRandom v3 plugin API minimum and detects running targets", async () => {
  assert.equal(isCompatibleSecRandomVersion("3.0.0-alpha.1"), true);
  assert.equal(isCompatibleSecRandomVersion("2.3.15"), false);
  assert.equal(isCompatibleSecRandomVersion(undefined), false);

  const exe = "C:\\Portable\\SecRandom\\app-v3.0.0-0\\SecRandom.Desktop.exe";
  const found = await discoverSecRandomInstallations({
    platform: "win32",
    home: "C:\\Users\\teacher",
    env: { LOCALAPPDATA: "C:\\Users\\teacher\\AppData\\Local" },
    executablePaths: [exe],
    runningProcesses: [{ executablePath: exe, pid: 17, commandLine: `"${exe}" --profile demo`, version: "3.0.0-alpha.2" }],
    exists: (candidate) => candidate === exe,
    versionOf: () => "3.0.0-alpha.2",
    readFile: () => JSON.stringify({ packageKind: "portable-zip" })
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].isRunning, true);
  assert.deepEqual(found[0].launchArgs, ["--profile", "demo"]);
  assert.equal(found[0].compatible, true);
});

test("reports not-loaded when plugin files exist but the SecRandom HTTP endpoint never responds", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-secrandom-"));
  try {
    const exe = path.win32.join(root, "app-v3.0.0-0", "SecRandom.Desktop.exe");
    const appRoot = path.win32.dirname(exe);
    fs.mkdirSync(appRoot, { recursive: true });
    fs.writeFileSync(exe, "test executable");
    fs.writeFileSync(path.win32.join(appRoot, "SecRandom.package.json"), JSON.stringify({ packageKind: "portable-zip" }));
    const bytes = Buffer.from("valid srpx bytes");
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:3910/")) return new Response(JSON.stringify({ error: "not listening" }), { status: 404 });
      if (url.includes("api.github.com")) return new Response(JSON.stringify({ tag_name: "v1.0.3", draft: false, prerelease: false, assets: [{ name: SECRANDOM_PLUGIN_ASSET_NAME, browser_download_url: "https://github.com/SECTL/SecRandom-SecAgent-Plugin/releases/download/v1.0.3/SecRandom.SecAgentPlugin.srpx", size: bytes.length, digest: `sha256:${digest}` }] }), { status: 200 });
      return new Response(bytes, { status: 200 });
    };
    const installer = new SecRandomInstaller({
      platform: "win32",
      executablePaths: [exe],
      runningProcesses: [{ executablePath: exe, pid: 71, commandLine: `"${exe}"`, version: "3.0.0-alpha.2" }],
      versionOf: () => "3.0.0-alpha.2",
      fetcher,
      exists: (candidate) => fs.existsSync(candidate),
      requestGracefulClose: async () => undefined,
      isProcessRunning: async () => false,
      installPackage: async (destinationPath) => destinationPath,
      restartProcess: async () => { writeSecRandomManifest(root); },
      listProcesses: async () => [],
      closeSettlePollMs: 1,
      waitForPluginTimeoutMs: 200,
      waitForPluginPollMs: 50
    });
    const [target] = await installer.detect();
    assert.equal(target.pluginHealthy, false);
    assert.equal(target.healthReason, "SecRandom 插件接口返回 HTTP 404");
    const [result] = await installer.install([target.id]);
    assert.equal(result.ok, false);
    assert.match(result.message, /尚未加载插件/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("downloads through ghproxy, verifies SRPX, stages it, and restarts SecRandom", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-secrandom-"));
  try {
    const exe = path.win32.join(root, "app-v3.0.0-0", "SecRandom.Desktop.exe");
    const appRoot = path.win32.dirname(exe);
    fs.mkdirSync(appRoot, { recursive: true });
    fs.writeFileSync(exe, "test executable");
    fs.writeFileSync(path.win32.join(appRoot, "SecRandom.package.json"), JSON.stringify({ packageKind: "portable-zip" }));
    const bytes = Buffer.from("valid srpx bytes");
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const calls: string[] = [];
    const launches: Array<{ executablePath: string; args: string[] }> = [];
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("http://127.0.0.1:3910/")) return new Response(JSON.stringify({ profile: "default", students: [] }), { status: 200 });
      if (url.includes("api.github.com")) return new Response(JSON.stringify({ tag_name: "v1.0.3", draft: false, prerelease: false, assets: [{ name: SECRANDOM_PLUGIN_ASSET_NAME, browser_download_url: "https://github.com/SECTL/SecRandom-SecAgent-Plugin/releases/download/v1.0.3/SecRandom.SecAgentPlugin.srpx", size: bytes.length, digest: `sha256:${digest}` }] }), { status: 200 });
      return new Response(bytes, { status: 200 });
    };
    const installer = new SecRandomInstaller({
      platform: "win32",
      executablePaths: [exe],
      runningProcesses: [{ executablePath: exe, pid: 99, commandLine: `"${exe}" --profile school`, version: "3.0.0-alpha.2" }],
      versionOf: () => "3.0.0-alpha.2",
      fetcher,
      exists: (candidate) => fs.existsSync(candidate),
      requestGracefulClose: async () => undefined,
      isProcessRunning: async () => false,
      installPackage: async (destinationPath) => destinationPath,
      restartProcess: async (executablePath, args) => { launches.push({ executablePath, args }); writeSecRandomManifest(root); },
      listProcesses: async () => [],
      closeSettlePollMs: 1
    });
    const [target] = await installer.detect();
    const [result] = await installer.install([target.id]);
    const installedPath = path.win32.join(root, "data", "plugins", "secrandom.secagent", "manifest.yml");
    assert.equal(result.ok, true);
    assert.match(result.message, /自动重启/);
    assert.equal(fs.existsSync(installedPath), true);
    assert.deepEqual(launches, [{ executablePath: exe, args: ["--profile", "school"] }]);
    assert.equal(calls.some((url) => url.startsWith("http://127.0.0.1:3910/api/secagent/v1/students")), true);
    assert.equal(calls.find((url) => url.includes("api.github.com"))!.startsWith(`${DEFAULT_MARKETPLACE_PROXY_URL}/https://api.github.com/`), true);
    // The download must resolve the pinned release tag, not "latest": plugin
    // v1.0.2 shipped without its HTTP transport, so "latest" installs a plugin
    // that can never answer the 3910 health check.
    assert.equal(calls.some((url) => url.includes(`/releases/tags/${SECRANDOM_PLUGIN_RELEASE_TAG}`)), true);
    assert.equal(calls.find((url) => url.includes("/releases/download/"))!.startsWith(`${DEFAULT_MARKETPLACE_PROXY_URL}/https://github.com/`), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
