import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { makeRepo, type TempRepo } from './helpers/repo.ts'
import { locateWorktree } from '../src/git.ts'
import { type ClaimHooks, type ClaimOwner, RegistryFullError, claimBlock, lookupClaim } from '../src/registry/claim.ts'
import { type Registry, openRegistry } from '../src/registry/index.ts'
import { type Claim, readAllClaims, writeClaim } from '../src/registry/store.ts'
import { type PortRange, settingsPath } from '../src/settings.ts'
import { testStateDir } from './setup.ts'

const RANGE: PortRange = { min: 20000, max: 20999 }
const CONFIG = 'worktree-ports.json'
const TODAY = '2026-10-21'

/** A registry over a fresh, empty state dir. */
function registry(range: PortRange = RANGE, stateDir?: string): Registry {
  return openRegistry({ stateDir: stateDir ?? mkdtempSync(join(testStateDir(), 'claim-')), settings: { range } })
}

function repo(t: { after(fn: () => void): void }): TempRepo {
  const r = makeRepo()
  t.after(() => r.cleanup())
  return r
}

function owner(dir: string, config = CONFIG): ClaimOwner {
  const loc = locateWorktree(dir)
  return { gitDir: loc.gitDir, root: loc.root, config }
}

/** Hooks with nothing listening and a fixed day. */
function hooks(extra: ClaimHooks = {}): ClaimHooks {
  return { isListening: async () => false, today: () => TODAY, ...extra }
}

function claimOf(o: ClaimOwner, base: number, size = 10, extra: Partial<Claim> = {}): Claim {
  return { base, size, ...o, claimedAt: '2026-10-01T00:00:00.000Z', lastUsed: TODAY, ...extra }
}

function files(reg: Registry): string[] {
  const dir = join(reg.stateDir, 'claims')
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

function disjoint(claims: readonly Claim[]): boolean {
  const sorted = [...claims].sort((a, b) => a.base - b.base)
  return sorted.every((c, i) => i === 0 || sorted[i - 1]!.base + sorted[i - 1]!.size <= c.base)
}

function aligned(base: number, size: number, range: PortRange): boolean {
  return base >= range.min && (base - range.min) % 10 === 0 && base + size - 1 <= range.max
}

// --- basics -------------------------------------------------------------------------------------------

test('first claim allocates an aligned block in the range and writes its file', async (t) => {
  const reg = registry()
  const o = owner(repo(t).main)
  const { claim, source } = await claimBlock(o, 10, reg, hooks())
  assert.equal(source, 'allocated')
  assert.equal(claim.size, 10)
  assert.ok(aligned(claim.base, 10, RANGE), `base ${claim.base}`)
  assert.equal(claim.gitDir, o.gitDir)
  assert.equal(claim.root, o.root)
  assert.equal(claim.config, CONFIG)
  assert.equal(claim.lastUsed, TODAY)
  assert.deepEqual(files(reg), [`${claim.base}.json`])
  assert.deepEqual(readAllClaims(reg.stateDir), [claim])
})

test('a second claim for the same owner returns the existing block', async (t) => {
  const reg = registry()
  const o = owner(repo(t).main)
  const first = await claimBlock(o, 10, reg, hooks())
  const second = await claimBlock(o, 10, reg, hooks())
  assert.equal(second.source, 'existing')
  assert.equal(second.claim.base, first.claim.base)
  assert.equal(files(reg).length, 1)
  assert.deepEqual(lookupClaim(reg, o, 10), first.claim)
})

test('claimedAt and lastUsed come from the hooks', async (t) => {
  const reg = registry()
  const { claim } = await claimBlock(owner(repo(t).main), 10, reg, {
    ...hooks(),
    now: () => new Date('2026-10-21T18:30:00.000Z'),
    today: () => '2026-10-20',
  })
  assert.equal(claim.claimedAt, '2026-10-21T18:30:00.000Z')
  assert.equal(claim.lastUsed, '2026-10-20')
})

test('a size that is not a positive multiple of 10 is rejected', async (t) => {
  const reg = registry()
  const o = owner(repo(t).main)
  for (const size of [0, 5, 15, -10, 2.5]) {
    await assert.rejects(claimBlock(o, size, reg, hooks()), /size/)
  }
})

// --- two owners ---------------------------------------------------------------------------------------

test('two worktrees of one repo get non-overlapping blocks', async (t) => {
  const reg = registry()
  const r = repo(t)
  const a = await claimBlock(owner(r.main), 20, reg, hooks())
  const b = await claimBlock(owner(r.addWorktree('feature')), 20, reg, hooks())
  assert.equal(b.source, 'allocated')
  assert.ok(disjoint([a.claim, b.claim]))
})

test('two separate repos get non-overlapping blocks', async (t) => {
  const reg = registry()
  const a = await claimBlock(owner(repo(t).main), 10, reg, hooks())
  const b = await claimBlock(owner(repo(t).main), 10, reg, hooks())
  assert.notEqual(a.claim.gitDir, b.claim.gitDir)
  assert.ok(disjoint([a.claim, b.claim]))
})

test('one git dir with two configs gets two claims', async (t) => {
  const reg = registry()
  const main = repo(t).main
  const a = await claimBlock(owner(main, 'a/worktree-ports.json'), 10, reg, hooks())
  const b = await claimBlock(owner(main, 'b/worktree-ports.json'), 10, reg, hooks())
  assert.equal(b.source, 'allocated')
  assert.ok(disjoint([a.claim, b.claim]))
  assert.equal(files(reg).length, 2)
})

// --- lastUsed -----------------------------------------------------------------------------------------

test('a claim from an earlier day gets lastUsed rewritten to today', async (t) => {
  const reg = registry()
  const o = owner(repo(t).main)
  const first = await claimBlock(o, 10, reg, hooks({ today: () => '2026-10-21' }))
  const next = await claimBlock(o, 10, reg, hooks({ today: () => '2026-10-22' }))
  assert.equal(next.source, 'existing')
  assert.equal(next.claim.base, first.claim.base)
  assert.equal(next.claim.lastUsed, '2026-10-22')
  assert.equal(next.claim.claimedAt, first.claim.claimedAt)
  assert.deepEqual(readAllClaims(reg.stateDir), [next.claim])
})

test('a claim already used today is not rewritten', async (t) => {
  const reg = registry()
  const o = owner(repo(t).main)
  const { claim } = await claimBlock(o, 10, reg, hooks())
  const file = join(reg.stateDir, 'claims', `${claim.base}.json`)
  const before = statSync(file).mtimeMs
  await new Promise((r) => setTimeout(r, 20))
  const again = await claimBlock(o, 10, reg, hooks())
  assert.equal(again.source, 'existing')
  assert.equal(statSync(file).mtimeMs, before)
  assert.ok(!existsSync(join(reg.stateDir, 'lock')))
})

test('lookupClaim never writes', async (t) => {
  const reg = registry()
  const o = owner(repo(t).main)
  writeClaim(reg.stateDir, claimOf(o, 20010, 10, { lastUsed: '2026-01-01' }))
  const file = join(reg.stateDir, 'claims', '20010.json')
  const before = statSync(file).mtimeMs
  assert.equal(lookupClaim(reg, o, 10)?.base, 20010)
  assert.equal(statSync(file).mtimeMs, before)
  assert.equal(lookupClaim(reg, o, 20), undefined, 'too small')
  assert.equal(lookupClaim(reg, { ...o, config: 'other.json' }, 10), undefined, 'other config')
})

// --- growth and range changes -------------------------------------------------------------------------

test('a grown config keeps its base when the larger block is free', async (t) => {
  const reg = registry()
  const o = owner(repo(t).main)
  writeClaim(reg.stateDir, claimOf(o, 20500, 10))
  const { claim, source } = await claimBlock(o, 20, reg, hooks())
  assert.equal(source, 'allocated')
  assert.equal(claim.base, 20500)
  assert.equal(claim.size, 20)
  assert.deepEqual(files(reg), ['20500.json'])
})

test('a grown config keeps its base even while its own old ports are in use', async (t) => {
  const reg = registry()
  const o = owner(repo(t).main)
  writeClaim(reg.stateDir, claimOf(o, 20500, 10))
  // Our own servers still listen on the old block; only the new ports need to be free.
  const isListening = async (port: number) => port >= 20500 && port < 20510
  const { claim } = await claimBlock(o, 20, reg, hooks({ isListening }))
  assert.equal(claim.base, 20500)
})

test('a grown config moves when the larger block is taken, and the old file is gone', async (t) => {
  const reg = registry()
  const r = repo(t)
  const o = owner(r.main)
  writeClaim(reg.stateDir, claimOf(o, 20500, 10))
  writeClaim(reg.stateDir, claimOf(owner(repo(t).main), 20510, 10))
  const { claim, source } = await claimBlock(o, 20, reg, hooks())
  assert.equal(source, 'allocated')
  assert.notEqual(claim.base, 20500)
  assert.equal(claim.size, 20)
  assert.ok(!existsSync(join(reg.stateDir, 'claims', '20500.json')))
  assert.ok(disjoint(readAllClaims(reg.stateDir)))
  assert.equal(readAllClaims(reg.stateDir).length, 2)
})

test('a claim outside a changed range is replaced by one inside it (Review Focus 5)', async (t) => {
  const state = mkdtempSync(join(testStateDir(), 'claim-'))
  const o = owner(repo(t).main)
  writeClaim(state, claimOf(o, 20010, 10))
  const moved: PortRange = { min: 30000, max: 30999 }
  const reg = registry(moved, state)
  assert.equal(lookupClaim(reg, o, 10), undefined)
  const { claim, source } = await claimBlock(o, 10, reg, hooks())
  assert.equal(source, 'allocated')
  assert.ok(claim.base >= 30000 && claim.base <= 30990, `base ${claim.base}`)
  assert.ok(aligned(claim.base, 10, moved))
  assert.ok(!existsSync(join(state, 'claims', '20010.json')))
  assert.deepEqual(files(reg), [`${claim.base}.json`])
})

test('a misaligned own claim is replaced', async (t) => {
  const reg = registry()
  const o = owner(repo(t).main)
  writeClaim(reg.stateDir, claimOf(o, 20005, 10))
  const { claim } = await claimBlock(o, 10, reg, hooks())
  assert.ok(aligned(claim.base, 10, RANGE))
  assert.deepEqual(files(reg), [`${claim.base}.json`])
})

// --- probing ------------------------------------------------------------------------------------------

test('candidates with a listening port are skipped', async (t) => {
  const reg = registry()
  const probed: number[] = []
  // random() = 0 picks the lowest remaining candidate, so the order is 20000, 20010, 20020, ...
  const isListening = async (port: number) => {
    probed.push(port)
    return port === 20003 || port === 20019
  }
  const { claim } = await claimBlock(owner(repo(t).main), 10, reg, hooks({ random: () => 0, isListening }))
  assert.equal(claim.base, 20020)
  for (let p = 20020; p < 20030; p++) assert.ok(probed.includes(p), `probed ${p}`)
})

// --- cleanup ------------------------------------------------------------------------------------------

test('claiming deletes a claim whose git dir has gone', async (t) => {
  const reg = registry()
  const r = repo(t)
  const wt = r.addWorktree('gone')
  writeClaim(reg.stateDir, claimOf(owner(wt), 20010, 10))
  r.removeWorktree(wt)
  await claimBlock(owner(r.main), 10, reg, hooks())
  assert.ok(!existsSync(join(reg.stateDir, 'claims', '20010.json')))
  assert.equal(readAllClaims(reg.stateDir).length, 1)
})

test('a stale claim does not count as taken space', async (t) => {
  const reg = registry({ min: 20000, max: 20009 })
  const r = repo(t)
  const wt = r.addWorktree('gone')
  writeClaim(reg.stateDir, claimOf(owner(wt), 20000, 10))
  r.removeWorktree(wt)
  const { claim } = await claimBlock(owner(r.main), 10, reg, hooks())
  assert.equal(claim.base, 20000)
})

// --- races --------------------------------------------------------------------------------------------

test('concurrent claims for the same owner resolve to one block', async (t) => {
  const reg = registry()
  const o = owner(repo(t).main)
  const results = await Promise.all([claimBlock(o, 10, reg, hooks()), claimBlock(o, 10, reg, hooks())])
  assert.equal(results[0].claim.base, results[1].claim.base)
  assert.deepEqual(results.map((r) => r.source).sort(), ['allocated', 'existing'])
  assert.equal(files(reg).length, 1)
})

test('8 concurrent claims for 8 owners get 8 disjoint blocks', async (t) => {
  const reg = registry({ min: 20000, max: 20199 })
  const r = repo(t)
  const owners = [r.main, r.addWorktree('w1'), r.addWorktree('w2'), r.addWorktree('w3')].flatMap((dir) => [
    owner(dir, 'a/worktree-ports.json'),
    owner(dir, 'b/worktree-ports.json'),
  ])
  const results = await Promise.all(owners.map((o) => claimBlock(o, 20, reg, hooks())))
  const claims = results.map((x) => x.claim)
  assert.ok(disjoint(claims))
  assert.equal(new Set(claims.map((c) => c.base)).size, 8)
  assert.equal(files(reg).length, 8)
  assert.ok(results.every((x) => x.source === 'allocated'))
})

test('backstop: a fresh claim that overlaps a claim written outside the lock yields and retries', async (t) => {
  const reg = registry({ min: 20000, max: 20099 })
  const o = owner(repo(t).main)
  const foreign = owner(repo(t).main)
  const writes: Claim[] = []
  let calls = 0
  // random() = 0.5 keeps the first pick off `min`, so a foreign block at base - 10 still fits.
  const { claim, source } = await claimBlock(
    o,
    10,
    reg,
    hooks({
      random: () => 0.5,
      afterWrite: (c) => {
        writes.push(c)
        if (calls++ === 0) writeClaim(reg.stateDir, claimOf(foreign, c.base - 10, 20))
      },
    }),
  )
  assert.equal(source, 'allocated')
  assert.equal(writes.length, 2, 'wrote, yielded, wrote again')
  const first = writes[0]!
  assert.notEqual(claim.base, first.base)
  assert.ok(!existsSync(join(reg.stateDir, 'claims', `${first.base}.json`)), 'our first file is gone')
  const all = readAllClaims(reg.stateDir)
  assert.equal(all.length, 2)
  assert.ok(disjoint(all))
  assert.ok(
    all.some((c) => c.gitDir === foreign.gitDir && c.base === first.base - 10),
    'foreign claim kept',
  )
})

test('backstop: a file that no longer names us is not deleted', async (t) => {
  const reg = registry({ min: 20000, max: 20099 })
  const o = owner(repo(t).main)
  const foreign = owner(repo(t).main)
  let calls = 0
  const { claim } = await claimBlock(
    o,
    10,
    reg,
    hooks({
      random: () => 0.5,
      afterWrite: (c) => {
        // A writer outside the lock replaces our file with its own claim at the same base.
        if (calls++ === 0) writeClaim(reg.stateDir, claimOf(foreign, c.base, 10))
      },
    }),
  )
  const all = readAllClaims(reg.stateDir)
  assert.equal(all.length, 2)
  assert.ok(disjoint(all))
  assert.ok(
    all.some((c) => c.gitDir === foreign.gitDir),
    'foreign claim kept',
  )
  assert.ok(all.some((c) => c.gitDir === o.gitDir && c.base === claim.base))
})

test('settled overlap: the owner whose gitDir sorts later moves, the other keeps its base', async (t) => {
  const reg = registry()
  const [x, y] = [owner(repo(t).main), owner(repo(t).main)].sort((a, b) => (a.gitDir < b.gitDir ? -1 : 1))
  const early = x!
  const late = y!
  writeClaim(reg.stateDir, claimOf(early, 20010, 20))
  writeClaim(reg.stateDir, claimOf(late, 20020, 10))
  assert.equal(lookupClaim(reg, early, 20)?.base, 20010)
  assert.equal(lookupClaim(reg, late, 10), undefined)

  const kept = await claimBlock(early, 20, reg, hooks())
  assert.equal(kept.source, 'existing')
  assert.equal(kept.claim.base, 20010)

  const moved = await claimBlock(late, 10, reg, hooks())
  assert.equal(moved.source, 'allocated')
  assert.notEqual(moved.claim.base, 20020)
  const all = readAllClaims(reg.stateDir)
  assert.equal(all.length, 2)
  assert.ok(disjoint(all))
  assert.ok(all.some((c) => c.gitDir === early.gitDir && c.base === 20010))
})

test('settled overlap with the same gitDir: the later-sorting config moves', async (t) => {
  const reg = registry()
  const main = repo(t).main
  const a = owner(main, 'a/worktree-ports.json')
  const b = owner(main, 'b/worktree-ports.json')
  writeClaim(reg.stateDir, claimOf(b, 20010, 10))
  writeClaim(reg.stateDir, claimOf(a, 20000, 20))
  assert.equal(lookupClaim(reg, a, 20)?.base, 20000)
  assert.equal(lookupClaim(reg, b, 10), undefined)
})

// --- exhaustion ---------------------------------------------------------------------------------------

test('a full range throws RegistryFullError listing the claims oldest first', async (t) => {
  const reg = registry({ min: 20000, max: 20029 })
  const owners = [owner(repo(t).main), owner(repo(t).main), owner(repo(t).main)]
  writeClaim(reg.stateDir, claimOf(owners[0]!, 20000, 10, { lastUsed: '2026-10-20' }))
  writeClaim(reg.stateDir, claimOf(owners[1]!, 20010, 10, { lastUsed: '2026-09-01' }))
  writeClaim(reg.stateDir, claimOf(owners[2]!, 20020, 10, { lastUsed: '2026-10-01' }))
  const fourth = owner(repo(t).main)
  const err = await claimBlock(fourth, 10, reg, hooks()).then(
    () => assert.fail('expected RegistryFullError'),
    (e: unknown) => e,
  )
  assert.ok(err instanceof RegistryFullError)
  assert.deepEqual(
    err.claims.map((c) => c.base),
    [20010, 20020, 20000],
  )
  const msg = err.message
  const listing = msg.indexOf('oldest last use first')
  assert.ok(listing >= 0, msg)
  const pos = [20010, 20020, 20000].map((b) => msg.indexOf(`  ${b}  `, listing))
  assert.ok(pos.every((p) => p >= 0) && pos[0]! < pos[1]! && pos[1]! < pos[2]!, msg)
  for (const [i, c] of [owners[1]!, owners[2]!, owners[0]!].entries()) {
    assert.ok(msg.includes(c.root), `root ${i}`)
  }
  for (const day of ['2026-09-01', '2026-10-01', '2026-10-20']) assert.ok(msg.includes(day), day)
  assert.match(msg, /size 10/)
  assert.ok(msg.includes('worktree-ports prune --unused-for 30d'))
  assert.ok(msg.includes('worktree-ports release'))
  assert.ok(msg.includes(settingsPath()))
  assert.equal(readAllClaims(reg.stateDir).length, 3, 'nothing written')
})

test('exhaustion keeps an own claim that is too small', async (t) => {
  const reg = registry({ min: 20000, max: 20019 })
  const o = owner(repo(t).main)
  writeClaim(reg.stateDir, claimOf(o, 20000, 10))
  writeClaim(reg.stateDir, claimOf(owner(repo(t).main), 20010, 10))
  await assert.rejects(claimBlock(o, 20, reg, hooks()), RegistryFullError)
  assert.deepEqual(files(reg), ['20000.json', '20010.json'])
})

test('busy candidates count toward exhaustion', async (t) => {
  const reg = registry({ min: 20000, max: 20019 })
  await assert.rejects(
    claimBlock(owner(repo(t).main), 10, reg, hooks({ isListening: async () => true })),
    (e: unknown) => e instanceof RegistryFullError && /listening/.test(e.message),
  )
  assert.deepEqual(files(reg), [])
})

test('the backstop gives up after maxAttempts', async (t) => {
  const reg = registry()
  const o = owner(repo(t).main)
  const foreign = owner(repo(t).main)
  await assert.rejects(
    claimBlock(
      o,
      10,
      reg,
      hooks({ maxAttempts: 3, afterWrite: (c) => writeClaim(reg.stateDir, claimOf(foreign, c.base, 10)) }),
    ),
    /after 3 attempts/,
  )
  assert.ok(readAllClaims(reg.stateDir).every((c) => c.gitDir === foreign.gitDir))
  assert.ok(!existsSync(join(reg.stateDir, 'lock')), 'lock released')
})
