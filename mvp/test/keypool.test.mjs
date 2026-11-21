import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyPool } from '../src/executor/keypool.mjs';

const okGateway = (tag, tokens = 10) => ({
  configured: true,
  name: `stub:${tag}`,
  async generate() { return { text: `${tag}-ok`, usage: { tokens } }; },
});
const badGateway = (tag) => ({
  configured: true,
  name: `stub:${tag}`,
  async generate() { throw new Error(`${tag} 限流 429`); },
});

test('池：单 key 直接可用，并把用量回传', async () => {
  const used = [];
  const pool = createKeyPool({
    config: { baseUrl: 'http://x', model: 'm', pools: { worker: { apiKey: 'k' } } },
    env: {},
    gatewayFactory: () => okGateway('w1', 42),
    onUsage: (u) => used.push(u),
  });
  const r = await pool.generate({ pool: 'worker', purpose: 'fill:8D' });
  assert.equal(r.text, 'w1-ok');
  assert.equal(r.keyId, 'primary');
  assert.deepEqual(used, [{ pool: 'worker', keyId: 'primary', model: 'm', tokens: 42, purpose: 'fill:8D' }]);
});

test('池：失败的 key 自动让位给下一把，并记录暂时失败', async () => {
  let n = 0;
  const pool = createKeyPool({
    config: {
      baseUrl: 'http://x', model: 'm',
      pools: { worker: { keys: [{ id: 'w1', apiKey: 'a' }, { id: 'w2', apiKey: 'b' }] } },
    },
    env: {},
    gatewayFactory: ({ apiKey }) => (apiKey === 'a' ? badGateway('w1') : okGateway('w2')),
  });
  const r = await pool.generate({ pool: 'worker' });
  assert.equal(r.keyId, 'w2');
  n += 1;
  // 第二次应优先走没失败过的 w2，不再先打 w1
  const r2 = await pool.generate({ pool: 'worker' });
  assert.equal(r2.keyId, 'w2');
  const desc = pool.describe().find((d) => d.pool === 'worker');
  assert.equal(desc.keys, 2);
  assert.equal(desc.temporaryFailures, 1);
});

test('池：全部 key 失败时抛出聚合错误，带上试过的 key', async () => {
  const pool = createKeyPool({
    config: { baseUrl: 'http://x', model: 'm', pools: { doc: { keys: [{ id: 'd1', apiKey: 'a' }, { id: 'd2', apiKey: 'b' }] } } },
    env: {},
    gatewayFactory: () => badGateway('d'),
  });
  await assert.rejects(() => pool.generate({ pool: 'doc' }), (err) => {
    assert.match(err.message, /池 doc 全部 key 失败/);
    assert.deepEqual(err.tried, ['d1', 'd2']);
    return true;
  });
});

test('池：只写 apiKeyEnv 时从环境变量取 key', async () => {
  const seen = [];
  const pool = createKeyPool({
    config: { baseUrl: 'http://x', model: 'm', pools: { worker: { apiKeyEnv: 'MY_WORKER_KEY' } } },
    env: { MY_WORKER_KEY: 'secret-1' },
    gatewayFactory: ({ apiKey }) => { seen.push(apiKey); return okGateway('w'); },
  });
  await pool.generate({ pool: 'worker' });
  assert.deepEqual(seen, ['secret-1']);
});

test('池：未配置的池继承默认网关（只填一把 key 也能用）', async () => {
  const fallback = okGateway('default');
  const pool = createKeyPool({ config: {}, env: {}, fallback });
  const r = await pool.generate({ pool: 'doc' });
  assert.equal(r.text, 'default-ok');
  assert.equal(r.keyId, 'default');
});

test('池：完全没有 key 时返回 skipped，而不是抛错', async () => {
  const pool = createKeyPool({ config: {}, env: {}, fallback: null });
  const r = await pool.generate({ pool: 'worker' });
  assert.equal(r.skipped, true);
  assert.equal(r.text, null);
  assert.match(r.reason, /未配置/);
});

test('池：不同池互不影响，可各用各的模型', async () => {
  const pool = createKeyPool({
    config: {
      baseUrl: 'http://x',
      pools: {
        worker: { model: 'strong', apiKey: 'a' },
        doc: { model: 'cheap', apiKey: 'b' },
      },
    },
    env: {},
    gatewayFactory: ({ model }) => okGateway(model),
  });
  const w = await pool.generate({ pool: 'worker' });
  const d = await pool.generate({ pool: 'doc' });
  assert.equal(w.text, 'strong-ok');
  assert.equal(d.text, 'cheap-ok');
});
