import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageError, parseArgs, run, type CliIo } from '../src/cli.ts'
import { runCli } from './helpers/cli.ts'
import { makeRepo, type TempRepo } from './helpers/repo.ts'
import { testStateDir } from './setup.ts'

const BIN_PATH = join(import.meta.dirname, '..', 'bin', 'worktree-ports.ts')
const POSIX_ONLY = process.platform === 'win32' ? 'signals differ on Windows' : false

type T = { after: (fn: () => void | Promise<void>) => void }

const CONFIG = {
  services: { api: { offset: 0, default: 8080 }, web: { offset: 1, default: 3000 } },
  env: { PORT: '{api}', ROOT: '{root}' },
}

async function waitForFile(path: string, deadlineMs = 5000): Promise<void> {
  const start = Date.now()
  while (!existsSync(path)) {
    if (Date.now() - start > deadlineMs) throw new Error(`timed out waiting for ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Kill a process (and, if `group`, its whole process group) without throwing if it's already gone. */
function killQuietly(child: ChildProcess, group = false): void {
  try {
    if (group && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
    else child.kill('SIGKILL')
  } catch {
    // already exited
  }
}

function capture(cwd: string, env: Record<string, string | undefined> = {}) {
  const out: string[] = []
  const err: string[] = []
  const io: CliIo = {
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    env: { PATH: process.env.PATH, ...env },
    cwd,
  }
  return { io, out, err }
}

function writeConfig(dir: string, config: Record<string, unknown> = CONFIG): string {
  const path = join(dir, 'worktree-ports.json')
  writeFileSync(path, JSON.stringify(config))
  return path
}

/** A temp repo with a config in its main checkout, plus helpers for configured linked worktrees. */
function repoWithConfig(t: T, config: Record<string, unknown> = CONFIG): TempRepo & { worktree(name: string): string } {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  writeConfig(repo.main, config)
  return {
    ...repo,
    worktree(name) {
      const wt = repo.addWorktree(name)
      writeConfig(wt, config)
      return wt
    },
  }
}

/** Point the registry at a fresh empty state dir for this test (in-process `run` reads process.env). */
function freshStateDir(t: T): string {
  const dir = mkdtempSync(join(testStateDir(), 'cli-'))
  const before = process.env.WORKTREE_PORTS_STATE_DIR
  process.env.WORKTREE_PORTS_STATE_DIR = dir
  t.after(() => {
    process.env.WORKTREE_PORTS_STATE_DIR = before
  })
  return dir
}

function claimFiles(stateDir: string): string[] {
  const dir = join(stateDir, 'claims')
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

/** A child that writes the named env vars as JSON to a file. */
function dumpEnvArgs(file: string, ...keys: string[]): string[] {
  const script = `require('fs').writeFileSync(${JSON.stringify(file)}, JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k => [k, process.env[k] ?? null]))))`
  return ['--', process.execPath, '-e', script]
}

async function server(t: T, body: Record<string, unknown>): Promise<number> {
  const s: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => s.close(() => resolve())))
  return (s.address() as AddressInfo).port
}

/** A config whose `api` default is `apiPort` and whose verify target is that port. */
function verifyConfig(apiPort: number): Record<string, unknown> {
  return {
    services: { api: { offset: 0, default: apiPort }, web: { offset: 1, default: 3 } },
    env: { PORT: '{api}' },
    verify: { url: 'http://127.0.0.1:{api}/health', field: 'root', expect: '{root}' },
  }
}

function noConfigDir(t: T): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-ports-cli-noconfig-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// --- parseArgs and usage ---

test('parseArgs', () => {
  const base = { json: false, verify: false, verbose: false, dryRun: false, rest: [] }
  assert.deepEqual(parseArgs(['exec', '--verify', '--config', 'c.json', '--', 'vite', '--host']), {
    ...base,
    command: 'exec',
    verify: true,
    config: 'c.json',
    rest: ['vite', '--host'],
  })
  assert.deepEqual(parseArgs(['show', '--json']), { ...base, command: 'show', json: true })
  assert.deepEqual(parseArgs(['status', '--json']), { ...base, command: 'status', json: true })
  assert.deepEqual(parseArgs(['list', '--json']), { ...base, command: 'list', json: true })
  assert.deepEqual(parseArgs(['release', '--config', 'x.json']), { ...base, command: 'release', config: 'x.json' })
  assert.deepEqual(parseArgs(['prune', '--unused-for', '12w', '--dry-run']), {
    ...base,
    command: 'prune',
    dryRun: true,
    unusedForDays: 84,
  })
  assert.deepEqual(parseArgs(['--version']), { ...base, command: 'version' })
  assert.deepEqual(parseArgs(['--help']), { ...base, command: 'help' })
  assert.deepEqual(parseArgs(['exec', '--port', 'web', '--', 'x']), {
    ...base,
    command: 'exec',
    port: 'web',
    rest: ['x'],
  })
  assert.equal(parseArgs(['env', '--port', 'web']).port, 'web')
  assert.equal(parseArgs(['exec', '-v', '--', 'x']).verbose, true)
  assert.equal(parseArgs(['exec', '--verbose', '--', 'x']).verbose, true)
  assert.throws(() => parseArgs(['show', '--port', 'web']), /--port does not apply to show/)
  assert.throws(() => parseArgs(['env', '-v']), /-v does not apply to env/)
  assert.throws(() => parseArgs([]), UsageError)
  assert.throws(() => parseArgs(['launch']), UsageError)
  assert.throws(() => parseArgs(['constructor']), UsageError)
  assert.throws(() => parseArgs(['version']), UsageError)
  assert.throws(() => parseArgs(['exec']), /needs a command after --/)
  assert.throws(() => parseArgs(['show', '--bogus']), /unknown option --bogus/)
  assert.throws(() => parseArgs(['show', 'extra']), /unexpected argument "extra"/)
  assert.throws(() => parseArgs(['show', '--verify']), /--verify does not apply to show/)
  assert.throws(() => parseArgs(['status', '--verify']), /--verify does not apply to status/)
  assert.throws(() => parseArgs(['env', '--json']), /--json does not apply to env/)
  assert.throws(() => parseArgs(['list', '--config', 'c.json']), /--config does not apply to list/)
  assert.throws(() => parseArgs(['show', '--config']), /--config needs a value/)
  assert.throws(() => parseArgs(['prune', '--unused-for', '3m']), UsageError)
})

test('a usage error exits 2', async () => {
  const { io, err } = capture(process.cwd())
  assert.equal(await run(['nope'], io), 2)
  assert.match(err.join('\n'), /^worktree-ports: unknown command "nope"/)
  assert.match(err.join('\n'), /usage:/)
})

test('--help prints usage and --version the package version', async () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
  const help = capture(process.cwd())
  assert.equal(await run(['--help'], help.io), 0)
  assert.match(help.out.join('\n'), /worktree-ports prune {3}\[--unused-for <duration>\] \[--dry-run\]/)
  const version = capture(process.cwd())
  assert.equal(await run(['--version'], version.io), 0)
  assert.deepEqual(version.out, [pkg.version])
})

test('prune --unused-for 3m exits 2', async () => {
  const r = await runCli(['prune', '--unused-for', '3m'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /worktree-ports: --unused-for: invalid duration "3m"/)
})

// --- show ---

test('show in a linked worktree prints the context, block and ports', async (t) => {
  const repo = repoWithConfig(t)
  const wt = repo.worktree('feat')
  const { io, out } = capture(wt)
  assert.equal(await run(['show'], io), 0)
  const block = /^block: (\d+)-(\d+)$/.exec(out[4] ?? '')
  assert.ok(block, out.join('\n'))
  const base = Number(block[1])
  assert.equal(Number(block[2]), base + 9)
  assert.deepEqual(out, [
    'context: linked worktree',
    'name: feat',
    `root: ${wt}`,
    `config: ${join(wt, 'worktree-ports.json')}`,
    `block: ${base}-${base + 9}`,
    `api: ${base}`,
    `web: ${base + 1}`,
  ])
})

test('show in the main checkout uses the defaults', async (t) => {
  const repo = repoWithConfig(t)
  const { io, out } = capture(repo.main)
  assert.equal(await run(['show'], io), 0)
  assert.deepEqual(out, [
    'context: main checkout',
    'name: main',
    `root: ${repo.main}`,
    `config: ${join(repo.main, 'worktree-ports.json')}`,
    'block: none (defaults)',
    'api: 8080',
    'web: 3000',
  ])
})

test('show --json in a linked worktree and the main checkout', async (t) => {
  const repo = repoWithConfig(t, { ...verifyConfig(8080), env: { PORT: '{api}', ROOT: '{root}' } })
  const wt = repo.worktree('feat')

  const linked = capture(wt)
  assert.equal(await run(['show', '--json'], linked.io), 0)
  const l = JSON.parse(linked.out.join('\n'))
  assert.deepEqual(Object.keys(l), ['context', 'name', 'root', 'configPath', 'block', 'ports', 'env', 'verify'])
  assert.deepEqual(l.context, { kind: 'linked-worktree', mode: 'auto', reason: 'linked worktree' })
  assert.equal(l.name, 'feat')
  assert.equal(l.root, wt)
  assert.equal(l.configPath, join(wt, 'worktree-ports.json'))
  assert.equal(l.block.size, 10)
  assert.deepEqual(l.ports, { api: l.block.base, web: l.block.base + 1 })
  assert.deepEqual(l.env, { PORT: String(l.block.base), ROOT: wt })
  assert.deepEqual(l.verify, { url: `http://127.0.0.1:${l.block.base}/health`, field: 'root', expect: wt })

  const main = capture(repo.main)
  assert.equal(await run(['show', '--json'], main.io), 0)
  const m = JSON.parse(main.out.join('\n'))
  assert.deepEqual(m.context, { kind: 'main-checkout', mode: 'auto', reason: 'main checkout' })
  assert.equal(m.name, 'main')
  assert.equal(m.block, null)
  assert.deepEqual(m.ports, { api: 8080, web: 3 })
  assert.deepEqual(m.env, { PORT: '8080', ROOT: repo.main })
})

test('show --json without a verify section omits verify', async (t) => {
  const repo = repoWithConfig(t)
  const { io, out } = capture(repo.main)
  assert.equal(await run(['show', '--json'], io), 0)
  assert.equal('verify' in JSON.parse(out.join('\n')), false)
})

// --- env ---

test('env prints shell-quoted exports', async (t) => {
  const repo = repoWithConfig(t, { ...CONFIG, env: { ROOT: "{root}/it's", PORT: '{api}' } })
  const { io, out } = capture(repo.main)
  assert.equal(await run(['env'], io), 0)
  assert.deepEqual(out, [`export ROOT='${repo.main}/it'\\''s'`, `export PORT='8080'`])
})

test('env --port appends PORT and the marker', async (t) => {
  const repo = repoWithConfig(t, { ...CONFIG, env: { ROOT: '{root}', PORT: '{api}' } })
  const { io, out } = capture(repo.main)
  assert.equal(await run(['env', '--port', 'web'], io), 0)
  assert.deepEqual(out, [`export ROOT='${repo.main}'`, `export PORT='3000'`, `export WORKTREE_PORTS_PORT='3000'`])
})

test('env --port with an unknown service exits 1', async (t) => {
  const repo = repoWithConfig(t)
  const { io, out, err } = capture(repo.main)
  assert.equal(await run(['env', '--port', 'nope'], io), 1)
  assert.deepEqual(out, [])
  assert.match(err.join('\n'), /unknown service "nope" for --port; declared services: api, web/)
})

// --- exec ---

test('exec passes the rendered env, never overwrites, and warns on a differing value', async (t) => {
  const repo = repoWithConfig(t, { ...CONFIG, env: { PORT: '{api}', ROOT: '{root}', SAME: 'x' } })
  const wt = repo.worktree('feat')
  const file = join(repo.dir, 'env.json')
  const { io, err } = capture(wt, { ROOT: '/explicit', SAME: 'x' })
  assert.equal(await run(['exec', ...dumpEnvArgs(file, 'PORT', 'ROOT', 'SAME')], io), 0)
  const seen = JSON.parse(readFileSync(file, 'utf8'))
  assert.match(seen.PORT, /^\d+0$/)
  assert.ok(Number(seen.PORT) >= 20000, `PORT was ${seen.PORT}`)
  assert.equal(seen.ROOT, '/explicit')
  assert.equal(seen.SAME, 'x')
  const stderr = err.join('\n')
  assert.match(stderr, /worktree-ports: ROOT is already set to "\/explicit"; keeping it/)
  assert.doesNotMatch(stderr, /SAME/)
})

test('exec passes through the child exit code', async (t) => {
  const repo = repoWithConfig(t)
  const r = await runCli(['exec', '--', process.execPath, '-e', 'process.exit(7)'], { cwd: repo.main })
  assert.equal(r.code, 7)
})

test('exec: a nonexistent command exits 127', async (t) => {
  const repo = repoWithConfig(t)
  const r = await runCli(['exec', '--', 'definitely-not-a-command-xyz'], { cwd: repo.main })
  assert.equal(r.code, 127)
  assert.match(r.stderr, /worktree-ports: could not start "definitely-not-a-command-xyz"/)
})

test('exec: a child killed by a signal maps to 128+n', { skip: POSIX_ONLY }, async (t) => {
  const repo = repoWithConfig(t)
  const r = await runCli(['exec', '--', process.execPath, '-e', "process.kill(process.pid, 'SIGTERM')"], {
    cwd: repo.main,
  })
  assert.equal(r.code, 143) // 128 + SIGTERM (15)
})

test('exec: SIGTERM sent to the wrapper reaches the child', { timeout: 20_000, skip: POSIX_ONLY }, async (t) => {
  const repo = repoWithConfig(t)
  const readyFile = join(repo.dir, 'ready-sigterm.txt')
  const markerFile = join(repo.dir, 'marker-sigterm.txt')
  const script = [
    'const fs = require("fs")',
    `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(markerFile)}, 'got-it'); process.exit(0) })`,
    `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready')`,
    'setInterval(() => {}, 1000)',
  ].join('; ')
  // detached so a failed or timed-out run can still be cleaned up as a whole process group (the grandchild
  // `node -e` otherwise survives an unsignaled wrapper forever).
  const wrapper = spawn(process.execPath, [BIN_PATH, 'exec', '--', process.execPath, '-e', script], {
    cwd: repo.main,
    stdio: 'ignore',
    detached: true,
  })
  t.after(() => killQuietly(wrapper, true))

  await waitForFile(readyFile)
  wrapper.kill('SIGTERM') // aimed at the wrapper only, not the group: proves the wrapper itself forwards it
  const [code] = await Promise.all([
    new Promise<number | null>((resolve) => wrapper.on('exit', (c) => resolve(c))),
    waitForFile(markerFile),
  ])
  assert.equal(code, 0)
})

test(
  'exec: one process-group SIGINT reaches the child exactly once',
  { timeout: 20_000, skip: POSIX_ONLY },
  async (t) => {
    const repo = repoWithConfig(t)
    const readyFile = join(repo.dir, 'ready-sigint.txt')
    const countFile = join(repo.dir, 'count-sigint.txt')
    const script = [
      'const fs = require("fs")',
      'let count = 0',
      'let timer = null',
      `process.on('SIGINT', () => { count++; if (!timer) timer = setTimeout(() => { fs.writeFileSync(${JSON.stringify(countFile)}, String(count)); process.exit(0) }, 300) })`,
      `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready')`,
      'setInterval(() => {}, 1000)',
    ].join('; ')
    const wrapper = spawn(process.execPath, [BIN_PATH, 'exec', '--', process.execPath, '-e', script], {
      cwd: repo.main,
      stdio: 'ignore',
      detached: true,
    })
    t.after(() => killQuietly(wrapper, true))

    await waitForFile(readyFile)
    assert.ok(wrapper.pid !== undefined)
    process.kill(-wrapper.pid!, 'SIGINT')
    const [code] = await Promise.all([
      new Promise<number | null>((resolve) => wrapper.on('exit', (c) => resolve(c))),
      waitForFile(countFile),
    ])
    assert.equal(readFileSync(countFile, 'utf8'), '1')
    assert.equal(code, 0)
  },
)

// --- exec --verify ---

test('exec --verify starts the command on a match', async (t) => {
  const repo = repoWithConfig(t, verifyConfig(1)) // rewritten below once the server's root is known
  writeConfig(repo.main, verifyConfig(await server(t, { root: repo.main })))
  const file = join(repo.dir, 'ran.json')
  const { io, err } = capture(repo.main)
  assert.equal(await run(['exec', '--verify', ...dumpEnvArgs(file, 'PORT')], io), 0)
  assert.ok(existsSync(file))
  assert.doesNotMatch(err.join('\n'), /starting anyway|Refusing/)
})

test('exec --verify refuses on a mismatch, exit 1', async (t) => {
  const repo = repoWithConfig(t, verifyConfig(await server(t, { root: '/some/other/checkout' })))
  const file = join(repo.dir, 'ran.json')
  const { io, err } = capture(repo.main)
  assert.equal(await run(['exec', '--verify', ...dumpEnvArgs(file, 'PORT')], io), 1)
  assert.equal(existsSync(file), false, 'the child must not run')
  assert.match(err.join('\n'), /belongs to "\/some\/other\/checkout", not this checkout/)
})

test('exec --verify warns and starts when nothing answers', async (t) => {
  const repo = repoWithConfig(t, verifyConfig(1))
  const file = join(repo.dir, 'ran.json')
  const { io, err } = capture(repo.main)
  assert.equal(await run(['exec', '--verify', ...dumpEnvArgs(file, 'PORT')], io), 0)
  assert.ok(existsSync(file))
  assert.match(err.join('\n'), /nothing is answering at http:\/\/127\.0\.0\.1:1\/health.*starting anyway/)
})

test('exec --verify warns and starts when the field is unreported', async (t) => {
  const repo = repoWithConfig(t, verifyConfig(await server(t, { status: 'ok' })))
  const file = join(repo.dir, 'ran.json')
  const { io, err } = capture(repo.main)
  assert.equal(await run(['exec', '--verify', ...dumpEnvArgs(file, 'PORT')], io), 0)
  assert.ok(existsSync(file))
  assert.match(err.join('\n'), /did not report "root".*starting anyway/)
})

test('exec --verify without a verify section is a usage error', async (t) => {
  const repo = repoWithConfig(t)
  const { io } = capture(repo.main)
  assert.equal(await run(['exec', '--verify', '--', process.execPath, '-e', ''], io), 2)
})

// --- exec --verbose ---

const SAFE_ARG = /^[A-Za-z0-9_/.,:=@%+-]+$/
const shownArg = (a: string) => (SAFE_ARG.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`)
const NOOP = ['--', process.execPath, '-e', '0']

test('exec -v lists set, replaced and kept variables and the command', async (t) => {
  const repo = repoWithConfig(t, { ...CONFIG, env: { ROOT: '{root}', ADDR: '127.0.0.1:{api}' } })
  const { io, err } = capture(repo.main, {
    PORT: '8080',
    WORKTREE_PORTS_PORT: '8080',
    ADDR: '127.0.0.1:9000',
    SECRET: 'hunter2',
  })
  assert.equal(await run(['exec', '-v', '--port', 'web', ...NOOP], io), 0)
  assert.deepEqual(err, [
    'worktree-ports: main (main checkout): api=8080 web=3000',
    `worktree-ports:   set      ROOT=${repo.main}`,
    'worktree-ports:   kept     ADDR=127.0.0.1:9000 (this checkout would use 127.0.0.1:8080)',
    'worktree-ports:   replaced PORT=3000 (--port web; was 8080 from an outer exec)',
    'worktree-ports:   replaced WORKTREE_PORTS_PORT=3000',
    `worktree-ports: running: ${NOOP.slice(1).map(shownArg).join(' ')}`,
  ])
  assert.doesNotMatch(err.join('\n'), /hunter2|already set/)
})

test('exec -v marks a set PORT with its service', async (t) => {
  const repo = repoWithConfig(t)
  const { io, err } = capture(repo.main)
  assert.equal(await run(['exec', '-v', '--port', 'web', ...NOOP], io), 0)
  const i = err.indexOf('worktree-ports:   set      PORT=3000 (--port web)')
  assert.ok(i >= 0, err.join('\n'))
  assert.equal(err[i + 1], 'worktree-ports:   set      WORKTREE_PORTS_PORT=3000')
})

test('exec -v shows a kept value even when equal', async (t) => {
  const repo = repoWithConfig(t)
  const { io, err } = capture(repo.main, { ROOT: repo.main })
  assert.equal(await run(['exec', '-v', ...NOOP], io), 0)
  assert.ok(
    err.includes(`worktree-ports:   kept     ROOT=${repo.main} (this checkout would use ${repo.main})`),
    err.join('\n'),
  )
})

test('exec -v quotes the command', async (t) => {
  const repo = repoWithConfig(t)
  const { io, err } = capture(repo.main)
  assert.equal(await run(['exec', '-v', '--', process.execPath, '-e', 'process.exit(0)'], io), 0)
  assert.match(err.at(-1)!, /^worktree-ports: running: .* -e 'process\.exit\(0\)'$/)
})

test('exec -v reports a verify match', async (t) => {
  const repo = repoWithConfig(t, verifyConfig(1))
  const port = await server(t, { root: repo.main })
  writeConfig(repo.main, verifyConfig(port))
  const { io, err } = capture(repo.main)
  assert.equal(await run(['exec', '-v', '--verify', ...NOOP], io), 0)
  const verifyAt = err.indexOf(`worktree-ports: verify: http://127.0.0.1:${port}/health reports this checkout`)
  const lastVar = err.findLastIndex((l) => l.startsWith('worktree-ports:   '))
  assert.ok(verifyAt > lastVar && lastVar > 0, err.join('\n'))
  assert.ok(err[verifyAt + 1]!.startsWith('worktree-ports: running: '))
})

test('exec -v with a verify mismatch still refuses', async (t) => {
  const repo = repoWithConfig(t, verifyConfig(await server(t, { root: '/some/other/checkout' })))
  const file = join(repo.dir, 'ran.json')
  const { io, err } = capture(repo.main)
  assert.equal(await run(['exec', '-v', '--verify', ...dumpEnvArgs(file, 'PORT')], io), 1)
  assert.equal(existsSync(file), false, 'the child must not run')
  assert.doesNotMatch(err.join('\n'), /running:/)
})

test('exec -v off and no config', async (t) => {
  const repo = repoWithConfig(t)
  const off = capture(repo.main, { WORKTREE_PORTS: 'off' })
  assert.equal(await run(['exec', '-v', ...NOOP], off.io), 0)
  assert.deepEqual(off.err, [
    'worktree-ports: nothing added (WORKTREE_PORTS=off)',
    `worktree-ports: running: ${NOOP.slice(1).map(shownArg).join(' ')}`,
  ])

  const none = capture(noConfigDir(t))
  assert.equal(await run(['exec', '-v', ...NOOP], none.io), 0)
  assert.equal(none.err.length, 3, none.err.join('\n'))
  assert.match(none.err[0]!, /running the command unchanged/)
  assert.equal(none.err[1], 'worktree-ports: nothing added (no config found)')
  assert.match(none.err[2]!, /^worktree-ports: running: /)
})

test('flags after -- belong to the child', () => {
  const a = parseArgs(['exec', '--', 'node', '-v'])
  assert.equal(a.verbose, false)
  assert.deepEqual(a.rest, ['node', '-v'])
  const b = parseArgs(['exec', '--port', 'web', '--', 'next', 'dev', '--port', '4000'])
  assert.equal(b.port, 'web')
  assert.deepEqual(b.rest, ['next', 'dev', '--port', '4000'])
})

test('exec without -v prints no variable lines', async (t) => {
  const repo = repoWithConfig(t, { ...CONFIG, env: { ROOT: '{root}', ADDR: '127.0.0.1:{api}' } })
  const { io, err } = capture(repo.main, { ADDR: '127.0.0.1:9000', SECRET: 'hunter2' })
  assert.equal(await run(['exec', '--port', 'web', ...NOOP], io), 0)
  assert.equal(
    err[0],
    'worktree-ports: ADDR is already set to "127.0.0.1:9000"; keeping it (this checkout would use "127.0.0.1:8080")',
  )
  assert.ok(err.some((l) => l.startsWith('worktree-ports: main (main checkout)')))
  assert.equal(
    err.some((l) => l.startsWith('worktree-ports:   ')),
    false,
  )
})

// --- status ---

test('status --json reports the verify target owner: mine', async (t) => {
  const repo = repoWithConfig(t, verifyConfig(1))
  const apiPort = await server(t, { root: repo.main })
  writeConfig(repo.main, verifyConfig(apiPort))
  const { io, out } = capture(repo.main)
  assert.equal(await run(['status', '--json'], io), 0)
  const parsed = JSON.parse(out.join('\n'))
  assert.deepEqual(parsed.context, { kind: 'main-checkout', mode: 'auto', reason: 'main checkout' })
  assert.equal(parsed.name, 'main')
  assert.equal(parsed.root, repo.main)
  assert.deepEqual(parsed.services, [
    { service: 'api', port: apiPort, listening: true, owner: 'mine', ownerRoot: repo.main },
    { service: 'web', port: 3, listening: false },
  ])
})

test('status --json reports the verify target owner: other', async (t) => {
  const apiPort = await server(t, { root: '/some/other/checkout' })
  const repo = repoWithConfig(t, verifyConfig(apiPort))
  const { io, out } = capture(repo.main)
  assert.equal(await run(['status', '--json'], io), 0)
  assert.deepEqual(JSON.parse(out.join('\n')).services[0], {
    service: 'api',
    port: apiPort,
    listening: true,
    owner: 'other',
    ownerRoot: '/some/other/checkout',
  })
})

test('status prints a readable table', async (t) => {
  const repo = repoWithConfig(t)
  const { io, out } = capture(repo.main)
  assert.equal(await run(['status'], io), 0)
  assert.deepEqual(out.slice(0, 2), ['context: main checkout', 'name: main'])
  assert.ok(
    out.some((l) => /^api\s+8080\s+(free|listening)/.test(l)),
    out.join('\n'),
  )
  assert.ok(
    out.some((l) => /^web\s+3000\s+(free|listening)/.test(l)),
    out.join('\n'),
  )
})

// --- list, release, prune ---

test('list and list --json show every claim across two repos, sorted by base', async (t) => {
  freshStateDir(t)
  const a = repoWithConfig(t)
  const b = repoWithConfig(t)
  const wtA = a.worktree('a1')
  const wtB = b.worktree('b1')
  for (const wt of [wtA, wtB]) assert.equal(await run(['show'], capture(wt).io), 0)

  const json = capture(a.main)
  assert.equal(await run(['list', '--json'], json.io), 0)
  const claims = JSON.parse(json.out.join('\n'))
  assert.equal(claims.length, 2)
  assert.ok(claims[0].base < claims[1].base)
  assert.deepEqual(new Set(claims.map((c: { root: string }) => c.root)), new Set([wtA, wtB]))
  for (const c of claims) {
    assert.equal(c.size, 10)
    assert.equal(c.config, 'worktree-ports.json')
    assert.equal('stale' in c, false)
  }

  const text = capture(a.main)
  assert.equal(await run(['list'], text.io), 0)
  assert.equal(text.out[0], 'BASE  SIZE  LAST-USED   STALE         ROOT  CONFIG')
  assert.equal(text.out.length, 3)
  for (const [i, c] of claims.entries()) {
    assert.equal(
      text.out[i + 1],
      `${String(c.base).padEnd(6)}10    ${c.lastUsed}  -             ${c.root}  worktree-ports.json`,
    )
  }
})

test('list marks a stale claim with its reason', async (t) => {
  freshStateDir(t)
  const repo = repoWithConfig(t)
  const wt = repo.worktree('gone')
  assert.equal(await run(['show'], capture(wt).io), 0)
  rmSync(wt, { recursive: true, force: true })
  const { io, out } = capture(repo.main)
  assert.equal(await run(['list'], io), 0)
  assert.match(out[1] ?? '', /^\d+ +10 +\d{4}-\d{2}-\d{2}  worktree-gone /)
})

test('release then show claims a fresh block', async (t) => {
  const stateDir = freshStateDir(t)
  const repo = repoWithConfig(t)
  const wt = repo.worktree('feat')
  const first = capture(wt)
  assert.equal(await run(['show', '--json'], first.io), 0)
  const base = JSON.parse(first.out.join('\n')).block.base
  assert.deepEqual(claimFiles(stateDir), [`${base}.json`])
  const claimedAt = JSON.parse(readFileSync(join(stateDir, 'claims', `${base}.json`), 'utf8')).claimedAt

  const released = capture(wt)
  assert.equal(await run(['release'], released.io), 0)
  assert.deepEqual(released.out, [`released ${base}`])
  assert.deepEqual(claimFiles(stateDir), [])

  const again = capture(wt)
  assert.equal(await run(['release'], again.io), 0)
  assert.deepEqual(again.out, ['no claim for this checkout'])

  await new Promise((resolve) => setTimeout(resolve, 5)) // a distinct claimedAt
  const second = capture(wt)
  assert.equal(await run(['show', '--json'], second.io), 0)
  const newBase = JSON.parse(second.out.join('\n')).block.base
  assert.deepEqual(claimFiles(stateDir), [`${newBase}.json`])
  const fresh = JSON.parse(readFileSync(join(stateDir, 'claims', `${newBase}.json`), 'utf8'))
  assert.notEqual(fresh.claimedAt, claimedAt)
})

test('release outside git exits 1', async (t) => {
  const dir = noConfigDir(t)
  writeConfig(dir)
  const { io, err } = capture(dir)
  assert.equal(await run(['release'], io), 1)
  assert.match(err.join('\n'), /^worktree-ports: /)
})

test('prune --dry-run reports, prune removes, then nothing to prune', async (t) => {
  const stateDir = freshStateDir(t)
  const repo = repoWithConfig(t)
  const wt = repo.worktree('gone')
  const shown = capture(wt)
  assert.equal(await run(['show', '--json'], shown.io), 0)
  const base = JSON.parse(shown.out.join('\n')).block.base
  rmSync(wt, { recursive: true, force: true })

  const dry = capture(repo.main)
  assert.equal(await run(['prune', '--dry-run'], dry.io), 0)
  assert.deepEqual(dry.out, [`would remove ${base} (worktree-gone) ${wt}`])
  assert.deepEqual(claimFiles(stateDir), [`${base}.json`])

  const real = capture(repo.main)
  assert.equal(await run(['prune'], real.io), 0)
  assert.deepEqual(real.out, [`removed ${base} (worktree-gone) ${wt}`])
  assert.deepEqual(claimFiles(stateDir), [])

  const none = capture(repo.main)
  assert.equal(await run(['prune'], none.io), 0)
  assert.deepEqual(none.out, ['nothing to prune'])
})

test('prune --unused-for 30d removes an idle claim that plain prune keeps', async (t) => {
  const stateDir = freshStateDir(t)
  const repo = repoWithConfig(t)
  const wt = repo.worktree('idle')
  const shown = capture(wt)
  assert.equal(await run(['show', '--json'], shown.io), 0)
  const base = JSON.parse(shown.out.join('\n')).block.base
  const file = join(stateDir, 'claims', `${base}.json`)
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), lastUsed: '2020-01-01' }))

  const plain = capture(repo.main)
  assert.equal(await run(['prune'], plain.io), 0)
  assert.deepEqual(plain.out, ['nothing to prune'])

  const idle = capture(repo.main)
  assert.equal(await run(['prune', '--unused-for', '30d'], idle.io), 0)
  assert.deepEqual(idle.out, [`removed ${base} (unused) ${wt}`])
  assert.deepEqual(claimFiles(stateDir), [])
})

// --- WORKTREE_PORTS=off and no config ---

test('WORKTREE_PORTS=off: exec adds nothing and show reports off', async (t) => {
  const repo = repoWithConfig(t)
  const wt = repo.worktree('feat')
  const file = join(repo.dir, 'env.json')
  const ex = capture(wt, { WORKTREE_PORTS: 'off' })
  assert.equal(await run(['exec', ...dumpEnvArgs(file, 'PORT', 'ROOT')], ex.io), 0)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { PORT: null, ROOT: null })
  assert.deepEqual(ex.err, [])

  for (const command of [['show'], ['env'], ['status'], ['list'], ['release'], ['prune']]) {
    const { io, out } = capture(wt, { WORKTREE_PORTS: 'off' })
    assert.equal(await run(command, io), 0, command.join(' '))
    assert.deepEqual(out, ['worktree-ports is off (WORKTREE_PORTS=off)'], command.join(' '))
  }
})

test('an invalid WORKTREE_PORTS exits 1', async (t) => {
  const repo = repoWithConfig(t)
  const { io, err } = capture(repo.main, { WORKTREE_PORTS: 'sometimes' })
  assert.equal(await run(['show'], io), 1)
  assert.match(err.join('\n'), /^worktree-ports: WORKTREE_PORTS must be one of/)
})

test('no config: exec warns and runs the command unchanged', async (t) => {
  const dir = noConfigDir(t)
  const file = join(dir, 'env.json')
  const { io, err } = capture(dir)
  assert.equal(await run(['exec', ...dumpEnvArgs(file, 'PORT')], io), 0)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { PORT: null })
  assert.match(err.join('\n'), /^worktree-ports: no worktree-ports\.json found.*running the command unchanged/)
})

test('no config: show, env and status exit 1', async (t) => {
  const dir = noConfigDir(t)
  for (const command of ['show', 'env', 'status']) {
    const { io, err } = capture(dir)
    assert.equal(await run([command], io), 1, command)
    assert.match(err.join('\n'), /^worktree-ports: no worktree-ports\.json found/, command)
  }
})

test('a bad config exits 1', async (t) => {
  const repo = repoWithConfig(t, { services: {} })
  const { io, err } = capture(repo.main)
  assert.equal(await run(['show'], io), 1)
  assert.match(err.join('\n'), /^worktree-ports: .*services must be an object/)
})

// --- registry failures, in a child CLI ---

test('a lock timeout exits 1 with the lock path on stderr', async (t) => {
  const stateDir = mkdtempSync(join(testStateDir(), 'cli-lock-'))
  const lock = join(stateDir, 'lock')
  mkdirSync(lock) // held, and fresh enough not to be broken as stale
  const repo = repoWithConfig(t)
  const wt = repo.worktree('feat')
  const r = await runCli(['show'], {
    cwd: wt,
    env: { WORKTREE_PORTS_STATE_DIR: stateDir, WORKTREE_PORTS_LOCK_TIMEOUT_MS: '200' },
  })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^worktree-ports: timed out after \d+ ms waiting for the registry lock/)
  assert.ok(r.stderr.includes(lock), r.stderr)
})

test('a full registry exits 1 with the RegistryFullError message', async (t) => {
  const scratch = mkdtempSync(join(testStateDir(), 'cli-full-'))
  const stateDir = join(scratch, 'state')
  const xdgConfig = join(scratch, 'xdg-config')
  mkdirSync(join(xdgConfig, 'worktree-ports'), { recursive: true })
  writeFileSync(join(xdgConfig, 'worktree-ports', 'config.json'), JSON.stringify({ range: { min: 20000, max: 20009 } }))
  // offset 10 needs a 20-port block, which a 10-port range can never hold
  const repo = repoWithConfig(t, {
    services: { api: { offset: 0, default: 8080 }, web: { offset: 10, default: 3000 } },
    env: {},
  })
  const wt = repo.worktree('feat')
  const r = await runCli(['show'], { cwd: wt, env: { WORKTREE_PORTS_STATE_DIR: stateDir, XDG_CONFIG_HOME: xdgConfig } })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^worktree-ports: /)
  assert.match(r.stderr, /prune --unused-for 30d/)
})

// --- exec --port ---

test('--port and --config need a real value', async (t) => {
  const dir = noConfigDir(t)
  for (const flag of ['--port', '--config']) {
    const { io, err } = capture(dir)
    assert.equal(await run(['exec', flag, '--', 'node'], io), 2)
    assert.match(err.join('\n'), new RegExp(`${flag} needs a value`))
  }
})

test('exec --port sets PORT and the marker for the child', async (t) => {
  const repo = repoWithConfig(t, { ...CONFIG, env: { ROOT: '{root}' } })
  const wt = repo.worktree('feat')
  const show = capture(wt)
  assert.equal(await run(['show', '--json'], show.io), 0)
  const webPort = String(JSON.parse(show.out.join('\n')).ports.web)
  const file = join(repo.dir, 'env.json')
  const { io } = capture(wt)
  assert.equal(await run(['exec', '--port', 'web', ...dumpEnvArgs(file, 'PORT', 'WORKTREE_PORTS_PORT', 'ROOT')], io), 0)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    PORT: webPort,
    WORKTREE_PORTS_PORT: webPort,
    ROOT: wt,
  })
})

test('exec --port in the main checkout uses the default', async (t) => {
  const repo = repoWithConfig(t)
  const file = join(repo.dir, 'env.json')
  const { io } = capture(repo.main)
  assert.equal(await run(['exec', '--port', 'web', ...dumpEnvArgs(file, 'PORT')], io), 0)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).PORT, '3000')
})

test('nested exec --port replaces the outer PORT', async (t) => {
  const repo = repoWithConfig(t)
  const file = join(repo.dir, 'env.json')
  const { io, err } = capture(repo.main, { PORT: '8080', WORKTREE_PORTS_PORT: '8080' })
  assert.equal(await run(['exec', '--port', 'web', ...dumpEnvArgs(file, 'PORT', 'WORKTREE_PORTS_PORT')], io), 0)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { PORT: '3000', WORKTREE_PORTS_PORT: '3000' })
  assert.doesNotMatch(err.join('\n'), /already set/)
})

test('exec --port keeps a pinned PORT and warns', async (t) => {
  const repo = repoWithConfig(t)
  const file = join(repo.dir, 'env.json')
  const { io, err } = capture(repo.main, { PORT: '9999' })
  assert.equal(await run(['exec', '--port', 'web', ...dumpEnvArgs(file, 'PORT', 'WORKTREE_PORTS_PORT')], io), 0)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { PORT: '9999', WORKTREE_PORTS_PORT: null })
  assert.match(err.join('\n'), /PORT is already set to "9999"; keeping it \(this checkout would use "3000"\)/)
})

test('exec --port with an unknown service exits 1', async (t) => {
  const repo = repoWithConfig(t)
  const file = join(repo.dir, 'ran.txt')
  const { io, err } = capture(repo.main)
  const script = `require('fs').writeFileSync(${JSON.stringify(file)}, 'ran')`
  assert.equal(await run(['exec', '--port', 'nope', '--', process.execPath, '-e', script], io), 1)
  assert.match(err.join('\n'), /unknown service "nope" for --port; declared services: api, web/)
  assert.equal(existsSync(file), false)
})

test('exec --port under WORKTREE_PORTS=off adds nothing', async (t) => {
  const repo = repoWithConfig(t)
  const file = join(repo.dir, 'env.json')
  const { io } = capture(repo.main, { WORKTREE_PORTS: 'off' })
  assert.equal(await run(['exec', '--port', 'web', ...dumpEnvArgs(file, 'PORT', 'WORKTREE_PORTS_PORT')], io), 0)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { PORT: null, WORKTREE_PORTS_PORT: null })
})

// --- WORKTREE_PORTS_ACTIVE ---

test('exec sets WORKTREE_PORTS_ACTIVE=1 for the child, replacing any inherited value', async (t) => {
  const repo = repoWithConfig(t)
  const file = join(repo.dir, 'env.json')
  const { io } = capture(repo.main, { WORKTREE_PORTS_ACTIVE: '0' })
  assert.equal(await run(['exec', ...dumpEnvArgs(file, 'WORKTREE_PORTS_ACTIVE')], io), 0)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { WORKTREE_PORTS_ACTIVE: '1' })
})

test('exec sets WORKTREE_PORTS_ACTIVE=1 even under WORKTREE_PORTS=off and with no config', async (t) => {
  const repo = repoWithConfig(t)
  const off = join(repo.dir, 'off.json')
  const { io } = capture(repo.main, { WORKTREE_PORTS: 'off' })
  assert.equal(await run(['exec', ...dumpEnvArgs(off, 'WORKTREE_PORTS_ACTIVE', 'PORT')], io), 0)
  assert.deepEqual(JSON.parse(readFileSync(off, 'utf8')), { WORKTREE_PORTS_ACTIVE: '1', PORT: null })

  const dir = noConfigDir(t)
  const none = join(dir, 'none.json')
  const nc = capture(dir)
  assert.equal(await run(['exec', ...dumpEnvArgs(none, 'WORKTREE_PORTS_ACTIVE')], nc.io), 0)
  assert.deepEqual(JSON.parse(readFileSync(none, 'utf8')), { WORKTREE_PORTS_ACTIVE: '1' })
})

test('env does not print WORKTREE_PORTS_ACTIVE', async (t) => {
  const repo = repoWithConfig(t)
  const { io, out } = capture(repo.main)
  assert.equal(await run(['env', '--port', 'web'], io), 0)
  assert.ok(!out.some((l) => l.includes('WORKTREE_PORTS_ACTIVE')), out.join('\n'))
})
