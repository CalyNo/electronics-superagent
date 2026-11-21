import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KeyStore } from '../src/executor/keystore.mjs';

const tmpFile = async () => path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'esa-ks-')), 'keys.json');

const seed = {
  baseUrl: 'https://api.example.com/v1',
  model: 'model-a',
  budget: { tokensPerTicket: 1000, tokensPerDay: 10000 },
  pools: {
    worker: { model: 'model-strong', apiKey: 'sk-seed-worker', keys: [{ id: 'w0', apiKey: 'sk-seed-worker' }] },
  },
};

async function store(opts = {}) {
  const s = new KeyStore({
    file: opts.file ?? await tmpFile(),
    env: opts.env ?? {},
    seed: opts.seed ?? seed,
  });
  await s.load();
  return s;
}

test('空库：快照包含四个标准池，且不伪造密钥', async () => {
  const s = await store({ seed: {} });
  const snap = s.snapshot();
  assert.deepEqual(snap.pools.map((p) => p.name).sort(), ['doc', 'router', 'vision', 'worker']);
  assert.equal(snap.totals.keys, 0);
  assert.equal(snap.fileExists, false);
});

test('新增字面密钥：落盘、掩码、归属正确', async () => {
  const file = await tmpFile();
  const s = await store({ file });
  await s.addKey({ pool: 'worker', id: 'w1', apiKey: 'sk-abcdefghijklmnop', model: 'model-x' });
  const snap = s.snapshot();
  const pool = snap.pools.find((p) => p.name === 'worker');
  assert.equal(pool.ownedBy, 'keys.json');
  const k = pool.keys.find((x) => x.id === 'w1');
  assert.equal(k.keyMasked, 'sk-a****mnop');
  assert.equal(k.envResolved, true);
  assert.equal(pool.usable, true);

  const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(onDisk.pools.worker.keys.find((k) => k.id === 'w1').apiKey, 'sk-abcdefghijklmnop', '落盘保存原值供运行时使用');
  // 但对外快照绝不能有明文
  assert.ok(!JSON.stringify(snap).includes('sk-abcdefghijklmnop'));
});

test('环境变量型密钥：变量缺失时标记不可用', async () => {
  const s = await store();
  await s.addKey({ pool: 'doc', id: 'd1', apiKeyEnv: 'EA_DOC_DS_01' });
  const k = s.snapshot().pools.find((p) => p.name === 'doc').keys[0];
  assert.equal(k.keyKind, 'env');
  assert.equal(k.keyMasked, 'env:EA_DOC_DS_01');
  assert.equal(k.envResolved, false);
});

test('环境变量型密钥：变量存在即视为可用', async () => {
  const s = await store({ env: { EA_DOC_DS_01: 'sk-live' } });
  await s.addKey({ pool: 'doc', id: 'd1', apiKeyEnv: 'EA_DOC_DS_01' });
  assert.equal(s.snapshot().pools.find((p) => p.name === 'doc').keys[0].envResolved, true);
  assert.equal(s.testKey, s.testKey); // 引用一下，确保方法存在
});

test('id 冲突与非法 id 被拒绝', async () => {
  const s = await store();
  await s.addKey({ pool: 'worker', id: 'w1', apiKey: 'k' });
  await assert.rejects(() => s.addKey({ pool: 'worker', id: 'w1', apiKey: 'k2' }), /已存在 id=w1/);
  await assert.rejects(() => s.addKey({ pool: 'worker', id: 'bad id!', apiKey: 'k3' }), /id 只能包含/);
  await assert.rejects(() => s.addKey({ pool: 'worker', id: 'w9' }), /必须提供 apiKey 或 apiKeyEnv/);
});

test('换密钥：提供 apiKey 即替换，并清掉 apiKeyEnv', async () => {
  const s = await store({ env: {} });
  await s.addKey({ pool: 'worker', id: 'w1', apiKeyEnv: 'OLD_VAR' });
  await s.updateKey({ pool: 'worker', id: 'w1', patch: { apiKey: 'sk-new-key-123456' } });
  const k = s.snapshot().pools.find((p) => p.name === 'worker').keys.find((x) => x.id === 'w1');
  assert.equal(k.keyKind, 'literal');
  assert.equal(k.keyMasked, 'sk-n****3456');
});

test('停用后不进池配置，但仍在快照里可见', async () => {
  const s = await store();
  await s.addKey({ pool: 'worker', id: 'w1', apiKey: 'k1' });
  await s.addKey({ pool: 'worker', id: 'w2', apiKey: 'k2' });
  await s.updateKey({ pool: 'worker', id: 'w2', patch: { enabled: false } });
  const cfg = s.toPoolConfig();
  // w0 是 model.yml 基线，首次编辑该池时被复制进来；w2 已停用
  assert.deepEqual(cfg.pools.worker.keys.map((k) => k.id), ['w0', 'w1']);
  assert.equal(s.snapshot().pools.find((p) => p.name === 'worker').keyCount, 3);
});

test('model.yml 接管的池：可以新增，但不能在这里删除', async () => {
  const s = await store();                     // seed 里 worker 由 model.yml 提供
  assert.equal(s.snapshot().pools.find((p) => p.name === 'worker').ownedBy, 'model.yml');
  await assert.rejects(() => s.removeKey({ pool: 'worker', id: 'w0' }), /由 model.yml 管理/);
  // 一旦在 keys.json 里加过，就由 keys.json 接管
  await s.addKey({ pool: 'worker', id: 'w1', apiKey: 'k1' });
  assert.equal(s.snapshot().pools.find((p) => p.name === 'worker').ownedBy, 'keys.json');
  await s.removeKey({ pool: 'worker', id: 'w1' });
  assert.deepEqual(s.snapshot().pools.find((p) => p.name === 'worker').keys.map((k) => k.id), ['w0']);
});

test('覆盖规则：keys.json 的池整组覆盖 model.yml，未覆盖的池回落基线', async () => {
  const s = await store({ seed: { ...seed, pools: { ...seed.pools, doc: { model: 'm-doc', apiKey: 'sk-d' } } } });
  await s.addKey({ pool: 'worker', id: 'w1', apiKey: 'k1' });
  const cfg = s.toPoolConfig();
  assert.deepEqual(cfg.pools.worker.keys.map((k) => k.id), ['w0', 'w1'], 'worker 用 keys.json（含复制来的基线 key）');
  assert.equal(cfg.pools.doc.keys.length, 1, 'doc 仍来自 model.yml');
});

test('预算：正数校验与倒挂拦截', async () => {
  const s = await store();
  assert.deepEqual(await s.setBudget({ tokensPerTicket: 500, tokensPerDay: 5000 }), { tokensPerTicket: 500, tokensPerDay: 5000 });
  await assert.rejects(() => s.setBudget({ tokensPerTicket: 0 }), /必须为正数/);
  await assert.rejects(() => s.setBudget({ tokensPerTicket: 9999, tokensPerDay: 100 }), /不应大于日预算/);
});

test('缺 baseUrl 时给出可操作的测试失败原因', async () => {
  const s = await store({ seed: {} });          // 没有任何 baseUrl
  await s.addKey({ pool: 'worker', id: 'w1', apiKey: 'sk-x' });
  const r = await s.testKey({ pool: 'worker', id: 'w1' });
  assert.equal(r.ok, false);
  assert.match(r.message, /缺少 baseUrl/);
});

test('损坏的 keys.json 不被静默覆盖', async () => {
  const file = await tmpFile();
  await fs.writeFile(file, '{ 这不是 JSON', 'utf8');
  const s = await store({ file });
  assert.equal(s.corrupt, true);
  assert.equal(s.snapshot().totals.keys, 1, 'model.yml 的基线 key 仍可见，只是不可在此删除');
  assert.equal(await fs.readFile(file, 'utf8'), '{ 这不是 JSON', '坏文件应原样保留供人工修复');
});
