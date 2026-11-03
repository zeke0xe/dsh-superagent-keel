/**
 * Submission gate for outbound Channel messages (design: 规格v4 §1). Every message a Source would post passes here first,
 * inside one store transaction, so admission and a person's stop are ordered against each other:
 *
 * - the message must still match the fingerprint taken when it was queued (immutable payload);
 * - a message queued for a Ticket before a person stopped it is voided; one queued after the stop, such as the confirmation,
 *   goes out;
 * - per-conversation and global hourly limits count every attempt, reserved in the same transaction (loop and spend brakes);
 * - before the first request the receipt records `attempts: 1`, so after a crash, a timeout or any error the message is never
 *   posted again by a Channel that cannot de-duplicate: it is only looked up, and an absent result after `LOOKUPS` tries
 *   settles as `outcomeUnknown` for a person to resolve. A Channel that de-duplicates by message ID (Feishu) may resend.
 *
 * The promise is narrowed accordingly: no automatic duplicate posts, at the price of occasionally leaving one unsent.
 */
import { createHash } from 'node:crypto'
import type { OutboundMessage, Ticket } from '../core/index.ts'

/** How many times an unconfirmed message is looked up before it settles as `outcomeUnknown`. */
export const LOOKUPS = 3
/** Limits counted over every attempted message; reaching one drops further messages as `limitReached`. */
export const LIMITS = { perConversationPerDay: 6, perHour: 20 }

/** Gate fields stored on a receipt next to the message. */
export interface GateState {
  /** SHA-256 of the channel and text, taken when the message was queued. */
  fingerprint?: string
  /** When the message was queued (ISO time). */
  queuedAt?: string
  /** Requests started; never more than one for a Channel that cannot de-duplicate. */
  attempts?: number
  /** When the first request started (ISO time); what the limits count. */
  attemptAt?: string
  /** Lookups that found nothing so far. */
  lookups?: number
}

/** What the gate lets `Outbox` do with a pending receipt. */
export type Admission =
  | { kind: 'send' }
  | { kind: 'lookup' }
  | { kind: 'drop'; reason: 'tampered' | 'ticketStopped' | 'limitReached' }

/** The fingerprint of a message's target and text. */
export function fingerprint(message: Pick<OutboundMessage, 'channel' | 'text'>): string {
  const address = Object.fromEntries(Object.entries(message.channel.address).sort(([a], [b]) => a.localeCompare(b)))
  return createHash('sha256').update(JSON.stringify([message.channel.source, address, message.text])).digest('hex')
}

/** A key naming one conversation of a Channel, for the per-conversation limit. */
export function conversation(message: Pick<OutboundMessage, 'channel'>): string {
  const { source, address } = message.channel
  return `${source}:${address.number ?? address.chat ?? address.chatId ?? address.thread ?? JSON.stringify(address)}`
}

export interface GateHost {
  ticket(id: string): Pick<Ticket, 'ended'> | undefined
  /** Attempts started since `since` (ISO time), overall and in `conversation`. */
  attemptsSince(since: string, conversation: string): { all: number; conversation: number }
  /** Whether this message's Channel de-duplicates repeated sends of one message ID. */
  idempotent(message: OutboundMessage): boolean
  now(): Date
}

/**
 * Decides what to do with a pending receipt. Call inside the store transaction that then records the outcome
 * (`attempts`/`attemptAt` for a send, or the drop).
 */
export function admit(receipt: OutboundMessage & GateState, host: GateHost): Admission {
  if (receipt.fingerprint !== undefined && receipt.fingerprint !== fingerprint(receipt)) return { kind: 'drop', reason: 'tampered' }
  const attempted = (receipt.attempts ?? 0) > 0
  // Already attempted: never post again unless the Channel de-duplicates; the earlier request may have gone through.
  if (attempted) return host.idempotent(receipt) ? { kind: 'send' } : { kind: 'lookup' }
  const ticket = receipt.ticketId ? host.ticket(receipt.ticketId) : undefined
  if (ticket?.ended?.by === 'human' && receipt.queuedAt !== undefined && receipt.queuedAt <= ticket.ended.at) {
    return { kind: 'drop', reason: 'ticketStopped' }
  }
  const now = host.now().getTime()
  const day = host.attemptsSince(new Date(now - 24 * 3600_000).toISOString(), conversation(receipt))
  const hour = host.attemptsSince(new Date(now - 3600_000).toISOString(), conversation(receipt))
  if (day.conversation >= LIMITS.perConversationPerDay || hour.all >= LIMITS.perHour) return { kind: 'drop', reason: 'limitReached' }
  return { kind: 'send' }
}
