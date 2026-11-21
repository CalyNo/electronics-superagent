import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { ensureDir } from '../util/fsx.mjs';

// 单文件 SQLite。理由见 docs/00 §1：单实例、单写入者，事务就是一致性边界。
// 表设计原则：触发事件与授权是不可变对象，只插入不更新；状态表只存当前态。

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trigger (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  external_id TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  actor_name  TEXT,
  chat_id     TEXT,
  body        TEXT NOT NULL,
  at          TEXT NOT NULL,
  addressed   INTEGER NOT NULL DEFAULT 0,
  disposition TEXT NOT NULL DEFAULT 'new',
  meta        TEXT,
  UNIQUE(source, external_id)
);

CREATE TABLE IF NOT EXISTS thread (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  title      TEXT,
  stage      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eval (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL,
  trigger_ids    TEXT NOT NULL,
  status         TEXT NOT NULL,
  verdict        TEXT,
  reason         TEXT,
  task_type      TEXT,
  stage          TEXT,
  gate_target    TEXT,
  severity       TEXT,
  assessment     TEXT,
  policy_version TEXT,
  created_at     TEXT NOT NULL,
  decided_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_eval_thread ON eval(thread_id, status);

CREATE TABLE IF NOT EXISTS ticket (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL,
  eval_id        TEXT NOT NULL,
  title          TEXT NOT NULL,
  task_type      TEXT NOT NULL,
  stage          TEXT NOT NULL,
  gate_target    TEXT,
  severity       TEXT,
  status         TEXT NOT NULL,
  blocked_reason TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_status ON ticket(status);

CREATE TABLE IF NOT EXISTS mandate (
  id             TEXT PRIMARY KEY,
  ticket_id      TEXT NOT NULL,
  strength       TEXT NOT NULL,
  repo_scope     TEXT NOT NULL,
  stage_scope    TEXT NOT NULL,
  action_scope   TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  granted_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assignment (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL,
  attempt    INTEGER NOT NULL,
  status     TEXT NOT NULL,
  workdir    TEXT,
  started_at TEXT,
  ended_at   TEXT,
  note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_assignment_status ON assignment(status);

CREATE TABLE IF NOT EXISTS report (
  id            TEXT PRIMARY KEY,
  ticket_id     TEXT NOT NULL,
  assignment_id TEXT,
  kind          TEXT NOT NULL,
  body          TEXT,
  at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  doc_type   TEXT,
  stage      TEXT,
  path       TEXT NOT NULL,
  revision   TEXT,
  sha256     TEXT,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gate (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  stage      TEXT NOT NULL,
  status     TEXT NOT NULL,
  checks     TEXT,
  updated_at TEXT NOT NULL,
  signed_by  TEXT,
  signed_at  TEXT,
  note       TEXT
);

CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    TEXT NOT NULL,
  error      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, next_at);

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  subject TEXT,
  detail  TEXT
);

-- 模型用量：按工单/岗位/池/密钥记账。没有这张表，预算与归因都只能靠估算
CREATE TABLE IF NOT EXISTS usage (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,
  ticket_id TEXT,
  position  TEXT,
  pool      TEXT,
  key_id    TEXT,
  model     TEXT,
  tokens    INTEGER NOT NULL DEFAULT 0,
  purpose   TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ticket ON usage(ticket_id);
CREATE INDEX IF NOT EXISTS idx_usage_at ON usage(at);
`;

export class Db {
  constructor(file) {
    this.file = file;
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec(SCHEMA);
    this.migrate();
    this.inTx = false;
  }

  /** 轻量迁移：只为已有库补列，不重建表（线上库里有真实数据） */
  migrate() {
    const cols = new Set(this.raw.prepare('PRAGMA table_info(asset)').all().map((r) => r.name));
    const add = (name, ddl) => {
      if (cols.has(name)) return;
      this.raw.exec(`ALTER TABLE asset ADD COLUMN ${ddl}`);
    };
    add('title', 'title TEXT');
    add('position', 'position TEXT');
    add('ai_assisted', 'ai_assisted INTEGER NOT NULL DEFAULT 0');
  }

  run(sql, ...params) { return this.raw.prepare(sql).run(...params); }
  get(sql, ...params) { return this.raw.prepare(sql).get(...params); }
  all(sql, ...params) { return this.raw.prepare(sql).all(...params); }

  /** 事务：异常必回滚。嵌套调用复用外层事务，避免 SQLite 不支持嵌套 BEGIN */
  tx(fn) {
    if (this.inTx) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.inTx = true;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.raw.exec('ROLLBACK'); } catch { /* 回滚失败不应掩盖原始错误 */ }
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  kvGet(key, fallback = null) {
    const row = this.get('SELECT value FROM kv WHERE key = ?', key);
    return row ? row.value : fallback;
  }

  kvSet(key, value, at) {
    this.run(
      'INSERT INTO kv(key, value, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
      key, String(value), at
    );
  }

  /** 计数器的原子自增（单写入者模型下无需乐观锁，但避免读改写竞态） */
  nextSeq(name, at) {
    return this.tx(() => {
      const cur = Number(this.kvGet(`seq:${name}`, '0')) || 0;
      const next = cur + 1;
      this.kvSet(`seq:${name}`, String(next), at);
      return next;
    });
  }

  close() { try { this.raw.close(); } catch { /* 已关闭 */ } }
}

export async function openDb(stateDir, filename = 'orchestrator.sqlite') {
  await ensureDir(stateDir);
  return new Db(path.join(stateDir, filename));
}
