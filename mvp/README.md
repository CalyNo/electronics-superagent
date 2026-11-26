# electronics-superagent MVP

零依赖 Node.js 实现，把 [docs/00-总体设计方案](../docs/00-总体设计方案.md) 落成可运行的闭环：
**消息进来 → 准入研判 → 建单授权 → 套模板产出文档 → 分类落位 → Git 分支提交 → 阶段门检查 → 回写飞书**。

- 运行时：Node.js ≥ 22.5（用到内置 `node:sqlite`；实测 22.22）
- 依赖：**0**（无 npm 包，克隆即可运行）
- 测试：`npm test`，基于临时项目、Git 仓库及模拟接口

## 1. 三分钟跑通

```bash
node src/cli.mjs demo                    # 建 .demo/PCU24，跑完 8D / 立项 / 越权三条场景
node src/cli.mjs verify --dir .demo/PCU24
```

**注意顺序：先 `init`，再 `run`。** 直接 `run --dir ./pcu24` 会因为目录还不是项目而退出（退出码 3），并打印可复制的两条路——这是设计好的提示，不是崩溃。

手工走一遍：

```bash
node src/cli.mjs init --dir ./pcu24 --code PCU24 --name "电机控制器 2024" \
     --owner "王经理" --customer "客户A" --platform PCU --stages S1,S5 --accept-mode auto

node src/cli.mjs say --dir ./pcu24 --as ou_xxx2 "客户投诉 PCU24 低温启动偶发失效，已退货 3 台，请开 8D"
node src/cli.mjs run --dir ./pcu24 --once

node src/cli.mjs tickets --dir ./pcu24
node src/cli.mjs tickets --dir ./pcu24 --id TKT-2026-0001
node src/cli.mjs gate  list  --dir ./pcu24
node src/cli.mjs gate  sign  G1 --dir ./pcu24 --as ou_xxx3 --note "立项评审通过"
```

常驻模式带面板：`node src/cli.mjs run --dir ./pcu24`
→ 运行面板 http://127.0.0.1:8787 ｜ **工作台 http://127.0.0.1:8787/admin**

## 2. 代码地图

| 路径 | 职责 | 看这个文件能回答什么 |
| --- | --- | --- |
| `src/cli.mjs` | 命令入口（装警告过滤器后加载实现） | 为什么分两个文件 |
| `src/cli-impl.mjs` | 各子命令的实现与退出码 | 某个命令到底做了什么 |
| `src/app/runtime.mjs` | 组合根 + 调度循环 | 一个周期到底做了哪六件事 |
| `src/app/bootstrap.mjs` | 建骨架、套模板、初始化 Git | 新项目从哪来 |
| `src/domain/engine.mjs` | 唯一写入者、状态机、事务 | 什么转换合法、为什么 Mandate 不可变 |
| `src/domain/policy.mjs` | 准入、签署权、版本 | 谁能发起、谁能签、为什么空名单等于全拒 |
| `src/domain/router.mjs` | 关键词路由 | 一句话怎么变成任务类型与交付物 |
| `src/domain/stages.mjs` | 阶段/文档类型/门禁的单一数据源 | APQP 五个阶段各要什么 |
| `src/domain/gate.mjs` | 门禁三类检查 | 机器检查什么、什么必须人签 |
| `src/domain/templates.mjs` | front-matter 与结构校验 | "模板即契约"具体怎么判 |
| `src/executor/executor.mjs` | 一次派工的完整执行 | 失败时为什么是 blocked 而不是 failed |
| `src/executor/positions.mjs` | 岗位（数字员工）注册表：谁负责哪类文档、用哪个池 | 一条需求派给谁干 |
| `src/executor/keypool.mjs` | 密钥池：多 key、失败换 key、用量回传 | 为什么按"调用形态"分池而不是按人发 key |
| `src/executor/agent.mjs` | 提示词、JSON 解析、章节落位、数值护栏 | 模型写了什么、哪些被拒绝落地 |
| `src/executor/generator.mjs` | 按模板产出文档、写索引 | 文档编号与落位规则 |
| `src/executor/asset-router.mjs` | 产物分类 | 未知类型为什么不猜 |
| `src/executor/repo.mjs` | 分支/提交/PR 草案/凭据扫描 | 为什么永远不碰 main |
| `src/sources/local.mjs` | 目录收件箱（离线可用） | 没有飞书时怎么验证链路 |
| `src/sources/feishu.mjs` | webhook、token、发消息 | 真实对接需要什么 |
| `src/panel/server.mjs` | 运行面板 + 管理 API + 工作台聚合 | 三个问题怎么被回答 |
| `src/panel/admin.mjs` | 管理员工作台页面（状态 / 交付物 / 密钥） | 一眼看清谁在干活、产出了什么 |
| `src/executor/keystore.mjs` | 密钥库（keys.json）与单 key 自检 | 密钥放哪、怎么改、怎么测 |
| `src/util/yaml.mjs` | YAML 子集解析 | 为什么不用第三方库 |

依赖方向：`sources → domain ← executor`；`domain` 不 import `sources/executor/panel`。
唯一的偏离是执行器与领域同进程（见 docs/00 §3 与 §10）。

## 3. 命令与退出码

| 命令 | 说明 |
| --- | --- |
| `init` | 建项目骨架（`--code --dir --name --stages --accept-mode --no-git`） |
| `run` | 启动（`--once` 单轮、`--port`、`--source local\|feishu`、`--no-panel`） |
| `status` | 一次健康检查（`--json`） |
| `say` | 投递消息（`--as --chat --id --not-addressed`） |
| `tickets` | 列表 / `--id` 看全链路 |
| `retry` | `retry <ticket_id> --dir <项目> --as <open_id>`，为阻塞工单创建下一次派工 |
| `gate` | `list｜check <G>｜sign/return/resubmit <G> --as <open_id>` |
| `model` | 查看模型网关配置（`--file`），`--check` 发一条最小请求自检 |
| `verify` | 配置 + 文档结构 + 资产落位 + 门禁 全量校验 |
| `classify` | 查看文件会归到哪个目录 |
| `demo` | 三条场景一键跑完 |

退出码：`0` 正常 / `1` 有越权或需重启 / `2` 部件错误或校验不通过 / `3` 待配置（缺凭据、白名单为空）。

## 4. 三条场景说明（demo 里可看到）

| 场景 | 输入 | 产出 | 验证了什么 |
| --- | --- | --- | --- |
| 质量问题 | "客户投诉…失效…退货" | `docs/S5-量产/8D/DOC-S5-8D-001-8D.md` + `fix/TKT-…` 分支 | 路由到 8D、不套阶段门、结构校验 |
| 新项目立项 | "启动…立项…定点" | S1 四份交付物 + `G1` 转 `pending` | 齐套检查、门禁只到待签、签署权 |
| 越权/重复 | 陌生人 @ / 同一条消息投两次 | `rejected` 评估 / 不新增工单 | 准入表、幂等 |

## 5. 岗位与密钥池：谁干活、用哪把 key

**主链路**：

```
飞书 @机器人 / 收件箱投递
   └→ Trigger → 准入(Policy：这个人能不能提) → 研判(任务类型/阶段)
        └→ Ticket + Mandate
             └→ 每份交付物按类型找岗位
                  PM 项目经理  ← CHTR / APQP / FEAS
                  SW 软件工程师 ← SRS / 固件代码
                  HW 硬件工程师 ← DFMEA / SC / DVP
                  PE 工艺工程师 ← PFC / PFMEA / CP
                  QE 质量工程师 ← 8D / MSA / SPC / TR / PPAP / ECN
                    └→ 岗位绑定池 → 池内选一把 key（失败自动换下一把）
                         └→ 模型按"只填能确定的部分"写章节
                              └→ 数值护栏 → 落盘 → 结构校验 → 提交 → 门禁
```

**为什么是"岗位 → 池"而不是"岗位 → 一把 key"**：岗位有 5 个，调用形态只有 4 种（研判 / 执行 / 长文档 / 视觉）。按岗位发 key 会得到 5 把低配额 key，且同一张工单跨岗位协作时用量散落在 3–4 把 key 上，既算不清单工单成本，也无法在限流时腾挪。岗位 → 池保留了"每个岗位用自己的模型"的表达力，又让配额集中可用。

配法（`~/.superagent/model.yml`）：

```yaml
baseUrl: https://api.deepseek.com/v1
model: deepseek-chat
apiKey: ""                     # 或 apiKeyEnv: DEEPSEEK_API_KEY

pools:                         # 不配则全部继承上面的默认
  worker:
    model: deepseek-reasoner
    keys: [{ id: w1, apiKeyEnv: EA_WORKER_DS_01 }, { id: w2, apiKeyEnv: EA_WORKER_DS_02 }]
  doc:
    model: deepseek-chat
    apiKeyEnv: EA_DOC_DS_01

budget:
  tokensPerTicket: 120000      # 超限即停，保留骨架，不静默降级换模型
```

**模型能写什么、不能写什么**：

| 允许 | 禁止 | 保障手段 |
| --- | --- | --- |
| 依据工单原文归纳问题描述、影响范围、临时措施 | 编造 S/O/D 分值、Cpk、GRR、温度/电压等实测值 | 提示词硬约束 + 事后扫描"输入里没有的数字"并标注 `⚠ 待核实` |
| 按模板章节组织内容 | 新增/删除章节、改 `id`/`status`、写 front-matter | 只接受已存在章节，标题精确或唯一模糊匹配 |
| 提出需要人确认的问题 | 假装已确认 | 进 `openQuestions`，写进派工备注与 PR |

生成的文档会在 front-matter 留痕：`preparedBy: "QE 质量工程师"`、`aiAssisted: true`、`aiModel: ...`。
评审时据此判断"这段是人写的还是模型写的"，**AI 草稿不能当作已评审内容**。

## 6. 管理员工作台（`/admin`）

一个页面回答四个问题，不需要去翻数据库：

| 区块 | 回答什么 | 关键字段 |
| --- | --- | --- |
| 概览 | 系统现在什么状态 | 正在执行 / 排队 / 待评审 / 阻塞、今日 tokens、可用 key 数、退出码与告警 |
| **岗位状态** | 谁在干活、谁空闲、谁没 key | 每个岗位：`在干活 / 空闲 / 无可用密钥`、当前工单与开始时间、最近一次调用（用途/tokens/多久前）、今日用量、可用模型 |
| 执行与队列 | 卡在哪一步 | 每张派工的状态与备注（为什么 blocked、AI 填了几节） |
| **交付物** | 产出了什么 | 文档类型、所属工单、阶段、结构校验结果、**AI 草稿 / 骨架**、文件路径、产出时间 |
| 阶段门 | 缺什么才能放行 | 门禁状态、缺口清单、签署人和授权操作 |
| 密钥与池 | key 能不能用、钱花在哪 | 每个池的 key 列表（掩码）、可用/停用/环境变量缺失、累计用量、最近自检结果 |

密钥管理是就地可写的：新增、停用、换 key、改模型/baseUrl、单把自检、删除、改预算。保存后立即重建运行时池，**不需要重启进程**。

两个存储层，别混淆：

| 文件 | 谁维护 | 作用 |
| --- | --- | --- |
| `~/.superagent/model.yml` | 人 | 声明式基线：默认网关、池、预算 |
| `~/.superagent/keys.json` | 工作台 | 运行时密钥库；某个池只要在这里出现，就以它为准（整组覆盖） |

工作台通过回环监听器提供。写接口要求 `x-superagent-request: 1`。签署、退回、撤回和重试还需要 `Authorization: Bearer <操作员令牌>`。服务端从进程环境变量 `SUPERAGENT_OPERATOR_TOKENS` 读取 `open_id → 令牌` 的 JSON 对象，并按项目策略核对角色。为每人使用独立的随机令牌，可用 `node -p "require('node:crypto').randomBytes(32).toString('base64url')"` 生成。工作台输入的令牌用完即清空，未配置身份时可由本机受信任的运维人员使用 CLI 操作。

模型密钥存于用户主目录，接口只返回掩码。飞书事件入口单独对外转发时，只开放 `/feishu/event`。

对应接口：`GET /api/workbench`（聚合视图）、`GET /api/keys`、`POST /api/keys`、`PATCH|DELETE /api/keys/:pool/:id`、`POST /api/keys/:pool/:id/test`、`PUT /api/keys/budget`。

下阶段工单在前置门禁放行前留在队列里。量产 8D 独立执行。签署即刻重查交付物。门禁退回后，关联工单可重试。没有关联待办时，有签署权限的人可在补齐证据后用 `gate resubmit <G> --dir <项目> --as <open_id>` 重新提审。

## 7. 刻意不做的事

| 不做 | 原因 |
| --- | --- |
| 让模型"自由发挥" | 只能填已有章节、只依据工单原文；输入里没有的数值事后标注待核实。无 key 时退回骨架，不假装生成 |
| 自动合并 PR / 打标签 | 违反最小权限；只产出 PR 草案 |
| 阶段门自动放行 | 质量责任不可转移；机器最多推进到 `pending` |
| 猜测未分类产物 | 错分类会污染特殊特性推导，宁可进 `_unclassified` |
| 独立进程沙箱执行器 | MVP 同类同进程；接口按可拆设计（只传 ID 与纯数据） |

## 8. 落地到真实环境

1. **接飞书**。设 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 和 `FEISHU_VERIFICATION_TOKEN`，以 `--source feishu` 启动。需要群聊触发时设置 `FEISHU_BOT_OPEN_ID`。启用 `im.message.receive_v1` 并将 HTTPS 回调转发给 `POST /feishu/event`。事件落库后才确认，处理结果回复原消息。
2. **改策略**：把 `.superagent/policy.yml` 里的 `ou_xxx*` 换成真实 `open_id`，`admission` 的群 ID 换成真实群。
3. **配模型密钥**（可选，不配也能跑，只是不生成技术内容）：

   ```bash
   mkdir -p ~/.superagent                       # Windows: %USERPROFILE%\.superagent
   cp model.example.yml ~/.superagent/model.yml  # 然后填 baseUrl / model / apiKey
   node src/cli.mjs model --dir ./pcu24 --check  # 自检：能连通、key 有效
   ```

   密钥位置优先级：**环境变量 > `~/.superagent/model.yml` > `--file` 指定**（字段级合并）。
   环境变量是 `SUPERAGENT_MODEL_BASE_URL` / `SUPERAGENT_MODEL_API_KEY` / `SUPERAGENT_MODEL_NAME`。
   文件里也可以只写 `apiKeyEnv: DEEPSEEK_API_KEY`，把值留在环境里。

   **不要**把密钥写进 `.superagent/*.yml` 或任何会被提交的文件——那等于把凭据写进 Git 历史。
4. **接真实 PR**：`executor/repo.mjs` 已生成 PR 草案 `.md`，接 `gh pr create` 或平台 API 即可（默认不开，需显式开启）。

## 9. 固件修改与编译

在授权工单中明确给出应用层 `.c` 或 `.h` 的项目相对路径，例如 `firmware/app/main.c`。启用 S2，并先放行项目启用的前置阶段门。在项目自己的 `.superagent/manifest.yml` 的现有 `integrations` 节点下增加构建配置。

```yaml
integrations:
  firmware:
    build:
      executable: cmake
      args: ["--build", "build"]
      cwd: "."
      timeoutMs: 300000
```

构建命令由维护者配置，替换成项目已经使用的工具和参数。Windows 下可指定编译器的绝对路径。目标源码需使用 UTF-8。执行器会先备份原文件，再应用候选源码并执行构建。构建失败时恢复本次写入的源码并把工单标为阻塞。修复原因后，可从工作台重试或执行 `retry <ticket_id> --dir <项目> --as <open_id>`。每次重试保留历史派工记录。

在提供 `agentPresets` 服务的 DSH profile 中加载 bundle，例如 `web` profile。将 profile 的 `node_modules/@local/electronics-superagent` 链接到完整 checkout 中的 `dsh-bundle` 目录，再把 `@local/electronics-superagent` 加到该 profile 的 `package.json` 的 `dsh.profile.bundles`。设置 `SUPERAGENT_PROJECT_DIR` 指向已初始化的目标项目。来源默认 `local`，接飞书时设置 `SUPERAGENT_SOURCE=feishu`。软件工程师 preset 使用 DSH 当前默认模型生成候选源码，共用 MVP 的构建与提交流程。

## 10. 已知限制

- **堆叠分支**：每张工单分支基于上一张，使工作区文档持续累积；PR 需按顺序评审。生产应改为 worktree 从 `develop` 拉出（docs/00 §10 已记录）。
- **路由是关键词**：复杂或含糊需求会落到 `clarify`，只问一句。这是设计内行为，不是缺陷。
- **门禁只覆盖 G1–G4 的机械检查**：`cpk`、`grr` 等数值判定依赖真实数据，尚未接入。
- **`node:sqlite` 仍标记实验性**：升级 Node 大版本前请跑一遍测试。
- **模型是直连，没有网关**：无票据、无按工单预算、无失败换 key。单人单实例够用；多人共用或需要 token 审计时必须换到 `docs/08` 描述的本地网关（迁移触发条件见 `docs/08` §8.3）。
- **预算按 token 计，不按金额**：不同供应商单价差异大，代码里不硬编码价格；要按人民币熔断需在网关侧换算。
- **岗位提示词是通用稿**：PM/SW/HW/PE/QE 五份提示词按行业通识写，落地时需按贵司术语与模板习惯调整（`src/executor/positions.mjs`）。
- **AI 草稿必须人评审**：`aiAssisted: true` 的文档只是草稿；门禁的机械检查通过 ≠ 内容正确。
