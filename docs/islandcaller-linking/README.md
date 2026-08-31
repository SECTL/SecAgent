# IslandCaller 联动支持（Issue #3 实现）

本目录包含 issue #3「ClassIsland 联动插件：新增 IslandCaller 支持」的完整实现补丁。

> 说明：本次运行环境中的 GitHub Token 仅对 `SECTL/SecAgent` 仓库有写权限，
> 无法直接向三个目标仓库推送分支/创建 PR，因此以补丁形式随本 PR 交付。
> 每个补丁都可直接应用（`git apply` / `git am`）到对应仓库的 `main` 分支。

## 变更内容

### 1. `SECTL/ClassIsland-SecAgent-Plugin`（`classisland-secagent-plugin.patch`）

在 `Plugin.cs`（ClassIsland 端 HTTP 服务插件）中新增 4 个工具，全部通过反射访问
IslandCaller 服务，无需改动 IslandCaller 本体、也不建立编译期依赖：

- `call_island_caller`（默认展示，非 hidden）：`count`（1–20，默认 1）→ 反射调用
  `IslandCallerService.ShowRandomStudent(count)`，读取 `HistoryService.top20List`
  返回被点学生名单；IslandCaller 未安装 / 未就绪 / 名单为空时返回结构化结果而非抛错。
- `list_island_caller_profiles`（hidden）：列出 `Settings.Instance.Profile.ProfileList`
  已登记的名单（ID、名称、当前/默认标记）。
- `read_island_caller_roster`（hidden）：按 `profile_id`（缺省为当前活动名单）读取
  `ProfileService.GetMembers` 返回的学生成员。
- `write_island_caller_roster`（hidden）：`members` 数组 → `ProfileService.SaveProfile`；
  写入当前活动名单时经 `ProfileRuntimeService.Reload` 热重载；名单未登记时用
  `profile_name` 补登记并保存 IslandCaller 设置。

`manifest.yml` 版本 bump 至 `0.1.0.2`，README 补充 IslandCaller 说明。

### 2. `SECTL/ClassIsland-SecAgent-Connector`（`classisland-secagent-connector.patch`）

- `secagent-plugin.json`：权限追加 `agent.pre_rules`，版本 bump 至 `1.1.0`。
- `main.mjs`：仿 SecRandom 连接插件新增前置规则 `islandcaller_call`，正则匹配
  「点名 / 随机点名 / 点个名 / 抽人 / 抽个学生 / 随机抽X人」等说法（支持阿拉伯数字与中文数字
  数量），命中后直接调用 `call_island_caller` 并渲染「点到：XXX」；连接成功时注册、断开时注销。
- `scripts/build.mjs`：从 `secagent-plugin.json` 读取版本生成
  `classisland-connector-{version}.zip`（本版本产出 `1.1.0`）。
- `skills/classisland/SKILL.md` 与 `README.md`：补充 IslandCaller 工具与点名说明。

### 3. `SECTL/secagent-plugin-marketplace`（`secagent-plugin-marketplace.patch`）

`plugins/classisland-connector.json` 的 `permissions` 增加 `agent.pre_rules`，
与连接插件 `secagent-plugin.json` 保持一致（索引由 20 分钟定时任务自动重新生成）。

## 验证结果

- `ClassIsland-SecAgent-Plugin`：`dotnet build -c Debug` 通过，0 警告 0 错误。
- `ClassIsland-SecAgent-Connector`：`node --check main.mjs` 通过；`npm run build`
  生成 `dist/classisland-connector-1.1.0.zip`；前置规则 19 组用例（13 命中 / 6 不命中）全部通过。
- 三个补丁均已在对应仓库的干净 `main` 上 `git apply --check` 验证可应用。

## 剩余发布步骤（需要仓库写权限）

1. 将三个补丁分别应用到各自仓库的 `main`（或按补丁新建分支并 PR）。
2. `ClassIsland-SecAgent-Plugin`：构建并发布 `ClassIsland.SecAgent.Plugin.cipx` 到
   v0.1.0.2 Release（ClassIsland 侧市场分发）。
3. `ClassIsland-SecAgent-Connector`：构建 `dist/classisland-connector-1.1.0.zip` 并上传到
   `v1.1.0` GitHub Release。
4. `secagent-plugin-marketplace` 的定时索引任务会自动把新 Release 纳入签名索引，
   SecAgent 侧 10 分钟自动更新即可收到。

## 已知行为提示

- 若用户同时安装 SecRandom 与 ClassIsland 两个连接插件，「点名」类关键词可能被两者前置规则
  同时匹配；SecAgent 按插件注册顺序取第一个命中（`src/plugin-manager.ts` 的 `matchPreRule`），
  行为是先注册者优先。
- `call_island_caller` 依赖 IslandCaller 的 `Status.IsPluginReady`（名单已加载、服务已初始化）；
  未就绪时返回明确原因，前置规则会把原因渲染给用户，不会假装点名成功。
