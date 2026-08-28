import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";
import { installCompanionPackage } from "./companion-package.js";

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
