// 任务路由：把一句自然语言判成 taskType / 起始阶段 / 交付物清单 / 风险等级。
// MVP 用有序关键词规则（docs/02 §3.1），命中即停；规则顺序本身就是优先级。
// 判不出来时返回 clarify —— 这是设计内行为：宁可问一句，不猜。

import { DOC_TYPES, STAGE_ORDER, TASK_PLANS, planFor } from './stages.mjs';

// 顺序敏感：越具体的规则越靠前，避免"产线参数变更"被判成设计变更
const RULES = [
  {
    // 固件代码改动优先于设计变更：否则"改固件实现双击配对"会先被 design-change 的"改/增加"命中
    taskType: 'code-change',
    id: 'rule-code-change',
    keywords: ['改固件', '改代码', '写固件', '固件实现', '代码实现', '烧录代码', '固件代码', '固件修改', '固件变更', '更新固件'],
    reason: '命中固件代码关键词 → 走 code-change，由软件工程师(SW)修改 firmware/ 应用代码',
  },
  {
    taskType: 'quality-8d',
    id: 'rule-quality-8d',
    keywords: ['投诉', '客诉', '反馈', '失效', '失败', '退货', '不良', '批量', '异常', '召回', '故障', '返修', '不工作'],
    reason: '命中质量问题关键词 → 走 8D（不套阶段门，按 D1–D8 时限）',
  },
  {
    taskType: 'process-change',
    id: 'rule-process-change',
    keywords: ['产线', '工艺', '工装', '检具', '贴片', '焊接', '回流焊', 'smt', 'sop', '节拍'],
    reason: '命中过程变更关键词 → 更新过程流程图/PFMEA/控制计划',
  },
  {
    taskType: 'design-change',
    id: 'rule-design-change',
    keywords: ['变更', '改版', '替换', '改板', 'ecn', '原理图', 'pcb', 'bom', '降额', '选型', '增加', '新增', '添加'],
    reason: '命中设计变更关键词 → 走 ECN，并做影响分析',
  },
  {
    taskType: 'project-init',
    id: 'rule-project-init',
    keywords: ['立项', '新项目', '启动项目', '定点', '开发新', '报价'],
    reason: '命中立项关键词 → 从 S1 起，齐套四份策划交付物',
  },
  {
    taskType: 'test',
    id: 'rule-test',
    keywords: ['测试', '试验', '验证', '温循', '振动', 'emc', '老化', '盐雾', '寿命'],
    reason: '命中验证关键词 → 生成试产/测试报告',
  },
  {
    taskType: 'doc',
    id: 'rule-doc-fill',
    keywords: ['补', '完善', '更新文档', '缺一份', '模板', '起草', '整理文档'],
    reason: '命中文档补齐关键词 → 按指定类型套模板生成骨架',
  },
];

// 文档类型识别词：只在 doc / 其它任务里用来细化交付物
const DOC_HINTS = [
  { type: 'DFMEA', words: ['dfmea', '设计失效'] },
  { type: 'PFMEA', words: ['pfmea', '过程失效'] },
  { type: 'CP', words: ['控制计划'] },
  { type: 'PFC', words: ['流程图', '过程流'] },
  { type: 'DVP', words: ['dvp', '验证计划'] },
  { type: 'SC', words: ['特殊特性'] },
  { type: 'MSA', words: ['msa', '测量系统'] },
  { type: 'SPC', words: ['spc', '过程能力', 'cpk'] },
  { type: 'PPAP', words: ['ppap'] },
  { type: '8D', words: ['8d'] },
  { type: 'ECN', words: ['ecn', '变更通知'] },
  { type: 'CHTR', words: ['章程'] },
  { type: 'SRS', words: ['需求规格', '技术要求'] },
  { type: 'APQP', words: ['apqp'] },
  { type: 'FEAS', words: ['可行性'] },
  { type: 'TEST', words: ['测试报告', '试验报告', '验证报告'] },
  { type: 'TR', words: ['试产'] },
];

const HIGH_RISK = ['安全件', '安全', '法规', '召回', '客户特殊特性', '功能安全', 'asil'];
const MID_RISK = ['特殊特性', '关键特性', '重要特性'];

const APP_PATH = /^(?:firmware\/(?:ble\/)?app\/|T23\/projects\/[^/]+\/ble\/app\/).+\.[ch]$/i;
const DENIED_CODE_DIR = /^(?:sdk|cmsis|ble_library|n32wb03x_std_periph_driver|middlewares?|boot(?:loader)?|mdk-arm|objects|listings)$/i;
const CHANGE_ACTION = /改|替换|新增|添加|修复|实现|调整|更新|\b(?:edit|modify|change|fix|implement|update|patch)\b/i;
const FIRMWARE_ACTION = /\bfirmware\s+(?:changes?|updates?|patch)\b|\b(?:edit|modify|change|update|patch)\s+(?:the\s+)?firmware\b/i;
const QUALITY_REPORT = /(?:出|开|提交|生成|提供|补写|制作|开展|走|要)\s*(?:一[份张个]\s*)?8d\b/i;

export function isFirmwareApplicationPath(relPath) {
  if (!APP_PATH.test(relPath)) return false;
  const parts = relPath.split('/');
  return parts.every((part) => /^[\p{L}\p{N}_. -]+$/u.test(part) && !/[. ]$/.test(part))
    && !parts.slice(0, -1).some((part) => DENIED_CODE_DIR.test(part));
}

function pickCodeTargets(requirement) {
  const text = requirement.replace(/\\/g, '/');
  const paths = new Set();
  const candidates = text.matchAll(/`([^`\r\n]+)`|"([^"\r\n]+)"|(?<![\w./:-])(?:firmware\/|T23\/projects\/)[\p{L}\p{N}_.\/-]+\.[ch](?![\p{L}\p{N}_/-]|\.[\p{L}\p{N}_-])/giu);
  for (const [match, backticked, quoted] of candidates) {
    const relPath = backticked ?? quoted ?? match;
    if (isFirmwareApplicationPath(relPath)) paths.add(relPath);
  }
  return [...paths].map((relPath) => ({ relPath, requirement }));
}

function norm(s) {
  return String(s || '').toLowerCase();
}

function pickDocTypes(text) {
  const t = norm(text);
  const found = [];
  for (const h of DOC_HINTS) {
    if (h.words.some((w) => t.includes(w))) found.push(h.type);
  }
  return [...new Set(found)];
}

function stageForDocuments(docTypes) {
  return STAGE_ORDER.findLast((stage) => docTypes.some((type) => DOC_TYPES[type].stage === stage));
}

function riskOf(text, severity) {
  const t = norm(text);
  if (HIGH_RISK.some((w) => t.includes(norm(w)))) return 'high';
  if (MID_RISK.some((w) => t.includes(norm(w)))) return 'medium';
  return severity === 'high' ? 'high' : severity === 'medium' ? 'medium' : 'low';
}

function titleOf(text) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  return line.length > 42 ? line.slice(0, 41) + '…' : line || '（无标题）';
}

/**
 * @returns {{taskType,stage,gateTarget,docTypes,severity,riskLevel,title,reason,ruleId,confidence,missing?,codeTargets?}}
 */
export function assess({ text, policyRules = [], defaultStage = 'S1' }) {
  const t = norm(text);
  const codeTargets = pickCodeTargets(String(text ?? ''));
  const qualityReport = QUALITY_REPORT.test(t);
  const severityOverride = new Map(
    (policyRules ?? [])
      .filter((r) => r?.match?.taskType)
      .map((r) => [r.match.taskType, r.defaultSeverity])
  );

  for (const rule of RULES) {
    const isCode = rule.taskType === 'code-change';
    const keywordHit = rule.keywords.some((k) => t.includes(norm(k)));
    const hit = isCode
      ? !qualityReport && (keywordHit || FIRMWARE_ACTION.test(t) || (codeTargets.length > 0 && CHANGE_ACTION.test(t)))
      : keywordHit || (rule.taskType === 'quality-8d' && qualityReport);
    if (!hit) continue;

    if (isCode && !codeTargets.length) {
      return {
        taskType: 'clarify', stage: null, gateTarget: null, docTypes: [], severity: 'low',
        riskLevel: 'low', title: titleOf(text), ruleId: rule.id, confidence: 'low',
        reason: '需要明确要改动的固件应用层文件',
        missing: ['要修改哪些应用层 .c 或 .h 文件？请提供相对路径，例如 firmware/app/main.c。'],
      };
    }

    const plan = planFor(rule.taskType, defaultStage);
    const severity = severityOverride.get(rule.taskType) ?? plan.defaultSeverity ?? 'medium';
    let docTypes = [...plan.docTypes];
    let stage = plan.stage ?? defaultStage;

    if (rule.taskType === 'doc') {
      docTypes = pickDocTypes(text);
      if (!docTypes.length) {
        return {
          taskType: 'clarify', stage: null, gateTarget: null, docTypes: [], severity: 'low',
          riskLevel: 'low', title: titleOf(text), ruleId: rule.id, confidence: 'low',
          reason: '看起来是文档任务，但没识别出具体文档类型',
          missing: ['要补哪份文档？可选项：' + Object.keys(DOC_TYPES).join(' / ')],
        };
      }
      stage = stageForDocuments(docTypes);
    }

    return {
      taskType: rule.taskType,
      stage,
      gateTarget: rule.taskType === 'doc' ? null : plan.gateTarget,
      docTypes,
      severity,
      riskLevel: riskOf(text, severity),
      title: titleOf(text),
      reason: rule.reason,
      ruleId: rule.id,
      confidence: 'medium',
      ...(isCode ? { codeTargets } : {}),
    };
  }

  // 兜底：先看是否提到了明确文档类型，能给一个"补齐"任务也算有用产出
  const hinted = pickDocTypes(text);
  if (hinted.length) {
    return {
      taskType: 'doc',
      stage: stageForDocuments(hinted),
      gateTarget: null,
      docTypes: hinted,
      severity: 'low',
      riskLevel: 'low',
      title: titleOf(text),
      reason: '未命中流程规则，但识别到文档类型 → 按文档补齐处理',
      ruleId: 'fallback-doc',
      confidence: 'low',
    };
  }

  return {
    taskType: 'clarify',
    stage: null,
    gateTarget: null,
    docTypes: [],
    severity: 'low',
    riskLevel: 'low',
    title: titleOf(text),
    reason: '未能判定任务类型，需要人指定',
    ruleId: 'fallback-clarify',
    confidence: 'low',
    missing: ['这是新项目立项、设计变更、过程变更、质量问题，还是要补某份文档？'],
  };
}

/** 生成一句结构化的澄清问题（一次只问一个，避免注意力过载） */
export function clarifyQuestion(assessment) {
  const q = assessment?.missing?.[0] ?? '这条请求需要你补充一句：要做哪类工作？';
  return `我还不能开工，需要确认一点：${q}`;
}

export { TASK_PLANS };
