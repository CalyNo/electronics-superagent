// 飞书来源适配器（真实实现，非桩）：
//   - webhook 事件接收（含 url_verification 握手）
//   - tenant_access_token 获取与缓存
//   - 发消息回写
// 无凭据时构造返回 null，由 runtime 明确提示"未启用"，而不是启动即崩。
//
// 安全边界：本文件只做协议转换，不做准入判断（准入在 domain/policy.mjs）。
// 事件签名：MVP 校验 verification token；加密事件（encrypt_key）未实现，遇到时明确报错而非静默丢。

const BASE = 'https://open.feishu.cn/open-apis';

export function createFeishuSource({ appId, appSecret, verificationToken, botOpenId = null }) {
  if (!appId || !appSecret) return null;

  let token = null;
  let tokenExpireAt = 0;
  const queue = [];
  const seen = new Set(); // event_id 去重（进程内；跨重启由 store 的 external_id 兜底）

  async function request(path, { method = 'POST', body = null, query = '' } = {}) {
    const headers = { 'content-type': 'application/json; charset=utf-8' };
    if (token) headers.authorization = `Bearer ${await getToken()}`;
    const res = await fetch(`${BASE}${path}${query}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (data.code && data.code !== 0) throw new Error(`飞书接口 ${path} 返回 ${data.code}: ${data.msg}`);
    return data;
  }

  async function getToken() {
    if (token && Date.now() < tokenExpireAt - 60_000) return token;
    const data = await request('/auth/v3/tenant_access_token/internal', {
      body: { app_id: appId, app_secret: appSecret },
    });
    token = data.tenant_access_token;
    tokenExpireAt = Date.now() + (data.expire ?? 7200) * 1000;
    return token;
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

    return {
      source: 'feishu',
      externalId: payload.header?.event_id ?? msg.message_id,
      threadKey: msg.root_id || msg.parent_id || msg.message_id,
      actorId: openId,
      actorName: sender.sender_id?.user_id ?? openId,
      chatId: msg.chat_id,
      body: text,
      at: new Date(Number(msg.create_time) || Date.now()).toISOString(),
      addressed: Array.isArray(msg.mentions) && msg.mentions.length > 0,
      meta: { chatType: msg.chat_type, messageId: msg.message_id },
    };
  }

  return {
    kind: 'feishu',

    async start() {
      await getToken();
    },

    /** webhook 入口：返回给飞书的响应体；事件进队列等 poll 取走 */
    async handleEvent(body) {
      if (body?.type === 'url_verification') {
        if (verificationToken && body.token !== verificationToken) {
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
      if (verificationToken && header.token && header.token !== verificationToken) {
        const err = new Error('事件 token 不匹配');
        err.status = 403;
        throw err;
      }
      const id = header.event_id;
      if (id && seen.has(id)) return { ok: true, duplicate: true };
      if (id) {
        seen.add(id);
        if (seen.size > 500) seen.delete(seen.values().next().value);
      }
      const evt = toEvent(body);
      if (evt) queue.push(evt);
      return { ok: true };
    },

    async poll() {
      return queue.splice(0, queue.length);
    },

    async send(reply) {
      if (!reply.chatId) throw new Error('飞书回复缺少 chatId');
      await request('/im/v1/messages', {
        query: '?receive_id_type=chat_id',
        body: {
          receive_id: reply.chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: reply.text }),
        },
      });
      return { ok: true, ref: reply.dedupeKey ?? null };
    },

    async stop() { /* 无长连接 */ },
  };
}
