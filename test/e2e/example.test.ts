// End-to-end: the packed tarball, installed into a temp repo holding example/ and a linked worktree (spec §12b).
// Set WORKTREE_PORTS_TARBALL to reuse a tarball; otherwise this runs `npm pack` itself.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { isListening } from '../../src/status.ts'
import { git, makeRepo } from '../helpers/repo.ts'

const REPO = join(import.meta.dirname, '..', '..')
const WIN = process.platform === 'win32'
const NPM = WIN ? 'npm.cmd' : 'npm'

interface Shown {
  block: { base: number; size: number } | null
  ports: { backend: number; frontend: number }
  root: string
}

function tarballPath(t: TestContext, scratch: string): string {
  const given = process.env.WORKTREE_PORTS_TARBALL
  if (given) return resolve(given)
  const out = execFileSync(NPM, ['pack', '--silent', '--pack-destination', scratch], {
    cwd: REPO,
    encoding: 'utf8',
    shell: WIN,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  t.diagnostic(`packed ${out.trim()}`)
  return join(scratch, out.trim().split('\n').pop()!)
}

async function waitListening(port: number, listening = true): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if ((await isListening(port, 250)) === listening) return
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.fail(`port ${port} did not ${listening ? 'start listening' : 'stop listening'} within 10 s`)
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url)
  assert.equal(res.status, 200, `GET ${url}`)
  return res.json()
}

test('example: two checkouts, one registry, and a verify mismatch', { timeout: 90_000 }, async (t) => {
  assert.equal(await isListening(4000, 250), false, 'port 4000 must be free for the defaults assertion')
  assert.equal(await isListening(4100, 250), false, 'port 4100 must be free for the defaults assertion')

  const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'worktree-ports-e2e-')))
  const repo = makeRepo()
  const children: ChildProcess[] = []
  t.after(() => {
    for (const child of children) {
      try {
        if (WIN) child.kill()
        else process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    repo.cleanup()
    rmSync(scratch, { recursive: true, force: true })
  })

  // 1. A temp repo with example/ committed, a linked worktree, and the tarball installed in both.
  const tarball = tarballPath(t, scratch)
  cpSync(join(REPO, 'example'), join(repo.main, 'example'), {
    recursive: true,
    filter: (src) => !src.includes('node_modules'),
  })
  git(repo.main, 'add', 'example')
  git(repo.main, 'commit', '-q', '-m', 'add example')
  const worktree = repo.addWorktree('feature')
  const stateDir = join(scratch, 'state')
  mkdirSync(stateDir)
  const baseEnv: NodeJS.ProcessEnv = { ...process.env, WORKTREE_PORTS_STATE_DIR: stateDir }
  for (const name of [
    'CI',
    'WORKTREE_PORTS',
    'PORT',
    'WORKTREE_PORTS_PORT',
    'WORKTREE_PORTS_ACTIVE',
    'WORKTREE_BACKEND_ORIGIN',
    'WORKTREE_ROOT',
  ])
    delete baseEnv[name]

  const dirs = { main: join(repo.main, 'example'), worktree: join(worktree, 'example') }
  for (const dir of Object.values(dirs)) {
    execFileSync(NPM, ['install', '--no-audit', '--no-fund', tarball], {
      cwd: dir,
      env: baseEnv,
      shell: WIN,
      stdio: ['ignore', 'ignore', 'inherit'],
    })
  }

  const cli = (dir: string) => join(dir, 'node_modules', '.bin', 'worktree-ports')
  const show = (dir: string, env: NodeJS.ProcessEnv = baseEnv): Shown =>
    JSON.parse(execFileSync(cli(dir), ['show', '--json'], { cwd: dir, env, encoding: 'utf8' }))

  // Starts a command in its own process group, so teardown can kill the whole tree.
  function start(dir: string, script: string, env: NodeJS.ProcessEnv = baseEnv): ChildProcess {
    const child = spawn(NPM, ['run', script], { cwd: dir, env, detached: true, shell: WIN, stdio: 'ignore' })
    children.push(child)
    return child
  }
  function stop(child: ChildProcess): void {
    process.kill(-child.pid!, 'SIGKILL')
  }

  // 2. Both checkouts run backend and frontend at the same time.
  const main = show(dirs.main)
  const feature = show(dirs.worktree)
  assert.equal(main.root, repo.main)
  assert.equal(feature.root, worktree)
  start(dirs.main, 'backend')
  start(dirs.main, 'frontend')
  const featureRun = [start(dirs.worktree, 'backend'), start(dirs.worktree, 'frontend')]
  for (const p of [main.ports, feature.ports]) {
    await waitListening(p.backend)
    await waitListening(p.frontend)
  }

  // 3. The frontend proxies to its own checkout's backend; only the main checkout uses the defaults.
  const mainHello = await getJson(`http://127.0.0.1:${main.ports.frontend}/api/hello`)
  const featureHello = await getJson(`http://127.0.0.1:${feature.ports.frontend}/api/hello`)
  assert.equal(mainHello.worktreeRoot, repo.main)
  assert.equal(mainHello.port, main.ports.backend)
  assert.equal(featureHello.worktreeRoot, worktree)
  assert.equal(featureHello.port, feature.ports.backend)
  assert.deepEqual(await getJson(`http://127.0.0.1:${feature.ports.backend}/__worktree`), { worktreeRoot: worktree })
  assert.deepEqual(main.ports, { backend: 4100, frontend: 4000 })
  assert.ok(feature.ports.frontend >= 20000 && feature.ports.backend >= 20000, JSON.stringify(feature.ports))
  assert.ok(feature.block, 'the linked worktree has a claimed block')

  // 4. An impostor backend from the main checkout sits on the worktree's backend port.
  for (const child of featureRun) stop(child)
  await waitListening(feature.ports.backend, false)
  await waitListening(feature.ports.frontend, false)
  start(dirs.main, 'backend', { ...baseEnv, PORT: String(feature.ports.backend) })
  await waitListening(feature.ports.backend)
  const verify = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(cli(dirs.worktree), ['exec', '--verify', '--', process.execPath, 'frontend.mjs'], {
      cwd: dirs.worktree,
      env: baseEnv,
      detached: !WIN,
      shell: WIN,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    children.push(child)
    let stderr = ''
    child.stderr!.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stderr }))
  })
  assert.equal(verify.code, 1, verify.stderr)
  assert.match(verify.stderr, /belongs to/)

  // 5. CI never claims: both checkouts resolve to the defaults and a fresh registry stays empty.
  const ciState = join(scratch, 'ci-state')
  mkdirSync(ciState)
  const ciEnv = { ...baseEnv, CI: 'true', WORKTREE_PORTS_STATE_DIR: ciState }
  for (const dir of Object.values(dirs)) {
    const shown = show(dir, ciEnv)
    assert.equal(shown.block, null)
    assert.deepEqual(shown.ports, { backend: 4100, frontend: 4000 })
  }
  const claims = join(ciState, 'claims')
  assert.deepEqual(existsSync(claims) ? readdirSync(claims) : [], [])
})
