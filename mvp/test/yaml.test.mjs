import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '../src/util/yaml.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

test('YAML：解析真实策略文件', () => {
  const p = parseYaml(read('config/policy.example.yml'), { file: 'policy' });
  assert.equal(p.acceptMode, 'observe');
  assert.equal(p.rules.length, 5);
  assert.deepEqual(p.rules[0].match.keywords, ['投诉', '客诉', '反馈', '失效', '失败', '退货', '不良', '批量', '异常', '召回', '故障', '返修', '不工作']);
  // 块标量保留换行
  assert.match(p.rules[0].instruction, /\n/);
  // 行内列表
  assert.deepEqual(p.stageGates.G1.requiredDeliverables, ['CHTR', 'SRS', 'APQP', 'FEAS']);
  // 列表中的映射（" - id: ..." 形式）
  assert.equal(p.sources.feishu.allowed[2].role, 'PM');
  assert.deepEqual(p.sources.feishu.allowed[0].canSign, ['G2']);
});

test('YAML：注释与引号内的 # 不被误删', () => {
  const doc = parseYaml('a: 1   # 行尾注释\nb: "x # 不是注释"\nc: [\'#\', \'@\']');
  assert.equal(doc.a, 1);
  assert.equal(doc.b, 'x # 不是注释');
  assert.deepEqual(doc.c, ['#', '@']);
});

test('YAML：骨架清单可解析且关键字段齐全', () => {
  const m = parseYaml(read('scaffold/.superagent/manifest.yml'), { file: 'manifest' });
  for (const k of ['code', 'name', 'topology', 'stages', 'system']) assert.ok(k in m, `缺少 ${k}`);
  assert.deepEqual(m.stages.enabled, ['S1']);
  assert.equal(m.system.recordRetentionYears, 15);
});

test('YAML：规则文件保持"只加严"的关键字段', () => {
  const r = parseYaml(read('scaffold/.superagent/rules.yml'), { file: 'rules' });
  assert.ok(r.stricter.templates.minSectionsFilled >= 0.8);
  assert.ok(Array.isArray(r.stricter.execution.blockedCommands));
  assert.ok(r.stricter.execution.blockedCommands.some((c) => /git reset --hard/.test(c)));
});

test('YAML：非法结构给出带行号的错误', () => {
  assert.throws(() => parseYaml('a: 1\n   b: 2'), /缩进|无法解析/);
});
