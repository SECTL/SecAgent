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
  "permissions": ["agent.tools", "agent.skills", "agent.prompts", "network.http"]
}
```

工具插件通常声明 `agent.tools`；提供 Skill 时声明 `agent.skills`；向 Agent 注入提示词时声明 `agent.prompts`；访问第三方 HTTP 服务时声明 `network.http`。

## 入口 API

```js
export async function activate(api) {
  const skillFile = api.registerSkill("skills/my-app", /积分|my-app/i);
  api.registerTool({
    name: "create_item",
    description: "创建一条记录",
    inputSchema: { type: "object", required: ["title"], properties: { title: { type: "string" } } },
    hidden: true
  }, async ({ title }) => ({ title }));
  api.registerPrompt("domain_rules", "操作涉及积分变更前，必须向用户展示变更明细并等待确认。");
  api.setStatus("已就绪");
  return () => { api.unregisterTool("create_item"); api.unregisterSkill("my-app"); api.unregisterPrompt("domain_rules"); };
}
```

Skill 的 `SKILL.md` 应包含 YAML frontmatter，声明 `name` 和 `description`。工具的完整 key、参数、返回值和安全约束应写在 Skill 正文中；隐藏工具仍然可以执行，但不会进入模型的初始工具列表。

### Skill 自动加载

注册 Skill 时可以传入第二个参数 `autoLoadPattern`，类型为正则字符串或 JavaScript `RegExp`：

```js
api.registerSkill("skills/my-app", /画板|画布|批注|CE|ICC-CE|ICC/i);
// 也可以传入字符串：
api.registerSkill("skills/my-app", "积分|查询学生");
```

当正则匹配当前用户消息时，宿主会在该用户消息后追加一条 system 消息，内容包括 Skill 名称、入口路径和 `SKILL.md` 完整内容；一次消息可以命中多个 Skill。同一会话中同一个 Skill 只自动加载一次，模型已经通过 `secagent__read_skill` 读取过的 Skill 也不会再次自动加载。没有自动加载需求时省略第二个参数即可。

## 提示词注入

插件通过 `api.registerPrompt(name, provider)` 注册提示词。每次用户向 Agent 发送消息时，宿主都会重新求值所有激活插件的提示词（`provider` 可以是静态字符串，也可以是返回字符串的函数），并拼接到系统提示词的最后：

- 多个插件、多个提示词按注册顺序依次拼接，每个提示词带来源标注 `[<插件 id>/<名称>]`；
- 求值返回空字符串或抛出异常的提示词会被跳过，不影响其他插件，错误记录在宿主日志；
- 插件停用或调用 `api.unregisterPrompt(name)` 后，对应提示词不再注入。

提示词会被完整注入模型上下文，只应包含业务规则、约束等指令内容；不要写入密钥或敏感信息。

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

## SVG 预览能力

声明 `agent.preview` 权限的插件可以使用宿主提供的 `api.openSvgPreview({ svg, title, fileName, openPreview })`。桌面端会将 SVG 保存到当前工作区的 `exports/handdrawn-markdown/`；默认打开独立预览窗口，传入 `openPreview: false` 时只保存文件而不打开窗口。CLI 等没有 Electron 窗口的运行环境仍会保存文件，但返回 `previewOpened: false`。

宿主会限制文件大小、拒绝带目录的文件名，并使用无 Node Integration 的隔离窗口加载 SVG。插件不得通过系统命令自行启动浏览器或窗口。
