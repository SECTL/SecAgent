export interface CompanionAppSpec {
  pluginId: string;
  appName: string;
  description: string;
}

export const COMPANION_CATALOG: CompanionAppSpec[] = [
  { pluginId: "classisland-connector", appName: "ClassIsland", description: "课表、换课和档案配置" },
  { pluginId: "class-widgets", appName: "Class Widgets", description: "课表小组件与课程信息" },
  { pluginId: "secrandom", appName: "SecRandom", description: "随机点名" },
  { pluginId: "secscore-connector", appName: "SecScore", description: "课堂积分" },
  { pluginId: "iccce-connector", appName: "ICC-CE", description: "互动画板" }
];

export const COMPANION_PLUGIN_IDS = new Set(COMPANION_CATALOG.map((item) => item.pluginId));
