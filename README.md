# 电子行业 SuperAgent 设计方案与 MVP

> 参照 DeepSeek Harness 团队的 `dsh-superagent` 设计思路，面向汽车电子零部件研发场景构建的单信息源主动式工程智能体方案。
> 方案已有一份**可运行的最小实现**：[`mvp/`](mvp/README.md)（零依赖 Node，`node --test` 62 项全绿）。

## 1. 这是什么

本方案把 `dsh-superagent`（一个监听单个 GitHub 仓库、按需接单、独立执行、回写原对话的主动式编码智能体）的领域模型与工程约束，迁移到**汽车电子研发与量产质量管理**场景：

- **单一信息源**：飞书。所有需求、变更、质量问题从飞书进入，也从飞书答复。
- **流程骨架**：IATF 16949 + APQP 五阶段 + 五大核心工具（APQP / FMEA / MSA / SPC / PPAP）。
- **三类资产**：文档、代码、硬件资源，各自有独立的分类法与版本策略。
- **自动操作仓库**：按阶段创建分支、提交文档与代码、发起 PR、打版本标签、维护追溯矩阵。
- **前置条件**：先有模板，再有自动化。模板是本方案的第一等交付物。

## 2. 核心主张

沿用原项目的第一性原理：**占用人最少的注意力，交付最大的工程价值**。

由此推导出本方案的六条硬约束：

| 编号 | 约束 | 含义 |
| --- | --- | --- |
| C1 | 单一入口 | 只监听飞书一个 Source，不做多入口聚合 |
| C2 | 先授权后执行 | 任何动作必须挂在有效 Mandate 上，授权与上下文分离 |
| C3 | 阶段门强制 | 未通过上一阶段门，不进入下一阶段的工作 |
| C4 | 模板先行 | 没有模板的文档不生成，没有分类的产物不落盘 |
| C5 | 产物可追溯 | 每份文档、每次提交、每个硬件版本都能反查到需求与授权 |
| C6 | 默认观察模式 | 新规则先 `observe` 记录，人工复核后再切 `auto` |

## 3. 交付物导航

| 路径 | 内容 | 读者 |
| --- | --- | --- |
| [docs/00-总体设计方案.md](docs/00-总体设计方案.md) | **工程蓝图**：模块与文件映射、数据模型、接口契约、时序、状态机、MVP 范围与验收标准 | 架构师、开发 |
| [docs/01-总体设计.md](docs/01-总体设计.md) | 设计目标、领域模型映射、架构分层、核心工作流 | 架构师、技术负责人 |
| [docs/02-IATF16949流程编排.md](docs/02-IATF16949流程编排.md) | APQP 五阶段、阶段门、任务流、交付物清单 | 项目经理、质量工程师 |
| [docs/03-资产分类规范.md](docs/03-资产分类规范.md) | 文档 / 代码 / 硬件资源三套分类法与命名规则 | 全体工程师 |
| [docs/04-飞书接入与交互.md](docs/04-飞书接入与交互.md) | 飞书应用配置、触发规则、卡片设计、消息策略 | 平台工程师、PM |
| [docs/05-仓库与执行器规范.md](docs/05-仓库与执行器规范.md) | 仓库拓扑、分支策略、worktree、工具与 Skills | 开发工程师 |
| [docs/06-权限策略与合规.md](docs/06-权限策略与合规.md) | 角色矩阵、准入表、授权强度、审计与记录保存 | 质量、合规、管理层 |
| [docs/07-部署与实施路线图.md](docs/07-部署与实施路线图.md) | 技术栈、部署形态、MVP 范围、迭代路线、度量 | 平台工程师、项目负责人 |
| [docs/08-AI密钥与模型分配.md](docs/08-AI密钥与模型分配.md) | 密钥分池、模型档位、并发限额、预算熔断、网关契约 | 平台工程师、安全、财务 |
| [docs/09-新项目接入.md](docs/09-新项目接入.md) | 接入形态判定、仓库骨架、Git 初始化、运行时工作目录、导入流程 | 平台工程师、项目负责人 |
| [docs/10-存量项目迁移.md](docs/10-存量项目迁移.md) | 存量项目四种接入形态、七步迁移、分类映射、追溯冷启动、回滚、成熟度分级 | 平台工程师、质量、项目负责人 |
| [templates/](templates/README.md) | 16 份可直接使用的文档模板 | 全体工程师 |
| [scaffold/](scaffold/) | 新项目骨架模板（manifest / rules / taxonomy / CODEOWNERS / LFS 规则） | 平台工程师 |
| [scripts/new-project.sh](scripts/new-project.sh) | 骨架生成器（建目录、套模板、初始化 Git 基线、自校验） | 平台工程师 |
| [scripts/import-project.sh](scripts/import-project.sh) | 存量迁移助手（盘点 / 映射建议 / 原地加装 / 校验，只增不改） | 平台工程师 |
| [config/](config/README.md) | 飞书 Source、Policy、profile、密钥池的配置示例 | 平台工程师 |
| [skills/](skills/) | 领域技能定义（16949 流程知识、仓库操作） | 智能体开发者 |
| [mvp/](mvp/README.md) | **可运行的最小实现**：飞书/本地来源、状态机、模板校验、资产分类、Git 操作、门禁、面板 | 开发、试点团队 |

## 4. 十分钟理解本方案

1. 一位有权限的工程师在飞书群里 `@电子超体`，贴上一段需求或一条质量问题。
2. 系统做**准入**（这个人、这个群、这个项目是否有权）和**研判**（属于哪个阶段、哪类任务、风险多高）。
3. 通过后生成一张**工单（Ticket）**，附带**授权（Mandate）**：允许改哪个仓库、走到哪个阶段门、能产出哪些文档。
4. 执行器在**独立会话 + 独立目录**里干活：套模板写文档、改代码、更新 BOM、跑校验、开 PR。
5. 结果回到飞书原话题，附上文档链接与 PR 链接；需要人决策时只问一个问题。
6. 阶段门由人确认，系统不代替人做放行决策。

## 5. 前提假设

本方案基于以下假设，实施前请逐条确认：

- **行业**：汽车电子零部件（IATF 16949 的适用行业）。若为消费电子或工业电子，需替换阶段门标准。
- **组织规模**：单产品线、10–50 人研发团队，已有或计划建立 Git 仓库与飞书组织。
- **飞书能力**：可创建自建应用、开启机器人、接收消息事件、读取群成员。
- **仓库平台**：GitHub / GitLab / Gitee 任一，支持 API 与 CLI；方案以 Git 通用能力描述。
- **质量体系**：已通过或正在推行 IATF 16949，已有 APQP 流程的责任人。
- **自动化边界**：阶段门放行、设计冻结、PPAP 提交签字等**必须由人完成**，系统只做准备与校验。

## 6. 与原项目的对应关系

| dsh-superagent | 本方案 | 变化 |
| --- | --- | --- |
| GitHub Source | 飞书 Source | 信息源替换，事件模型重写 |
| Ticket（编码任务） | 工程任务（开发/变更/质量/文档） | 任务类型扩展 |
| Executor（编码会话） | 阶段化执行器（按 APQP 分工） | 增加阶段门约束 |
| Policy（允许列表 + 准入表） | 角色矩阵 + 项目准入 + 阶段权限 | 复杂度上升 |
| Channel（GitHub 评论 / PR） | 飞书话题 + 仓库 PR + 文档库 | 三通道回写 |
| Panel（工单总览） | 项目驾驶舱 + 阶段门看板 | 视图重构 |

## 7. 快速开始

### 7.1 直接跑起来（MVP，无需任何依赖）

```bash
cd mvp
node src/cli.mjs demo            # 自动建 .demo/PCU24 并跑完三条场景
node src/cli.mjs verify --dir .demo/PCU24
node --test test/*.test.mjs      # 62 项测试
```

自己走一遍：

```bash
node src/cli.mjs init --dir ./pcu24 --code PCU24 --name "电机控制器" --stages S1,S5 --accept-mode auto
node src/cli.mjs say  --dir ./pcu24 --as ou_xxx2 "客户投诉 PCU24 低温启动偶发失效，请开 8D"
node src/cli.mjs run  --dir ./pcu24 --once      # 单轮跑完即退，便于 CI
node src/cli.mjs run  --dir ./pcu24             # 常驻：运行面板 :8787 ｜ 工作台 :8787/admin
```

### 7.2 读设计与落地模板

```bash
# 阅读顺序：先蓝图，再业务规则
docs/00 → docs/01 → docs/02 → docs/03 → docs/04 → docs/05 → docs/06 → docs/07 → docs/08 → docs/09 → docs/10

# 落地模板
cp -r templates/ <你的仓库>/docs/_templates/

# 生成一个项目的骨架（含 Git 基线）
scripts/new-project.sh PCU24 "电机控制器 2024 平台" --org acme --owner "张工" --stages S1 --git
scripts/new-project.sh --verify ./pcu24

# 或者：把已有的老项目接进来（先只读盘点，不写源目录）
scripts/import-project.sh /data/legacy/PCU_V2 --scan
scripts/import-project.sh /data/legacy/PCU_V2 --plan
scripts/import-project.sh /data/legacy/PCU_V2 --apply --code PCU24 --stages S1,S2 --git-init
```

### 7.3 接真实飞书

```bash
export FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx FEISHU_VERIFICATION_TOKEN=xxx
node src/cli.mjs run --dir ./pcu24 --source feishu --port 8787
# 事件回调地址：http://<内网地址>:8787/feishu/event
```

未配置凭据时不会崩：命令以退出码 3 退出并说明缺哪个变量。

### 7.4 配模型密钥

密钥放**用户主目录**，不放项目目录（项目目录会进 Git）：

```bash
mkdir -p ~/.superagent
cp mvp/model.example.yml ~/.superagent/model.yml   # 填 baseUrl / model / apiKey
node mvp/src/cli.mjs model --dir ./pcu24 --check   # 自检：连通性 + key 有效性
```

优先级：环境变量 `SUPERAGENT_MODEL_BASE_URL` / `_API_KEY` / `_NAME` > `~/.superagent/model.yml` > `--file` 指定。
文件里也可只写 `apiKeyEnv: DEEPSEEK_API_KEY`，把密钥值留在环境变量里。
需要按岗位分配不同模型时，在文件里配 `pools`（worker/doc/router/vision），岗位会自动落到对应池，池内多把 key 失败自动切换。
不配也能跑：退化为 `nullGateway`，文档骨架照常产出，只是不生成技术内容。详见 [docs/08](docs/08-AI密钥与模型分配.md) §8.3。

## 8. 免责声明

`docs/` 是设计蓝图，`mvp/` 是其中可运行的子集（范围与偏差见 [docs/00](docs/00-总体设计方案.md) §2 与 §10）。落地时需要：

- 依据企业实际的产品线、组织架构、质量体系文件做裁剪；
- 由质量部门确认阶段门与交付物清单符合本企业的 IATF 16949 体系文件；
- 由信息安全部门评审仓库权限、BOM 保密与数据出境要求；
- 先在 `observe` 模式运行 2–4 周，用真实决策记录校准规则后再放开自动执行。
