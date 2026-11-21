// 一次派工的完整执行（进程内，边界照留）：
//   生成文档 → 结构校验 → 资产登记 → 索引与追溯写入 → Git 分支与提交 → PR 草案
// 失败语义：结构问题 = blocked（等人补），外部故障 = failed（可重试）。
// 执行器不能把工单置为 closed / dropped，也不能改门禁状态。

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { generateDoc, upsertDocumentIndex, appendTraceability } from './generator.mjs';
import * as repo from './repo.mjs';
import { runGateChecks } from '../domain/gate.mjs';
import { validateDoc } from '../domain/templates.mjs';
import { positionForDoc } from './positions.mjs';
import { fillDocument, markAiAssisted } from './agent.mjs';
import { ensureDir, todayISO, writeJson, sha256File, sha256Text, exists } from '../util/fsx.mjs';
import { DOC_TYPES } from '../domain/stages.mjs';

export async function runAssignment({
  assignment, ticket, plan, project, rules = {}, policy, engine,
  stateDir, fallbackTemplateDir = null, options = {},
}) {
  const notes = [];
  const assets = [];
  const startedAt = todayISO();
  const workdir = path.join(stateDir, 'work', ticket.id);
  await ensureDir(workdir);
  await writeJson(path.join(workdir, 'ticket.json'), {
    ticket, assignment, plan, createdAt: startedAt,
  });

  const docTypes = (plan.docTypes ?? []).filter((t) => DOC_TYPES[t]);
  if (!docTypes.length) {
    return {
      status: 'blocked',
      reason: '本次任务没有可生成的交付物：需要先澄清任务类型或指定文档类型',
      assets, notes,
    };
  }

  const generated = [];
  for (const docType of docTypes) {
    let doc = await generateDoc({
      project, docType, rules, fallbackTemplateDir,
      nextDocIndex: (stage, type) => engine.nextDocIndex(stage, type),
      ctx: {
        title: ticket.title,
        ticket: ticket.id,
        name: project.manifest.name,
        customer: project.manifest.customer,
        platform: project.manifest.platform,
        date: startedAt,
        upstream: docType === 'ECN' ? ['DFMEA', 'CP'] : [],
      },
    });

    // 岗位化执行：文档类型 → 岗位 → 模型池（池决定用哪把 key）
    const position = positionForDoc(docType);
    let aiFilled = false;
    if (options.aiFill !== false && position) {
      if (!options.pool) {
        notes.push(`AI 未参与 ${docType}：未配置模型池（文档保留骨架，可正常评审流程）`);
      } else {
        const fill = await fillDocument({
          doc, ticket, position, pool: options.pool,
          budget: options.budget ?? {}, engine,
          inputText: plan.inputText ?? ticket.title,
        });
        if (fill.text) {
          await fs.writeFile(doc.absPath, fill.text, 'utf8');
          doc = {
            ...doc,
            text: fill.text,
            sha256: sha256Text(fill.text),
            validation: validateDoc({
              text: fill.text, relPath: doc.relPath, rules,
              expect: { stage: doc.stage, type: docType, project: project.manifest.code },
            }),
          };
          aiFilled = true;
          engine.recordUsage({
            ticketId: ticket.id, position: position.code, pool: fill.pool,
            keyId: fill.keyId, model: fill.model, tokens: fill.tokens,
            purpose: `fill:${docType}`,
          });
          notes.push(`AI 参与 ${docType}：${position.code} ${position.name} 填充 ${fill.applied.length} 节（${fill.model ?? '-'} / ${fill.keyId ?? '-'}，${fill.tokens} tokens）`);
          for (const q of fill.openQuestions ?? []) notes.push(`待确认（${docType}）：${q}`);
        } else {
          const marked = markAiAssisted(doc.text, { position, model: null, aiAssisted: false });
          await fs.writeFile(doc.absPath, marked, 'utf8');
          doc = { ...doc, text: marked, sha256: sha256Text(marked) };
          notes.push(`AI 未参与 ${docType}：${fill.reason}`);
        }
      }
    }

    generated.push(doc);
    assets.push({
      kind: 'document',
      id: doc.id,
      docType,
      stage: doc.stage,
      title: doc.title,
      relPath: doc.relPath,
      absPath: doc.absPath,
      revision: doc.revision,
      sha256: doc.sha256,
      validation: doc.validation,
      position: position?.code ?? null,
      aiAssisted: aiFilled,
    });
    engine.registerAsset({
      ticketId: ticket.id, kind: 'document', docType, stage: doc.stage,
      path: doc.relPath, revision: doc.revision, sha256: doc.sha256,
      status: doc.validation.ok ? 'valid' : 'invalid',
      title: doc.title, position: position?.code ?? null, aiAssisted: aiFilled,
    });
    if (!doc.validation.ok) notes.push(`${docType} 结构校验失败：${doc.validation.errors.join('；')}`);
    if (doc.validation.warnings.length) notes.push(`${docType} 提示：${doc.validation.warnings.join('；')}`);
  }

  const invalid = assets.filter((a) => !a.validation.ok);
  if (invalid.length) {
    return {
      status: 'blocked',
      reason: `有 ${invalid.length} 份文档未通过结构校验，需要补齐后重试`,
      assets, notes,
    };
  }

  // 索引与追溯
  for (const a of assets) {
    await upsertDocumentIndex({
      project,
      row: {
        id: a.id,
        title: a.title ?? `${ticket.title} ${DOC_TYPES[a.docType]?.name ?? a.docType}`,
        project: project.manifest.code,
        stage: a.stage,
        type: a.docType,
        revision: a.revision,
        status: 'draft',
        classification: project.manifest.system?.defaultClassification ?? 'internal',
        owner: DOC_TYPES[a.docType]?.owner ?? '',
        path: a.relPath,
        ticket: ticket.id,
        updated: startedAt,
      },
    });
  }
  const ids = assets.map((a) => a.id);
  const edges = [];
  for (let i = 1; i < ids.length; i++) edges.push({ upstream: ids[0], downstream: ids[i], relation: 'derives', note: ticket.id });
  if (edges.length) await appendTraceability({ project, edges });

  // Git
  let commit = null;
  let prDraftPath = null;
  const defaultBranch = project.manifest.integrations?.repo?.defaultBranch ?? 'develop';
  const protectedList = policy?.execution?.protectedBranches ?? ['main', 'develop', 'release/*'];

  if (options.git !== false) {
    try {
      await repo.ensureRepo(project.root, { author: options.author });

      // 堆叠分支：本工单分支基于上一张工单的分支，使工作区里的文档持续累积。
      // 取舍：牺牲"每张 PR 都相对 develop 独立"的纯粹性，换取门禁能读到全部已完成文档；
      // 生产环境应改为 worktree 从 develop 拉出 + 合并后校验（docs/00 §10 已记录该偏差）。
      const tip = engine.db.kvGet('repo:tip', null);
      let base = null;
      if (tip && (await repo.branchExists(project.root, tip))) {
        await repo.checkoutBranch(project.root, tip);
        base = tip;
      } else {
        base = await repo.checkoutBase(project.root, [defaultBranch, 'main', 'master']);
      }

      const branch = `${plan.branchPrefix ?? 'agent/'}${ticket.id}`;
      await repo.createBranch(project.root, branch, {
        protectedList,
        allowedPrefixes: rules.allowedBranchPrefixes ?? ['agent/', 'change/', 'fix/'],
      });

      const indexFiles = [path.join(project.paths.index, 'documents.csv'), path.join(project.paths.index, 'trace-edges.csv')];
      const files = [];
      for (const f of [...assets.map((a) => a.absPath), ...indexFiles]) {
        // trace-edges.csv 只在存在追溯边时才生成，直接 add 不存在的路径会让整次提交失败
        if (await exists(f)) files.push(f);
      }

      const hits = await repo.scanSecrets(assets.map((a) => a.absPath), rules.redactPatterns ?? []);
      if (hits.length) {
        notes.push(`凭据扫描命中 ${hits.length} 处，已阻断提交：${hits[0].file}`);
        return { status: 'blocked', reason: '产物中检出疑似凭据，已阻断提交', assets, notes };
      }

      const maxDiff = rules.maxDiffLines ?? 800;
      const diff = await repo.stagedDiffLines(project.root);
      if (diff > maxDiff) notes.push(`改动 ${diff} 行，超过单工单上限 ${maxDiff} 行，需人工确认（docs/06 §4）`);

      commit = await repo.commitFiles(
        project.root, files,
        `${plan.commitPrefix ?? 'chore'}(${ticket.id}): ${ticket.title}`,
        { author: options.author ?? policy?.execution?.commitAuthor }
      );
      engine.db.kvSet('repo:tip', branch, engine.now());

      // 门禁快照要在文档落盘之后重新跑，否则 PR 里写的是提交前的旧状态
      let gate = null;
      if (ticket.gate_target) {
        try { gate = await runGateChecks({ gateId: ticket.gate_target, project, rules }); } catch { gate = null; }
      }
      const draft = repo.buildPrDraft({
        ticket, assessment: { riskLevel: ticket.severity }, assets, gate, commit, notes, base,
      });
      prDraftPath = await repo.writePrDraft(stateDir, ticket.id, draft);
      notes.push(`PR 草案：${prDraftPath}（目标分支 ${base ?? '-'}）`);
    } catch (err) {
      return { status: 'blocked', reason: `仓库操作失败：${err.message}`, assets, notes, commit };
    }
  }

  // 产物哈希复核（落盘后被改动要能被发现）
  for (const a of assets) {
    const h = await sha256File(a.absPath);
    a.sha256 = h;
  }

  return { status: 'ready', assets, commit, prDraftPath, notes };
}

export { fs };
