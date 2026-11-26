// 飞书协议边界。业务准入由 domain/policy.mjs 判定。

import { stableKey } from '../util/ids.mjs';

const BASE = 'https://open.feishu.cn/open-apis';
const REQUEST_TIMEOUT_MS = 10_000;

export function createFeishuSource({ appId, appSecret, verificationToken, botOpenId = null, onEvent = null }) {
  if (!appId || !appSecret || typeof verificationToken !== 'string' || !verificationToken.trim()) return null;

  let token = null;
  let tokenExpireAt = 0;
  let tokenRequest = null;
  const queue = [];
  const seen = new Set();

  async function request(path, body, accessToken = null) {
    const headers = { 'content-type': 'application/json; charset=utf-8' };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST', headers, body: JSON.stringify(body), signal,
    });
    if (!res.ok) throw new Error(`飞书接口 ${path} 返回 HTTP ${res.status}`);
    const data = await res.json().catch((err) => {
      if (signal.aborted) throw signal.reason;
      if (!(err instanceof SyntaxError)) throw err;
      throw new Error(`飞书接口 ${path} 返回无效 JSON`);
    });
    if (data?.code === 0) return data;
    if (typeof data?.code !== 'number') throw new Error(`飞书接口 ${path} 返回无效响应`);
    throw new Error(`飞书接口 ${path} 返回 ${data.code}：${data.msg}`);
  }

  async function refreshToken() {
    const data = await request('/auth/v3/tenant_access_token/internal', {
      app_id: appId, app_secret: appSecret,
    });
    if (typeof data.tenant_access_token !== 'string' || !data.tenant_access_token.trim()
      || !Number.isFinite(data.expire) || data.expire <= 0) {
      throw new Error('飞书接口返回的 tenant_access_token 或有效期无效');
    }
    token = data.tenant_access_token;
    tokenExpireAt = Date.now() + data.expire * 1000;
    return token;
  }

  async function getToken() {
    if (token && Date.now() < tokenExpireAt - 60_000) return token;
    tokenRequest ??= refreshToken().finally(() => { tokenRequest = null; });
    return tokenRequest;
  }

  function toEvent(payload) {
    const msg = payload.event?.message;
    const sender = payload.event?.sender;
    if (!msg || !sender) return null;
    if (sender.sender_type === 'app') return null;            // 机器人自己发的，丢弃
    const openId = sender.sender_id?.open_id;
    if (!openId) return null;
    if (botOpenId && openId === botOpenId) return null;

    let text = '';
    try {
      text = JSON.parse(msg.content ?? '{}').text ?? '';
    } catch { text = String(msg.content ?? ''); }
    // 去掉 @ 占位符，正文才是研判输入
    text = text.replace(/@_user_\d+/g, '').trim();

    const mentionsBot = !!botOpenId && Array.isArray(msg.mentions)
      && msg.mentions.some((mention) => mention?.id?.open_id === botOpenId);
    return {
      source: 'feishu',
      externalId: payload.header?.event_id ?? msg.message_id,
      threadKey: msg.root_id || msg.parent_id || msg.message_id,
      actorId: openId,
      actorName: sender.sender_id?.user_id ?? openId,
      chatId: msg.chat_id,
      body: text,
      at: new Date(Number(msg.create_time) || Date.now()).toISOString(),
      addressed: msg.chat_type === 'p2p' || mentionsBot,
      meta: { chatType: msg.chat_type, messageId: msg.message_id },
    };
  }

  return {
    kind: 'feishu',

    async start() {
      await getToken();
    },

    /** 运行时提供 onEvent 时，先落库再向飞书确认接收。 */
    async handleEvent(body) {
      if (body?.type === 'url_verification') {
        if (body.token !== verificationToken) {
          const err = new Error('url_verification token 不匹配');
          err.status = 403;
          throw err;
        }
        return { challenge: body.challenge };
      }
      if (body?.encrypt) {
        const err = new Error('收到加密事件（encrypt），MVP 未实现解密：请在飞书后台关闭加密或补 encrypt_key 支持');
        err.status = 400;
        throw err;
      }
      const header = body?.header ?? {};
      if (header.token !== verificationToken) {
        const err = new Error('事件 token 不匹配');
        err.status = 403;
        throw err;
      }
      if (header.event_type !== 'im.message.receive_v1') return { ok: true };
      const evt = toEvent(body);
      if (!evt) return { ok: true };
      if (onEvent) {
        const received = await onEvent(evt);
        return received?.status === 'duplicate' ? { ok: true, duplicate: true } : { ok: true };
      }

      const id = evt.externalId;
      if (id && seen.has(id)) return { ok: true, duplicate: true };
      if (id) {
        seen.add(id);
        if (seen.size > 500) seen.delete(seen.values().next().value);
      }
      queue.push(evt);
      return { ok: true };
    },

    async poll() {
      return queue.splice(0, queue.length);
    },

    async send(reply) {
      const { messageId, chatId, text, dedupeKey } = reply;
      if (!messageId && !chatId) throw new Error('飞书回复缺少 messageId 或 chatId');
      const body = { msg_type: 'text', content: JSON.stringify({ text }) };
      if (dedupeKey) body.uuid = stableKey(messageId || chatId, dedupeKey);
      const path = messageId
        ? `/im/v1/messages/${encodeURIComponent(messageId)}/reply`
        : '/im/v1/messages?receive_id_type=chat_id';
      if (!messageId) body.receive_id = chatId;
      await request(path, body, await getToken());
      return { ok: true, ref: dedupeKey ?? null };
    },

    async stop() { /* 无长连接 */ },
  };
}
