import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, makeRepo, type TempRepo } from './helpers/repo.ts'
import { locateWorktree } from '../src/git.ts'
import { collectStale, parseDuration, staleReason } from '../src/registry/cleanup.ts'
import { openRegistry } from '../src/registry/index.ts'
import { type Claim, readAllClaims, writeClaim } from '../src/registry/store.ts'
import type { PortRange } from '../src/settings.ts'
import { testStateDir } from './setup.ts'

const RANGE: PortRange = { min: 20000, max: 20999 }
const CONFIG = 'worktree-ports.json'

function freshState(): string {
  return mkdtempSync(join(testStateDir(), 'cleanup-'))
}

function repo(t: { after(fn: () => void): void }): TempRepo {
  const r = makeRepo()
  t.after(() => r.cleanup())
  return r
}

/** A claim owned by the checkout at `dir`, whose config file exists. */
function claimAt(dir: string, base: number, extra: Partial<Claim> = {}): Claim {
  const loc = locateWorktree(dir)
  writeFileSync(join(loc.root, CONFIG), '{}\n')
  return {
    base,
    size: 10,
    gitDir: loc.gitDir,
    root: loc.root,
    config: CONFIG,
    claimedAt: '2026-10-01T00:00:00.000Z',
    lastUsed: '2026-10-21',
    ...extra,
  }
}

function bases(claims: readonly { base: number }[]): number[] {
  return claims.map((c) => c.base).sort((a, b) => a - b)
}

test('staleReason: git-dir-gone after git worktree remove', (t) => {
  const r = repo(t)
  const wt = r.addWorktree('feature')
  const c = claimAt(wt, 20010)
  r.removeWorktree(wt)
  assert.equal(staleReason(c, { checkConfig: false }), 'git-dir-gone')
  assert.equal(staleReason(c, { checkConfig: true }), 'git-dir-gone')
})

test('staleReason: worktree-gone when the folder is deleted but the admin dir remains', (t) => {
  const r = repo(t)
  const wt = r.addWorktree('feature')
  const c = claimAt(wt, 20010)
  rmSync(wt, { recursive: true, force: true })
  assert.equal(staleReason(c, { checkConfig: false }), 'worktree-gone')
})

test('staleReason: a locked admin dir is never stale, even with its folder gone', (t) => {
  const r = repo(t)
  const wt = r.addWorktree('feature')
  const c = claimAt(wt, 20010)
  git(r.main, 'worktree', 'lock', wt)
  rmSync(wt, { recursive: true, force: true })
  assert.equal(staleReason(c, { checkConfig: false }), undefined)
  assert.equal(staleReason(c, { checkConfig: true }), undefined)
})

test('staleReason: config-gone only when checkConfig is set', (t) => {
  const r = repo(t)
  const wt = r.addWorktree('feature')
  const c = claimAt(wt, 20010)
  assert.equal(staleReason(c, { checkConfig: true }), undefined)
  rmSync(join(wt, CONFIG))
  assert.equal(staleReason(c, { checkConfig: true }), 'config-gone')
  assert.equal(staleReason(c, { checkConfig: false }), undefined)
})

test('staleReason: an absolute config outside the root is checked where it is', (t) => {
  const r = repo(t)
  const outside = join(r.dir, 'elsewhere.json')
  writeFileSync(outside, '{}\n')
  const c = claimAt(r.main, 20010, { config: outside })
  assert.equal(staleReason(c, { checkConfig: true }), undefined)
  rmSync(outside)
  assert.equal(staleReason(c, { checkConfig: true }), 'config-gone')
})

test('staleReason: a live main checkout and a live linked worktree are not stale', (t) => {
  const r = repo(t)
  const wt = r.addWorktree('feature')
  assert.equal(staleReason(claimAt(r.main, 20010), { checkConfig: true }), undefined)
  assert.equal(staleReason(claimAt(wt, 20020), { checkConfig: true }), undefined)
})

test('staleReason: a deleted main checkout is git-dir-gone', (t) => {
  const r = repo(t)
  const c = claimAt(r.main, 20010)
  rmSync(r.main, { recursive: true, force: true })
  assert.equal(staleReason(c, { checkConfig: false }), 'git-dir-gone')
})

/** live (20010), git-dir-gone (20020), worktree-gone (20030), config-gone (20040), locked+gone (20050). */
function scenario(r: TempRepo, state: string): void {
  writeClaim(state, claimAt(r.main, 20010))
  const removed = r.addWorktree('removed')
  writeClaim(state, claimAt(removed, 20020))
  r.removeWorktree(removed)
  const deleted = r.addWorktree('deleted')
  writeClaim(state, claimAt(deleted, 20030))
  rmSync(deleted, { recursive: true, force: true })
  const noConfig = r.addWorktree('noconfig')
  writeClaim(state, claimAt(noConfig, 20040))
  rmSync(join(noConfig, CONFIG))
  const locked = r.addWorktree('locked')
  writeClaim(state, claimAt(locked, 20050))
  git(r.main, 'worktree', 'lock', locked)
  rmSync(locked, { recursive: true, force: true })
}

test('collectStale deletes git-dir-gone and worktree-gone claims and keeps config-gone ones', (t) => {
  const r = repo(t)
  const state = freshState()
  scenario(r, state)
  assert.deepEqual(bases(collectStale(state)), [20020, 20030])
  assert.deepEqual(bases(readAllClaims(state)), [20010, 20040, 20050])
})

test('collectStale also deletes stale claims outside the current range', (t) => {
  const r = repo(t)
  const state = freshState()
  const wt = r.addWorktree('feature')
  writeClaim(state, claimAt(wt, 30000))
  r.removeWorktree(wt)
  assert.deepEqual(bases(collectStale(state)), [30000])
  assert.deepEqual(readAllClaims(state), [])
})

test('prune also removes config-gone claims, and reports each reason', async (t) => {
  const r = repo(t)
  const state = freshState()
  scenario(r, state)
  const reg = openRegistry({ stateDir: state, settings: { range: RANGE } })
  const removed = await reg.prune()
  assert.deepEqual(
    removed.map((x) => [x.claim.base, x.reason]).sort((a, b) => Number(a[0]) - Number(b[0])),
    [
      [20020, 'git-dir-gone'],
      [20030, 'worktree-gone'],
      [20040, 'config-gone'],
    ],
  )
  assert.deepEqual(bases(readAllClaims(state)), [20010, 20050])
})

test('prune --unused-for removes claims last used more than that many days ago', async (t) => {
  const r = repo(t)
  const state = freshState()
  const a = r.addWorktree('a')
  const b = r.addWorktree('b')
  writeClaim(state, claimAt(a, 20010, { lastUsed: '2026-09-20' }))
  writeClaim(state, claimAt(b, 20020, { lastUsed: '2026-09-21' }))
  const reg = openRegistry({ stateDir: state, settings: { range: RANGE } })
  const removed = await reg.prune({ unusedForDays: 30, today: '2026-10-21' })
  assert.deepEqual(
    removed.map((x) => [x.claim.base, x.reason]),
    [[20010, 'unused']],
  )
  assert.deepEqual(bases(readAllClaims(state)), [20020])
})

test('prune --dry-run returns the same removals and deletes nothing', async (t) => {
  const r = repo(t)
  const state = freshState()
  scenario(r, state)
  const old = r.addWorktree('old')
  writeClaim(state, claimAt(old, 20060, { lastUsed: '2026-01-01' }))
  const reg = openRegistry({ stateDir: state, settings: { range: RANGE } })
  const opts = { unusedForDays: 30, today: '2026-10-21' }
  const before = bases(readAllClaims(state))
  const dry = await reg.prune({ ...opts, dryRun: true })
  assert.deepEqual(bases(readAllClaims(state)), before)
  const real = await reg.prune(opts)
  assert.deepEqual(dry, real)
  assert.deepEqual(bases(dry.map((x) => x.claim)), [20020, 20030, 20040, 20060])
})

test('parseDuration accepts days and weeks only', () => {
  assert.equal(parseDuration('90d'), 90)
  assert.equal(parseDuration('12w'), 84)
  assert.equal(parseDuration('1d'), 1)
  for (const bad of ['90', '3m', '-1d', '0d', '', 'd', '1.5d', ' 90d', '90 d']) {
    assert.throws(() => parseDuration(bad), /duration/, bad)
  }
})

test('list marks stale claims with their reason, including config-gone', (t) => {
  const r = repo(t)
  const state = freshState()
  scenario(r, state)
  writeClaim(state, { ...claimAt(r.main, 30000), config: 'other.json' }) // outside the range: still listed
  const reg = openRegistry({ stateDir: state, settings: { range: RANGE } })
  const listed = reg.list()
  assert.deepEqual(
    listed.map((c) => [c.base, c.stale]),
    [
      [20010, undefined],
      [20020, 'git-dir-gone'],
      [20030, 'worktree-gone'],
      [20040, 'config-gone'],
      [20050, undefined],
      [30000, 'config-gone'],
    ],
  )
  assert.deepEqual(bases(readAllClaims(state)), [20010, 20020, 20030, 20040, 20050, 30000], 'list deletes nothing')
})

test("release deletes the owner's claim and returns it; undefined when there is none", async (t) => {
  const r = repo(t)
  const state = freshState()
  const wt = r.addWorktree('feature')
  const mine = claimAt(wt, 20010)
  const sibling = { ...claimAt(wt, 20020), config: 'apps/web/worktree-ports.json' }
  writeClaim(state, mine)
  writeClaim(state, sibling)
  const reg = openRegistry({ stateDir: state, settings: { range: RANGE } })
  assert.deepEqual(await reg.release({ gitDir: mine.gitDir, config: mine.config }), mine)
  assert.deepEqual(bases(readAllClaims(state)), [20020])
  assert.equal(await reg.release({ gitDir: mine.gitDir, config: mine.config }), undefined)
})

test('openRegistry exposes its state dir, range and lock options', () => {
  const state = freshState()
  const reg = openRegistry({ stateDir: state, settings: { range: RANGE }, lock: { lockTimeoutMs: 500 } })
  assert.equal(reg.stateDir, state)
  assert.deepEqual(reg.range, RANGE)
  assert.deepEqual(reg.lock, { lockTimeoutMs: 500 })
  const defaults = openRegistry()
  assert.equal(defaults.stateDir, testStateDir())
})
