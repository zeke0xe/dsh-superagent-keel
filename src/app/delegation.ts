/**
 * The bridge between dsh-superagent and Keel's delegation-consistency runtime (src/keel/).
 *
 * - Every Assignment runs as a Keel work packet scoped to its ticket (`/t/<ticket>`), holding the grants the delegation
 *   allows now: `write` (change files in its checkout), `comment` (reply in the source conversation), `open_pr`, `push`.
 * - A person's change of mind becomes a new delegation version through `orchestrator_change`. Its authority comes from
 *   the person's own message, which the host verifies (a human the Policy allows), never from what a Session claims.
 * - Work whose premises changed is interrupted at once and restarts under a fresh packet that carries the change; whatever
 *   it queued before the change is refused at the submission gate, so an answer built on the old premises never goes out.
 */
import { join } from 'node:path'
import { Keel, VersionConflict, type Change, type ChangeResult, type Grant, type Term } from '../keel/keel.ts'
import { Store as KeelStore } from '../keel/store.ts'
import type { Ticket, Trigger } from '../core/index.ts'

export const ACTIONS = ['write', 'comment', 'open_pr', 'push'] as const
export type Action = typeof ACTIONS[number]
export const ticketScope = (ticketId: string): string => `/t/${ticketId}`

export interface DelegationHost {
  ticket(id: string): Ticket | undefined
  trigger(id: string): Trigger | undefined
  /** Whether `trigger` is a person the Policy lets ask for work, so their words may change the delegation. */
  authorized(trigger: Trigger): boolean
  /** Ends a ticket's worker turn and its background work now, keeping the ticket open. */
  interrupt(ticketId: string, reason: string): void
  /** Tells a ticket's worker something, delivered as its next input. */
  note(ticketId: string, text: string): void
}

/** What a person changed, as `orchestrator_change` receives it. */
export interface ChangeRequest {
  triggerId: string
  /** The ticket the change applies to; without it, the whole engagement. */
  ticketId?: string
  add?: { kind: Term['kind']; text: string; replaces?: string }[]
  retract?: string[]
  deny?: Action[]
  allow?: Action[]
}
export interface ChangeOutcome {
  version: number
  duplicate: boolean
  /** Tickets whose worker was interrupted and restarted under the change. */
  restarted: string[]
  /** Term ids now in force for the change's scope, so later changes can replace them. */
  terms: { id: string; kind: string; text: string }[]
}

/** Keel's delegation state for one dsh-superagent state directory, and the operations the runtime and tools call. */
export class Delegation {
  readonly keel: Keel
  constructor(stateDir: string, private readonly host: DelegationHost, path = join(stateDir, 'keel.sqlite')) {
    this.keel = new Keel(new KeelStore(path))
  }
  close(): void { this.keel.store.close() }

  /** The packet a ticket's messages and actions are judged under now. */
  packet(ticketId: string): string | undefined { return this.keel.current(ticketId) }

  /** Grants the delegation allows for a ticket right now. */
  grants(ticketId: string): Grant[] {
    const scope = ticketScope(ticketId)
    return ACTIONS.map(action => ({ action, scope })).filter(grant => !this.keel.denied(grant.action, scope))
  }

  /** Starts a packet for a ticket's Assignment, unless one is already open for it. */
  start(ticketId: string, assignmentId: string): string {
    const open = this.keel.current(ticketId)
    if (open?.startsWith(`${assignmentId}#`)) return open
    if (open) this.keel.retire(open)
    const id = `${assignmentId}#${this.keel.packets(ticketId) + 1}`
    this.keel.startPacket({ id, task: ticketId, scope: ticketScope(ticketId), grants: this.grants(ticketId), writeSet: [] })
    return id
  }

  /**
   * Applies a person's change. Throws when the trigger is unknown, not a person's, or from someone the Policy does not
   * allow to ask for work. The same trigger applies once.
   */
  change(request: ChangeRequest): ChangeOutcome {
    const trigger = this.host.trigger(request.triggerId)
    if (!trigger) throw new Error(`Unknown trigger ${request.triggerId}`)
    if (!trigger.human || !this.host.authorized(trigger)) {
      throw new Error('Only a message from a person allowed to ask for work can change what was asked; this one cannot')
    }
    if (request.ticketId && !this.host.ticket(request.ticketId)) throw new Error(`Unknown ticket ${request.ticketId}`)
    const scope = request.ticketId ? ticketScope(request.ticketId) : '/'
    const change: Change = {
      add: (request.add ?? []).map((term, index) => ({ id: `${request.triggerId}:${index + 1}`, kind: term.kind, scope, text: term.text,
        ...term.replaces ? { supersedes: term.replaces } : {} })),
      ...request.retract?.length ? { retract: request.retract } : {},
      ...request.deny?.length ? { deny: request.deny.map(action => ({ action, scope })) } : {},
      ...request.allow?.length ? { allow: request.allow.map(action => ({ action, scope })) } : {},
    }
    let result: ChangeResult | undefined
    for (let attempt = 0; !result; attempt++) {
      try { result = this.keel.applyChange(this.keel.version(), request.triggerId, change) } catch (error) {
        if (!(error instanceof VersionConflict) || attempt > 3) throw error
      }
    }
    const restarted = result.duplicate ? [] : this.restart(result, change)
    return { version: result.version, duplicate: result.duplicate, restarted,
      terms: this.keel.terms(scope).map(term => ({ id: term.id, kind: term.kind, text: term.text })) }
  }

  /** Interrupts every ticket whose packet the change touched and restarts it under a fresh packet that carries the change. */
  private restart(result: ChangeResult, change: Change): string[] {
    const tickets = new Map<string, string>()
    for (const packet of [...result.stop, ...result.stale]) {
      const row = this.keel.store.get('SELECT task FROM packets WHERE id = ?', packet)
      if (row) tickets.set(String(row.task), packet)
    }
    for (const [ticketId, packet] of tickets) {
      this.host.interrupt(ticketId, 'The person changed what they asked for')
      if (this.keel.status(packet) === 'stopping') this.keel.confirmStopped(packet)
      this.keel.retire(packet)
      const ticket = this.host.ticket(ticketId)
      const assignment = ticket?.assignments.at(-1)
      if (assignment && assignment.state !== 'ended') this.start(ticketId, assignment.id)
      this.host.note(ticketId, this.notice(ticketId, change))
    }
    return [...tickets.keys()]
  }

  /** What the restarted worker is told: what changed, what is in force, and what it may still do. */
  private notice(ticketId: string, change: Change): string {
    const scope = ticketScope(ticketId)
    const changed = [
      ...(change.add ?? []).map(term => `- ${term.kind}${term.supersedes ? ` (replaces ${term.supersedes})` : ''}: ${term.text}`),
      ...(change.retract ?? []).map(id => `- withdrawn: ${id}`),
      ...(change.deny ?? []).map(grant => `- no longer allowed: ${grant.action}`),
      ...(change.allow ?? []).map(grant => `- allowed again: ${grant.action}`),
    ].join('\n')
    const inForce = this.keel.terms(scope).map(term => `- [${term.id}] ${term.kind}: ${term.text}`).join('\n') || '- (none)'
    const grants = this.grants(ticketId).map(grant => grant.action).join(', ') || 'none'
    return `The person changed what they asked for. Your previous turn was stopped, and anything you queued before this change will not be sent.\n`
      + `Changed:\n${changed}\nNow in force:\n${inForce}\nYou may now: ${grants}. Re-check your work against this before continuing.`
  }

  /**
   * Whether a message queued under `packet` may still go out, recording it as a Keel action; `reasons` say why not.
   * Messages queued outside any packet, such as the main Session's own replies, are not judged here.
   */
  admit(packet: string | undefined, message: { id: string; channel: { thread: string }; text: string }): { ok: boolean; reasons: string[] } {
    if (!packet) return { ok: true, reasons: [] }
    const existing = this.keel.action(message.id)
    if (existing) return { ok: existing.status !== 'refused', reasons: existing.status === 'refused' ? ['refused before'] : [] }
    const result = this.keel.requestAction(packet, { id: message.id, action: 'comment', target: message.channel.thread, payload: message.text })
    return { ok: result.admitted, reasons: result.reasons }
  }
  /** Records the outcome of a message the gate admitted. */
  settled(id: string, sent: boolean): void {
    if (!this.keel.action(id)) return
    this.keel.settleAction(id, sent ? { status: 'sent', serverId: id } : { status: 'failed', reason: 'dropped by the Channel' })
  }
}
