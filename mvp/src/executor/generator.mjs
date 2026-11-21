// 文档生成：读模板 → 填 front-matter 与可确定的正文占位 → 落盘 → 结构校验。
// 刻意不做的事：不填技术结论、不虚构数据、不自动把 status 升到 review。

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { DOC_TYPES, docDir, STAGES } from '../domain/stages.mjs';
import { docId } from '../util/ids.mjs';
import { buildDoc, validateDoc } from '../domain/templates.mjs';
import { ensureDir, exists, sha256Text, toPosix, rel } from '../util/fsx.mjs';

/** 模板来源：优先项目内 docs/_templates（项目可定制），回退到方案包 templates/ */
export async function resolveTemplate(project, docType, fallbackDir = null) {
  const t = DOC_TYPES[docType];
  if (!t) throw new Error(`未知文档类型：${docType}`);
  const candidates = [
    path.join(project.paths.templates, t.template),
    fallbackDir ? path.join(fallbackDir, t.template) : null,
  ].filter(Boolean);
  for (const c of candidates) {
    if (await exists(c)) return c;
  }
  throw new Error(`模板缺失：${t.template}（已查找 ${candidates.join(' / ')}）`);
}

/**
 * @returns {{id,docType,stage,relPath,absPath,text,validation,revision}}
 */
export async function generateDoc({
  project, docType, ctx, rules = {}, nextDocIndex, fallbackTemplateDir = null,
}) {
  const meta = DOC_TYPES[docType];
  if (!meta) throw new Error(`未知文档类型：${docType}`);

  const stage = meta.stage;
  if (!(project.manifest.stages?.enabled ?? []).includes(stage)) {
    throw new Error(`阶段 ${stage} 未在 manifest.stages.enabled 中启用，不能在该阶段产出文档`);
  }

  const templateFile = await resolveTemplate(project, docType, fallbackTemplateDir);
  const templateText = await fs.readFile(templateFile, 'utf8');

  const seq = nextDocIndex(stage, docType);
  const id = docId(stage, docType, seq);
  const dirRel = docDir(docType);
  const relPath = `${dirRel}/${id}-${docType}.md`;
  const absPath = path.join(project.root, relPath);

  const { text, data } = buildDoc({
    templateText,
    ctx: {
      ...ctx, id, stage, type: docType,
      project: project.manifest.code,
      classification: project.manifest.system?.defaultClassification ?? 'internal',
    },
  });

  await ensureDir(path.dirname(absPath));
  await fs.writeFile(absPath, text, 'utf8');

  const validation = validateDoc({
    text, relPath, rules,
    expect: { stage, type: docType, project: project.manifest.code },
  });

  return {
    id, docType, stage, relPath, absPath,
    revision: data.revision ?? 'v0.1',
    title: data.title,
    text,
    sha256: sha256Text(text),
    validation,
  };
}

/** 在 documents.csv 追加/更新一行（追溯索引的事实来源） */
export async function upsertDocumentIndex({ project, row }) {
  const file = path.join(project.paths.index, 'documents.csv');
  const { readCsvObjects, toCsv } = await import('../util/csv.mjs');
  const desired = ['id', 'title', 'project', 'stage', 'type', 'revision', 'status', 'classification', 'owner', 'path', 'ticket', 'updated'];
  let header;
  let rows;
  const text = (await exists(file)) ? await fs.readFile(file, 'utf8') : '';
  if (text.trim()) {
    const parsed = readCsvObjects(text);
    header = parsed.header;
    rows = parsed.rows;
    // 骨架表头可能比运行时需要的少：补齐列而不是丢字段（丢字段等于断掉追溯）
    const missing = desired.filter((k) => !header.includes(k));
    if (missing.length) header = [...header, ...missing];
  } else {
    header = desired;
    rows = [];
  }
  const idx = rows.findIndex((r) => r.id === row.id);
  if (idx >= 0) rows[idx] = { ...rows[idx], ...row };
  else rows.push(row);
  await ensureDir(project.paths.index);
  await fs.writeFile(file, toCsv([header, ...rows.map((r) => header.map((h) => r[h] ?? ''))]), 'utf8');
  return rows.length;
}

/**
 * 追溯边：写 trace-edges.csv（有向边表）。
 * 宽表 traceability.csv 保留给"需求→…→代码"的矩阵视图，两者不是一回事：
 * 边表便于机器反查影响面，宽表便于审核时一眼看全链路。
 */
export async function appendTraceability({ project, edges }) {
  const file = path.join(project.paths.index, 'trace-edges.csv');
  const { readCsvObjects, toCsv } = await import('../util/csv.mjs');
  const text = (await exists(file)) ? await fs.readFile(file, 'utf8') : '';
  let header;
  let rows;
  if (text.trim()) {
    const parsed = readCsvObjects(text);
    header = parsed.header;
    rows = parsed.rows;
  } else {
    header = ['upstream_id', 'relation', 'downstream_id', 'note'];
    rows = [];
  }
  for (const e of edges) {
    if (!rows.some((r) => r.upstream_id === e.upstream && r.downstream_id === e.downstream)) {
      rows.push({ upstream_id: e.upstream, relation: e.relation ?? 'derives', downstream_id: e.downstream, note: e.note ?? '' });
    }
  }
  await ensureDir(project.paths.index);
  await fs.writeFile(file, toCsv([header, ...rows.map((r) => header.map((h) => r[h] ?? ''))]), 'utf8');
  return rows.length;
}

/** 相对仓库根的路径（用于面板与 PR 草案） */
export function toRepoRel(project, absPath) {
  return toPosix(rel(project.root, absPath));
}

export { STAGES };
