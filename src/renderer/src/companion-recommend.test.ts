import assert from "node:assert/strict";
import test from "node:test";
import { filterRecommendedCompanionApps } from "./companion-recommend.js";

function app(pluginId: string, detected = false): DetectedCompanionApp {
  return { pluginId, appName: pluginId, description: "", icon: "", detected };
}

function plugin(id: string): PluginStatus {
  return { id, name: id, version: "0.1.0", enabled: true, state: "ready", settingsPages: [] };
}

const ALL_APPS: DetectedCompanionApp[] = [
  app("classisland-connector"),
  app("class-widgets"),
  app("secrandom"),
  app("iccce-connector"),
  app("secscore-connector")
];

const emptyInput = {
  plugins: [] as PluginStatus[],
  classIslandTargets: [] as ClassIslandInstallCandidate[],
  secRandomTargets: [] as SecRandomInstallCandidate[],
  iccceTargets: [] as IccceInstallCandidate[],
  cwTargets: [] as ClassWidgetsInstallCandidate[]
};

test("shows no cards on a fresh machine without any companion app installed", () => {
  const recommended = filterRecommendedCompanionApps(ALL_APPS, emptyInput);
  assert.deepEqual(recommended, []);
});

test("shows a card when the app was auto-detected", () => {
  const detected = ALL_APPS.map((item) => item.pluginId === "class-widgets" ? { ...item, detected: true } : item);
  const recommended = filterRecommendedCompanionApps(detected, emptyInput);
  assert.deepEqual(recommended.map((item) => item.pluginId), ["class-widgets"]);
});

test("shows a card when its SecAgent connector plugin is already installed", () => {
  const recommended = filterRecommendedCompanionApps(ALL_APPS, { ...emptyInput, plugins: [plugin("class-widgets")] });
  assert.deepEqual(recommended.map((item) => item.pluginId), ["class-widgets"]);
});

test("shows a card when a manual installation target was picked", () => {
  const recommended = filterRecommendedCompanionApps(ALL_APPS, { ...emptyInput, cwTargets: [{} as ClassWidgetsInstallCandidate] });
  assert.deepEqual(recommended.map((item) => item.pluginId), ["class-widgets"]);
});

test("each linkage app is gated by its own target list", () => {
  const recommended = filterRecommendedCompanionApps(ALL_APPS, { ...emptyInput, classIslandTargets: [{} as ClassIslandInstallCandidate] });
  assert.deepEqual(recommended.map((item) => item.pluginId), ["classisland-connector"]);
});

test("single-end apps without detection are never force-listed", () => {
  const recommended = filterRecommendedCompanionApps([app("secscore-connector")], emptyInput);
  assert.deepEqual(recommended, []);
});
