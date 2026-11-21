// 组合根 + 调度循环。这里不含业务规则：只负责装配、按周期推进、把错误变成可判断的状态。
// 一个周期做六件事（docs/00 §7）：收事件 → 评估 → 接单 → 执行 → 刷新门禁 → 投递回写。

import path from 'node:path';
import { loadProject, loadPolicy, assertStricter, effectiveRules, ConfigError } from '../config/load.mjs';
import { openDb } from '../store/db.mjs';
import { Engine } from '../domain/engine.mjs';
import { createPolicy } from '../domain/policy.mjs';
import { planFor } from '../domain/stages.mjs';
import { refreshGates } from '../domain/gate.mjs';
import { clarifyQuestion } from '../domain/router.mjs';
import { createLocalSource } from '../sources/local.mjs';
import { createFeishuSource } from '../sources/feishu.mjs';
import { runAssignment } from '../executor/executor.mjs';
import { gatewayFromConfig, resolveModelConfig } from '../executor/model.mjs';
import { createKeyPool } from '../executor/keypool.mjs';
import { loadKeyStore, DEFAULT_KEYS_FILE } from '../executor/keystore.mjs';
import { listPositions } from '../executor/positions.mjs';
import { PACKAGE_ROOT } from './bootstrap.mjs';
import { exists } from '../util/fsx.mjs';

export class Runtime {
  constructor(props) {
    Object.assign(this, props);
    this.startedAt = new Date().toISOString();
    this.errors = [];
    this.needsRestart = false;
    this.lastTick = null;
  }

  static async create({ dir, options = {} }) {
    const project = await loadProject(dir);

    const requested = options.policyFile
      ?? path.join(dir, '.superagent', 'policy.yml');
    const resolvedPolicy = (await exists(requested))
      ? requested
      : path.join(PACKAGE_ROOT, 'config/policy.example.yml');

    const { policy, errors: policyErrors } = await loadPolicy(resolvedPolicy);
    const fatal = policyErrors.filter((e) => !e.startsWith('acceptMode=auto 但白名单为空'));
    if (fatal.length) throw new ConfigError('策略配置校验失败', fatal);

    const strict = assertStricter(project.rules);
    if (!strict.ok) throw new ConfigError('项目规则宽于平台基线，拒绝启动', strict.errors);

    const rules = effectiveRules(project.rules, policy);
    const db = await openDb(project.paths.state);
    const policyObj = createPolicy({ policy, manifest: project.manifest });
    const engine = new Engine({ db, policy: policyObj, manifest: project.manifest });
    const recovered = engine.recover();

    let source = null;
    let sourceError = null;
    const sourceKind = options.source ?? 'local';
    if (sourceKind === 'feishu') {
      const env = options.env ?? process.env;
      source = createFeishuSource({
        appId: env.FEISHU_APP_ID,
        appSecret: env.FEISHU_APP_SECRET,
        verificationToken: env.FEISHU_VERIFICATION_TOKEN,
        botOpenId: env.FEISHU_BOT_OPEN_ID ?? null,
      });
      if (!source) sourceError = '缺少 FEISHU_APP_ID / FEISHU_APP_SECRET，飞书来源未启用（退出码 3）';
    } else {
      source = createLocalSource({ projectDir: project.root });
    }

    // 模型配置：显式传入 > 环境变量 > ~/.superagent/model.yml；
    // 没有 key 不报错，退化为 nullGateway（不生成内容，但流程照跑）
    let model;
    let modelInfo;
    if (options.model) {
      model = options.model;
      modelInfo = {
        source: 'override', keySource: 'override', baseUrl: null, apiKey: '', file: null,
        fileExists: false, warnings: [],
      };
    } else {
      modelInfo = await resolveModelConfig({
        env: options.env ?? process.env,
        file: options.modelFile ?? null,
        overrides: options.modelOverrides ?? {},
      });
      model = gatewayFromConfig(modelInfo);
    }

    // 密钥库：model.yml 是人工基线，keys.json 是工作台可写层（按池整组覆盖）。
    // 注入 model 时（测试/嵌入）不读真实密钥文件，避免把开发机的 key 带进测试。
    const env = options.env ?? process.env;
    const keysFile = options.keysFile ?? (options.model ? null : DEFAULT_KEYS_FILE);
    const keys = await loadKeyStore({
      file: keysFile,
      env,
      seed: {
        pools: modelInfo.pools ?? {},
        baseUrl: modelInfo.baseUrl,
        model: modelInfo.model,
        budget: modelInfo.budget,
      },
    });

    // 密钥池：池 → 岗位 → 用哪把 key。未配池时全部继承默认网关，保持"只填一把 key"可用
    const poolConfig = keys.toPoolConfig();
    const pool = createKeyPool({
      config: { ...modelInfo, pools: poolConfig.pools, budget: poolConfig.budget },
      env,
      fallback: options.model ? options.model : (model.configured ? model : null),
    });

    const rt = new Runtime({
      project, policy, policyObj, policyFile: resolvedPolicy, policyErrors,
      rules, db, engine, source, sourceError, sourceKind, model, modelInfo, pool, keys, env, options, recovered,
    });

    if (source) await source.start();
    return rt;
  }

  // ------------------------------------------------------------- 主循环

  async tick() {
    const summary = { received: 0, duplicate: 0, evaluated: 0, accepted: 0, rejected: 0, clarified: 0, executed: 0, gates: [], errors: [] };

    if (!this.source) {
      this.errors.push(this.sourceError ?? '来源未就绪');
      return summary;
    }

    try {
      const events = await this.source.poll();
      for (const evt of events) {
        const r = this.engine.receive(evt);
        if (r.status === 'new') summary.received += 1;
        else summary.duplicate += 1;
      }
    } catch (err) {
      summary.errors.push(`接收失败：${err.message}`);
      this.errors.push(`source.poll: ${err.message}`);
    }

    for (const t of this.engine.pendingThreads()) {
      let ev;
      try {
        ev = this.engine.evaluate(t.threadId);
      } catch (err) {
        summary.errors.push(`评估失败 ${t.threadId}：${err.message}`);
        continue;
      }
      if (!ev) continue;
      summary.evaluated += 1;

      if (ev.status === 'context') continue;

      if (ev.status === 'rejected') {
        summary.rejected += 1;
        // 只在被点名时说明原因：陌生人未 @ 的请求静默处理，不占用注意力
        if (this.wasAddressed(t.threadId)) {
          this.replyToThread(t.threadId, `这条请求没有进入工单：${ev.reason}`);
        }
        continue;
      }
      if (ev.verdict === 'clarify') {
        summary.clarified += 1;
        this.replyToThread(t.threadId, clarifyQuestion(ev.assessment));
        continue;
      }

      const acc = this.engine.accept(ev.id, { actor: 'engine' });
      if (acc.status === 'accepted') summary.accepted += 1;
      else if (acc.status === 'observed') this.replyToThread(t.threadId, `observe 模式：本会接单（${ev.assessment?.taskType}）。切到 auto 后才会实际开工。`);
    }

    // 串行执行：保证仓库不被并发写（docs/00 §7）
    for (let i = 0; i < 10; i++) {
      const assignment = this.engine.claimNextAssignment();
      if (!assignment) break;
      summary.executed += 1;
      await this.executeOne(assignment, summary);
    }

    try {
      summary.gates = await refreshGates({ project: this.project, engine: this.engine, rules: this.rules });
    } catch (err) {
      summary.errors.push(`门禁检查失败：${err.message}`);
    }

    await this.flushOutbox();
    this.lastTick = { at: new Date().toISOString(), summary };
    return summary;
  }

  async executeOne(assignment, summary) {
    const ticket = this.engine.getTicket(assignment.ticket_id);
    if (!ticket) return;
    const ev = this.engine.getEval(ticket.eval_id);
    const assessment = ev?.assessment ?? {};
    const basePlan = planFor(assessment.taskType ?? ticket.task_type, ticket.stage);
    const plan = {
      ...basePlan,
      ...assessment,
      stage: assessment.stage ?? ticket.stage,
      gateTarget: assessment.gateTarget ?? ticket.gate_target,
      docTypes: assessment.docTypes?.length ? assessment.docTypes : basePlan.docTypes,
    };

    // 工单原文交给岗位当"唯一事实来源"：模型只能依据它写，不得自行补事实
    const history = this.engine.history(ticket.id);
    const inputText = (history?.triggers ?? []).map((t) => t.body).join('\n---\n');
    plan.inputText = inputText;

    try {
      const result = await runAssignment({
        assignment, ticket, plan, project: this.project, rules: this.rules,
        policy: this.policy, engine: this.engine, stateDir: this.project.paths.state,
        fallbackTemplateDir: path.join(PACKAGE_ROOT, 'templates'),
        options: {
          git: this.options.git !== false,
          author: this.policy.execution?.commitAuthor,
          pool: this.pool,
          budget: this.modelInfo?.budget,
          aiFill: this.options.aiFill !== false,
        },
      });

      if (result.status === 'ready') {
        this.engine.addReport({
          ticketId: ticket.id, assignmentId: assignment.id, kind: 'ready',
          body: `产出 ${result.assets.length} 份文档${result.commit?.sha ? `，提交 ${result.commit.sha}` : ''}`,
        });
        this.engine.finishAssignment({
          assignmentId: assignment.id, ticketId: ticket.id, status: 'done',
          note: result.notes.join(' | ').slice(0, 500) || null, ticketStatus: 'review',
        });
        this.replyToThread(ticket.thread_id,
          `${ticket.id} 已产出 ${result.assets.length} 份文档并提交到 ${result.commit?.branch ?? '(未提交)'}：\n`
          + result.assets.map((a) => `· ${a.relPath}`).join('\n')
          + (result.prDraftPath ? `\nPR 草案：${result.prDraftPath}` : '')
          + (ticket.gate_target ? `\n门禁 ${ticket.gate_target} 需人工签署后才可进入下一阶段。` : ''),
          ticket.id);
      } else {
        this.engine.addReport({
          ticketId: ticket.id, assignmentId: assignment.id, kind: result.status,
          body: result.reason ?? '',
        });
        this.engine.finishAssignment({
          assignmentId: assignment.id, ticketId: ticket.id, status: result.status,
          note: (result.reason ?? '').slice(0, 500), ticketStatus: 'blocked',
        });
        this.replyToThread(ticket.thread_id,
          `${ticket.id} 暂停在阻塞状态：${result.reason}\n需要人工处理后重试。`, ticket.id);
      }
    } catch (err) {
      summary.errors.push(`执行失败 ${ticket.id}：${err.message}`);
      this.engine.addReport({ ticketId: ticket.id, assignmentId: assignment.id, kind: 'failed', body: err.message });
      this.engine.finishAssignment({
        assignmentId: assignment.id, ticketId: ticket.id, status: 'failed',
        note: err.message.slice(0, 500), ticketStatus: 'blocked',
      });
      this.errors.push(`execute ${ticket.id}: ${err.message}`);
    }
  }

  // ------------------------------------------------------------- 回写

  replyToThread(threadId, text, ticketId = null) {
    const key = ticketId ? `msg:${ticketId}:${Date.now()}` : `msg:${threadId}:${Date.now()}:${text.length}`;
    this.engine.enqueueOutbox({ kind: 'reply', dedupeKey: key, payload: { threadId, text } });
  }

  wasAddressed(threadId) {
    const row = this.engine.db.get(
      'SELECT addressed FROM trigger WHERE thread_id = ? ORDER BY at DESC, rowid DESC LIMIT 1', threadId
    );
    return !!row?.addressed;
  }

  chatOfThread(threadId) {
    if (!threadId) return null;
    const row = this.engine.db.get(
      'SELECT chat_id FROM trigger WHERE thread_id = ? ORDER BY at DESC LIMIT 1', threadId
    );
    return row?.chat_id ?? null;
  }

  async flushOutbox() {
    for (const row of this.engine.dueOutbox()) {
      const payload = JSON.parse(row.payload);
      const chatId = payload.chatId ?? this.chatOfThread(payload.threadId);
      try {
        await this.source.send({ text: payload.text, chatId, threadId: payload.threadId, dedupeKey: row.dedupe_key });
        this.engine.markOutboxSent(row.id);
      } catch (err) {
        const attempts = row.attempts + 1;
        const delay = Math.min(300000, 5000 * 2 ** attempts);
        this.engine.markOutboxFailed(row.id, err.message, attempts, new Date(Date.now() + delay).toISOString());
      }
    }
  }

  // ------------------------------------------------------------- 运行与状态

  async run({ intervalMs = 1500, once = false, onTick = null, signal = null } = {}) {
    const summary = [];
    let stopped = false;
    const stop = () => { stopped = true; };
    if (signal) signal.addEventListener('abort', stop, { once: true });

    do {
      const s = await this.tick();
      summary.push(s);
      if (onTick) onTick(s);
      if (once || stopped) break;
      await new Promise((r) => setTimeout(r, intervalMs));
    } while (!stopped);

    return summary;
  }

  /** 工作台改了密钥后重建池：不重启进程，下一次派工即生效 */
  async reloadKeys() {
    if (this.keys) await this.keys.load();
    const cfg = this.keys.toPoolConfig();
    this.modelInfo = { ...this.modelInfo, budget: cfg.budget };
    this.pool = createKeyPool({
      config: { ...this.modelInfo, pools: cfg.pools, budget: cfg.budget },
      env: this.env,
      fallback: this.options?.model ?? (this.model?.configured ? this.model : null),
    });
    return this.pool.describe();
  }

  status() {
    const stats = this.engine.stats();
    const sourceReady = !!this.source;
    const hasWhitelist = this.policyObj.users.size > 0;
    const targets = this.engine.listTickets({ status: 'blocked' });

    let exitCode = 0;
    let reason = '正常';
    if (!sourceReady) { exitCode = 3; reason = this.sourceError ?? '来源未配置'; }
    else if (!hasWhitelist) { exitCode = 3; reason = '白名单为空：任何请求都不会成为工单'; }
    else if (this.errors.length && this.lastTick?.summary?.errors?.length) { exitCode = 2; reason = '存在部件错误，详见 errors'; }
    else if (this.needsRestart) { exitCode = 1; reason = '需要重启'; }

    return {
      project: {
        code: this.project.manifest.code,
        name: this.project.manifest.name,
        stages: this.project.manifest.stages?.enabled ?? [],
        topology: this.project.manifest.topology,
      },
      source: { kind: this.sourceKind, ready: sourceReady, error: this.sourceError },
      policy: { version: this.policyObj.version, acceptMode: this.policyObj.acceptMode, whitelist: this.policyObj.users.size },
      model: {
        gateway: this.model?.name ?? 'null',
        configured: !!this.model?.configured || (this.pool?.describe()?.length ?? 0) > 0,
        source: this.modelInfo?.source ?? 'none',
        baseUrl: this.modelInfo?.baseUrl || null,
        apiKeySet: !!this.modelInfo?.apiKey,
        file: this.modelInfo?.file ?? null,
        warnings: this.modelInfo?.warnings ?? [],
        pools: this.pool?.describe() ?? [],
        positions: listPositions().map((p) => ({ code: p.code, name: p.name, pool: p.pool })),
        keyStore: this.keys ? (() => {
          const snap = this.keys.snapshot();
          return { file: snap.file, exists: snap.fileExists, corrupt: snap.corrupt, totals: snap.totals };
        })() : null,
      },
      usage: this.engine.usageSummary({ since: new Date().toISOString().slice(0, 10) }),
      stats: { ...stats, blockedTickets: targets.length, pendingSignatures: stats.pendingSignatures },
      lastTick: this.lastTick,
      recovered: this.recovered,
      gateExitCode: exitCode,
      reason,
      errors: this.errors.slice(-5),
      startedAt: this.startedAt,
    };
  }

  /** 面板一次性数据：只回答三个问题（docs/01 §10） */
  panelData() {
    const attention = this.engine.db.all(
      `SELECT id, title, status, stage, task_type, blocked_reason, updated_at FROM ticket
        WHERE status IN ('review','blocked') ORDER BY updated_at DESC LIMIT 20`
    );
    const gates = this.engine.listGates();
    return {
      status: this.status(),
      attention: {
        tickets: attention,
        gates: gates.filter((g) => g.status === 'pending' || g.status === 'preparing'),
      },
      recent: this.engine.listTickets({ limit: 10 }),
      evals: this.engine.listEvals(10).map((e) => ({
        id: e.id, status: e.status, verdict: e.verdict, reason: e.reason,
        task_type: e.task_type, stage: e.stage, created_at: e.created_at,
      })),
      gates,
    };
  }

  async close() {
    try { await this.source?.stop(); } catch { /* 忽略关闭异常 */ }
    this.db.close();
  }
}

export { ConfigError };
