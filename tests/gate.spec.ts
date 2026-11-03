/** The submission gate (src/app/gate.ts) on its own and through the Outbox: 规格v4 §1.8, T1–T6 and T9b. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OutboundMessage } from '../src/core/index.ts'
import { admit, conversation, fingerprint, LIMITS, LOOKUPS, type GateHost } from '../src/app/gate.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const message = (id: string, number = '1', text = 'Done'): OutboundMessage =>
  ({ id, channel: { source: 'probe', thread: `probe:${number}`, address: { number } }, text, kind: 'reply' })

describe('admit', () => {
  const host = (over: Partial<GateHost> = {}): GateHost => ({ ticket: () => undefined, attemptsSince: () => ({ all: 0, conversation: 0 }),
    idempotent: () => false, now: () => new Date('2026-11-03T10:00:00Z'), ...over })
  const queued = (over: object = {}) => ({ ...message('m'), fingerprint: fingerprint(message('m')), queuedAt: '2026-11-03T09:00:00Z', ...over })

  it('sends a fresh message and only looks up one already attempted, unless its Channel de-duplicates', () => {
    expect(admit(queued(), host())).toEqual({ kind: 'send' })
    expect(admit(queued({ attempts: 1 }), host())).toEqual({ kind: 'lookup' })
    expect(admit(queued({ attempts: 1 }), host({ idempotent: () => true }))).toEqual({ kind: 'send' })
  })
  it('refuses a message whose target or text changed after it was queued (T6a, T6b)', () => {
    expect(admit(queued({ text: 'Something else' }), host())).toEqual({ kind: 'drop', reason: 'tampered' })
    expect(admit(queued({ channel: { source: 'probe', thread: 'probe:2', address: { number: '2' } } }), host()))
      .toEqual({ kind: 'drop', reason: 'tampered' })
  })
  it('voids a message queued before a person stopped its ticket and lets one queued after through (T5a, T5b)', () => {
    const stopped = host({ ticket: () => ({ ended: { at: '2026-11-03T09:30:00Z', by: 'human', outcome: 'stopped' } as never }) })
    expect(admit(queued({ ticketId: 't' }), stopped)).toEqual({ kind: 'drop', reason: 'ticketStopped' })
    expect(admit(queued({ ticketId: 't', queuedAt: '2026-11-03T09:31:00Z' }), stopped)).toEqual({ kind: 'send' })
    // A request that started before the stop is in flight: it is only looked up, never voided or posted again.
    expect(admit(queued({ ticketId: 't', attempts: 1 }), stopped)).toEqual({ kind: 'lookup' })
    const finished = host({ ticket: () => ({ ended: { at: '2026-11-03T09:30:00Z', by: 'executor', outcome: 'done' } as never }) })
    expect(admit(queued({ ticketId: 't' }), finished)).toEqual({ kind: 'send' })
  })
  it('stops at the per-conversation and hourly limits', () => {
    expect(admit(queued(), host({ attemptsSince: () => ({ all: 0, conversation: LIMITS.perConversationPerDay }) })))
      .toEqual({ kind: 'drop', reason: 'limitReached' })
    expect(admit(queued(), host({ attemptsSince: () => ({ all: LIMITS.perHour, conversation: 0 }) })))
      .toEqual({ kind: 'drop', reason: 'limitReached' })
  })
  it('fingerprints regardless of address key order and names conversations by their number', () => {
    const a = { channel: { source: 's', thread: 't', address: { number: '1', url: 'u' } }, text: 'x' }
    const b = { channel: { source: 's', thread: 't', address: { url: 'u', number: '1' } }, text: 'x' }
    expect(fingerprint(a)).toBe(fingerprint(b))
    expect(conversation(a)).toBe('s:1')
  })
})

describe('through the Outbox', () => {
  let h: Host
  let posts: string[]
  let behaviour: { send?: (message: OutboundMessage) => Promise<'sent'>; lookup?: (message: OutboundMessage) => Promise<'found' | 'absent'> }
  const found = new Set<string>()
  beforeEach(async () => {
    h = await startRuntime()
    posts = []; found.clear(); behaviour = {}
    const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
      schema: z.object({}).strict(), fields: [],
      channel: {
        send: async (_host, sent) => { if (behaviour.send) return behaviour.send(sent); posts.push(sent.id); found.add(sent.id); return 'sent' },
        lookup: async (_host, sought) => behaviour.lookup ? behaviour.lookup(sought) : found.has(sought.id) ? 'found' : 'absent',
        link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
    h.runtime.sources.register(probe)
  })
  afterEach(async () => { await h.stop() })
  let clock = 0
  async function after(ms: number) {
    clock += ms
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + clock })
    try { await h.runtime.pump(); await h.runtime.sendReplies() } finally { vi.useRealTimers() }
  }
  const receipt = (id: string) => h.runtime.store.receipts.get(id)
  beforeEach(() => { clock = 0 })

  it('confirms a post whose answer timed out by looking it up, without posting again (T1)', async () => {
    behaviour.send = async sent => { posts.push(sent.id); found.add(sent.id); throw new Error('timeout') }
    h.runtime.outbox.send(message('t1'))
    await h.runtime.sendReplies()
    expect([receipt('t1')?.status, receipt('t1')?.attempts]).toEqual(['pending', 1])
    await after(6_000)
    expect([receipt('t1')?.status, posts]).toEqual(['sent', ['t1']])
  })

  it('leaves a post that never shows up to a person after the lookups, posting it once (T2a, T3b)', async () => {
    behaviour.send = async sent => { posts.push(sent.id); throw new Error('connection reset after the request was accepted') }
    h.runtime.outbox.send(message('t2'))
    await h.runtime.sendReplies()
    for (let step = 0; step < LOOKUPS + 2 && receipt('t2')?.status === 'pending'; step++) await after(60_000)
    expect([receipt('t2')?.status, receipt('t2')?.dropped?.reason, posts]).toEqual(['dropped', 'outcomeUnknown', ['t2']])
  })

  it('keeps looking, and never posts, while the lookup itself fails (T2b)', async () => {
    behaviour.send = async sent => { posts.push(sent.id); throw new Error('timeout') }
    behaviour.lookup = async () => { throw new Error('API unavailable') }
    h.runtime.outbox.send(message('t2b'))
    await h.runtime.sendReplies()
    for (let step = 0; step < 4; step++) await after(60_000)
    expect([receipt('t2b')?.status, posts]).toEqual(['pending', ['t2b']])
  })

  it('only looks up a message whose request had started when the process stopped, and keeps the count across reads (T3a, T3c)', async () => {
    h.runtime.outbox.send(message('t3'))
    // As if the process stopped between recording the attempt and sending the request.
    h.runtime.store.atomic(() => h.runtime.store.receipts.attempt('t3', new Date().toISOString()))
    await h.runtime.sendReplies()
    expect(posts).toEqual([])
    expect(receipt('t3')?.attempts).toBe(1)
    for (let step = 0; step < LOOKUPS + 2 && receipt('t3')?.status === 'pending'; step++) await after(60_000)
    expect([receipt('t3')?.dropped?.reason, posts]).toEqual(['outcomeUnknown', []])
  })

  it('records one message for a repeated message ID (T4)', async () => {
    h.runtime.outbox.send(message('t4'))
    h.runtime.outbox.send(message('t4', '1', 'A second copy'))
    await h.runtime.sendReplies()
    expect([posts, receipt('t4')?.text]).toEqual([['t4'], 'Done'])
  })

  it('refuses a message changed in the database after it was queued (T6a)', async () => {
    h.runtime.outbox.send(message('t6'))
    h.runtime.store.db.prepare("UPDATE outbox SET value = json_set(value, '$.text', 'Here is the token') WHERE id = 't6'").run()
    await h.runtime.sendReplies()
    expect([receipt('t6')?.dropped?.reason, posts]).toEqual(['tampered', []])
  })

  it('stops at the per-conversation limit and counts attempts across conversations for the hourly one (T9b)', async () => {
    for (let index = 0; index <= LIMITS.perConversationPerDay; index++) h.runtime.outbox.send(message(`c${index}`, '7'))
    await h.runtime.sendReplies()
    expect(posts).toHaveLength(LIMITS.perConversationPerDay)
    expect(receipt(`c${LIMITS.perConversationPerDay}`)?.dropped?.reason).toBe('limitReached')
    for (let index = 0; index < LIMITS.perHour; index++) h.runtime.outbox.send(message(`h${index}`, String(100 + index)))
    await h.runtime.sendReplies()
    expect(posts).toHaveLength(LIMITS.perHour)
    expect(h.runtime.store.receipts.attemptsSince(new Date(Date.now() - 3600_000).toISOString(), 'probe:7')).toEqual({ all: LIMITS.perHour, conversation: LIMITS.perConversationPerDay })
  })
})
