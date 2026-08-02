# SecAgent 插件开发

插件是可移植的 zip 包。包内只能包含 JavaScript、JSON、Skill 和静态资源；初版不支持 Node 原生扩展，以便同一份发布物运行于 Windows、macOS 和 Linux。用 `esbuild` 输出 ESM `main.mjs`，再与 `secagent-plugin.json`、Skill 一起压缩为 zip。

## 清单

```json
{
  "apiVersion": 1,
  "id": "my-app",
  "name": "我的应用",
  "version": "1.0.0",
  "main": "main.mjs",
  "permissions": ["agent.tools", "agent.skills", "network.http"],
  "settingsPages": [{ "id": "connection", "title": "我的应用", "description": "连接状态" }]
}
```

`id` 必须为小写字母、数字和连字符。工具最终名称固定为 `<plugin-id>__<tool-name>`，例如 `my-app__create_item`。清单声明的设置页会进入 SecAgent 设置页左侧导航，宿主显示插件上报的状态。

## 主入口与 API

主入口必须导出 `activate(api)`；可返回清理函数。插件通过受控 API 操作宿主，不能依赖直接访问 Electron、IPC 或工作区文件。

宿主会在 Agent 的可用 Skills 目录中同时给出每个入口文件相对于工作目录的路径，例如 `.secagent-runtime/plugins/example-counter/1.0.0/skills/counter/SKILL.md`。模型可以直接用 `read` 或 `bash` 访问该路径；`secagent__read_skill` 适合需要一次性获得完整入口内容的场景，不是访问 Skill 的唯一方式。

```js
export async function activate(api) {
  api.registerSkill("skills/my-app/SKILL.md");
  api.registerTool({
    name: "create_item", hidden: true,
    description: "创建一条记录。",
    inputSchema: { type: "object", required: ["title"], properties: { title: { type: "string" } } }
  }, async ({ title }) => ({ title }));
  api.setStatus("已就绪");
}
```

可用权限：`agent.tools`、`agent.skills`、`network.http`。`registerTool`、`unregisterTool`、`registerSkill`、`unregisterSkill`、`setStatus` 和 `fetch` 都会校验对应权限。工具名和输入必须由插件服务端再次校验；隐藏工具只节省上下文，绝不是安全边界。

## Skill 生命周期

**Skill 是否注册完全由插件决定。** 主应用不会根据 HTTP 是否连接、插件是否启用或任何约定自动注册它。插件调用 `registerSkill` 时，宿主把包内 `SKILL.md` 释放到工作目录 `.secagent-runtime/plugins/<id>/<version>/skills/`，只在本次插件运行中向 Agent 暴露其名称和摘要；模型需要完整说明时调用 `secagent__read_skill`。

Skill 可以包含完整目录，而不只是 `SKILL.md`，例如 `references/*.md`、`examples/`、`scripts/*.mjs` 和其他辅助文件。宿主会把整个目录释放到运行时 Skill 目录，并将 `SKILL.md` 作为目录入口。模型可通过 `secagent__read_skill` 读取入口，也可以使用已有的 `read`/`bash` 工具查看、grep 或执行 Skill 目录中的脚本；插件权限不会阻止模型使用已注册 Skill 的这些内容。脚本仍应自行校验输入和副作用。

推荐实践是：先检查依赖应用的服务可用性，再注册对应 Skill 和隐藏工具；连接断开时取消注册。这样 Agent 不会看到不可执行能力。示例计数器插件实现了这个策略，但这不是强制规则。

## HTTP 第三方应用

推荐第三方桌面应用只监听 loopback（`127.0.0.1`），并选择一个固定、高且未保留的端口，例如 `48123`。固定高端口便于插件零配置发现；同时必须允许通过设置或环境变量覆盖，处理端口冲突，并提供 `GET /health`。生产服务还应使用随机本地令牌、用户授权或其他鉴权，不能仅因是隐藏工具就信任请求。

示例服务采用 `GET /secagent/health`、`GET /secagent/tools`、`POST /secagent/tools/<name>`。该 HTTP 形状是示例契约，不要求使用 MCP；插件可以把任意安全 HTTP 协议适配为 Agent 工具。

## 安装与发布

用户可在“设置 → 插件 → 安装本地 zip”安装包。宿主会限制包大小、拒绝路径穿越、验证 manifest，再释放到 `<workspace>/plugins/installed/<id>/<version>`。市场安装下载后还必须校验 SHA-256 与 Ed25519 签名。

发布仓库应在 GitHub Release 附加 zip 与 SHA-256 文件；不应发布平台绑定二进制。若未来确实需要原生模块，应按平台分别发布、声明 `os/cpu`，并由宿主单独审核，而不是伪装成通用包。
