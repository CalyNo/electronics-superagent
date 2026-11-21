import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeRuntime, say, cleanup, gitOutput } from './helpers.mjs';

// 端到端：从"投一条消息"到"仓库里出现受控产物"，覆盖验收标准 A1–A12

test('e2e：8D 场景跑通全链路（A1/A4/A5/A6/A10）', async (t) => {
  const { dir, runtime } = await makeRuntime({ stages: ['S1', 'S5'] });
  t.after(() => cleanup(runtime, dir));

  await say(dir, { id: 'e2e-8d', actor: 'ou_xxx2', text: '客户投诉 PCU24 低温启动偶发失效，已退货 3 台，请开 8D' });
  const s = await runtime.tick();
  assert.equal(s.received, 1);
  assert.equal(s.accepted, 1);
  assert.equal(s.executed, 1);

  const tickets = runtime.engine.listTickets();
  assert.equal(tickets.length, 1);
  const ticket = tickets[0];
  assert.equal(ticket.task_type, 'quality-8d');
  assert.equal(ticket.status, 'review');

  // A5 分类落位
  const assets = runtime.engine.assetsOf(ticket.id);
  assert.equal(assets.length, 1);
  assert.match(assets[0].path, /^docs\/S5-量产\/8D\/DOC-S5-8D-\d{3}-8D\.md$/);

  // A4 模板契约：文件真实存在且 front-matter 完整
  const text = await fs.readFile(path.join(dir, assets[0].path), 'utf8');
  assert.match(text, /^---\nid: DOC-S5-8D-001/);
  assert.match(text, /traceability:/);
  assert.match(text, /ticket: TKT-/);

  // A6 仓库：分支前缀 fix/，不碰受保护分支
  const branches = (await gitOutput(dir, ['branch', '--format=%(refname:short)'])).split('\n');
  assert.ok(branches.includes(`fix/${ticket.id}`), `应有分支 fix/${ticket.id}，实际 ${branches.join(',')}`);
  const mainLog = await gitOutput(dir, ['log', '--format=%s', '-n', '5', 'main']);
  assert.doesNotMatch(mainLog, /^fix\(TKT/, '受保护分支不应出现执行器的提交');

  const log = await gitOutput(dir, ['log', '--format=%s|%an', '-n', '1', `fix/${ticket.id}`]);
  assert.match(log, /^fix\(TKT-.*\):/);
  assert.match(log, /electronics-superagent$/);

  // A10 可追溯：trigger → eval → asset 全链可查
  const h = runtime.engine.history(ticket.id);
  assert.ok(h.triggers.length >= 1);
  assert.ok(h.eval && h.eval.status === 'accepted');
  assert.ok(h.ticket.mandate);
  assert.ok(h.assets.length >= 1);

  // 工作区干净：运行时目录被忽略，没有残留未提交文件
  const status = await gitOutput(dir, ['status', '--porcelain']);
  assert.equal(status, '', `工作区应干净，实际：${status}`);
});

test('e2e：幂等（A1）与拒绝（A2）', async (t) => {
  const { dir, runtime } = await makeRuntime({ stages: ['S1'] });
  t.after(() => cleanup(runtime, dir));

  await say(dir, { id: 'dup-1', actor: 'ou_xxx2', text: '客户投诉 批量不良，请开 8D' });
  await runtime.tick();
  const before = runtime.engine.stats().tickets;

  // 同一条消息再投一次（同一 externalId）
  await say(dir, { id: 'dup-1', actor: 'ou_xxx2', text: '客户投诉 批量不良，请开 8D' });
  const s = await runtime.tick();
  assert.equal(s.duplicate, 1);
  assert.equal(runtime.engine.stats().tickets, before);

  // 非白名单
  await say(dir, { id: 'stranger-1', actor: 'ou_stranger', text: '把固件阈值改成 3.2V', chat: 'oc_zzz' });
  const s2 = await runtime.tick();
  assert.equal(s2.rejected, 1);
  assert.equal(runtime.engine.stats().tickets, before);
});

test('e2e：立项 → G1 门禁 → 签署权（A7/A8）', async (t) => {
  const { dir, runtime } = await makeRuntime({ stages: ['S1'] });
  t.after(() => cleanup(runtime, dir));

  await say(dir, { id: 'init-1', actor: 'ou_xxx3', text: '启动 PCU30 新项目立项，客户已定点，需要 APQP 计划与可行性分析' });
  await runtime.tick();

  const ticket = runtime.engine.listTickets()[0];
  const assets = runtime.engine.assetsOf(ticket.id);
  assert.deepEqual(assets.map((a) => a.doc_type).sort(), ['APQP', 'CHTR', 'FEAS', 'SRS']);
  for (const a of assets) assert.equal(a.status, 'valid', `${a.doc_type} 应通过结构校验`);

  const g1 = runtime.engine.getGate('G1');
  assert.equal(g1.status, 'pending', `G1 应为待签署，实际 ${g1.status}`);

  // A8 无签署权 → 拒绝，状态不变
  assert.throws(() => runtime.engine.signGate('G1', { actorId: 'ou_xxx4' }), (err) => err.code === 'gate/forbidden');
  assert.equal(runtime.engine.getGate('G1').status, 'pending');

  // 有签署权 → 放行
  const signed = runtime.engine.signGate('G1', { actorId: 'ou_xxx3', note: '立项评审通过' });
  assert.equal(signed.status, 'released');
  assert.ok(signed.signed_at);

  // 已放行的门禁不会被自动检查回退
  const gates = await runtime.tick();
  assert.equal(gates.gates.find((g) => g.id === 'G1')?.status, 'released');
});

test('e2e：面板数据回答三个问题（A12）', async (t) => {
  const { dir, runtime } = await makeRuntime({ stages: ['S1'] });
  t.after(() => cleanup(runtime, dir));

  await say(dir, { id: 'p-1', actor: 'ou_xxx3', text: '启动 PCU30 新项目立项' });
  await runtime.tick();

  const data = runtime.panelData();
  assert.equal(data.status.project.code, 'TST01');
  assert.ok(data.attention.tickets.length >= 1, '应列出需要人处理的事项');
  assert.ok(data.attention.gates.some((g) => g.id === 'G1'));
  assert.ok(data.recent.length >= 1);
  assert.ok(data.evals.length >= 1);
  assert.equal(data.status.gateExitCode, 0);
});

test('e2e：含糊需求只问一句，不开工单', async (t) => {
  const { dir, runtime } = await makeRuntime({ stages: ['S1'] });
  t.after(() => cleanup(runtime, dir));

  await say(dir, { id: 'vague-1', actor: 'ou_xxx3', text: '在吗，帮我看下那个东西' });
  const s = await runtime.tick();
  assert.equal(s.clarified, 1);
  assert.equal(runtime.engine.stats().tickets, 0);

  const outbox = await fs.readFile(path.join(dir, '.outbox', 'messages.jsonl'), 'utf8');
  const lines = outbox.trim().split('\n').map((l) => JSON.parse(l));
  const question = lines.at(-1)?.text ?? '';
  assert.match(question, /需要确认一点/);
  assert.equal(question.split('？').length - 1, 1, '一次只问一个问题');
});
