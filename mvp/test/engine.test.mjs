import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/store/db.mjs';
import { Engine, UserError } from '../src/domain/engine.mjs';
import { createPolicy } from '../src/domain/policy.mjs';

const manifest = { code: 'TST01', name: '测试', stages: { enabled: ['S1', 'S5'] } };
const policyCfg = {
  version: 'pv-test',
  acceptMode: 'auto',
  sources: {
    local: {
      allowed: [
        { id: 'u_pm', name: '王经理', role: 'PM', canInitiate: ['project-init', 'quality-8d'], canSign: ['G1'] },
        { id: 'u_hw', name: '张工', role: 'HW', canInitiate: ['design-change'], canSign: [] },
      ],
      admission: {},
    },
  },
};

async function newEngine(over = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'esa-eng-'));
  const db = await openDb(dir);
  const engine = new Engine({
    db,
    policy: createPolicy({ policy: { ...policyCfg, ...over.policy }, manifest }),
    manifest,
  });
  return { engine, db, dir };
}

const evt = (over = {}) => ({
  source: 'local', externalId: 'm1', threadKey: 't1', actorId: 'u_pm',
  actorName: '王经理', chatId: 'oc_dev', body: '启动新项目立项', at: new Date().toISOString(),
  addressed: true, ...over,
});

test('幂等：同一外部事件只产生一个 Trigger 与一张工单', async () => {
  const { engine } = await newEngine();
  assert.equal(engine.receive(evt()).status, 'new');
  assert.equal(engine.receive(evt()).status, 'duplicate');
  assert.equal(engine.stats().triggers, 1);

  const t = engine.pendingThreads()[0];
  const e = engine.evaluate(t.threadId);
  assert.equal(e.verdict, 'accept');
  const acc = engine.accept(e.id);
  assert.equal(acc.status, 'accepted');
  assert.equal(engine.stats().tickets, 1);
  assert.equal(engine.stats().tickets, 1, '重复投递不应新增工单');
});

test('一个 Trigger 只被评估一次', async () => {
  const { engine } = await newEngine();
  engine.receive(evt());
  const t = engine.pendingThreads()[0];
  assert.ok(engine.evaluate(t.threadId));
  assert.equal(engine.evaluate(t.threadId), null, '第二次不应再有待评估触发');
});

test('准入拒绝：非白名单 → 评估 rejected，无工单', async () => {
  const { engine } = await newEngine();
  engine.receive(evt({ actorId: 'u_stranger', body: '帮我改固件阈值' }));
  const t = engine.pendingThreads()[0];
  const e = engine.evaluate(t.threadId);
  assert.equal(e.status, 'rejected');
  assert.match(e.reason, /不在白名单/);
  assert.equal(engine.stats().tickets, 0);
});

test('上下文：未 @ 的白名单消息不产生新工单', async () => {
  const { engine } = await newEngine();
  engine.receive(evt({ addressed: false }));
  const t = engine.pendingThreads()[0];
  const e = engine.evaluate(t.threadId);
  assert.equal(e.status, 'context');
  assert.equal(engine.stats().tickets, 0);
});

test('observe 模式：记录"本会接"但不建工单', async () => {
  const { engine } = await newEngine({ policy: { acceptMode: 'observe' } });
  engine.receive(evt());
  const t = engine.pendingThreads()[0];
  const e = engine.evaluate(t.threadId);
  const acc = engine.accept(e.id);
  assert.equal(acc.status, 'observed');
  assert.equal(engine.stats().tickets, 0);
  assert.equal(engine.getEval(e.id).status, 'accepted');
});

test('授权：Mandate 只插入，工单带仓库/阶段/动作范围', async () => {
  const { engine, db } = await newEngine();
  engine.receive(evt());
  const e = engine.evaluate(engine.pendingThreads()[0].threadId);
  const { ticketId } = engine.accept(e.id);
  const t = engine.getTicket(ticketId);
  assert.ok(t.mandate);
  assert.deepEqual(t.mandate.actionScope.slice(-2), ['doc.write', 'repo.commit']);
  assert.equal(db.all('SELECT * FROM mandate').length, 1);
  // 没有提供修改 Mandate 的接口：扩大范围只能新开工单
  assert.equal(typeof engine.updateMandate, 'undefined');
});

test('状态机：非法转换被拒绝并给出允许项', async () => {
  const { engine } = await newEngine();
  engine.receive(evt());
  const e = engine.evaluate(engine.pendingThreads()[0].threadId);
  const { ticketId } = engine.accept(e.id);
  assert.throws(() => engine.transitionTicket(ticketId, 'closed'), (err) => {
    assert.ok(err instanceof UserError);
    assert.equal(err.code, 'ticket/bad-transition');
    assert.ok(Array.isArray(err.details.allowed));
    return true;
  });
});

test('关单前置：没有合格产物不能关闭', async () => {
  const { engine } = await newEngine();
  engine.receive(evt());
  const e = engine.evaluate(engine.pendingThreads()[0].threadId);
  const { ticketId } = engine.accept(e.id);
  engine.transitionTicket(ticketId, 'working');
  engine.transitionTicket(ticketId, 'review');
  assert.throws(() => engine.transitionTicket(ticketId, 'closed'), /没有结构校验通过的产物/);
  engine.registerAsset({ ticketId, kind: 'document', docType: 'CHTR', stage: 'S1', path: 'docs/S1-策划/CHTR/x.md', status: 'valid' });
  assert.equal(engine.transitionTicket(ticketId, 'closed').status, 'closed');
});

test('门禁：机器不能放行，只有人签署能到 released', async () => {
  const { engine } = await newEngine();
  engine.ensureGate('G1', { name: '立项批准', stage: 'S1' });
  assert.throws(() => engine.refreshGate('G1', { status: 'released', checks: [] }), /不能放行/);
  engine.refreshGate('G1', { status: 'preparing', checks: [] });
  engine.refreshGate('G1', { status: 'pending', checks: [] });
  assert.throws(() => engine.signGate('G1', { actorId: 'u_hw' }), (err) => err.code === 'gate/forbidden');
  const g = engine.signGate('G1', { actorId: 'u_pm' });
  assert.equal(g.status, 'released');
  assert.equal(g.signed_by, '王经理');
});

test('门禁：非 pending 状态不能签署', async () => {
  const { engine } = await newEngine();
  engine.ensureGate('G1', { name: '立项批准', stage: 'S1' });
  assert.throws(() => engine.signGate('G1', { actorId: 'u_pm' }), /只有待签署状态才能签署/);
});

test('门禁放行关闭对应工单，退回则阻塞', async () => {
  const mkTicket = async (engine, externalId, threadKey) => {
    engine.receive(evt({ externalId, threadKey }));
    const threadId = engine.pendingThreads().find((t) => t.threadId.includes(threadKey))?.threadId
      ?? engine.pendingThreads()[0].threadId;
    const ev = engine.evaluate(threadId);
    const { ticketId } = engine.accept(ev.id);
    engine.transitionTicket(ticketId, 'working');
    engine.transitionTicket(ticketId, 'review');
    engine.registerAsset({ ticketId, kind: 'document', docType: 'CHTR', stage: 'S1', path: `docs/${ticketId}.md`, status: 'valid' });
    return ticketId;
  };

  // 放行：所有指向 G1 且待评审的工单都关闭
  const { engine: e1 } = await newEngine();
  const t1 = await mkTicket(e1, 'm1', 't1');
  const t2 = await mkTicket(e1, 'm2', 't2');
  assert.equal(e1.getTicket(t1).gate_target, 'G1');
  assert.equal(e1.getTicket(t2).gate_target, 'G1');
  e1.ensureGate('G1', { name: '立项批准', stage: 'S1' });
  e1.refreshGate('G1', { status: 'pending', checks: [] });
  e1.signGate('G1', { actorId: 'u_pm', note: '同意' });
  assert.equal(e1.getTicket(t1).status, 'closed');
  assert.equal(e1.getTicket(t2).status, 'closed');

  // 退回：对应工单回到 blocked
  const { engine: e2 } = await newEngine();
  const t3 = await mkTicket(e2, 'm3', 't3');
  e2.ensureGate('G1', { name: '立项批准', stage: 'S1' });
  e2.refreshGate('G1', { status: 'pending', checks: [] });
  e2.returnGate('G1', { actorId: 'u_pm', reason: '补材料' });
  assert.equal(e2.getTicket(t3).status, 'blocked');
});

test('人可撤回，执行器不可自我停止', async () => {
  const { engine } = await newEngine();
  engine.receive(evt());
  const e = engine.evaluate(engine.pendingThreads()[0].threadId);
  const { ticketId } = engine.accept(e.id);
  assert.equal(engine.stopTicket(ticketId, { actor: 'u_pm', reason: '需求取消' }).status, 'dropped');
  assert.equal(engine.getTicket(ticketId).assignment.status, 'cancelled');
  assert.equal(engine.listAssignments({ status: 'queued' }).length, 0);
  assert.throws(() => engine.stopTicket(ticketId, { actor: 'u_pm' }), /已 dropped/);
  // 执行器回报失败只会走 finishAssignment，不提供把工单置 dropped 的路径
  assert.equal(typeof engine.selfDrop, 'undefined');
});

test('恢复：working 的派工在重启后重新入队', async () => {
  const { engine } = await newEngine();
  engine.receive(evt());
  const e = engine.evaluate(engine.pendingThreads()[0].threadId);
  const { ticketId } = engine.accept(e.id);
  const a = engine.claimNextAssignment();
  assert.ok(a);
  assert.equal(engine.getTicket(ticketId).status, 'working');
  const rec = engine.recover();
  assert.equal(rec.recoveredAssignments, 1);
  assert.equal(engine.db.get('SELECT status FROM assignment WHERE id = ?', a.id).status, 'queued');
  assert.ok(engine.claimNextAssignment(), '恢复后应能再次取到该派工');
});

test('外发：outbox 去重键唯一', async () => {
  const { engine } = await newEngine();
  engine.enqueueOutbox({ kind: 'reply', dedupeKey: 'k1', payload: { text: 'a' } });
  engine.enqueueOutbox({ kind: 'reply', dedupeKey: 'k1', payload: { text: 'b' } });
  assert.equal(engine.stats().outboxPending, 1);
});
