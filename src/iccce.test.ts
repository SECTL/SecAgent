import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ICCCE_PLUGIN_ASSET_NAME,
  IccceInstaller,
  discoverIccceInstallations,
  resolveIccceLayout
} from "./iccce.js";
import { DEFAULT_MARKETPLACE_PROXY_URL } from "./marketplace.js";

function writeIccceManifest(root: string, version = "0.3.2"): void {
  const manifestPath = path.win32.join(root, "Plugins", "inkcanvas.iccce.secagent", "manifest.json");
  fs.mkdirSync(path.win32.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ Id: "inkcanvas.iccce.secagent", Version: version }));
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
      restartProcess: async (executablePath, args) => { launches.push({ executablePath, args }); writeIccceManifest(root); }
    });
    const [target] = await installer.detect();
    const [result] = await installer.install([target.id]);
    const installedPath = path.win32.join(root, "PluginPackages", ICCCE_PLUGIN_ASSET_NAME);
    assert.equal(result.ok, true);
    assert.equal(result.version, "0.3.2");
    assert.match(result.message, /自动重启/);
    assert.equal(fs.readFileSync(installedPath).toString(), bytes.toString());
    assert.deepEqual(launches, [{ executablePath: exe, args: ["--profile", "classroom"] }]);
    assert.equal(calls[0].startsWith(`${DEFAULT_MARKETPLACE_PROXY_URL}/https://api.github.com/`), true);
    assert.equal(calls[1].startsWith(`${DEFAULT_MARKETPLACE_PROXY_URL}/https://github.com/`), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
