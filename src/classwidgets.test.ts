import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";
import {
  ClassWidgetsInstaller,
  compareClassWidgetsVersions,
  discoverClassWidgetsInstallations,
  isCompatibleClassWidgetsVersion,
  resolveClassWidgetsLayout
} from "./classwidgets.js";

function writeCwPluginManifest(pluginsRoot: string, version = "0.1.0"): void {
  const manifest = JSON.stringify({ id: "cn.sectl.secagent", name: "SecAgent 联动", version, api_version: "~=0.4.2", entry: "main.py" });
  // POSIX hosts treat win32-joined paths (a leading "/" normalized into "\")
  // as cwd-relative backslash names, while discovery reads manifests through
  // the win32-joined spelling. Create the directory once via the slash
  // spelling so both forms land inside it, then write each file in both
  // spellings — on Windows they name the same files.
  fs.mkdirSync(`${pluginsRoot}/cn.sectl.secagent`, { recursive: true });
  fs.writeFileSync(path.win32.join(pluginsRoot, "cn.sectl.secagent", "cwplugin.json"), manifest);
  fs.writeFileSync(path.win32.join(pluginsRoot, "cn.sectl.secagent", "main.py"), "print('test')");
  fs.writeFileSync(`${pluginsRoot}/cn.sectl.secagent/cwplugin.json`, manifest);
  fs.writeFileSync(`${pluginsRoot}/cn.sectl.secagent/main.py`, "print('test')");
}

function removeCwPlugin(pluginsRoot: string): void {
  fs.rmSync(path.win32.join(pluginsRoot, "cn.sectl.secagent"), { recursive: true, force: true });
  fs.rmSync(`${pluginsRoot}/cn.sectl.secagent`, { recursive: true, force: true });
}

/** Builds a minimal valid cwplugin zip (manifest + entry at the archive root). */
function cwPluginZip(manifest: string): Buffer {
  const zip = new AdmZip();
  zip.addFile("cwplugin.json", Buffer.from(manifest, "utf8"));
  zip.addFile("main.py", Buffer.from("print('secagent')", "utf8"));
  const archivePath = path.join(os.tmpdir(), `secagent-cw-package-${crypto.randomUUID()}.zip`);
  try {
    zip.writeZip(archivePath);
    return fs.readFileSync(archivePath);
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

test("Class Widgets versions enforce the 2.0.0.0 minimum", () => {
  assert.equal(compareClassWidgetsVersions("2.0.0.0", "2.0.0.0"), 0);
  assert.equal(compareClassWidgetsVersions("2.0.0.2", "2.0.0.0") > 0, true);
  assert.equal(compareClassWidgetsVersions("1.2.0.5", "2.0.0.0") < 0, true);
  assert.equal(isCompatibleClassWidgetsVersion("2.0.0.2"), true);
  assert.equal(isCompatibleClassWidgetsVersion("1.2.0.5"), false);
  assert.equal(isCompatibleClassWidgetsVersion(undefined), false);
});

test("resolves portable and non-portable Class Widgets plugin directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-cw-layout-"));
  try {
    const portableExe = path.win32.join(root, "ClassWidgets.exe");
    fs.mkdirSync(path.win32.join(root, "plugins"), { recursive: true });
    fs.writeFileSync(path.win32.join(root, "plugins", "marker"), "");
    const portable = resolveClassWidgetsLayout(portableExe, { platform: "win32", home: "C:\\Users\\teacher", env: { APPDATA: "C:\\Users\\teacher\\AppData\\Roaming" } });
    assert.equal(portable.pluginsPath, path.win32.join(root, "plugins"));

    const installed = resolveClassWidgetsLayout("C:\\Program Files\\Class Widgets\\ClassWidgets.exe", {
      platform: "win32",
      home: "C:\\Users\\teacher",
      env: { APPDATA: "C:\\Users\\teacher\\AppData\\Roaming" },
      exists: () => false
    });
    assert.equal(installed.pluginsPath, "C:\\Users\\teacher\\AppData\\Roaming\\Class Widgets\\plugins");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("discovers Class Widgets installations and validates the cwplugin manifest", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-cw-discover-"));
  try {
    const exe = path.win32.join(root, "ClassWidgets.exe");
    fs.writeFileSync(exe, "stub");
    const pluginsRoot = path.win32.join(root, "plugins");
    fs.mkdirSync(pluginsRoot, { recursive: true });
    fs.writeFileSync(`${root}/plugins-marker`, "");
    // Portable layout: the plugins directory exists next to the executable.
    // POSIX splits win32-joined and slash-joined spellings, so probe files are
    // written with both (identical on Windows).
    fs.writeFileSync(path.win32.join(pluginsRoot, ".keep"), "");
    writeCwPluginManifest(pluginsRoot);
    const found = await discoverClassWidgetsInstallations({
      platform: "win32",
      home: "C:\\Users\\teacher",
      env: { APPDATA: path.win32.join(root, "Roaming"), LOCALAPPDATA: path.win32.join(root, "Local") },
      executablePaths: [exe],
      exists: (candidate) => {
        const normalized = candidate.replaceAll("/", "\\").toLowerCase();
        if (normalized === exe.toLowerCase()) return true;
        if (normalized === path.win32.join(pluginsRoot, ".keep").toLowerCase()) return true;
        // Manifest + entry probes via the layout resolver's portable check.
        if (normalized.endsWith("plugins")) return true;
        if (normalized.endsWith("cwplugin.json") || normalized.endsWith("main.py")) return true;
        return false;
      },
      versionOf: () => "2.0.0.2",
      readFile: (filePath) => {
        if (filePath.toLowerCase().endsWith("cwplugin.json")) {
          return JSON.stringify({ id: "cn.sectl.secagent", version: "0.1.0", entry: "main.py" });
        }
        return "";
      }
    });
    assert.equal(found.length, 1);
    const candidate = found[0];
    assert.equal(candidate.compatible, true);
    assert.equal(candidate.installedPluginVersion, "0.1.0");
    assert.equal(candidate.isRunning, false);
    assert.match(candidate.pluginsPath.toLowerCase(), /plugins$/);

    // A host below the minimum is reported incompatible with a reason.
    const old = await discoverClassWidgetsInstallations({
      platform: "win32",
      home: "C:\\Users\\teacher",
      env: {},
      executablePaths: [exe],
      exists: (candidate) => candidate.replaceAll("/", "\\").toLowerCase() === exe.toLowerCase(),
      versionOf: () => "1.2.0.5"
    });
    assert.equal(old[0]?.compatible, false);
    assert.match(old[0]?.reason || "", /2\.0\.0\.0/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installs the cwplugin package and verifies the entry after restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-cw-install-"));
  try {
    const exe = path.win32.join(root, "ClassWidgets.exe");
    fs.writeFileSync(exe, "stub");
    const pluginsRoot = path.win32.join(root, "plugins");
    // Slash-spelled mkdir so POSIX creates a real directory that both path
    // spellings resolve into (see writeCwPluginManifest).
    fs.mkdirSync(`${pluginsRoot}/existing`, { recursive: true });
    fs.writeFileSync(`${pluginsRoot}/existing/keep`, "");

    const manifest = JSON.stringify({ id: "cn.sectl.secagent", name: "SecAgent 联动", version: "0.1.0", api_version: "~=0.4.2", entry: "main.py" });
    const zipBytes = cwPluginZip(manifest);

    const healthResponses: number[] = [];
    const releaseTag = "v0.1.0";
    const digest = crypto.createHash("sha256").update(zipBytes).digest("hex");
    const fetcher = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === "http://127.0.0.1:18791/health") {
        healthResponses.push(1);
        return new Response(JSON.stringify({ apiVersion: 1, name: "classwidgets", status: "ok" }), { status: 200 });
      }
      if (url.includes("api.github.com") && url.includes("releases/latest")) {
        return new Response(JSON.stringify({
          tag_name: releaseTag,
          draft: false,
          prerelease: false,
          assets: [{ name: "cn.sectl.secagent.cwplugin", browser_download_url: "https://github.com/SECTL/ClassWidgets-SecAgent-Plugin/releases/download/v0.1.0/cn.sectl.secagent.cwplugin", digest: `sha256:${digest}` }]
        }), { status: 200 });
      }
      if (url.includes("/releases/download/")) return new Response(new Uint8Array(zipBytes), { status: 200 });
      throw new Error(`unexpected URL ${url}`);
    };
    let restarted = 0;
    const installer = new ClassWidgetsInstaller({
      platform: "win32",
      home: root,
      env: { APPDATA: path.win32.join(root, "Roaming") },
      executablePaths: [exe],
      exists: (candidate) => {
        const normalized = candidate.replaceAll("/", "\\").toLowerCase();
        if (normalized === exe.toLowerCase()) return true;
        if (normalized.endsWith("plugins")) return true;
        if (normalized.endsWith(".keep")) return true;
        if (normalized.endsWith("cwplugin.json") || normalized.endsWith("main.py")) return true;
        return false;
      },
      versionOf: () => "2.0.0.2",
      readFile: (filePath) => filePath.toLowerCase().endsWith("cwplugin.json") ? manifest : "",
      fetcher,
      restartProcess: async () => { restarted += 1; },
      listProcesses: async () => [],
      isProcessRunning: async () => false,
      installPackage: (destinationPath, bytes, spec) => {
        assert.equal(spec.pluginId, "cn.sectl.secagent");
        assert.equal(spec.manifestFileName, "cwplugin.json");
        const pluginDir = path.win32.dirname(destinationPath);
        fs.mkdirSync(`${pluginDir}/cn.sectl.secagent`, { recursive: true });
        fs.writeFileSync(`${pluginDir}/cn.sectl.secagent/cwplugin.json`, manifest);
        fs.writeFileSync(path.win32.join(pluginDir, "cn.sectl.secagent", "cwplugin.json"), manifest);
        assert.ok(bytes.length > 0);
        return destinationPath;
      },
      waitForPluginTimeoutMs: 2_000,
      waitForPluginPollMs: 100
    });
    const detected = await installer.detect();
    assert.equal(detected.length, 1);
    const results = await installer.install([detected[0].id]);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true, results[0].message);
    assert.equal(results[0].action, "installed");
    assert.match(results[0].message, /v/);
    assert.equal(restarted, 1, "installer launches the host once to load the plugin");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a cwplugin package whose manifest id does not match", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-cw-invalid-"));
  try {
    const destination = path.join(root, "plugins", "cn.sectl.secagent");
    fs.mkdirSync(destination, { recursive: true });
    const bytes = cwPluginZip(JSON.stringify({ id: "com.other.plugin", entry: "main.py", version: "1.0.0" }));
    const { installCompanionPackage } = await import("./companion-package.js");
    await assert.rejects(
      () => installCompanionPackage(destination, bytes, { pluginId: "cn.sectl.secagent", manifestFileName: "cwplugin.json" }, process.platform),
      /ID 不匹配/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
