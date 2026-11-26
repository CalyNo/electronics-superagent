// Engine 是唯一写入者：Trigger / Eval / Ticket / Mandate / Assignment / Gate 的每次变更都经过这里。
// 约束（docs/00 §8）：
//   - 状态转换用显式表校验，非法转换抛 UserError（固定错误码，不暴露内部细节）
//   - Mandate 只插入不更新：扩大范围必须新工单
//   - gate 的 released 只能由 signGate() 写入，且必须有签署权
//   - 所有多表写在一个事务里；跨表一致性与副作用入队同时提交

import { stableKey, docId, ticketId as makeTicketId, assignmentId as makeAssignmentId } from '../util/ids.mjs';
import { assess } from './router.mjs';
import { buildMandate } from './policy.mjs';
import { GATES } from './stages.mjs';

export class UserError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'UserError';
    this.code = code;
    this.details = details;
  }
}

const TICKET_TRANSITIONS = {
  open: ['working', 'blocked', 'dropped'],
  working: ['review', 'blocked', 'dropped'],
  review: ['closed', 'blocked', 'working'],
  blocked: ['working', 'dropped'],
  closed: [],
  dropped: [],
};

const GATE_MACHINE = {
  not_started: ['preparing', 'pending'],
  preparing: ['pending', 'not_started'],
  pending: ['released', 'returned', 'preparing'],
  returned: ['preparing', 'pending'],
  released: [],
};

export class Engine {
  constructor({ db, policy, manifest, clock }) {
    this.db = db;
    this.policy = policy;
    this.manifest = manifest;
    this.clock = clock ?? { now: () => new Date().toISOString() };
  }

  now() { return this.clock.now(); }

  audit(actor, action, subject = null, detail = null) {
    this.db.run(
      'INSERT INTO audit(at, actor, action, subject, detail) VALUES(?,?,?,?,?)',
      this.now(), actor, action, subject, detail == null ? null : String(detail)
    );
  }

  // ---------------------------------------------------------------- 接入

  /**
   * 接收一条外部事件。幂等：同一 (source, externalId) 只产生一个 Trigger。
   * @returns {{status:'new'|'duplicate', triggerId:string, threadId:string}}
   */
  receive(evt) {
    const at = evt.at ?? this.now();
    return this.db.tx(() => {
      const dup = this.db.get(
        'SELECT id, thread_id FROM trigger WHERE source = ? AND external_id = ?',
        evt.source, evt.externalId
      );
      if (dup) {
        this.audit(evt.source, 'trigger.duplicate', dup.id, evt.externalId);
        return { status: 'duplicate', triggerId: dup.id, threadId: dup.thread_id };
      }

      const threadId = `THR-${stableKey(evt.source, evt.threadKey ?? evt.externalId).slice(0, 10)}`;
      const triggerId = `TRG-${stableKey(evt.source, evt.externalId).slice(0, 10)}`;

      const t = this.db.get('SELECT id, title FROM thread WHERE id = ?', threadId);
      if (!t) {
        this.db.run(
          'INSERT INTO thread(id, source, title, stage, created_at, updated_at) VALUES(?,?,?,?,?,?)',
          threadId, evt.source, String(evt.body ?? '').slice(0, 60), null, at, at
        );
      } else {
        this.db.run('UPDATE thread SET updated_at = ? WHERE id = ?', at, threadId);
      }

      this.db.run(
        `INSERT INTO trigger(id, source, external_id, thread_id, actor_id, actor_name, chat_id, body, at, addressed, disposition, meta)
         VALUES(?,?,?,?,?,?,?,?,?,?, 'new', ?)`,
        triggerId, evt.source, evt.externalId, threadId, evt.actorId,
        evt.actorName ?? evt.actorId, evt.chatId ?? null, String(evt.body ?? ''),
        at, evt.addressed ? 1 : 0, evt.meta ? JSON.stringify(evt.meta) : null
      );
      this.audit(evt.source, 'trigger.new', triggerId, `thread=${threadId}`);
      return { status: 'new', triggerId, threadId };
    });
  }

  pendingThreads() {
    return this.db.all(
      `SELECT tr.thread_id AS threadId, COUNT(*) AS pending, MIN(tr.at) AS firstAt
         FROM trigger tr WHERE tr.disposition = 'new'
        GROUP BY tr.thread_id ORDER BY firstAt`
    );
  }

  // ---------------------------------------------------------------- 评估

  /**
   * 对一个线程的待处理触发做一次评估（同一线程同一时刻只有一个 Eval）。
   * 三种结果：context（仅上下文）/ rejected（不准入）/ open（可接，含 clarify）
   */
  evaluate(threadId) {
    const rows = this.db.all(
      "SELECT * FROM trigger WHERE thread_id = ? AND disposition = 'new' ORDER BY at, rowid", threadId
    );
    if (!rows.length) return null;

    const last = rows[rows.length - 1];
    const triggerIds = rows.map((r) => r.id);
    const at = this.now();

    return this.db.tx(() => {
      for (const id of triggerIds) {
        this.db.run("UPDATE trigger SET disposition = 'consumed' WHERE id = ?", id);
      }

      const g = this.policy.gate({
        source: last.source, actorId: last.actor_id, chatId: last.chat_id, addressed: !!last.addressed,
      });

      // 仅上下文：附着到已有工单，不新开
      if (g.contextOnly) {
        const open = this.db.get(
          "SELECT id FROM ticket WHERE thread_id = ? AND status IN ('open','working','review') ORDER BY created_at DESC LIMIT 1",
          threadId
        );
        if (open) {
          this.addReport({ ticketId: open.id, kind: 'context', body: `补充信息：${last.body}` });
          this.audit(last.actor_id, 'eval.context', open.id, g.reason);
          return { status: 'context', ticketId: open.id, triggerIds, reason: g.reason };
        }
        // 没有可附着的工单：它是上下文而非请求，既不建单也不算拒绝（拒绝统计只记真正的越权）
        this.audit(last.actor_id, 'eval.context.no-target', null, g.reason);
        return { status: 'context', ticketId: null, triggerIds, reason: '仅补充上下文，当前没有可附着的工单' };
      }

      const year = at.slice(0, 4);
      const seq = this.db.nextSeq(`eval-${year}`, at);
      const id = `EVL-${year}-${String(seq).padStart(4, '0')}`;

      if (!g.admitted) {
        this.db.run(
          `INSERT INTO eval(id, thread_id, trigger_ids, status, verdict, reason, policy_version, created_at, decided_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
          id, threadId, JSON.stringify(triggerIds), 'rejected', 'reject', g.reason, this.policy.version, at, at
        );
        this.audit(last.actor_id, 'eval.rejected', id, g.reason);
        return { id, status: 'rejected', verdict: 'reject', reason: g.reason, triggerIds };
      }

      const assessment = assess({
        text: rows.map((r) => r.body).join('\n'),
        policyRules: this.policy.rules ?? [],
        defaultStage: (this.manifest?.stages?.enabled ?? ['S1'])[0],
      });

      const ci = this.policy.canInitiate(last.actor_id, assessment.taskType);
      if (!ci.ok) {
        this.db.run(
          `INSERT INTO eval(id, thread_id, trigger_ids, status, verdict, reason, task_type, stage, assessment, policy_version, created_at, decided_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          id, threadId, JSON.stringify(triggerIds), 'rejected', 'reject', ci.reason,
          assessment.taskType, assessment.stage, JSON.stringify(assessment), this.policy.version, at, at
        );
        this.audit(last.actor_id, 'eval.rejected', id, ci.reason);
        return { id, status: 'rejected', verdict: 'reject', reason: ci.reason, triggerIds };
      }

      const verdict = assessment.taskType === 'clarify' ? 'clarify' : 'accept';
      this.db.run(
        `INSERT INTO eval(id, thread_id, trigger_ids, status, verdict, reason, task_type, stage, gate_target, severity, assessment, policy_version, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, threadId, JSON.stringify(triggerIds), 'open', verdict, assessment.reason,
        assessment.taskType, assessment.stage, assessment.gateTarget, assessment.severity,
        JSON.stringify(assessment), this.policy.version, at
      );
      this.audit(last.actor_id, `eval.${verdict}`, id, `${assessment.taskType}/${assessment.stage ?? '-'}`);
      return this.getEval(id);
    });
  }

  getEval(id) {
    const row = this.db.get('SELECT * FROM eval WHERE id = ?', id);
    if (!row) return null;
    return { ...row, assessment: row.assessment ? JSON.parse(row.assessment) : null, triggerIds: JSON.parse(row.trigger_ids) };
  }

  // ---------------------------------------------------------------- 接单

  /** 接受一个评估结果，事务内建 Ticket + Mandate + Assignment + 致谢 */
  accept(evalId, { actor = 'system' } = {}) {
    const ev = this.getEval(evalId);
    if (!ev) throw new UserError('eval/not-found', `评估不存在：${evalId}`);
    if (ev.status !== 'open') throw new UserError('eval/closed', `评估 ${evalId} 已是 ${ev.status}，不能重复接单`);
    if (ev.verdict !== 'accept') throw new UserError('eval/not-acceptable', `评估 ${evalId} 的结论是 ${ev.verdict}`);

    if (this.policy.acceptMode === 'off') {
      return { status: 'disallowed', reason: 'acceptMode=off' };
    }
    if (this.policy.acceptMode === 'observe') {
      this.db.tx(() => {
        this.db.run("UPDATE eval SET status = 'accepted', decided_at = ? WHERE id = ?", this.now(), evalId);
        this.audit(actor, 'eval.observed', evalId, 'observe 模式：记录"本会接"，不实际开工');
      });
      return { status: 'observed', evalId };
    }

    const at = this.now();
    const year = at.slice(0, 4);
    const a = ev.assessment ?? {};

    return this.db.tx(() => {
      const tid = makeTicketId(at, this.db.nextSeq(`ticket-${year}`, at));
      this.db.run(
        `INSERT INTO ticket(id, thread_id, eval_id, title, task_type, stage, gate_target, severity, status, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        tid, ev.thread_id, evalId, a.title ?? '未命名任务', a.taskType, a.stage ?? 'S1',
        a.gateTarget ?? null, a.severity ?? 'medium', 'open', at, at
      );

      const mandate = buildMandate({
        ticket: { id: tid, stage: a.stage },
        assessment: a, manifest: this.manifest, policy: this.policy, grantedBy: actor,
      });
      this.db.run(
        `INSERT INTO mandate(id, ticket_id, strength, repo_scope, stage_scope, action_scope, policy_version, granted_by, created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        mandate.id, tid, mandate.strength, mandate.repoScope, mandate.stageScope,
        JSON.stringify(mandate.actionScope), mandate.policyVersion, mandate.grantedBy, at
      );

      const asgId = makeAssignmentId(tid, 1);
      this.db.run(
        'INSERT INTO assignment(id, ticket_id, attempt, status, workdir, note) VALUES(?,?,?,?,?,?)',
        asgId, tid, 1, 'queued', null, '待执行'
      );

      this.db.run("UPDATE eval SET status = 'accepted', decided_at = ? WHERE id = ?", at, evalId);
      this.db.run('UPDATE thread SET stage = ?, updated_at = ? WHERE id = ?', a.stage ?? null, at, ev.thread_id);

      this.enqueueOutbox({
        kind: 'reply',
        dedupeKey: `ack:${tid}`,
        triggerIds: ev.triggerIds,
        payload: {
          threadId: ev.thread_id,
          text: `已接单 ${tid}：${a.title}\n类型 ${a.taskType}｜阶段 ${a.stage ?? '-'}｜门禁 ${a.gateTarget ?? '不适用'}\n交付物：${(a.docTypes ?? []).join('、') || '按澄清结果确定'}`,
        },
      });

      this.audit(actor, 'ticket.accepted', tid, `${a.taskType}/${a.stage}`);
      return { status: 'accepted', ticketId: tid, mandateId: mandate.id, assignmentId: asgId };
    });
  }

  reject(evalId, reason, actor = 'system') {
    const ev = this.getEval(evalId);
    if (!ev) throw new UserError('eval/not-found', `评估不存在：${evalId}`);
    this.db.tx(() => {
      this.db.run("UPDATE eval SET status = 'rejected', verdict = 'reject', reason = ?, decided_at = ? WHERE id = ?", reason, this.now(), evalId);
      this.audit(actor, 'eval.reject', evalId, reason);
    });
    return { status: 'rejected', evalId, reason };
  }

  // ---------------------------------------------------------------- 工单

  getTicket(id) {
    const t = this.db.get('SELECT * FROM ticket WHERE id = ?', id);
    if (!t) return null;
    const mandate = this.db.get('SELECT * FROM mandate WHERE ticket_id = ?', id);
    const assignment = this.db.get('SELECT * FROM assignment WHERE ticket_id = ? ORDER BY attempt DESC LIMIT 1', id);
    return {
      ...t,
      mandate: mandate ? { ...mandate, actionScope: JSON.parse(mandate.action_scope) } : null,
      assignment: assignment ?? null,
    };
  }

  listTickets({ status = null, limit = 100 } = {}) {
    const sql = status
      ? 'SELECT * FROM ticket WHERE status = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM ticket ORDER BY created_at DESC LIMIT ?';
    return status ? this.db.all(sql, status, limit) : this.db.all(sql, limit);
  }

  transitionTicket(id, to, { note = null, actor = 'system', force = false } = {}) {
    const t = this.db.get('SELECT status FROM ticket WHERE id = ?', id);
    if (!t) throw new UserError('ticket/not-found', `工单不存在：${id}`);
    if (!force && !(TICKET_TRANSITIONS[t.status] ?? []).includes(to)) {
      throw new UserError('ticket/bad-transition', `工单 ${id} 不能从 ${t.status} 转为 ${to}`, {
        allowed: TICKET_TRANSITIONS[t.status] ?? [],
      });
    }
    if (to === 'closed') {
      const assets = this.db.all("SELECT id FROM asset WHERE ticket_id = ? AND status = 'valid'", id);
      if (!assets.length) throw new UserError('ticket/no-asset', `工单 ${id} 没有结构校验通过的产物，不能关闭`);
    }
    this.db.run('UPDATE ticket SET status = ?, updated_at = ?, blocked_reason = ? WHERE id = ?', to, this.now(), note, id);
    this.audit(actor, `ticket.${to}`, id, note);
    return { status: to };
  }

  /** 人撤回：执行器不能自我停止，只有这条路径能把工单置为 dropped */
  stopTicket(id, { actor, reason = '人工撤回' } = {}) {
    return this.db.tx(() => {
      const t = this.getTicket(id);
      this.assertTicketOperator(t, id, actor);
      if (t.status === 'closed' || t.status === 'dropped') {
        throw new UserError('ticket/settled', `工单 ${id} 已 ${t.status}，无需撤回`);
      }
      if (t.assignment?.status === 'working') throw new UserError('ticket/busy', `工单 ${id} 正在执行，请等待本轮结束`);
      this.db.run("UPDATE assignment SET status = 'cancelled', ended_at = ?, note = ? WHERE ticket_id = ? AND status = 'queued'", this.now(), reason, id);
      return this.transitionTicket(id, 'dropped', { note: reason, actor, force: true });
    });
  }

  // ---------------------------------------------------------------- 派工

  waitingGates(stage, taskType = null) {
    // 量产质量响应需要独立于研发放行，避免延误客户问题的处理。
    if (taskType === 'quality-8d') return [];
    const enabled = this.manifest?.stages?.enabled ?? [];
    return Object.values(GATES)
      .filter((g) => g.deliverables.length && enabled.includes(g.stage) && g.stage < stage)
      .filter((g) => this.getGate(g.id)?.status !== 'released')
      .map((g) => g.id);
  }

  claimNextAssignment() {
    if (this.policy.acceptMode !== 'auto') return null;
    return this.db.tx(() => {
      const row = this.db.all(
        `SELECT a.id, a.ticket_id, a.attempt, a.workdir, t.title, t.task_type, t.stage, t.gate_target, t.severity, t.thread_id
           FROM assignment a JOIN ticket t ON t.id = a.ticket_id
          WHERE a.status = 'queued' AND t.status IN ('open','working','blocked')
          ORDER BY a.rowid`
      ).find((a) => !this.waitingGates(a.stage, a.task_type).length);
      if (!row) return null;
      const at = this.now();
      this.db.run("UPDATE assignment SET status = 'working', started_at = ? WHERE id = ?", at, row.id);
      this.db.run("UPDATE ticket SET status = 'working', updated_at = ? WHERE id = ? AND status <> 'working'", at, row.ticket_id);
      this.audit('executor', 'assignment.working', row.id, row.ticket_id);
      return row;
    });
  }

  finishAssignment({ assignmentId, ticketId, status, note = null, ticketStatus = null, actor = 'executor' }) {
    const at = this.now();
    this.db.tx(() => {
      this.db.run("UPDATE assignment SET status = ?, ended_at = ?, note = ? WHERE id = ?", status, at, note, assignmentId);
      if (ticketStatus) {
        this.db.run('UPDATE ticket SET status = ?, updated_at = ?, blocked_reason = ? WHERE id = ?', ticketStatus, at, note, ticketId);
        this.audit(actor, `ticket.${ticketStatus}`, ticketId, note);
        if (ticketStatus === 'review') {
          const gateId = this.db.get('SELECT gate_target FROM ticket WHERE id = ?', ticketId)?.gate_target;
          if (gateId && !this.unfinishedGateTickets(gateId).length) {
            this.db.run("UPDATE gate SET status = 'preparing', updated_at = ? WHERE id = ? AND status = 'returned'", at, gateId);
          }
        }
      }
    });
  }

  assertTicketOperator(ticket, id, actorId) {
    if (!ticket) throw new UserError('ticket/not-found', `工单不存在：${id}`);
    const canSign = ticket.gate_target && this.policy.canSign(actorId, ticket.gate_target).ok;
    const canInitiate = this.policy.users.has(actorId) && this.policy.canInitiate(actorId, ticket.task_type).ok;
    if (!canSign && !canInitiate) throw new UserError('ticket/forbidden', `无权操作工单 ${id}`);
  }

  retryTicket(id, { actorId }) {
    return this.db.tx(() => {
      const ticket = this.getTicket(id);
      this.assertTicketOperator(ticket, id, actorId);
      if (ticket.status !== 'blocked') throw new UserError('ticket/not-blocked', `工单 ${id} 当前是 ${ticket.status}，仅阻塞工单可重试`);
      if (['queued', 'working'].includes(ticket.assignment?.status)) {
        throw new UserError('ticket/retry-pending', `工单 ${id} 已有待执行派工`);
      }
      const attempt = (ticket.assignment?.attempt ?? 0) + 1;
      const assignmentId = makeAssignmentId(id, attempt);
      this.db.run(
        'INSERT INTO assignment(id, ticket_id, attempt, status, workdir, note) VALUES(?,?,?,?,?,?)',
        assignmentId, id, attempt, 'queued', null, '人工重新派工'
      );
      this.audit(actorId, 'assignment.retry', assignmentId, id);
      return { assignmentId, attempt };
    });
  }

  addReport({ ticketId, assignmentId = null, kind, body }) {
    const id = `RPT-${stableKey(ticketId, kind, this.now(), Math.random()).slice(0, 8)}`;
    this.db.run(
      'INSERT INTO report(id, ticket_id, assignment_id, kind, body, at) VALUES(?,?,?,?,?,?)',
      id, ticketId, assignmentId, kind, String(body ?? ''), this.now()
    );
    return id;
  }

  // ---------------------------------------------------------------- 资产

  registerAsset({
    ticketId, kind, docType = null, stage = null, path, revision = null, sha256 = null,
    status = 'valid', title = null, position = null, aiAssisted = false,
  }) {
    const id = `AST-${stableKey(ticketId, path).slice(0, 10)}`;
    this.db.run(
      `INSERT INTO asset(id, ticket_id, kind, doc_type, stage, path, revision, sha256, status, created_at, title, position, ai_assisted)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, sha256 = excluded.sha256,
         status = excluded.status, title = excluded.title, position = excluded.position,
         ai_assisted = excluded.ai_assisted`,
      id, ticketId, kind, docType, stage, path, revision, sha256, status, this.now(),
      title, position, aiAssisted ? 1 : 0
    );
    return id;
  }

  assetsOf(ticketId) {
    return this.db.all('SELECT * FROM asset WHERE ticket_id = ? ORDER BY path', ticketId);
  }

  /** 文档流水：同一 (阶段, 类型) 的编号单调递增，保证 DOC-S1-SRS-001 唯一 */
  nextDocIndex(stage, type) {
    return this.db.nextSeq(`doc-${stage}-${type}`, this.now());
  }

  // ---------------------------------------------------------------- 门禁

  getGate(id) {
    const g = this.db.get('SELECT * FROM gate WHERE id = ?', id);
    if (!g) return null;
    return { ...g, checks: g.checks ? JSON.parse(g.checks) : [] };
  }

  listGates() {
    return this.db.all('SELECT * FROM gate ORDER BY id').map((g) => ({ ...g, checks: g.checks ? JSON.parse(g.checks) : [] }));
  }

  ensureGate(id, { name, stage }) {
    const cur = this.getGate(id);
    if (cur) return cur;
    this.db.run(
      "INSERT INTO gate(id, name, stage, status, checks, updated_at) VALUES(?,?,?, 'not_started', '[]', ?)",
      id, name, stage, this.now()
    );
    return this.getGate(id);
  }

  /** 机器只能把门禁推进到 pending；released 只有 signGate 能写 */
  refreshGate(gateId, { status, checks }) {
    const g = this.getGate(gateId);
    if (!g) throw new UserError('gate/not-found', `门禁不存在：${gateId}`);
    // 已放行的门禁不再接受状态改写，只允许刷新证据（回退等于覆盖人的决定）
    if (g.status === 'released') return g;
    if (status === 'released') throw new UserError('gate/machine-cannot-release', '自动检查不能放行门禁，必须由人签署');
    if (!(GATE_MACHINE[g.status] ?? []).includes(status) && g.status !== status) {
      throw new UserError('gate/bad-transition', `门禁 ${gateId} 不能从 ${g.status} 转为 ${status}`, {
        allowed: GATE_MACHINE[g.status] ?? [],
      });
    }
    this.db.run('UPDATE gate SET status = ?, checks = ?, updated_at = ? WHERE id = ?', status, JSON.stringify(checks), this.now(), gateId);
    return this.getGate(gateId);
  }

  /** 退回期间更新缺口，保留退回状态直到修订或人工重提。 */
  updateGateChecks(gateId, checks) {
    this.db.run('UPDATE gate SET checks = ?, updated_at = ? WHERE id = ?', JSON.stringify(checks), this.now(), gateId);
    return this.getGate(gateId);
  }

  unfinishedGateTickets(gateId) {
    return this.db.all("SELECT id FROM ticket WHERE gate_target = ? AND status IN ('open','working','blocked')", gateId);
  }

  #assertGateChecks(gate) {
    if (gate.checks.some((c) => !c.ok && !c.skipped) || this.waitingGates(gate.stage).length || this.unfinishedGateTickets(gate.id).length) {
      throw new UserError('gate/checks-failed', `门禁 ${gate.id} 仍有未完成的前置检查`);
    }
  }

  resubmitGate(gateId, { actorId }) {
    return this.db.tx(() => {
      const gate = this.getGate(gateId);
      if (!gate) throw new UserError('gate/not-found', `门禁不存在：${gateId}`);
      const permission = this.policy.canSign(actorId, gateId);
      if (!permission.ok) throw new UserError('gate/forbidden', permission.reason);
      if (gate.status !== 'returned') throw new UserError('gate/not-returned', `门禁 ${gateId} 当前是 ${gate.status}，仅已退回门禁可重提`);
      this.#assertGateChecks(gate);
      this.audit(actorId, 'gate.resubmitted', gateId);
      return this.refreshGate(gateId, { status: 'pending', checks: gate.checks });
    });
  }

  signGate(gateId, { actorId, note = null }) {
    return this.db.tx(() => this.#releaseGate(gateId, actorId, note));
  }

  #releaseGate(gateId, actorId, note) {
    const g = this.getGate(gateId);
    if (!g) throw new UserError('gate/not-found', `门禁不存在：${gateId}`);
    if (g.status !== 'pending') {
      throw new UserError('gate/not-pending', `门禁 ${gateId} 当前是 ${g.status}，只有待签署状态才能签署`);
    }
    const perm = this.policy.canSign(actorId, gateId);
    if (!perm.ok) throw new UserError('gate/forbidden', perm.reason, { code: 403 });
    this.#assertGateChecks(g);
    const at = this.now();
    this.db.run(
      "UPDATE gate SET status = 'released', signed_by = ?, signed_at = ?, note = ?, updated_at = ? WHERE id = ?",
      this.policy.describe(actorId).name, at, note, at, gateId
    );
    this.audit(actorId, 'gate.released', gateId, note);
    // 门禁放行 = 阶段完成：关闭所有指向该门且待评审的工单（docs/02 §4 状态对应表）
    const signer = this.policy.describe(actorId).name;
    const tickets = this.db.all(
      "SELECT id, thread_id, eval_id FROM ticket WHERE gate_target = ? AND status = 'review'", gateId
    );
    for (const t of tickets) {
      try {
        this.transitionTicket(t.id, 'closed', {
          actor: actorId,
          note: `门禁 ${gateId} 已由 ${signer} 签署放行${note ? '：' + note : ''}`,
        });
        this.enqueueOutbox({
          kind: 'reply',
          dedupeKey: `gate:${gateId}:${at}:${t.id}`,
          triggerIds: this.getEval(t.eval_id)?.triggerIds,
          payload: { threadId: t.thread_id, text: `门禁 ${gateId}（${g.name}）已由 ${signer} 放行，工单 ${t.id} 已关闭。` },
        });
      } catch (err) {
        // 无有效产物的工单不能关闭，保留在 review 并在审计里留痕，避免静默跳过
        this.audit(actorId, 'ticket.close-skipped', t.id, `${gateId} 放行但无法关闭：${err.message}`);
      }
    }
    return this.getGate(gateId);
  }

  returnGate(gateId, { actorId, reason }) {
    return this.db.tx(() => {
      const g = this.getGate(gateId);
      if (!g) throw new UserError('gate/not-found', `门禁不存在：${gateId}`);
      if (g.status !== 'pending') throw new UserError('gate/not-pending', `门禁 ${gateId} 当前是 ${g.status}`);
      const perm = this.policy.canSign(actorId, gateId);
      if (!perm.ok) throw new UserError('gate/forbidden', perm.reason);
      this.db.run("UPDATE gate SET status = 'returned', note = ?, updated_at = ? WHERE id = ?", reason, this.now(), gateId);
      this.audit(actorId, 'gate.returned', gateId, reason);
      const tickets = this.db.all("SELECT id, thread_id, eval_id FROM ticket WHERE gate_target = ? AND status = 'review'", gateId);
      for (const t of tickets) {
        this.transitionTicket(t.id, 'blocked', { actor: actorId, note: `门禁 ${gateId} 退回：${reason}` });
        this.enqueueOutbox({
          kind: 'reply',
          dedupeKey: `gate-return:${gateId}:${this.now()}:${t.id}`,
          triggerIds: this.getEval(t.eval_id)?.triggerIds,
          payload: { threadId: t.thread_id, text: `工单 ${t.id} 的门禁 ${gateId} 已退回：${reason}` },
        });
      }
      return this.getGate(gateId);
    });
  }

  // ---------------------------------------------------------------- 外发

  replyDestination(threadId, triggerIds = []) {
    if (!threadId) return {};
    const selected = triggerIds.length ? `AND id IN (${triggerIds.map(() => '?').join(',')})` : '';
    const row = this.db.get(
      `SELECT chat_id, meta FROM trigger WHERE thread_id = ? ${selected} ORDER BY addressed DESC, at DESC, rowid DESC LIMIT 1`,
      threadId, ...triggerIds
    );
    if (!row) return {};
    const meta = row.meta ? JSON.parse(row.meta) : {};
    return { chatId: row.chat_id, messageId: meta.messageId ?? null };
  }

  enqueueOutbox({ kind, dedupeKey, payload, triggerIds }) {
    const at = this.now();
    const destination = kind === 'reply' ? this.replyDestination(payload.threadId, triggerIds) : {};
    this.db.run(
      `INSERT INTO outbox(kind, dedupe_key, payload, status, attempts, next_at, created_at)
       VALUES(?,?,?, 'pending', 0, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`,
      kind, dedupeKey, JSON.stringify({ ...destination, ...payload }), at, at
    );
  }

  dueOutbox(at = this.now(), limit = 20) {
    return this.db.all(
      "SELECT * FROM outbox WHERE status IN ('pending','failed') AND next_at <= ? ORDER BY id LIMIT ?", at, limit
    );
  }

  markOutboxSent(id) {
    this.db.run("UPDATE outbox SET status = 'sent', error = NULL WHERE id = ?", id);
  }

  markOutboxFailed(id, error, attempts, nextAt) {
    this.db.run("UPDATE outbox SET status = 'failed', error = ?, attempts = ?, next_at = ? WHERE id = ?", String(error).slice(0, 300), attempts, nextAt, id);
  }

  // ---------------------------------------------------------------- 用量

  recordUsage({ ticketId = null, position = null, pool = null, keyId = null, model = null, tokens = 0, purpose = null }) {
    this.db.run(
      'INSERT INTO usage(at, ticket_id, position, pool, key_id, model, tokens, purpose) VALUES(?,?,?,?,?,?,?,?)',
      this.now(), ticketId, position, pool, keyId, model, Number(tokens) || 0, purpose
    );
    return Number(tokens) || 0;
  }

  tokensForTicket(ticketId) {
    return this.db.get('SELECT COALESCE(SUM(tokens),0) AS n FROM usage WHERE ticket_id = ?', ticketId)?.n ?? 0;
  }

  usageSummary({ since = null } = {}) {
    const where = since ? 'WHERE at >= ?' : '';
    const args = since ? [since] : [];
    const total = this.db.get(`SELECT COALESCE(SUM(tokens),0) AS tokens, COUNT(*) AS calls FROM usage ${where}`, ...args);
    const byPosition = this.db.all(
      `SELECT COALESCE(position,'-') AS position, COALESCE(SUM(tokens),0) AS tokens, COUNT(*) AS calls
         FROM usage ${where} GROUP BY position ORDER BY tokens DESC`, ...args
    );
    const byPool = this.db.all(
      `SELECT COALESCE(pool,'-') AS pool, COALESCE(SUM(tokens),0) AS tokens
         FROM usage ${where} GROUP BY pool ORDER BY tokens DESC`, ...args
    );
    return { tokens: total?.tokens ?? 0, calls: total?.calls ?? 0, byPosition, byPool };
  }

  /** 按池 + key 汇总用量：工作台据此显示"哪把 key 在烧钱" */
  usageByKey({ since = null } = {}) {
    const where = since ? 'WHERE at >= ?' : '';
    const args = since ? [since] : [];
    return this.db.all(
      `SELECT COALESCE(pool,'-') AS pool, COALESCE(key_id,'-') AS keyId,
              COALESCE(SUM(tokens),0) AS tokens, COUNT(*) AS calls, MAX(at) AS lastAt
         FROM usage ${where}
        GROUP BY pool, keyId ORDER BY tokens DESC`, ...args
    );
  }

  usageByPosition({ since = null } = {}) {
    const where = since ? 'WHERE at >= ?' : '';
    const args = since ? [since] : [];
    return this.db.all(
      `SELECT COALESCE(position,'-') AS position, COALESCE(SUM(tokens),0) AS tokens,
              COUNT(*) AS calls, MAX(at) AS lastAt
         FROM usage ${where} GROUP BY position`, ...args
    );
  }

  usageRecent(limit = 20) {
    return this.db.all(
      `SELECT position, ticket_id AS ticketId, purpose, tokens, model, pool, key_id AS keyId, at
         FROM usage ORDER BY id DESC LIMIT ?`, limit
    );
  }

  // ---------------------------------------------------------------- 工作台

  listAssignments({ status = null, limit = 50 } = {}) {
    return this.db.all(
      `SELECT a.id, a.ticket_id AS ticketId, a.attempt, a.status, a.started_at AS startedAt,
              a.ended_at AS endedAt, a.note,
              t.title, t.task_type AS taskType, t.stage, t.gate_target AS gateTarget,
              t.status AS ticketStatus
         FROM assignment a JOIN ticket t ON t.id = a.ticket_id
        ${status ? 'WHERE a.status = ?' : ''}
        ORDER BY a.rowid DESC LIMIT ?`,
      ...(status ? [status, limit] : [limit])
    ).map((a) => ({ ...a, waitingOn: a.status === 'queued' ? this.waitingGates(a.stage, a.taskType) : [] }));
  }

  /** 交付物清单：带工单任务类型与门禁，工作台据此回答"这批活产出了什么" */
  listAssets({ limit = 100, ticketId = null } = {}) {
    return this.db.all(
      `SELECT s.id, s.ticket_id AS ticketId, s.kind, s.doc_type AS docType, s.stage, s.path,
              s.revision, s.status, s.created_at AS createdAt, s.title, s.position,
              s.ai_assisted AS aiAssisted,
              t.task_type AS taskType, t.gate_target AS gateTarget, t.status AS ticketStatus,
              t.title AS ticketTitle
         FROM asset s LEFT JOIN ticket t ON t.id = s.ticket_id
        ${ticketId ? 'WHERE s.ticket_id = ?' : ''}
        ORDER BY s.created_at DESC, s.id DESC LIMIT ?`,
      ...(ticketId ? [ticketId, limit] : [limit])
    );
  }

  // ---------------------------------------------------------------- 查询

  listEvals(limit = 50) {
    return this.db.all('SELECT * FROM eval ORDER BY created_at DESC LIMIT ?', limit)
      .map((e) => ({ ...e, assessment: e.assessment ? JSON.parse(e.assessment) : null }));
  }

  listReports(ticketId) {
    return this.db.all('SELECT * FROM report WHERE ticket_id = ? ORDER BY at', ticketId);
  }

  /** 全链路：trigger → eval → ticket → mandate → assignment → report → asset */
  history(ticketId) {
    const ticket = this.getTicket(ticketId);
    if (!ticket) return null;
    const ev = this.getEval(ticket.eval_id);
    const triggers = ev ? this.db.all(
      `SELECT * FROM trigger WHERE id IN (${ev.triggerIds.map(() => '?').join(',') || "''"}) ORDER BY at`,
      ...ev.triggerIds
    ) : [];
    return {
      ticket,
      eval: ev,
      triggers,
      assignments: this.db.all('SELECT * FROM assignment WHERE ticket_id = ? ORDER BY attempt', ticketId),
      reports: this.listReports(ticketId),
      assets: this.assetsOf(ticketId),
    };
  }

  stats() {
    const one = (sql) => this.db.get(sql)?.n ?? 0;
    return {
      triggers: one('SELECT COUNT(*) AS n FROM trigger'),
      threads: one('SELECT COUNT(*) AS n FROM thread'),
      evals: one('SELECT COUNT(*) AS n FROM eval'),
      rejected: one("SELECT COUNT(*) AS n FROM eval WHERE status = 'rejected'"),
      tickets: one('SELECT COUNT(*) AS n FROM ticket'),
      openTickets: one("SELECT COUNT(*) AS n FROM ticket WHERE status IN ('open','working','review','blocked')"),
      pendingSignatures: one("SELECT COUNT(*) AS n FROM gate WHERE status = 'pending'"),
      assets: one('SELECT COUNT(*) AS n FROM asset'),
      outboxPending: one("SELECT COUNT(*) AS n FROM outbox WHERE status IN ('pending','failed')"),
    };
  }

  /** 启动恢复：working 的派工重新入队；sending 的消息重回待发 */
  recover() {
    const stuck = this.db.all("SELECT id, ticket_id, attempt FROM assignment WHERE status = 'working'");
    for (const a of stuck) {
      this.db.run("UPDATE assignment SET status = 'queued', note = ? WHERE id = ?", '重启恢复：上次执行中断，重新入队', a.id);
      this.db.run("UPDATE ticket SET updated_at = ? WHERE id = ?", this.now(), a.ticket_id);
      this.audit('system', 'assignment.recover', a.id, '进程中断后恢复');
    }
    this.db.run("UPDATE outbox SET status = 'pending' WHERE status = 'sending'");
    return { recoveredAssignments: stuck.length };
  }
}

export { TICKET_TRANSITIONS, GATE_MACHINE };
