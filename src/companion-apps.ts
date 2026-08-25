import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMPANION_CATALOG, type CompanionAppSpec } from "./companion-catalog.js";

export type { CompanionAppSpec };

export interface DetectedCompanionApp extends CompanionAppSpec {
  detected: boolean;
  evidence?: string;
}

export { COMPANION_CATALOG, COMPANION_PLUGIN_IDS } from "./companion-catalog.js";

export function companionCatalog(): CompanionAppSpec[] {
  return COMPANION_CATALOG.map((item) => ({ ...item }));
}

export function detectCompanionApps(options: {
  home?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
} = {}): DetectedCompanionApp[] {
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const exists = options.exists || ((candidate: string) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  });
  return COMPANION_CATALOG.map((app) => {
    const evidence = candidatePaths(app.pluginId, home, env).find(exists);
    return { ...app, detected: Boolean(evidence), ...(evidence ? { evidence } : {}) };
  });
}

function candidatePaths(pluginId: string, home: string, env: NodeJS.ProcessEnv): string[] {
  const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const roaming = env.APPDATA || path.join(home, "AppData", "Roaming");
  const programFiles = env.PROGRAMFILES || "C:\\Program Files";
  const programFilesX86 = env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const names = appDirNames(pluginId);
  const roots = [
    local,
    roaming,
    path.join(local, "Programs"),
    programFiles,
    programFilesX86,
    path.join(home, ".config"),
    path.join(home, ".local", "share"),
    path.join(home, "Library", "Application Support"),
    "/opt",
    "/usr/share/applications",
    path.join(home, ".local", "share", "applications"),
    "/Applications"
  ];
  const paths = names.flatMap((name) => roots.map((root) => path.join(root, name)));
  if (pluginId === "secscore-connector") {
    // SecScore is a Tauri desktop app. Cover both the usual install directory
    // and portable/single-executable layouts used by its Windows bundles.
    paths.push(...roots.flatMap((root) => [
      path.join(root, "SecScore", "SecScore.exe"),
      path.join(root, "SecScore", "secscore.exe"),
      path.join(root, "SecScore.exe"),
      path.join(root, "secscore.exe")
    ]));
  }
  if (pluginId === "class-widgets") {
    paths.push(path.join(home, ".class-widgets"), path.join(roaming, "Class Widgets"), path.join(local, "ClassWidgets"));
  }
  if (pluginId === "classisland-connector") {
    paths.push(path.join("/Applications", "ClassIsland.app"));
  }
  if (pluginId === "iccce-connector") {
    paths.push(path.join("/Applications", "ICC-CE.app"), path.join(local, "icc-ce"), path.join(home, ".config", "icc-ce"));
  }
  return [...new Set(paths)];
}

function appDirNames(pluginId: string): string[] {
  if (pluginId === "classisland-connector") return ["ClassIsland", "classisland.desktop"];
  if (pluginId === "class-widgets") return ["Class Widgets", "ClassWidgets", "class-widgets", "class-widgets.desktop"];
  if (pluginId === "secrandom") return ["SecRandom", "secrandom", "secrandom.desktop"];
  if (pluginId === "secscore-connector") return ["SecScore", "secscore", "secscore.desktop"];
  if (pluginId === "iccce-connector") return ["ICC-CE", "ICC CE", "iccce", "icc-ce.desktop"];
  return [];
}
