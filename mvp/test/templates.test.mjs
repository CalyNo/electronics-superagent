import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { DOC_TYPES } from '../src/domain/stages.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDoc, validateDoc, parseFrontMatter, stringifyYaml, fillStats } from '../src/domain/templates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const template8D = readFileSync(path.join(ROOT, 'templates/15-8D报告.md'), 'utf8');

function gen(over = {}) {
  const ctx = {
    id: 'DOC-S5-8D-001', title: '低温启动失效', type: '8D', stage: 'S5',
    project: 'PCU24', name: '电机控制器', ticket: 'TKT-2026-0001', date: '2026-11-21',
    classification: 'internal', ...over,
  };
  return buildDoc({ templateText: template8D, ctx });
}

test('模板：DOC_TYPES 声明的每个模板文件都真实存在', () => {
  for (const [code, meta] of Object.entries(DOC_TYPES)) {
    if (meta.kind === 'code') continue; // 代码类交付物无文档模板
    assert.ok(existsSync(path.join(ROOT, 'templates', meta.template)), `缺少模板 ${meta.template}（${code}）`);
  }
});

test('模板：测试报告（TEST/S4）生成后结构校验通过（草稿）', () => {
  const tpl = readFileSync(path.join(ROOT, 'templates/17-测试报告.md'), 'utf8');
  const { text } = buildDoc({
    templateText: tpl,
    ctx: {
      id: 'DOC-S4-TEST-001', title: '串口协议与功能测试', type: 'TEST', stage: 'S4',
      project: 'T23', name: '蓝牙接收控制器', ticket: 'TKT-2026-0001', date: '2026-11-21',
      classification: 'internal',
    },
  });
  const res = validateDoc({
    text, relPath: 'docs/S4-验证/TEST/DOC-S4-TEST-001-TEST.md',
    rules: {}, expect: { stage: 'S4', type: 'TEST', project: 'T23' },
  });
  assert.equal(res.ok, true, res.errors.join('；'));
  assert.ok(res.warnings.some((w) => w.includes('填充率')), '草稿应提示填充率');
});

test('模板：生成的文档 front-matter 必填键齐全', () => {
  const { text } = gen();
  const { data } = parseFrontMatter(text);
  for (const k of ['id', 'title', 'project', 'stage', 'type', 'revision', 'status',
    'classification', 'owner', 'created', 'updated', 'traceability']) {
    assert.ok(data[k] !== undefined && data[k] !== null, `缺少 ${k}`);
  }
  assert.equal(data.id, 'DOC-S5-8D-001');
  assert.equal(data.ticket, 'TKT-2026-0001');
});

test('模板：标题不重复拼接类型名', () => {
  assert.equal(parseFrontMatter(gen().text).data.title, '低温启动失效 8D 报告');
  assert.equal(parseFrontMatter(gen({ title: '低温启动失效 8D 报告' }).text).data.title, '低温启动失效 8D 报告');
});

test('模板：结构校验通过（草稿）', () => {
  const res = validateDoc({
    text: gen().text, relPath: 'docs/S5-量产/8D/DOC-S5-8D-001-8D.md',
    rules: {}, expect: { stage: 'S5', type: '8D', project: 'PCU24' },
  });
  assert.equal(res.ok, true, res.errors.join('；'));
  // 草稿填充率低只应给提示，不应阻断
  assert.ok(res.warnings.some((w) => w.includes('填充率')));
});

test('模板：路径与阶段不自洽时校验失败', () => {
  const res = validateDoc({
    text: gen().text, relPath: 'docs/S1-策划/8D/DOC-S5-8D-001-8D.md',
    rules: {}, expect: { stage: 'S5', type: '8D', project: 'PCU24' },
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('不在阶段目录')));
});

test('模板：id 格式错误被发现', () => {
  const bad = gen().text.replace('DOC-S5-8D-001', 'DOC-S5-8D-1');
  const res = validateDoc({ text: bad, relPath: 'docs/S5-量产/8D/x.md', rules: {}, expect: { stage: 'S5', type: '8D' } });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('id 不合规')));
});

test('模板：缺少 front-matter 键被发现', () => {
  const text = gen().text.replace(/^owner:.*$/m, '');
  const res = validateDoc({ text, relPath: 'docs/S5-量产/8D/x.md', rules: {}, expect: { stage: 'S5', type: '8D' } });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('owner')));
});

test('模板：待补充标记超过上限即失败', () => {
  const text = gen().text.replace('---\n\n<!--', '---\n\n⚠ 待补充\n⚠ 待补充\n⚠ 待补充\n\n<!--');
  const res = validateDoc({
    text, relPath: 'docs/S5-量产/8D/DOC-S5-8D-001-8D.md',
    rules: { maxTodoMarkers: 2 }, expect: { stage: 'S5', type: '8D' },
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('待补充')));
});

test('模板：填充率只统计有实质内容的章节', () => {
  const body = '## 一\n\n<待填>\n\n## 二\n\n已填写内容\n\n## 三\n\n| a | b |\n| --- | --- |\n| <x> | - |\n';
  const s = fillStats(body);
  assert.equal(s.sections, 3);
  assert.equal(s.filled, 1);
  assert.equal(s.fillRatio, 0.33);
});

test('模板：YAML 序列化可被自身解析器读回', () => {
  const obj = { a: '带 空格', b: ['x', 'y'], c: { d: 1 }, e: [] };
  const { data } = parseFrontMatter(`---\n${stringifyYaml(obj)}\n---\n body\n`);
  assert.deepEqual(data, obj);
});
