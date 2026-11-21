// CLI 实现。真正的入口是 src/cli.mjs（负责屏蔽 node:sqlite 的实验性警告后动态加载本文件）。
// 每个命令都有可断言的退出码（docs/00 §6.5）：0 正常 / 1 需重启 / 2 部件错误 / 3 待配置

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bootstrapProject, PACKAGE_ROOT } from './app/bootstrap.mjs';
import { Runtime } from './app/runtime.mjs';
import { createPanelServer } from './panel/server.mjs';
import { loadProject, loadPolicy, assertStricter, effectiveRules } from './config/load.mjs';
import { validateDoc, parseFrontMatter } from './domain/templates.mjs';
import { runGateChecks } from './domain/gate.mjs';
import { STAGES, DOC_TYPES } from './domain/stages.mjs';
import { classify, checkPlacement } from './executor/asset-router.mjs';
import { walk, exists, readFileSafe, rel } from './util/fsx.mjs';
import { parseCsv } from './util/csv.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const OK = () => C.green('✅');
const NO = () => C.red('❌');

function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  return [C.dim(line(headers)), ...rows.map((r) => line(r))].join('\n');
}

function need(args, key, message) {
  if (!args[key]) {
    console.error(`${NO()} ${message}`);
    process.exit(2);
  }
  return args[key];
}

// ---------------------------------------------------------------- 命令

async function cmdInit(args) {
  const dir = path.resolve(args.dir ?? path.join(process.cwd(), args.code ?? 'project'));
  const stages = String(args.stages ?? 'S1,S2,S3,S4,S5').split(',').map((s) => s.trim().toUpperCase());
  const res = await bootstrapProject({
    targetDir: dir,
    code: need(args, 'code', 'init 需要 --code（2-8 位大写字母数字）'),
    name: args.name ?? '',
    owner: args.owner ?? '',
    customer: args.customer ?? '',
    platform: args.platform ?? '',
    stages,
    gitInit: args['no-git'] !== true,
    // 演示/试点常用：把接入模式改成 auto，否则只会记录"本会接"
    acceptMode: args['accept-mode'] ?? null,
  });

  console.log(`${OK()} 已生成项目 ${C.bold(res.code)} → ${dir}`);
  console.log(`   启用阶段：${res.enabled.join(', ')}`);
  if (res.git.ok) console.log(`   Git：main（tag baseline-v0.0.1）+ develop`);
  else console.log(C.yellow('   Git 未初始化（--no-git 或缺 git）'));
  console.log('\n下一步：');
  for (const n of res.next) console.log('  ' + n);
  return 0;
}

async function cmdSay(args) {
  const dir = path.resolve(need(args, 'dir', 'say 需要 --dir'));
  const text = args._.slice(1).join(' ').trim();
  if (!text) { console.error(`${NO()} 缺少消息正文`); return 2; }
  const inbox = path.join(dir, '.inbox');
  await fs.mkdir(inbox, { recursive: true });
  const id = args.id ?? `loc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const payload = {
    id,
    actorId: args.as ?? 'ou_xxx1',
    actorName: args.name ?? null,
    chatId: args.chat ?? 'oc_aaa',
    text,
    at: new Date().toISOString(),
    addressed: args['not-addressed'] ? false : true,
    threadId: args.thread ?? undefined,
  };
  await fs.writeFile(path.join(inbox, `${id}.json`), JSON.stringify(payload, null, 2), 'utf8');
  console.log(`${OK()} 已投递 ${C.dim(id)}（${payload.actorId} @ ${payload.chatId}）`);
  return 0;
}

async function cmdRun(args) {
  const dir = path.resolve(need(args, 'dir', 'run 需要 --dir'));
  const runtime = await Runtime.create({ dir, options: { source: args.source ?? 'local', policyFile: args.policy } });
  const s = runtime.status();
  console.log(`${C.bold('electronics-superagent')} ${s.project.code} · 来源 ${s.source.kind} · 策略 ${s.policy.acceptMode} · 模型 ${s.model.gateway}`);
  if (s.model.pools?.length) {
    console.log(`   岗位池：${s.model.pools.map((p) => `${p.pool}×${p.keys}（${p.models.join('/') || '-'}）`).join('　')}`);
  } else {
    console.log(C.dim('   未配置模型池：流程照跑，文档只出骨架'));
  }
  if (s.source.error) console.log(C.yellow(`   ${s.source.error}`));

  let panel = null;
  if (args['no-panel'] !== true && args.once !== true) {
    panel = createPanelServer({ runtime, port: Number(args.port ?? 8787) });
    const { url } = await panel.listen();
    console.log(`   运行面板：${C.cyan(url)}`);
    console.log(`   工作台：  ${C.cyan(url + '/admin')}`);
  }

  const ac = new AbortController();
  process.on('SIGINT', () => { ac.abort(); });
  process.on('SIGTERM', () => { ac.abort(); });

  try {
    const rounds = await runtime.run({
      once: args.once === true,
      intervalMs: Number(args.interval ?? 1500),
      signal: ac.signal,
      onTick: (sum) => {
        const bits = [];
        if (sum.received) bits.push(`收 ${sum.received}`);
        if (sum.duplicate) bits.push(`重 ${sum.duplicate}`);
        if (sum.evaluated) bits.push(`评 ${sum.evaluated}`);
        if (sum.accepted) bits.push(`接 ${sum.accepted}`);
        if (sum.executed) bits.push(`执行 ${sum.executed}`);
        if (sum.rejected) bits.push(`拒 ${sum.rejected}`);
        if (bits.length) console.log(C.dim(`   [${new Date().toISOString().slice(11, 19)}] ${bits.join(' · ')}`));
        for (const e of sum.errors ?? []) console.log(C.red(`   ! ${e}`));
      },
    });
    const final = runtime.status();
    const last = rounds.at(-1) ?? {};
    console.log('');
    console.log(`工单 ${final.stats.tickets} · 待签署 ${final.stats.pendingSignatures} · 文档 ${final.stats.assets} · 拒绝 ${final.stats.rejected}`);
    if (last.gates?.length) {
      for (const g of last.gates) console.log(`  ${g.status === 'pending' ? C.yellow('待签署') : g.status === 'released' ? C.green('已放行') : C.dim(g.status)}  ${g.id} ${g.name}`);
    }
    return final.gateExitCode;
  } finally {
    if (panel) await panel.close();
    await runtime.close();
  }
}

async function cmdStatus(args) {
  const dir = path.resolve(need(args, 'dir', 'status 需要 --dir'));
  const runtime = await Runtime.create({ dir, options: { source: args.source ?? 'local', policyFile: args.policy } });
  const s = runtime.status();
  if (args.json) console.log(JSON.stringify(s, null, 2));
  else {
    console.log(`${C.bold(s.project.code)} ${s.project.name}`);
    console.log(`  来源      ${s.source.kind}${s.source.ready ? '' : C.red('（未就绪）')}`);
    console.log(`  策略      ${s.policy.version} · ${s.policy.acceptMode} · 白名单 ${s.policy.whitelist} 人`);
    const poolTxt = s.model.pools?.length ? s.model.pools.map((p) => `${p.pool}×${p.keys}`).join(' ') : '未配置池（不生成内容）';
    console.log(`  模型      ${s.model.gateway} · ${poolTxt} · 今日 ${s.usage?.tokens ?? 0} tokens`);
    console.log(`  工单      ${s.stats.tickets}（进行中 ${s.stats.openTickets}，阻塞 ${s.stats.blockedTickets}）`);
    console.log(`  待签署    ${s.stats.pendingSignatures}`);
    console.log(`  文档      ${s.stats.assets}`);
    console.log(`  退出码    ${s.gateExitCode === 0 ? C.green(0) : C.yellow(s.gateExitCode)} — ${s.reason}`);
    for (const e of s.errors) console.log(C.red(`  ! ${e}`));
  }
  await runtime.close();
  return s.gateExitCode;
}

async function cmdTickets(args) {
  const dir = path.resolve(need(args, 'dir', 'tickets 需要 --dir'));
  const runtime = await Runtime.create({ dir, options: { policyFile: args.policy } });
  try {
    if (args.id) {
      const h = runtime.engine.history(String(args.id));
      if (!h) { console.error(`${NO()} 找不到工单 ${args.id}`); return 2; }
      const t = h.ticket;
      console.log(`${C.bold(t.id)} ${t.title}`);
      console.log(`  状态 ${t.status} · 类型 ${t.task_type} · 阶段 ${t.stage} · 门禁 ${t.gate_target ?? '-'}`);
      console.log(`  授权 ${h.ticket.mandate?.id ?? '-'} 范围 ${h.ticket.mandate?.stage_scope ?? '-'} 动作 ${(h.ticket.mandate?.actionScope ?? []).join(',')}`);
      console.log('\n  触发：');
      for (const tr of h.triggers) console.log(`    ${C.dim(tr.at.slice(0, 19))} ${tr.actor_id}: ${tr.body.slice(0, 60)}`);
      console.log('\n  评估：');
      if (h.eval) console.log(`    ${h.eval.id} ${h.eval.status} · ${h.eval.reason ?? ''}`);
      console.log('\n  派工与回报：');
      for (const a of h.assignments) console.log(`    ${a.id} ${a.status}${a.note ? ` — ${a.note.slice(0, 90)}` : ''}`);
      for (const r of h.reports) console.log(`    ${C.dim(r.at.slice(0, 19))} [${r.kind}] ${(r.body ?? '').slice(0, 100)}`);
      console.log('\n  产物：');
      for (const a of h.assets) console.log(`    ${a.path} ${C.dim(a.doc_type ?? '')} ${a.revision ?? ''} ${a.status}`);
      return 0;
    }
    const rows = runtime.engine.listTickets({ limit: 50 }).map((t) => [t.id, t.task_type, t.stage, t.status, t.title.slice(0, 30)]);
    console.log(rows.length ? table(rows, ['编号', '类型', '阶段', '状态', '标题']) : '还没有工单。');
    return 0;
  } finally {
    await runtime.close();
  }
}

async function cmdGate(args) {
  const dir = path.resolve(need(args, 'dir', 'gate 需要 --dir'));
  const sub = args._[1] ?? 'list';
  const runtime = await Runtime.create({ dir, options: { policyFile: args.policy } });
  try {
    if (sub === 'list') {
      const rows = runtime.engine.listGates().map((g) => [g.id, g.name, g.status, g.signed_by ?? '-', (g.checks ?? []).filter((c) => !c.ok).length + ' 项缺口']);
      console.log(rows.length ? table(rows, ['门', '名称', '状态', '签署人', '缺口']) : '尚未生成门禁（先跑 run 或 gate check）。');
      return 0;
    }
    if (sub === 'check') {
      const gateId = args._[2] ?? 'G1';
      const res = await runGateChecks({ gateId, project: await loadProject(dir), rules: effectiveRules((await loadProject(dir)).rules) });
      console.log(`${C.bold(gateId)} ${res.name} → ${res.status === 'pending' ? C.yellow('待签署') : C.red('检查未通过')}`);
      for (const c of res.checks) {
        console.log(`  ${c.ok ? OK() : c.skipped ? C.yellow('○') : NO()} ${c.id}  ${C.dim(c.detail ?? '')}`);
      }
      return res.status === 'pending' ? 0 : 2;
    }
    if (sub === 'sign') {
      const gateId = args._[2] ?? 'G1';
      const who = need(args, 'as', 'gate sign 需要 --as <open_id>');
      try {
        const g = runtime.engine.signGate(gateId, { actorId: who, note: args.note ?? null });
        console.log(`${OK()} ${gateId} 已由 ${g.signed_by} 放行（${g.signed_at}）`);
        return 0;
      } catch (err) {
        console.error(`${NO()} ${err.message}`);
        return err.code === 'gate/forbidden' ? 1 : 2;
      }
    }
    if (sub === 'return') {
      const gateId = args._[2] ?? 'G1';
      const who = need(args, 'as', 'gate return 需要 --as <open_id>');
      runtime.engine.returnGate(gateId, { actorId: who, reason: args.reason ?? '退回' });
      console.log(`${OK()} ${gateId} 已退回`);
      return 0;
    }
    console.error(`未知子命令：${sub}（list|check|sign|return）`);
    return 2;
  } finally {
    await runtime.close();
  }
}

/**
 * 存量迁移校验模式（docs/10 §4 P5）：
 *  strict 任何错位都失败（新建项目默认）
 *  legacy 只有 import-map.csv 已登记的存量件被豁免落位，其余按 strict；未登记件告警不失败
 *  report 全部只告警不失败
 *  auto（默认）存在 import-map.csv 时选 legacy，否则 strict
 */
async function resolveVerifyMode(args, dir) {
  const requested = args.mode === true ? 'auto' : args.mode;
  if (requested && !['strict', 'legacy', 'report', 'auto'].includes(requested)) {
    console.error(`${NO()} --mode 非法：${requested}（可选 strict|legacy|report|auto）`);
    process.exit(2);
  }
  if (requested && requested !== 'auto') return requested;
  // scaffold 给新项目也放了一份空 import-map.csv，只有含数据行的才代表"存量迁移项目"
  const mapFile = path.join(dir, 'docs/_index/import-map.csv');
  if (!(await exists(mapFile))) return 'strict';
  const rows = parseCsv(await readFileSafe(mapFile, ''));
  return rows.length > 1 ? 'legacy' : 'strict';
}

async function loadLegacyPaths(dir) {
  const mapFile = path.join(dir, 'docs/_index/import-map.csv');
  if (!(await exists(mapFile))) return new Set();
  const rows = parseCsv(await readFileSafe(mapFile, ''));
  const set = new Set();
  for (const r of rows.slice(1)) {
    const p = r[0];
    if (p) set.add(String(p).replace(/\\/g, '/'));
  }
  return set;
}

async function cmdVerify(args) {
  const dir = path.resolve(need(args, 'dir', 'verify 需要 --dir'));
  const mode = await resolveVerifyMode(args, dir);
  const legacyPaths = mode === 'legacy' || mode === 'report' ? await loadLegacyPaths(dir) : new Set();
  const problems = [];
  const warnings = [];
  const checked = { docs: 0, files: 0, gates: 0, legacyExempt: 0 };
  const addIssue = (msg) => (mode === 'strict' ? problems : warnings).push(msg);

  const project = await loadProject(dir);
  const { policy, errors: policyErrors } = await loadPolicy(
    (await exists(path.join(dir, '.superagent/policy.yml')))
      ? path.join(dir, '.superagent/policy.yml')
      : path.join(PACKAGE_ROOT, 'config/policy.example.yml')
  );
  for (const e of policyErrors) problems.push(`策略：${e}`);
  const strict = assertStricter(project.rules);
  for (const e of strict.errors) problems.push(`规则：${e}`);
  const rules = effectiveRules(project.rules, policy);

  // 文档结构与 path/id 自洽
  const mdFiles = (await walk(path.join(dir, 'docs'), { filter: (p) => p.endsWith('.md') }))
    .filter((p) => !p.includes(`${path.sep}_templates${path.sep}`) && !p.includes(`${path.sep}_index${path.sep}`));
  for (const f of mdFiles) {
    const relPath = rel(dir, f);
    const parts = relPath.split('/');
    const stage = String(parts[1] ?? '').slice(0, 2);
    const type = parts[2] ?? '';
    if (!STAGES[stage] || !DOC_TYPES[type]) { addIssue(`${relPath}：路径不符合 docs/<阶段>/<类型>/ 约定`); continue; }
    const text = await readFileSafe(f, '');
    const v = validateDoc({ text, relPath, rules, expect: { stage, type, project: project.manifest.code } });
    checked.docs += 1;
    if (!v.ok) addIssue(`${relPath}：${v.errors.join('；')}`);
  }

  // 资产落位：legacy/report 模式下，import-map 已登记的存量件按 docs/10 §4 P5 豁免
  const allFiles = await walk(dir, { filter: (p) => !p.includes(`${path.sep}.git${path.sep}`) });
  for (const f of allFiles) {
    const relPath = rel(dir, f);
    if (relPath.startsWith('docs/') || relPath.startsWith('.superagent/') || relPath.startsWith('.state/')) continue;
    const c = checkPlacement(relPath);
    checked.files += 1;
    if (!c.ok) {
      if (legacyPaths.has(relPath)) {
        checked.legacyExempt += 1;
        warnings.push(`${relPath}：存量件落位豁免（import-map 已登记）— ${c.reason}`);
      } else {
        addIssue(`${relPath}：${c.reason}`);
      }
    }
  }

  // 门禁：只检查"已开工"的阶段。项目在 S1 时 S2 无交付物属正常，不是问题
  let notStarted = 0;
  for (const g of project.manifest.stages?.enabled ?? []) {
    const gateId = `G${Number(g.slice(1))}`;
    if (gateId === 'G5') continue;
    try {
      const res = await runGateChecks({ gateId, project, rules });
      checked.gates += 1;
      const docs = Object.values(res.evidence?.docs ?? {});
      const allMissing = docs.length > 0 && docs.every((v) => !v);
      if (allMissing) { notStarted += 1; continue; }
      if (res.status !== 'pending') {
        const gaps = res.checks.filter((c) => !c.ok && !c.skipped);
        if (gaps.length) addIssue(`${gateId}：${gaps.map((c) => c.detail).join('；')}`);
      }
    } catch (err) {
      addIssue(`${gateId}：${err.message}`);
    }
  }

  console.log(`${C.bold('校验')} ${dir}  ${C.dim(`[${mode}]`)}`);
  console.log(`  文档 ${checked.docs} 份 · 文件 ${checked.files} 个 · 门禁 ${checked.gates} 个${notStarted ? `（${notStarted} 个阶段未启动，跳过）` : ''}${checked.legacyExempt ? ` · 存量豁免 ${checked.legacyExempt}` : ''}`);
  if (warnings.length) {
    console.log(`  ${C.yellow('⚠')} ${warnings.length} 项告警（不阻断）`);
    for (const w of warnings.slice(0, 10)) console.log(`    · ${w}`);
    if (warnings.length > 10) console.log(C.dim(`    …另有 ${warnings.length - 10} 项告警`));
  }
  if (!problems.length) {
    console.log(`  ${OK()} 全部通过`);
    return 0;
  }
  console.log(`  ${NO()} ${problems.length} 项问题`);
  for (const p of problems.slice(0, 40)) console.log(`    · ${p}`);
  if (problems.length > 40) console.log(C.dim(`    …另有 ${problems.length - 40} 项`));
  return 2;
}

async function cmdClassify(args) {
  const files = args._.slice(1);
  if (!files.length) { console.error('用法：superagent classify <文件路径...>'); return 2; }
  for (const f of files) {
    const c = classify(f);
    console.log(`${f}\n  → ${C.cyan(c.kind)} ${c.target}/  ${C.dim(c.reason)}`);
  }
  return 0;
}

async function cmdDemo(args) {
  const dir = path.resolve(args.dir ?? path.join(HERE, '..', '.demo', 'PCU24'));
  const log = [];
  const step = (s) => { log.push(s); console.log(s); };

  if (!(await exists(path.join(dir, '.superagent', 'manifest.yml')))) {
    step(`${C.bold('① 建骨架')} ${dir}`);
    await bootstrapProject({
      targetDir: dir, code: 'PCU24', name: '电机控制器 2024 平台',
      owner: '王经理', customer: '客户A', platform: 'PCU',
      stages: ['S1', 'S2', 'S3', 'S4', 'S5'],
      acceptMode: 'auto',
    });
  }

  const runtime = await Runtime.create({ dir, options: { source: 'local', git: true } });

  const say = async (id, actor, text, chat = 'oc_aaa') => {
    await fs.mkdir(path.join(dir, '.inbox'), { recursive: true });
    await fs.writeFile(path.join(dir, '.inbox', `${id}.json`), JSON.stringify({
      id, actorId: actor, chatId: chat, text, at: new Date().toISOString(), addressed: true,
    }), 'utf8');
  };

  step(`\n${C.bold('② 质量问题 → 8D')}`);
  await say('demo-8d-1', 'ou_xxx2', '客户投诉 PCU24 在 -30℃ 低温启动时偶发失效，已退货 3 台，请开 8D');
  let s = await runtime.tick();
  step(`   收 ${s.received} · 评 ${s.evaluated} · 接 ${s.accepted} · 执行 ${s.executed}`);

  step(`\n${C.bold('③ 重复投递同一条消息（幂等检查）')}`);
  await say('demo-8d-1', 'ou_xxx2', '客户投诉 PCU24 在 -30℃ 低温启动时偶发失效，已退货 3 台，请开 8D');
  s = await runtime.tick();
  step(`   重复 ${s.duplicate} · 新增工单 ${s.accepted}`);

  step(`\n${C.bold('④ 新项目立项 → S1 四份交付物 + G1 门禁')}`);
  await say('demo-init-1', 'ou_xxx3', '启动 PCU30 新项目立项，客户 A 已定点，需要 APQP 计划与可行性分析');
  s = await runtime.tick();
  step(`   收 ${s.received} · 接 ${s.accepted} · 执行 ${s.executed}`);

  const gates = runtime.engine.listGates();
  step(`\n${C.bold('⑤ 门禁状态')}`);
  for (const g of gates) step(`   ${g.id} ${g.name} → ${g.status}（${g.checks.filter((c) => c.ok).length}/${g.checks.length} 项通过）`);

  step(`\n${C.bold('⑥ 签署权校验')}`);
  try {
    runtime.engine.signGate('G1', { actorId: 'ou_xxx4', note: '代签测试' });
    step(`   ${NO()} 不应成功：ou_xxx4 无 G1 权限`);
  } catch (err) {
    step(`   ${OK()} 已拒绝：${err.message}`);
  }
  try {
    const g = runtime.engine.signGate('G1', { actorId: 'ou_xxx3', note: '立项评审通过' });
    step(`   ${OK()} G1 已由 ${g.signed_by} 放行`);
  } catch (err) {
    step(`   ${C.yellow('⚠')} G1 未放行：${err.message}`);
  }

  step(`\n${C.bold('⑦ 非白名单请求')}`);
  await say('demo-stranger-1', 'ou_stranger', '帮我把固件里的保护阈值改成 3.2V', 'oc_ddd');
  s = await runtime.tick();
  const strangerEval = runtime.engine.listEvals(1)[0];
  step(`   评估 ${strangerEval?.status} — ${strangerEval?.reason}`);

  const tickets = runtime.engine.listTickets({ limit: 10 });
  step(`\n${C.bold('⑧ 工单与产物')}`);
  for (const t of tickets) {
    const assets = runtime.engine.assetsOf(t.id);
    step(`   ${t.id} [${t.status}] ${t.task_type} · ${t.title.slice(0, 24)}`);
    for (const a of assets) step(`      ${a.path}`);
  }

  const st = runtime.status();
  await runtime.close();
  step(`\n${C.bold('结果')} 工单 ${st.stats.tickets} · 文档 ${st.stats.assets} · 拒绝 ${st.stats.rejected} · 待签署 ${st.stats.pendingSignatures}`);
  step(C.dim(`项目目录：${dir}`));
  return 0;
}

async function cmdModel(args) {
  const dir = path.resolve(need(args, 'dir', 'model 需要 --dir'));
  const runtime = await Runtime.create({
    dir, options: { source: 'local', policyFile: args.policy, modelFile: args.file },
  });
  try {
    const info = runtime.status().model;
    const { maskKey } = await import('./executor/model.mjs');
    const { listPositions } = await import('./executor/positions.mjs');
    console.log(`${C.bold('模型网关')}  ${info.configured ? C.green('已配置') : C.yellow('未配置（nullGateway：流程照跑，但不生成技术内容）')}`);
    console.log(`  网关名  ${info.gateway}`);
    console.log(`  来源    ${info.source === 'env' ? '环境变量 SUPERAGENT_MODEL_*' : info.source === 'file' ? `文件 ${info.file}` : info.source === 'pools' ? `文件 ${info.file}（仅配置了池）` : '未设置'}`);
    if (info.baseUrl) console.log(`  接口    ${info.baseUrl}`);
    console.log(`  密钥    ${info.apiKeySet ? `已设置（${maskKey(runtime.modelInfo?.apiKey)}）` : '未设置（走池内 key）'}`);
    if (info.file) console.log(`  配置文件 ${info.file}`);
    for (const w of info.warnings) console.log(C.yellow(`  ! ${w}`));

    if (info.pools?.length) {
      console.log(`\n${C.bold('密钥池')}（池 = 调用形态；失败自动换下一把）`);
      for (const p of info.pools) {
        console.log(`  ${p.pool.padEnd(7)} ${p.keys} 把  ${p.models.join(' / ') || '-'}${p.temporaryFailures ? C.yellow(`  (${p.temporaryFailures} 把暂时失败)`) : ''}`);
      }
    } else {
      console.log(C.dim('\n  未配置密钥池：所有岗位共用一把默认 key'));
    }

    console.log(`\n${C.bold('岗位 → 池')}`);
    for (const p of listPositions()) {
      console.log(`  ${p.code.padEnd(3)} ${p.name.padEnd(6)} → ${p.pool.padEnd(7)} 交付物 ${p.docTypes.join('/')}`);
    }

    if (args.check) {
      if (!info.configured) {
        console.error(`${NO()} 没有可用的模型配置，无法自检。按上面提示填写后重试。`);
        return 3;
      }
      const poolsToCheck = info.pools?.length ? info.pools.map((p) => p.pool) : ['worker'];
      let failed = 0;
      for (const poolName of poolsToCheck) {
        const t0 = Date.now();
        try {
          const r = await runtime.pool.generate({ pool: poolName, purpose: 'self-check', prompt: '只回复两个字：就绪', system: '你是连通性自检，不要解释。' });
          console.log(`${OK()} ${poolName.padEnd(7)} ${Date.now() - t0} ms · key ${r.keyId ?? '-'} · ${r.model ?? '-'} · ${String(r.text ?? '').trim().slice(0, 20)}`);
        } catch (err) {
          failed += 1;
          console.error(`${NO()} ${poolName.padEnd(7)} ${err.message}`);
        }
      }
      return failed ? 2 : 0;
    }
    return info.configured ? 0 : 3;
  } finally {
    await runtime.close();
  }
}

async function cmdHelp() {
  console.log(`${C.bold('electronics-superagent')} — 电子行业工程智能体 MVP

用法：superagent <命令> [选项]

  init      建项目骨架（--code --dir --name --stages --accept-mode）
  run       启动服务（--dir --once --port --source local|feishu --no-panel）
  status    一次健康检查（--dir --json），退出码 0/1/2/3
  say       投递一条消息（--dir --as --chat --id --not-addressed "正文"）
  tickets   列出工单；--id 看单张全链路
  gate      list | check <G> | sign <G> --as <open_id> | return <G> --as <open_id>
  model     查看模型网关配置（--dir --file），--check 发一条最小请求自检
  verify    全量校验：配置、文档结构、资产落位、门禁（--mode strict|legacy|report|auto）
  classify  查看文件会落到哪个目录
  demo      跑一遍三条场景（自动建 .demo/PCU24）

模型密钥放在哪（三选一，优先级从高到低）：
  1) 环境变量  SUPERAGENT_MODEL_BASE_URL / SUPERAGENT_MODEL_API_KEY / SUPERAGENT_MODEL_NAME
  2) 用户主目录 ~/.superagent/model.yml（推荐本机开发；不进仓库也不进 stateDir）
  3) 显式指定  model --file /path/to/model.yml

  # ~/.superagent/model.yml 示例
  baseUrl: https://api.deepseek.com/v1   # 通常以 /v1 结尾
  model: deepseek-chat
  apiKey: sk-xxxxxxxx                    # 或改用 apiKeyEnv: MY_KEY_VAR

示例：
  superagent init --dir ./pcu24 --code PCU24 --name "电机控制器" --accept-mode auto
  superagent model --dir ./pcu24 --check
  superagent say  --dir ./pcu24 --as ou_xxx2 "客户投诉 低温启动失效，请开 8D"
  superagent run  --dir ./pcu24 --once
  superagent verify --dir ./pcu24
`);
  return 0;
}

// ---------------------------------------------------------------- 入口

const COMMANDS = {
  init: cmdInit, run: cmdRun, status: cmdStatus, say: cmdSay,
  tickets: cmdTickets, gate: cmdGate, model: cmdModel, verify: cmdVerify,
  classify: cmdClassify, demo: cmdDemo, help: cmdHelp,
};

/** 目录里没有项目时，直接给出可复制的两条路（比"缺少某文件"有用得多） */
function projectHint(dirArg) {
  const dir = dirArg && dirArg !== true ? String(dirArg) : './pcu24';
  const raw = path.basename(path.resolve(dir)).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const code = /^[A-Z][A-Z0-9]{1,7}$/.test(raw) ? raw : 'PCU24';
  return [
    `这个目录还不是一个项目（找不到 .superagent/manifest.yml）。两条路选一条：`,
    ``,
    `① 新建项目（建骨架、复制模板、初始化 Git 基线）`,
    `   node src/cli.mjs init --dir ${dir} --code ${code} --name "项目名称" --stages S1,S5 --accept-mode auto`,
    `   node src/cli.mjs run  --dir ${dir}`,
    ``,
    `② 先看内置演示（不用建项目，会在 .demo/PCU24 里跑三条场景）`,
    `   node src/cli.mjs demo`,
  ].join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'help';
  const args = parseArgs(argv);
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`未知命令：${cmd}\n`);
    await cmdHelp();
    process.exit(2);
  }
  try {
    const code = await fn(args);
    process.exitCode = typeof code === 'number' ? code : 0;
  } catch (err) {
    console.error(`${NO()} ${err.message}`);
    if (err.details?.length) for (const d of err.details) console.error(`   · ${d}`);

    const missingProject = err.name === 'ConfigError' || /manifest\.yml/.test(err.message ?? '');
    if (missingProject) {
      console.error(`\n${C.yellow('提示')}\n${projectHint(args.dir)}`);
    }
    if (process.env.SUPERAGENT_DEBUG) console.error(err.stack);
    // 缺项目/缺配置属于"待配置"，与"部件出错"区分开，便于脚本判断
    process.exitCode = missingProject ? 3 : 2;
  }
}

main();
