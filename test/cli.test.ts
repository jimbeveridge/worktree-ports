import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageError, parseArgs, run, type CliIo } from '../src/cli.ts'
import { makeRepo, type TempRepo } from './helpers/repo.ts'

const BIN_PATH = join(import.meta.dirname, '..', 'bin', 'worktree-ports.ts')

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

function repoWithConfig(
  t: { after: (fn: () => void) => void },
  extra: Record<string, unknown> = {},
): { repo: TempRepo; config: string } {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const config = join(repo.dir, 'config.json')
  writeFileSync(
    config,
    JSON.stringify({
      fileName: 'port.txt',
      range: { min: 20000, max: 20020, step: 10 },
      services: { api: { offset: 0, mainPort: 8080 }, web: { offset: 1, mainPort: 3000 } },
      env: { PORT: '{api}', ROOT: '{root}' },
      ...extra,
    }),
  )
  return { repo, config }
}

/** A child that writes the named env vars as JSON to a file. */
function dumpEnvArgs(file: string, ...keys: string[]): string[] {
  const script = `require('fs').writeFileSync(${JSON.stringify(file)}, JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k => [k, process.env[k] ?? null]))))`
  return ['--', process.execPath, '-e', script]
}

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['exec', '--verify', '--config', 'c.json', '--', 'vite', '--host']), {
    command: 'exec',
    json: false,
    verify: true,
    config: 'c.json',
    rest: ['vite', '--host'],
  })
  assert.deepEqual(parseArgs(['show', '--json']), { command: 'show', json: true, verify: false, rest: [] })
  assert.throws(() => parseArgs([]), UsageError)
  assert.throws(() => parseArgs(['launch']), UsageError)
  assert.throws(() => parseArgs(['exec']), /needs a command after --/)
  assert.throws(() => parseArgs(['show', '--bogus']), /unknown option --bogus/)
  assert.throws(() => parseArgs(['show', '--verify']), /--verify only applies to exec/)
})

test('a usage error exits 2', async () => {
  const { io, err } = capture(process.cwd())
  assert.equal(await run(['nope'], io), 2)
  assert.match(err.join('\n'), /usage:/)
})

test('show --json prints the resolution', { skip: 'rewired in Task 5/6' }, async (t) => {
  const { repo, config } = repoWithConfig(t)
  const { io, out } = capture(repo.main)
  assert.equal(await run(['show', '--json', '--config', config], io), 0)
  const parsed = JSON.parse(out.join('\n'))
  assert.deepEqual(parsed.ports, { api: 8080, web: 3000 })
  assert.equal(parsed.name, 'main')
  assert.equal(parsed.root, repo.main)
  assert.deepEqual(parsed.env, { PORT: '8080', ROOT: repo.main })
})

test('env prints shell-quoted exports', { skip: 'rewired in Task 5/6' }, async (t) => {
  const { repo, config } = repoWithConfig(t, { env: { ROOT: "{root}/it's" } })
  const { io, out } = capture(repo.main)
  assert.equal(await run(['env', '--config', config], io), 0)
  assert.deepEqual(out, [`export ROOT='${repo.main}/it'\\''s'`])
})

test(
  'exec passes rendered env to the child, but an explicit variable wins',
  { skip: 'rewired in Task 5/6' },
  async (t) => {
    const { repo, config } = repoWithConfig(t)
    const wt = repo.addWorktree('feat')
    const file = join(repo.dir, 'env.json')
    const { io, err } = capture(wt, { ROOT: '/explicit' })
    const code = await run(['exec', '--config', config, ...dumpEnvArgs(file, 'PORT', 'ROOT')], io)
    assert.equal(code, 0)
    const seen = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(['20000', '20010', '20020'].includes(seen.PORT), `PORT was ${seen.PORT}`)
    assert.equal(seen.ROOT, '/explicit')
    assert.match(err.join('\n'), /ROOT is already set to "\/explicit"; keeping it/)
  },
)

test('exec returns the child exit code', { skip: 'rewired in Task 5/6' }, async (t) => {
  const { repo, config } = repoWithConfig(t)
  const { io } = capture(repo.main)
  assert.equal(await run(['exec', '--config', config, '--', process.execPath, '-e', 'process.exit(7)'], io), 7)
})

test('exec with no config found warns and still runs the command unchanged', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-ports-cli-nogit-')))
  const file = join(dir, 'env.json')
  const { io, err } = capture(dir)
  assert.equal(await run(['exec', ...dumpEnvArgs(file, 'PORT')], io), 0)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { PORT: null })
  assert.match(err.join('\n'), /no worktree-ports\.json found.*running the command unchanged/)
})

async function healthServer(root: string): Promise<{ port: number; server: Server }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', root }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, server }
}

test(
  'exec --verify refuses to start when the service belongs to another worktree',
  { skip: 'rewired in Task 5/6' },
  async (t) => {
    const { server, port } = await healthServer('/some/other/worktree')
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
    // mainPort for api points at the fake health server, so the main checkout's verify URL hits it.
    // The range must never contain an OS-assigned port (Linux ephemeral starts at 32768), or
    // parseConfig rejects mainPort as "inside the allocation range" and the test flakes.
    const { repo, config } = repoWithConfig(t, {
      range: { min: 2000, max: 2000, step: 10 },
      services: { api: { offset: 0, mainPort: port }, web: { offset: 1, mainPort: 3000 } },
      verify: { url: 'http://127.0.0.1:{api}/health', field: 'root', expect: '{root}' },
    })
    const file = join(repo.dir, 'ran.json')
    const { io, err } = capture(repo.main)
    assert.equal(await run(['exec', '--verify', '--config', config, ...dumpEnvArgs(file, 'PORT')], io), 1)
    assert.equal(existsSync(file), false, 'the child must not run')
    assert.match(err.join('\n'), /belongs to "\/some\/other\/worktree", not this worktree/)
  },
)

test('exec --verify continues with a warning when nothing is listening', { skip: 'rewired in Task 5/6' }, async (t) => {
  const { repo, config } = repoWithConfig(t, {
    verify: { url: 'http://127.0.0.1:1/health', field: 'root', expect: '{root}' },
  })
  const file = join(repo.dir, 'ran.json')
  const { io, err } = capture(repo.main)
  assert.equal(await run(['exec', '--verify', '--config', config, ...dumpEnvArgs(file, 'PORT')], io), 0)
  assert.ok(existsSync(file))
  assert.match(err.join('\n'), /nothing is answering at http:\/\/127\.0\.0\.1:1\/health/)
})

test('exec --verify without a verify section is a usage error', { skip: 'rewired in Task 5/6' }, async (t) => {
  const { repo, config } = repoWithConfig(t)
  const { io } = capture(repo.main)
  assert.equal(await run(['exec', '--verify', '--config', config, '--', process.execPath, '-e', ''], io), 2)
})

test('exec: a nonexistent command exits 127', { skip: 'rewired in Task 5/6' }, async (t) => {
  const { repo, config } = repoWithConfig(t)
  const { io, err } = capture(repo.main)
  assert.equal(await run(['exec', '--config', config, '--', 'definitely-not-a-command-xyz'], io), 127)
  assert.match(err.join('\n'), /could not start/)
})

test('exec: a child killed by a signal maps to 128+n', { skip: 'rewired in Task 5/6' }, async (t) => {
  const { repo, config } = repoWithConfig(t)
  const { io } = capture(repo.main)
  const code = await run(
    ['exec', '--config', config, '--', process.execPath, '-e', "process.kill(process.pid, 'SIGTERM')"],
    io,
  )
  assert.equal(code, 143) // 128 + SIGTERM (15)
})

test(
  'exec: SIGTERM sent to the wrapper reaches the child',
  { timeout: 20_000, skip: 'rewired in Task 5/6' },
  async (t) => {
    const { repo, config } = repoWithConfig(t)
    const readyFile = join(repo.dir, 'ready-sigterm.txt')
    const markerFile = join(repo.dir, 'marker-sigterm.txt')
    const script = [
      'const fs = require("fs")',
      `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(markerFile)}, 'got-it'); process.exit(0) })`,
      `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready')`,
      'setInterval(() => {}, 1000)',
    ].join('; ')
    // detached so a failed/timed-out run can still be cleaned up as a whole process
    // group (the grandchild `node -e` otherwise survives an unsignaled wrapper forever).
    const wrapper = spawn(
      process.execPath,
      [BIN_PATH, 'exec', '--config', config, '--', process.execPath, '-e', script],
      {
        cwd: repo.main,
        stdio: 'ignore',
        detached: true,
      },
    )
    t.after(() => killQuietly(wrapper, true))

    await waitForFile(readyFile)
    wrapper.kill('SIGTERM') // aimed at the wrapper only, not the group: proves the wrapper itself forwards it
    const [code] = await Promise.all([
      new Promise<number | null>((resolve) => wrapper.on('exit', (c) => resolve(c))),
      waitForFile(markerFile),
    ])
    assert.equal(code, 0)
  },
)

test(
  'exec: one process-group SIGINT reaches the child exactly once',
  { timeout: 20_000, skip: 'rewired in Task 5/6' },
  async (t) => {
    const { repo, config } = repoWithConfig(t)
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
    const wrapper = spawn(
      process.execPath,
      [BIN_PATH, 'exec', '--config', config, '--', process.execPath, '-e', script],
      {
        cwd: repo.main,
        stdio: 'ignore',
        detached: true,
      },
    )
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

test('parseArgs accepts status with --json and rejects --verify on it', () => {
  assert.deepEqual(parseArgs(['status', '--json']), { command: 'status', json: true, verify: false, rest: [] })
  assert.deepEqual(parseArgs(['status']), { command: 'status', json: false, verify: false, rest: [] })
  assert.throws(() => parseArgs(['status', '--verify']), /--verify only applies to exec/)
})

test('status --json reports each service and the verify target owner', { skip: 'rewired in Task 5/6' }, async (t) => {
  const { repo, config } = repoWithConfig(t)
  // repoWithConfig pins api=8080 / web=3000 as mainPorts with no verify section.
  // Point verify at a live health server that answers with this repo's root.
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ root: repo.main }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const apiPort = (server.address() as AddressInfo).port
  writeFileSync(
    config,
    JSON.stringify({
      fileName: 'port.txt',
      range: { min: 2000, max: 2000, step: 10 },
      services: { api: { offset: 0, mainPort: apiPort }, web: { offset: 1, mainPort: 3 } },
      verify: { url: 'http://127.0.0.1:{api}/health', field: 'root', expect: '{root}' },
    }),
  )
  const { io, out } = capture(repo.main)
  assert.equal(await run(['status', '--json', '--config', config], io), 0)
  const parsed = JSON.parse(out.join('\n'))
  assert.equal(parsed.name, 'main')
  assert.equal(parsed.root, repo.main)
  assert.equal(parsed.isMain, true)
  assert.deepEqual(parsed.services, [
    { service: 'api', port: apiPort, listening: true, owner: 'mine', ownerRoot: repo.main },
    { service: 'web', port: 3, listening: false },
  ])
})

test('status prints a readable table', { skip: 'rewired in Task 5/6' }, async (t) => {
  const { repo, config } = repoWithConfig(t)
  const { io, out } = capture(repo.main)
  assert.equal(await run(['status', '--config', config], io), 0)
  assert.equal(out[0], 'worktree  main (main checkout)')
  assert.ok(
    out.some((l) => /^api\s+8080\s+(free|listening)/.test(l)),
    out.join('\n'),
  )
  assert.ok(
    out.some((l) => /^web\s+3000\s+(free|listening)/.test(l)),
    out.join('\n'),
  )
})
