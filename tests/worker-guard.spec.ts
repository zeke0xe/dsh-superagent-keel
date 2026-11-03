import { expect, test } from 'vitest'
import { NO_DELEGATION, NO_ESCALATION, USE_SHELL, workerRefusal } from '../src/app/worker-guard.ts'

test('refuses every host file tool, whatever the path, so a symbolic link cannot leave the sandbox', () => {
  for (const name of ['read', 'read_image', 'write', 'edit', 'glob', 'grep']) {
    expect(workerRefusal(name, { file_path: 'leak' })).toBe(USE_SHELL)
  }
})

test('refuses delegation tools that a Session registers for itself', () => {
  for (const name of ['subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent']) {
    expect(workerRefusal(name, {})).toBe(NO_DELEGATION)
  }
})

test('refuses sandbox escalation and lets ordinary commands and other tools through', () => {
  expect(workerRefusal('bash', { command: 'cat ~/.ssh/id_ed25519', sandbox_permissions: 'danger-full-access', justification: 'x' })).toBe(NO_ESCALATION)
  expect(workerRefusal('bash', { command: 'pytest' })).toBeUndefined()
  expect(workerRefusal('web_search', { query: 'x' })).toBeUndefined()
  expect(workerRefusal('orchestrator_report', { state: 'ready' })).toBeUndefined()
})
