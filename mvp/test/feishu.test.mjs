import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeishuSource } from '../src/sources/feishu.mjs';

const credentials = {
  appId: 'cli_test',
  appSecret: 'test-app-secret',
  verificationToken: 'test-callback-token',
};
const botOpenId = 'ou_bot';
const reply = { chatId: 'oc_chat', text: '收到', dedupeKey: 'reply-test' };
const authPath = '/open-apis/auth/v3/tenant_access_token/internal';
const sendPath = '/open-apis/im/v1/messages';

function callback({ id = 'event-one', chatType = 'group', mentionedId = null } = {}) {
  return {
    schema: '2.0',
    header: {
      event_id: id,
      event_type: 'im.message.receive_v1',
      create_time: '1700000000000',
      app_id: credentials.appId,
      tenant_key: 'test-tenant',
      token: credentials.verificationToken,
    },
    event: {
      sender: { sender_id: { open_id: 'ou_sender', user_id: 'sender' }, sender_type: 'user' },
      message: {
        chat_id: 'oc_chat',
        message_id: `om_${id}`,
        chat_type: chatType,
        message_type: 'text',
        create_time: '1700000000000',
        content: JSON.stringify({ text: `${mentionedId ? '@_user_1 ' : ''}请整理测试报告` }),
        mentions: mentionedId ? [{ key: '@_user_1', id: { open_id: mentionedId } }] : [],
      },
    },
  };
}

function tokenResponse(token = 'test-access-token') {
  return Response.json({ code: 0, msg: 'ok', tenant_access_token: token, expire: 7200 });
}

test('飞书来源必须配置回调令牌才能启用', () => {
  for (const verificationToken of [undefined, '', '  ']) {
    assert.equal(createFeishuSource({ ...credentials, verificationToken }), null);
  }
});

test('飞书回调只有令牌匹配才确认连接或接收事件', async () => {
  const source = createFeishuSource(credentials);
  const challenge = { type: 'url_verification', challenge: 'challenge' };
  for (const token of [undefined, 'wrong-token']) {
    await assert.rejects(source.handleEvent({ ...challenge, token }), { status: 403 });
    const event = callback();
    event.header.token = token;
    await assert.rejects(source.handleEvent(event), { status: 403 });
  }
  assert.deepEqual(await source.poll(), []);
  assert.deepEqual(await source.handleEvent({ ...challenge, token: credentials.verificationToken }), { challenge: 'challenge' });
  assert.deepEqual(await source.handleEvent(callback()), { ok: true });
  assert.deepEqual(await source.handleEvent(callback()), { ok: true, duplicate: true });
  assert.equal((await source.poll()).length, 1);
});

test('飞书群聊只把对当前机器人的 @ 识别为明确请求', async () => {
  const source = createFeishuSource({ ...credentials, botOpenId });
  await source.handleEvent(callback({ id: 'bot', mentionedId: botOpenId }));
  await source.handleEvent(callback({ id: 'other', mentionedId: 'ou_other' }));
  const [bot, other] = await source.poll();
  assert.equal(bot.addressed, true);
  assert.equal(bot.body, '请整理测试报告');
  assert.equal(other.addressed, false);

  const unconfigured = createFeishuSource(credentials);
  await unconfigured.handleEvent(callback({ mentionedId: botOpenId }));
  assert.equal((await unconfigured.poll())[0].addressed, false);
});

test('飞书单聊直接发给机器人时无需 @', async () => {
  const source = createFeishuSource(credentials);
  await source.handleEvent(callback({ chatType: 'p2p' }));
  assert.equal((await source.poll())[0].addressed, true);
});

test('飞书来源忽略其他事件类型', async () => {
  const source = createFeishuSource(credentials);
  const event = callback();
  event.header.event_type = 'im.message.message_read_v1';
  assert.deepEqual(await source.handleEvent(event), { ok: true });
  assert.deepEqual(await source.poll(), []);
});

test('飞书回调等待事件持久化成功后确认，失败时可以重投', async () => {
  const stored = new Set();
  let writes = 0;
  const source = createFeishuSource({ ...credentials, onEvent: async (event) => {
    if (++writes === 1) throw new Error('测试写入失败');
    await Promise.resolve();
    if (stored.has(event.externalId)) return { status: 'duplicate' };
    assert.equal(event.meta.messageId, 'om_event-one');
    stored.add(event.externalId);
    return { status: 'new' };
  } });
  await assert.rejects(source.handleEvent(callback()), /测试写入失败/);
  assert.deepEqual(await source.handleEvent(callback()), { ok: true });
  assert.deepEqual([...stored], ['event-one']);
  assert.deepEqual(await source.handleEvent(callback()), { ok: true, duplicate: true });
  assert.deepEqual(await source.poll(), []);
});

test('飞书发送首条消息前先获取令牌并使用 Bearer 鉴权', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, { headers, body }) => {
    const { pathname, search } = new URL(url);
    calls.push({ pathname, search, authorization: headers.authorization, body: JSON.parse(body) });
    return pathname === authPath ? tokenResponse() : Response.json({ code: 0, msg: 'success' });
  });

  const source = createFeishuSource(credentials);
  assert.deepEqual(await source.send(reply), { ok: true, ref: reply.dedupeKey });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    pathname: authPath, search: '', authorization: undefined,
    body: { app_id: credentials.appId, app_secret: credentials.appSecret },
  });
  const { body: { uuid, ...message }, ...request } = calls[1];
  assert.deepEqual(request, { pathname: sendPath, search: '?receive_id_type=chat_id', authorization: 'Bearer test-access-token' });
  assert.deepEqual(message, { receive_id: reply.chatId, msg_type: 'text', content: JSON.stringify({ text: reply.text }) });
  assert.match(uuid, /^.{1,50}$/);
});

test('飞书使用消息 ID 回复原消息，重试保留相同的飞书幂等键', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, { body }) => {
    const { pathname, search } = new URL(url);
    if (pathname === authPath) return tokenResponse();
    calls.push({ pathname, search, body: JSON.parse(body) });
    if (calls.length === 1) return new Response(null, { status: 503 });
    return Response.json({ code: 0, msg: 'success' });
  });
  const source = createFeishuSource(credentials);
  const original = { messageId: 'om_original', text: reply.text, dedupeKey: reply.dedupeKey };
  await assert.rejects(source.send(original), /HTTP 503/);
  assert.deepEqual(await source.send(original), { ok: true, ref: reply.dedupeKey });
  assert.equal(calls.length, 2);
  const [sent, retried] = calls;
  assert.equal(sent.pathname, `${sendPath}/${original.messageId}/reply`);
  assert.equal(sent.search, '');
  assert.equal(sent.body.msg_type, 'text');
  assert.equal(sent.body.content, JSON.stringify({ text: original.text }));
  assert.match(sent.body.uuid, /^.{1,50}$/);
  assert.deepEqual(retried, sent);
});

test('飞书并发发送共用一次令牌刷新且刷新请求不带 Bearer', async (t) => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, { headers }) => {
    const { pathname } = new URL(url);
    calls.push([pathname, headers.authorization]);
    return pathname === authPath ? tokenResponse(`token-${calls.length}`) : Response.json({ code: 0, msg: 'success' });
  });
  const source = createFeishuSource(credentials);
  await source.start();
  now += 7200_000;
  await Promise.all([source.send(reply), source.send(reply)]);
  assert.deepEqual(calls, [
    [authPath, undefined], [authPath, undefined], [sendPath, 'Bearer token-2'], [sendPath, 'Bearer token-2'],
  ]);
});

test('飞书启动拒绝缺少令牌的响应，重试能重新获取', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? Response.json({ code: 0, msg: 'ok', expire: 7200 }) : tokenResponse());
  const source = createFeishuSource(credentials);
  await assert.rejects(source.start(), /tenant_access_token/);
  await source.start();
  assert.equal(calls, 2);
});

test('飞书发送失败会向调用方返回 HTTP、业务和无效响应错误', async (t) => {
  const responses = [
    new Response('unavailable', { status: 503 }),
    Response.json({ code: 230001, msg: 'invalid request' }),
    new Response('invalid JSON'),
    Response.json({}),
  ];
  t.mock.method(globalThis, 'fetch', async (url) => new URL(url).pathname === authPath
    ? tokenResponse() : responses.shift());
  const source = createFeishuSource(credentials);
  await source.start();
  for (const error of [/HTTP 503/, /230001/, /JSON/, /无效响应/]) {
    await assert.rejects(source.send(reply), error);
  }
});

test('飞书网络请求会在超时时中止', async (t) => {
  const timeout = new DOMException('请求超时', 'TimeoutError');
  t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort(timeout));
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    signal?.throwIfAborted();
    return tokenResponse();
  });
  await assert.rejects(createFeishuSource(credentials).start(), { name: 'TimeoutError' });
});
