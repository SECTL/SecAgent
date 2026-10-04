export interface CompanionRecommendationInput {
  plugins: PluginStatus[];
  classIslandTargets: ClassIslandInstallCandidate[];
  secRandomTargets: SecRandomInstallCandidate[];
  iccceTargets: IccceInstallCandidate[];
  cwTargets: ClassWidgetsInstallCandidate[];
}

// Which dual-end companion apps deserve a card on the OOBE plugins page.
// A card must be backed by real evidence — otherwise a machine that never had
// the companion app installed would still be offered its linkage card (the
// bug: Class Widgets shown without Class Widgets installed). The app qualifies
// when:
//   1. auto-detection found it (`detected`), or
//   2. its SecAgent-side connector is already installed (the user has started
//      configuring this linkage), or
//   3. an installation target was found or manually picked (the user selected
//      an executable via the file dialog), which covers non-standard installs.
export function filterRecommendedCompanionApps(
  apps: DetectedCompanionApp[],
  input: CompanionRecommendationInput
): DetectedCompanionApp[] {
  return apps.filter((app) => {
    if (app.detected) return true;
    if (input.plugins.some((plugin) => plugin.id === app.pluginId)) return true;
    switch (app.pluginId) {
      case "classisland-connector": return input.classIslandTargets.length > 0;
      case "secrandom": return input.secRandomTargets.length > 0;
      case "iccce-connector": return input.iccceTargets.length > 0;
      case "class-widgets": return input.cwTargets.length > 0;
      default: return false;
    }
  });
}
