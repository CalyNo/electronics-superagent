import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime, say, cleanup } from './helpers.mjs';
import { createPanelServer } from '../src/panel/server.mjs';
import { POSITIONS } from '../src/executor/positions.mjs';

// 工作台的价值在于"一眼看清谁在干什么、产出了什么"，所以测的是视图字段是否真的对得上库里的状态

const stubModel = (sections) => ({
  name: 'stub:model',
  configured: true,
  async generate() {
    return {
      text: JSON.stringify({ sections, openQuestions: ['需确认批次'] }),
      usage: { tokens: 240 },
      model: 'stub-model', keyId: 'doc-1', pool: 'doc',
    };
  },
});

async function boot(t, opts = {}) {
  const { dir, runtime } = await makeRuntime({ stages: ['S1', 'S5'], ...opts });
  const panel = createPanelServer({ runtime, port: 0 });
  const { url } = await panel.listen();
  t.after(async () => { await panel.close(); await cleanup(runtime, dir); });
  const get = async (p) => {
    const r = await fetch(url + p);
    return { status: r.status, body: await r.json() };
  };
  return { dir, runtime, url, get };
}

test('工作台：结构完整，岗位齐全、队列与工单一致', async (t) => {
  const { runtime, get, dir } = await boot(t);
  await say(dir, { id: 'wb-1', actor: 'ou_xxx2', text: '客户投诉 低温启动偶发失效' });
  await runtime.tick();

  const r = await get('/api/workbench');
  assert.equal(r.status, 200);
  const w = r.body;
  assert.equal(w.project.code, 'TST01');
  assert.equal(w.positions.length, Object.keys(POSITIONS).length);
  assert.deepEqual(w.positions.map((p) => p.code).sort(), Object.keys(POSITIONS).sort());
  assert.equal(w.queue.review, 1, '跑完的工单应计入待评审');
  assert.equal(w.queue.working, 0);
  assert.ok(w.gates.length >= 1);
  assert.equal(typeof w.health.exitCode, 'number');
  assert.ok(w.policy.acceptMode);
});

test('工作台：交付物带类型、路径、校验状态与 AI 标记', async (t) => {
  const { runtime, get, dir } = await boot(t, {
    model: stubModel([{ heading: 'D2 描述问题', content: '客户反馈低温启动偶发失效。' }]),
  });
  await say(dir, { id: 'wb-2', actor: 'ou_xxx2', text: '客户投诉 低温启动偶发失效，已退货 3 台' });
  await runtime.tick();

  const w = (await get('/api/workbench')).body;
  assert.equal(w.deliverables.length, 1);
  const d = w.deliverables[0];
  assert.equal(d.docType, '8D');
  assert.equal(d.stage, 'S5');
  assert.equal(d.status, 'valid');
  assert.match(d.path, /^docs\/S5-量产\/8D\//);
  assert.equal(d.aiAssisted, 1, 'AI 参与过的交付物要能被筛选出来');
  assert.equal(d.position, 'QE');
  assert.ok(d.title.includes('低温'));
});

test('工作台：岗位显示"在干活/空闲/无密钥"三种状态', async (t) => {
  // 无模型配置：岗位应显示为无可用的池
  const { get } = await boot(t);
  const w = (await get('/api/workbench')).body;
  assert.ok(w.positions.every((p) => p.state === 'unconfigured'), '没有 key 时不应假装空闲可用');

  // 有桩模型：池可用但当前无任务
  const { get: get2 } = await boot(t, { model: stubModel([]) });
  const w2 = (await get2('/api/workbench')).body;
  assert.ok(w2.positions.every((p) => p.state === 'idle'));
  assert.ok(w2.positions.every((p) => p.poolKeys >= 1));
});

test('工作台：用量按岗位归集，能看到最近一次调用', async (t) => {
  const { runtime, get, dir } = await boot(t, {
    model: stubModel([{ heading: 'D2 描述问题', content: '客户反馈失效。' }]),
  });
  await say(dir, { id: 'wb-3', actor: 'ou_xxx2', text: '客户投诉 低温启动失效' });
  await runtime.tick();

  const w = (await get('/api/workbench')).body;
  assert.equal(w.usage.tokens, 240);
  assert.equal(w.usage.calls, 1);
  const qe = w.positions.find((p) => p.code === 'QE');
  assert.equal(qe.today.tokens, 240);
  assert.equal(qe.today.calls, 1);
  assert.ok(qe.lastCall);
  assert.match(qe.lastCall.purpose, /fill:8D/);
});

test('工作台：派工记录可追溯到工单与备注', async (t) => {
  const { runtime, get, dir } = await boot(t, {
    model: stubModel([{ heading: 'D2 描述问题', content: '客户反馈失效。' }]),
  });
  await say(dir, { id: 'wb-4', actor: 'ou_xxx2', text: '客户投诉 低温启动失效' });
  await runtime.tick();

  const w = (await get('/api/workbench')).body;
  assert.equal(w.assignments.length, 1);
  const a = w.assignments[0];
  assert.equal(a.status, 'done');
  assert.equal(a.taskType, 'quality-8d');
  assert.match(a.ticketId, /^TKT-/);
  assert.ok(a.note && a.note.length > 0);
  assert.ok(a.startedAt);
});

test('工作台：页面包含四个核心区块，且不内嵌密钥', async (t) => {
  const { url } = await boot(t);
  const html = await (await fetch(url + '/admin')).text();
  for (const k of ['岗位状态', '执行与队列', '交付物', '阶段门', '密钥与池']) {
    assert.ok(html.includes(k), `页面缺少区块：${k}`);
  }
  assert.ok(!/sk-[a-z0-9]{20,}/i.test(html), '页面源码不得包含密钥');
});
