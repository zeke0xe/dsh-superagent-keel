/** Reliable outbound message delivery backed by persistent receipts and retried reply effects. */
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { FAILURES_BEFORE_ERROR, Later, type Effects } from './effects.ts'
import { admit, LOOKUPS } from './gate.ts'
import type { Receipt, Store } from './store.ts'

export interface OutboxHost {
  readonly store: Pick<Store, 'atomic' | 'receipts' | 'tickets'>
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'channelAllowed' | 'send' | 'lookup' | 'idempotent'>
  readonly commands: Commands
  paused(): boolean
  /** The clock the submission gate reads; defaults to the system clock. */
  now?(): Date
}

/**
 * Persists outbound channel messages as receipts and delivers them sequentially through `Effects` and `SourceRegistry`.
 * Implements the core `Outbox` port for `Engine` and source contexts, ensuring per-conversation ordering for each ticket until an earlier message fails repeatedly.
 * Messages wait while processing is paused or their source is unavailable, and settle as dropped when the target conversation is ignored or gone.
 */
export class Outbox implements OutboxPort {
  constructor(private readonly host: OutboxHost) {
    host.effects.handle('reply', (_payload, id) => this.deliver(id), { limit: () => host.paused() ? 0 : 1, retry: [5000, 300_000] })
  }
  /** Record a message receipt and enqueue its delivery effect atomically; duplicate message IDs are ignored. */
  send(message: OutboundMessage): void {
    // Validate IM reply length here; acknowledgements are already validated when decided.
    if (message.kind === 'reply' && message.channel.source === 'feishu') checkedImText(message.text)
    const { store, effects } = this.host
    store.atomic(() => { if (store.receipts.add(message)) effects.enqueue('reply', message.id, {}) })
  }
  status(id: string): ReplyStatus | undefined { return this.host.store.receipts.get(id)?.status }
  withdraw(id: string): void {
    const { store, effects } = this.host
    store.atomic(() => { if (store.receipts.withdraw(id)) effects.cancel('reply', id) })
  }
  sent(): Promise<void> { return this.host.effects.idle('reply') }
  private async deliver(id: string): Promise<void> {
    const { store, sources, commands } = this.host
    const receipt = store.receipts.get(id)
    if (receipt?.status !== 'pending') return
    if (!sources.instance(receipt.channel.source)?.enabled) throw new Later('The Source is off or not installed')
    // Hold later messages for the same ticket and conversation behind an earlier pending message until it exceeds the failure threshold.
    if (store.receipts.behind(id, FAILURES_BEFORE_ERROR)) throw new Later('An earlier message of this ticket to this conversation waits')
    if (!sources.channelAllowed(receipt.channel)) { store.receipts.settle(receipt, 'channelIgnored'); return }
    // The submission gate (src/app/gate.ts) decides and records in one transaction, ordered against a person's stop.
    const now = () => this.host.now?.() ?? new Date()
    const admission = store.atomic(() => {
      const current = store.receipts.get(id)
      if (current?.status !== 'pending') return undefined
      const decided = admit(current, { now, ticket: ticketId => store.tickets.get(ticketId),
        attemptsSince: (since, key) => store.receipts.attemptsSince(since, key), idempotent: message => sources.idempotent(message) })
      if (decided.kind === 'drop') store.receipts.settle(current, decided.reason)
      // Record the attempt before the request, so a crash or timeout after it never leads to a second post.
      if (decided.kind === 'send') store.receipts.attempt(id, now().toISOString())
      return decided
    })
    if (!admission || admission.kind === 'drop') return
    if (admission.kind === 'lookup') { await this.confirm(receipt); return }
    // A permanently unreachable target (such as a recalled message or deleted Issue) settles as `channelGone` so its receipt prevents retries.
    const result = await sources.send(receipt, commands)
    if (result === 'waiting') throw new Later('The Source is not installed')
    store.receipts.settle(receipt, result === 'gone' ? 'channelGone' : 'sent')
  }
  /** Settles a message whose earlier request may have gone through, by looking for it rather than posting again. */
  private async confirm(receipt: Receipt): Promise<void> {
    const { store, sources, commands } = this.host
    let found: Awaited<ReturnType<typeof sources.lookup>>
    try { found = await sources.lookup(receipt, commands) } catch (error) {
      // A lookup that keeps failing is counted like one that finds nothing, so the message reaches a person.
      if (store.atomic(() => store.receipts.lookedUp(receipt.id)) < LOOKUPS) throw error
      store.receipts.settle(receipt, 'outcomeUnknown'); return
    }
    if (found === 'waiting') throw new Later('The Source is not installed')
    if (found === 'found') { store.receipts.settle(receipt, 'sent'); return }
    if (found === 'gone') { store.receipts.settle(receipt, 'channelGone'); return }
    // Not found yet: the platform may show it late, so look again with backoff before leaving it to a person.
    if (found === 'absent' && store.atomic(() => store.receipts.lookedUp(receipt.id)) < LOOKUPS) {
      throw new Error('The earlier send is not visible yet; looking again before deciding')
    }
    store.receipts.settle(receipt, 'outcomeUnknown')
  }
}
