// APQP 阶段、文档类型、门禁与任务计划的唯一数据源。
// 路由、文档生成、门禁检查、面板展示都从这里取，避免四处散落的字符串常量漂移。

export const STAGES = {
  S1: { code: 'S1', name: '策划', dir: 'docs/S1-策划' },
  S2: { code: 'S2', name: '产品设计', dir: 'docs/S2-产品设计' },
  S3: { code: 'S3', name: '过程设计', dir: 'docs/S3-过程设计' },
  S4: { code: 'S4', name: '验证', dir: 'docs/S4-验证' },
  S5: { code: 'S5', name: '量产', dir: 'docs/S5-量产' },
};

export const STAGE_ORDER = ['S1', 'S2', 'S3', 'S4', 'S5'];

export const DOC_TYPES = {
  CHTR:  { name: '项目章程',      stage: 'S1', template: '01-项目章程.md',   owner: '项目负责人' },
  SRS:   { name: '需求规格书',    stage: 'S1', template: '02-需求规格书.md', owner: '系统工程师' },
  APQP:  { name: 'APQP 项目计划', stage: 'S1', template: '03-APQP项目计划.md', owner: '项目负责人' },
  FEAS:  { name: '可行性分析',    stage: 'S1', template: '04-可行性分析.md', owner: '跨职能小组' },
  DFMEA: { name: 'DFMEA',         stage: 'S2', template: '05-DFMEA.md',      owner: '设计工程师' },
  DVP:   { name: '设计验证计划',  stage: 'S2', template: '06-设计验证计划.md', owner: '测试工程师' },
  SC:    { name: '特殊特性清单',  stage: 'S2', template: '07-特殊特性清单.md', owner: '设计质量' },
  PFC:   { name: '过程流程图',    stage: 'S3', template: '08-过程流程图.md', owner: '工艺工程师' },
  PFMEA: { name: 'PFMEA',         stage: 'S3', template: '09-PFMEA.md',      owner: '工艺质量' },
  CP:    { name: '控制计划',      stage: 'S3', template: '10-控制计划.md',   owner: '质量工程师' },
  MSA:   { name: 'MSA 报告',      stage: 'S4', template: '11-MSA报告.md',    owner: '质量工程师' },
  SPC:   { name: '过程能力报告',  stage: 'S4', template: '12-过程能力报告.md', owner: '质量工程师' },
  TR:    { name: '试产报告',      stage: 'S4', template: '13-试产报告.md',   owner: '工艺质量' },
  PPAP:  { name: 'PPAP 提交清单', stage: 'S4', template: '14-PPAP提交清单.md', owner: '质量工程师' },
  TEST:  { name: '测试报告',      stage: 'S4', template: '17-测试报告.md',   owner: '测试工程师' },
  '8D':  { name: '8D 报告',       stage: 'S5', template: '15-8D报告.md',     owner: '质量工程师' },
  ECN:   { name: 'ECN 变更通知',  stage: 'S5', template: '16-ECN变更通知.md', owner: '变更委员会' },
};

export const DOC_TYPE_ORDER = Object.keys(DOC_TYPES);

// 门禁：deliverables 是齐套要求；checks 是自动检查项 ID（实现在 domain/gate.mjs）
export const GATES = {
  G1: {
    id: 'G1', name: '立项批准', stage: 'S1',
    deliverables: ['CHTR', 'SRS', 'APQP', 'FEAS'],
    checks: ['all_deliverables_present', 'docs_structurally_valid', 'risks_registered'],
  },
  G2: {
    id: 'G2', name: '设计冻结', stage: 'S2',
    deliverables: ['DFMEA', 'DVP', 'SC'],
    checks: ['all_deliverables_present', 'docs_structurally_valid', 'dfmea_high_ap_has_action', 'dvp_covers_all_special_characteristics'],
  },
  G3: {
    id: 'G3', name: '过程就绪', stage: 'S3',
    deliverables: ['PFC', 'PFMEA', 'CP'],
    checks: ['all_deliverables_present', 'docs_structurally_valid', 'pfc_pfmea_step_match', 'cp_covers_all_special_characteristics'],
  },
  G4: {
    id: 'G4', name: 'PPAP 批准', stage: 'S4',
    deliverables: ['MSA', 'SPC', 'TR', 'PPAP'],
    checks: ['all_deliverables_present', 'docs_structurally_valid', 'ppap_18_items_complete'],
  },
  G5: {
    id: 'G5', name: '量产监控', stage: 'S5',
    deliverables: [],
    checks: [],
  },
};

/**
 * 任务计划：taskType → 起始阶段、目标门禁、交付物、分支前缀。
 * branchPrefix 与 docs/06 §4 的受保护分支规则一致：
 * 执行器只能推 agent/ change/ fix/ 前缀，永远不碰 main/develop/release/*。
 */
export const TASK_PLANS = {
  'project-init': {
    stage: 'S1', gateTarget: 'G1', docTypes: ['CHTR', 'SRS', 'APQP', 'FEAS'],
    branchPrefix: 'agent/', commitPrefix: 'feat', defaultSeverity: 'medium',
  },
  'design-change': {
    // G2 齐套要求 DFMEA/DVP/SC；SC 必须随设计变更产出，否则门禁永远停在 preparing
    stage: 'S2', gateTarget: 'G2', docTypes: ['ECN', 'DFMEA', 'DVP', 'SC'],
    branchPrefix: 'change/', commitPrefix: 'change', defaultSeverity: 'medium',
  },
  'process-change': {
    // G3 齐套要求 PFC/PFMEA/CP；同理 PFC 不可缺
    stage: 'S3', gateTarget: 'G3', docTypes: ['ECN', 'PFMEA', 'CP', 'PFC'],
    branchPrefix: 'change/', commitPrefix: 'change', defaultSeverity: 'medium',
  },
  'quality-8d': {
    stage: 'S5', gateTarget: null, docTypes: ['8D'],
    branchPrefix: 'fix/', commitPrefix: 'fix', defaultSeverity: 'high',
  },
  test: {
    stage: 'S4', gateTarget: null, docTypes: ['TEST'],
    branchPrefix: 'agent/', commitPrefix: 'test', defaultSeverity: 'medium',
  },
  doc: {
    stage: null, gateTarget: null, docTypes: [],
    branchPrefix: 'agent/', commitPrefix: 'docs', defaultSeverity: 'low',
  },
  clarify: {
    stage: null, gateTarget: null, docTypes: [],
    branchPrefix: null, commitPrefix: null, defaultSeverity: 'low',
  },
};

export function stageDir(stage) {
  return STAGES[stage]?.dir ?? 'docs/_unclassified';
}

export function docDir(docType) {
  const t = DOC_TYPES[docType];
  if (!t) return 'docs/_unclassified';
  return `${stageDir(t.stage)}/${docType}`;
}

export function gateForStage(stage) {
  const order = { S1: 'G1', S2: 'G2', S3: 'G3', S4: 'G4', S5: 'G5' };
  return order[stage] ?? null;
}

export function docTypeName(code) {
  return DOC_TYPES[code]?.name ?? code;
}

/** 任务计划；doc 类型需要按关键词细化，交由 router 填充 docTypes */
export function planFor(taskType, stage) {
  const plan = TASK_PLANS[taskType] ?? TASK_PLANS.clarify;
  return { ...plan, stage: plan.stage ?? stage ?? null };
}
