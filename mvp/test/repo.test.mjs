import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as repo from '../src/executor/repo.mjs';

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true }).trim();
}

async function makeRepo({ initialCommit = true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'esa-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'core.hooksPath', '.git/test-hooks');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgSign', 'false');
  if (initialCommit) {
    await writeFile(path.join(dir, 'target.txt'), 'initial\n');
    await writeFile(path.join(dir, 'other.txt'), 'initial\n');
    git(dir, 'add', '--', 'target.txt', 'other.txt');
    git(dir, 'commit', '-qm', 'Initial');
  }
  git(dir, 'checkout', '-qb', 'agent/test');
  return dir;
}

test('commitFiles commits selected working-tree paths and leaves unrelated staged changes intact', async () => {
  const dir = await makeRepo();
  const target = path.join(dir, 'target.txt');
  const other = path.join(dir, 'other.txt');
  const nested = path.join(dir, 'asset directory');
  const added = path.join(nested, 'new[1].txt');
  const likewise = path.join(nested, 'new1.txt');
  await writeFile(target, 'selected staged content\n');
  await writeFile(other, 'unrelated staged content\n');
  git(dir, 'add', '--', 'other.txt', 'target.txt');
  await writeFile(target, 'selected working content\n');
  await mkdir(nested);
  await writeFile(added, 'new content\n');
  await writeFile(likewise, 'similarly named content\n');

  const commit = await repo.commitFiles(dir, [target, added], 'Scoped', {});

  assert.match(commit.sha, /^[a-f0-9]+$/);
  assert.equal(commit.branch, 'agent/test');
  assert.deepEqual(
    git(dir, 'show', '--pretty=', '--name-only', 'HEAD').split('\n'),
    ['asset directory/new[1].txt', 'target.txt'],
  );
  assert.equal(git(dir, 'show', 'HEAD:target.txt'), 'selected working content');
  assert.equal(git(dir, 'show', 'HEAD:other.txt'), 'initial');
  assert.equal(git(dir, 'show', ':other.txt'), 'unrelated staged content');
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), 'other.txt');
  assert.equal(git(dir, 'ls-files', '--others', '--exclude-standard'), 'asset directory/new1.txt');
});

test('commitFiles returns no commit when only unrelated files have changes', async () => {
  const dir = await makeRepo();
  await writeFile(path.join(dir, 'other.txt'), 'unrelated staged content\n');
  git(dir, 'add', '--', 'other.txt');
  const head = git(dir, 'rev-parse', 'HEAD');

  const commit = await repo.commitFiles(dir, [path.join(dir, 'target.txt')], 'No selected changes', {});

  assert.equal(commit.sha, null);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), 'other.txt');
});

test('commitFiles scopes the first commit in a new repository', async () => {
  const dir = await makeRepo({ initialCommit: false });
  const target = path.join(dir, 'target.txt');
  await writeFile(target, 'first file\n');
  await writeFile(path.join(dir, 'other.txt'), 'unrelated staged content\n');
  git(dir, 'add', '--', 'other.txt');

  await repo.commitFiles(dir, [target], 'Initial', {});

  assert.equal(git(dir, 'ls-tree', '--name-only', 'HEAD'), 'target.txt');
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), 'other.txt');
});

test('commitFiles preserves the index when Git rejects the commit', async () => {
  const dir = await makeRepo();
  const target = path.join(dir, 'target.txt');
  const added = path.join(dir, 'new.txt');
  git(dir, 'config', 'user.name', '');
  await writeFile(target, 'selected staged content\n');
  await writeFile(path.join(dir, 'other.txt'), 'unrelated staged content\n');
  git(dir, 'add', '--', 'other.txt', 'target.txt');
  const staged = git(dir, 'ls-files', '--stage');
  await writeFile(target, 'selected working content\n');
  await writeFile(added, 'new content\n');
  const head = git(dir, 'rev-parse', 'HEAD');

  await assert.rejects(repo.commitFiles(dir, [target, added], 'Rejected', {}), /empty ident name/);

  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'ls-files', '--stage'), staged);
  assert.equal(git(dir, 'ls-files', '--others', '--exclude-standard'), 'new.txt');
});

test('workingDiffLines counts selected tracked and untracked changes without changing the index', async () => {
  const dir = await makeRepo();
  const target = path.join(dir, 'target.txt');
  const added = path.join(dir, 'new content.txt');
  await writeFile(path.join(dir, 'other.txt'), 'unrelated\nstaged\ncontent\n');
  git(dir, 'add', '--', 'other.txt');
  const staged = git(dir, 'ls-files', '--stage');
  await writeFile(target, 'new line 1\nnew line 2\n');
  await writeFile(added, 'new line 1\nnew line 2\nnew line 3\n');

  assert.equal(await repo.workingDiffLines(dir, [target, added]), 6);
  assert.equal(git(dir, 'ls-files', '--stage'), staged);
});

test('workingDiffLines counts selected additions on an unborn branch', async () => {
  const dir = await makeRepo({ initialCommit: false });
  const target = path.join(dir, 'target.txt');
  await writeFile(target, 'first staged version\n');
  git(dir, 'add', '--', 'target.txt');
  await writeFile(target, 'first\nworking\nversion\n');

  assert.equal(await repo.workingDiffLines(dir, [target]), 3);
});

test('hasTrackedChanges reports selected staged and unstaged edits', async () => {
  const dir = await makeRepo();
  const target = path.join(dir, 'target.txt');
  const untracked = path.join(dir, 'new.txt');
  await writeFile(path.join(dir, 'other.txt'), 'unrelated staged content\n');
  git(dir, 'add', '--', 'other.txt');
  await writeFile(untracked, 'untracked content\n');
  assert.equal(await repo.hasTrackedChanges(dir, [target, untracked]), false);

  await writeFile(target, 'selected change\n');
  assert.equal(await repo.hasTrackedChanges(dir, [target]), true);

  git(dir, 'add', '--', 'target.txt');
  assert.equal(await repo.hasTrackedChanges(dir, [target]), true);
});

test('checkoutBase only returns a branch that actually checked out', async () => {
  const dir = await makeRepo();
  const target = path.join(dir, 'target.txt');
  await writeFile(target, 'different branch content\n');
  git(dir, 'add', '--', 'target.txt');
  git(dir, 'commit', '-qm', 'Change target');
  git(dir, 'branch', 'fallback');
  await writeFile(target, 'uncommitted content\n');

  await assert.rejects(repo.checkoutBase(dir, ['main']), /git checkout -q main/);
  assert.equal(await repo.currentBranch(dir), 'agent/test');
  assert.equal(await repo.checkoutBase(dir, ['missing']), null);
  assert.equal(await repo.checkoutBase(dir, ['main', 'fallback']), 'fallback');
  assert.equal(await repo.currentBranch(dir), 'fallback');
});
