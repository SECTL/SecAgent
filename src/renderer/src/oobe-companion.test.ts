import assert from "node:assert/strict";
import test from "node:test";
import type { PluginStatus } from "../../types.js";
import { filterRecommendedCompanionApps, MANUAL_COMPANION_PLUGIN_IDS } from "./oobe-companion.js";

function app(pluginId: string, detected = false): Parameters<typeof filterRecommendedCompanionApps>[0][number] {
  return { pluginId, appName: pluginId, description: "", icon: "", detected };
}

function plugin(id: string): PluginStatus {
  return { id, name: id, version: "1.0.0", enabled: true, state: "ready", settingsPages: [] };
}

test("omits companion apps with no evidence on the machine", () => {
  const apps = [
    app("classisland-connector"),
    app("class-widgets"),
    app("secrandom"),
    app("iccce-connector"),
    app("secscore-connector")
  ];
  const recommended = filterRecommendedCompanionApps(apps, [], {});
  assert.deepEqual(recommended.map((item) => item.pluginId), []);
});

test("keeps only detected apps when nothing else is configured", () => {
  const apps = [
    app("classisland-connector"),
    app("class-widgets", true),
    app("secrandom")
  ];
  const recommended = filterRecommendedCompanionApps(apps, [], {});
  assert.deepEqual(recommended.map((item) => item.pluginId), ["class-widgets"]);
});

test("keeps apps whose SecAgent-side connector plugin is already installed", () => {
  const apps = [app("class-widgets"), app("secrandom")];
  const recommended = filterRecommendedCompanionApps(apps, [plugin("class-widgets")], {});
  assert.deepEqual(recommended.map((item) => item.pluginId), ["class-widgets"]);
});

test("keeps apps with a manually added install target", () => {
  const apps = [app("class-widgets"), app("secrandom")];
  const recommended = filterRecommendedCompanionApps(apps, [], { "class-widgets": 1 });
  assert.deepEqual(recommended.map((item) => item.pluginId), ["class-widgets"]);
});

test("a zero manual target count does not keep a card", () => {
  const apps = [app("class-widgets")];
  const recommended = filterRecommendedCompanionApps(apps, [], { "class-widgets": 0 });
  assert.deepEqual(recommended.map((item) => item.pluginId), []);
});

test("manual-configuration set covers only the dual-end companion apps", () => {
  assert.deepEqual(MANUAL_COMPANION_PLUGIN_IDS, ["classisland-connector", "secrandom", "iccce-connector", "class-widgets"]);
});
