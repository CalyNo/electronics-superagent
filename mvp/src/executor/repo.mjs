// Git 操作：分支、提交、PR 草案。
// 铁律（docs/05 §3）：
//   - 永不直接提交到 main/develop/release/*
//   - 只允许 agent/ change/ fix/ 前缀
//   - 提交前扫描凭据，命中即阻断
//   - 不自动合并、不自动打标签

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ensureDir, exists, readFileSafe } from '../util/fsx.mjs';

function git(args, cwd, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !allowFail) {
        err.message = `git ${args.join(' ')} 失败：${(stderr || stdout || err.message).trim()}`;
        return reject(err);
      }
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim() });
    });
  });
}

export async function isRepo(dir) {
  return exists(path.join(dir, '.git'));
}

export async function ensureRepo(dir, { author = { name: 'electronics-superagent', email: 'agent@example.com' } } = {}) {
  const created = !(await isRepo(dir));
  if (created) {
    await git(['init', '-q', '-b', 'main'], dir, { allowFail: true });
    // 老版本 git 不支持 -b，退化为 init + branch -M
    if (!(await isRepo(dir))) await git(['init', '-q'], dir);
    await git(['config', 'user.name', author.name], dir, { allowFail: true });
    await git(['config', 'user.email', author.email], dir, { allowFail: true });
  }
  return { created };
}

export async function currentBranch(dir) {
  const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir, { allowFail: true });
  return r.ok ? r.stdout : null;
}

function globMatch(pattern, value) {
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(value);
}

export function isProtected(branch, protectedList = ['main', 'develop', 'release/*']) {
  return protectedList.some((p) => globMatch(p, branch));
}

export function assertBranchAllowed(branch, { protectedList, allowedPrefixes }) {
  if (isProtected(branch, protectedList)) {
    return { ok: false, reason: `分支 ${branch} 属于受保护分支，执行器不得直接提交` };
  }
  if (!allowedPrefixes.some((p) => branch.startsWith(p))) {
    return { ok: false, reason: `分支 ${branch} 前缀不在允许列表（${allowedPrefixes.join(' / ')}）` };
  }
  return { ok: true, reason: '分支合法' };
}

export async function createBranch(dir, branch, { protectedList, allowedPrefixes }) {
  const check = assertBranchAllowed(branch, { protectedList, allowedPrefixes });
  if (!check.ok) throw new Error(check.reason);
  const exists_ = await git(['rev-parse', '--verify', '--quiet', branch], dir, { allowFail: true });
  if (exists_.ok) await git(['checkout', '-q', branch], dir);
  else await git(['checkout', '-q', '-b', branch], dir);
  return branch;
}

/** 切回基线分支：受保护分支只读操作，不提交 */
export async function checkoutBase(dir, candidates = ['develop', 'main', 'master']) {
  for (const b of candidates) {
    const r = await git(['rev-parse', '--verify', '--quiet', b], dir, { allowFail: true });
    if (!r.ok) continue;
    await git(['checkout', '-q', b], dir, { allowFail: true });
    return b;
  }
  return null;
}

export async function branchExists(dir, branch) {
  return (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], dir, { allowFail: true })).ok;
}

export async function checkoutBranch(dir, branch) {
  return (await git(['checkout', '-q', branch], dir, { allowFail: true })).ok;
}

/** 提交指定文件；返回 {sha, branch, files} */
export async function commitFiles(dir, files, message, { author }) {
  const rels = files.map((f) => path.relative(dir, f)).filter(Boolean);
  if (!rels.length) return { sha: null, branch: await currentBranch(dir), files: [] };
  await git(['add', '--', ...rels], dir);
  const args = ['commit', '-q', '-m', message];
  if (author?.name && author?.email) args.push('--author', `${author.name} <${author.email}>`);
  const r = await git(args, dir, { allowFail: true });
  if (!r.ok) {
    const status = await git(['status', '--porcelain'], dir, { allowFail: true });
    if (!status.stdout) return { sha: null, branch: await currentBranch(dir), files: rels };
    throw new Error(`提交失败：${r.stderr || r.stdout}`);
  }
  const sha = (await git(['rev-parse', '--short', 'HEAD'], dir, { allowFail: true })).stdout;
  return { sha, branch: await currentBranch(dir), files: rels };
}

export async function stagedDiffLines(dir) {
  const r = await git(['diff', '--cached', '--numstat'], dir, { allowFail: true });
  if (!r.ok || !r.stdout) return 0;
  return r.stdout.split('\n').reduce((sum, line) => {
    const [add, del] = line.split('\t');
    return sum + (Number(add) || 0) + (Number(del) || 0);
  }, 0);
}

/** 凭据扫描：命中即阻断提交（提交进 Git 历史的东西删不掉） */
export async function scanSecrets(files, patterns, { allow = [] } = {}) {
  const hits = [];
  for (const f of files) {
    const text = await readFileSafe(f);
    if (text == null) continue;
    const name = path.basename(f);
    if (allow.some((a) => a.test(name) || a.test(f))) continue;
    for (const p of patterns) {
      let re;
      try { re = new RegExp(p, 'm'); } catch { continue; }
      const m = re.exec(text);
      if (m) hits.push({ file: f, pattern: p, sample: text.slice(Math.max(0, m.index - 10), m.index + 40).split('\n')[0] });
    }
  }
  return hits;
}

export function buildPrDraft({ ticket, assessment, assets, gate, commit, notes = [], base = null }) {
  const lines = [
    `# ${ticket.id} ${ticket.title}`,
    '',
    `> 由 electronics-superagent 生成。合并与打标签必须由人完成。`,
    '',
    `| 项 | 值 |`,
    `| --- | --- |`,
    `| 任务类型 | ${ticket.task_type} |`,
    `| 阶段 | ${ticket.stage} |`,
    `| 目标门禁 | ${ticket.gate_target ?? '不适用'} |`,
    `| 风险等级 | ${assessment?.riskLevel ?? ticket.severity ?? '-'} |`,
    `| 分支 | ${commit?.branch ?? '-'} |`,
    `| 目标分支 | ${base ?? '-'} |`,
    `| 提交 | ${commit?.sha ?? '-'} |`,
    '',
    '## 交付物',
    '',
    ...(assets.length ? assets.map((a) => `- \`${a.relPath}\`（${a.docType ?? a.kind}，${a.revision ?? '-'}）`) : ['- （无）']),
    '',
    '## 门禁状态',
    '',
    gate ? `- ${gate.id} ${gate.name}：**${gate.status}**` : '- 本任务不触发阶段门',
    ...(gate?.checks ?? []).map((c) => `  - ${c.ok ? '✅' : '❌'} ${c.id}${c.detail ? `：${c.detail}` : ''}`),
    '',
    '## 评审要点',
    '',
    '1. 文档正文中的 `<...>` 占位与「⚠ 待补充」需责任人填写。',
    '2. 系统不代填技术结论；如发现结论性内容，请核查来源。',
    '3. 涉及特殊特性/Safety 的变更，必须走阶段门签署。',
    '',
    ...(notes.length ? ['## 执行备注', '', ...notes.map((n) => `- ${n}`), ''] : []),
  ];
  return lines.join('\n');
}

export async function writePrDraft(stateDir, ticketId, text) {
  const dir = path.join(stateDir, 'pr');
  await ensureDir(dir);
  const file = path.join(dir, `${ticketId}.md`);
  await fs.writeFile(file, text, 'utf8');
  return file;
}
