export interface CompanionAppSpec {
  pluginId: string;
  appName: string;
  description: string;
  icon: string;
}

export const COMPANION_CATALOG: CompanionAppSpec[] = [
  { pluginId: "classisland-connector", appName: "ClassIsland", description: "课表、换课和档案配置", icon: "/classisland-icon.png" },
  { pluginId: "class-widgets", appName: "Class Widgets", description: "课表小组件与课程信息", icon: "/cw-icon.png" },
  { pluginId: "secrandom", appName: "SecRandom", description: "随机点名", icon: "/secrandom-logo.png" },
  { pluginId: "secscore-connector", appName: "SecScore", description: "课堂积分", icon: "/SecScore.png" },
  { pluginId: "iccce-connector", appName: "ICC-CE", description: "互动画板", icon: "/iccce-logo.png" }
];

export const COMPANION_PLUGIN_IDS = new Set(COMPANION_CATALOG.map((item) => item.pluginId));
