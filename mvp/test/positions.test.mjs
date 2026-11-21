import test from 'node:test';
import assert from 'node:assert/strict';
import { POSITIONS, positionForDoc, positionForTask, positionsForDocs, listPositions } from '../src/executor/positions.mjs';
import { DOC_TYPES } from '../src/domain/stages.mjs';

test('岗位：任务类型映射到主责岗位', () => {
  assert.equal(positionForTask('quality-8d').code, 'QE');
  assert.equal(positionForTask('project-init').code, 'PM');
  assert.equal(positionForTask('design-change').code, 'HW');
  assert.equal(positionForTask('process-change').code, 'PE');
  assert.equal(positionForTask('clarify'), null);
});

test('岗位：每个文档类型都有人负责（新增类型不得漏挂）', () => {
  const missing = Object.keys(DOC_TYPES).filter((t) => !positionForDoc(t));
  assert.deepEqual(missing, [], `这些文档类型没有对应岗位：${missing.join(',')}`);
});

test('岗位：一个岗位可负责多类文档，一张工单可能跨岗位', () => {
  assert.equal(positionForDoc('8D').code, 'QE');
  assert.equal(positionForDoc('PFMEA').code, 'PE');
  assert.deepEqual(positionsForDocs(['8D', 'DFMEA', 'CHTR']).sort(), ['HW', 'PM', 'QE']);
});

test('岗位：测试报告由 TE 负责，提示词写明 Word 交付与 IATF 要素硬要求', () => {
  assert.equal(positionForDoc('TEST').code, 'TE');
  const p = POSITIONS.TE;
  assert.match(p.systemPrompt, /\.docx/);
  assert.match(p.systemPrompt, /禁止/);
  assert.match(p.systemPrompt, /校准/);
  assert.match(p.systemPrompt, /待确认/);
  assert.deepEqual(p.docTypes, ['TEST']);
});

test('岗位：每个岗位都绑定了池，且池名在允许集合内', () => {
  const allowed = new Set(['router', 'worker', 'doc', 'vision']);
  for (const p of Object.values(POSITIONS)) {
    assert.ok(allowed.has(p.pool), `${p.code} 的池 ${p.pool} 不在允许集合`);
    assert.ok(p.systemPrompt.length > 20, `${p.code} 缺少职责提示词`);
    assert.ok(p.docTypes.length > 0, `${p.code} 没有交付物`);
  }
});

test('岗位：提示词必须含"不得编造/待确认"这类硬约束', () => {
  for (const p of Object.values(POSITIONS)) {
    assert.match(p.systemPrompt, /待确认|不得|绝不/, `${p.code} 的提示词缺少反编造约束`);
  }
});

test('岗位：清单可用于面板展示，不含提示词全文', () => {
  const list = listPositions();
  assert.equal(list.length, Object.keys(POSITIONS).length);
  assert.ok(list.every((p) => p.code && p.name && p.duty && !('systemPrompt' in p)));
});
