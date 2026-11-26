import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime, seedKeysFile, cleanup, say } from './helpers.mjs';
import { createPanelServer } from '../src/panel/server.mjs';

const H = { 'x-superagent-request': '1', 'content-type': 'application/json' };
const SECRET = 'sk-aaaaaaaaaaaaaaaaaaaa';

async function boot(t, { pools, env } = {}) {
  const keysFile = await seedKeysFile(pools ?? {
    worker: {
      model: 'model-strong',
      baseUrl: 'http://127.0.0.1:9/v1',
      keys: [{ id: 'w1', apiKey: SECRET }],
    },
  });
  const { dir, runtime } = await makeRuntime({ stages: ['S1'], keysFile, env, aiFill: false });
  const panel = createPanelServer({ runtime, port: 0 });
  const { url } = await panel.listen();
  t.after(async () => {
    await panel.close();
    await cleanup(runtime, dir);
  });
  const api = async (path, opts = {}) => {
    const res = await fetch(url + path, { ...opts, headers: { ...H, ...(opts.headers ?? {}) } });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  };
  return { url, runtime, api };
}

test('工作台：GET /api/keys 只返回掩码，不含明文', async (t) => {
  const { api } = await boot(t);
  const r = await api('/api/keys');
  assert.equal(r.status, 200);
  assert.equal(r.body.totals.keys, 1);
  const pool = r.body.pools.find((p) => p.name === 'worker');
  assert.equal(pool.usable, true);
  assert.equal(pool.keys[0].keyMasked, 'sk-a****aaaa');
  assert.ok(!JSON.stringify(r.body).includes(SECRET), '响应体不得包含明文密钥');
});

test('工作台：新增 → 停用 → 删除，运行时池随之重建', async (t) => {
  const { api, runtime } = await boot(t);
  assert.equal(runtime.pool.describe().find((p) => p.pool === 'worker').keys, 1);

  const add = await api('/api/keys', { method: 'POST', body: JSON.stringify({ pool: 'worker', id: 'w2', apiKey: 'sk-bbbbbbbbbbbbbbbbbbbb' }) });
  assert.equal(add.status, 201);
  assert.equal(runtime.pool.describe().find((p) => p.pool === 'worker').keys, 2);

  const off = await api('/api/keys/worker/w2', { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
  assert.equal(off.status, 200);
  assert.equal(runtime.pool.describe().find((p) => p.pool === 'worker').keys, 1, '停用的 key 不应进池');

  const del = await api('/api/keys/worker/w2', { method: 'DELETE' });
  assert.equal(del.status, 200);
  const snap = await api('/api/keys');
  assert.equal(snap.body.totals.keys, 1);
});

test('工作台：重复 id 与无密钥被拒绝，且给出可读原因', async (t) => {
  const { api } = await boot(t);
  const dup = await api('/api/keys', { method: 'POST', body: JSON.stringify({ pool: 'worker', id: 'w1', apiKey: 'x' }) });
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /已存在/);

  const none = await api('/api/keys', { method: 'POST', body: JSON.stringify({ pool: 'worker', id: 'w9' }) });
  assert.equal(none.status, 400);
  assert.match(none.body.error, /apiKey 或 apiKeyEnv/);
});

test('工作台：写接口必须带自定义请求头', async (t) => {
  const { url } = await boot(t);
  const res = await fetch(url + '/api/keys', { method: 'POST', body: '{}' });
  assert.equal(res.status, 403);
});

test('工作台：单把 key 自检把结果记进快照，便于回看', async (t) => {
  const { api } = await boot(t);
  const r = await api('/api/keys/worker/w1/test', { method: 'POST', body: '{}' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false, '127.0.0.1:9 不可达，应返回失败而不是抛错');
  assert.ok(r.body.message.length > 0);

  const snap = await api('/api/keys');
  const k = snap.body.pools.find((p) => p.name === 'worker').keys[0];
  assert.equal(k.lastTest.ok, false);
  assert.ok(k.lastTest.at);
});

test('工作台：预算可改，倒挂被拒', async (t) => {
  const { api } = await boot(t);
  const ok = await api('/api/keys/budget', { method: 'PUT', body: JSON.stringify({ tokensPerTicket: 5000, tokensPerDay: 50000 }) });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.budget, { tokensPerTicket: 5000, tokensPerDay: 50000 });

  const bad = await api('/api/keys/budget', { method: 'PUT', body: JSON.stringify({ tokensPerTicket: 90000, tokensPerDay: 1000 }) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /不应大于日预算/);
});

test('工作台：页面可打开，且带回到运行面板的入口', async (t) => {
  const { url } = await boot(t);
  const html = await (await fetch(url + '/admin')).text();
  assert.match(html, /工作台/);
  assert.match(html, /新增密钥/);
  assert.match(html, /href="\/"/);
  assert.ok(!html.includes(SECRET), '页面源码不应内嵌密钥');
});

test('工作台：model.yml 基线的池在界面上标注来源', async (t) => {
  // 不给 keysFile 里的 worker，pool 由 model.yml/seed 提供（此处 seed 为空 → 无池）
  const { api } = await boot(t, { pools: {} });
  const r = await api('/api/keys');
  assert.equal(r.body.totals.keys, 0);
  assert.equal(r.body.pools.length, 4, '标准池始终展示，便于新增');
  assert.ok(r.body.pools.every((p) => p.ownedBy === 'model.yml'));
});

test('工作台：门禁 API 只使用服务端验证过的签署身份', async (t) => {
  const pm = 'temporary-project-manager-token-for-tests';
  const sw = 'temporary-software-engineer-token-for-tests';
  const { api, runtime } = await boot(t, { env: { SUPERAGENT_OPERATOR_TOKENS: JSON.stringify({ ou_xxx3: pm, ou_xxx4: sw }) } });
  await say(runtime.project.root, { actor: 'ou_xxx3', text: '启动项目立项' });
  await runtime.tick();
  assert.equal(runtime.engine.getGate('G1').status, 'pending');

  const post = (action, credential) => api(`/api/gates/G1/${action}`, {
    method: 'POST',
    headers: credential ? { authorization: `Bearer ${credential}` } : {},
    body: JSON.stringify({ note: '同意', reason: '补充材料' }),
  });
  assert.equal((await post('sign')).status, 401);
  assert.equal((await post('return', sw)).status, 403);
  assert.equal(runtime.engine.getGate('G1').status, 'pending');
  assert.equal((await post('sign', pm)).status, 200);
  assert.equal(runtime.engine.getGate('G1').status, 'released');
});
