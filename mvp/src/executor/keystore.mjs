// 密钥存储：管理员工作台的可写层。
//
// 为什么不让工作台直接改 model.yml：那个文件是人手写的、带注释的声明式基线，
// 用程序重写会把注释和排版全丢掉，第二次人工编辑就无从下手。
// 所以分两层：
//   ~/.superagent/model.yml   人工维护的基线（含默认网关、池、预算）
//   ~/.superagent/keys.json   工作台维护的运行时密钥库（按池整组覆盖）
// 同一池只要在 keys.json 里出现，就以 keys.json 为准；否则回落 model.yml。
//
// 安全：文件 0600；密钥只在服务端内存里留全量，任何 API 只返回掩码。
// 诚实说明：这是**本机明文存储**，够单机管理员用；多人或需要审计时应换 Vault/KMS（docs/08 §6）。

import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { exists, readFileSafe, writeFileAtomic } from '../util/fsx.mjs';
import { createHttpGateway, maskKey } from './model.mjs';

export const DEFAULT_KEYS_FILE = path.join(os.homedir(), '.superagent', 'keys.json');
export const VALID_POOLS = ['router', 'worker', 'doc', 'vision'];

const POOL_ALIAS = {
  router: '研判（准入、任务分类）',
  worker: '执行（长上下文、强推理）',
  doc: '长文档（质量记录）',
  vision: '视觉（图纸、扫描件）',
};

function emptyStore() {
  return { version: 1, updatedAt: null, budget: null, pools: {} };
}

function normalizeEntry(raw, env) {
  const id = String(raw.id ?? '').trim();
  const literal = String(raw.apiKey ?? '');
  const envName = raw.apiKeyEnv ? String(raw.apiKeyEnv) : null;
  return {
    id,
    apiKey: literal || undefined,
    apiKeyEnv: envName || undefined,
    model: raw.model ? String(raw.model) : undefined,
    baseUrl: raw.baseUrl ? String(raw.baseUrl) : undefined,
    note: raw.note ? String(raw.note) : '',
    enabled: raw.enabled !== false,
    addedAt: raw.addedAt ?? new Date().toISOString(),
    lastTest: raw.lastTest ?? null,
  };
}

/** 池里的 key 列表：支持 keys[] 与单 key 简写（apiKey / apiKeyEnv）两种写法 */
function entriesOf(src, env) {
  const list = Array.isArray(src?.keys) && src.keys.length
    ? src.keys
    : (src?.apiKey || src?.apiKeyEnv
      ? [{ id: src.id ?? 'primary', apiKey: src.apiKey, apiKeyEnv: src.apiKeyEnv, model: src.model, baseUrl: src.baseUrl }]
      : []);
  return list.map((k) => normalizeEntry(k, env));
}

export class KeyStore {
  constructor({ file = DEFAULT_KEYS_FILE, env = process.env, seed = {} } = {}) {
    this.file = file;
    this.env = env;
    this.seed = seed;              // model.yml 解析结果（含 pools / baseUrl / model / budget）
    this.data = emptyStore();
    this.loaded = false;
    this.fromFile = false;
  }

  async load() {
    if (!this.file) { this.loaded = true; this.fromFile = false; return this; } // 内存态（测试/嵌入式）
    if (await exists(this.file)) {
      const text = await readFileSafe(this.file, '');
      try {
        const parsed = JSON.parse(text);
        this.data = {
          version: parsed.version ?? 1,
          updatedAt: parsed.updatedAt ?? null,
          budget: parsed.budget ?? null,
          pools: parsed.pools ?? {},
        };
        this.fromFile = true;
      } catch {
        // 坏文件不静默覆盖：留原文件，内存用空库，管理员能在界面上看到告警
        this.data = emptyStore();
        this.fromFile = false;
        this.corrupt = true;
      }
    }
    this.loaded = true;
    return this;
  }

  async save() {
    this.data.updatedAt = new Date().toISOString();
    if (!this.file) return null;
    await writeFileAtomic(this.file, JSON.stringify(this.data, null, 2) + '\n');
    try { await fs.chmod(this.file, 0o600); } catch { /* Windows 上可能不支持，忽略 */ }
    this.fromFile = true;
    return this.file;
  }

  /** 该池是否由 keys.json 接管 */
  ownsPool(pool) {
    return Object.prototype.hasOwnProperty.call(this.data.pools, pool);
  }

  effectivePool(pool) {
    if (this.ownsPool(pool)) return this.data.pools[pool];
    return this.seed.pools?.[pool] ?? null;
  }

  effectiveBudget() {
    return {
      tokensPerTicket: Number(this.data.budget?.tokensPerTicket ?? this.seed.budget?.tokensPerTicket) || 120000,
      tokensPerDay: Number(this.data.budget?.tokensPerDay ?? this.seed.budget?.tokensPerDay) || 2000000,
    };
  }

  /** 给 createKeyPool 用的配置：pools 已按覆盖规则合并 */
  toPoolConfig() {
    const pools = {};
    const names = new Set([...Object.keys(this.seed.pools ?? {}), ...Object.keys(this.data.pools)]);
    for (const name of names) {
      const src = this.effectivePool(name);
      if (!src) continue;
      pools[name] = {
        model: src.model ?? this.seed.model,
        baseUrl: src.baseUrl ?? this.seed.baseUrl,
        keys: entriesOf(src, this.env)
          .filter((k) => k.enabled)
          .map((k) => ({
            id: k.id,
            apiKey: k.apiKey,
            apiKeyEnv: k.apiKeyEnv,
            model: k.model ?? src.model ?? this.seed.model,
            baseUrl: k.baseUrl ?? src.baseUrl ?? this.seed.baseUrl,
          })),
      };
    }
    return { pools, budget: this.effectiveBudget() };
  }

  resolveSecret(entry) {
    if (entry.apiKey) return { value: entry.apiKey, kind: 'literal' };
    if (entry.apiKeyEnv) {
      const v = this.env[entry.apiKeyEnv];
      return { value: v ?? '', kind: 'env', envName: entry.apiKeyEnv, resolved: !!v };
    }
    return { value: '', kind: 'none' };
  }

  /** 对外快照：绝不包含明文密钥 */
  snapshot() {
    const names = [...new Set([...VALID_POOLS, ...Object.keys(this.seed.pools ?? {}), ...Object.keys(this.data.pools)])];
    const pools = names.map((name) => {
      const src = this.effectivePool(name);
      const owned = this.ownsPool(name) ? 'keys.json' : 'model.yml';
      const keys = entriesOf(src, this.env).map((entry) => {
        const secret = this.resolveSecret(entry);
        return {
          id: entry.id,
          enabled: entry.enabled,
          model: entry.model ?? src?.model ?? this.seed.model ?? null,
          baseUrl: entry.baseUrl ?? src?.baseUrl ?? this.seed.baseUrl ?? null,
          note: entry.note,
          addedAt: entry.addedAt,
          lastTest: entry.lastTest,
          keyKind: secret.kind,
          keyMasked: secret.kind === 'literal' ? maskKey(secret.value) : (secret.envName ? `env:${secret.envName}` : '(未设置)'),
          envResolved: secret.kind === 'env' ? !!secret.resolved : true,
          ownedBy: owned,
        };
      });
      return {
        name,
        label: POOL_ALIAS[name] ?? '',
        ownedBy: owned,
        model: src?.model ?? this.seed.model ?? null,
        baseUrl: src?.baseUrl ?? this.seed.baseUrl ?? null,
        keys,
        keyCount: keys.length,
        activeCount: keys.filter((k) => k.enabled && (k.keyKind !== 'env' || k.envResolved)).length,
        usable: !!(src?.baseUrl ?? this.seed.baseUrl) && keys.some((k) => k.enabled && (k.keyKind !== 'env' || k.envResolved)),
        problems: (src?.baseUrl ?? this.seed.baseUrl) ? [] : ['缺少 baseUrl（在 model.yml 顶层或该 key 上填写）'],
      };
    });
    return {
      file: this.file,
      fileExists: this.fromFile,
      corrupt: !!this.corrupt,
      budget: this.effectiveBudget(),
      pools,
      totals: {
        keys: pools.reduce((n, p) => n + p.keyCount, 0),
        active: pools.reduce((n, p) => n + p.activeCount, 0),
        poolsWithKeys: pools.filter((p) => p.keyCount > 0).length,
      },
    };
  }

  materialize(poolName) {
    if (!this.ownsPool(poolName)) {
      const src = this.seed.pools?.[poolName];
      this.data.pools[poolName] = {
        model: src?.model ?? this.seed.model,
        baseUrl: src?.baseUrl ?? this.seed.baseUrl,
        // 首次编辑时把 model.yml 的 key 复制进来：此后该池完全由 keys.json 管理
        keys: entriesOf(src, this.env),
      };
    }
    return this.data.pools[poolName];
  }

  assertPool(pool) {
    if (!pool || typeof pool !== 'string') throw new Error('缺少 pool');
    if (!/^[a-z][a-z0-9_-]{1,15}$/i.test(pool)) throw new Error(`pool 名不合规：${pool}`);
  }

  async addKey({ pool, id = null, apiKey = '', apiKeyEnv = '', model = '', baseUrl = '', note = '', enabled = true }) {
    this.assertPool(pool);
    if (!apiKey && !apiKeyEnv) throw new Error('必须提供 apiKey 或 apiKeyEnv 之一');
    const p = this.materialize(pool);
    const keyId = (id || `k${p.keys.length + 1}`).trim();
    if (!/^[A-Za-z0-9_.-]{1,24}$/.test(keyId)) throw new Error('id 只能包含字母、数字、下划线、点、短横线');
    if (p.keys.some((k) => k.id === keyId)) throw new Error(`池 ${pool} 中已存在 id=${keyId}`);
    p.keys.push(normalizeEntry({ id: keyId, apiKey, apiKeyEnv, model, baseUrl, note, enabled }, this.env));
    await this.save();
    return keyId;
  }

  async updateKey({ pool, id, patch = {} }) {
    this.assertPool(pool);
    const p = this.materialize(pool);
    const idx = p.keys.findIndex((k) => k.id === id);
    if (idx === -1) throw new Error(`池 ${pool} 中不存在 id=${id}`);
    const cur = p.keys[idx];
    const next = { ...cur };
    if (patch.apiKey !== undefined) {
      // 换 key：显式提供则替换，空字符串表示清空（退回 apiKeyEnv）
      next.apiKey = patch.apiKey ? String(patch.apiKey) : undefined;
      if (patch.apiKey) next.apiKeyEnv = undefined;
    }
    if (patch.apiKeyEnv !== undefined) {
      next.apiKeyEnv = patch.apiKeyEnv ? String(patch.apiKeyEnv) : undefined;
      if (patch.apiKeyEnv) next.apiKey = undefined;
    }
    if (patch.model !== undefined) next.model = patch.model ? String(patch.model) : undefined;
    if (patch.baseUrl !== undefined) next.baseUrl = patch.baseUrl ? String(patch.baseUrl) : undefined;
    if (patch.note !== undefined) next.note = String(patch.note).slice(0, 200);
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
    if (patch.testResult !== undefined) next.lastTest = patch.testResult;
    if (!next.apiKey && !next.apiKeyEnv) throw new Error('更新后该 key 既无 apiKey 也无 apiKeyEnv，已拒绝');
    p.keys[idx] = next;
    await this.save();
    return next;
  }

  async removeKey({ pool, id }) {
    this.assertPool(pool);
    if (!this.ownsPool(pool)) throw new Error(`池 ${pool} 由 model.yml 管理，不能在此删除；请改动 model.yml 或在 keys.json 中重建该池`);
    const p = this.data.pools[pool];
    const before = p.keys.length;
    p.keys = p.keys.filter((k) => k.id !== id);
    if (p.keys.length === before) throw new Error(`池 ${pool} 中不存在 id=${id}`);
    await this.save();
    return p.keys.length;
  }

  async setBudget({ tokensPerTicket, tokensPerDay }) {
    const cur = this.effectiveBudget();
    const next = {
      tokensPerTicket: Number(tokensPerTicket ?? cur.tokensPerTicket),
      tokensPerDay: Number(tokensPerDay ?? cur.tokensPerDay),
    };
    if (!(next.tokensPerTicket > 0) || !(next.tokensPerDay > 0)) throw new Error('预算必须为正数');
    if (next.tokensPerTicket > next.tokensPerDay) throw new Error('单工单预算不应大于日预算');
    this.data.budget = next;
    await this.save();
    return next;
  }

  entry(pool, id) {
    const p = this.effectivePool(pool);
    const found = entriesOf(p, this.env).find((k) => k.id === id);
    if (!found) return null;
    const secret = this.resolveSecret(found);
    return {
      entry: found,
      secret,
      model: found.model ?? p?.model ?? this.seed.model,
      baseUrl: found.baseUrl ?? p?.baseUrl ?? this.seed.baseUrl,
    };
  }

  /** 单把 key 的连通性自检：只看这一把，不走池内换 key 逻辑 */
  async testKey({ pool, id, timeoutMs = 15000 }) {
    const found = this.entry(pool, id);
    if (!found) throw new Error(`池 ${pool} 中不存在 id=${id}`);
    const { entry, secret, model, baseUrl } = found;
    if (!secret.value) {
      const msg = secret.kind === 'env' ? `环境变量 ${secret.envName} 为空` : '未配置密钥';
      await this.updateKey({ pool, id, patch: { testResult: { at: new Date().toISOString(), ok: false, message: msg } } });
      return { ok: false, message: msg };
    }
    const gw = createHttpGateway({ baseUrl, apiKey: secret.value, model, timeoutMs, maxTokens: 16 });
    if (!gw.configured) {
      const msg = !baseUrl
        ? '缺少 baseUrl：请在 model.yml 顶层或该 key 的 baseUrl 填写'
        : '密钥为空，无法测试';
      await this.updateKey({ pool, id, patch: { testResult: { at: new Date().toISOString(), ok: false, message: msg } } });
      return { ok: false, message: msg };
    }
    const t0 = Date.now();
    try {
      const r = await gw.generate({ prompt: '只回复两个字：就绪', system: '连通性自检，不要解释。' });
      const ms = Date.now() - t0;
      await this.updateKey({ pool, id, patch: { testResult: { at: new Date().toISOString(), ok: true, ms, message: String(r.text ?? '').slice(0, 40) } } });
      return { ok: true, ms, sample: String(r.text ?? '').slice(0, 40) };
    } catch (err) {
      const ms = Date.now() - t0;
      await this.updateKey({ pool, id, patch: { testResult: { at: new Date().toISOString(), ok: false, ms, message: err.message } } });
      return { ok: false, ms, message: err.message };
    }
  }
}

export async function loadKeyStore({ file, env, seed }) {
  const store = new KeyStore({ file: file ?? DEFAULT_KEYS_FILE, env: env ?? process.env, seed: seed ?? {} });
  return store.load();
}
