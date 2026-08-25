import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CLASSISLAND_PLUGIN_ASSET_NAME,
  ClassIslandInstaller,
  compareClassIslandVersions,
  discoverClassIslandInstallations,
  isCompatibleClassIslandVersion,
  resolveClassIslandLayout
} from "./classisland.js";
import { DEFAULT_MARKETPLACE_PROXY_URL } from "./marketplace.js";

test("ClassIsland versions enforce the 2.1.1.0 minimum", () => {
  assert.equal(compareClassIslandVersions("2.1.1.0", "2.1.1.0"), 0);
  assert.equal(compareClassIslandVersions("2.1.1.1", "2.1.1.0") > 0, true);
  assert.equal(compareClassIslandVersions("2.1.0.9", "2.1.1.0") < 0, true);
  assert.equal(isCompatibleClassIslandVersion("2.1.1.0"), true);
  assert.equal(isCompatibleClassIslandVersion("2.1.0.9"), false);
  assert.equal(isCompatibleClassIslandVersion(undefined), false);
});

test("resolves portable and installer ClassIsland data directories", () => {
  const home = "C:\\Users\\teacher";
  const env = { APPDATA: "C:\\Users\\teacher\\AppData\\Roaming" };
  const portableExe = "D:\\Apps\\ClassIsland\\ClassIsland.exe";
  const portable = resolveClassIslandLayout(portableExe, {
    platform: "win32",
    home,
    env,
    readFile: (filePath) => filePath.endsWith("\\PackageType") ? "folder\n" : ""
  });
  assert.equal(portable.dataRoot, "D:\\Apps\\ClassIsland\\data");
  assert.equal(portable.pluginPackagesPath, "D:\\Apps\\ClassIsland\\data\\Cache\\PluginPackages");

  const installedExe = "C:\\Program Files\\ClassIsland\\ClassIsland.exe";
  const installed = resolveClassIslandLayout(installedExe, {
    platform: "win32",
    home,
    env,
    readFile: (filePath) => filePath.endsWith("\\PackageType") ? "installer\n" : ""
  });
  assert.equal(installed.dataRoot, "C:\\Users\\teacher\\AppData\\Roaming\\ClassIsland\\Data");
});

test("discovers multiple ClassIsland versions and marks old versions incompatible", async () => {
  const paths = ["C:\\Portable\\ClassIsland.exe", "D:\\Old\\ClassIsland.exe", "C:\\Program Files\\ClassIsland\\ClassIsland.exe"];
  const versions: Record<string, string> = {
    [paths[0]]: "2.1.1.0",
    [paths[1]]: "2.0.4.0",
    [paths[2]]: "2.1.1.0"
  };
  const found = await discoverClassIslandInstallations({
    platform: "win32",
    home: "C:\\Users\\teacher",
    env: { APPDATA: "C:\\Users\\teacher\\AppData\\Roaming" },
    executablePaths: paths,
    runningProcesses: [{ executablePath: paths[0], pid: 12, commandLine: `"${paths[0]}" --quiet`, version: versions[paths[0]] }],
    exists: (candidate) => paths.includes(candidate),
    versionOf: (executablePath) => versions[executablePath],
    readFile: (filePath) => filePath.endsWith("\\PackageType") ? (filePath.includes("Portable") ? "folder" : "installer") : ""
  });
  assert.equal(found.length, 3);
  assert.equal(found.find((item) => item.executablePath === paths[0])?.isRunning, true);
  assert.deepEqual(found.find((item) => item.executablePath === paths[0])?.launchArgs, ["--quiet"]);
  assert.equal(found.find((item) => item.executablePath === paths[1])?.compatible, false);
  assert.match(found.find((item) => item.executablePath === paths[1])?.reason || "", /2\.1\.1\.0/);
});

test("scans Windows external locations when the installer has no explicit executable paths", async () => {
  const exe = "C:\\Program Files\\ClassIsland\\ClassIsland.exe";
  const commandRunner = async (_file: string, args: string[]) => ({
    stdout: args.join(" ").includes("WScript.Shell") ? "[]" : JSON.stringify([exe]),
    stderr: ""
  });
  const installer = new ClassIslandInstaller({
    platform: "win32",
    executablePaths: [],
    commandRunner,
    versionOf: () => "2.1.1.0",
    exists: (candidate) => candidate === exe,
    readFile: () => "installer"
  });
  const [target] = await installer.detect();
  assert.equal(target?.executablePath, exe);
  assert.equal(target?.source, "discovery");
});

test("downloads through ghproxy first, verifies the asset, and installs to the selected portable instance", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-classisland-"));
  try {
    const exe = path.win32.join(root, "ClassIsland.exe");
    const packageType = path.win32.join(root, "PackageType");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(exe, "test executable");
    fs.writeFileSync(packageType, "folder\n");
    const bytes = Buffer.from("valid cipx bytes");
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const calls: string[] = [];
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url.includes("api.github.com")) return new Response(JSON.stringify({ tag_name: "0.1.0.1", draft: false, prerelease: false, assets: [{ name: CLASSISLAND_PLUGIN_ASSET_NAME, browser_download_url: "https://github.com/SECTL/ClassIsland-SecAgent-Plugin/releases/download/0.1.0.1/ClassIsland.SecAgent.Plugin.cipx", size: bytes.length, digest: `sha256:${digest}` }] }), { status: 200 });
      return new Response(bytes, { status: 200 });
    };
    const installer = new ClassIslandInstaller({
      platform: "win32",
      executablePaths: [exe],
      runningProcesses: [],
      versionOf: () => "2.1.1.0",
      fetcher,
      exists: (candidate) => fs.existsSync(candidate),
      now: () => 123
    });
    const [target] = await installer.detect();
    const [result] = await installer.install([target.id]);
    const installedPath = path.win32.join(root, "data", "Cache", "PluginPackages", CLASSISLAND_PLUGIN_ASSET_NAME);
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(installedPath).toString(), bytes.toString());
    assert.equal(calls[0].startsWith(`${DEFAULT_MARKETPLACE_PROXY_URL}/https://api.github.com/`), true);
    assert.equal(calls[1].startsWith(`${DEFAULT_MARKETPLACE_PROXY_URL}/https://github.com/`), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("falls back from the proxy to direct GitHub for both release metadata and the asset", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-classisland-fallback-"));
  try {
    const exe = path.win32.join(root, "ClassIsland.exe");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(exe, "test executable");
    fs.writeFileSync(path.win32.join(root, "PackageType"), "folder\n");
    const bytes = Buffer.from("fallback cipx bytes");
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const calls: string[] = [];
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith(`${DEFAULT_MARKETPLACE_PROXY_URL}/`)) return new Response("proxy unavailable", { status: 503 });
      if (url.includes("api.github.com")) return new Response(JSON.stringify({ tag_name: "0.1.0.1", assets: [{ name: CLASSISLAND_PLUGIN_ASSET_NAME, browser_download_url: "https://github.com/SECTL/ClassIsland-SecAgent-Plugin/releases/download/0.1.0.1/ClassIsland.SecAgent.Plugin.cipx", digest: `sha256:${digest}`, size: bytes.length }] }), { status: 200 });
      return new Response(bytes, { status: 200 });
    };
    const installer = new ClassIslandInstaller({ platform: "win32", executablePaths: [exe], runningProcesses: [], versionOf: () => "2.1.1.0", fetcher, exists: (candidate) => fs.existsSync(candidate) });
    const [target] = await installer.detect();
    const [result] = await installer.install([target.id]);
    assert.equal(result.ok, true);
    assert.equal(calls.length, 4);
    assert.equal(calls[0].startsWith(`${DEFAULT_MARKETPLACE_PROXY_URL}/https://api.github.com/`), true);
    assert.equal(calls[1].startsWith("https://api.github.com/"), true);
    assert.equal(calls[2].startsWith(`${DEFAULT_MARKETPLACE_PROXY_URL}/https://github.com/`), true);
    assert.equal(calls[3].startsWith("https://github.com/"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not write a package when ClassIsland is too old or the digest is invalid", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-classisland-"));
  try {
    const exe = path.win32.join(root, "ClassIsland.exe");
    fs.writeFileSync(exe, "test executable");
    const oldInstaller = new ClassIslandInstaller({ platform: "win32", executablePaths: [exe], runningProcesses: [], versionOf: () => "2.1.0.9", exists: (candidate) => fs.existsSync(candidate) });
    const [oldTarget] = await oldInstaller.detect();
    const [oldResult] = await oldInstaller.install([oldTarget.id]);
    assert.equal(oldResult.action, "skipped");
    assert.equal(fs.existsSync(path.win32.join(root, "data", "Cache", "PluginPackages", CLASSISLAND_PLUGIN_ASSET_NAME)), false);

    const bytes = Buffer.from("invalid digest");
    const invalidInstaller = new ClassIslandInstaller({
      platform: "win32",
      executablePaths: [exe],
      runningProcesses: [],
      versionOf: () => "2.1.1.0",
      exists: (candidate) => fs.existsSync(candidate),
      fetcher: async (input: string | URL) => String(input).includes("api.github.com")
        ? new Response(JSON.stringify({ tag_name: "0.1.0.1", assets: [{ name: CLASSISLAND_PLUGIN_ASSET_NAME, browser_download_url: "https://github.com/example/plugin.cipx", digest: `sha256:${"0".repeat(64)}`, size: bytes.length }] }), { status: 200 })
        : new Response(bytes, { status: 200 })
    });
    const [target] = await invalidInstaller.detect();
    await assert.rejects(() => invalidInstaller.install([target.id]), /SHA-256/);
    assert.equal(fs.existsSync(path.win32.join(root, "Cache", "PluginPackages", CLASSISLAND_PLUGIN_ASSET_NAME)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not force-terminate or write when a running ClassIsland cannot close", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-classisland-"));
  try {
    const exe = path.win32.join(root, "ClassIsland.exe");
    fs.writeFileSync(exe, "test executable");
    const installer = new ClassIslandInstaller({
      platform: "win32",
      executablePaths: [exe],
      runningProcesses: [{ executablePath: exe, pid: 123, version: "2.1.1.0" }],
      exists: (candidate) => fs.existsSync(candidate),
      requestGracefulClose: async () => { throw new Error("still running"); },
      fetcher: async (input: string | URL) => String(input).includes("api.github.com")
        ? new Response(JSON.stringify({ tag_name: "0.1.0.1", assets: [{ name: CLASSISLAND_PLUGIN_ASSET_NAME, browser_download_url: "https://github.com/example/plugin.cipx", digest: `sha256:${crypto.createHash("sha256").update("x").digest("hex")}`, size: 1 }] }), { status: 200 })
        : new Response("x", { status: 200 })
    });
    const [target] = await installer.detect();
    const [result] = await installer.install([target.id]);
    assert.equal(result.ok, false);
    assert.match(result.message, /未能正常退出/);
    assert.equal(fs.existsSync(path.win32.join(root, "data", "Cache", "PluginPackages", CLASSISLAND_PLUGIN_ASSET_NAME)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
