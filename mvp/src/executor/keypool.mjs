// 密钥池：一个"池"对应一种调用形态（研判 / 执行 / 长文档 / 视觉），
// 池内可放多把 key；选 key 用"最久未失败优先"，失败即换下一把。
//
// 为什么按形态分池、再让岗位绑定池，而不是"每个岗位一把 key"：
// 岗位有 5 个、形态只有 4 种。按岗位发 key 会得到 5 把低配额 key，且同一张工单
// 由多岗位协作时会散落在 3–4 把 key 上，既算不清单工单成本，也无法在限流时腾挪。
// 岗位 → 池 的映射保留了"每个岗位用自己的模型"的表达力，同时让配额集中可用。

import { createHttpGateway, nullGateway } from './model.mjs';

const DEFAULT_POOLS = ['router', 'worker', 'doc', 'vision'];

function normalizeKeys(poolCfg) {
  if (!poolCfg) return [];
  if (Array.isArray(poolCfg.keys) && poolCfg.keys.length) {
    return poolCfg.keys.map((k, i) => ({
      id: k.id ?? `${i + 1}`,
      apiKey: k.apiKey ?? '',
      apiKeyEnv: k.apiKeyEnv ?? null,
      baseUrl: k.baseUrl ?? poolCfg.baseUrl ?? '',
      model: k.model ?? poolCfg.model ?? '',
      tier: k.tier ?? poolCfg.tier ?? 'standard',
    }));
  }
  if (poolCfg.apiKey || poolCfg.apiKeyEnv) {
    return [{
      id: poolCfg.id ?? 'primary',
      apiKey: poolCfg.apiKey ?? '',
      apiKeyEnv: poolCfg.apiKeyEnv ?? null,
      baseUrl: poolCfg.baseUrl ?? '',
      model: poolCfg.model ?? '',
      tier: poolCfg.tier ?? 'standard',
    }];
  }
  return [];
}

/**
 * @param {object} args
 * @param {object} args.config       model.yml 解析结果（含 pools / baseUrl / model / apiKey）
 * @param {object} args.env          环境变量来源
 * @param {object|null} args.fallback 未配置池时使用的网关（通常是默认网关或测试桩）
 * @param {(u:object)=>void} args.onUsage 每次成功调用后的记账回调
 */
export function createKeyPool({
  config = {}, env = process.env, fallback = null, onUsage = null, maxAttempts = 3,
  gatewayFactory = createHttpGateway,
} = {}) {
  const poolCfgs = { ...(config.pools ?? {}) };
  const names = [...new Set([...DEFAULT_POOLS, ...Object.keys(poolCfgs)])];

  /** @type {Map<string, Array<{id,gateway,model,lastFailedAt,failures}>>} */
  const pools = new Map();

  for (const name of names) {
    const cfg = poolCfgs[name] ?? null;
    const keys = normalizeKeys(cfg);
    const entries = [];

    for (const k of keys) {
      const apiKey = k.apiKey || (k.apiKeyEnv ? env[k.apiKeyEnv] ?? '' : '');
      const baseUrl = k.baseUrl || config.baseUrl || '';
      const model = k.model || config.model || '';
      const gateway = gatewayFactory({ baseUrl, apiKey, model, timeoutMs: config.timeoutMs, maxTokens: config.maxTokens });
      if (gateway.configured) {
        entries.push({ id: k.id, gateway, model, tier: k.tier, lastFailedAt: 0, failures: 0 });
      }
    }

    // 池没配 key 时继承默认网关：让"只填了一个 key"的用法继续可用
    if (!entries.length && fallback) entries.push({ id: 'default', gateway: fallback, model: fallback.modelName ?? config.model, tier: 'inherit', lastFailedAt: 0, failures: 0 });
    pools.set(name, entries);
  }

  function available(name) {
    return (pools.get(name) ?? []).length > 0;
  }

  function ordered(name) {
    const list = pools.get(name) ?? [];
    // 最久未失败优先：失败过的排后面，避免重试总打在同一把 key 上
    return [...list].sort((a, b) => a.lastFailedAt - b.lastFailedAt);
  }

  async function generate({ pool = 'worker', purpose = 'unknown', ...args }) {
    const list = ordered(pool);
    if (!list.length) {
      const out = await nullGateway.generate(args);
      return { ...out, pool, keyId: null, model: null, skipped: true, reason: out.reason };
    }
    let lastErr = null;
    const tried = [];
    for (const entry of list.slice(0, Math.max(1, maxAttempts))) {
      tried.push(entry.id);
      try {
        // 把 pool/purpose 一并传下去：网关会忽略，但测试桩与审计需要知道这次是谁在用
        const res = await entry.gateway.generate({ ...args, pool, purpose });
        entry.failures = 0;
        if (onUsage) {
          onUsage({
            pool, keyId: entry.id, model: entry.model,
            tokens: res.usage?.tokens ?? 0, purpose,
          });
        }
        return { ...res, pool, keyId: entry.id, model: entry.model ?? null };
      } catch (err) {
        entry.failures += 1;
        entry.lastFailedAt = Date.now();
        lastErr = err;
      }
    }
    const e = new Error(`池 ${pool} 全部 key 失败（试过 ${tried.join(',')}）：${lastErr?.message ?? '未知错误'}`);
    e.pool = pool;
    e.tried = tried;
    throw e;
  }

  function describe() {
    return names
      .filter((n) => (pools.get(n) ?? []).length > 0)
      .map((n) => ({
        pool: n,
        keys: pools.get(n).length,
        models: [...new Set(pools.get(n).map((e) => e.model).filter(Boolean))],
        temporaryFailures: pools.get(n).filter((e) => e.failures > 0).length,
      }));
  }

  return { generate, describe, available, pools, names };
}
