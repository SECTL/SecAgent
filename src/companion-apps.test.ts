import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { detectCompanionApps } from "./companion-apps.js";

test("detects Class Widgets from the Linux config directory", () => {
  const home = "/home/teacher";
  const detected = detectCompanionApps({
    home,
    env: {},
    exists: (candidate) => candidate === path.join(home, ".class-widgets")
  });
  const widgets = detected.find((app) => app.pluginId === "class-widgets");
  assert.equal(widgets?.detected, true);
  assert.equal(detected.filter((app) => app.detected).length, 1);
});

test("detects ClassIsland from LocalAppData", () => {
  const home = "C:\\Users\\teacher";
  const local = "C:\\Users\\teacher\\AppData\\Local";
  const detected = detectCompanionApps({
    home,
    env: { LOCALAPPDATA: local, APPDATA: "C:\\Users\\teacher\\AppData\\Roaming" },
    exists: (candidate) => candidate === path.join(local, "ClassIsland")
  });
  assert.equal(detected.find((app) => app.pluginId === "classisland-connector")?.detected, true);
});
