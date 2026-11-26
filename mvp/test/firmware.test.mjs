import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { runAssignment } from '../src/executor/executor.mjs';

const run = promisify(execFile);
const source = 'firmware/app/main.c';
const header = 'firmware/app/config.h';
const original = 'int speed(void) { return 1; }\n';
const candidate = '#include <stdint.h>\nint speed(void) { return 2; }\n';
const fullInput = '修改应用层源文件。\n超过工单标题长度的具体约束保留全文：速率设置为 2。';

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'esa-firmware-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function fixture(t) {
  const root = await workspace(t);
  const stateDir = path.join(root, '.state');
  const project = { root, manifest: { code: 'FW', stages: { enabled: ['S2'] } }, paths: { index: path.join(root, 'docs/_index') } };
  const ticket = { id: 'TKT-01', title: '修改应用层源文件' };
  const registered = [];
  const engine = {
    registerAsset(asset) { registered.push(asset); },
    db: { kvGet: () => null, kvSet: () => {} },
    now: () => new Date().toISOString(),
  };
  await fs.mkdir(path.join(root, 'firmware/app'), { recursive: true });
  await fs.writeFile(path.join(root, source), original);
  await fs.writeFile(path.join(root, header), '#define RATE 1\n');
  const buildScript = path.join(root, 'compiler fixture.mjs');
  await fs.writeFile(buildScript, `
    import { readFileSync, writeFileSync } from 'node:fs';
    const [source, profile, exitCode] = process.argv.slice(2);
    if (profile !== 'target & literal') process.exit(91);
    if (!readFileSync(source, 'utf8').includes('return 2')) process.exit(92);
    writeFileSync('.state/compiler-ran', profile);
    if (exitCode === 'edit') {
      writeFileSync(source, 'int speed(void) { return 3; }\\n');
      process.exit(2);
    }
    if (+exitCode) console.error('controlled compiler error');
    process.exit(+exitCode);
  `);
  return {
    root, registered,
    read: (file) => fs.readFile(path.join(root, file), 'utf8'),
    build: (code = '0') => ({ executable: process.execPath, args: [buildScript, source, 'target & literal', code] }),
    project,
    execute: (options, codeTargets = [{ relPath: source }], rules = {}) => runAssignment({
      assignment: { id: 'ASG-01' }, ticket, project, engine, stateDir, rules,
      plan: { stage: 'S2', docTypes: ['CODE'], inputText: fullInput, codeTargets },
      options: { git: false, ...options },
    }),
  };
}

async function linkDirectory(t, target, link) {
  try {
    await fs.symlink(target, link, 'junction');
    return true;
  } catch (err) {
    if (err.code !== 'EPERM') throw err;
    t.skip('当前沙箱禁止创建 junction');
    return false;
  }
}

test('固件候选经过配置的编译命令后才登记为有效资产', async (t) => {
  const f = await fixture(t);
  const result = await f.execute({ firmwareBuild: f.build(), codeModifier: async (req) => {
    assert.equal(req.original, original);
    assert.equal(req.requirement, fullInput);
    assert.deepEqual(f.registered, []);
    return { text: candidate };
  } });
  assert.equal(result.status, 'ready');
  assert.equal(await f.read('.state/compiler-ran'), 'target & literal');
  assert.equal(await f.read(source), candidate);
  assert.equal(f.registered[0].status, 'valid');
});

test('固件配置缺失时保持文件并阻止模型调用', async (t) => {
  const f = await fixture(t);
  const result = await f.execute({ codeModifier: async () => {
    assert.fail('缺少编译配置时不可调用代码生成器');
  } });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /integrations\.firmware\.build/);
  assert.equal(await f.read(source), original);
  assert.deepEqual(f.registered, []);
});

test('项目未启用 S2 时固件工单保持阻塞', async (t) => {
  const f = await fixture(t);
  f.project.manifest.stages.enabled = ['S1'];
  const result = await f.execute({ firmwareBuild: f.build(), codeModifier: async () => {
    assert.fail('unexpected code generator call');
  } });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /未启用.*S2/);
  assert.equal(await f.read(source), original);
  await assert.rejects(f.read('.state/compiler-ran'), { code: 'ENOENT' });
});

test('固件构建可使用项目清单中的受信配置', async (t) => {
  const f = await fixture(t);
  f.project.manifest.integrations = { firmware: { build: f.build() } };
  const result = await f.execute({ codeModifier: async () => ({ text: candidate }) });
  assert.equal(result.status, 'ready');
  assert.equal(await f.read('.state/compiler-ran'), 'target & literal');
});

test('固件编译失败时还原所有候选且没有 Git 和登记副作用', async (t) => {
  const f = await fixture(t);
  const result = await f.execute({
    git: true, firmwareBuild: f.build('2'),
    codeModifier: async ({ relPath }) => ({ text: relPath === source ? candidate : '#define RATE 2\n' }),
  }, [{ relPath: source }, { relPath: header }]);
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /controlled compiler error/);
  assert.equal(await f.read('.state/compiler-ran'), 'target & literal');
  assert.equal(await f.read(source), original);
  assert.equal(await f.read(header), '#define RATE 1\n');
  assert.deepEqual(result.assets, []);
  assert.deepEqual(f.registered, []);
  await assert.rejects(fs.access(path.join(f.root, '.git')), { code: 'ENOENT' });
});

test('多文件生成中途失败时不落盘前一个候选', async (t) => {
  const f = await fixture(t);
  const result = await f.execute({ firmwareBuild: f.build(), codeModifier: async ({ relPath }) => {
    if (relPath === header) throw new Error('header unavailable');
    return { text: candidate };
  } }, [{ relPath: source }, { relPath: header }]);
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /header unavailable/);
  assert.equal(await f.read(source), original);
  assert.deepEqual(f.registered, []);
});

test('固件编译失败回滚时保护执行期间出现的其他编辑', async (t) => {
  const f = await fixture(t);
  const result = await f.execute({ firmwareBuild: f.build('edit'), codeModifier: async () => ({ text: candidate }) });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /需从备份恢复/);
  assert.equal(await f.read(source), 'int speed(void) { return 3; }\n');
  assert.deepEqual(f.registered, []);
});

test('疑似包含凭据的候选不会送去编译', async (t) => {
  const f = await fixture(t);
  const result = await f.execute({ firmwareBuild: f.build(), codeModifier: async () => ({
    text: `${candidate}// SAMPLE_PRIVATE_VALUE=only-test-fixture\n`,
  }) }, [{ relPath: source }], { redactPatterns: ['SAMPLE_PRIVATE_VALUE=.+'] });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /疑似凭据/);
  assert.doesNotMatch(result.reason, /only-test-fixture/);
  assert.equal(await f.read(source), original);
  await assert.rejects(f.read('.state/compiler-ran'), { code: 'ENOENT' });
});

test('固件工单保留现有的已跟踪文件改动', async (t) => {
  const f = await fixture(t);
  const opts = { cwd: f.root };
  await run('git', ['init', '-q', '-b', 'main'], opts);
  await run('git', ['add', '--', source], opts);
  await run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'baseline'], opts);
  await fs.writeFile(path.join(f.root, source), '#include <stdint.h>\nint speed(void) { return 3; }\n');
  const result = await f.execute({ git: true, firmwareBuild: f.build(), codeModifier: async () => {
    assert.fail('unexpected code generator call');
  } });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /未提交/);
  assert.match(await f.read(source), /return 3/);
  await assert.rejects(f.read('.state/compiler-ran'), { code: 'ENOENT' });
});

test('内置生成器与注入的修改器使用同一个固件编译门禁', async (t) => {
  const f = await fixture(t);
  const result = await f.execute({ firmwareBuild: f.build('2'), pool: { generate: async ({ prompt }) => {
    assert.ok(prompt.includes(fullInput));
    return { text: candidate };
  } } });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /controlled compiler error/);
  assert.equal(await f.read(source), original);
  assert.deepEqual(f.registered, []);
});

test('固件超出改动行数时保留原文件和索引内容', async (t) => {
  const f = await fixture(t);
  const indexPath = 'docs/_index/documents.csv';
  const originalIndex = 'id,title\nEXISTING,已登记的交付物\n';
  await fs.mkdir(f.project.paths.index, { recursive: true });
  await fs.writeFile(path.join(f.root, indexPath), originalIndex);
  const result = await f.execute({ git: true, firmwareBuild: f.build(), codeModifier: async () => ({ text: candidate }) },
    [{ relPath: source }], { maxDiffLines: 1 });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /超过单工单上限 1 行/);
  assert.equal(await f.read(source), original);
  assert.equal(await f.read(indexPath), originalIndex);
  assert.deepEqual(f.registered, []);
  await assert.rejects(run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: f.root }));
});

test('固件索引写入出错时恢复可编译的候选文件', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.project.paths.index), { recursive: true });
  await fs.writeFile(f.project.paths.index, 'index path unavailable');
  const result = await f.execute({ firmwareBuild: f.build(), codeModifier: async () => ({ text: candidate }) });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /索引与追溯写入失败/);
  assert.equal(await f.read('.state/compiler-ran'), 'target & literal');
  assert.equal(await f.read(source), original);
  assert.deepEqual(f.registered, []);
});

test('固件白名单拒绝经过链接指向应用层外的源码', async (t) => {
  const f = await fixture(t);
  const sdk = path.join(f.root, 'sdk');
  await fs.mkdir(sdk);
  await fs.writeFile(path.join(sdk, 'main.c'), original);
  if (!await linkDirectory(t, sdk, path.join(f.root, 'firmware/app/linked'))) return;
  const result = await f.execute({ firmwareBuild: f.build(), codeModifier: async () => {
    assert.fail('目标逃出应用层时不可调用代码生成器');
  } }, [{ relPath: 'firmware/app/linked/main.c' }]);
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /白名单|链接/);
  assert.equal(await f.read('sdk/main.c'), original);
});

test('DSH bundle 可通过 junction 加载', async (t) => {
  const root = await workspace(t);
  const bundle = fileURLToPath(new URL('../../dsh-bundle/', import.meta.url));
  const junction = path.join(root, 'bundle-link');
  if (!await linkDirectory(t, bundle, junction)) return;
  const entry = pathToFileURL(path.join(junction, 'index.mjs')).href;
  const { stdout } = await run(process.execPath, ['--preserve-symlinks', '--input-type=module', '-e',
    `const plugin = await import(${JSON.stringify(entry)}); console.log(plugin.name);`], { cwd: root });
  assert.equal(stdout.trim(), 'electronics-superagent');
});

test('DSH bundle 只返回包含标准头文件的候选', async (t) => {
  const root = await workspace(t);
  const { makeDshCodeModifier, apply } = await import('../../dsh-bundle/index.mjs');
  let startup;
  apply({ effect: (fn) => { startup = fn; } }, { projectDir: path.join(root, 'missing-project') });
  await assert.rejects(startup(), /SUPERAGENT_PROJECT_DIR/);
  await assert.rejects(makeDshCodeModifier({}, { skillsDir: path.join(root, 'missing-skills') })({
    relPath: source, original, requirement: fullInput,
  }), /SUPERAGENT_SKILLS_DIR/);

  let prompt;
  let completion = 'completed';
  let sessionListener;
  let restrictions = 0;
  let disposed = 0;
  const selection = { provider: 'test-provider', model: 'test-model' };
  const session = { seq: 1 };
  const agent = {
    followup: (message) => {
      prompt = message.content[0].text;
      sessionListener(session, { type: 'turn/start', data: {} });
      sessionListener(session, { type: 'assistant/message', data: {
        message: { content: [
          { type: 'text', text: '#include <stdint.h>\n' },
          { type: 'text', text: 'int speed(void) { return 2; }\n' },
        ] },
      } });
      sessionListener(session, { type: 'turn/end', data: { reason: { kind: completion } } });
    },
    whenIdle: async () => {}, session,
  };
  const modifier = makeDshCodeModifier({
    logger: { info: () => {} },
    on: (event, listener) => {
      assert.equal(event, 'session/event');
      sessionListener = listener;
      return () => { sessionListener = undefined; };
    },
    agentDefaultModel: { currentSelection: () => selection },
    agents: { create: async ({ meta, setup, agentOptions }) => {
      assert.notEqual(meta.cwd, root);
      assert.deepEqual(agentOptions, selection);
      await setup({ tools: {
        restrict: (filter) => { assert.deepEqual(filter, { allow: [] }); restrictions += 1; },
        guard: (guard) => { assert.ok(guard({})); restrictions += 1; },
      } });
      return { agent, dispose: async () => { disposed += 1; } };
    } },
    agentPresets: { resolve: async (id) => ({ id }), mount: async () => {} },
  }, { skillsDir: fileURLToPath(new URL('../../dsh-bundle/skills/', import.meta.url)) });
  const staged = await modifier({ projectRoot: root, relPath: source, original, requirement: fullInput });
  assert.equal(staged.text, candidate);
  assert.ok(prompt.includes(original));
  assert.ok(prompt.includes(fullInput));
  assert.equal(restrictions, 2);
  assert.equal(disposed, 1);
  assert.equal(sessionListener, undefined);
  completion = 'max-tokens';
  await assert.rejects(modifier({ relPath: source, original, requirement: fullInput }), /max-tokens/);
  assert.equal(disposed, 2);
  await assert.rejects(fs.access(path.join(root, 'firmware')), { code: 'ENOENT' });
});
