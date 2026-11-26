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

function git(args, cwd, { allowFail = false, rawStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !allowFail) {
        err.message = `git ${args.join(' ')} 失败：${(stderr || stdout || err.message).trim()}`;
        return reject(err);
      }
      resolve({ ok: !err, code: err?.code ?? 0, stdout: rawStdout ? stdout : stdout.trim(), stderr: stderr.trim() });
    });
    child.stdin.end();
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
  let checkoutError = null;
  for (const b of candidates) {
    if (!(await branchExists(dir, b))) continue;
    try {
      await git(['checkout', '-q', b], dir);
      return b;
    } catch (err) {
      checkoutError = err;
    }
  }
  if (checkoutError) throw checkoutError;
  return null;
}

export async function branchExists(dir, branch) {
  return (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], dir, { allowFail: true })).ok;
}

export async function checkoutBranch(dir, branch) {
  return (await git(['checkout', '-q', branch], dir, { allowFail: true })).ok;
}

function relativePaths(dir, files) {
  return [...new Set(files.map((file) => path.relative(dir, file).split(path.sep).join('/')).filter(Boolean))];
}

function nulSeparated(output) {
  return output.split('\0').filter(Boolean);
}

export async function hasTrackedChanges(dir, files) {
  const rels = relativePaths(dir, files);
  if (!rels.length) return false;
  const { stdout } = await git(
    ['--literal-pathspecs', 'status', '--porcelain=v1', '--untracked-files=no', '--no-renames', '-z', '--', ...rels],
    dir, { rawStdout: true },
  );
  return stdout.length > 0;
}

async function untrackedPaths(dir, rels) {
  const { stdout } = await git(
    ['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z', '--', ...rels],
    dir, { rawStdout: true },
  );
  return nulSeparated(stdout);
}

async function restoreIntents(dir, paths) {
  const { stdout } = await git(
    ['--literal-pathspecs', 'diff', '--no-renames', '--name-only', '--diff-filter=A', '-z', '--', ...paths],
    dir, { rawStdout: true },
  );
  const pending = nulSeparated(stdout);
  if (pending.length) await git(['update-index', '--force-remove', '--', ...pending], dir);
}

/** 提交指定文件；返回 {sha, branch, files} */
export async function commitFiles(dir, files, message, { author } = {}) {
  const rels = relativePaths(dir, files);
  if (!rels.length) return { sha: null, branch: await currentBranch(dir), files: [] };
  const untracked = await untrackedPaths(dir, rels);
  const args = ['--literal-pathspecs', 'commit', '--only', '-q', '-m', message];
  if (author?.name && author?.email) args.push('--author', `${author.name} <${author.email}>`);

  let committed = false;
  try {
    // Git 的部分提交需要在索引中识别新路径，意向条目避免暂存文件内容。
    if (untracked.length) await git(['--literal-pathspecs', 'add', '-N', '--', ...untracked], dir);
    const preview = await git(
      ['--literal-pathspecs', 'commit', '--only', '--dry-run', '--porcelain', '--branch', '-uno', '--', ...rels],
      dir, { allowFail: true },
    );
    if (!preview.ok) {
      // 状态输出的分支行区分了无改动和 Git 在生成状态之前拒绝了提交。
      if (preview.code === 1 && preview.stdout.startsWith('## ')) {
        return { sha: null, branch: await currentBranch(dir), files: rels };
      }
      throw new Error(`提交预检失败：${preview.stderr || preview.stdout}`);
    }
    const result = await git([...args, '--', ...rels], dir, { allowFail: true });
    if (!result.ok) throw new Error(`提交失败：${result.stderr || result.stdout}`);
    committed = true;
  } finally {
    if (!committed && untracked.length) await restoreIntents(dir, untracked);
  }
  const { stdout: sha } = await git(['rev-parse', '--short', 'HEAD'], dir);
  return { sha, branch: await currentBranch(dir), files: rels };
}

function countDiffLines(output) {
  return output.split('\0').reduce((sum, entry) => {
    const [add, del] = entry.split('\t', 2);
    return sum + (Number(add) || 0) + (Number(del) || 0);
  }, 0);
}

/** 统计指定工作树路径相对 HEAD 的增删行数，包含尚未跟踪的新文件。 */
export async function workingDiffLines(dir, files) {
  const rels = relativePaths(dir, files);
  if (!rels.length) return 0;
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], dir, { allowFail: true });
  const base = head.ok ? head.stdout : (await git(['hash-object', '-t', 'tree', '--stdin'], dir)).stdout;
  const diffOptions = ['--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z'];
  const tracked = await git(['--literal-pathspecs', 'diff', ...diffOptions, base, '--', ...rels], dir);
  let lines = countDiffLines(tracked.stdout);
  for (const file of await untrackedPaths(dir, rels)) {
    const diff = await git(['diff', '--no-index', ...diffOptions, '--', '/dev/null', file], dir, { allowFail: true });
    if (!diff.ok && (diff.code !== 1 || !diff.stdout)) {
      throw new Error(`读取 ${file} 的改动失败：${diff.stderr || diff.stdout}`);
    }
    lines += countDiffLines(diff.stdout);
  }
  return lines;
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
