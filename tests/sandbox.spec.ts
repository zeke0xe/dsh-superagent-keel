/**
 * The hardened Seatbelt wrapper (scripts/hardened/sandbox-exec) against a fake home: 规格v4 §1.8 T10a–c and T7b's
 * "a leftover process stays confined". macOS only; the wrapper is a no-op elsewhere.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer as createHttp } from 'node:http'
import { createServer as createNet, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { confinedPids, cwdPids, reapConfined } from '../src/infra/leftovers.ts'

const WRAPPER = join(import.meta.dirname, '..', 'scripts', 'hardened', 'sandbox-exec')
const mac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')

describe.skipIf(!mac)('hardened sandbox-exec', () => {
  let home: string, workspace: string, state: string, port: number, socket: string
  let http: ReturnType<typeof createHttp>, unix: Server
  beforeAll(async () => {
    // The fake home sits under the system temporary directory, which Seatbelt resolves through /private.
    home = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-home-')))
    state = join(home, '.dsh', 'state', 'superagent')
    workspace = join(state, 'work', 'answer-question-0123456789ab')
    for (const dir of [join(home, '.config', 'gh'), join(home, '.ssh'), join(home, 'Documents'), workspace, join(state, 'worker-bin')]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'oauth_token: gho_secret\n')
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY\n')
    writeFileSync(join(home, '.dsh', '.env'), 'DEEPSEEK_API_KEY=sk-secret\n')
    writeFileSync(join(home, 'Documents', 'diary.txt'), 'private\n')
    writeFileSync(join(state, 'orchestrator.sqlite'), 'db\n')
    writeFileSync(join(state, 'worker-gitconfig'), '[user]\n')
    writeFileSync(join(workspace, 'README.md'), 'hello\n')
    http = createHttp((_request, response) => response.end('panel'))
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    port = (http.address() as { port: number }).port
    socket = join(tmpdir(), `sbx-${process.pid}.sock`)
    unix = createNet(connection => connection.end('agent'))
    await new Promise<void>(resolve => unix.listen(socket, resolve))
  })
  afterAll(() => { http?.close(); unix?.close(); rmSync(home, { recursive: true, force: true }); rmSync(socket, { force: true }) })

  /** Runs `script` with sh under DSH's workspace-write profile through the wrapper; resolves with the exit code and output. */
  function confined(script: string, extra: Record<string, string> = {}): Promise<{ code: number; out: string }> {
    const profile = `(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null")) (allow file-write* (subpath "${workspace}") (subpath "/private/tmp"))`
    return new Promise(resolve => execFile(WRAPPER, ['-p', profile, '--', '/bin/sh', '-c', script], {
      cwd: workspace, timeout: 20_000,
      env: { PATH: '/usr/bin:/bin', HOME: home, SUPERAGENT_STATE_DIR: state, SUPERAGENT_ADMIN_PORT: String(port), NO_PROXY: '*', no_proxy: '*', ...extra },
    }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out: stdout + stderr })))
  }

  it('lets a command read and write its own workspace and read the worker git configuration', async () => {
    expect(await confined('cat README.md && echo more > notes.txt && cat notes.txt')).toEqual({ code: 0, out: 'hello\nmore\n' })
    expect((await confined(`cat "${state}/worker-gitconfig"`)).code).toBe(0)
  })

  it('reads none of the credentials, the state database or the rest of home, by any path spelling (T10a)', async () => {
    for (const path of ['.config/gh/hosts.yml', '.ssh/id_ed25519', '.dsh/.env', 'Documents/diary.txt', '.dsh/state/superagent/orchestrator.sqlite']) {
      const result = await confined(`cat "$HOME/${path}"`)
      expect([path, result.code, result.out]).toEqual([path, 1, expect.stringMatching(/Operation not permitted/)])
    }
    expect((await confined('cat ../../orchestrator.sqlite')).code).not.toBe(0)
    expect((await confined(`cat "/private${home}/.dsh/.env" || cat "${home}/./.ssh/../.ssh/id_ed25519"`)).code).not.toBe(0)
    expect((await confined('ls "$HOME"')).code).not.toBe(0)
    // A symbolic link the command makes in its workspace does not lift the rule: Seatbelt checks the resolved path.
    expect((await confined('ln -s "$HOME/.ssh/id_ed25519" key && cat key')).code).not.toBe(0)
  })

  it('keeps credentials and the state database unreadable even when SUPERAGENT_READ_ALLOW opens their directory', async () => {
    const allow = { SUPERAGENT_READ_ALLOW: `${home}/.dsh:${home}/.ssh` }
    expect((await confined('cat "$HOME/.dsh/.env"', allow)).code).not.toBe(0)
    expect((await confined('cat "$HOME/.ssh/id_ed25519"', allow)).code).not.toBe(0)
    expect((await confined(`cat "${state}/orchestrator.sqlite"`, allow)).code).not.toBe(0)
    expect((await confined(`cat "${state}/worker-gitconfig"`, allow)).code).toBe(0)
  })

  it('cannot write outside the workspace', async () => {
    expect((await confined('echo x > "$HOME/planted"')).code).not.toBe(0)
    expect((await confined(`echo x >> "${state}/worker-gitconfig"`)).code).not.toBe(0)
  })

  it('cannot reach the management port or a Unix socket such as an SSH agent (T10b, T10c)', async () => {
    const panel = await confined(`/usr/bin/curl -s --max-time 3 http://127.0.0.1:${port}/`)
    expect([panel.code === 0, panel.out]).toEqual([false, expect.not.stringContaining('panel')])
    const agent = await confined(`/usr/bin/nc -U "${socket}" < /dev/null`)
    expect(agent.out).not.toContain('agent')
  })

  it('finds and kills a confined process that left its process group, after the command returned (T7a, T7b)', async () => {
    // The child leaves the process group and lets go of the command's output, so the command returns while it keeps running.
    writeFileSync(join(workspace, 'linger.py'), ['import os', 'if os.fork() == 0:', '    os.setsid()',
      '    null = os.open("/dev/null", os.O_RDWR)', '    for fd in (0, 1, 2): os.dup2(null, fd)', '    os.execv("/bin/sleep", ["sleep", "60"])'].join('\n'))
    const started = await confined('/usr/bin/python3 linger.py')
    expect(started.code).toBe(0)
    const { found, remaining } = await reapConfined(workspace)
    expect(found.length).toBeGreaterThan(0)
    expect(remaining).toEqual([])
  })

  it('keeps a process that leaves the process group confined (T7b)', async () => {
    const script = ['import os, sys', 'if os.fork() == 0:', '    os.setsid()', '    try:',
      "        open(os.environ['HOME'] + '/.dsh/.env').read(); print('leaked')", '    except Exception as error:',
      '        print(type(error).__name__)', '    sys.stdout.flush(); os._exit(0)', 'os.wait()'].join('\n')
    writeFileSync(join(workspace, 'escape.py'), script)
    const result = await confined('/usr/bin/python3 escape.py')
    expect(result.out).toContain('PermissionError')
    expect(result.out).not.toContain('leaked')
  })
})

describe('leftover processes', () => {
  it('finds processes by their workspace marker, not by a longer path that starts the same', () => {
    const listing = ['  101 /bin/sh -c x PATH=/bin SUPERAGENT_CONFINED=/w/a HOME=/h', '  102 sleep 9 SUPERAGENT_CONFINED=/w/ab',
      '  103 python3 x SUPERAGENT_CONFINED=/w/a', '  104 node dsh', `  ${process.pid} node SUPERAGENT_CONFINED=/w/a`].join('\n')
    expect(confinedPids(listing, '/w/a')).toEqual([101, 103])
  })
  it('finds processes by their working directory', () => {
    expect(cwdPids(['p11', 'fcwd', 'n/w/a/src', 'p12', 'fcwd', 'n/w/ab', 'p13', 'fcwd', 'n/w/a'].join('\n'), '/w/a')).toEqual([11, 13])
  })
  it('kills what it found and reports what survived', async () => {
    const alive = new Set([7, 8])
    const list = async () => [...alive]
    expect(await reapConfined('/w/a', list, pid => { if (pid === 7) alive.delete(pid) }, 0)).toEqual({ found: [7, 8], remaining: [8] })
    expect(await reapConfined('', list)).toEqual({ found: [], remaining: [] })
  })
})
