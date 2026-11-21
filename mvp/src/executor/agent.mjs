// 让模型真正干活：把工单输入交给"岗位"，由它把文档里能从输入确定的部分填上。
//
// 三条护栏（比"生成得漂亮"更重要）：
//   1. 只允许填已有章节，不允许新增/删除章节、不允许改 front-matter 的 id/status
//   2. 输入里没有的数值必须留「待确认」；事后扫描"凭空出现的数字"并标注待核实
//   3. 模型不可用、超预算、返回非法 JSON —— 一律退回骨架，绝不假装成功

import { parseFrontMatter, renderFrontMatter } from '../domain/templates.mjs';

export function extractHeadings(markdown) {
  const body = parseFrontMatter(markdown).body;
  return body
    .split('\n')
    .map((l) => /^##\s+(.+?)\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1]);
}

function normalizeHeading(h) {
  return String(h ?? '').trim()
    .replace(/^\d+(\.\d+)*[.、)]?\s*/, '')       // "1. 问题描述" → "问题描述"
    .replace(/^[A-Z]{1,3}\d{1,3}[.、)]?\s+/i, '') // "D2 描述问题" → "描述问题"
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** 标题匹配：先精确（规范化后），再唯一包含；多个候选时不猜 */
export function matchHeading(allowed, wanted) {
  const nw = normalizeHeading(wanted);
  if (!nw) return null;
  const exact = allowed.find((h) => normalizeHeading(h) === nw);
  if (exact) return exact;
  const cands = allowed.filter((h) => {
    const nh = normalizeHeading(h);
    return nh.includes(nw) || nw.includes(nh);
  });
  return cands.length === 1 ? cands[0] : null;
}

export function extractJson(text) {
  const s = String(text ?? '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const candidate = fenced ? fenced[1] : s;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

const numbersIn = (text) => new Set((String(text ?? '').match(/\d+(?:\.\d+)?/g) ?? []));

/** 把某一章节正文替换掉，保留其余结构。先按原样匹配，再退回规范化匹配 */
export function replaceSection(markdown, heading, content) {
  const lines = String(markdown).split('\n');
  const headOf = (l) => {
    const m = /^##\s+(.+?)\s*$/.exec(l);
    return m ? m[1] : null;
  };
  let idx = lines.findIndex((l) => headOf(l) === String(heading).trim());
  if (idx === -1) {
    idx = lines.findIndex((l) => {
      const h = headOf(l);
      return h && normalizeHeading(h) === normalizeHeading(heading);
    });
  }
  if (idx === -1) return null;

  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^#{1,2}\s+/.test(lines[i])) { end = i; break; }
  }
  const block = ['', String(content).trim(), ''];
  return [...lines.slice(0, idx + 1), ...block, ...lines.slice(end)].join('\n');
}

/** 在 front-matter 里补 AI 参与痕迹，供评审识别 */
export function markAiAssisted(markdown, { position, model, aiAssisted }) {
  const { data, body } = parseFrontMatter(markdown);
  if (!data) return markdown;
  const merged = {
    ...data,
    preparedBy: position ? `${position.code} ${position.name}` : data.preparedBy,
    aiAssisted: !!aiAssisted,
    aiModel: model ?? null,
  };
  return `${renderFrontMatter(merged)}\n${body.replace(/^\n/, '')}`;
}

function buildPrompt({ position, doc, ticket, inputText, headings }) {
  return [
    `# 任务`,
    `你在为汽车电子项目 ${ticket.project ?? ''} 编写《${doc.docType}》文档的正文。`,
    `文档当前是骨架，章节标题如下（只能填这些章节，不得新增或改名）：`,
    ...headings.map((h) => `- ${h}`),
    ``,
    `# 工单输入（唯一事实来源）`,
    inputText?.trim() || ticket.title,
    ``,
    `# 输出要求`,
    `只输出一个 JSON 对象，不要解释、不要 Markdown 代码块之外的文字：`,
    `{"sections":[{"heading":"章节标题（与上面完全一致）","content":"该章节正文（Markdown）"}],"openQuestions":["需要人确认的问题"]}`,
    ``,
    `规则：`,
    `1. 只写工单输入能支撑的内容；输入没有的事实不要补。`,
    `2. 任何数值、型号、客户名、日期若未在输入中出现，一律写「待确认」。`,
    `3. 不要输出 front-matter，不要输出一级标题，不要写"本文档描述了…"这类空话。`,
    `4. 不确定的地方宁可少写，并把问题放进 openQuestions（最多 5 条）。`,
    `5. 单节正文不超过 600 字；没有可写内容的章节不要出现在 sections 里。`,
  ].join('\n');
}

/**
 * 用岗位对应的模型池填充一份文档。
 * @returns {{skipped?:boolean, reason?:string, text?:string, applied?:string[],
 *            openQuestions?:string[], model?:string, keyId?:string, pool?:string, tokens?:number}}
 */
export async function fillDocument({
  doc, ticket, position, pool, budget = {}, engine, inputText = '',
}) {
  if (!position) return { skipped: true, reason: '该文档类型没有对应岗位' };
  if (!pool) return { skipped: true, reason: '未配置模型池' };

  const limit = Number(budget.tokensPerTicket ?? 0);
  if (limit > 0 && engine) {
    const spent = engine.tokensForTicket(ticket.id);
    if (spent >= limit) {
      return { skipped: true, reason: `工单 token 预算已用尽（${spent}/${limit}），保留骨架待人工填写` };
    }
  }

  const headings = extractHeadings(doc.text);
  if (!headings.length) return { skipped: true, reason: '文档没有可填章节' };

  const prompt = buildPrompt({ position, doc, ticket, inputText, headings });
  let res;
  try {
    res = await pool.generate({ pool: position.pool, purpose: `fill:${doc.docType}`, prompt, system: position.systemPrompt });
  } catch (err) {
    return { skipped: true, reason: `模型调用失败：${err.message}` };
  }
  if (!res?.text) return { skipped: true, reason: res?.reason ?? '模型未返回内容' };

  const data = extractJson(res.text);
  if (!data || !Array.isArray(data.sections)) {
    return { skipped: true, reason: '模型返回的不是约定 JSON，已丢弃', model: res.model, keyId: res.keyId, tokens: res.usage?.tokens ?? 0 };
  }

  // 只接受已存在章节；标题模糊匹配（模型常把"D2 描述问题"写成"问题描述"）
  const baseline = numbersIn(`${inputText}\n${doc.text}`);
  const openQuestions = Array.isArray(data.openQuestions) ? data.openQuestions.filter((q) => typeof q === 'string').slice(0, 5) : [];

  let text = doc.text;
  const applied = [];
  const tried = [];
  for (const section of data.sections.slice(0, 30)) {
    const wanted = section?.heading;
    if (wanted) tried.push(String(wanted).slice(0, 20));
    const target = matchHeading(headings, wanted);
    const content = String(section?.content ?? '').trim();
    if (!target || !content) continue;
    const next = replaceSection(text, target, content);
    if (!next) continue;

    // 数值护栏：生成文本里出现、但输入与骨架里都没有的数字 → 标注待核实
    const invented = [...numbersIn(content)].filter((n) => !baseline.has(n));
    let finalContent = content;
    if (invented.length) {
      const list = invented.slice(0, 5).join('、');
      finalContent = `${content}\n\n> ⚠ 待核实：本节出现输入中未提供的数值（${list}），请责任人确认来源。`;
      openQuestions.push(`《${target}》中的数值 ${list} 无输入依据，需确认`);
    }
    const replaced = replaceSection(text, target, finalContent);
    text = replaced ?? next;
    applied.push(target);
  }

  if (!applied.length) {
    return {
      skipped: true,
      reason: `模型给出的章节名与文档不匹配（试过：${tried.slice(0, 3).join('、') || '无'}）`,
      model: res.model, keyId: res.keyId, tokens: res.usage?.tokens ?? 0,
    };
  }

  text = markAiAssisted(text, { position, model: res.model, aiAssisted: true });
  return {
    text, applied, openQuestions,
    model: res.model, keyId: res.keyId, pool: res.pool,
    tokens: res.usage?.tokens ?? 0,
  };
}
