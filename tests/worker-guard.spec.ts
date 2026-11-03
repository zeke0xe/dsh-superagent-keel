import { expect, test } from 'vitest'
import { NO_DIRECTORY, NO_ESCALATION, OUTSIDE, within, workerRefusal } from '../src/app/worker-guard.ts'

const dir = '/state/work/fix-typo-0123456789ab'

test('keeps paths inside the ticket directory, including relative resource paths', () => {
  expect(within(dir, 'src/a.ts')).toBe(true)
  expect(within(dir, `${dir}/src/a.ts`)).toBe(true)
  expect(within(dir, dir)).toBe(true)
  expect(within(dir, 'github/pulls/12/thread/34')).toBe(true)
  expect(within(dir, '../other-ticket/secret')).toBe(false)
  expect(within(dir, '/Users/me/.config/gh/hosts.yml')).toBe(false)
  expect(within(dir, `${dir}-evil/x`)).toBe(false)
  expect(within(dir, 'a\0b')).toBe(false)
})

test('refuses file tools outside the directory and allows them inside', () => {
  expect(workerRefusal('read', { file_path: '/Users/me/.dsh/.env' }, dir)).toBe(OUTSIDE)
  expect(workerRefusal('read', { file_path: 'README.md' }, dir)).toBeUndefined()
  expect(workerRefusal('write', { file_path: '../../worker-gitconfig', content: 'x' }, dir)).toBe(OUTSIDE)
  expect(workerRefusal('edit', { file_path: `${dir}/a.ts` }, dir)).toBeUndefined()
  expect(workerRefusal('grep', { pattern: 'token', path: '/Users/me' }, dir)).toBe(OUTSIDE)
  expect(workerRefusal('grep', { pattern: 'token', glob: '../**/*.yml' }, dir)).toBe(OUTSIDE)
  expect(workerRefusal('grep', { pattern: 'token' }, dir)).toBeUndefined()
  expect(workerRefusal('glob', { pattern: '/Users/me/**' }, dir)).toBe(OUTSIDE)
  expect(workerRefusal('glob', { pattern: '../**/*' }, dir)).toBe(OUTSIDE)
  expect(workerRefusal('glob', { pattern: '**/*.ts' }, dir)).toBeUndefined()
  expect(workerRefusal('read', { file_path: 42 }, dir)).toBe(OUTSIDE)
})

test('refuses file tools before the ticket has a directory', () => {
  expect(workerRefusal('read', { file_path: 'a' }, undefined)).toBe(NO_DIRECTORY)
  expect(workerRefusal('bash', { command: 'ls' }, undefined)).toBeUndefined()
})

test('refuses sandbox escalation and lets ordinary commands through', () => {
  expect(workerRefusal('bash', { command: 'cat ~/.ssh/id_ed25519', sandbox_permissions: 'danger-full-access', justification: 'x' }, dir)).toBe(NO_ESCALATION)
  expect(workerRefusal('bash', { command: 'pytest' }, dir)).toBeUndefined()
  expect(workerRefusal('web_search', { query: 'x' }, dir)).toBeUndefined()
})
