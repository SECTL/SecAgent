# SecAgent 插件开发

SecAgent 插件是可移植的 zip 包，包内包含 JavaScript、JSON、Skill 和静态资源。入口文件导出 `activate(api)`，工具 key 由宿主自动生成为 `<plugin-id>__<tool-name>`。

## 清单

```json
{
  "apiVersion": 1,
  "id": "my-app",
  "name": "我的应用",
  "version": "1.0.0",
  "main": "main.mjs",
  "permissions": ["agent.tools", "agent.skills", "network.http"]
}
```

工具插件通常声明 `agent.tools`；提供 Skill 时声明 `agent.skills`；访问第三方 HTTP 服务时声明 `network.http`。

## 入口 API

```js
export async function activate(api) {
  const skillFile = api.registerSkill("skills/my-app");
  api.registerTool({
    name: "create_item",
    description: "创建一条记录",
    inputSchema: { type: "object", required: ["title"], properties: { title: { type: "string" } } },
    hidden: true
  }, async ({ title }) => ({ title }));
  api.setStatus("已就绪");
  return () => { api.unregisterTool("create_item"); api.unregisterSkill("my-app"); };
}
```

Skill 的 `SKILL.md` 应包含 YAML frontmatter，声明 `name` 和 `description`。工具的完整 key、参数、返回值和安全约束应写在 Skill 正文中；隐藏工具仍然可以执行，但不会进入模型的初始工具列表。

## 非 MCP 第三方应用连接

当第三方应用不使用 MCP 时，第三方应用插件只负责启动 loopback HTTP JSON 服务；SecAgent 连接插件负责健康检查、读取工具目录、注册工具和 Skill。第三方端不得直接写入 SecAgent 工作区，也不得维护 MCP 配置。

推荐接口：

```text
GET  /health
GET  /tools
POST /tools/{toolName}
```

`/health` 返回 `{ "apiVersion": 1, "name": "...", "status": "ok" }`；`/tools` 返回 `{ "apiVersion": 1, "tools": [...] }`，每个工具包含 `name`、`description`、`inputSchema` 和可选的 `hidden`。调用接口的请求体就是工具参数，成功返回 `{ "ok": true, "result": ... }`，失败返回非 2xx 和 `{ "ok": false, "error": ... }`。

第三方服务只监听 `127.0.0.1`，端口应固定并允许应用自身设置覆盖。连接插件应在健康检查和工具目录检查成功后注册工具与 Skill；轮询发现服务断开时撤销注册，重新连接后再注册。

## 安全要求

HTTP 服务只绑定 loopback 不是完整鉴权。生产实现应增加随机本地令牌、用户授权或其他认证机制，并在服务端重新校验工具名、参数、权限和业务状态。写入类工具必须保留备份或使用原子替换。
