import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LockTimeoutError, withLock } from '../src/registry/lock.ts'
import { type Claim, claimsDir, deleteClaim, readAllClaims, readClaims, writeClaim } from '../src/registry/store.ts'
import type { PortRange } from '../src/settings.ts'
import { testStateDir } from './setup.ts'

const RANGE: PortRange = { min: 20000, max: 20999 }

/** A fresh, empty state dir for one test (it does not exist yet). */
function freshState(): string {
  return join(mkdtempSync(join(testStateDir(), 'store-')), 'state')
}

function claim(base: number, extra: Partial<Claim> = {}): Claim {
  return {
    base,
    size: 10,
    gitDir: `/home/me/src/app/.git/worktrees/w${base}`,
    root: `/home/me/src/app/.worktrees/w${base}`,
    config: 'worktree-ports.json',
    claimedAt: '2026-10-21T18:30:00.000Z',
    lastUsed: '2026-10-21',
    ...extra,
  }
}

function writeRaw(state: string, name: string, text: string): void {
  mkdirSync(join(state, 'claims'), { recursive: true })
  writeFileSync(join(state, 'claims', name), text)
}

test('fresh machine: no state dir reads as no claims, and a write creates the dirs', () => {
  const state = freshState()
  assert.deepEqual(readClaims(state, RANGE), [])
  assert.deepEqual(readAllClaims(state), [])
  assert.equal(existsSync(state), false, 'reading must not create the state dir')
  writeClaim(state, claim(20010))
  assert.deepEqual(readdirSync(join(state, 'claims')), ['20010.json'])
})

test('claimsDir is <state>/claims and is created on demand', () => {
  const state = freshState()
  assert.equal(claimsDir(state), join(state, 'claims'))
  assert.ok(existsSync(join(state, 'claims')))
})

test('a claim round-trips through its file', () => {
  const state = freshState()
  const c = claim(20040, { size: 20, config: 'apps/api/worktree-ports.json' })
  writeClaim(state, c)
  assert.deepEqual(readClaims(state, RANGE), [c])
})

test('writeClaim leaves no temp file behind and overwrites in place', () => {
  const state = freshState()
  writeClaim(state, claim(20010))
  writeClaim(state, claim(20010, { lastUsed: '2026-10-22' }))
  assert.deepEqual(readdirSync(join(state, 'claims')), ['20010.json'])
  assert.equal(readClaims(state, RANGE)[0]?.lastUsed, '2026-10-22')
})

test('debris and invalid claim files are ignored, never thrown', () => {
  const state = freshState()
  writeClaim(state, claim(20010))
  writeRaw(state, '20020.json', 'not json {')
  const { lastUsed: _drop, ...missing } = claim(20030)
  writeRaw(state, '20030.json', JSON.stringify(missing))
  writeRaw(state, '20045.json', JSON.stringify(claim(20045))) // misaligned
  writeRaw(state, '19990.json', JSON.stringify(claim(19990))) // below the range
  writeRaw(state, '20990.json', JSON.stringify(claim(20990, { size: 20 }))) // runs past max
  writeRaw(state, '20010.json.123.tmp', JSON.stringify(claim(20010)))
  writeRaw(state, 'notes.txt', 'hello')
  writeRaw(state, '20060.json', JSON.stringify(claim(20070))) // name disagrees with base
  writeRaw(state, '020080.json', JSON.stringify(claim(20080))) // leading zero: not its canonical name
  writeRaw(state, '20090.json', JSON.stringify(claim(20090, { size: 0 })))
  writeRaw(state, '20100.json', JSON.stringify(claim(20100, { lastUsed: 'yesterday' })))
  writeRaw(state, '20110.json', 'null')
  mkdirSync(join(state, 'claims', '20120.json'))
  assert.deepEqual(
    readClaims(state, RANGE).map((c) => c.base),
    [20010],
  )
})

test('readAllClaims keeps well-formed claims outside the range, readClaims drops them', () => {
  const state = freshState()
  writeClaim(state, claim(20010))
  writeClaim(state, claim(30000))
  assert.deepEqual(
    readAllClaims(state).map((c) => c.base),
    [20010, 30000],
  )
  assert.deepEqual(
    readClaims(state, RANGE).map((c) => c.base),
    [20010],
  )
})

test(
  'an unreadable claim file is an error, not an absent claim',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  (t) => {
    const state = freshState()
    writeClaim(state, claim(20010))
    const file = join(state, 'claims', '20010.json')
    chmodSync(file, 0o000)
    t.after(() => chmodSync(file, 0o644))
    assert.throws(() => readClaims(state, RANGE), /20010\.json/)
  },
)

test('deleteClaim removes the file and tolerates a missing one', () => {
  const state = freshState()
  writeClaim(state, claim(20010))
  deleteClaim(state, 20010)
  assert.deepEqual(readClaims(state, RANGE), [])
  deleteClaim(state, 20010)
  deleteClaim(freshState(), 20010)
})

test('withLock runs fn, returns its value and removes the lock dir', async () => {
  const state = freshState()
  const out = await withLock(state, () => {
    assert.ok(existsSync(join(state, 'lock')), 'lock held while fn runs')
    return 42
  })
  assert.equal(out, 42)
  assert.equal(existsSync(join(state, 'lock')), false)
})

test('withLock removes the lock dir when fn throws', async () => {
  const state = freshState()
  await assert.rejects(
    withLock(state, async () => {
      throw new Error('boom')
    }),
    /boom/,
  )
  assert.equal(existsSync(join(state, 'lock')), false)
})

test('a second withLock waits for the first', async () => {
  const state = freshState()
  const events: string[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const first = withLock(state, async () => {
    events.push('first:start')
    await gate
    events.push('first:end')
  })
  // Let the first one take the lock before the second starts.
  await new Promise((r) => setTimeout(r, 10))
  const second = withLock(state, () => {
    events.push('second')
  })
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(events, ['first:start'])
  release()
  await Promise.all([first, second])
  assert.deepEqual(events, ['first:start', 'first:end', 'second'])
})

test('a fresh foreign lock times out with LockTimeoutError naming the lock dir', async () => {
  const state = freshState()
  const lock = join(state, 'lock')
  mkdirSync(lock, { recursive: true })
  let ran = false
  const err = await withLock(
    state,
    () => {
      ran = true
    },
    { lockTimeoutMs: 200, staleLockMs: 60_000 },
  ).then(
    () => undefined,
    (e: unknown) => e,
  )
  assert.ok(err instanceof LockTimeoutError)
  assert.equal(err.lockPath, lock)
  assert.match(err.message, new RegExp(lock.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')))
  assert.equal(ran, false)
  assert.ok(existsSync(lock), 'a fresh foreign lock is left alone')
})

test('a lock older than staleLockMs is broken and fn runs', async () => {
  const state = freshState()
  const lock = join(state, 'lock')
  mkdirSync(lock, { recursive: true })
  const old = new Date(Date.now() - 5_000)
  utimesSync(lock, old, old)
  const out = await withLock(state, () => 'ran', { lockTimeoutMs: 1_000, staleLockMs: 100 })
  assert.equal(out, 'ran')
  assert.equal(existsSync(lock), false)
})
