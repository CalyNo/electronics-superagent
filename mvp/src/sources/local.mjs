// 本地文件来源：把"人 @ 机器人"替换成"往收件箱丢一个 json"。
// 存在的意义不是替代飞书，而是让整条链路可以在无网络、无凭据的环境里被验证与回归。
// 语义与飞书源完全一致：读成功才移走（崩溃可重放），回复写到 outbox。

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ensureDir, exists } from '../util/fsx.mjs';

export function createLocalSource({ projectDir }) {
  const inbox = path.join(projectDir, '.inbox');
  const processed = path.join(inbox, 'processed');
  const outbox = path.join(projectDir, '.outbox');

  return {
    kind: 'local',

    async start() {
      await ensureDir(inbox);
      await ensureDir(processed);
      await ensureDir(outbox);
    },

    /** @returns {Promise<Array>} 未处理的事件 */
    async poll() {
      if (!(await exists(inbox))) return [];
      const files = (await fs.readdir(inbox)).filter((f) => f.endsWith('.json')).sort();
      const events = [];
      for (const f of files) {
        const abs = path.join(inbox, f);
        let raw;
        try {
          raw = JSON.parse(await fs.readFile(abs, 'utf8'));
        } catch (err) {
          // 坏文件不静默丢弃：改名留证，供人排查
          await fs.rename(abs, path.join(processed, `${f}.bad-${Date.now()}`)).catch(() => {});
          continue;
        }
        const externalId = raw.id ?? f.replace(/\.json$/, '');
        events.push({
          source: 'local',
          externalId,
          threadKey: raw.threadId ?? raw.threadKey ?? `local:${raw.actorId ?? 'anonymous'}:${externalId}`,
          actorId: raw.actorId ?? 'ou_local',
          actorName: raw.actorName ?? raw.actorId ?? '本地用户',
          chatId: raw.chatId ?? 'local',
          body: String(raw.text ?? raw.body ?? ''),
          at: raw.at ?? new Date().toISOString(),
          addressed: raw.addressed !== false,
          meta: { file: f },
        });
        await fs.rename(abs, path.join(processed, f)).catch(() => {});
      }
      return events;
    },

    async send(reply) {
      await ensureDir(outbox);
      const line = JSON.stringify({
        at: new Date().toISOString(),
        kind: reply.kind ?? 'reply',
        threadId: reply.threadId ?? null,
        text: reply.text,
        dedupeKey: reply.dedupeKey ?? null,
      });
      await fs.appendFile(path.join(outbox, 'messages.jsonl'), line + '\n', 'utf8');
      return { ok: true, ref: path.join(outbox, 'messages.jsonl') };
    },

    async stop() { /* 无连接可关 */ },
  };
}
