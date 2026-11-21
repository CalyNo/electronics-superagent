// 固件代码修改执行器（软件工程师 SW 岗位专用）。
// 安全边界（docs/05 §3 + 角色授权）：
//   - 只允许改应用代码白名单路径，绝不触碰厂商 SDK / CMSIS / 协议栈 / bootloader
//   - 大模型只提交"完整文件内容"，调用方校验后才落盘，禁止直接执行模型给的 shell/命令
//   - 原文件先备份到 .state/codegen，人工可一键回退；不自动合并、不打标签
//
// 与文档填充的区别：文档按章节替换（agent.mjs），代码必须整文件替换——
// 局部 diff 由模型生成时极易错位，整文件 + 结构校验更可控。

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ensureDir, exists, readFileSafe, sha256Text } from '../util/fsx.mjs';

// 允许修改的应用代码目录（相对项目根，posix 风格）。boot/ 与 middlewares/ 有意排除。
const ALLOWED_DIR_PREFIXES = [
  'T23/projects/',                       // T23 应用工程根
];
// 这些子路径即使在上行者内也禁止修改（厂商/协议栈/引导程序/SDK）
const DENIED_PATH_PARTS = [
  '/firmware/CMSIS/', '/firmware/n32wb03x_std_periph_driver/',
  '/middlewares/', '/boot/', '/MDK-ARM/Objects/', '/MDK-ARM/Listings/',
];

export function isAllowedCodePath(projectRoot, absOrRelPath) {
  // 相对路径按 projectRoot 解析（而非进程 cwd），绝对路径原样使用
  const abs = path.isAbsolute(absOrRelPath)
    ? absOrRelPath
    : path.resolve(projectRoot, absOrRelPath);
  const relPath = path.relative(projectRoot, abs).replace(/\\/g, '/');
  if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) return false;
  if (!ALLOWED_DIR_PREFIXES.some((p) => relPath.startsWith(p))) return false;
  if (DENIED_PATH_PARTS.some((d) => `/${relPath}`.includes(d))) return false;
  // 只改源码与头文件
  if (!/\.(c|h)$/i.test(relPath)) return false;
  return true;
}

function buildPrompt({ relPath, original, requirement, notes }) {
  return [
    '你是嵌入式固件工程师，正在修改一个真实产品的 C 源码。请严格遵守：',
    '1. 只输出修改后的【完整文件内容】，不要输出解释、diff、markdown 代码块标记。',
    '2. 未涉及的代码必须逐字保留原样（含缩进、注释、空行），不得"顺手重构"或删减。',
    '3. 只在必要处新增/修改代码；新增的可调参数用 #define 宏，集中放在本文件或已包含的用户配置头。',
    '4. 不臆造寄存器、SDK 函数或协议细节；调用不存在的函数会导致编译失败，禁止。',
    '5. 保持 C90/C99 兼容的写法（该工程为 Keil ArmCC v5），不要在语句块中间声明变量。',
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
 * 让模型生成目标文件的新内容。
 * @returns {{text, usedBytes, changed, backupPath, sha256}}
 */
export async function modifySourceFile({
  projectRoot, relPath, requirement, notes = '', pool, budget = {}, engine,
  ticketId = null, positionCode = 'SW',
}) {
  const absPath = path.resolve(projectRoot, relPath);
  if (!isAllowedCodePath(projectRoot, absPath)) {
    throw new Error(`拒绝修改：${relPath} 不在固件应用代码白名单内（禁止 SDK/CMSIS/middleware/boot）`);
  }
  const original = await readFileSafe(absPath, null);
  if (original == null) throw new Error(`目标文件不存在：${relPath}`);

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
  if (/```/.test(text)) throw new Error('模型返回了 markdown 代码块标记，已拒绝落盘（要求纯文件内容）');
  if (text.length < original.length * 0.6) {
    throw new Error(`模型输出显著短于原文件（${text.length} < ${original.length * 0.6}），疑似误删，已拒绝落盘`);
  }
  if (/\b(TODO 由模型填写|待确认.*实现|<在此.*>)/.test(text)) {
    throw new Error('模型输出含未替换占位符，已拒绝落盘');
  }
  if (text === original) return { text, changed: false, relPath, sha256: sha256Text(text) };

  // 备份原文件，便于人工回退
  const backupDir = path.join(projectRoot, '.state', 'codegen', path.dirname(relPath));
  await ensureDir(backupDir);
  const backupPath = path.join(backupDir, path.basename(relPath) + '.orig');
  await fs.writeFile(backupPath, original, 'utf8');

  await fs.writeFile(absPath, text, 'utf8');
  return {
    text, changed: true, relPath, backupPath, sha256: sha256Text(text),
    model: res.model, keyId: res.keyId, tokens: res.usage?.tokens ?? 0,
  };
}
