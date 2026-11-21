// 模板即契约（docs/01 §2）：
//   - front-matter 必填键缺失 = 结构校验失败，不允许"看起来齐全"
//   - 文档 id 必须与所在阶段目录、类型目录自洽
//   - "⚠ 待补充" 数量有上限，超过即拒绝进入评审

import { parseYaml } from '../util/yaml.mjs';
import { DOC_TYPES, STAGES } from '../domain/stages.mjs';

export const REQUIRED_KEYS = [
  'id', 'title', 'project', 'stage', 'type', 'revision',
  'status', 'classification', 'owner', 'created', 'updated', 'traceability',
];

export function parseFrontMatter(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!s.startsWith('---\n')) return { data: null, body: s, hasFrontMatter: false };
  const end = s.indexOf('\n---', 4);
  if (end === -1) return { data: null, body: s, hasFrontMatter: false };
  const fmText = s.slice(4, end);
  const after = s.indexOf('\n', end + 4);
  const body = after === -1 ? '' : s.slice(after + 1);
  let data = null;
  try { data = parseYaml(fmText, { file: 'front-matter' }); } catch { data = null; }
  return { data, body, hasFrontMatter: true };
}

function scalarOut(v) {
  if (v === null || v === undefined) return '""';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (s === '') return '""';
  if (/^[A-Za-z0-9_./@+-]+$/.test(s) && !/^(true|false|null)$/.test(s)) return s;
  return JSON.stringify(s);
}

export function stringifyYaml(obj, indent = 0) {
  const pad = ' '.repeat(indent);
  const lines = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (Array.isArray(v)) {
      if (!v.length) lines.push(`${pad}${k}: []`);
      else if (v.every((x) => x === null || typeof x !== 'object')) {
        lines.push(`${pad}${k}: [${v.map(scalarOut).join(', ')}]`);
      } else {
        lines.push(`${pad}${k}:`);
        for (const item of v) {
          if (item && typeof item === 'object') {
            const sub = stringifyYaml(item, indent + 4).split('\n');
            lines.push(`${pad}  - ${sub[0].trim()}`);
            lines.push(...sub.slice(1));
          } else lines.push(`${pad}  - ${scalarOut(item)}`);
        }
      }
    } else if (v && typeof v === 'object') {
      lines.push(`${pad}${k}:`);
      lines.push(stringifyYaml(v, indent + 2));
    } else {
      lines.push(`${pad}${k}: ${scalarOut(v)}`);
    }
  }
  return lines.join('\n');
}

export function renderFrontMatter(data) {
  return `---\n${stringifyYaml(data)}\n---\n`;
}

const BODY_PLACEHOLDERS = [
  [/<项目代号>/g, 'project'],
  [/<项目名称>/g, 'name'],
  [/<客户>/g, 'customer'],
  [/<平台>/g, 'platform'],
  [/<YYYY-MM-DD>/g, 'date'],
  [/<问题简述>/g, 'title'],
];

/**
 * 由模板生成一份草稿。
 * 只填"能从上下文确定"的字段；技术结论一律保留 `<...>`，不编造（docs/00 §6.3）。
 */
export function buildDoc({ templateText, ctx }) {
  const { data, body } = parseFrontMatter(templateText);
  const base = data ?? {};
  const typeName = DOC_TYPES[ctx.type]?.name ?? ctx.type;
  // 工单标题里已经点了文档类型时不再重复拼接，避免"…请开 8D 8D 报告"
  const alreadyNamed = String(ctx.title).includes(typeName)
    || String(ctx.title).toUpperCase().includes(String(ctx.type).toUpperCase());
  const docTitle = alreadyNamed ? ctx.title : `${ctx.title} ${typeName}`;
  const fm = {
    id: ctx.id,
    title: docTitle,
    project: ctx.project,
    stage: ctx.stage,
    type: ctx.type,
    revision: ctx.revision ?? 'v0.1',
    status: 'draft',
    classification: ctx.classification ?? 'internal',
    owner: ctx.owner ?? DOC_TYPES[ctx.type]?.owner ?? '待指派',
    reviewers: [],
    created: ctx.date,
    updated: ctx.date,
    ticket: ctx.ticket,
    related: base.related ?? { requirements: [] },
    traceability: {
      upstream: ctx.upstream ?? base.traceability?.upstream ?? [],
      downstream: ctx.downstream ?? base.traceability?.downstream ?? [],
    },
  };

  let outBody = body;
  const values = {
    project: ctx.project,
    name: ctx.name ?? ctx.project,
    customer: ctx.customer ?? '-',
    platform: ctx.platform ?? '-',
    date: ctx.date,
    title: docTitle,
  };
  for (const [re, key] of BODY_PLACEHOLDERS) outBody = outBody.replace(re, values[key]);

  // 模板正文常写成 "# <问题简述> 8D 报告"：标题里已经带类型时，去掉重复的那一段
  if (alreadyNamed) {
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    outBody = outBody.replace(new RegExp(`\\b${esc(ctx.type)}\\s+${esc(typeName)}`, 'gi'), typeName);
  }

  const note = [
    '',
    '---',
    '',
    `<!-- 由 electronics-superagent 生成：${ctx.ticket} / ${ctx.id}`,
    `     生成时间 ${ctx.date}；正文中的 <...> 与「⚠ 待补充」需责任人填写后走复核。`,
    '     系统不代填技术结论：无法从上下文确定的项一律留空，避免"看起来齐全、实则空洞"。 -->',
    '',
  ].join('\n');

  return { text: `${renderFrontMatter(fm)}\n${outBody.replace(/\s*$/, '')}\n${note}`, data: fm, body: outBody };
}

function isPlaceholderLine(line) {
  const t = line.trim();
  if (!t) return true;
  if (/^[-|: ]+$/.test(t)) return true;
  if (t.includes('⚠ 待补充')) return true;
  // 表格行里所有单元格都是占位（含表头分隔行 ---）
  if (t.startsWith('|')) {
    const cells = t.split('|').slice(1, -1).map((c) => c.trim());
    return cells.every((c) => c === '' || /^<.*>$/.test(c) || c === '-' || /^:?-{2,}:?$/.test(c));
  }
  return /^<.*>$/.test(t);
}

/**
 * 章节填充率：有实质内容的二级章节占比。
 * 表格要单独看——模板里大量章节是表格，如果只数"有没有非占位行"，
 * 一个只有表头、正文全是 <...> 的表格会被算成已填写，填充率就失去意义。
 */
function substantiveCount(lines) {
  let n = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\|/.test(line)) {
      const block = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { block.push(lines[i]); i++; }
      const body = block.slice(2); // 表头 + 分隔行之外的正文行
      if (body.some((l) => !isPlaceholderLine(l))) n++;
      continue;
    }
    if (!isPlaceholderLine(line) && !/^#{1,6}\s/.test(line)) n++;
    i++;
  }
  return n;
}

/**
 * 章节填充率：真正"写完"的二级章节占比。
 * 判定标准不是"有没有字"，而是"还有没有待填的 <...> 占位"——
 * 模板自带大量说明性文字，只看字数会让每份草稿都显示 100% 填充，指标就废了。
 */
function isFilledSection(content) {
  const text = content.join('\n');
  if (/<[^<>\n]{1,40}>/.test(text)) return false;   // 仍有占位符
  if (/⚠\s*待补充/.test(text)) return false;
  return substantiveCount(content) > 0;
}

export function fillStats(body) {
  const lines = String(body).split('\n');
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const m = /^##\s+(.+)$/.exec(line);
    if (m) {
      cur = { title: m[1].trim(), content: [] };
      sections.push(cur);
    } else if (cur) cur.content.push(line);
  }
  const filled = sections.filter((s) => isFilledSection(s.content));
  return {
    sections: sections.length,
    filled: filled.length,
    fillRatio: sections.length ? Number((filled.length / sections.length).toFixed(2)) : 0,
  };
}

export function countTodo(text) {
  return (String(text).match(/⚠\s*待补充/g) ?? []).length;
}

/**
 * 结构校验：机械可判的部分。内容质量不在此列——那由人评审。
 */
export function validateDoc({ text, relPath, expect = {}, rules = {} }) {
  const errors = [];
  const warnings = [];
  const { data, body, hasFrontMatter } = parseFrontMatter(text);

  if (!hasFrontMatter) {
    return { ok: false, errors: ['缺少 front-matter'], warnings, stats: { fillRatio: 0, todoCount: 0, sections: 0 } };
  }
  if (!data || typeof data !== 'object') {
    return { ok: false, errors: ['front-matter 无法解析为映射'], warnings, stats: { fillRatio: 0, todoCount: 0, sections: 0 } };
  }

  for (const k of REQUIRED_KEYS) {
    const v = data[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && k === 'traceability' && !v.length && false)) {
      errors.push(`front-matter 缺少必填键：${k}`);
    }
  }
  if (data.traceability && (typeof data.traceability !== 'object' || Array.isArray(data.traceability))) {
    errors.push('front-matter.traceability 必须是映射（upstream/downstream）');
  }

  const id = String(data.id ?? '');
  const idMatch = /^DOC-(S[1-5])-([A-Z0-9]{2,6})-(\d{3})$/.exec(id);
  if (!idMatch) {
    errors.push(`id 不合规：${id || '(空)'}（应为 DOC-<S1..S5>-<TYPE>-<3位数字>）`);
  } else {
    const [, idStage, idType] = idMatch;
    if (expect.stage && idStage !== expect.stage) errors.push(`id 阶段 ${idStage} 与文档阶段 ${expect.stage} 不一致`);
    if (expect.type && idType !== expect.type) errors.push(`id 类型 ${idType} 与文档类型 ${expect.type} 不一致`);
    if (relPath && !relPath.includes(`/${expect.type}/`) && expect.type) {
      errors.push(`路径 ${relPath} 不在类型目录 ${expect.type}/ 下`);
    }
    if (expect.stage && STAGES[expect.stage] && relPath && !relPath.startsWith(`${STAGES[expect.stage].dir}/`)) {
      errors.push(`路径 ${relPath} 不在阶段目录 ${STAGES[expect.stage].dir}/ 下`);
    }
  }

  if (data.stage && !STAGES[data.stage]) errors.push(`stage 非法：${data.stage}`);
  if (expect.type && data.type !== expect.type) errors.push(`front-matter.type=${data.type} 与预期 ${expect.type} 不一致`);
  if (expect.project && data.project !== expect.project) errors.push(`project=${data.project} 与项目代号 ${expect.project} 不一致`);
  if (data.revision && !/^v\d+\.\d+$/.test(String(data.revision))) errors.push(`revision 格式非法：${data.revision}`);
  if (data.status && !['draft', 'review', 'released', 'obsolete'].includes(String(data.status))) {
    errors.push(`status 非法：${data.status}`);
  }

  const todo = countTodo(text);
  const limit = Number(rules.maxTodoMarkers ?? 5);
  if (todo > limit) errors.push(`「⚠ 待补充」共 ${todo} 处，超过上限 ${limit}`);

  const stats = fillStats(body);
  if (stats.sections < 2) errors.push(`正文二级章节过少（${stats.sections}），疑似模板未展开`);

  const minFill = Number(rules.minSectionsFilled ?? 0.8);
  if (stats.fillRatio < minFill) {
    warnings.push(`章节填充率 ${(stats.fillRatio * 100).toFixed(0)}% 低于要求 ${(minFill * 100).toFixed(0)}%（草稿阶段允许，签署前应补齐）`);
  }

  return { ok: errors.length === 0, errors, warnings, stats: { ...stats, todoCount: todo }, data };
}

export { isPlaceholderLine };
