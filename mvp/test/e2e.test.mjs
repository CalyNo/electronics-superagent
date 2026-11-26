import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Runtime } from '../src/app/runtime.mjs';
import { makeProject, makeRuntime, say, cleanup, gitOutput } from './helpers.mjs';

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

test('e2e：下阶段等待放行，队列仍可执行前阶段和量产质量工单', async (t) => {
  const { dir, runtime } = await makeRuntime({ stages: ['S1', 'S2', 'S5'], git: false, aiFill: false });
  t.after(() => cleanup(runtime, dir));

  await say(dir, { actor: 'ou_xxx3', text: '替换 BOM 中的 MOS 管型号，发起设计变更' });
  assert.equal((await runtime.tick()).executed, 0);
  const [design] = runtime.engine.listTickets();
  assert.equal(runtime.engine.getTicket(design.id).assignment.status, 'queued');
  assert.deepEqual(runtime.engine.listAssignments({ status: 'queued' })[0].waitingOn, ['G1']);

  await say(dir, { actor: 'ou_xxx3', text: '启动新项目立项' });
  await say(dir, { actor: 'ou_xxx2', text: '客户投诉批量不良，请开 8D' });
  assert.equal((await runtime.tick()).executed, 2);
  await runtime.signGate('G1', { actorId: 'ou_xxx3' });
  assert.equal((await runtime.tick()).executed, 1);
  assert.equal(runtime.engine.getTicket(design.id).status, 'review');
  assert.equal(runtime.engine.getGate('G2').status, 'pending');
});

test('e2e：跨阶段文档工单等待最晚交付阶段的前置门禁', async (t) => {
  const { dir, runtime } = await makeRuntime({ stages: ['S2', 'S3'], git: false, aiFill: false });
  t.after(() => cleanup(runtime, dir));
  await say(dir, { actor: 'ou_xxx4', text: '补 DFMEA 和控制计划' });
  assert.equal((await runtime.tick()).executed, 0);
  const [doc] = runtime.engine.listTickets();
  assert.deepEqual(runtime.engine.listAssignments({ status: 'queued' })[0].waitingOn, ['G2']);

  await say(dir, { actor: 'ou_xxx3', text: '替换 BOM 中的 MOS 管型号，发起设计变更' });
  assert.equal((await runtime.tick()).executed, 1);
  await runtime.signGate('G2', { actorId: 'ou_xxx3' });
  assert.equal((await runtime.tick()).executed, 1);
  assert.deepEqual(runtime.engine.assetsOf(doc.id).map((a) => a.doc_type).sort(), ['CP', 'DFMEA']);
});

test('e2e：签署入口立即重检当前交付物', async (t) => {
  const { dir, runtime } = await makeRuntime({ stages: ['S1'], git: false, aiFill: false });
  t.after(() => cleanup(runtime, dir));

  await say(dir, { actor: 'ou_xxx3', text: '启动新项目立项' });
  await runtime.tick();
  const [ticket] = runtime.engine.listTickets();
  const [asset] = runtime.engine.assetsOf(ticket.id);
  await fs.writeFile(path.join(dir, asset.path), '交付物损坏', 'utf8');

  await assert.rejects(async () => runtime.signGate('G1', { actorId: 'ou_xxx3' }));
  assert.equal(runtime.engine.getGate('G1').status, 'preparing');
  assert.equal(runtime.engine.getTicket(ticket.id).status, 'review');
});

test('e2e：授权退回后保持阻塞，新一轮派工完成才能重新待签', async (t) => {
  const { dir, runtime } = await makeRuntime({ stages: ['S1', 'S5'], aiFill: false });
  t.after(() => cleanup(runtime, dir));

  await say(dir, { actor: 'ou_xxx3', text: '启动新项目立项' });
  await runtime.tick();
  const [ticket] = runtime.engine.listTickets();
  assert.throws(() => runtime.engine.returnGate('G1', { actorId: 'ou_xxx4', reason: '复核' }), { code: 'gate/forbidden' });
  runtime.engine.returnGate('G1', { actorId: 'ou_xxx3', reason: '补充风险登记' });
  await say(dir, { actor: 'ou_xxx2', text: '客户投诉批量不良，请开 8D' });
  await runtime.tick();
  assert.equal(runtime.engine.getGate('G1').status, 'returned');
  const quality = runtime.engine.listTickets().find((t) => t.task_type === 'quality-8d');
  assert.equal(quality.status, 'review');
  const qualityHead = await gitOutput(dir, ['rev-parse', 'HEAD']);
  assert.throws(() => runtime.engine.retryTicket(ticket.id, { actorId: 'ou_xxx4' }), { code: 'ticket/forbidden' });

  const retry = runtime.engine.retryTicket(ticket.id, { actorId: 'ou_xxx3' });
  assert.equal(retry.attempt, 2);
  assert.throws(() => runtime.engine.retryTicket(ticket.id, { actorId: 'ou_xxx3' }), { code: 'ticket/retry-pending' });
  await runtime.tick();
  const history = runtime.engine.history(ticket.id);
  assert.deepEqual(history.assignments.map((a) => a.status), ['done', 'done']);
  assert.equal(history.ticket.status, 'review');
  assert.equal(runtime.engine.getGate('G1').status, 'pending');
  assert.equal(await gitOutput(dir, ['rev-parse', 'HEAD^']), qualityHead);
});

test('e2e：没有待审工单的门禁退回后可以显式重提', async (t) => {
  const { dir, runtime } = await makeRuntime({ stages: ['S1'], git: false, aiFill: false });
  t.after(() => cleanup(runtime, dir));
  await say(dir, { actor: 'ou_xxx3', text: '启动新项目立项' });
  await runtime.tick();
  const [ticket] = runtime.engine.listTickets();
  runtime.engine.stopTicket(ticket.id, { actor: 'ou_xxx3' });
  runtime.engine.returnGate('G1', { actorId: 'ou_xxx3', reason: '人工复核' });
  await runtime.tick();
  assert.equal(runtime.engine.getGate('G1').status, 'returned');

  assert.equal(typeof runtime.resubmitGate, 'function');
  await assert.rejects(runtime.resubmitGate('G1', { actorId: 'ou_xxx4' }), { code: 'gate/forbidden' });
  assert.equal((await runtime.resubmitGate('G1', { actorId: 'ou_xxx3' })).status, 'pending');
});

test('e2e：飞书确认收件后重启仍可处理，确认与放行都回复原消息', async (t) => {
  const dir = await makeProject({ stages: ['S1'], git: false });
  const replies = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    const endpoint = new URL(url).pathname;
    if (endpoint.endsWith('/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'mock-access', expire: 7200 });
    }
    replies.push({ endpoint, body: JSON.parse(request.body) });
    return Response.json({ code: 0 });
  });
  const options = {
    source: 'feishu', git: false, aiFill: false, model: { configured: false },
    env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'test-app', FEISHU_VERIFICATION_TOKEN: 'test-callback' },
  };
  const event = {
    header: { token: 'test-callback', event_id: 'evt-1', event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_xxx3' } },
      message: { message_type: 'text', chat_type: 'p2p', chat_id: 'oc_aaa', message_id: 'om_original', content: JSON.stringify({ text: '启动新项目立项' }) },
    },
  };
  let runtime = await Runtime.create({ dir, options });
  t.after(() => cleanup(runtime, dir));
  assert.deepEqual(await runtime.source.handleEvent(event), { ok: true });
  await runtime.close();

  runtime = await Runtime.create({ dir, options });
  assert.deepEqual(await runtime.source.handleEvent(event), { ok: true, duplicate: true });
  assert.equal((await runtime.tick()).accepted, 1);
  const later = structuredClone(event);
  later.header.event_id = 'evt-2';
  later.event.message.root_id = 'om_original';
  later.event.message.message_id = 'om_later';
  later.event.message.create_time = String(Date.now() + 1000);
  await runtime.source.handleEvent(later);
  await runtime.signGate('G1', { actorId: 'ou_xxx3' });
  await runtime.flushOutbox();
  assert.equal(replies.length, 3);
  assert.ok(replies.every(({ endpoint }) => endpoint.endsWith('/im/v1/messages/om_original/reply')));
  assert.equal(new Set(replies.map(({ body }) => body.uuid)).size, 3);
  assert.equal(runtime.engine.stats().outboxPending, 0);
});

test('e2e：接单写入失败后收件仍可在下一轮重新处理', async (t) => {
  const { dir, runtime } = await makeRuntime({ stages: ['S1'], git: false, aiFill: false });
  t.after(() => cleanup(runtime, dir));
  t.mock.method(runtime.engine, 'accept', () => { throw new Error('测试接单写入失败'); }, { times: 1 });
  await say(dir, { actor: 'ou_xxx3', text: '启动新项目立项' });

  const failed = await runtime.tick();
  assert.match(failed.errors[0], /测试接单写入失败/);
  assert.equal(runtime.engine.pendingThreads().length, 1);

  assert.equal((await runtime.tick()).accepted, 1);
  assert.equal(runtime.engine.stats().tickets, 1);
});
