import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SECRANDOM_PLUGIN_ASSET_NAME,
  SecRandomInstaller,
  discoverSecRandomInstallations,
  isCompatibleSecRandomVersion,
  resolveSecRandomLayout
} from "./secrandom.js";
import { DEFAULT_MARKETPLACE_PROXY_URL } from "./marketplace.js";

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
      if (url.includes("api.github.com")) return new Response(JSON.stringify({ tag_name: "v1.0.1", draft: false, prerelease: false, assets: [{ name: SECRANDOM_PLUGIN_ASSET_NAME, browser_download_url: "https://github.com/SECTL/SecRandom-SecAgent-Plugin/releases/download/v1.0.1/SecRandom.SecAgentPlugin.srpx", size: bytes.length, digest: `sha256:${digest}` }] }), { status: 200 });
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
      restartProcess: async (executablePath, args) => { launches.push({ executablePath, args }); }
    });
    const [target] = await installer.detect();
    const [result] = await installer.install([target.id]);
    const installedPath = path.win32.join(root, "data", "cache", "plugin-packages", SECRANDOM_PLUGIN_ASSET_NAME);
    assert.equal(result.ok, true);
    assert.match(result.message, /自动重启/);
    assert.equal(fs.readFileSync(installedPath).toString(), bytes.toString());
    assert.deepEqual(launches, [{ executablePath: exe, args: ["--profile", "school"] }]);
    assert.equal(calls[0].startsWith(`${DEFAULT_MARKETPLACE_PROXY_URL}/https://api.github.com/`), true);
    assert.equal(calls[1].startsWith(`${DEFAULT_MARKETPLACE_PROXY_URL}/https://github.com/`), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

