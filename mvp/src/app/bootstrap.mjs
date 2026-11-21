// 初始化项目骨架：复制 scaffold/ 与 templates/，填占位符，建启用阶段的目录，初始化 Git 基线。
// 与 scripts/new-project.sh 同源（同一份 scaffold 与 templates），避免两套骨架漂移。

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureDir, exists, copyDir, readFileSafe, writeFileAtomic } from '../util/fsx.mjs';
import { execFile } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(HERE, '../../..');

const STAGE_DIRS = {
  S1: ['docs/S1-策划/CHTR', 'docs/S1-策划/SRS', 'docs/S1-策划/APQP', 'docs/S1-策划/FEAS'],
  S2: ['docs/S2-产品设计/DFMEA', 'docs/S2-产品设计/DVP', 'docs/S2-产品设计/SC'],
  S3: ['docs/S3-过程设计/PFC', 'docs/S3-过程设计/PFMEA', 'docs/S3-过程设计/CP'],
  S4: ['docs/S4-验证/MSA', 'docs/S4-验证/SPC', 'docs/S4-验证/TR', 'docs/S4-验证/PPAP'],
  S5: ['docs/S5-量产/8D', 'docs/S5-量产/ECN'],
};

const BASE_DIRS = [
  'hardware/bom', 'hardware/schematic', 'hardware/pcb', 'hardware/mechanical',
  'hardware/fixture', 'hardware/datasheet', 'hardware/_released',
  'firmware/app', 'firmware/drivers', 'firmware/bsp', 'firmware/bootloader', 'firmware/config',
  'software/tools', 'software/host',
  'test/unit', 'test/hil', 'test/data',
  'evidence', 'tools/validators',
  'docs/_templates', 'docs/_index',
];

function git(args, cwd, allowFail = true) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout ?? '').trim(), err: String(stderr ?? '').trim() });
    });
  });
}

export async function bootstrapProject({
  targetDir, code, name, owner = '', customer = '', platform = '', stages = ['S1'], gitInit = true, acceptMode = null,
}) {
  if (!/^[A-Z][A-Z0-9]{1,7}$/.test(code)) {
    throw new Error(`项目代号不合规：${code}（2-8 位大写字母数字，首字符为字母）`);
  }
  const enabled = [...new Set(stages.map((s) => String(s).toUpperCase()))];
  const bad = enabled.filter((s) => !STAGE_DIRS[s]);
  if (bad.length) throw new Error(`非法阶段：${bad.join(',')}（可选 S1..S5）`);

  if (await exists(targetDir)) {
    const entries = await fs.readdir(targetDir);
    if (entries.length) throw new Error(`目标目录已存在且非空：${targetDir}`);
  }
  await ensureDir(targetDir);

  const scaffold = path.join(PACKAGE_ROOT, 'scaffold');
  const templates = path.join(PACKAGE_ROOT, 'templates');
  if (!(await exists(scaffold))) throw new Error(`缺少骨架模板目录：${scaffold}`);

  const vars = {
    '{{CODE}}': code,
    '{{codeLower}}': code.toLowerCase(),
    '{{NAME}}': name || code,
    '{{PLATFORM}}': platform || code.slice(0, 3),
    '{{CUSTOMER}}': customer || '-',
    '{{OWNER_NAME}}': owner || '-',
  };
  const transform = (text) => Object.entries(vars).reduce((acc, [k, v]) => acc.split(k).join(v), text);

  await copyDir(scaffold, targetDir, { transform });

  // 模板副本：项目可定制，但来源只有一份
  const tplFiles = (await fs.readdir(templates)).filter((f) => f.endsWith('.md') && f !== 'README.md');
  for (const f of tplFiles) {
    await ensureDir(path.join(targetDir, 'docs/_templates'));
    await fs.copyFile(path.join(templates, f), path.join(targetDir, 'docs/_templates', f));
  }

  for (const d of BASE_DIRS) await ensureDir(path.join(targetDir, d));
  for (const s of enabled) for (const d of STAGE_DIRS[s]) await ensureDir(path.join(targetDir, d));

  // manifest：阶段与门禁跟着 enabled 走
  const manifestFile = path.join(targetDir, '.superagent/manifest.yml');
  let manifest = await readFileSafe(manifestFile, '');
  manifest = manifest.replace(/^(\s*)enabled:\s*\[[^\]]*\]/m, `$1enabled: [${enabled.join(', ')}]`);
  await writeFileAtomic(manifestFile, manifest);

  // 默认开启的策略：示例策略原样复制，项目再按真实 open_id 改
  const policySrc = path.join(PACKAGE_ROOT, 'config/policy.example.yml');
  if (await exists(policySrc)) {
    await ensureDir(path.join(targetDir, '.superagent'));
    let text = await readFileSafe(policySrc, '');
    if (acceptMode) {
      if (!['off', 'observe', 'auto'].includes(acceptMode)) throw new Error(`acceptMode 非法：${acceptMode}`);
      text = text.replace(/^acceptMode:\s*\S+/m, `acceptMode: ${acceptMode}`);
    }
    await writeFileAtomic(path.join(targetDir, '.superagent/policy.yml'), text);
  }

  // 运行时目录（不进 Git，但先建好，省得首次运行再报错）
  await ensureDir(path.join(targetDir, '.state'));
  await ensureDir(path.join(targetDir, '.inbox'));
  await ensureDir(path.join(targetDir, '.outbox'));

  let gitResult = { ok: false, skipped: true };
  if (gitInit) {
    await git(['init', '-q', '-b', 'main'], targetDir);
    await git(['config', 'user.name', 'electronics-superagent'], targetDir);
    await git(['config', 'user.email', 'agent@example.com'], targetDir);
    await git(['add', '-A'], targetDir);
    const c = await git(['commit', '-q', '-m', `chore: 初始化 ${code} 工程骨架（baseline-v0.0.1）`], targetDir);
    await git(['tag', 'baseline-v0.0.1'], targetDir);
    await git(['branch', 'develop'], targetDir);
    gitResult = { ok: c.ok, branch: 'main', tag: 'baseline-v0.0.1' };
  }

  return {
    targetDir, code, enabled, git: gitResult,
    files: (await fs.readdir(targetDir)).length,
    next: [
      'superagent run --dir <项目目录>            # 启动（含面板）',
      'superagent say --dir <项目目录> --as ou_xxx1 "客户投诉 ... 请开 8D"',
      'superagent verify --dir <项目目录>         # 全量校验',
    ],
  };
}
