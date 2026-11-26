import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// DSH 可能保留 junction 路径，实际源码目录才有相邻的 mvp。
const BUNDLE_DIR = path.dirname(await fs.realpath(fileURLToPath(import.meta.url)));
const ENGINE_DIR = path.resolve(BUNDLE_DIR, '../mvp/src');
const engineImport = (rel) => import(pathToFileURL(path.join(ENGINE_DIR, rel)).href);
try { await fs.access(path.join(ENGINE_DIR, 'app/runtime.mjs')); }
catch { throw new Error(`找不到 ${ENGINE_DIR} 中的引擎；请从完整 checkout 加载 dsh-bundle，或建立指向该目录的 junction`); }
const { Runtime } = await engineImport('app/runtime.mjs');
const { createPanelServer } = await engineImport('panel/server.mjs');

export const name = 'electronics-superagent';
export const inject = ['agentDefaultModel', 'agentPresets', 'agents', 'sessions', 'tools'];

// 从 ~/.superagent/feishu.env 加载飞书凭据（格式：export KEY = value）。
// 只在缺失时注入，不覆盖 DSH 进程已有的环境变量。
async function loadFeishuEnv() {
  const file = path.join(os.homedir(), '.superagent', 'feishu.env');
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key]) continue;
    let value = raw;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function log(ctx, msg) {
  try { ctx.logger.info(`[electronics-superagent] ${msg}`); }
  catch { console.log(`[electronics-superagent] ${msg}`); }
}

async function loadFirmwareSkill(config) {
  const dir = config.skillsDir || process.env.SUPERAGENT_SKILLS_DIR || path.join(BUNDLE_DIR, 'skills');
  const skillPath = path.resolve(dir, 'firmware-change/SKILL.md');
  try { return await fs.readFile(skillPath, 'utf8'); }
  catch (err) {
    throw new Error(`无法读取固件技能 ${skillPath}（${err.code ?? err.message}）；请检查 skillsDir 或 SUPERAGENT_SKILLS_DIR`);
  }
}

function buildFirmwarePrompt({ relPath, requirement, notes, original, skill }) {
  return [
    '你是项目的软件工程师，请基于给定源码生成完整的候选文件。',
    '',
    skill,
    '',
    `目标文件（相对项目根）：${relPath}`,
    `需求：${requirement}`,
    notes ? `补充约束：${notes}` : '',
    '',
    '=== 目标文件原文 ===',
    original,
  ].join('\n');
}

export function makeDshCodeModifier(ctx, config = {}, loadedSkill = null) {
  return async function dshCodeModifier({
    relPath, original, requirement, notes = '', ticketId = null,
  }) {
    const skill = loadedSkill ?? await loadFirmwareSkill(config);

    log(ctx, `code-change -> software-engineer preset: ${relPath}`);

    const agents = ctx.agents;
    const presets = ctx.agentPresets;
    if (!agents || !presets) {
      throw new Error('DSH 未提供 agents / agentPresets 服务，无法在会话内改固件');
    }

    const presetId = config.codePresetId ?? 'software-engineer';
    if (presetId !== 'software-engineer') throw new Error('固件候选生成需要 bundle 自带的 software-engineer preset');
    const preset = await presets.resolve(presetId);
    if (!preset) throw new Error(`未找到 DSH preset：${presetId}`);
    if (preset.broken) throw new Error(`DSH preset ${presetId} 未就绪：${preset.broken}`);

    const selection = ctx.agentDefaultModel?.currentSelection();
    if (!selection?.provider || !selection?.model) throw new Error('请先配置 DSH profile 的默认模型');

    const setup = async (agentCtx) => {
      await presets.mount(agentCtx, preset.id);
      // dsh-base 的全局工具也会被 Agent 继承，需为这次源码会话显式拦截。
      agentCtx.tools.restrict({ allow: [] });
      agentCtx.tools.guard(() => '固件候选会话只允许生成源码文本');
    };
    const { agent, dispose } = await agents.create({
      sessionId: `esa-code-${randomUUID()}`,
      meta: { cwd: BUNDLE_DIR, agentPreset: preset.id, ticketId, purpose: 'firmware-code-change' },
      agentOptions: selection, setup,
    });
    let text = '';
    let reason = null;
    let unwatch;
    try {
      await agent.whenIdle();
      unwatch = ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return;
        if (event.type === 'turn/start') {
          text = '';
          reason = null;
        } else if (event.type === 'assistant/message') {
          const content = event.data.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
          if (content) text = content;
        } else if (event.type === 'turn/end') {
          reason = event.data.reason;
        }
      });
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: buildFirmwarePrompt({ relPath, requirement, notes, original, skill }) }],
        source: { kind: 'user' },
      });
      await agent.whenIdle();
      if (ctx.sessions?.flush) await ctx.sessions.flush(agent.session);
      if (reason?.kind !== 'completed') {
        throw new Error(`DSH 源码生成未完成（${reason?.error?.code ?? reason?.kind ?? '缺少终止事件'}）`);
      }
      if (!text.trim()) throw new Error('DSH software-engineer preset 未返回候选源码');
      if (/^\s*BLOCKED:/i.test(text)) throw new Error(text.trim().slice(0, 300));
      const fence = /^\s*```(?:c|h|cpp)?[^\S\r\n]*\r?\n([\s\S]*?\r?\n)```\s*$/i.exec(text);
      return { text: fence?.[1] ?? text, model: selection.model, keyId: preset.id, tokens: 0 };
    } finally {
      unwatch?.();
      await dispose();
    }
  };
}

export function apply(ctx, config = {}) {
  const state = { runtime: null, panel: null };

  ctx.effect(async () => {
    const projectDir = config.projectDir || process.env.SUPERAGENT_PROJECT_DIR;
    if (!projectDir || !(await fs.stat(projectDir).catch(() => null))?.isDirectory()) {
      throw new Error(`请通过 electronics-superagent.projectDir 或 SUPERAGENT_PROJECT_DIR 指定有效的项目目录（当前：${projectDir ?? '未配置'}）`);
    }
    const dir = await fs.realpath(projectDir);
    const skill = await loadFirmwareSkill(config);
    const source = config.source ?? process.env.SUPERAGENT_SOURCE ?? 'local';
    if (source === 'feishu') await loadFeishuEnv();

    const options = {
      source,
      codeModifier: makeDshCodeModifier(ctx, config, skill),
      firmwareBuild: config.firmwareBuild,
    };
    if (config.modelFile) options.modelFile = config.modelFile;
    if (config.policyFile) options.policyFile = config.policyFile;

    const runtime = await Runtime.create({ dir, options });
    state.runtime = runtime;
    log(ctx, `引擎已创建：${runtime.status().project.code}`);

    let panel = null;
    if (config.panel !== false) {
      panel = createPanelServer({ runtime, host: config.host ?? '127.0.0.1', port: config.port ?? 8787 });
      const { url } = await panel.listen();
      state.panel = panel;
      log(ctx, `面板已监听：${url}`);
    }

    const ac = new AbortController();
    const running = runtime.run({
      intervalMs: config.intervalMs ?? 1500,
      signal: ac.signal,
    }).catch((err) => log(ctx, `引擎轮询异常：${err.message}`));

    // 提供服务给同一 profile 内的其他插件（如面板扩展、定时任务）
    ctx.provide('electronicsSuperagent', {
      runtime,
      status: () => runtime.status(),
      panelData: () => runtime.panelData(),
      getEngine: () => runtime.engine,
    });

    return async () => {
      ac.abort();
      await running.catch(() => {});
      if (panel) await panel.close().catch(() => {});
      await runtime.close().catch(() => {});
      log(ctx, '引擎与面板已停止');
    };
  }, 'electronics-superagent.runtime');
}
