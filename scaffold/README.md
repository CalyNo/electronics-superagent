# {{CODE}} {{NAME}}

> 本仓库由 `electronics-superagent` 托管：飞书里授权成员 `@电子超体` 发起需求，系统按 IATF 16949 / APQP 流程产出文档、代码与硬件资料并提 PR。
> 仓库结构、命名、元数据规则见 `docs/_templates/` 与平台文档；**人工提交同样受这些规则约束**。

## 项目身份

| 项 | 值 |
| --- | --- |
| 项目代号 | `{{CODE}}`（终身不变） |
| 所属平台 | {{PLATFORM}} |
| 客户 | {{CUSTOMER}} |
| 项目负责人 | {{OWNER_NAME}} |
| 当前阶段 | S1 策划 |
| 授权基线 | `baseline-v0.0.1` |
| 记录保存 | 15 年 |

## 阶段与门禁

| 门 | 名称 | 必需交付物 | 状态 |
| --- | --- | --- | --- |
| G1 | 立项批准 | CHTR / SRS / APQP / FEAS | 未开始 |

> 门禁放行只能由人签署。系统只准备证据包并做一致性校验，不代替人做放行决策。

## 目录导览

| 路径 | 内容 |
| --- | --- |
| `docs/S1-策划/` … `docs/S5-量产/` | 按阶段归档的受控文档 |
| `docs/_index/` | 文档索引与追溯矩阵（自动维护，勿手改） |
| `docs/_templates/` | 模板副本，只读，随平台升级 |
| `hardware/` | BOM、原理图、PCB、结构、工装、器件资料 |
| `firmware/` `software/` | 固件与上位机代码 |
| `test/` | 单元测试与 HIL 用例 |
| `evidence/` | 已定稿的验证证据，按工单号分目录 |
| `.superagent/` | 系统配置（manifest / rules / taxonomy），仅平台组可改 |

## 分支

| 分支 | 用途 | 谁能推 |
| --- | --- | --- |
| `main` | 量产基线 | 仅合并 PR |
| `develop` | 集成基线 | 仅合并 PR |
| `agent/*` | 智能体工作分支 | 执行器 |
| `change/*` `fix/*` | 人工变更与修复 | 工程师 |

## 提交规范

```
<type>(<scope>): <subject>

Refs: TKT-YYYY-NNNN
```

`type` 取 `feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `hw`。缺少 `Refs` 的提交会被钩子拒绝。

## 首次使用

1. 确认 `.superagent/manifest.yml` 中的责任人与 `chatIds` 已填；
2. 在飞书对应群内 `@电子超体` 发起一条真实需求；
3. 系统以 `observe` 模式运行，只记录"本会做什么"，不实际执行；
4. 两周后由项目负责人评估是否切换到 `auto`。
