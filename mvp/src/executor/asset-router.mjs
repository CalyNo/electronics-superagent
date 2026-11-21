// 资产路由器：任何产物落盘前先判归属（docs/03 §4）。
// 原则：能确定就落位，不能确定就进 _unclassified 并留原因——不猜，因为猜错的分类会污染
// 特殊特性推导与追溯链，比"未分类"危险得多。

import path from 'node:path';

const RULES = [
  // 固件源码
  { kind: 'code', ext: ['.c', '.h', '.s', '.asm', '.ld'], target: 'firmware/app', reason: 'C/汇编 → 固件应用层' },
  { kind: 'code', ext: ['.cpp', '.hpp', '.cc'], target: 'firmware/app', reason: 'C++ → 固件应用层' },
  // 上位机 / 工具
  { kind: 'code', ext: ['.ts', '.js', '.vue', '.py'], target: 'software/tools', reason: '脚本与上位机 → 软件工具' },
  // 硬件资源
  { kind: 'hardware', ext: ['.schdoc', '.sch', '.kicad_sch'], target: 'hardware/schematic', reason: '原理图 → 硬件原理图' },
  { kind: 'hardware', ext: ['.pcbdoc', '.brd', '.kicad_pcb'], target: 'hardware/pcb', reason: 'PCB → 硬件 PCB' },
  { kind: 'hardware', ext: ['.step', '.stp', '.igs', '.dwg', '.dxf'], target: 'hardware/mechanical', reason: '结构件 → 硬件结构' },
  { kind: 'hardware', ext: ['.pdf', '.docx'], nameHint: /bom|datasheet|规格书|选型/i, target: 'hardware/datasheet', reason: '选型/规格资料 → 硬件资料' },
  { kind: 'hardware', nameHint: /bom|物料清单/i, ext: ['.xlsx', '.xls', '.csv'], target: 'hardware/bom', reason: 'BOM → 硬件 BOM' },
  // 测试与证据
  { kind: 'test', ext: ['.log', '.trc', '.csv'], target: 'test/data', reason: '测试数据 → 测试数据' },
  // 文档
  { kind: 'document', ext: ['.md', '.docx', '.pdf', '.xlsx', '.xls'], target: 'docs/_unclassified', reason: '文档但无法判定阶段/类型', needsMeta: true },
];

export function classify(relPath) {
  const p = String(relPath).replace(/\\/g, '/');
  const base = path.posix.basename(p).toLowerCase();
  const ext = path.posix.extname(base);

  for (const r of RULES) {
    const extOk = !r.ext || r.ext.includes(ext);
    const nameOk = !r.nameHint || r.nameHint.test(base);
    if (extOk && nameOk) {
      return { kind: r.kind, target: r.target, ext, reason: r.reason, needsMeta: !!r.needsMeta };
    }
  }
  return {
    kind: 'unknown',
    target: 'docs/_unclassified',
    ext,
    reason: '扩展名与文件名均无匹配规则',
    needsMeta: true,
  };
}

/** 判断一个路径是否已经落在它该在的目录（用于 verify 报告错位文件） */
export function checkPlacement(relPath) {
  const p = String(relPath).replace(/\\/g, '/');
  if (p.startsWith('docs/_templates/') || p.startsWith('docs/_index/') || p.startsWith('.superagent/')) {
    return { ok: true, skipped: true, reason: '平台元文件，不参与分类校验' };
  }
  const c = classify(p);
  if (c.kind === 'unknown' || c.kind === 'document') return { ok: true, skipped: true, reason: c.reason };
  const ok = p.startsWith(c.target + '/');
  return {
    ok,
    skipped: false,
    kind: c.kind,
    expected: c.target + '/',
    reason: ok ? '落位正确' : `应位于 ${c.target}/，实际在 ${path.posix.dirname(p)}/`,
  };
}

/** 产物的分类编码：DOC-S2-DFMEA-012 / CODE-FW-app / HW-schematic */
export function assetCode({ kind, docType = null, stage = null, target = null, id = null }) {
  if (kind === 'document' && id) return id;
  if (kind === 'code') return `CODE-${(target ?? 'misc').replace(/^software\//, 'SW-').replace(/^firmware\//, 'FW-').replace(/\//g, '-')}`;
  if (kind === 'hardware') return `HW-${(target ?? 'misc').replace(/^hardware\//, '').replace(/\//g, '-')}`;
  if (kind === 'test') return 'TEST-data';
  return 'UNCLASSIFIED';
}
