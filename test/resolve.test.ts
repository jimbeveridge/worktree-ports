import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { ConfigError } from '../src/config.ts'
import { openRegistry, type Registry } from '../src/registry/index.ts'
import { NoConfigError, resolvePorts } from '../src/resolve.ts'
import { makeRepo } from './helpers/repo.ts'
import { testStateDir } from './setup.ts'

const CONFIG = {
  services: { api: { offset: 0, default: 8080 }, web: { offset: 1, default: 3000 } },
  env: {
    WORKTREE_API_PORT: '{api}',
    WORKTREE_ORIGIN: 'http://localhost:{web}',
    WORKTREE_ROOT: '{root}',
    WORKTREE_TOKEN: '{home}/.tool/token-{name}.json',
  },
  verify: { url: 'http://localhost:{api}/health', field: 'root', expect: '{root}' },
}

type T = { after: (fn: () => void) => void }

/** A registry in its own empty state dir, so file counts are exact. */
function freshRegistry(range?: { min: number; max: number }): Registry {
  const stateDir = mkdtempSync(join(testStateDir(), 'resolve-'))
  return openRegistry(range ? { stateDir, settings: { range } } : { stateDir })
}

function claimFiles(registry: Registry): string[] {
  const dir = join(registry.stateDir, 'claims')
  return existsSync(dir) ? readdirSync(dir) : []
}

function tempDir(t: T, prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeConfig(dir: string, config: object = CONFIG): string {
  const path = join(dir, 'worktree-ports.json')
  writeFileSync(path, JSON.stringify(config))
  return path
}

function linkedWorktree(t: T) {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const wt = repo.addWorktree('feat')
  return { repo, wt }
}

test('a linked worktree gets its claimed block, rendered env and verify, and git admin-dir name', async (t) => {
  const { wt } = linkedWorktree(t)
  writeConfig(wt)
  const registry = freshRegistry()
  const r = await resolvePorts({ cwd: wt, env: {}, home: '/home/me', registry })
  assert.ok(r.claim)
  assert.equal(r.context.kind, 'linked-worktree')
  assert.equal(r.name, 'feat')
  assert.equal(r.root, wt)
  assert.equal(r.configPath, join(wt, 'worktree-ports.json'))
  assert.equal(r.claim.config, 'worktree-ports.json')
  assert.equal(r.claim.size, 10)
  assert.deepEqual(r.ports, { api: r.claim.base + 0, web: r.claim.base + 1 })
  assert.deepEqual(r.env, {
    WORKTREE_API_PORT: String(r.claim.base),
    WORKTREE_ORIGIN: `http://localhost:${r.claim.base + 1}`,
    WORKTREE_ROOT: wt,
    WORKTREE_TOKEN: '/home/me/.tool/token-feat.json',
  })
  assert.deepEqual(r.verify, { url: `http://localhost:${r.claim.base}/health`, field: 'root', expect: wt })
  assert.equal(basename(r.claim.gitDir), 'feat')
  assert.deepEqual(claimFiles(registry), [`${r.claim.base}.json`])
})

test('the main checkout gets the defaults, no claim and name "main"', async (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  writeConfig(repo.main)
  const registry = freshRegistry()
  const r = await resolvePorts({ cwd: repo.main, env: {}, home: '/home/me', registry })
  assert.equal(r.context.kind, 'main-checkout')
  assert.equal(r.claim, undefined)
  assert.equal(r.name, 'main')
  assert.equal(r.root, repo.main)
  assert.deepEqual(r.ports, { api: 8080, web: 3000 })
  assert.equal(r.env.WORKTREE_TOKEN, '/home/me/.tool/token-main.json')
  assert.deepEqual(r.verify, { url: 'http://localhost:8080/health', field: 'root', expect: repo.main })
  assert.deepEqual(claimFiles(registry), [])
})

test('no git: defaults, root is the config dir, name "main"', async (t) => {
  const dir = tempDir(t, 'worktree-ports-nogit-')
  writeConfig(dir)
  mkdirSync(join(dir, 'deep', 'er'), { recursive: true })
  const r = await resolvePorts({ cwd: join(dir, 'deep', 'er'), env: {}, home: '/home/me', registry: freshRegistry() })
  assert.equal(r.context.kind, 'no-git')
  assert.equal(r.claim, undefined)
  assert.equal(r.root, dir)
  assert.equal(r.name, 'main')
  assert.deepEqual(r.ports, { api: 8080, web: 3000 })
  assert.equal(r.env.WORKTREE_ROOT, dir)
})

test('CI leaves the registry dir empty', async (t) => {
  const { wt } = linkedWorktree(t)
  writeConfig(wt)
  const registry = freshRegistry()
  const r = await resolvePorts({ cwd: wt, env: { CI: 'true' }, registry })
  assert.equal(r.context.kind, 'ci')
  assert.equal(r.claim, undefined)
  assert.equal(r.name, 'feat', '{name} stays the admin-dir name in a linked worktree')
  assert.deepEqual(r.ports, { api: 8080, web: 3000 })
  assert.deepEqual(readdirSync(registry.stateDir), [])
})

test('no config found is a NoConfigError', async (t) => {
  const dir = tempDir(t, 'worktree-ports-empty-')
  await assert.rejects(resolvePorts({ cwd: dir, env: {}, registry: freshRegistry() }), NoConfigError)
})

test('WORKTREE_PORTS=off: empty ports and env, before any config is read', async (t) => {
  const dir = tempDir(t, 'worktree-ports-off-')
  writeFileSync(join(dir, 'worktree-ports.json'), '{ not json')
  const r = await resolvePorts({ cwd: dir, env: { WORKTREE_PORTS: 'off' }, registry: freshRegistry() })
  assert.equal(r.context.kind, 'off')
  assert.deepEqual(r.ports, {})
  assert.deepEqual(r.env, {})
  assert.equal(r.claim, undefined)
})

test('a default inside the effective range is a ConfigError', async (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  writeConfig(repo.main)
  await assert.rejects(
    resolvePorts({ cwd: repo.main, env: {}, registry: freshRegistry({ min: 8000, max: 8999 }) }),
    (err: Error) => err instanceof ConfigError && /services\.api\.default 8080/.test(err.message),
  )
})

test('a symlinked cwd and the real path resolve to one claim (Review Focus 1)', async (t) => {
  const { repo, wt } = linkedWorktree(t)
  writeConfig(wt)
  const link = join(repo.dir, 'link-to-feat')
  symlinkSync(wt, link, 'dir')
  const registry = freshRegistry()
  const viaLink = await resolvePorts({ cwd: link, env: {}, registry })
  const viaReal = await resolvePorts({ cwd: wt, env: {}, registry })
  assert.ok(viaLink.claim && viaReal.claim)
  assert.equal(viaLink.claim.base, viaReal.claim.base)
  assert.equal(viaLink.root, wt)
  assert.equal(viaLink.claim.config, 'worktree-ports.json')
  const viaLinkConfig = await resolvePorts({
    cwd: wt,
    configPath: join(link, 'worktree-ports.json'),
    env: {},
    registry,
  })
  assert.equal(viaLinkConfig.claim?.base, viaReal.claim.base)
  assert.equal(claimFiles(registry).length, 1)
})

test('--config outside the worktree root claims under its absolute path (Review Focus 2)', async (t) => {
  const { wt } = linkedWorktree(t)
  const outside = writeConfig(tempDir(t, 'worktree-ports-outside-'))
  const registry = freshRegistry()
  const first = await resolvePorts({ cwd: wt, configPath: outside, env: {}, registry })
  assert.equal(first.claim?.config, outside)
  assert.equal(first.root, wt)
  const second = await resolvePorts({ cwd: wt, configPath: outside, env: {}, registry })
  assert.equal(second.claim?.base, first.claim?.base)
  assert.equal(claimFiles(registry).length, 1)
})

test('a relative --config resolves against cwd', async (t) => {
  const { wt } = linkedWorktree(t)
  mkdirSync(join(wt, 'conf'))
  writeConfig(join(wt, 'conf'))
  const r = await resolvePorts({ cwd: wt, configPath: 'conf/worktree-ports.json', env: {}, registry: freshRegistry() })
  assert.equal(r.claim?.config, 'conf/worktree-ports.json')
})

test('a sub-project config claims under its root-relative path with / separators', async (t) => {
  const { wt } = linkedWorktree(t)
  writeConfig(wt)
  mkdirSync(join(wt, 'sub', 'src'), { recursive: true })
  writeConfig(join(wt, 'sub'))
  const registry = freshRegistry()
  const sub = await resolvePorts({ cwd: join(wt, 'sub', 'src'), env: {}, registry })
  assert.equal(sub.claim?.config, 'sub/worktree-ports.json')
  assert.equal(sub.root, wt)
  const top = await resolvePorts({ cwd: wt, env: {}, registry })
  assert.equal(top.claim?.config, 'worktree-ports.json')
  assert.notEqual(top.claim?.base, sub.claim?.base)
  assert.equal(claimFiles(registry).length, 2)
})
