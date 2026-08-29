import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ICCCE_PLUGIN_ASSET_NAME,
  ICCCE_PLUGIN_ID,
  IccceInstaller,
  discoverIccceInstallations,
  resolveIccceLayout
} from "./iccce.js";
import type { CompanionExecutor, HostProcessFilter, HostProcessInfo } from "./companion-package.js";
import { DEFAULT_MARKETPLACE_PROXY_URL } from "./marketplace.js";

function writeIccceManifest(root: string, version = "0.3.2"): void {
  const manifestPath = path.win32.join(root, "Plugins", "inkcanvas.iccce.secagent", "manifest.json");
  fs.mkdirSync(path.win32.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ Id: "inkcanvas.iccce.secagent", Version: version }));
}

/** Formats `now` (+offset) the way ICC-CE stamps host log lines and names daily files. */
function iccceLogStamp(offsetMs = 0): string {
  const time = new Date(Date.now() + offsetMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
}

test("resolves ICC-CE PluginPackages and detects the installed side plugin", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-iccce-"));
  try {
    const exe = path.win32.join(root, "InkCanvasForClass.exe");
    const layout = resolveIccceLayout(exe, { platform: "win32", home: "C:\\Users\\teacher", env: { LOCALAPPDATA: "C:\\Users\\teacher\\AppData\\Local" } });
    fs.mkdirSync(path.win32.join(layout.pluginsPath, "inkcanvas.iccce.secagent"), { recursive: true });
    fs.writeFileSync(exe, "test executable");
    fs.writeFileSync(path.win32.join(layout.pluginsPath, "inkcanvas.iccce.secagent", "manifest.json"), JSON.stringify({ Id: "inkcanvas.iccce.secagent", Version: "0.3.2" }));
    const found = await discoverIccceInstallations({
      platform: "win32",
      executablePaths: [exe],
      exists: (candidate) => fs.existsSync(candidate),
      versionOf: () => "1.7.19.9"
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].pluginPackagesPath, path.win32.join(root, "PluginPackages"));
    assert.equal(found[0].installedPluginVersion, "0.3.2");
    assert.equal(found[0].compatible, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not treat an ICC-CE uninstaller as an application target", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-iccce-uninstaller-"));
  try {
    const uninstaller = path.win32.join(root, "unins000.exe");
    fs.writeFileSync(uninstaller, "uninstaller");
    const found = await discoverIccceInstallations({
      platform: "win32",
      home: "C:\\Users\\teacher",
      env: { LOCALAPPDATA: "C:\\Users\\teacher\\AppData\\Local" },
      commandRunner: async () => ({ stdout: JSON.stringify([uninstaller]), stderr: "" }),
      exists: (candidate) => fs.existsSync(candidate),
      versionOf: () => "1.8.0.2"
    });
    assert.deepEqual(found, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("downloads ICC-CE icpx through ghproxy, verifies it, and restarts the selected instance", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-iccce-install-"));
  try {
    const exe = path.win32.join(root, "InkCanvasForClass.exe");
    fs.writeFileSync(exe, "test executable");
    const bytes = Buffer.from("PK\\x03\\x04 valid icpx bytes");
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const calls: string[] = [];
    const launches: Array<{ executablePath: string; args: string[] }> = [];
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url === "http://127.0.0.1:18790/health") return new Response(JSON.stringify({ apiVersion: 1, name: "iccce", status: "ok" }), { status: 200 });
      if (url.includes("api.github.com")) return new Response(JSON.stringify({ tag_name: "v0.3.2", draft: false, prerelease: false, assets: [{ name: ICCCE_PLUGIN_ASSET_NAME, browser_download_url: "https://github.com/SECTL/ICC-CE-SecAgent-Plugin/releases/download/v0.3.2/ICC-CE.SecAgent.Plugin.icpx", size: bytes.length, digest: `sha256:${digest}` }] }), { status: 200 });
      return new Response(bytes, { status: 200 });
    };
    const installer = new IccceInstaller({
      platform: "win32",
      executablePaths: [exe],
      runningProcesses: [{ executablePath: exe, pid: 123, commandLine: `"${exe}" --profile classroom`, version: "1.7.19.9" }],
      versionOf: () => "1.7.19.9",
      fetcher,
      exists: (candidate) => fs.existsSync(candidate),
      requestGracefulClose: async () => undefined,
      isProcessRunning: async () => false,
      installPackage: async (destinationPath) => destinationPath,
      restartProcess: async (executablePath, args) => { launches.push({ executablePath, args }); writeIccceManifest(root); },
      listProcesses: async () => [],
      closeSettlePollMs: 1
    });
    const [target] = await installer.detect();
    const [result] = await installer.install([target.id]);
    const installedPath = path.win32.join(root, "Plugins", ICCCE_PLUGIN_ID, "manifest.json");
    assert.equal(result.ok, true);
    assert.equal(result.version, "0.3.2");
    assert.match(result.message, /自动重启/);
    assert.equal(fs.existsSync(installedPath), true);
    assert.deepEqual(launches, [{ executablePath: exe, args: ["--profile", "classroom"] }]);
    const marketplaceCalls = calls.filter((url) => url.includes("api.github.com") || url.includes("github.com/SECTL/ICC-CE-SecAgent-Plugin/releases/download"));
    assert.equal(marketplaceCalls[0].startsWith(`${DEFAULT_MARKETPLACE_PROXY_URL}/https://api.github.com/`), true);
    assert.equal(marketplaceCalls[1].startsWith(`${DEFAULT_MARKETPLACE_PROXY_URL}/https://github.com/`), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("terminates the ICC-CE watchdog first and outlives its relaunch before writing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-iccce-watchdog-"));
  try {
    const exe = path.win32.join(root, "InkCanvasForClass.exe");
    fs.writeFileSync(exe, "test executable");
    const bytes = Buffer.from("PK\\x03\\x04 watchdog icpx bytes");
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const closeOrder: number[] = [];
    const launches: Array<{ executablePath: string; args: string[] }> = [];
    let enumerateCalls = 0;
    const listProcesses = async (filter: HostProcessFilter): Promise<HostProcessInfo[]> => {
      enumerateCalls += 1;
      assert.equal(filter.names.includes("InkCanvasForClass.exe"), true);
      assert.deepEqual(filter.roots, [root]);
      if (enumerateCalls === 1) {
        // Watchdog copy of the same exe plus the real app, as StartWatchdogIfNeeded launches them.
        return [
          { pid: 8, name: "InkCanvasForClass.exe", executablePath: exe, commandLine: `"${exe}" --profile classroom` },
          { pid: 10, name: "InkCanvasForClass.exe", executablePath: exe, commandLine: `"${exe}" --watchdog 8 "C:\\iccce-exit.flag"` }
        ];
      }
      // The watchdog fires once after round one; the later quiet checks must come back empty.
      return enumerateCalls === 2 ? [{ pid: 11, name: "InkCanvasForClass.exe", executablePath: exe, commandLine: `"${exe}" --profile classroom` }] : [];
    };
    const installer = new IccceInstaller({
      platform: "win32",
      executablePaths: [exe],
      runningProcesses: [{ executablePath: exe, pid: 8, commandLine: `"${exe}" --profile classroom`, version: "1.7.19.9" }],
      versionOf: () => "1.7.19.9",
      fetcher: async (input: string | URL): Promise<Response> => {
        const url = String(input);
        if (url === "http://127.0.0.1:18790/health") return new Response(JSON.stringify({ apiVersion: 1, name: "iccce", status: "ok" }), { status: 200 });
        if (url.includes("api.github.com")) return new Response(JSON.stringify({ tag_name: "v0.3.2", draft: false, prerelease: false, assets: [{ name: ICCCE_PLUGIN_ASSET_NAME, browser_download_url: "https://github.com/SECTL/ICC-CE-SecAgent-Plugin/releases/download/v0.3.2/ICC-CE.SecAgent.Plugin.icpx", size: bytes.length, digest: `sha256:${digest}` }] }), { status: 200 });
        return new Response(bytes, { status: 200 });
      },
      exists: (candidate) => fs.existsSync(candidate),
      requestGracefulClose: async (pid) => { closeOrder.push(pid); },
      isProcessRunning: async () => false,
      installPackage: async (destinationPath) => destinationPath,
      restartProcess: async (executablePath, args) => { launches.push({ executablePath, args }); writeIccceManifest(root); },
      listProcesses,
      closeSettlePollMs: 1
    });
    const [target] = await installer.detect();
    const [result] = await installer.install([target.id]);
    assert.equal(result.ok, true);
    assert.match(result.message, /自动重启/);
    // The watchdog (pid 10) dies before the app it guards (pid 8), and the relaunch (pid 11) is caught too.
    assert.deepEqual(closeOrder, [10, 8, 11]);
    assert.deepEqual(launches, [{ executablePath: exe, args: ["--profile", "classroom"] }]);
    assert.equal(enumerateCalls >= 6, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("quotes ICC-CE's own plugin load error when the health check fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-iccce-diag-"));
  try {
    const exe = path.win32.join(root, "InkCanvasForClass.exe");
    fs.writeFileSync(exe, "test executable");
    const bytes = Buffer.from("PK\\x03\\x04 diagnostic icpx bytes");
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    // ICC-CE's own view of the failed load: error-recovery bookkeeping plus its
    // host-side plugin log. Neither marks the plugin disabled, so without the
    // diagnostics read the OOBE could only say "服务未响应".
    fs.mkdirSync(path.win32.join(root, "Configs"), { recursive: true });
    fs.writeFileSync(path.win32.join(root, "Configs", "plugin_error_recovery.json"), JSON.stringify([
      {
        PluginId: "inkcanvas.iccce.secagent",
        PluginName: "SecAgent 联动",
        FirstFailureAt: "2026-08-29T04:10:00",
        LastFailureAt: "2026-08-29T04:12:00",
        FailureTimestamps: ["2026-08-29T04:10:00", "2026-08-29T04:12:00"],
        LastErrorMessage: "Could not load file or assembly 'InkCanvas.PluginSdk'.",
        LastStackTrace: "   at Ink_Canvas.Plugins.PluginManager.LoadPlugin(PluginInfo info)",
        AutoDisabled: false
      }
    ]));
    fs.mkdirSync(path.win32.join(root, "PluginLogs", "host"), { recursive: true });
    // The host writes its plugin log during startup, so the fixture writes it
    // from the fake restart with current timestamps — the failure hint must only
    // quote lines written after this attempt's restart began.
    const writeHostLog = (): void => {
      fs.writeFileSync(path.win32.join(root, "PluginLogs", "host", `${iccceLogStamp().slice(0, 10)}.log`), [
        `[${iccceLogStamp()}] [INFO] [host] Loading plugin: SecAgent 联动`,
        `[${iccceLogStamp()}] [ERROR] [host] Failed to load plugin SecAgent 联动 | System.IO.FileNotFoundException: Could not load file or assembly 'InkCanvas.PluginSdk'.`,
        `[${iccceLogStamp()}] [INFO] [host] Plugin loading complete. Loaded 0 plugins`
      ].join("\n"));
    };
    const stages: Array<{ stage: string; data: unknown }> = [];
    const installer = new IccceInstaller({
      platform: "win32",
      executablePaths: [exe],
      runningProcesses: [{ executablePath: exe, pid: 4242, commandLine: `"${exe}"`, version: "1.8.0.2" }],
      versionOf: () => "1.8.0.2",
      fetcher: async (input: string | URL): Promise<Response> => {
        const url = String(input);
        if (url === "http://127.0.0.1:18790/health") return new Response("no listener", { status: 502 });
        if (url.includes("api.github.com")) return new Response(JSON.stringify({ tag_name: "v0.3.2", draft: false, prerelease: false, assets: [{ name: ICCCE_PLUGIN_ASSET_NAME, browser_download_url: "https://github.com/SECTL/ICC-CE-SecAgent-Plugin/releases/download/v0.3.2/ICC-CE.SecAgent.Plugin.icpx", size: bytes.length, digest: `sha256:${digest}` }] }), { status: 200 });
        return new Response(bytes, { status: 200 });
      },
      exists: (candidate) => fs.existsSync(candidate),
      requestGracefulClose: async () => undefined,
      isProcessRunning: async () => false,
      installPackage: async (destinationPath) => destinationPath,
      restartProcess: async () => { writeIccceManifest(root); writeHostLog(); },
      listProcesses: async () => [],
      closeSettlePollMs: 1,
      waitForPluginTimeoutMs: 200,
      waitForPluginPollMs: 50,
      log: (stage, data) => stages.push({ stage, data })
    });
    const [target] = await installer.detect();
    const [result] = await installer.install([target.id]);
    assert.equal(result.ok, false);
    // The failure message must quote what ICC-CE itself recorded, not just the
    // silent health endpoint.
    assert.match(result.message, /ICC-CE 记录的加载错误|ICC-CE 宿主日志/);
    assert.match(result.message, /ICC-CE 宿主日志：.*Failed to load plugin/);
    const diagnostics = stages.find((entry) => entry.stage === "companion.iccce.host.diagnostics");
    assert.ok(diagnostics, "host diagnostics were not logged");
    const data = diagnostics!.data as { recovery?: { failures: number; lastErrorMessage?: string }; hostLog?: { file: string; tail: string }; pluginLog?: { file: string; tail: string } };
    assert.equal(data.recovery?.failures, 2);
    assert.equal(data.recovery?.lastErrorMessage, "Could not load file or assembly 'InkCanvas.PluginSdk'.");
    assert.match(data.hostLog?.file || "", /PluginLogs.*host.*\.log$/);
    assert.match(data.hostLog?.tail || "", /Failed to load plugin/);
    assert.equal(data.pluginLog, undefined);
    // Without an elevated executor the stale record cannot be cleared, but the
    // attempt must be visible in the log, not silent.
    assert.equal(stages.some((entry) => entry.stage === "companion.iccce.errorrecovery.reset"), true);
    assert.equal(stages.some((entry) => entry.stage === "companion.iccce.errorrecovery.reset.skipped"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ignores stale host-log errors from a previous day when the health check fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-iccce-stalelog-"));
  try {
    const exe = path.win32.join(root, "InkCanvasForClass.exe");
    fs.writeFileSync(exe, "test executable");
    const bytes = Buffer.from("PK\\x03\\x04 stale log icpx bytes");
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    // Field case (2026-08-29): the newest host log is still yesterday's and its
    // tail is full of yesterday's unload errors, while the restarted process
    // has not written a single line today — no log file for today even exists.
    // The hint must not blame yesterday's "ALC is still alive" noise for a
    // fresh process that simply has not initialized its plugin host yet.
    fs.mkdirSync(path.win32.join(root, "PluginLogs", "host"), { recursive: true });
    fs.writeFileSync(path.win32.join(root, "PluginLogs", "host", "2026-08-28.log"), [
      "[2026-08-28 12:33:43.553] [INFO] [PluginManager] Plugin loaded: SecAgent 联动 v0.3.2 by SecAgent",
      "[2026-08-28 13:18:49.265] [ERROR] [PluginManager] Plugin ALC for inkcanvas.iccce.secagent is still alive after 10 GC passes; some host reference is pinning it (hot reload will fall back to restart).",
      "[2026-08-28 15:01:26.690] [ERROR] [PluginManager] Plugin ALC for inkcanvas.iccce.secagent is still alive after 10 GC passes; some host reference is pinning it (hot reload will fall back to restart)."
    ].join("\n"));
    const installer = new IccceInstaller({
      platform: "win32",
      executablePaths: [exe],
      runningProcesses: [{ executablePath: exe, pid: 4242, commandLine: `"${exe}"`, version: "1.8.0.2" }],
      versionOf: () => "1.8.0.2",
      fetcher: async (input: string | URL): Promise<Response> => {
        const url = String(input);
        if (url === "http://127.0.0.1:18790/health") return new Response("no listener", { status: 502 });
        if (url.includes("api.github.com")) return new Response(JSON.stringify({ tag_name: "v0.3.2", draft: false, prerelease: false, assets: [{ name: ICCCE_PLUGIN_ASSET_NAME, browser_download_url: "https://github.com/SECTL/ICC-CE-SecAgent-Plugin/releases/download/v0.3.2/ICC-CE.SecAgent.Plugin.icpx", size: bytes.length, digest: `sha256:${digest}` }] }), { status: 200 });
        return new Response(bytes, { status: 200 });
      },
      exists: (candidate) => fs.existsSync(candidate),
      requestGracefulClose: async () => undefined,
      isProcessRunning: async () => false,
      installPackage: async (destinationPath) => destinationPath,
      restartProcess: async () => { writeIccceManifest(root); },
      listProcesses: async () => [],
      closeSettlePollMs: 1,
      waitForPluginTimeoutMs: 200,
      waitForPluginPollMs: 50
    });
    const [target] = await installer.detect();
    const [result] = await installer.install([target.id]);
    assert.equal(result.ok, false);
    // Yesterday's unload errors are not this failure's cause and must not be
    // quoted; the honest report is that the host wrote nothing new.
    assert.doesNotMatch(result.message, /ALC|still alive/);
    assert.match(result.message, /未写入新的插件日志/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("clears only this plugin's stale error-recovery record before restarting ICC-CE", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-iccce-reset-"));
  try {
    const exe = path.win32.join(root, "InkCanvasForClass.exe");
    fs.writeFileSync(exe, "test executable");
    const bytes = Buffer.from("PK\\x03\\x04 reset icpx bytes");
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    fs.mkdirSync(path.win32.join(root, "Configs"), { recursive: true });
    fs.writeFileSync(path.win32.join(root, "Configs", "plugin_error_recovery.json"), JSON.stringify([
      { PluginId: "someone.else.plugin", PluginName: "Unrelated", FailureTimestamps: ["2026-08-29T03:00:00"], AutoDisabled: true },
      { PluginId: "inkcanvas.iccce.secagent", PluginName: "SecAgent 联动", FailureTimestamps: ["2026-08-29T04:00:00"], LastErrorMessage: "boom", AutoDisabled: true }
    ]));
    const writes: Array<{ filePath: string; bytes: Buffer }> = [];
    const executor: CompanionExecutor = {
      writePackage: async (filePath, fileBytes) => { writes.push({ filePath, bytes: fileBytes }); return filePath; },
      installPackage: async (destinationPath) => destinationPath,
      requestGracefulClose: async () => true,
      forceTerminate: async () => undefined,
      isProcessRunning: async () => false,
      startProcess: async () => undefined,
      close: async () => undefined
    };
    const installer = new IccceInstaller({
      platform: "win32",
      executablePaths: [exe],
      runningProcesses: [{ executablePath: exe, pid: 77, commandLine: `"${exe}"`, version: "1.8.0.2" }],
      versionOf: () => "1.8.0.2",
      fetcher: async (input: string | URL): Promise<Response> => {
        const url = String(input);
        if (url === "http://127.0.0.1:18790/health") return new Response(JSON.stringify({ apiVersion: 1, name: "iccce", status: "ok" }), { status: 200 });
        if (url.includes("api.github.com")) return new Response(JSON.stringify({ tag_name: "v0.3.2", draft: false, prerelease: false, assets: [{ name: ICCCE_PLUGIN_ASSET_NAME, browser_download_url: "https://github.com/SECTL/ICC-CE-SecAgent-Plugin/releases/download/v0.3.2/ICC-CE.SecAgent.Plugin.icpx", size: bytes.length, digest: `sha256:${digest}` }] }), { status: 200 });
        return new Response(bytes, { status: 200 });
      },
      exists: (candidate) => fs.existsSync(candidate),
      requestGracefulClose: async () => undefined,
      isProcessRunning: async () => false,
      installPackage: async (destinationPath) => destinationPath,
      restartProcess: async () => { writeIccceManifest(root); },
      listProcesses: async () => [],
      closeSettlePollMs: 1
    });
    const [target] = await installer.detect();
    const [result] = await installer.install([target.id], undefined, executor);
    assert.equal(result.ok, true);
    const recoveryWrites = writes.filter((write) => write.filePath.endsWith("plugin_error_recovery.json"));
    assert.equal(recoveryWrites.length, 1);
    const rewritten = JSON.parse(recoveryWrites[0].bytes.toString("utf8")) as Array<{ PluginId: string }>;
    assert.deepEqual(rewritten.map((record) => record.PluginId), ["someone.else.plugin"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("relaunches ICC-CE through the elevated worker when its install root is not writable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-iccce-elevated-"));
  try {
    const exe = path.win32.join(root, "InkCanvasForClass.exe");
    fs.writeFileSync(exe, "test executable");
    const bytes = Buffer.from("PK\\x03\\x04 elevated restart icpx bytes");
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const elevatedLaunches: Array<{ executablePath: string; args: string[] }> = [];
    const plainLaunches: Array<{ executablePath: string; args: string[] }> = [];
    const stages: Array<{ stage: string; data: unknown }> = [];
    const executor: CompanionExecutor = {
      writePackage: async (filePath, fileBytes) => { fs.mkdirSync(path.win32.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, fileBytes); return filePath; },
      installPackage: async (destinationPath) => destinationPath,
      requestGracefulClose: async () => true,
      forceTerminate: async () => undefined,
      isProcessRunning: async () => false,
      startProcess: async (executablePath, args) => { elevatedLaunches.push({ executablePath, args }); writeIccceManifest(root); },
      close: async () => undefined
    };
    // Field case (2026-08-29): ICC-CE lives under Program Files, so only the
    // admin token that installed the plugin can also relaunch a host that can
    // create PluginConfigs/<id>/ — a same-elevation relaunch from non-elevated
    // SecAgent silently drops the plugin instead of loading it.
    const installer = new IccceInstaller({
      platform: "win32",
      executablePaths: [exe],
      runningProcesses: [{ executablePath: exe, pid: 9001, commandLine: `"${exe}" --profile classroom`, version: "1.8.0.2" }],
      versionOf: () => "1.8.0.2",
      isDirectoryWritable: () => false,
      fetcher: async (input: string | URL): Promise<Response> => {
        const url = String(input);
        if (url === "http://127.0.0.1:18790/health") return new Response(JSON.stringify({ apiVersion: 1, name: "iccce", status: "ok" }), { status: 200 });
        if (url.includes("api.github.com")) return new Response(JSON.stringify({ tag_name: "v0.3.2", draft: false, prerelease: false, assets: [{ name: ICCCE_PLUGIN_ASSET_NAME, browser_download_url: "https://github.com/SECTL/ICC-CE-SecAgent-Plugin/releases/download/v0.3.2/ICC-CE.SecAgent.Plugin.icpx", size: bytes.length, digest: `sha256:${digest}` }] }), { status: 200 });
        return new Response(bytes, { status: 200 });
      },
      exists: (candidate) => fs.existsSync(candidate),
      requestGracefulClose: async () => undefined,
      isProcessRunning: async () => false,
      installPackage: async (destinationPath) => destinationPath,
      restartProcess: async (executablePath, args) => { plainLaunches.push({ executablePath, args }); },
      listProcesses: async () => [],
      closeSettlePollMs: 1,
      log: (stage, data) => stages.push({ stage, data })
    });
    const [target] = await installer.detect();
    const [result] = await installer.install([target.id], undefined, executor);
    assert.equal(result.ok, true);
    assert.deepEqual(elevatedLaunches, [{ executablePath: exe, args: ["--profile", "classroom"] }]);
    assert.deepEqual(plainLaunches, []);
    const elevatedStage = stages.find((entry) => entry.stage === "companion.iccce.process.restart.elevated");
    assert.ok(elevatedStage, "elevated restart decision was not logged");
    assert.equal((elevatedStage!.data as { viaExecutor: boolean }).viaExecutor, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("falls back to an explicit elevated relaunch when no elevated worker survived", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-iccce-elevated-fallback-"));
  try {
    const exe = path.win32.join(root, "InkCanvasForClass.exe");
    fs.writeFileSync(exe, "test executable");
    const bytes = Buffer.from("PK\\x03\\x04 elevated fallback icpx bytes");
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const elevatedLaunches: Array<{ executablePath: string; args: string[] }> = [];
    const plainLaunches: Array<{ executablePath: string; args: string[] }> = [];
    const installer = new IccceInstaller({
      platform: "win32",
      executablePaths: [exe],
      runningProcesses: [{ executablePath: exe, pid: 9002, commandLine: `"${exe}"`, version: "1.8.0.2" }],
      versionOf: () => "1.8.0.2",
      isDirectoryWritable: () => false,
      fetcher: async (input: string | URL): Promise<Response> => {
        const url = String(input);
        if (url === "http://127.0.0.1:18790/health") return new Response(JSON.stringify({ apiVersion: 1, name: "iccce", status: "ok" }), { status: 200 });
        if (url.includes("api.github.com")) return new Response(JSON.stringify({ tag_name: "v0.3.2", draft: false, prerelease: false, assets: [{ name: ICCCE_PLUGIN_ASSET_NAME, browser_download_url: "https://github.com/SECTL/ICC-CE-SecAgent-Plugin/releases/download/v0.3.2/ICC-CE.SecAgent.Plugin.icpx", size: bytes.length, digest: `sha256:${digest}` }] }), { status: 200 });
        return new Response(bytes, { status: 200 });
      },
      exists: (candidate) => fs.existsSync(candidate),
      requestGracefulClose: async () => undefined,
      isProcessRunning: async () => false,
      installPackage: async (destinationPath) => destinationPath,
      restartProcess: async (executablePath, args) => { plainLaunches.push({ executablePath, args }); },
      restartElevatedProcess: async (executablePath, args) => { elevatedLaunches.push({ executablePath, args }); writeIccceManifest(root); },
      listProcesses: async () => [],
      closeSettlePollMs: 1
    });
    const [target] = await installer.detect();
    // No executor: nothing elevated is alive, so the relaunch must still take
    // the elevated route (here observable only through the override).
    const [result] = await installer.install([target.id], undefined, undefined);
    assert.equal(result.ok, true);
    assert.deepEqual(elevatedLaunches, [{ executablePath: exe, args: [] }]);
    assert.deepEqual(plainLaunches, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keeps the same-elevation relaunch when the install root is writable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-iccce-elevated-writable-"));
  try {
    const exe = path.win32.join(root, "InkCanvasForClass.exe");
    fs.writeFileSync(exe, "test executable");
    const bytes = Buffer.from("PK\\x03\\x04 writable root icpx bytes");
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const elevatedLaunches: Array<{ executablePath: string; args: string[] }> = [];
    const plainLaunches: Array<{ executablePath: string; args: string[] }> = [];
    const installer = new IccceInstaller({
      platform: "win32",
      executablePaths: [exe],
      runningProcesses: [{ executablePath: exe, pid: 9003, commandLine: `"${exe}"`, version: "1.8.0.2" }],
      versionOf: () => "1.8.0.2",
      isDirectoryWritable: () => true,
      fetcher: async (input: string | URL): Promise<Response> => {
        const url = String(input);
        if (url === "http://127.0.0.1:18790/health") return new Response(JSON.stringify({ apiVersion: 1, name: "iccce", status: "ok" }), { status: 200 });
        if (url.includes("api.github.com")) return new Response(JSON.stringify({ tag_name: "v0.3.2", draft: false, prerelease: false, assets: [{ name: ICCCE_PLUGIN_ASSET_NAME, browser_download_url: "https://github.com/SECTL/ICC-CE-SecAgent-Plugin/releases/download/v0.3.2/ICC-CE.SecAgent.Plugin.icpx", size: bytes.length, digest: `sha256:${digest}` }] }), { status: 200 });
        return new Response(bytes, { status: 200 });
      },
      exists: (candidate) => fs.existsSync(candidate),
      requestGracefulClose: async () => undefined,
      isProcessRunning: async () => false,
      installPackage: async (destinationPath) => destinationPath,
      restartProcess: async (executablePath, args) => { plainLaunches.push({ executablePath, args }); writeIccceManifest(root); },
      restartElevatedProcess: async (executablePath, args) => { elevatedLaunches.push({ executablePath, args }); },
      listProcesses: async () => [],
      closeSettlePollMs: 1
    });
    const [target] = await installer.detect();
    const [result] = await installer.install([target.id]);
    // A LOCALAPPDATA-style install loads plugins fine without the admin token,
    // so the relaunch stays same-elevation and never bothers the elevated route.
    assert.equal(result.ok, true);
    assert.deepEqual(plainLaunches, [{ executablePath: exe, args: [] }]);
    assert.deepEqual(elevatedLaunches, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
