import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writePendingUpdate } from "../update.js";
import { WindowsUpdateManager } from "./update-manager.js";

function preferences() {
  return { channel: "preview" as const, autoCheck: true, autoDownload: false, autoInstallOnQuit: false };
}

test("reports why an unpackaged Windows build cannot check for updates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-update-manager-"));
  const logs: Array<{ stage: string; data: unknown }> = [];
  try {
    const manager = new WindowsUpdateManager({
      currentVersion: "0.1.0-alpha.2",
      preferences: preferences(),
      platform: "win32",
      isPackaged: false,
      storageDirectory: root,
      publish: () => undefined,
      quit: () => undefined,
      launchInstaller: () => undefined,
      log: (stage, data) => logs.push({ stage, data })
    });
    const state = await manager.check();
    assert.equal(state.status, "unsupported");
    assert.match(state.error || "", /开发版本/);
    assert.equal(logs.some((entry) => entry.stage === "updates.check.unsupported"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not request the same update installation twice", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-update-install-once-"));
  const updatesRoot = path.join(root, "updates");
  const installerPath = path.join(updatesRoot, "SecAgent-Setup-1.1.0.exe");
  const logs: Array<{ stage: string; data: unknown }> = [];
  fs.mkdirSync(updatesRoot, { recursive: true });
  fs.writeFileSync(installerPath, "installer");
  writePendingUpdate(path.join(updatesRoot, "pending-update.json"), {
    path: installerPath,
    version: "1.1.0",
    channel: "preview",
    sha256: "0".repeat(64),
    assetName: "SecAgent-Setup-1.1.0.exe",
    downloadedAt: new Date().toISOString()
  });
  let quitCalls = 0;
  let launches = 0;
  try {
    const manager = new WindowsUpdateManager({
      currentVersion: "1.0.0",
      preferences: preferences(),
      platform: "win32",
      isPackaged: true,
      storageDirectory: root,
      publish: () => undefined,
      quit: () => { quitCalls += 1; },
      launchInstaller: () => { launches += 1; },
      log: (stage, data) => logs.push({ stage, data })
    });
    assert.equal(manager.install().status, "installing");
    assert.equal(manager.install().status, "installing");
    assert.equal(quitCalls, 1);
    manager.handleBeforeQuit();
    manager.handleBeforeQuit();
    assert.equal(launches, 1);
    assert.equal(logs.filter((entry) => entry.stage === "updates.install.skipped").length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
