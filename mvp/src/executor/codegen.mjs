import { execFile } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import { isFirmwareApplicationPath } from '../domain/router.mjs';
import { ensureDir, writeFileAtomic } from '../util/fsx.mjs';
import { scanSecrets } from './repo.mjs';

const exec = promisify(execFile);

function isOutside(root, absPath) {
  const rel = path.relative(root, absPath);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

export function isAllowedCodePath(projectRoot, absOrRelPath) {
  if (typeof absOrRelPath !== 'string') return false;
  const normalized = absOrRelPath.replace(/\\/g, '/');
  const relative = path.isAbsolute(normalized) ? path.relative(projectRoot, normalized) : normalized;
  return isFirmwareApplicationPath(relative.replace(/\\/g, '/'));
}

async function resolveFirmwareSource(projectRoot, relPath) {
  if (!isAllowedCodePath(projectRoot, relPath)) {
    throw new Error(`目标不在固件应用代码白名单内：${relPath}`);
  }
  const absPath = path.resolve(projectRoot, relPath.replace(/\\/g, '/'));
  let resolved;
  try { resolved = await fs.realpath(absPath); }
  catch (err) { throw new Error(`无法打开固件目标 ${relPath}（${err.code ?? err.message}）`); }
  if (path.relative(absPath, resolved) || !(await fs.lstat(absPath)).isFile()) {
    throw new Error(`固件目标必须是项目应用层中的普通文件，不可经过链接：${relPath}`);
  }
  return resolved;
}

export async function readFirmwareSource(projectRoot, requestedPath) {
  const absPath = await resolveFirmwareSource(projectRoot, requestedPath);
  const relPath = path.relative(projectRoot, absPath).split(path.sep).join('/');
  const bytes = await fs.readFile(absPath);
  const original = bytes.toString('utf8');
  if (!bytes.equals(Buffer.from(original))) throw new Error(`固件目标须使用 UTF-8 编码：${relPath}`);
  return { absPath, relPath, original };
}

export async function prepareFirmwareBuild(projectRoot, config) {
  const { executable, args, cwd = '.', timeoutMs = 300_000, maxExitCode = 0 } = config ?? {};
  if (typeof executable !== 'string' || !executable.trim() || executable.includes('\0')
    || (!path.isAbsolute(executable) && !/^[\w+-][\w+.-]*$/.test(executable))
    || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    || typeof cwd !== 'string' || path.isAbsolute(cwd) || cwd.includes('\0')
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647
    || !Number.isInteger(maxExitCode) || maxExitCode < 0) {
    throw new Error('请由项目维护者在 integrations.firmware.build 配置编译工具 executable 与字符串参数数组 args');
  }
  const buildPath = path.resolve(projectRoot, cwd);
  const realPath = await fs.realpath(buildPath).catch(() => null);
  if (!realPath || isOutside(projectRoot, buildPath) || isOutside(projectRoot, realPath) || !(await fs.stat(realPath)).isDirectory()) {
    throw new Error(`integrations.firmware.build.cwd 必须是项目内已存在的目录：${cwd}`);
  }
  return { executable, args: [...args], cwd: realPath, timeoutMs, maxExitCode };
}

async function compileFirmware({ executable, args, cwd, timeoutMs, maxExitCode }) {
  try {
    await exec(executable, args, { cwd, timeout: timeoutMs, windowsHide: true, shell: false });
    return 0;
  } catch (err) {
    if (Number.isInteger(err.code) && err.code > 0 && err.code <= maxExitCode) return err.code;
    const detail = [err.stderr, err.stdout].filter(Boolean).join('\n').trim().slice(-1000);
    const reason = err.killed ? `超过 ${timeoutMs} ms` : (err.code ?? err.signal ?? '执行异常');
    throw new Error(`固件编译失败（${reason}）${detail ? `：${detail}` : ''}`);
  }
}

export function validateFirmwareCandidate(original, text) {
  if (typeof text !== 'string' || !text.trim() || text.includes('\0')) throw new Error('代码生成器未返回完整源码');
  if (text.trim() === original.trim()) return original;
  if (/(?:^|\n)\s*```/.test(text)) throw new Error('候选源码含 Markdown 代码块标记');
  if (text.length < original.length * 0.6 || /TODO_FILL|TODO 由模型填写|待确认[^\n]*实现|<在此[^>]*>|\.\.\.\s*\/\/\s*省略/.test(text)) {
    throw new Error('候选源码疑似截断或含未替换占位符');
  }
  return text;
}

async function verifySources(projectRoot, sources, expected) {
  for (const source of sources) {
    const absPath = await resolveFirmwareSource(projectRoot, source.relPath);
    if (!(await fs.readFile(absPath)).equals(Buffer.from(source[expected]))) {
      throw new Error(`固件文件在执行期间意外变化：${source.relPath}`);
    }
  }
}

export async function applyAndBuildFirmware({ projectRoot, sources, build, backupRoot, redactPatterns }) {
  const changed = sources.filter(({ original, text }) => text !== original);
  const written = [];
  await verifySources(projectRoot, sources, 'original');
  if (changed.length) {
    await ensureDir(backupRoot);
    const dir = await fs.mkdtemp(path.join(backupRoot, 'attempt-'));
    for (const source of changed) {
      source.backupPath = path.join(dir, source.relPath + '.orig');
      await ensureDir(path.dirname(source.backupPath));
      await fs.writeFile(source.backupPath, source.original, { flag: 'wx' });
    }
  }

  const rollback = async () => {
    const errors = [];
    for (const source of [...written].reverse()) {
      try {
        const absPath = await resolveFirmwareSource(projectRoot, source.relPath);
        const current = await fs.readFile(absPath);
        if (current.equals(Buffer.from(source.original))) continue;
        if (!current.equals(Buffer.from(source.text))) throw new Error('检测到并发修改，保留当前文件');
        await writeFileAtomic(absPath, source.original);
      } catch (err) {
        errors.push(`${source.relPath}：${err.message}（原件 ${source.backupPath}）`);
      }
    }
    return errors;
  };

  try {
    for (const source of changed) {
      await verifySources(projectRoot, [source], 'original');
      await writeFileAtomic(source.absPath, source.text);
      written.push(source);
    }
    if (redactPatterns?.length) {
      const hits = await scanSecrets(sources.map((source) => source.absPath), redactPatterns);
      if (hits.length) throw new Error('候选源码中检出疑似凭据');
    }
    const exitCode = await compileFirmware(build);
    await verifySources(projectRoot, sources, 'text');
    return { exitCode, rollback, verify: () => verifySources(projectRoot, sources, 'text') };
  } catch (err) {
    const errors = await rollback();
    if (errors.length) throw new Error(`${err.message}；部分固件文件需从备份恢复：${errors.join('；')}`);
    throw err;
  }
}

function buildPrompt({ relPath, original, requirement, notes }) {
  return [
    '你是嵌入式固件工程师，正在修改一个真实产品的 C 源码。请严格遵守：',
    '1. 只输出修改后的【完整文件内容】，不要输出解释、diff、markdown 代码块标记。',
    '2. 未涉及的代码必须逐字保留原样（含缩进、注释、空行），不得"顺手重构"或删减。',
    '3. 只在必要处新增/修改代码；新增的可调参数用 #define 宏，集中放在本文件或已包含的用户配置头。',
    '4. 不臆造寄存器、SDK 函数或协议细节；调用不存在的函数会导致编译失败，禁止。',
    '5. 保持原文件使用的 C 方言与工程编译约束。',
    '',
    '=== 需求 ===',
    requirement,
    '',
    '=== 补充说明 ===',
    notes || '（无）',
    '',
    '=== 目标文件：' + relPath + ' ===',
    original,
  ].join('\n');
}

/**
 * 让模型生成完整候选文件，实际写入与编译由执行器统一处理。
 */
export async function modifySourceFile({
  relPath, original, requirement, notes = '', pool, budget = {}, engine,
  ticketId = null, positionCode = 'SW',
}) {
  if (!pool) throw new Error('固件代码生成需要配置 worker 模型池');
  const limit = Number(budget.tokensPerTicket ?? 0);
  if (limit > 0 && engine && ticketId) {
    const spent = engine.tokensForTicket(ticketId);
    if (spent >= limit) throw new Error(`工单 token 预算已用尽（${spent}/${limit}），不修改代码`);
  }

  const prompt = buildPrompt({ relPath, original, requirement, notes });
  const res = await pool.generate({
    pool: positionCode === 'SW' ? 'worker' : positionCode,
    purpose: `code:${relPath}`,
    prompt,
    system: '你是汽车电子嵌入式软件工程师。输出完整的、可编译的 C 源文件；保留未改动部分原样；不确定的信息不要编造。',
  });
  const text = res?.text;
  if (!text) throw new Error(res?.reason ?? '模型未返回代码内容');
  if (res.truncated) throw new Error('模型输出被 max_tokens 截断，代码不完整已丢弃；请提高 maxTokens');
  return {
    text,
    model: res.model, keyId: res.keyId, tokens: res.usage?.tokens ?? 0,
  };
}
