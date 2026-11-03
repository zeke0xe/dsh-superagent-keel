/**
 * Tool-call checks for an Executor Session under the hardened sandbox (scripts/hardened/sandbox-exec).
 *
 * The bash tool runs every command inside Seatbelt, which denies reads under the operator's home except the ticket's own
 * directory. DSH's file tools (`read`, `glob`, `grep`, `write`, `edit`) run in the host process instead and the DSH file
 * sandbox does not restrict reads, so these checks keep them inside the ticket directory; a relative path that names a
 * resource, such as `github/pulls/12/thread/34`, stays allowed because it resolves inside the directory or to a resource the
 * host serves. A worker may not ask the bash tool to widen its sandbox: nobody is there to approve, and a wider mode would
 * drop the read rules.
 */
import { isAbsolute, normalize, relative, resolve } from 'node:path'

/** Tools whose path arguments the guard checks, with the argument names that hold a path or a pattern. */
const PATH_ARGS: Record<string, readonly string[]> = {
  read: ['file_path', 'path'],
  read_image: ['file_path', 'path'],
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  glob: ['path', 'pattern'],
  grep: ['path', 'glob'],
}

export const OUTSIDE = 'Path outside this ticket\'s directory; work only with files under it and the resources the host lists.'
export const NO_ESCALATION = 'This worker\'s shell sandbox cannot be widened; do the work inside the ticket directory.'
export const NO_DIRECTORY = 'This ticket has no working directory yet; file tools are unavailable.'

/** Whether `path`, relative to `directory` when not absolute, stays within `directory`. */
export function within(directory: string, path: string): boolean {
  if (path.includes('\0')) return false
  const target = isAbsolute(path) ? normalize(path) : resolve(directory, path)
  const rel = relative(resolve(directory), target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Returns why the tool call must not run, or `undefined` to let it run.
 * @param name - the tool's name.
 * @param input - the tool call's arguments.
 * @param directory - the ticket's working directory, or `undefined` before it exists.
 */
export function workerRefusal(name: string, input: unknown, directory: string | undefined): string | undefined {
  const args = (input ?? {}) as Record<string, unknown>
  if (name === 'bash' || name === 'pwsh') {
    const asked = args.sandbox_permissions
    return asked !== undefined && asked !== null && asked !== '' ? NO_ESCALATION : undefined
  }
  const keys = PATH_ARGS[name]
  if (!keys) return undefined
  if (!directory) return NO_DIRECTORY
  for (const key of keys) {
    const value = args[key]
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'string') return OUTSIDE
    // A glob pattern is matched under `path`; refuse absolute patterns and ones that climb out of it.
    if ((key === 'pattern' || key === 'glob') ? isAbsolute(value) || value.split(/[\\/]/).includes('..') : !within(directory, value)) {
      return OUTSIDE
    }
  }
  return undefined
}
