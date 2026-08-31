import type { DetectedCompanionApp } from "../../companion-apps.js";
import type { PluginStatus } from "../../types.js";

/**
 * The dual-end companion apps the OOBE can configure manually by picking an
 * executable. SecScore only needs the SecAgent-side plugin, so it is never
 * offered for manual target selection here.
 */
export const MANUAL_COMPANION_PLUGIN_IDS: readonly string[] = [
  "classisland-connector",
  "secrandom",
  "iccce-connector",
  "class-widgets"
];

/**
 * Number of manually added install targets per companion app (i.e. targets
 * the user picked through the "选择可执行文件" flow). Only apps that the user
 * has actually opted into this way keep their OOBE card.
 */
export type ManualCompanionTargetCounts = Record<string, number>;

/**
 * Decides which companion-app cards the OOBE "安装课堂联动插件" page shows.
 *
 * A card is rendered only when the app is relevant to this machine in some
 * way:
 *  1. the companion app was auto-detected on disk (`app.detected`);
 *  2. its SecAgent-side connector plugin is already installed (the linkage was
 *     configured in a previous session); or
 *  3. the user has manually added an install target (picked the executable).
 *
 * Apps with no evidence — e.g. Class Widgets on a machine that never had it —
 * are omitted so the page stops implying they were detected or installed.
 */
export function filterRecommendedCompanionApps(
  apps: DetectedCompanionApp[],
  plugins: PluginStatus[],
  manualTargetCounts: ManualCompanionTargetCounts
): DetectedCompanionApp[] {
  return apps.filter((app) => (
    app.detected ||
    plugins.some((plugin) => plugin.id === app.pluginId) ||
    (manualTargetCounts[app.pluginId] ?? 0) > 0
  ));
}
