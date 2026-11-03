/**
 * Processes a ticket's worker left behind after its shell jobs were stopped (design: 规格v4 §1.6, T7).
 *
 * DSH stops a job's process group, but on macOS a process that left its group (setsid, double fork) escapes that. Every
 * command the hardened wrapper (scripts/hardened/sandbox-exec) confines carries `SUPERAGENT_CONFINED=<workspace>` in its
 * environment, which children inherit, so the operator's own `ps -E` finds them whatever their process group; a process whose
 * working directory is inside the workspace is found too. A process that does neither is not found; it still runs inside the
 * sandbox, without credentials or the management port.
 */
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'

/** Lists the PIDs of the operator's processes confined to `workspace`. */
export type ProcessLister = (workspace: string) => Promise<number[]>

const run = (file: string, args: string[]): Promise<string> => new Promise(resolve => {
  // A failed listing (lsof exits 1 when a process vanished mid-scan) still returns what it printed.
  execFile(file, args, { maxBuffer: 32 * 1024 * 1024 }, (_error, stdout) => resolve(stdout ?? ''))
})

/**
 * Both signs, because macOS hides the environment of platform binaries such as `/bin/sleep` from `ps -E`, while a process
 * that changed directory is still found by its marker.
 */
const listConfined: ProcessLister = async workspace => [...new Set([
  ...confinedPids(await run('/bin/ps', ['-E', '-x', '-o', 'pid=,command=']), workspace),
  ...cwdPids(await run('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fpn']), workspace),
])]

/** PIDs whose working directory, from `lsof -d cwd -Fpn`, is `workspace` or below it, excluding `self`. */
export function cwdPids(listing: string, workspace: string, self = process.pid): number[] {
  const pids: number[] = []
  let pid = 0
  for (const line of listing.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid && pid !== self) {
      const dir = line.slice(1)
      if (dir === workspace || dir.startsWith(workspace + '/')) pids.push(pid)
    }
  }
  return pids
}

/** PIDs whose environment says they were confined to `workspace`, excluding `self`. */
export function confinedPids(listing: string, workspace: string, self = process.pid): number[] {
  const marker = `SUPERAGENT_CONFINED=${workspace}`
  const pids: number[] = []
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    // The marker must end at a space or the line end, so `/work/a` does not match `/work/ab`.
    const at = match[2]!.indexOf(marker)
    if (pid !== self && at >= 0 && /^(\s|$)/.test(match[2]!.slice(at + marker.length))) pids.push(pid)
  }
  return pids
}

/**
 * Kills every process still confined to `workspace` and reports what remained.
 * @returns the PIDs found at first, and those still alive after SIGKILL and a short wait.
 */
export async function reapConfined(workspace: string, list: ProcessLister = listConfined,
  kill: (pid: number) => void = pid => process.kill(pid, 'SIGKILL'), waitMs = 500): Promise<{ found: number[]; remaining: number[] }> {
  if (!workspace) return { found: [], remaining: [] }
  // DSH hands the sandbox the workspace's resolved path.
  try { workspace = realpathSync(workspace) } catch { /* removed already; match the path as given */ }
  const found = await list(workspace)
  for (const pid of found) try { kill(pid) } catch { /* already gone */ }
  if (!found.length) return { found, remaining: [] }
  await new Promise(resolve => setTimeout(resolve, waitMs))
  const after = new Set(await list(workspace))
  return { found, remaining: found.filter(pid => after.has(pid)) }
}
