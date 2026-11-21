// 准入与授权：决定"谁能发起、能做什么、能签哪个门"。
// 三条铁律（docs/06）：
//   1. 白名单为空 → 任何请求都不成为工单（空集合语义，不是"不限"）
//   2. 上下文不授予权限：未 @ 的消息最多补充信息，不能开新工单
//   3. 策略变更不撤销既有授权，只影响新工单

import { stableKey } from '../util/ids.mjs';

export const STRENGTH = { EXPLICIT: 'explicit', INFERRED: 'inferred', NONE: 'none' };

export function createPolicy({ policy, manifest }) {
  const version = policy?.version ?? `pv-${stableKey(JSON.stringify(policy ?? {}))}`;
  const acceptMode = policy?.acceptMode ?? 'off';

  const users = new Map();
  for (const srcName of ['feishu', 'local']) {
    for (const u of policy?.sources?.[srcName]?.allowed ?? []) {
      if (u?.id) users.set(u.id, { ...u, source: srcName });
    }
  }
  const bots = new Set();
  for (const srcName of ['feishu', 'local']) {
    for (const b of policy?.sources?.[srcName]?.bots ?? []) if (b?.id) bots.add(b.id);
  }

  function admissionFor(source, chatId) {
    const adm = policy?.sources?.[source]?.admission ?? {};
    if (chatId && adm[chatId]) return adm[chatId];
    if (adm.direct) return adm.direct;
    // 未配置的群：默认最保守 —— 白名单未 @ 视为上下文，其余忽略
    return { listedUnaddressed: STRENGTH.INFERRED, unlistedAddressed: STRENGTH.NONE, unlistedUnaddressed: STRENGTH.NONE };
  }

  /**
   * 准入判定。纯函数，无 I/O。
   * @returns {{admitted:boolean, strength:string, contextOnly:boolean, user:object|null, reason:string}}
   */
  function gate({ source, actorId, chatId, addressed = false }) {
    if (acceptMode === 'off') {
      return { admitted: false, strength: STRENGTH.NONE, contextOnly: false, user: null, reason: 'acceptMode=off：当前不接主动工作' };
    }
    if (bots.has(actorId)) {
      return { admitted: false, strength: STRENGTH.INFERRED, contextOnly: true, user: null, reason: '来源是机器人：只作候选，不构成明确请求' };
    }
    const user = users.get(actorId) ?? null;
    const adm = admissionFor(source, chatId);

    if (!user) {
      const s = addressed ? adm.unlistedAddressed : adm.unlistedUnaddressed;
      if (s === STRENGTH.EXPLICIT) {
        return { admitted: true, strength: STRENGTH.EXPLICIT, contextOnly: false, user: null, reason: '非白名单但在该群被允许直接发起' };
      }
      return { admitted: false, strength: STRENGTH.NONE, contextOnly: false, user: null, reason: '发送者不在白名单，且该群不允许其发起' };
    }

    if (addressed) {
      return { admitted: true, strength: STRENGTH.EXPLICIT, contextOnly: false, user, reason: `白名单成员 ${user.name ?? actorId} 明确请求` };
    }
    const s = adm.listedUnaddressed ?? STRENGTH.INFERRED;
    if (s === STRENGTH.EXPLICIT) {
      return { admitted: true, strength: STRENGTH.EXPLICIT, contextOnly: false, user, reason: '该群配置为：白名单成员未 @ 也视为明确请求' };
    }
    return { admitted: false, strength: STRENGTH.INFERRED, contextOnly: true, user, reason: '白名单成员未 @：仅补充上下文，不新开工单' };
  }

  function canInitiate(actorId, taskType) {
    const user = users.get(actorId);
    if (!user) {
      // 群里允许陌生人发起的场景：作者身份由 admission 决定，这里只放行"类型未受限"
      return { ok: true, reason: '身份由准入表判定' };
    }
    const list = user.canInitiate ?? [];
    if (!list.length) return { ok: false, reason: `${user.name ?? actorId} 未配置可发起类型` };
    if (taskType === 'clarify') return { ok: true, reason: '澄清不产生工单' };
    if (list.includes(taskType) || list.includes('all')) return { ok: true, reason: '角色允许' };
    return { ok: false, reason: `${user.name ?? actorId}（${user.role ?? '-'}）不能发起 ${taskType}；可发起：${list.join(' / ')}` };
  }

  function canSign(actorId, gateId) {
    const user = users.get(actorId);
    if (!user) return { ok: false, reason: '签署人不在白名单' };
    const list = user.canSign ?? [];
    if (list.includes(gateId) || list.includes('all')) return { ok: true, reason: `${user.name ?? actorId} 有权签署 ${gateId}` };
    return { ok: false, reason: `${user.name ?? actorId} 无 ${gateId} 签署权（可签：${list.join(' / ') || '无'}）` };
  }

  function signersOf(gateId) {
    return [...users.values()].filter((u) => (u.canSign ?? []).includes(gateId) || (u.canSign ?? []).includes('all'));
  }

  function describe(actorId) {
    const u = users.get(actorId);
    return u ? { id: u.id, name: u.name, role: u.role } : { id: actorId, name: actorId, role: null };
  }

  return { version, acceptMode, gate, canInitiate, canSign, signersOf, describe, users, bots };
}

/** 授权范围：不可变，扩大范围必须新工单 */
export function buildMandate({ ticket, assessment, manifest, policy, grantedBy }) {
  const stage = assessment.stage ?? ticket.stage;
  const docTypes = assessment.docTypes ?? [];
  const actionScope = [...new Set([
    ...docTypes, 'doc.write', 'repo.commit',
    // 固件代码写权限只在 code-change 任务中授予，且不撤销既有范围
    ...(docTypes.includes('CODE') ? ['code.write'] : []),
  ])];
  return {
    id: `MND-${ticket.id.replace(/^TKT-/, '')}`,
    ticketId: ticket.id,
    strength: 'explicit',
    repoScope: `${manifest.integrations?.repo?.url || manifest.code}`,
    stageScope: stage ? `${stage}..${assessment.gateTarget ?? stage}` : 'none',
    actionScope,
    policyVersion: policy.version,
    grantedBy,
  };
}
