// 模型网关接口。MVP 默认用 nullGateway：不调模型，不伪造内容。
//
// 密钥放哪（优先级从高到低）：
//   1. 构造参数（测试/嵌入用）
//   2. 环境变量 SUPERAGENT_MODEL_BASE_URL / _API_KEY / _NAME（CI、容器）
//   3. ~/.superagent/model.yml（本机开发推荐；不在仓库里，也不在 stateDir 里）
//
// 为什么默认放用户主目录：docs/08 的三条硬规则是"不进 Git、不进 stateDir、不进工单目录"。
// 放在仓库里靠 .gitignore 兜底，迟早有人 git add -f；放在主目录则根本进不了版本库。

import path from 'node:path';
import os from 'node:os';
import { parseYaml } from '../util/yaml.mjs';
import { exists, readFileSafe } from '../util/fsx.mjs';

export const DEFAULT_MODEL_FILE = path.join(os.homedir(), '.superagent', 'model.yml');

export const nullGateway = {
  name: 'null',
  configured: false,
  async generate() {
    return {
      text: null, object: null, usage: { tokens: 0 },
      reason: '未配置模型网关：本实例不生成技术内容（骨架与占位仍会产出）',
    };
  },
};

/** 只暴露首尾各 4 位，足够核对"填的是哪把 key"，又不足以泄露 */
export function maskKey(key) {
  const s = String(key ?? '');
  if (!s) return '(未设置)';
  if (s.length <= 10) return `${'*'.repeat(s.length)}`;
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

/**
 * 解析生效的模型配置。字段级合并：环境变量优先于文件，未提供的字段回落到文件。
 * @returns {{baseUrl:string, model:string, apiKey:string, file:string, fileExists:boolean,
 *            source:string, keySource:string, warnings:string[]}}
 */
export async function resolveModelConfig({ env = process.env, file = null, overrides = {} } = {}) {
  const warnings = [];
  const filePath = file ?? env.SUPERAGENT_MODEL_FILE ?? DEFAULT_MODEL_FILE;

  let fromFile = {};
  let fileExists = false;
  if (await exists(filePath)) {
    fileExists = true;
    try {
      fromFile = parseYaml(await readFileSafe(filePath, ''), { file: filePath }) ?? {};
    } catch (err) {
      warnings.push(`${filePath} 解析失败：${err.message}`);
      fromFile = {};
    }
  }

  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '') ?? '';
  const baseUrl = String(pick(overrides.baseUrl, env.SUPERAGENT_MODEL_BASE_URL, fromFile.baseUrl)).replace(/\/+$/, '');
  const model = String(pick(overrides.model, env.SUPERAGENT_MODEL_NAME, fromFile.model));

  let apiKey = String(pick(overrides.apiKey, env.SUPERAGENT_MODEL_API_KEY, fromFile.apiKey));
  let keySource = apiKey
    ? (overrides.apiKey ? 'override' : (env.SUPERAGENT_MODEL_API_KEY ? 'env' : `file:${filePath}`))
    : 'none';

  // 文件里只写变量名（推荐做法，与 config/ai-keys.example.yml 的约定一致）
  if (!apiKey && fromFile.apiKeyEnv) {
    const v = env[fromFile.apiKeyEnv];
    if (v) {
      apiKey = String(v);
      keySource = `env:${fromFile.apiKeyEnv}`;
    } else {
      warnings.push(`${filePath} 引用 apiKeyEnv=${fromFile.apiKeyEnv}，但该环境变量为空`);
    }
  }

  if (fileExists && (!baseUrl || !apiKey)) {
    const pools = fromFile.pools ?? {};
    const poolKeys = Object.values(pools).some((p) => p && (p.apiKey || p.apiKeyEnv || (Array.isArray(p.keys) && p.keys.length)));
    if (!poolKeys) warnings.push(`${filePath} 已存在但配置不完整：缺少 ${[!baseUrl && 'baseUrl', !apiKey && 'apiKey/apiKeyEnv'].filter(Boolean).join('、')}`);
  }

  const pools = fromFile.pools ?? {};
  const poolKeyCount = Object.values(pools).reduce((n, p) => {
    if (!p) return n;
    if (Array.isArray(p.keys)) return n + p.keys.length;
    return n + (p.apiKey || p.apiKeyEnv ? 1 : 0);
  }, 0);

  return {
    baseUrl, model, apiKey,
    file: filePath, fileExists, keySource,
    source: apiKey ? (keySource.startsWith('env') ? 'env' : 'file') : (poolKeyCount ? 'pools' : 'none'),
    configured: !!apiKey || poolKeyCount > 0,
    pools,
    poolKeyCount,
    budget: {
      tokensPerTicket: Number(fromFile.budget?.tokensPerTicket) || 120000,
      tokensPerDay: Number(fromFile.budget?.tokensPerDay) || 2000000,
    },
    timeoutMs: Number(fromFile.timeoutMs) || 60000,
    maxTokens: Number(fromFile.maxTokens) || 1200,
    warnings,
  };
}

export function createHttpGateway({ baseUrl, apiKey, model, timeoutMs = 60000, maxTokens = 1200 }) {
  if (!baseUrl || !apiKey) return nullGateway;
  return {
    name: `http:${model || 'default'}`,
    configured: true,
    async generate({ prompt, system = '你是汽车电子工程师助手。只输出可从输入确定的结论；不确定就写“待确认”。' }) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        let res;
        try {
          res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model,
              max_tokens: maxTokens,
              messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
            }),
            signal: ctrl.signal,
          });
        } catch (err) {
          // Node 的 fetch 只抛 "fetch failed"，真正原因在 err.cause，不展开等于没说
          if (err.name === 'AbortError') throw new Error(`请求超时（>${timeoutMs} ms）：${baseUrl}`);
          const cause = err.cause?.code ?? err.cause?.message ?? err.message;
          throw new Error(`无法连接 ${baseUrl}：${cause}（检查 baseUrl / 代理 / 网络策略）`);
        }

        const text = await res.text();
        let data = {};
        try { data = JSON.parse(text); } catch { data = {}; }
        if (!res.ok) {
          const detail = data?.error?.message ?? data?.message ?? text.slice(0, 160);
          const hint = res.status === 401 || res.status === 403
            ? '密钥无效或无权访问该模型'
            : res.status === 404
              ? '接口路径不对，baseUrl 通常需以 /v1 结尾'
              : res.status === 429
                ? '限流或额度用尽'
                : '服务端错误';
          throw new Error(`模型网关返回 ${res.status}（${hint}）：${detail}`);
        }
        return {
          text: data.choices?.[0]?.message?.content ?? null,
          object: null,
          usage: { tokens: data.usage?.total_tokens ?? 0 },
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function gatewayFromConfig(cfg) {
  if (!cfg?.baseUrl || !cfg?.apiKey) return nullGateway;
  return createHttpGateway({
    baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
    timeoutMs: cfg.timeoutMs, maxTokens: cfg.maxTokens,
  });
}

/** 兼容旧调用：仅从环境变量构造 */
export function gatewayFromEnv(env = process.env) {
  const baseUrl = env.SUPERAGENT_MODEL_BASE_URL;
  const apiKey = env.SUPERAGENT_MODEL_API_KEY;
  if (!baseUrl || !apiKey) return nullGateway;
  return createHttpGateway({ baseUrl, apiKey, model: env.SUPERAGENT_MODEL_NAME });
}
