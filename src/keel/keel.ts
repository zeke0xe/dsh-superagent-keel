/**
 * The delegation-consistency runtime (docs/SPEC.md). Three operations carry the guarantee:
 *
 * - `applyChange`: a user's change becomes a new delegation version, bumps the affected scopes, and revokes grants, all in
 *   one transaction; it reports the packets whose premises changed and those that must stop.
 * - `commit`: a worker's outputs become artifacts only if, at that moment, its premises still hold, its write grant is
 *   still valid, its targets are in its declared write set and unchanged since it read them. Otherwise they are
 *   quarantined (stale premises) or rejected as a conflict (someone else wrote the target first).
 * - `requestAction` and `settleAction`: an external action is admitted under the same checks, recorded before it is sent,
 *   and never sent twice: an unknown outcome is looked up, not retried.
 */
import { createHash } from 'node:crypto'
import { overlaps, type Row, Store } from './store.ts'

export type TermKind = 'goal' | 'constraint' | 'decision'
export interface Term { id: string; kind: TermKind; scope: string; text: string; supersedes?: string }
export interface Grant { action: string; scope: string }
export interface Change {
  add?: Term[]
  /** Term ids withdrawn without a replacement. */
  retract?: string[]
  deny?: Grant[]
  allow?: Grant[]
  /** Further scopes the change affects, such as a goal reworded without new terms. */
  scopes?: string[]
}
export interface ChangeResult {
  version: number
  duplicate: boolean
  affected: string[]
  /** Running packets whose premises changed: their commits will be quarantined. */
  stale: string[]
  /** Packets holding a revoked grant: the executor must stop them and call `confirmStopped`. */
  stop: string[]
}
export interface PacketSpec { id: string; task: string; scope: string; grants: Grant[]; writeSet: string[] }
export type PacketStatus = 'running' | 'stale' | 'stopping' | 'stopped' | 'committed' | 'quarantined'
export interface Output { target: string; content: string; baseVersion: number }
export type CommitResult =
  | { status: 'committed'; versions: Record<string, number> }
  | { status: 'quarantined'; reasons: string[] }
  | { status: 'conflict'; targets: string[] }
export type ActionStatus = 'sending' | 'sent' | 'unknown' | 'failed' | 'refused'
export interface ActionRequest { id: string; action: string; target: string; payload: string }

/** A change was made against a delegation version that is no longer current. */
export class VersionConflict extends Error {
  constructor(readonly expected: number, readonly actual: number) { super(`Delegation is at version ${actual}, not ${expected}`) }
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const json = <T>(value: string | number | null | undefined, fallback: T): T => typeof value === 'string' ? JSON.parse(value) as T : fallback

/** The delegation-consistency runtime: changes, work packets, commits and external actions over one `Store`. */
export class Keel {
  constructor(readonly store: Store = new Store()) {}

  version(): number { return Number(this.store.get('SELECT version FROM delegation WHERE id = 1')!.version) }
  scopeVersion(scope: string): number { return Number(this.store.get('SELECT version FROM scope_versions WHERE scope = ?', scope)?.version ?? 0) }
  /** Active terms whose scope overlaps `scope`: what a worker in `scope` must respect. */
  terms(scope = '/'): Term[] {
    return this.store.all("SELECT id, kind, scope, text, supersedes FROM terms WHERE status = 'active' ORDER BY rowid")
      .filter(row => overlaps(String(row.scope), scope))
      .map(row => ({ id: String(row.id), kind: row.kind as TermKind, scope: String(row.scope), text: String(row.text),
        ...row.supersedes ? { supersedes: String(row.supersedes) } : {} }))
  }
  /** Whether `action` on `scope` is currently denied. */
  denied(action: string, scope: string): boolean {
    return this.store.all('SELECT scope FROM denials WHERE action = ?', action).some(row => overlaps(String(row.scope), scope))
  }

  /**
   * Applies a user's change as delegation version `expected + 1`. A repeated `eventId` returns the first result without
   * applying anything again; an `expected` other than the current version throws `VersionConflict`.
   */
  applyChange(expected: number, eventId: string, change: Change): ChangeResult {
    const { store } = this
    return store.tx(() => {
      const seen = store.get('SELECT result FROM events WHERE id = ?', eventId)
      if (seen) return { ...json<ChangeResult>(seen.result, undefined as never), duplicate: true }
      const current = this.version()
      if (current !== expected) throw new VersionConflict(expected, current)
      const version = current + 1
      const affected = new Set(change.scopes ?? [])
      for (const term of change.add ?? []) {
        if (term.supersedes) {
          const old = store.get('SELECT scope FROM terms WHERE id = ?', term.supersedes)
          if (old) affected.add(String(old.scope))
          store.run("UPDATE terms SET status = 'superseded', until = ? WHERE id = ? AND status = 'active'", version, term.supersedes)
        }
        store.run("INSERT INTO terms VALUES (?, ?, ?, ?, 'active', ?, NULL, ?, ?)", term.id, term.kind, term.scope, term.text, version, eventId, term.supersedes ?? null)
        affected.add(term.scope)
      }
      for (const id of change.retract ?? []) {
        const old = store.get('SELECT scope FROM terms WHERE id = ?', id)
        if (old && store.run("UPDATE terms SET status = 'retracted', until = ? WHERE id = ? AND status = 'active'", version, id)) affected.add(String(old.scope))
      }
      for (const grant of change.deny ?? []) {
        store.run('INSERT OR IGNORE INTO denials VALUES (?, ?, ?)', grant.action, grant.scope, version)
        store.run('INSERT INTO revocations (action, scope, version) VALUES (?, ?, ?)', grant.action, grant.scope, version)
        affected.add(grant.scope)
      }
      for (const grant of change.allow ?? []) {
        store.run('DELETE FROM denials WHERE action = ? AND scope = ?', grant.action, grant.scope)
        affected.add(grant.scope)
      }
      for (const scope of affected) {
        store.run('INSERT INTO scope_versions VALUES (?, 1) ON CONFLICT(scope) DO UPDATE SET version = version + 1', scope)
      }
      store.run('UPDATE delegation SET version = ? WHERE id = 1', version)
      const stale: string[] = [], stop: string[] = []
      for (const packet of store.all("SELECT id, scope, grants FROM packets WHERE status IN ('running', 'stale')")) {
        const scope = String(packet.scope)
        const holdsRevoked = json<Grant[]>(packet.grants, []).some(grant => (change.deny ?? [])
          .some(denied => denied.action === grant.action && overlaps(denied.scope, grant.scope)))
        if (holdsRevoked) { store.run("UPDATE packets SET status = 'stopping' WHERE id = ?", String(packet.id)); stop.push(String(packet.id)); continue }
        if ([...affected].some(changed => overlaps(changed, scope))) {
          store.run("UPDATE packets SET status = 'stale' WHERE id = ?", String(packet.id)); stale.push(String(packet.id))
        }
      }
      const result: ChangeResult = { version, duplicate: false, affected: [...affected], stale, stop }
      store.run('INSERT INTO events VALUES (?, ?, ?, ?, ?)', eventId, 'change', JSON.stringify(change), JSON.stringify(result), store.iso())
      return result
    })
  }

  /** Starts a work packet on the current delegation; grants denied right now are not given. */
  startPacket(spec: PacketSpec): { version: number; grants: Grant[]; refused: Grant[] } {
    const { store } = this
    return store.tx(() => {
      const version = this.version()
      const snapshot = Object.fromEntries(store.all('SELECT scope, version FROM scope_versions')
        .filter(row => overlaps(String(row.scope), spec.scope)).map(row => [String(row.scope), Number(row.version)]))
      const seq = Number(store.get('SELECT IFNULL(MAX(seq), 0) AS seq FROM revocations')!.seq)
      const grants = spec.grants.filter(grant => !this.denied(grant.action, grant.scope))
      const refused = spec.grants.filter(grant => this.denied(grant.action, grant.scope))
      store.run("INSERT INTO packets VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, NULL)", spec.id, spec.task, spec.scope, version,
        JSON.stringify(snapshot), seq, JSON.stringify(grants), JSON.stringify(spec.writeSet), store.iso())
      return { version, grants, refused }
    })
  }

  /** Records that a packet read `item` at `version` (a term id, an artifact target with its version, a file with its hash). */
  recordRead(packet: string, kind: 'term' | 'artifact' | 'file' | 'source', item: string, version: string | number): void {
    this.store.run('INSERT OR REPLACE INTO reads VALUES (?, ?, ?, ?)', packet, kind, item, String(version))
  }

  /** The executor confirms a stopping packet's processes have exited. */
  confirmStopped(packet: string): void {
    this.store.run("UPDATE packets SET status = 'stopped', ended_at = ? WHERE id = ? AND status = 'stopping'", this.store.iso(), packet)
  }

  /** Ends a packet that will produce nothing more, such as one whose turn was interrupted to restart under new premises. */
  retire(packet: string): void {
    this.store.run("UPDATE packets SET status = 'stopped', ended_at = ? WHERE id = ? AND status IN ('running', 'stale', 'stopping')", this.store.iso(), packet)
  }
  /** The newest packet of `task` that has not ended. */
  current(task: string): string | undefined {
    const row = this.store.get("SELECT id FROM packets WHERE task = ? AND status IN ('running', 'stale', 'stopping') ORDER BY rowid DESC LIMIT 1", task)
    return row ? String(row.id) : undefined
  }
  /** How many packets `task` has had. */
  packets(task: string): number { return Number(this.store.get('SELECT COUNT(*) AS n FROM packets WHERE task = ?', task)!.n) }

  status(packet: string): PacketStatus | undefined { return this.store.get('SELECT status FROM packets WHERE id = ?', packet)?.status as PacketStatus | undefined }

  /** Why a packet's results may no longer become valid, checked inside the caller's transaction; empty when they may. */
  private premiseFailures(row: Row, action: string): string[] {
    const { store } = this
    const reasons: string[] = []
    const status = String(row.status)
    if (status === 'stopping' || status === 'stopped') reasons.push(`packet ${status}`)
    const scope = String(row.scope)
    const snapshot = json<Record<string, number>>(row.scope_snapshot, {})
    for (const changed of store.all('SELECT scope, version FROM scope_versions')) {
      const name = String(changed.scope)
      if (overlaps(name, scope) && Number(changed.version) !== (snapshot[name] ?? 0)) reasons.push(`scope ${name} changed (v${snapshot[name] ?? 0} → v${changed.version})`)
    }
    for (const read of store.all('SELECT kind, item, version FROM reads WHERE packet = ?', String(row.id))) {
      if (read.kind === 'term') {
        const term = store.get('SELECT status FROM terms WHERE id = ?', String(read.item))
        if (!term || term.status !== 'active') reasons.push(`read term ${read.item} is ${term?.status ?? 'missing'}`)
      } else if (read.kind === 'artifact') {
        const current = store.get('SELECT version FROM artifacts WHERE target = ?', String(read.item))
        if (String(current?.version ?? 0) !== String(read.version)) reasons.push(`read artifact ${read.item} changed (v${read.version} → v${current?.version ?? 0})`)
      }
    }
    const grants = json<Grant[]>(row.grants, [])
    const grant = grants.find(candidate => candidate.action === action)
    if (!grant) reasons.push(`no ${action} grant`)
    else {
      const revoked = store.all('SELECT scope FROM revocations WHERE action = ? AND seq > ?', action, Number(row.revocation_seq))
        .some(revocation => overlaps(String(revocation.scope), grant.scope))
      if (revoked || this.denied(action, grant.scope)) reasons.push(`${action} grant revoked`)
    }
    return reasons
  }

  /** Commits a packet's outputs; see the module comment. */
  commit(packetId: string, outputs: Output[]): CommitResult {
    const { store } = this
    return store.tx(() => {
      const row = store.get('SELECT * FROM packets WHERE id = ?', packetId)
      if (!row) throw new Error(`Unknown packet ${packetId}`)
      if (row.status === 'committed' || row.status === 'quarantined') throw new Error(`Packet ${packetId} already ended as ${row.status}`)
      const reasons = this.premiseFailures(row, 'write')
      const writeSet = json<string[]>(row.write_set, [])
      for (const output of outputs) if (!writeSet.includes(output.target)) reasons.push(`${output.target} is outside the write set`)
      if (reasons.length) {
        for (const output of outputs) {
          store.run('INSERT INTO quarantine (packet, target, hash, content, reasons, at) VALUES (?, ?, ?, ?, ?, ?)',
            packetId, output.target, hash(output.content), output.content, JSON.stringify(reasons), store.iso())
        }
        store.run("UPDATE packets SET status = 'quarantined', reasons = ?, ended_at = ? WHERE id = ?", JSON.stringify(reasons), store.iso(), packetId)
        return { status: 'quarantined', reasons }
      }
      const conflicts = outputs.filter(output => Number(store.get('SELECT version FROM artifacts WHERE target = ?', output.target)?.version ?? 0) !== output.baseVersion)
      if (conflicts.length) return { status: 'conflict', targets: conflicts.map(output => output.target) }
      const versions: Record<string, number> = {}
      for (const output of outputs) {
        const next = output.baseVersion + 1
        store.run('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(target) DO UPDATE SET version = excluded.version, hash = excluded.hash, content = excluded.content, packet = excluded.packet, delegation_version = excluded.delegation_version, at = excluded.at',
          output.target, next, hash(output.content), output.content, packetId, Number(row.delegation_version), store.iso())
        versions[output.target] = next
      }
      store.run("UPDATE packets SET status = 'committed', ended_at = ? WHERE id = ?", store.iso(), packetId)
      return { status: 'committed', versions }
    })
  }

  /** The accepted artifact at `target`, if any. */
  artifact(target: string): { version: number; content: string; packet: string } | undefined {
    const row = this.store.get('SELECT version, content, packet FROM artifacts WHERE target = ?', target)
    return row ? { version: Number(row.version), content: String(row.content), packet: String(row.packet) } : undefined
  }
  quarantined(packet?: string): { packet: string; target: string; reasons: string[] }[] {
    return this.store.all('SELECT packet, target, reasons FROM quarantine' + (packet ? ' WHERE packet = ?' : ''), ...(packet ? [packet] : []))
      .map(row => ({ packet: String(row.packet), target: String(row.target), reasons: json<string[]>(row.reasons, []) }))
  }

  /**
   * Admits an external action under the packet's premises and grant, recording it as `sending` before anything is sent.
   * A repeated action id returns its recorded status and is never admitted twice.
   */
  requestAction(packetId: string, request: ActionRequest): { admitted: boolean; status: ActionStatus; reasons: string[] } {
    const { store } = this
    return store.tx(() => {
      const existing = store.get('SELECT status FROM actions WHERE id = ?', request.id)
      if (existing) return { admitted: false, status: existing.status as ActionStatus, reasons: ['action already recorded'] }
      const row = store.get('SELECT * FROM packets WHERE id = ?', packetId)
      if (!row) throw new Error(`Unknown packet ${packetId}`)
      const reasons = this.premiseFailures(row, request.action)
      if (row.status === 'stale') reasons.push('packet premises changed')
      const status: ActionStatus = reasons.length ? 'refused' : 'sending'
      store.run('INSERT INTO actions VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)', request.id, packetId, request.action, request.target, request.payload,
        hash(`${request.action}\n${request.target}\n${request.payload}`), status, status === 'sending' ? 1 : 0, reasons.length ? JSON.stringify(reasons) : null, store.iso())
      return { admitted: !reasons.length, status, reasons }
    })
  }

  /** Records what became of a sent action: `sent` with the service's id, `failed` (a definite refusal), or `unknown`. */
  settleAction(id: string, outcome: { status: 'sent'; serverId: string } | { status: 'failed'; reason: string } | { status: 'unknown'; reason: string }): void {
    this.store.run("UPDATE actions SET status = ?, server_id = ?, reason = ? WHERE id = ? AND status IN ('sending', 'unknown')", outcome.status,
      outcome.status === 'sent' ? outcome.serverId : null, outcome.status === 'sent' ? null : outcome.reason, id)
  }

  action(id: string): { status: ActionStatus; attempts: number; fingerprint: string; serverId?: string } | undefined {
    const row = this.store.get('SELECT status, attempts, fingerprint, server_id FROM actions WHERE id = ?', id)
    return row ? { status: row.status as ActionStatus, attempts: Number(row.attempts), fingerprint: String(row.fingerprint), ...row.server_id ? { serverId: String(row.server_id) } : {} } : undefined
  }
  /** Actions whose outcome is not known yet: `sending` ones found after a restart, and `unknown` ones. */
  unsettled(): string[] { return this.store.all("SELECT id FROM actions WHERE status IN ('sending', 'unknown')").map(row => String(row.id)) }
}
