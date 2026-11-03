/**
 * Sends admitted external actions through a service adapter, at most once per action. A request whose answer is lost is
 * looked up by its fingerprint, never sent again; one still unconfirmed after the lookups stays `unknown` for a person.
 */
import type { Keel } from './keel.ts'

/** An external service, such as GitHub comments or Feishu messages, seen through two calls. */
export interface ActionService {
  /** Performs the action. Throws `OutcomeUnknown` when the request may have gone through; any other error is a definite failure. */
  send(action: { id: string; action: string; target: string; payload: string; fingerprint: string }): Promise<{ serverId: string }>
  /** Looks for an earlier send by fingerprint, without sending; `undefined` when not found. */
  find(fingerprint: string, target: string): Promise<{ serverId: string } | undefined>
}

/** The request may or may not have reached the service: a timeout, a dropped connection, a crash after sending. */
/** The request may or may not have reached the service. */
export class OutcomeUnknown extends Error {}

export async function perform(keel: Keel, service: ActionService, id: string): Promise<ReturnType<Keel['action']>> {
  const row = keel.store.get('SELECT action, target, payload, fingerprint, status FROM actions WHERE id = ?', id)
  if (!row) throw new Error(`Unknown action ${id}`)
  if (row.status !== 'sending') return keel.action(id)
  try {
    const { serverId } = await service.send({ id, action: String(row.action), target: String(row.target), payload: String(row.payload), fingerprint: String(row.fingerprint) })
    keel.settleAction(id, { status: 'sent', serverId })
  } catch (error) {
    if (error instanceof OutcomeUnknown) keel.settleAction(id, { status: 'unknown', reason: error.message })
    else keel.settleAction(id, { status: 'failed', reason: String(error instanceof Error ? error.message : error) })
  }
  return keel.action(id)
}

/**
 * Settles actions whose outcome is unknown, including ones left `sending` by a crash, by looking them up. Never sends.
 * @returns the ids still unknown after the lookup.
 */
export async function reconcile(keel: Keel, service: ActionService): Promise<string[]> {
  const still: string[] = []
  for (const id of keel.unsettled()) {
    const row = keel.store.get('SELECT target, fingerprint FROM actions WHERE id = ?', id)!
    let found: { serverId: string } | undefined
    try { found = await service.find(String(row.fingerprint), String(row.target)) } catch { found = undefined }
    if (found) keel.settleAction(id, { status: 'sent', serverId: found.serverId })
    else { keel.settleAction(id, { status: 'unknown', reason: 'not found by lookup' }); still.push(id) }
  }
  return still
}
