// 测试夹具：在临时目录里建一个真实项目（含 Git），并提供一个投递消息的助手。
// 不用 mock 数据库、不 mock 文件系统——MVP 的价值恰恰在于"真的能跑"。

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapProject } from '../src/app/bootstrap.mjs';
import { Runtime } from '../src/app/runtime.mjs';

export async function makeProject({ code = 'TST01', stages = ['S1', 'S5'], acceptMode = 'auto', git = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'esa-'));
  const dir = path.join(root, code.toLowerCase());
  await bootstrapProject({
    targetDir: dir, code, name: '测试项目', owner: '王经理', stages, acceptMode, gitInit: git,
  });
  return dir;
}

export async function makeRuntime(opts = {}) {
  const dir = await makeProject(opts);
  const runtime = await Runtime.create({
    dir,
    options: {
      source: 'local',
      git: opts.git !== false,
      model: opts.model ?? null,
      aiFill: opts.aiFill,
      keysFile: opts.keysFile,
      // 测试不读开发机的模型配置，避免环境串味
      modelFile: opts.modelFile ?? path.join(path.dirname(dir), 'no-model.yml'),
      env: opts.env ?? {},
    },
  });
  return { dir, runtime };
}

/** 预置一份 keys.json（工作台测试用） */
export async function seedKeysFile(pools, { budget } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'esa-keystore-'));
  const file = path.join(dir, 'keys.json');
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    budget: budget ?? { tokensPerTicket: 1000, tokensPerDay: 10000 },
    pools,
  }, null, 2), 'utf8');
  return file;
}

let seq = 0;
export async function say(dir, { id, actor = 'ou_xxx2', text, chat = 'oc_aaa', addressed = true } = {}) {
  seq += 1;
  const messageId = id ?? `msg-${Date.now()}-${seq}`;
  await fs.mkdir(path.join(dir, '.inbox'), { recursive: true });
  await fs.writeFile(path.join(dir, '.inbox', `${messageId}.json`), JSON.stringify({
    id: messageId, actorId: actor, chatId: chat, text, at: new Date().toISOString(), addressed,
  }), 'utf8');
  return messageId;
}

export async function cleanup(runtime, dir) {
  try { await runtime?.close(); } catch { /* 忽略 */ }
  if (dir) await fs.rm(path.dirname(dir), { recursive: true, force: true }).catch(() => {});
}

export async function gitOutput(dir, args) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile('git', args, { cwd: dir, windowsHide: true }, (err, stdout) => resolve(String(stdout ?? '').trim()));
  });
}
