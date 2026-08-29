import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";
import { ELEVATED_WORKER_SCRIPT, elevatedWorkerScriptFileContents, installCompanionPackage } from "./companion-package.js";

function archiveBytes(manifestName: string, manifest: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(manifestName, Buffer.from(manifest, "utf8"));
  zip.addFile("Companion.Plugin.dll", Buffer.from("test dll", "utf8"));
  const archivePath = path.join(os.tmpdir(), `secagent-companion-package-${crypto.randomUUID()}.zip`);
  try {
    zip.writeZip(archivePath);
    return fs.readFileSync(archivePath);
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

test("installs a YAML companion package into the final plugin directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-companion-direct-"));
  try {
    const destination = path.join(root, "data", "Plugins", "classisland.secagent");
    const bytes = archiveBytes("manifest.yml", "id: classisland.secagent\nentranceAssembly: Companion.Plugin.dll\nversion: 1.0.0\n");
    const events: string[] = [];
    const actual = await installCompanionPackage(destination, bytes, { pluginId: "classisland.secagent", manifestFileName: "manifest.yml" }, process.platform, undefined, (stage) => events.push(stage));
    assert.equal(actual, destination);
    assert.equal(fs.existsSync(path.join(destination, "manifest.yml")), true);
    assert.equal(fs.existsSync(path.join(destination, "Companion.Plugin.dll")), true);
    assert.equal(events.includes("package.install.direct.success"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("replaces an existing companion package and preserves its disabled marker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-companion-replace-"));
  try {
    const destination = path.join(root, "Plugins", "inkcanvas.iccce.secagent");
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, ".disabled"), "");
    fs.writeFileSync(path.join(destination, "old.dll"), "old");
    const bytes = archiveBytes("manifest.json", JSON.stringify({ Id: "inkcanvas.iccce.secagent", EntranceAssembly: "Companion.Plugin.dll", Version: "1.0.0" }));
    await installCompanionPackage(destination, bytes, { pluginId: "inkcanvas.iccce.secagent", manifestFileName: "manifest.json" }, process.platform);
    assert.equal(fs.existsSync(path.join(destination, ".disabled")), true);
    assert.equal(fs.existsSync(path.join(destination, "old.dll")), false);
    assert.equal(fs.existsSync(path.join(destination, "Companion.Plugin.dll")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an invalid companion package before touching the destination", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-companion-invalid-"));
  try {
    const destination = path.join(root, "Plugins", "secrandom.secagent");
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, "keep.txt"), "keep");
    const bytes = archiveBytes("manifest.yml", "id: another.plugin\nentranceAssembly: Companion.Plugin.dll\n");
    await assert.rejects(
      () => installCompanionPackage(destination, bytes, { pluginId: "secrandom.secagent", manifestFileName: "manifest.yml" }, process.platform),
      /ID 不匹配/
    );
    assert.equal(fs.existsSync(path.join(destination, "keep.txt")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("elevated worker script never reassigns the case-insensitive $Root variable", () => {
  // PowerShell variables are case-insensitive: `$root = ...` or
  // `foreach ($root in ...)` clobbers the worker's $Root parameter and
  // silently redirects the whole request loop into a host install
  // directory — the alpha.13 stall where every elevated operation timed out.
  assert.equal(/\$root\s*(=|\+=|-=|\+\+|--)/i.test(ELEVATED_WORKER_SCRIPT), false, "script assigns $root (case-insensitive collision with the $Root parameter)");
  assert.equal(/foreach\s*\(\s*\$root\s+in\b/i.test(ELEVATED_WORKER_SCRIPT), false, "script loops over $root (case-insensitive collision with the $Root parameter)");
});

test("elevated worker script file starts with a UTF-8 BOM", () => {
  // PowerShell 5.1 reads a BOM-less .ps1 with the system ANSI codepage. On
  // Western locales the UTF-8 continuation bytes of the Chinese diagnostics
  // decode to smart quotes (U+2018-U+201D), which PowerShell accepts as string
  // delimiters: the literals close early, parsing aborts at startup, and the
  // elevated worker never becomes ready. The BOM makes every locale read the
  // script as UTF-8 — this guards the write helper against regressing.
  assert.equal(elevatedWorkerScriptFileContents().charCodeAt(0), 0xfeff, "worker script file must start with a UTF-8 BOM");
});

test("elevated worker keeps answering after an enumerate request (real protocol run)", { skip: process.platform !== "win32" }, async (t) => {
  const protocolRoot = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-worker-protocol-"));
  const fakeInstallRoot = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-worker-install-"));
  const scriptPath = path.join(protocolRoot, "worker.ps1");
  fs.writeFileSync(scriptPath, elevatedWorkerScriptFileContents(), "utf8");
  const child = spawn("powershell.exe", [
    "-NoProfile", "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", scriptPath, "-Root", protocolRoot
  ], { stdio: ["ignore", "ignore", "ignore"] });
  t.after(() => {
    if (child.exitCode === null) child.kill();
    fs.rmSync(protocolRoot, { recursive: true, force: true });
    fs.rmSync(fakeInstallRoot, { recursive: true, force: true });
  });
  const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };
  const sendRequest = async (id: string, body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> => {
    fs.writeFileSync(path.join(protocolRoot, `request-${id}.json`), JSON.stringify({ id, ...body }), "utf8");
    if (!await waitFor(() => fs.existsSync(path.join(protocolRoot, `result-${id}.json`)), 20_000)) return undefined;
    const response = JSON.parse(fs.readFileSync(path.join(protocolRoot, `result-${id}.json`), "utf8")) as Record<string, unknown>;
    fs.rmSync(path.join(protocolRoot, `result-${id}.json`), { force: true });
    return response;
  };

  assert.equal(await waitFor(() => fs.existsSync(path.join(protocolRoot, "ready")), 30_000), true, "worker never became ready");

  // enumerate with roots pointing at another directory: this request used to
  // overwrite $Root (case-insensitive `$root` loop variable) and silence the
  // worker for every operation that followed.
  const enumerated = await sendRequest("aaaa0000-0000-0000-0000-000000000001", { action: "enumerate", data: { names: ["DefinitelyNotRunning.exe"], roots: [fakeInstallRoot] } });
  assert.equal(enumerated?.ok, true, "enumerate was not answered");
  assert.deepEqual(enumerated?.processes, []);
  assert.equal(fs.readdirSync(fakeInstallRoot).length, 0, "enumerate leaked a result file into the roots directory");

  // The worker must still watch its protocol directory afterwards.
  const probe = await sendRequest("aaaa0000-0000-0000-0000-000000000002", { action: "is-running", data: { pid: process.pid } });
  assert.equal(probe?.ok, true, "worker went silent after the enumerate request");
  assert.equal(probe?.running, true);

  fs.writeFileSync(path.join(protocolRoot, "request-shutdown.json"), JSON.stringify({ id: "shutdown", action: "shutdown", data: {} }), "utf8");
  assert.equal(await waitFor(() => child.exitCode !== null, 15_000), true, "worker ignored the shutdown request");
  assert.equal(child.exitCode, 0);
});
