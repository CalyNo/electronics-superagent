import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy, buildMandate } from '../src/domain/policy.mjs';
import { emptyPolicy } from '../src/config/load.mjs';

const policy = {
  version: 'pv-test',
  acceptMode: 'auto',
  sources: {
    local: {
      allowed: [
        { id: 'u_hw', name: '张工', role: 'HW', canInitiate: ['design-change', 'doc'], canSign: ['G2'] },
        { id: 'u_pm', name: '王经理', role: 'PM', canInitiate: ['project-init'], canSign: ['G1'] },
        { id: 'u_qe', name: '李工', role: 'QE', canInitiate: ['quality-8d'], canSign: [] },
      ],
      bots: [{ id: 'bot_ci', name: 'CI' }],
      admission: {
        oc_qa: { listedUnaddressed: 'inferred', unlistedAddressed: 'explicit', unlistedUnaddressed: 'ignore' },
        oc_dev: { listedUnaddressed: 'inferred', unlistedAddressed: 'ignore', unlistedUnaddressed: 'ignore' },
      },
    },
  },
};

const manifest = { code: 'TST01', integrations: { repo: { url: 'https://example/tst01.git' } } };

test('准入：白名单成员被 @ → explicit', () => {
  const p = createPolicy({ policy, manifest });
  const g = p.gate({ source: 'local', actorId: 'u_qe', chatId: 'oc_dev', addressed: true });
  assert.equal(g.admitted, true);
  assert.equal(g.strength, 'explicit');
  assert.equal(g.contextOnly, false);
});

test('准入：白名单成员未 @ → 仅上下文，不新开工单', () => {
  const p = createPolicy({ policy, manifest });
  const g = p.gate({ source: 'local', actorId: 'u_hw', chatId: 'oc_dev', addressed: false });
  assert.equal(g.admitted, false);
  assert.equal(g.contextOnly, true);
  assert.equal(g.strength, 'inferred');
});

test('准入：陌生人 @ 在质量群允许（准入表 explicit）', () => {
  const p = createPolicy({ policy, manifest });
  assert.equal(p.gate({ source: 'local', actorId: 'u_stranger', chatId: 'oc_qa', addressed: true }).admitted, true);
});

test('准入：陌生人在研发群 @ 仍被忽略', () => {
  const p = createPolicy({ policy, manifest });
  const g = p.gate({ source: 'local', actorId: 'u_stranger', chatId: 'oc_dev', addressed: true });
  assert.equal(g.admitted, false);
  assert.match(g.reason, /不在白名单/);
});

test('准入：acceptMode=off 一律拒绝（不是"限流"而是"停接"）', () => {
  const p = createPolicy({ policy: { ...policy, acceptMode: 'off' }, manifest });
  const g = p.gate({ source: 'local', actorId: 'u_pm', chatId: 'oc_dev', addressed: true });
  assert.equal(g.admitted, false);
  assert.match(g.reason, /off/);
});

test('准入：机器人消息只作候选，永不构成明确请求', () => {
  const p = createPolicy({ policy, manifest });
  const g = p.gate({ source: 'local', actorId: 'bot_ci', chatId: 'oc_dev', addressed: true });
  assert.equal(g.admitted, false);
  assert.equal(g.contextOnly, true);
});

test('准入：空白名单 = 全拒（空集合语义）', () => {
  const p = createPolicy({ policy: emptyPolicy(), manifest });
  const g = p.gate({ source: 'local', actorId: 'u_pm', chatId: 'oc_dev', addressed: true });
  assert.equal(g.admitted, false);
});

test('签署权：有/无权限分别判定', () => {
  const p = createPolicy({ policy, manifest });
  assert.equal(p.canSign('u_pm', 'G1').ok, true);
  assert.equal(p.canSign('u_hw', 'G1').ok, false);
  assert.match(p.canSign('u_hw', 'G1').reason, /无 G1 签署权/);
});

test('发起权：角色限制生效', () => {
  const p = createPolicy({ policy, manifest });
  assert.equal(p.canInitiate('u_qe', 'project-init').ok, false);
  assert.equal(p.canInitiate('u_pm', 'project-init').ok, true);
  assert.equal(p.canInitiate('u_qe', 'clarify').ok, true, '澄清不产生工单，不受限');
});

test('授权：范围与动作在创建时固化', () => {
  const p = createPolicy({ policy, manifest });
  const m = buildMandate({
    ticket: { id: 'TKT-2026-0001', stage: 'S5' },
    assessment: { stage: 'S5', gateTarget: null, docTypes: ['8D'] },
    manifest, policy: p, grantedBy: 'u_qe',
  });
  assert.equal(m.id, 'MND-2026-0001');
  assert.equal(m.stageScope, 'S5..S5');
  assert.deepEqual(m.actionScope, ['8D', 'doc.write', 'repo.commit']);
  assert.equal(m.policyVersion, 'pv-test');
  assert.equal(m.grantedBy, 'u_qe');
});
