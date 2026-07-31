# Skill 与 MCP 工具约定

SecAgent 会自动发现工作目录三层以内的 `SKILL.md`。Skill 文件负责提供面向模型的工作流和工具用法；MCP 服务负责提供真实可执行的工具，并在 `tools/list` 的每个工具上标明是否隐藏。隐藏工具的详细模型定义由 Skill 正文承担，不会把 MCP 的工具 schema 放进模型初始上下文。

## Skill 文件格式

每个 `SKILL.md` 应以 YAML frontmatter 开头：

```md
---
name: SecScore
description: 处理学生查询、积分加减分和撤销。
---
# SecScore
```

`name` 和 `description` 会被拼入初始系统提示词的 Skills 目录。Skill frontmatter 不声明工具隐藏性，不应添加 `tools.hidden` 字段。没有 frontmatter 的旧 Skill 仍可加载，但应尽快补齐 `name` 和 `description`。

MCP `tools/list` 返回的工具使用 SecAgent 扩展字段 `hidden: true` 标记隐藏工具。工具 key 使用 SecAgent 暴露给模型的完整名称：`<MCP 配置名>__<MCP 原始工具名>`，例如 `secscore__add_score`。MCP 原始工具名是 `add_score` 时，服务配置名为 `secscore`，返回给 SecAgent 的注册 key 就是 `secscore__add_score`。

## 隐藏工具的定义与调用

初始请求包含 `hidden` 不为 `true` 的 MCP 工具、`secagent__read_skill` 和一个固定的 `secagent__call_hidden_tool` 入口。模型通常先调用 `secagent__read_skill` 获取隐藏工具的名称和用法；但读取 Skill 不是权限门槛。如果模型已经从用户输入、其他上下文或既有知识中知道完整工具 key 和调用契约，也可以直接通过通用入口调用。

SecAgent 不会在读取 Skill 后重新加入隐藏工具的 MCP schema。隐藏工具的名称、参数、返回值和使用约束应写在 Skill 正文中，读取 Skill 的作用是帮助模型知道这些信息，而不是授予调用权限。例如：

```md
## 隐藏工具说明

`secscore__add_score`：给指定学生增加或扣减积分。调用参数：
- `student_id`：学生 ID，整数。
- `student_name`：学生姓名，用于二次确认。
- `delta`：积分变化量，负数表示扣分。
- `reason_content`：变更原因。

`secscore__undo_score`：撤销一条已完成的积分操作。调用参数为 `event_uuid` 和 `student_id`，只能用于真实存在且允许撤销的记录。
```

调用通用入口时，模型使用如下结构：

```json
{
  "name": "secscore__add_score",
  "arguments": {
    "student_id": 123,
    "student_name": "李明",
    "delta": 2,
    "reason_content": "课堂表现良好"
  }
}
```

## MCP 开发者约定

- `tools/list` 的返回示例：

```json
{
  "tools": [
    { "name": "list_students", "description": "查询学生", "hidden": false },
    { "name": "add_score", "description": "调整积分", "hidden": true }
  ]
}
```

- `hidden` 是 SecAgent 扩展字段；`true` 表示隐藏工具仍可执行，但不把该工具的 MCP schema 放入模型初始工具列表。省略该字段或设置为 `false` 表示常驻展示。
- 工具名应稳定、语义明确；Skill 正文会引用完整工具 key，随意改名会使已有 Skill 失效。
- `tools/list` 仍应提供准确的 `description` 和完整 `inputSchema`，供可见工具直接调用、供运行时和 MCP 自身校验使用；隐藏工具的模型可读定义以 Skill 正文为准。
- 工具执行端必须自行校验权限、参数和业务状态。隐藏工具只是减少初始上下文，不是安全边界，也不会替代 MCP 的鉴权和服务端校验。
- 如果一个工具属于某个工作流但不适合常驻上下文，在 MCP 的 `tools/list` 返回中将它标记为 `hidden: true`，并在对应 Skill 正文中完整说明。

## Skill 开发者约定

- `description` 写成一句能帮助模型判断“是否需要读取此 Skill”的摘要，不要把完整流程塞进 frontmatter。
- 只隐藏不常用、参数复杂或必须先理解业务规则的工具；高频、简单、跨场景工具可以保持可见。
- 对 MCP 标记为 `hidden: true` 的工具，在 Skill 正文中逐个说明名称、参数、返回值和使用约束。
- 不要依赖 MCP 的隐藏工具 schema 让模型补全参数；Skill 正文必须足够完整，模型只读 Skill 内容也能构造通用调用入口的 `arguments`。
