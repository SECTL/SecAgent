# SecAgent CLI

SecAgent 的第一阶段验证版：把教学场景自然语言转换为受策略保护的工具调用。

```bash
npm install
npm run build
node dist/index.js init --workspace ./demo-workspace
node dist/index.js run "给高一三班的李明加 2 分" --workspace ./demo-workspace
node dist/index.js confirm <confirmation-id> --workspace ./demo-workspace
```

CLI 直接调用 SecScore 的 HTTP MCP（默认 `http://127.0.0.1:3901/mcp`），支持查学生、积分预览、一次性确认、真实写入、审计和撤销。先在 SecScore 中以管理员身份启动 MCP 服务，再执行写操作。

## 本地中文语音输入

桌面端麦克风按钮使用本地 `sherpa-onnx` 流式识别，不上传音频。当前已下载官方的小型中文 `streaming-zipformer-zh-14M` 模型到 `models/`；运行环境需要安装 Python 依赖：

```bash
python3 -m pip install sherpa-onnx
npm run dev
```

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
# OpenAI 或任何兼容 Chat Completions 的服务
agent:
  provider: openai-compatible
  model: gpt-5
  apiKeyEnv: OPENAI_API_KEY
  baseUrl: https://api.openai.com/v1
  endpoint: /chat/completions
  maxTokens: 800

  # 可选：配置多个模型后，可在桌面端输入框右侧切换。
  models:
    - id: gpt-5
      name: GPT-5
      provider: openai-compatible
      model: gpt-5
      apiKeyEnv: OPENAI_API_KEY
      baseUrl: https://api.openai.com/v1
      endpoint: /chat/completions
      maxTokens: 800
    - id: claude
      name: Claude Sonnet
      provider: anthropic
      model: claude-sonnet-4-20250514
      apiKeyEnv: ANTHROPIC_API_KEY
      baseUrl: https://api.anthropic.com
      endpoint: /v1/messages
      anthropicVersion: "2023-06-01"
      maxTokens: 800

# Anthropic Messages API 或其兼容端点
# agent:
#   provider: anthropic
#   model: claude-sonnet-4-20250514
#   apiKeyEnv: ANTHROPIC_API_KEY
#   baseUrl: https://api.anthropic.com
#   endpoint: /v1/messages
#   anthropicVersion: "2023-06-01"
#   maxTokens: 800

# Google Gemini 原生 API
# agent:
#   provider: google
#   model: gemini-2.5-flash
#   apiKeyEnv: GEMINI_API_KEY
#   baseUrl: https://generativelanguage.googleapis.com/v1beta
#   endpoint: ""
#   maxTokens: 800
```

当前验证阶段的 `policy.execution: bypass` 表示模型调用已启用 MCP 的工具后会直接执行；每次调用仍会写入本地审计。生产使用前应改为 `confirm` 并为写操作配置确认策略。

基础系统提示词在工作区的 `prompts/agent-system.md`。SecAgent 会自动扫描工作目录下三层以内、文件名大小写不敏感的 `SKILL.md`。每个 Skill 应在文件开头使用 YAML frontmatter 声明 `name` 和 `description`，两者会进入系统上下文；模型需要完整流程时会调用 `secagent__read_skill` 读取对应文件。Skill 不需要写入 `secagent.yaml`，文件可直接手动编辑。

```md
---
name: SecScore
description: 处理学生查询、积分加减分和撤销。
---
# SecScore
```

隐藏 MCP 工具的声明方式、通用调用入口，以及 Skill/MCP 开发者约定见 [`docs/skill-mcp-convention.md`](docs/skill-mcp-convention.md)。
