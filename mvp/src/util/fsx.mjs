import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export async function readFileSafe(file, fallback = null) {
  try { return await fs.readFile(file, 'utf8'); } catch { return fallback; }
}

export async function readJson(file, fallback = null) {
  const text = await readFileSafe(file);
  if (text === null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/** 原子写：先写临时名再 rename，避免进程被杀留下半截文件 */
export async function writeFileAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

export async function writeJson(file, obj) {
  await writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}

export function sha256Text(s) {
  return createHash('sha256').update(s).digest('hex');
}

export async function sha256File(file) {
  try {
    return createHash('sha256').update(await fs.readFile(file)).digest('hex');
  } catch { return null; }
}

const DEFAULT_SKIP = new Set(['.git', 'node_modules', '.state', '.inbox', '.outbox', '.migration']);

export async function walk(dir, { skipDirs = DEFAULT_SKIP, filter = null } = {}) {
  const out = [];
  async function rec(d) {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        await rec(p);
      } else if (e.isFile()) {
        if (!filter || filter(p)) out.push(p);
      }
    }
  }
  await rec(dir);
  return out;
}

export async function copyDir(src, dst, { transform = null } = {}) {
  await ensureDir(dst);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(from, to, { transform });
    else {
      const buf = await fs.readFile(from);
      const text = buf.toString('utf8');
      if (transform) {
        const replaced = transform(text, from);
        await ensureDir(path.dirname(to));
        await fs.writeFile(to, replaced ?? text);
      } else {
        await ensureDir(path.dirname(to));
        await fs.writeFile(to, buf);
      }
    }
  }
}

export function nowISO(clock = Date) {
  return new Date(clock.now ? clock.now() : Date.now()).toISOString();
}

export function todayISO(clock = Date) {
  return nowISO(clock).slice(0, 10);
}

export function rel(root, p) {
  return path.relative(root, p).split(path.sep).join('/');
}

export function toPosix(p) {
  return String(p).split(path.sep).join('/');
}
