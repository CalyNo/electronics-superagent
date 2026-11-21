import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeRuntime, say, cleanup } from './helpers.mjs';

// 端到端验证"飞书消息 → 岗位 → 密钥池 → 模型干活 → 文档落盘 → 用量记账"
// 用桩模型替代真实供应商：验证的是调度与护栏，而不是模型写得好不好。

function stubModel(handler) {
  return {
    name: 'stub:model',
    configured: true,
    modelName: 'stub-model',
    calls: [],
    async generate(args) {
      this.calls.push(args);
      return handler(args);
    },
  };
}

const sectionsReply = (sections, openQuestions = []) => ({
  text: JSON.stringify({ sections, openQuestions }),
  usage: { tokens: 210 },
  model: 'stub-model',
  keyId: 'doc-1',
  pool: 'doc',
});

test('e2e：带模型时，岗位会真的把文档写出来（含 AI 痕迹与用量）', async (t) => {
  const model = stubModel(() => sectionsReply([
    { heading: 'D2 描述问题', content: '客户反馈 PCU24 在 -30℃ 低温启动偶发失效，已退货 3 台。' },
    { heading: '根因分析', content: '怀疑电源时序裕量不足。' },
  ], ['需确认失效批次范围']));

  const { dir, runtime } = await makeRuntime({ stages: ['S1', 'S5'], model });
  t.after(() => cleanup(runtime, dir));

  await say(dir, { id: 'ai-1', actor: 'ou_xxx2', text: '客户投诉 PCU24 在 -30℃ 低温启动时偶发失效，已退货 3 台' });
  const s = await runtime.tick();
  assert.equal(s.executed, 1);

  // 1) 模型被调用，且用的是 QE 岗位的提示词与 doc 池
  assert.equal(model.calls.length, 1);
  assert.match(model.calls[0].system, /质量工程师/);
  assert.equal(model.calls[0].pool, 'doc');
  assert.match(model.calls[0].prompt, /已退货 3 台/, '工单原文必须进提示词');

  // 2) 文档里出现了模型写的内容 + AI 痕迹
  const ticket = runtime.engine.listTickets()[0];
  const asset = runtime.engine.assetsOf(ticket.id)[0];
  const text = await fs.readFile(path.join(dir, asset.path), 'utf8');
  assert.match(text, /已退货 3 台/);
  assert.match(text, /aiAssisted: true/);
  assert.match(text, /preparedBy: "QE 质量工程师"/);
  assert.match(text, /aiModel: stub-model/);

  // 3) 用量按工单/岗位/池记账
  assert.equal(runtime.engine.tokensForTicket(ticket.id), 210);
  const usage = runtime.engine.usageSummary();
  assert.equal(usage.total ?? usage.tokens, 210);
  assert.equal(usage.byPosition[0].position, 'QE');
  assert.equal(usage.byPool[0].pool, 'doc');

  // 4) 待确认问题进入派工备注，随 PR 一起呈现
  const note = runtime.engine.db.get('SELECT note FROM assignment WHERE ticket_id = ?', ticket.id)?.note ?? '';
  assert.match(note, /需确认失效批次范围/);
});

test('e2e：模型返回不可用内容时，退回骨架但不阻断流程', async (t) => {
  const model = stubModel(() => ({ text: '抱歉，我无法完成。', usage: { tokens: 8 } }));
  const { dir, runtime } = await makeRuntime({ stages: ['S1', 'S5'], model });
  t.after(() => cleanup(runtime, dir));

  await say(dir, { id: 'ai-2', actor: 'ou_xxx2', text: '客户投诉 低温启动偶发失效' });
  const s = await runtime.tick();
  assert.equal(s.executed, 1);

  const ticket = runtime.engine.listTickets()[0];
  assert.equal(ticket.status, 'review', '模型不靠谱不应让工单失败，骨架仍然可用');
  const asset = runtime.engine.assetsOf(ticket.id)[0];
  const text = await fs.readFile(path.join(dir, asset.path), 'utf8');
  assert.match(text, /aiAssisted: false/);
  assert.match(text, /待补充|<.*>/, '保留模板占位');
});

test('e2e：工单预算耗尽后不再调用模型', async (t) => {
  let calls = 0;
  const model = stubModel(() => {
    calls += 1;
    return sectionsReply([{ heading: 'D2 描述问题', content: '来自模型的内容' }]);
  });
  const { dir, runtime } = await makeRuntime({ stages: ['S1', 'S5'], model });
  t.after(() => cleanup(runtime, dir));

  // 预算置为 0 之前已用满：直接预置一条用量记录
  await say(dir, { id: 'ai-3', actor: 'ou_xxx2', text: '客户投诉 低温启动偶发失效' });
  await runtime.tick();
  const ticket = runtime.engine.listTickets()[0];
  const used = runtime.engine.tokensForTicket(ticket.id);
  assert.ok(used > 0);

  // 同一工单重试时预算已用尽（把上限设成已用量）
  runtime.modelInfo.budget = { tokensPerTicket: used, tokensPerDay: 1e9 };
  const before = calls;
  const { fillDocument } = await import('../src/executor/agent.mjs');
  const { positionForDoc } = await import('../src/executor/positions.mjs');
  const fee = await fillDocument({
    doc: { text: '---\nid: DOC-S5-8D-001\n---\n\n## D2 描述问题\n\n<待填>\n', docType: '8D' },
    ticket: { id: ticket.id, title: 'x' },
    position: positionForDoc('8D'),
    pool: runtime.pool,
    budget: runtime.modelInfo.budget,
    engine: runtime.engine,
    inputText: 'x',
  });
  assert.equal(fee.skipped, true);
  assert.match(fee.reason, /预算已用尽/);
  assert.equal(calls, before, '预算耗尽时不得再调模型');
});

test('e2e：关闭 AI 填充后完全不走模型', async (t) => {
  const model = stubModel(() => sectionsReply([{ heading: 'D2 描述问题', content: 'x' }]));
  const { dir, runtime } = await makeRuntime({ stages: ['S1', 'S5'], model, aiFill: false });
  t.after(() => cleanup(runtime, dir));

  await say(dir, { id: 'ai-4', actor: 'ou_xxx2', text: '客户投诉 低温启动偶发失效' });
  await runtime.tick();
  assert.equal(model.calls.length, 0);
  assert.equal(runtime.engine.usageSummary().tokens, 0);
});
