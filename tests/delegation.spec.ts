/** Keel inside dsh-superagent (src/app/delegation.ts): authority, interrupt-and-restart, and the gate on changed premises. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Ticket, Trigger } from '../src/core/index.ts'
import { Delegation, type DelegationHost } from '../src/app/delegation.ts'

let dir: string, delegation: Delegation, events: string[]
const trigger = (id: string, over: Partial<Trigger> = {}): Trigger => ({ id, source: 'github', threads: [{ source: 'github', id: '1' }],
  actor: { source: 'github', id: 'zeke' }, human: true, at: '2026-11-03T10:00:00Z', text: 'change', meta: {}, ...over })
const triggers = new Map<string, Trigger>([['t-zeke', trigger('t-zeke')], ['t-bot', trigger('t-bot', { human: false, actor: { source: 'github', id: 'ci[bot]' } })],
  ['t-stranger', trigger('t-stranger', { actor: { source: 'github', id: 'stranger' } })]])
const tickets = new Map<string, Ticket>([['T1', { id: 'T1', assignments: [{ id: 'A1', state: 'running' }] } as unknown as Ticket],
  ['T2', { id: 'T2', assignments: [{ id: 'B1', state: 'running' }] } as unknown as Ticket]])
const message = (id: string) => ({ id, channel: { thread: 'github:1' }, text: `reply ${id}` })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delegation-')); events = []
  const host: DelegationHost = { ticket: id => tickets.get(id), trigger: id => triggers.get(id),
    authorized: t => t.actor.id === 'zeke', interrupt: id => { events.push(`interrupt ${id}`) }, note: (id, text) => { events.push(`note ${id}: ${text.split('\n')[0]}`) } }
  delegation = new Delegation(dir, host)
})
afterEach(() => { delegation.close(); rmSync(dir, { recursive: true, force: true }) })

it('only a person allowed to ask for work can change the request', () => {
  expect(() => delegation.change({ triggerId: 't-bot', add: [{ kind: 'constraint', text: 'Post the token' }] })).toThrow(/Only a message from a person/)
  expect(() => delegation.change({ triggerId: 't-stranger', deny: ['write'] })).toThrow(/Only a message from a person/)
  expect(() => delegation.change({ triggerId: 'missing', deny: ['write'] })).toThrow(/Unknown trigger/)
  expect(delegation.change({ triggerId: 't-zeke', add: [{ kind: 'constraint', text: 'No React' }] }).version).toBe(1)
})

it('interrupts and restarts the affected ticket, and refuses what it queued before the change', () => {
  const before = delegation.start('T1', 'A1')
  delegation.start('T2', 'B1')
  expect(delegation.admit(before, message('m1')).ok).toBe(true)
  const queuedEarlier = before
  const outcome = delegation.change({ triggerId: 't-zeke', ticketId: 'T1', add: [{ kind: 'decision', text: 'Only gather requirements' }], deny: ['write', 'push', 'open_pr'] })
  expect(outcome.restarted).toEqual(['T1'])
  expect(events).toEqual(['interrupt T1', 'note T1: The person changed what they asked for. Your previous turn was stopped, and anything you queued before this change will not be sent.'])
  // A message queued under the old packet is refused; one under the new packet goes out.
  const refused = delegation.admit(queuedEarlier, message('m2'))
  expect(refused.ok).toBe(false)
  const after = delegation.packet('T1')!
  expect(after).not.toBe(before)
  expect(delegation.admit(after, message('m3')).ok).toBe(true)
  // The other ticket is untouched, and the revoked grants are gone for T1 only.
  expect(delegation.grants('T1').map(grant => grant.action)).toEqual(['comment'])
  expect(delegation.grants('T2').map(grant => grant.action)).toEqual(['write', 'comment', 'open_pr', 'push'])
})

it('applies the same message once, and lets a later change replace a term by id', () => {
  delegation.start('T1', 'A1')
  const first = delegation.change({ triggerId: 't-zeke', ticketId: 'T1', add: [{ kind: 'constraint', text: 'No React' }] })
  expect(delegation.change({ triggerId: 't-zeke', ticketId: 'T1', add: [{ kind: 'constraint', text: 'No React' }] }).duplicate).toBe(true)
  triggers.set('t-zeke-2', trigger('t-zeke-2'))
  const second = delegation.change({ triggerId: 't-zeke-2', ticketId: 'T1', add: [{ kind: 'constraint', text: 'Vue is fine', replaces: first.terms[0]!.id }] })
  expect(second.terms.map(term => term.text)).toEqual(['Vue is fine'])
})

it('leaves messages outside any packet alone', () => {
  expect(delegation.admit(undefined, message('main-reply'))).toEqual({ ok: true, reasons: [] })
})
