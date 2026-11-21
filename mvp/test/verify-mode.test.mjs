// verify 的 strict / legacy / report 三种模式（docs/10 §4 P5）。
// 存量迁移项目不能一上来就 strict：未整理的源码全部报错位会让 CI 永久红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeProject, cleanup } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.mjs');

function runVerify(dir, mode) {
  const args = [CLI, 'verify', '--dir', dir];
  if (mode) args.push('--mode', mode);
  return new Promise((resolve) => {
    execFile(process.execPath, args, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code ?? 1 : 0, out: String(stdout), err: String(stderr) });
    });
  });
}

async function addMisplacedSource(dir, relPath) {
  const full = path.join(dir, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, 'void legacy_fn(void) {}\n', 'utf8');
  return relPath;
}

test('verify：无 import-map 时默认 strict，未登记错位文件失败', async (t) => {
  const dir = await makeProject();
  t.after(() => cleanup(null, dir));
  const p = await addMisplacedSource(dir, 'legacy/vendor/foo.c');

  const strict = await runVerify(dir, 'strict');
  assert.equal(strict.code, 2, `strict 应失败：${strict.out}\n${strict.err}`);
  assert.match(strict.out, new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const auto = await runVerify(dir);
  assert.equal(auto.code, 2, '无 import-map 时 auto 等同 strict');
});

test('verify：legacy 模式豁免 import-map 已登记路径，auto 自动识别迁移项目', async (t) => {
  const dir = await makeProject();
  t.after(() => cleanup(null, dir));
  const p = await addMisplacedSource(dir, 'legacy/vendor/bar.c');

  // 只登记这一个文件，模拟"存量件已映射"
  await fs.writeFile(
    path.join(dir, 'docs/_index/import-map.csv'),
    'oldPath,assetId,type,stage,status,note\n' + p + ',,,,,存量代码，保持原名\n',
    'utf8'
  );

  const legacy = await runVerify(dir, 'legacy');
  assert.equal(legacy.code, 0, `legacy 应通过：${legacy.out}\n${legacy.err}`);
  assert.match(legacy.out, /\[legacy\]/);
  assert.match(legacy.out, /存量豁免 1/);

  const auto = await runVerify(dir);
  assert.equal(auto.code, 0, '有 import-map 时 auto 应自动选 legacy');
  assert.match(auto.out, /\[legacy\]/);
});

test('verify：report 模式只告警不失败，且非法 mode 被拒绝', async (t) => {
  const dir = await makeProject();
  t.after(() => cleanup(null, dir));
  await addMisplacedSource(dir, 'legacy/vendor/baz.c');

  const report = await runVerify(dir, 'report');
  assert.equal(report.code, 0, `report 不应失败：${report.out}\n${report.err}`);
  assert.match(report.out, /\[report\]/);

  const bad = await runVerify(dir, 'bogus');
  assert.notEqual(bad.code, 0, '非法 mode 应非 0 退出');
  assert.match(bad.err, /--mode 非法/);
});
