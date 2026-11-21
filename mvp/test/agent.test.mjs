import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractHeadings, extractJson, matchHeading, replaceSection, markAiAssisted,
  fillDocument,
} from '../src/executor/agent.mjs';
import { positionForDoc } from '../src/executor/positions.mjs';

const DOC = `---
id: DOC-S5-8D-001
title: 测试 8D 报告
status: draft
---

# 测试

## D1 成立小组

<待填>

## D2 描述问题

<待填>

## D4 根因分析

<待填>
`;

const stubPool = (reply) => ({
  generate: async () => (typeof reply === 'function' ? reply() : reply),
});

const TICKET = { id: 'TKT-2026-0001', title: '低温启动失效', project: 'PCU24' };

test('章节识别：只取二级标题', () => {
  assert.deepEqual(extractHeadings(DOC), ['D1 成立小组', 'D2 描述问题', 'D4 根因分析']);
});

test('标题匹配：去编号、去 D 序号、唯一包含', () => {
  const allowed = ['D2 描述问题', 'D4 根因分析', 'D5 永久措施'];
  assert.equal(matchHeading(allowed, 'D2 描述问题'), 'D2 描述问题');
  assert.equal(matchHeading(allowed, '描述问题'), 'D2 描述问题');
  assert.equal(matchHeading(allowed, '2. 描述问题'), 'D2 描述问题');
  assert.equal(matchHeading(allowed, '根因分析'), 'D4 根因分析');
  assert.equal(matchHeading(allowed, '不存在的章节'), null);
});

test('章节替换：只换目标节，其余原样保留', () => {
  const out = replaceSection(DOC, 'D2 描述问题', '客户反馈低温失效，已退货 3 台。');
  assert.match(out, /## D2 描述问题\n\n客户反馈低温失效，已退货 3 台。/);
  assert.match(out, /## D1 成立小组\n\n<待填>/);
  assert.match(out, /## D4 根因分析\n\n<待填>/);
});

test('JSON 提取：容忍 ```json 围栏与前后废话', () => {
  assert.deepEqual(extractJson('好的：\n```json\n{"sections":[]}\n```\n以上'), { sections: [] });
  assert.equal(extractJson('没有 JSON'), null);
  assert.equal(extractJson('{坏掉的'), null);
});

test('填文档：按章节落位并写入 AI 痕迹', async () => {
  const res = await fillDocument({
    doc: { text: DOC, docType: '8D' },
    ticket: TICKET,
    position: positionForDoc('8D'),
    pool: stubPool({
      text: JSON.stringify({
        sections: [
          { heading: 'D2 描述问题', content: '客户反馈 PCU24 低温启动偶发失效，已退货 3 台。' },
          { heading: '根因分析', content: '怀疑电源时序裕量不足。' },
        ],
        openQuestions: ['需确认批次范围'],
      }),
      usage: { tokens: 120 }, model: 'stub', keyId: 'k1', pool: 'doc',
    }),
    inputText: '客户投诉 PCU24 低温启动偶发失效，已退货 3 台',
  });
  assert.ok(!res.skipped, res.reason);
  assert.deepEqual(res.applied, ['D2 描述问题', 'D4 根因分析']);
  assert.match(res.text, /aiAssisted: true/);
  assert.match(res.text, /preparedBy: "QE 质量工程师"/);
  assert.match(res.text, /已退货 3 台/);
  assert.deepEqual(res.openQuestions, ['需确认批次范围']);
  assert.equal(res.tokens, 120);
});

test('数值护栏：输入里没有的数字会被标注待核实', async () => {
  const res = await fillDocument({
    doc: { text: DOC, docType: '8D' },
    ticket: TICKET,
    position: positionForDoc('8D'),
    pool: stubPool({
      text: JSON.stringify({ sections: [{ heading: 'D4 根因分析', content: '实测余量 1.67V，Cpk 1.33。' }] }),
      usage: { tokens: 10 }, model: 'stub', keyId: 'k1', pool: 'doc',
    }),
    inputText: '客户投诉 低温启动偶发失效',
  });
  assert.match(res.text, /待核实/);
  assert.match(res.text, /1\.67/);
  assert.ok(res.openQuestions.some((q) => q.includes('无输入依据')));
});

test('填文档：模型不可用 → 跳过且保留骨架', async () => {
  const res = await fillDocument({
    doc: { text: DOC, docType: '8D' }, ticket: TICKET,
    position: positionForDoc('8D'), pool: stubPool({ text: null, reason: '未配置模型网关' }),
    inputText: 'x',
  });
  assert.equal(res.skipped, true);
  assert.match(res.reason, /未配置/);
  assert.equal(res.text, undefined);
});

test('填文档：返回非约定 JSON 时不落地', async () => {
  const res = await fillDocument({
    doc: { text: DOC, docType: '8D' }, ticket: TICKET,
    position: positionForDoc('8D'), pool: stubPool({ text: '我觉得这份文档应该写得更详细一些。' }),
    inputText: 'x',
  });
  assert.equal(res.skipped, true);
  assert.match(res.reason, /不是约定 JSON/);
});

test('填文档：章节名对不上时说明试过哪些，便于排查', async () => {
  const res = await fillDocument({
    doc: { text: DOC, docType: '8D' }, ticket: TICKET,
    position: positionForDoc('8D'),
    pool: stubPool({ text: JSON.stringify({ sections: [{ heading: '完全无关的标题', content: '内容' }] }) }),
    inputText: 'x',
  });
  assert.equal(res.skipped, true);
  assert.match(res.reason, /章节名与文档不匹配/);
  assert.match(res.reason, /完全无关的标题/);
});

test('填文档：超预算直接跳过，不发请求', async () => {
  let called = 0;
  const res = await fillDocument({
    doc: { text: DOC, docType: '8D' }, ticket: TICKET,
    position: positionForDoc('8D'),
    pool: { generate: async () => { called += 1; return { text: '{}' }; } },
    budget: { tokensPerTicket: 100 },
    engine: { tokensForTicket: () => 100 },
    inputText: 'x',
  });
  assert.equal(res.skipped, true);
  assert.match(res.reason, /预算已用尽/);
  assert.equal(called, 0, '超预算时不应真的调用模型');
});

test('填文档：没有对应岗位时不做任何事', async () => {
  const res = await fillDocument({ doc: { text: DOC, docType: 'XXX' }, ticket: TICKET, position: null, pool: stubPool({ text: '{}' }) });
  assert.equal(res.skipped, true);
  assert.match(res.reason, /没有对应岗位/);
});

test('AI 痕迹：标记与清除都不破坏 front-matter', () => {
  const marked = markAiAssisted(DOC, { position: { code: 'QE', name: '质量工程师' }, model: 'm', aiAssisted: true });
  assert.match(marked, /preparedBy: "QE 质量工程师"/);
  assert.match(marked, /aiAssisted: true/);
  assert.match(marked, /aiModel: m/);
  const cleared = markAiAssisted(marked, { position: { code: 'QE', name: '质量工程师' }, model: null, aiAssisted: false });
  assert.match(cleared, /aiAssisted: false/);
  assert.match(cleared, /status: draft/, '原有字段不能丢');
});
