---
name: secscore
description: 使用 SecScore 云端班级工具给同学加分或扣分
---

# SecScore 操作

插件启动时会自动读取当前 SECTL 登录态，并加载已保存的账号和班级；首次登录或需要切换多个账号/班级时，仍可在 SecAgent 设置中的“SecScore 操作”页完成选择。账号默认使用当前 SECTL 登录账号，也可以在该页通过 OAuth 登录其它账号。

## 给同学加减分

调用 `secscore-connector__add_score`，参数如下：

```json
{
  "student_name": "同学完整姓名",
  "score": 2,
  "reason": "课堂表现积极"
}
```

`score` 为整数，正数表示加分，负数表示扣分。`reason` 必须说明原因。调用前确认同学姓名、分值和理由；同名时先让用户补充更完整的姓名。成功后向用户说明云端已同步，并报告变更前后分数。

## 查询同学和分组

以下工具是隐藏工具，不会直接出现在工具列表中，必须通过 `secagent__call_hidden_tool` 调用。`name` 必须使用完整工具 key，不能自行改名：

- `secscore-connector__list_students`：列出当前班级同学。参数可选 `query`、`group_name`、`limit`、`account_id`、`class_id`。
- `secscore-connector__find_students`：按姓名搜索同学。参数 `query` 必填，可选 `account_id`、`class_id`。
- `secscore-connector__list_groups`：列出当前班级分组和每组人数。参数可选 `account_id`、`class_id`。
- `secscore-connector__list_group_members`：列出指定分组成员。参数 `group_name` 必填，可选 `account_id`、`class_id`。

例如，查询当前班级全部同学：

```json
{
  "name": "secscore-connector__list_students",
  "arguments": {}
}
```

如果隐藏工具返回 `error`，必须把失败原因告诉用户，不能宣称操作已完成。
