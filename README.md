# SecAgent CLI

## CLI 调试 Agent

CLI 的每次 `run` 都会持久化为一个会话，并默认实时打印模型思考片段、工具调用、工具返回结果和最终回答。模型请求失败时会保存错误消息并返回非零退出码。

```bash
cd SecAgent
npm install
npm run build:cli

# 初始化工作区，并在 .env 中填写模型密钥
node dist/index.js init --workspace ./demo-workspace

# 执行单条消息；命令结束时会打印 [session] <会话 ID>
node dist/index.js run "查询李明当前积分" --workspace ./demo-workspace

# 查看历史会话，复制会话 ID
node dist/index.js sessions list --workspace ./demo-workspace

# 接着指定历史会话运行
node dist/index.js run "把刚才的结果总结一下" --session <会话 ID> --workspace ./demo-workspace

# 进入交互式续聊；不指定 --session 时默认打开最近会话
node dist/index.js chat --session <会话 ID> --workspace ./demo-workspace
```

交互式 `chat` 中输入 `:history` 查看当前会话，输入 `:use <会话 ID>` 切换会话，输入 `exit` 退出。需要完整的模型请求/响应原始事件时，加上 `--verbose`；普通模式已经会打印思考和工具过程。

会话文件位于工作区的 `sessions/<会话 ID>/session.json`，运行时事件位于同目录的 `runtime.jsonl`，因此 CLI 和桌面端可以共享历史会话。

SecAgent：把自然语言转换为工具调用。

```bash
npm install
npm run build
node dist/index.js init --workspace ./demo-workspace
node dist/index.js run "给高一三班的李明加 2 分" --workspace ./demo-workspace
```

CLI 直接调用 SecScore 的 HTTP MCP（默认 `http://127.0.0.1:3901/mcp`），支持查学生、真实写入、审计和撤销。

## 云端中文语音输入

桌面端麦克风按钮统一通过 SecAgent 官方服务的 WebSocket 接口进行云端识别。使用前需要登录官方服务并配置 `SECTL_OFFICIAL_API_URL` 和 `SECTL_OFFICIAL_TOKEN`；音频不会在本地使用 `sherpa-onnx` 模型处理。

点击麦克风后，识别结果会实时替换并插入到点击按钮前 textarea 的光标位置；再次点击结束录音。

## 模型配置

`secagent init` 会在工作区创建 `.env`。将密钥填入其中，密钥不会写进 `secagent.yaml`：

```dotenv
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...
```

桌面端打开“设置”后，可在“协议”中选择“Google Gemini”，粘贴从 Google AI Studio 获取的 API key 并保存。程序会使用 Gemini 原生 API；key 会保存到工作区 `.env`，不会写入 `secagent.yaml`。

在 `secagent.yaml` 的 `agent` 区块选择协议、模型和端点：

```yaml
# OpenAI Responses 协议
agent:
  provider: openai-responses
  model: gpt-5
  apiKeyEnv: OPENAI_API_KEY
  baseUrl: https://api.openai.com/v1
  endpoint: /responses
  maxTokens: 16384

# OpenAI 或任何兼容 Chat Completions 的服务
agent:
  provider: openai-compatible
  model: gpt-5
  apiKeyEnv: OPENAI_API_KEY
  baseUrl: https://api.openai.com/v1
  endpoint: /chat/completions
  maxTokens: 16384

  # 可选：配置多个模型后，可在桌面端输入框右侧切换。
  models:
    - id: gpt-5
      name: GPT-5
      provider: openai-compatible
      model: gpt-5
      apiKeyEnv: OPENAI_API_KEY
      baseUrl: https://api.openai.com/v1
      endpoint: /chat/completions
      maxTokens: 16384
    - id: claude
      name: Claude Sonnet
      provider: anthropic
      model: claude-sonnet-4-20250514
      apiKeyEnv: ANTHROPIC_API_KEY
      baseUrl: https://api.anthropic.com
      endpoint: /v1/messages
      anthropicVersion: "2023-06-01"
      maxTokens: 16384

# Anthropic Messages API 或其兼容端点
# agent:
#   provider: anthropic
#   model: claude-sonnet-4-20250514
#   apiKeyEnv: ANTHROPIC_API_KEY
#   baseUrl: https://api.anthropic.com
#   endpoint: /v1/messages
#   anthropicVersion: "2023-06-01"
#   maxTokens: 16384

# Google Gemini 原生 API
# agent:
#   provider: google
#   model: gemini-2.5-flash
#   apiKeyEnv: GEMINI_API_KEY
#   baseUrl: https://generativelanguage.googleapis.com/v1beta
#   endpoint: ""
#   maxTokens: 16384
```

桌面端输入框右侧的模型菜单可以分别选择模型和推理强度（不思考、低、中、高）。OpenAI Responses 会将其映射到 `reasoning.effort`；Anthropic 和 Gemini 会映射到各自的 thinking 配置。Responses、Anthropic thinking 和 Gemini thought summary 的流式内容会按时间顺序显示在工具执行过程内，最终答案仍单独显示。

模型可直接调用所有已发现的 MCP 工具，以及 Pi 风格的 `read`、`write`、`edit`、`bash` 四个本地工具；每次调用仍会写入本地审计。

基础系统提示词从工作区 `secagent.yaml` 的 `agent.systemPrompt` 读取；新工作区会写入源码中的默认值，配置项为空时也会回退到该默认值。SecAgent 会自动扫描工作目录下三层以内、文件名大小写不敏感的 `SKILL.md`，并将扫描到的 Skill 名称、描述和入口文件追加到系统提示词中。模型需要完整流程时会调用 `secagent__read_skill` 读取对应文件。Skill 不需要写入 `secagent.yaml`，文件可直接手动编辑。

```md
---
name: SecScore
description: 处理学生查询、积分加减分和撤销。
---
# SecScore
```

隐藏 MCP 工具的声明方式、通用调用入口，以及 Skill/MCP 开发者约定见 [`docs/skill-mcp-convention.md`](docs/skill-mcp-convention.md)。
