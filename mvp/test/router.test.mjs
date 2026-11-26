import test from 'node:test';
import assert from 'node:assert/strict';
import { assess, clarifyQuestion } from '../src/domain/router.mjs';
import { POSITIONS, positionForDoc } from '../src/executor/positions.mjs';

const cases = [
  ['客户投诉 PCU24 低温启动偶发失效，已退货 3 台', 'quality-8d', 'S5'],
  // 质量问题的常见变体：客户"反馈" + "失败"，历史上会掉到 fallback-doc 变成低优先级
  ['客户反馈 T23 串口升级到 32KB 时必失败，boot 回 CAN CAN', 'quality-8d', 'S5'],
  ['现场返修发现模块不工作，需 8D', 'quality-8d', 'S5'],
  ['把 BOM 里的 MOS 管从 A 换成 B', 'design-change', 'S2'],
  // 功能新增（未出现"变更/改版"字样）也应识别为设计变更，而不是 clarify
  ['T23项目增加按键双击进入BLE的配对功能', 'design-change', 'S2'],
  ['产线贴片工艺参数调整，需要更新控制计划', 'process-change', 'S3'],
  ['启动 PCU30 新项目立项，客户已定点', 'project-init', 'S1'],
  ['跑一轮温循试验并出报告', 'test', 'S4'],
  ['补一份 DFMEA', 'doc', 'S2'],
];

for (const [text, taskType, stage] of cases) {
  test(`路由：${taskType} ← ${text.slice(0, 14)}…`, () => {
    const a = assess({ text, defaultStage: 'S1' });
    assert.equal(a.taskType, taskType);
    assert.equal(a.stage, stage);
    assert.ok(a.docTypes.length > 0, '应有交付物');
    assert.ok(a.title.length <= 42);
  });
}

test('路由：过程变更优先于设计变更（规则顺序）', () => {
  assert.equal(assess({ text: '产线变更：SMT 焊接温度参数调整' }).taskType, 'process-change');
});

test('路由：判不出来时返回 clarify 且只问一个具体问题', () => {
  const a = assess({ text: '在吗' });
  assert.equal(a.taskType, 'clarify');
  assert.equal(a.docTypes.length, 0);
  const q = clarifyQuestion(a);
  assert.match(q, /需要确认一点/);
  assert.equal(q.split('？').length - 1, 1);
});

test('路由：识别安全件 → 高风险', () => {
  const a = assess({ text: '客户投诉刹车助力失效，涉及安全件' });
  assert.equal(a.riskLevel, 'high');
  assert.equal(a.taskType, 'quality-8d');
});

test('路由：仅提到文档类型也能落成补齐任务', () => {
  const a = assess({ text: '整理文档：控制计划' });
  assert.equal(a.taskType, 'doc');
  assert.deepEqual(a.docTypes, ['CP']);
  assert.equal(a.stage, 'S3');
});

test('路由：固件代码修改 → code-change，由软件工程师执行', () => {
  const text = '修改 `T23/projects/n32wb03x_EVAL/ble/app/src/key.c` 和 firmware\\app\\inc\\config.h。\n双击进入配对，超时后恢复原行为。';
  const a = assess({ text });
  assert.equal(a.taskType, 'code-change');
  assert.deepEqual(a.docTypes, ['CODE']);
  assert.equal(a.gateTarget, null);
  assert.deepEqual(a.codeTargets, [
    { relPath: 'T23/projects/n32wb03x_EVAL/ble/app/src/key.c', requirement: text },
    { relPath: 'firmware/app/inc/config.h', requirement: text },
  ]);
});

test('路由：固件修改缺少明确的应用层文件时询问相对路径', () => {
  for (const text of [
    '修改 T23 固件代码实现双击进入配对',
    '改固件 key.c、../firmware/app/key.c、D:/tool/firmware/app/key.c',
    '改固件 T23/projects/n32wb03x_EVAL/ble/boot/src/main.c',
  ]) {
    const a = assess({ text });
    assert.equal(a.taskType, 'clarify');
    assert.match(clarifyQuestion(a), /相对路径/);
  }
});

test('路由：提及应用文件的投诉仍进入 8D', () => {
  const a = assess({ text: '客户投诉 T23/projects/PCU/ble/app/main.c 启动异常，请出 8D' });
  assert.equal(a.taskType, 'quality-8d');
});

test('路由：明确点名文件和修改动作时进入固件工单', () => {
  const a = assess({ text: '将 firmware/app/main.c 的阈值改为 5，解决启动故障' });
  assert.equal(a.taskType, 'code-change');
  assert.equal(a.codeTargets[0].relPath, 'firmware/app/main.c');
});

test('路由：跨阶段文档以最高阶段作为工单阶段', () => {
  for (const text of ['补一份 DFMEA 和 PFMEA', 'DFMEA、PFMEA']) {
    const a = assess({ text });
    assert.equal(a.taskType, 'doc');
    assert.equal(a.stage, 'S3');
    assert.deepEqual(a.docTypes, ['DFMEA', 'PFMEA']);
  }
});

test('路由：软件工程师代号为 SW', () => {
  assert.equal(POSITIONS.SW.code, 'SW');
  assert.equal(POSITIONS.SW.name, '软件工程师');
  assert.equal(POSITIONS.SE, undefined);
  assert.equal(positionForDoc('CODE').code, 'SW');
});
