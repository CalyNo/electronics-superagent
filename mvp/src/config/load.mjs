import path from 'node:path';
import { readFileSafe, exists } from '../util/fsx.mjs';
import { parseYaml } from '../util/yaml.mjs';

export class ConfigError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'ConfigError';
    this.details = details;
  }
}

const CODE_RE = /^[A-Z][A-Z0-9]{1,7}$/;
export const ACCEPT_MODES = ['off', 'observe', 'auto'];

// 平台基线：项目级 rules.yml 只能加严，不能放宽（docs/06 §3）
export const PLATFORM_BASELINE = {
  minSectionsFilled: 0.8,
  maxTodoMarkers: 5,
  maxDiffLines: 800,
  perTicketLimit: 30,
  dailyLimit: 250,
  blockedCommands: ['rm -rf /', 'git push --force', 'git reset --hard origin/main'],
};

/** 平台必备禁令的"能力"表示：项目清单只要覆盖这些能力即可，不要求逐字照抄 */
const REQUIRED_BLOCKED = [
  { id: 'rm -rf', re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i },
  { id: 'git push --force', re: /git\s+push\s+(--force|-f)\b/i },
  { id: 'git reset --hard', re: /git\s+reset\s+--hard/i },
];

/** 读取项目骨架三件套：manifest / rules / taxonomy */
export async function loadProject(projectDir) {
  const sa = path.join(projectDir, '.superagent');
  const manifestFile = path.join(sa, 'manifest.yml');
  if (!(await exists(manifestFile))) {
    throw new ConfigError(`缺少 ${path.relative(process.cwd(), manifestFile)}；先运行 init 或 new-project.sh`);
  }
  const manifest = parseYaml(await readFileSafe(manifestFile, ''), { file: manifestFile });
  const errors = [];

  if (!manifest.code) errors.push('manifest.code 必填');
  else if (!CODE_RE.test(String(manifest.code))) errors.push(`manifest.code 不合规：${manifest.code}（2-8 位大写字母数字，首字符为字母）`);
  if (!manifest.name) errors.push('manifest.name 必填');
  if (!manifest.topology) errors.push('manifest.topology 必填（A/B/C）');
  const stages = manifest.stages?.enabled;
  if (!Array.isArray(stages) || !stages.length) errors.push('manifest.stages.enabled 必须是非空数组');
  else {
    const bad = stages.filter((s) => !/^S[1-5]$/.test(String(s)));
    if (bad.length) errors.push(`manifest.stages.enabled 含非法阶段：${bad.join(',')}`);
  }
  if (!manifest.system?.stateDir) errors.push('manifest.system.stateDir 必填');

  const rulesFile = path.join(sa, 'rules.yml');
  const rules = (await exists(rulesFile))
    ? parseYaml(await readFileSafe(rulesFile, ''), { file: rulesFile })
    : {};

  const taxFile = path.join(sa, 'taxonomy.yml');
  const taxonomy = (await exists(taxFile))
    ? parseYaml(await readFileSafe(taxFile, ''), { file: taxFile })
    : {};

  if (errors.length) throw new ConfigError(`项目配置校验失败（${errors.length} 项）`, errors);

  return {
    root: projectDir,
    manifest,
    rules,
    taxonomy,
    paths: {
      superagent: sa,
      docs: path.join(projectDir, 'docs'),
      templates: path.join(projectDir, 'docs', '_templates'),
      index: path.join(projectDir, 'docs', '_index'),
      hardware: path.join(projectDir, 'hardware'),
      firmware: path.join(projectDir, 'firmware'),
      software: path.join(projectDir, 'software'),
      evidence: path.join(projectDir, 'evidence'),
      state: path.join(projectDir, '.state'),
    },
  };
}

/** 读取平台策略。缺文件时返回一份"全拒"的最小策略——空名单即全拒是设计内行为 */
export async function loadPolicy(file) {
  if (!file) return { policy: emptyPolicy(), source: null, errors: [] };
  if (!(await exists(file))) return { policy: emptyPolicy(), source: null, errors: [`策略文件不存在：${file}`] };
  const text = await readFileSafe(file, '');
  let policy;
  try {
    policy = parseYaml(text, { file });
  } catch (err) {
    return { policy: emptyPolicy(), source: file, errors: [`策略解析失败：${err.message}`] };
  }
  const errors = validatePolicy(policy);
  return { policy, source: file, errors };
}

export function emptyPolicy() {
  return {
    version: 'pv-empty',
    acceptMode: 'observe',
    rules: [],
    sources: { feishu: { allowed: [], bots: [], admission: {} } },
    stageGates: {},
    execution: { protectedBranches: ['main', 'develop'], allowedBranchPrefixes: ['agent/', 'change/', 'fix/'] },
    audit: { retainYears: 15 },
  };
}

export function validatePolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== 'object') return ['策略内容不是对象'];
  if (!policy.acceptMode) errors.push('policy.acceptMode 必填');
  else if (!ACCEPT_MODES.includes(policy.acceptMode)) errors.push(`policy.acceptMode 非法：${policy.acceptMode}`);

  for (const key of ['feishu', 'local']) {
    const src = policy.sources?.[key];
    if (src && src.allowed && !Array.isArray(src.allowed)) errors.push(`policy.sources.${key}.allowed 必须是数组`);
  }
  const mode = policy.acceptMode;
  if (mode === 'auto' && !(policy.sources?.feishu?.allowed?.length || policy.sources?.local?.allowed?.length)) {
    // 不是错误，但必须显式提示：auto + 空名单等于"永不开工"
    errors.push('acceptMode=auto 但白名单为空：任何请求都不会成为工单（这是配置意图问题，不是程序缺陷）');
  }
  for (const [gid, g] of Object.entries(policy.stageGates ?? {})) {
    if (!Array.isArray(g.requiredDeliverables)) errors.push(`policy.stageGates.${gid}.requiredDeliverables 必须是数组`);
    if (!Array.isArray(g.signers)) errors.push(`policy.stageGates.${gid}.signers 必须是数组`);
  }
  return errors;
}

/**
 * 项目级规则只能加严：填充率下限更高、待补充上限更低、命令黑名单更大、预算更低。
 * 任一项放宽即拒绝启动——这是防"某个项目嫌麻烦就自己把门禁关掉"的唯一有效手段。
 */
export function assertStricter(rules, baseline = PLATFORM_BASELINE) {
  const errors = [];
  const s = rules?.stricter ?? {};

  const fill = s.templates?.minSectionsFilled;
  if (fill !== undefined && Number(fill) < baseline.minSectionsFilled) {
    errors.push(`rules.stricter.templates.minSectionsFilled=${fill} 低于平台基线 ${baseline.minSectionsFilled}（只能加严）`);
  }
  const todo = s.templates?.maxTodoMarkers;
  if (todo !== undefined && Number(todo) > baseline.maxTodoMarkers) {
    errors.push(`rules.stricter.templates.maxTodoMarkers=${todo} 高于平台上限 ${baseline.maxTodoMarkers}（只能加严）`);
  }
  const diff = s.execution?.maxDiffLines;
  if (diff !== undefined && Number(diff) > baseline.maxDiffLines) {
    errors.push(`rules.stricter.execution.maxDiffLines=${diff} 高于平台上限 ${baseline.maxDiffLines}（只能加严）`);
  }
  const per = s.budget?.perTicketLimit;
  if (per !== undefined && Number(per) > baseline.perTicketLimit) {
    errors.push(`rules.stricter.budget.perTicketLimit=${per} 高于平台上限 ${baseline.perTicketLimit}（只能加严）`);
  }
  const blocked = s.execution?.blockedCommands ?? [];
  // 不做字符串精确匹配：项目写 `rm -rf` 与平台写 `rm -rf /` 是同一类禁令，
  // 按"危险能力是否被覆盖"判断，避免形式主义地逼人抄一遍清单。
  if (blocked.length) {
    const missing = REQUIRED_BLOCKED.filter((c) => !blocked.some((b) => c.re.test(String(b))));
    if (missing.length) {
      errors.push(`rules.stricter.execution.blockedCommands 未覆盖平台必备禁令：${missing.map((c) => c.id).join(' / ')}`);
    }
  }
  const prefixes = s.execution?.allowedBranchPrefixes;
  if (Array.isArray(prefixes)) {
    const forbidden = prefixes.filter((p) => ['main', 'develop', ''].includes(p) || p.startsWith('release/'));
    if (forbidden.length) errors.push(`allowedBranchPrefixes 不得包含受保护分支前缀：${forbidden.join(',')}`);
  }
  return { ok: errors.length === 0, errors };
}

/** 生效的约束值：项目规则覆盖平台默认，但已被 assertStricter 保证不会放宽 */
export function effectiveRules(rules = {}, policy = {}) {
  const s = rules.stricter ?? {};
  return {
    minSectionsFilled: s.templates?.minSectionsFilled ?? PLATFORM_BASELINE.minSectionsFilled,
    maxTodoMarkers: s.templates?.maxTodoMarkers ?? PLATFORM_BASELINE.maxTodoMarkers,
    maxDiffLines: s.execution?.maxDiffLines ?? policy.execution?.maxDiffLines ?? PLATFORM_BASELINE.maxDiffLines,
    protectedBranches: policy.execution?.protectedBranches ?? ['main', 'develop'],
    allowedBranchPrefixes: s.execution?.allowedBranchPrefixes ?? policy.execution?.allowedBranchPrefixes ?? ['agent/', 'change/', 'fix/'],
    blockedCommands: [...new Set([...(policy.execution?.blockedCommands ?? []), ...(s.execution?.blockedCommands ?? []), ...PLATFORM_BASELINE.blockedCommands])],
    redactPatterns: s.security?.redactPatterns ?? [
      '(?i)api[_-]?key\\s*[=:]',
      '(?i)secret\\s*[=:]',
      '(?i)passwd\\s*[=:]',
      'ghp_[A-Za-z0-9]{36}',
      'AKIA[0-9A-Z]{16}',
    ],
    requiredTemplates: s.templates?.required ?? [],
  };
}
