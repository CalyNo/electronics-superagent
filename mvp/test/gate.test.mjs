import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGateChecks, extractOps, extractSpecialCharacteristics } from '../src/domain/gate.mjs';
import { stringifyYaml } from '../src/domain/templates.mjs';
import { GATES, TASK_PLANS } from '../src/domain/stages.mjs';

const project = (root) => ({
  root,
  manifest: { code: 'TST01', stages: { enabled: ['S2', 'S3'] } },
  paths: { index: path.join(root, 'docs/_index') },
});

function docText({ id, stage, type, body }) {
  const stageCode = String(stage).slice(0, 2); // 目录用 "S3-过程设计"，front-matter 用 "S3"
  const fm = stringifyYaml({
    id, title: 't', project: 'TST01', stage: stageCode, type, revision: 'v0.1', status: 'draft',
    classification: 'internal', owner: 'x', created: '2026-11-21', updated: '2026-11-21',
    traceability: { upstream: [], downstream: [] },
  });
  return `---\n${fm}\n---\n\n${body}\n`;
}

async function writeDoc(root, type, stage, id, body) {
  const dir = path.join(root, 'docs', stage, type);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.md`), docText({ id, stage, type, body }), 'utf8');
}

async function fixture({ pfcOps, pfmeaOps, cpText = '', scText = '' }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'esa-gate-'));
  const stage3 = 'S3-过程设计';
  await writeDoc(root, 'PFC', stage3, 'DOC-S3-PFC-001',
    `# 过程流程图\n\n## 说明\n\n本流程共 ${pfcOps.length} 道工序。\n\n## 工序\n\n| 工序 | 名称 |\n| --- | --- |\n${pfcOps.map((o) => `| ${o} | 工序${o} |`).join('\n')}\n`);
  await writeDoc(root, 'PFMEA', stage3, 'DOC-S3-PFMEA-001',
    `# PFMEA\n\n## 说明\n\n覆盖全部工序。\n\n## 失效分析\n\n| 工序 | 失效 |\n| --- | --- |\n${pfmeaOps.map((o) => `| ${o} | 虚焊 |`).join('\n')}\n`);
  await writeDoc(root, 'CP', stage3, 'DOC-S3-CP-001',
    `# 控制计划\n\n## 说明\n\n按工序编制。\n\n## 控制项\n\n${cpText}\n`);
  await writeDoc(root, 'SC', 'S2-产品设计', 'DOC-S2-SC-001',
    `# 特殊特性\n\n## 说明\n\n来自 DFMEA。\n\n## 清单\n\n${scText}\n`);
  return root;
}

test('工序编号提取：容忍 OP-5 / OP 05 / op-05 写法', () => {
  assert.deepEqual([...extractOps('OP-5 OP 06 op-07')], ['OP-05', 'OP-06', 'OP-07']);
});

test('特殊特性提取：CC/SC 及带前缀形式', () => {
  const set = extractSpecialCharacteristics('PCU24-CC-03 与 SC-12');
  assert.ok(set.has('CC-03'));
  assert.ok(set.has('SC-12'));
});

test('特殊特性提取：忽略文档编号与生成页脚里的 SC-xxx', () => {
  const set = extractSpecialCharacteristics('由 electronics-superagent 生成 DOC-S2-SC-001\n真实特性 CC-07');
  assert.deepEqual([...set], ['CC-07']);
});

test('G3 通过：流程图与 PFMEA 工序一一对应', async () => {
  const root = await fixture({
    pfcOps: ['OP-10', 'OP-20'],
    pfmeaOps: ['OP-10', 'OP-20'],
    cpText: '| 工序 | 特性 |\n| --- | --- |\n| OP-10 | CC-01 |',
    scText: '| 编号 | 等级 |\n| --- | --- |\n| CC-01 | 关键 |',
  });
  const res = await runGateChecks({ gateId: 'G3', project: project(root), rules: {} });
  const match = res.checks.find((c) => c.id === 'pfc_pfmea_step_match');
  assert.equal(match.ok, true, match.detail);
  assert.equal(res.status, 'pending');
});

test('G3 失败：PFMEA 多出一道流程图没有的工序', async () => {
  const root = await fixture({
    pfcOps: ['OP-10', 'OP-20'],
    pfmeaOps: ['OP-10', 'OP-30'],
  });
  const res = await runGateChecks({ gateId: 'G3', project: project(root), rules: {} });
  const match = res.checks.find((c) => c.id === 'pfc_pfmea_step_match');
  assert.equal(match.ok, false);
  assert.match(match.detail, /仅流程图有 \[OP-20\]/);
  assert.match(match.detail, /仅 PFMEA 有 \[OP-30\]/);
  assert.equal(res.status, 'preparing');
});

test('G3 失败：控制计划漏掉特殊特性', async () => {
  const root = await fixture({
    pfcOps: ['OP-10'], pfmeaOps: ['OP-10'],
    cpText: '| 工序 | 特性 |\n| --- | --- |\n| OP-10 | CC-01 |',
    scText: '| 编号 |\n| --- |\n| CC-01 |\n| CC-02 |',
  });
  const res = await runGateChecks({ gateId: 'G3', project: project(root), rules: {} });
  const cp = res.checks.find((c) => c.id === 'cp_covers_all_special_characteristics');
  assert.equal(cp.ok, false);
  assert.match(cp.detail, /未覆盖：CC-02/);
});

test('G3：两份文档都没有工序编号时标记为跳过而不是通过', async () => {
  const root = await fixture({ pfcOps: [], pfmeaOps: [] });
  const res = await runGateChecks({ gateId: 'G3', project: project(root), rules: {} });
  const match = res.checks.find((c) => c.id === 'pfc_pfmea_step_match');
  assert.equal(match.skipped, true);
  assert.match(match.detail, /无法比对/);
});

test('G1 失败：交付物不全时给出缺哪些', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'esa-gate1-'));
  await writeDoc(root, 'CHTR', 'S1-策划', 'DOC-S1-CHTR-001', '# 章程\n\n## 目标\n\n内容\n\n## 风险\n\n内容\n');
  const res = await runGateChecks({ gateId: 'G1', project: project(root), rules: {} });
  const present = res.checks.find((c) => c.id === 'all_deliverables_present');
  assert.equal(present.ok, false);
  assert.match(present.detail, /SRS/);
  assert.equal(res.status, 'preparing');
});

test('任务计划必须产出其目标门禁要求的全部交付物', () => {
  for (const [taskType, plan] of Object.entries(TASK_PLANS)) {
    if (!plan.gateTarget) continue;
    const required = GATES[plan.gateTarget]?.deliverables ?? [];
    const missing = required.filter((t) => !plan.docTypes.includes(t));
    assert.deepEqual(missing, [], `${taskType} → ${plan.gateTarget} 缺交付物：${missing.join(',')}`);
  }
});
