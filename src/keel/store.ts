/**
 * Keel's state: one SQLite file holding the delegation (what the user asked for and allowed), work packets (what each
 * worker was told and read), artifacts (accepted results), quarantined results, and external actions. Every change runs in
 * one immediate transaction, so a user's change and a worker's commit are strictly ordered (docs/SPEC.md §3).
 */
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, result TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS delegation (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
INSERT OR IGNORE INTO delegation VALUES (1, 0);
CREATE TABLE IF NOT EXISTS scope_versions (scope TEXT PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS terms (id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL, text TEXT NOT NULL,
  status TEXT NOT NULL, since INTEGER NOT NULL, until INTEGER, source_event TEXT NOT NULL, supersedes TEXT);
CREATE TABLE IF NOT EXISTS denials (action TEXT NOT NULL, scope TEXT NOT NULL, since INTEGER NOT NULL, PRIMARY KEY (action, scope));
CREATE TABLE IF NOT EXISTS revocations (seq INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, scope TEXT NOT NULL, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS packets (id TEXT PRIMARY KEY, task TEXT NOT NULL, scope TEXT NOT NULL, delegation_version INTEGER NOT NULL,
  scope_snapshot TEXT NOT NULL, revocation_seq INTEGER NOT NULL, grants TEXT NOT NULL, write_set TEXT NOT NULL,
  status TEXT NOT NULL, reasons TEXT, started_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE IF NOT EXISTS reads (packet TEXT NOT NULL, kind TEXT NOT NULL, item TEXT NOT NULL, version TEXT NOT NULL,
  PRIMARY KEY (packet, kind, item));
CREATE TABLE IF NOT EXISTS artifacts (target TEXT PRIMARY KEY, version INTEGER NOT NULL, hash TEXT NOT NULL, content TEXT NOT NULL,
  packet TEXT NOT NULL, delegation_version INTEGER NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quarantine (id INTEGER PRIMARY KEY AUTOINCREMENT, packet TEXT NOT NULL, target TEXT NOT NULL,
  hash TEXT NOT NULL, content TEXT NOT NULL, reasons TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, packet TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
  payload TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, server_id TEXT,
  reason TEXT, at TEXT NOT NULL);
`

export type Row = Record<string, string | number | null>

/** One SQLite file of Keel state, with immediate transactions that nest. */
export class Store {
  readonly db: DatabaseSync
  constructor(path = ':memory:', readonly now: () => Date = () => new Date()) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    this.db.exec(SCHEMA)
  }
  /** Runs `work` in one immediate transaction; nested calls join the outer one. */
  tx<T>(work: () => T): T {
    if (this.depth > 0) { this.depth++; try { return work() } finally { this.depth-- } }
    this.db.exec('BEGIN IMMEDIATE')
    this.depth = 1
    try { const result = work(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error } finally { this.depth = 0 }
  }
  private depth = 0
  all(sql: string, ...args: (string | number | null)[]): Row[] { return this.db.prepare(sql).all(...args) as Row[] }
  get(sql: string, ...args: (string | number | null)[]): Row | undefined { return this.db.prepare(sql).get(...args) as Row | undefined }
  run(sql: string, ...args: (string | number | null)[]): number { return Number(this.db.prepare(sql).run(...args).changes) }
  iso(): string { return this.now().toISOString() }
  close(): void { this.db.close() }
}

/**
 * Scopes are paths: `/` is the whole engagement, `/site` a part of it, `/site/css` a part of that. Two scopes overlap when
 * one contains the other: a change to `/site` can affect work on `/site/css`, and the reverse.
 */
export function overlaps(a: string, b: string): boolean {
  const norm = (s: string) => s.endsWith('/') ? s : `${s}/`
  return norm(a).startsWith(norm(b)) || norm(b).startsWith(norm(a))
}
