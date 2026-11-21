import { createHash } from 'node:crypto';

/** 稳定键：同输入必得同输出，用于幂等去重与外部事件映射 */
export function stableKey(...parts) {
  return createHash('sha1').update(parts.map((p) => String(p)).join('\u0001')).digest('hex').slice(0, 16);
}

export function shortSha(s, n = 7) {
  return String(s).replace(/[^a-z0-9]/gi, '').slice(0, n);
}

const pad = (n, w) => String(n).padStart(w, '0');

/** DOC-<阶段>-<类型>-<3位流水>，与 docs/03 的编码规则一致 */
export function docId(stage, type, seq) {
  return `DOC-${stage}-${type}-${pad(seq, 3)}`;
}

/** TKT-<年>-<4位流水> */
export function ticketId(dateISO, seq) {
  const year = String(dateISO).slice(0, 4);
  return `TKT-${year}-${pad(seq, 4)}`;
}

export function evalId(threadId, seq) {
  return `EVL-${shortSha(threadId, 8)}-${pad(seq, 3)}`;
}

export function assignmentId(ticket, attempt) {
  return `ASG-${ticket.replace(/^TKT-/, '')}-${pad(attempt, 2)}`;
}

export function gateId(stage) {
  return stage === 'S5' ? 'G5' : `G${Number(String(stage).slice(1))}`;
}
