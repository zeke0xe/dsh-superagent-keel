/**
 * Tool-call checks for an Executor Session under the hardened sandbox (scripts/hardened/sandbox-exec).
 *
 * A worker reads and writes files only through the bash tool, whose every command runs inside Seatbelt. DSH's host file
 * tools (`read`, `glob`, `grep`, `write`, `edit`) run in the host process and resolve symbolic links there, outside the
 * sandbox, so a link in a worktree could reach the operator's credentials: workers never get them. Delegation tools a
 * Session registers for itself escape `tools.restrict`, so they are refused here. A worker may not ask the bash tool to widen
 * its sandbox: nobody is there to approve, and a wider mode would drop the read rules. Resources such as threads and
 * assignments are read with `orchestrator_read`, which the host serves.
 */

export const NO_ESCALATION = 'This worker\'s shell sandbox cannot be widened; do the work inside the ticket directory.'
export const USE_SHELL = 'Read and write files with the bash tool, which runs inside this worker\'s sandbox; host file tools are not available to workers.'
export const NO_DELEGATION = 'Workers do not start or message other agents; report to the orchestrator instead.'
/** Host-side file tools: they resolve symbolic links in the host process, outside the sandbox. */
const HOST_FILE_TOOLS = new Set(['read', 'read_image', 'write', 'edit', 'glob', 'grep'])
/** Tools a Session registers for itself, which `tools.restrict` cannot hide. */
const DELEGATION_TOOLS = new Set(['subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent'])

/**
 * Returns why the tool call must not run, or `undefined` to let it run.
 * @param name - the tool's name.
 * @param input - the tool call's arguments.
 */
export function workerRefusal(name: string, input: unknown): string | undefined {
  if (HOST_FILE_TOOLS.has(name)) return USE_SHELL
  if (DELEGATION_TOOLS.has(name)) return NO_DELEGATION
  if (name === 'bash' || name === 'pwsh') {
    const asked = ((input ?? {}) as Record<string, unknown>).sandbox_permissions
    return asked !== undefined && asked !== null && asked !== '' ? NO_ESCALATION : undefined
  }
  return undefined
}
