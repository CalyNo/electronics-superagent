// electronics-superagent 的 DSH/Cordis 宿主插件。
// 职责：在 DSH 会话内启动 superagent 引擎（飞书来源 + 面板），
// 并把「固件代码修改」后端注入为 DSH 的 software-engineer preset——
// 即真正改固件的是 DSH agent（在隔离的 preset 会话里），而不是自建模型网关。
//
// 生命周期全部交给 ctx.effect：DSH 卸载本插件时会逆序执行 disposer，
// 关闭 HTTP server、停止引擎轮询、关闭 SQLite。

import os from 'node:os';
import path from 'node:path';
import { promises as fs, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// 本 bundle 通过 junction 挂到 ~/.dsh/bundles，相对路径 '../mvp' 会解析到 junction
// 的父目录而非源码目录，因此引擎依赖统一用源码绝对路径。
const ENGINE_DIR = 'D:/yoxi/superagent/electronics-superagent/mvp/src';
const engineImport = (rel) => import(pathToFileURL(path.join(ENGINE_DIR, rel)).href);
const { Runtime } = await engineImport('app/runtime.mjs');
const { createPanelServer } = await engineImport('panel/server.mjs');
const { ensureDir, exists, readFileSafe, sha256Text } = await engineImport('util/fsx.mjs');
const { isAllowedCodePath } = await engineImport('executor/codegen.mjs');

export const name = 'electronics-superagent';
export const inject = ['agentPresets', 'agents', 'sessions'];

// 从 ~/.superagent/feishu.env 加载飞书凭据（格式：export KEY = value）。
// 只在缺失时注入，不覆盖 DSH 进程已有的环境变量。
function loadFeishuEnv() {
  const file = path.join(os.homedir(), '.superagent', 'feishu.env');
  if (!exists(file)) return;
  const text = readFileSync(file, 'utf8');
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

// DSH agent 执行固件修改的提示词。
function buildFirmwarePrompt({ relPath, requirement, notes }) {
  return [
    '你是 T23 项目的软件工程师，请修改固件源码实现下述需求。',
    '',
    `目标文件（相对项目根）：${relPath}`,
    `需求：${requirement}`,
    notes ? `补充约束：${notes}` : '',
    '',
    '严格要求：',
    '1. 只允许修改上面指定的目标文件，不得改动 SDK/CMSIS/middleware/bootloader/构建产物。',
    '2. 遵循现有代码风格，改动最小；未涉及的函数与注释原样保留。',
    '3. 先读取原文件全文，再给出「完整修改后的文件内容」，不要只给片段或 diff。',
    '4. 输出必须是可编译的 C 源码全文，从第一个字符到最后一个字符，不要包裹在解释性文字里。',
    '5. 不要虚构不存在的函数或宏；无法安全实现时明确说明并保持文件不变。',
  ].filter(Boolean).join('\n');
}

// 从 DSH agent 的 session 日志里抽取最后一条 assistant 文本。
function lastAssistantText(session) {
  try {
    const events = session.events?.() ?? [];
    let text = '';
    for (const ev of events) {
      if (ev.type === 'assistant/message' && Array.isArray(ev.data?.content)) {
        for (const part of ev.data.content) {
          if (part?.type === 'text' && typeof part.text === 'string') text = part.text;
        }
      }
    }
    return text;
  } catch {
    return '';
  }
}

// 从模型输出里提取完整源码：优先 ```c ... ``` 代码块，否则整体作为源码。
function extractSource(text) {
  if (!text || typeof text !== 'string') return null;
  const fence = /```(?:c|h|cpp)?\s*\n([\s\S]*?)\n```/i.exec(text);
  let src = fence ? fence[1] : text.trim();
  // 去掉模型常见的开场白（若首行不是预处理/注释/代码起始）
  const lines = src.split('\n');
  const firstCode = lines.findIndex((l) => /^\s*(#|\/\*|\/\/|[A-Za-z_])/.test(l));
  if (firstCode > 0) src = lines.slice(firstCode).join('\n');
  return src.trim().length ? src : null;
}

// 构造注入给 Runtime 的 codeModifier：在 DSH 会话内驱动 software-engineer preset。
export function makeDshCodeModifier(ctx, config) {
  return async function dshCodeModifier({
    projectRoot, relPath, requirement, notes = '', engine, ticketId = null,
  }) {
    const absPath = path.resolve(projectRoot, relPath);
    // 硬校验：即便由 DSH agent 执行，也必须落在固件应用代码白名单内
    if (!isAllowedCodePath(projectRoot, absPath)) {
      throw new Error(`拒绝修改：${relPath} 不在固件应用代码白名单内（禁止 SDK/CMSIS/middleware/boot）`);
    }
    const original = await readFileSafe(absPath, null);
    if (original == null) throw new Error(`目标文件不存在：${relPath}`);

    log(ctx, `code-change -> software-engineer preset: ${relPath}`);

    const agents = ctx.agents;
    const presets = ctx.agentPresets;
    if (!agents || !presets) {
      throw new Error('DSH 未提供 agents / agentPresets 服务，无法在会话内改固件');
    }

    const presetId = config.codePresetId ?? 'software-engineer';
    // 解析 preset，失败则报错而不是静默回退到网关（避免"以为在 DSH 改其实没改"）
    const preset = await presets.resolve(presetId);
    if (!preset) throw new Error(`未找到 DSH preset：${presetId}`);

    const sessionId = `esa-code-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const setup = async (agentCtx) => {
      await presets.mount(agentCtx, preset.id);
    };
    const handle = await agents.create({
      sessionId,
      meta: { cwd: projectRoot, agentPreset: preset.id, ticketId, purpose: 'firmware-code-change' },
      setup,
    });
    const agent = handle.agent;

    // 投递任务并等待 agent 空闲（headless 内部同一套公开 API）。
    // 直接构造 user message 结构，避免 bundle 跨 node_modules 裸包 import '@deepseek-ai/dsh-llm'。
    agent.followup({
      id: `msg-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text: buildFirmwarePrompt({ relPath, requirement, notes }) }],
      source: { kind: 'user' },
    });

    const subagents = ctx.subagents;
    // 等待一轮完成：whenIdle + 子 agent 静默 + session 序列稳定
    for (let i = 0; i < 3; i += 1) {
      await agent.whenIdle();
      const seq = agent.session.seq;
      if (!subagents || !await subagents.waitForChildren(agent)) {
        if (agent.status === 'idle' && agent.session.seq === seq) break;
      }
    }
    if (ctx.sessions?.flush) await ctx.sessions.flush(agent.session);

    const text = lastAssistantText(agent.session);
    const src = extractSource(text);
    if (!src) {
      throw new Error('DSH software-engineer preset 未返回可解析的源码；固件保持不变');
    }
    if (src === original || src.trim() === original.trim()) {
      return { changed: false, sha256: sha256Text(original), model: preset.id, keyId: preset.id, tokens: 0 };
    }
    // 明显的破坏信号：大幅缩水或残留占位符
    if (src.length < original.length * 0.6 || /<[^>]+>|TODO_FILL|\.\.\.\s*\/\/\s*省略/.test(src)) {
      throw new Error('DSH 输出疑似截断或含占位符，拒绝写入；固件保持不变');
    }

    // 备份后写入（与内置 codegen 一致的约定）
    const backupDir = path.join(projectRoot, '.state', 'codegen');
    await ensureDir(backupDir);
    const backupPath = path.join(backupDir, `${path.basename(relPath)}.${Date.now()}.bak`);
    await fs.writeFile(backupPath, original, 'utf8');
    await fs.writeFile(absPath, src, 'utf8');

    return {
      changed: true,
      sha256: sha256Text(src),
      backupPath,
      model: preset.id,
      keyId: preset.id,
      tokens: 0,
    };
  };
}

export function apply(ctx, config = {}) {
  const state = { runtime: null, panel: null };

  ctx.effect(async () => {
    const dir = config.projectDir;
    // 飞书来源需要凭据；从 ~/.superagent/feishu.env 注入缺失的环境变量。
    if ((config.source ?? 'local') === 'feishu') loadFeishuEnv();
    if (!dir || !await exists(dir)) {
      throw new Error(`electronics-superagent.projectDir 不存在：${dir}`);
    }

    const options = {
      source: config.source ?? 'local',
      codeModifier: makeDshCodeModifier(ctx, config),
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
