// 阶段门自动检查：机器只做"机械可判"的部分。
// 结构性问题（缺文件、结构不合规、工序对不上）阻断；内容质量（写得好不好）不阻断，
// 只作为证据交给签署人。这条界线如果模糊，系统就会变成"替人签字"。

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { GATES, STAGES, DOC_TYPES, docDir, docTypeName } from './stages.mjs';
import { exists, readFileSafe } from '../util/fsx.mjs';
import { parseFrontMatter, validateDoc } from './templates.mjs';

export function extractOps(text) {
  const set = new Set();
  for (const m of String(text).matchAll(/\bOP[-\s]?(\d{1,3})\b/gi)) set.add(`OP-${String(m[1]).padStart(2, '0')}`);
  return set;
}

export function extractSpecialCharacteristics(text) {
  const set = new Set();
  const s = String(text);
  for (const m of s.matchAll(/\b(?:[A-Z]{2,6}-)?(CC|SC)-(\d{1,3})\b/g)) {
    // 文档编号（DOC-S2-SC-001、生成页脚等）不是申报的特殊特性，不能计入覆盖性检查
    if (/DOC-[A-Z0-9-]*$/.test(s.slice(Math.max(0, m.index - 24), m.index))) continue;
    set.add(`${m[1]}-${String(m[2]).padStart(2, '0')}`);
  }
  return set;
}

/** 取某类型最新一份文档（按 id 末位流水最大者） */
export async function findLatestDoc(project, docType) {
  const dir = path.join(project.root, docDir(docType));
  if (!(await exists(dir))) return null;
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md') && f.startsWith(`DOC-${DOC_TYPES[docType].stage}-${docType}-`));
  if (!files.length) return null;
  files.sort((a, b) => {
    const na = Number((/-(\d{3})/.exec(a) ?? [0, 0])[1]);
    const nb = Number((/-(\d{3})/.exec(b) ?? [0, 0])[1]);
    return nb - na;
  });
  const abs = path.join(dir, files[0]);
  const text = await readFileSafe(abs, '');
  return {
    absPath: abs,
    relPath: `${docDir(docType)}/${files[0]}`,
    text,
    data: parseFrontMatter(text).data,
    body: parseFrontMatter(text).body,
  };
}

function sectionText(body, keyword) {
  const lines = String(body).split('\n');
  const out = [];
  let inside = false;
  for (const line of lines) {
    const m = /^(#{2,3})\s+(.+)$/.exec(line);
    if (m) {
      inside = m[2].includes(keyword);
      continue;
    }
    if (inside) out.push(line);
  }
  return out.join('\n');
}

function countTableRows(text) {
  return String(text).split('\n').filter((l) => {
    const t = l.trim();
    if (!t.startsWith('|')) return false;
    if (/^\|[\s|:-]+\|$/.test(t)) return false;
    if (/^\|\s*(项|序号|No|编号|#)\s*\|/i.test(t)) return false;
    return true;
  }).length;
}

/** DFMEA 中 AP=H 的行是否都有措施（无数据时视为通过并注明） */
function highApWithoutAction(body) {
  const rows = String(body).split('\n').filter((l) => l.trim().startsWith('|'));
  const bad = [];
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 8) continue;
    const hasH = cells.some((c) => c === 'H');
    if (!hasH) continue;
    const tail = cells.slice(-3);
    const hasAction = tail.some((c) => c && !/^<.*>$/.test(c) && c !== '-' && !c.includes('待补充'));
    if (!hasAction) bad.push(row.trim().slice(0, 80));
  }
  return bad;
}

/**
 * 跑一个门禁的全部自动检查。
 * @returns {{id,name,stage,status:'preparing'|'pending',checks:Array,evidence:object}}
 */
export async function runGateChecks({ gateId, project, rules = {} }) {
  const gate = GATES[gateId];
  if (!gate) throw new Error(`未知门禁：${gateId}`);
  const checks = [];
  const evidence = { docs: {} };

  const docs = {};
  for (const t of gate.deliverables) {
    docs[t] = await findLatestDoc(project, t);
    evidence.docs[t] = docs[t] ? docs[t].relPath : null;
  }
  // 覆盖性检查要读特殊特性清单，而它属于上一阶段的交付物
  for (const extra of ['SC']) {
    if (!docs[extra]) docs[extra] = await findLatestDoc(project, extra);
  }

  const validations = {};
  for (const [t, d] of Object.entries(docs)) {
    if (!d) continue;
    validations[t] = validateDoc({
      text: d.text, relPath: d.relPath, rules,
      expect: { stage: DOC_TYPES[t].stage, type: t, project: project.manifest.code },
    });
  }

  for (const checkId of gate.checks) {
    switch (checkId) {
      case 'all_deliverables_present': {
        const missing = gate.deliverables.filter((t) => !docs[t]);
        checks.push({
          id: checkId,
          ok: missing.length === 0,
          detail: missing.length
            ? `缺少交付物：${missing.map((t) => `${t}(${docTypeName(t)})`).join('、')}`
            : `${gate.deliverables.length} 份交付物齐套`,
        });
        break;
      }
      case 'docs_structurally_valid': {
        const bad = Object.entries(validations).filter(([, v]) => !v.ok);
        checks.push({
          id: checkId,
          ok: bad.length === 0,
          detail: bad.length ? bad.map(([t, v]) => `${t}: ${v.errors.join('；')}`).join(' ｜ ') : '全部通过结构校验',
        });
        break;
      }
      case 'risks_registered': {
        const anyRisk = Object.values(docs).some((d) => d && /风险/.test(d.body));
        checks.push({
          id: checkId,
          ok: anyRisk,
          detail: anyRisk ? '已建立风险章节（内容由责任人补充）' : '四份策划文档均未见风险章节',
        });
        break;
      }
      case 'dfmea_high_ap_has_action': {
        const d = docs.DFMEA;
        if (!d) { checks.push({ id: checkId, ok: false, detail: '缺少 DFMEA' }); break; }
        const bad = highApWithoutAction(d.body);
        checks.push({
          id: checkId,
          ok: bad.length === 0,
          detail: bad.length ? `AP=H 且无措施的行 ${bad.length} 条：${bad[0]}` : 'AP=H 行均有对应措施（或尚未识别到高风险行）',
          skipped: !/\bH\b/.test(d.body),
        });
        break;
      }
      case 'pfc_pfmea_step_match': {
        const pfc = docs.PFC; const pfmea = docs.PFMEA;
        if (!pfc || !pfmea) { checks.push({ id: checkId, ok: false, detail: '缺少过程流程图或 PFMEA' }); break; }
        const a = extractOps(pfc.body); const b = extractOps(pfmea.body);
        const onlyPfc = [...a].filter((x) => !b.has(x));
        const onlyPfmea = [...b].filter((x) => !a.has(x));
        const empty = a.size === 0 && b.size === 0;
        checks.push({
          id: checkId,
          ok: onlyPfc.length === 0 && onlyPfmea.length === 0,
          skipped: empty,
          detail: empty
            ? '两份文档均未识别到 OP-xx 工序编号，无法比对（补编号后重跑）'
            : onlyPfc.length || onlyPfmea.length
              ? `不一致：仅流程图有 [${onlyPfc.join(',') || '-'}]；仅 PFMEA 有 [${onlyPfmea.join(',') || '-'}]`
              : `工序一一对应（${a.size} 道）`,
        });
        break;
      }
      case 'dvp_covers_all_special_characteristics':
      case 'cp_covers_all_special_characteristics': {
        const isCp = checkId.startsWith('cp_');
        const target = isCp ? docs.CP : docs.DVP;
        const sc = docs.SC;
        if (!target || !sc) { checks.push({ id: checkId, ok: false, detail: `缺少 ${isCp ? '控制计划' : 'DVP'} 或特殊特性清单` }); break; }
        const ids = extractSpecialCharacteristics(sc.body);
        if (!ids.size) {
          checks.push({ id: checkId, ok: true, skipped: true, detail: '特殊特性清单尚未填写编号，无法检查覆盖性' });
          break;
        }
        const missing = [...ids].filter((id) => !target.body.includes(id));
        checks.push({
          id: checkId,
          ok: missing.length === 0,
          detail: missing.length ? `未覆盖：${missing.join(',')}` : `全部 ${ids.size} 个特殊特性均被覆盖`,
        });
        break;
      }
      case 'ppap_18_items_complete': {
        const d = docs.PPAP;
        if (!d) { checks.push({ id: checkId, ok: false, detail: '缺少 PPAP 清单' }); break; }
        const n = countTableRows(d.body);
        checks.push({
          id: checkId,
          ok: n >= 18,
          detail: n >= 18 ? `已列 ${n} 项（≥18）` : `仅列 ${n} 项，PPAP 要求 18 项`,
        });
        break;
      }
      default:
        checks.push({ id: checkId, ok: true, skipped: true, detail: '检查项未实现，按不阻断处理（MVP）' });
    }
  }

  const blocking = checks.filter((c) => !c.ok && !c.skipped);
  return {
    id: gate.id,
    name: gate.name,
    stage: gate.stage,
    status: blocking.length ? 'preparing' : 'pending',
    checks,
    evidence,
  };
}

/** 对已启用阶段的所有门禁跑一遍，并写回状态（机器最多推进到 pending） */
export async function refreshGates({ project, engine, rules }) {
  const enabled = new Set(project.manifest.stages?.enabled ?? []);
  const results = [];
  for (const gate of Object.values(GATES)) {
    if (!enabled.has(gate.stage)) continue;
    if (!gate.deliverables.length) continue;
    const res = await runGateChecks({ gateId: gate.id, project, rules });
    engine.ensureGate(gate.id, { name: gate.name, stage: gate.stage });
    const cur = engine.getGate(gate.id);
    if (cur.status === 'released' || cur.status === 'pending') {
      // 已签署或已待签：只刷新证据，不回退状态（回退等于把人的决定覆盖掉）
      const updated = engine.updateGateChecks(gate.id, res.checks);
      results.push({ ...res, status: updated.status, checks: updated.checks });
      continue;
    }
    const updated = engine.refreshGate(gate.id, { status: res.status, checks: res.checks });
    results.push({ ...res, status: updated.status, checks: updated.checks });
  }
  return results;
}

export { GATES, STAGES };
