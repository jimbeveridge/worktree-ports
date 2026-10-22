import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseConfig, type WorktreePortsConfig } from '../src/config.ts'
import { locateWorktree } from '../src/git.ts'
import { readSiblingReservations, reservationPath, reservePorts } from '../src/reserve.ts'
import { makeRepo } from './helpers/repo.ts'

/** Three blocks: 20000, 20010, 20020. */
function config(extra: Record<string, unknown> = {}): WorktreePortsConfig {
  return parseConfig({
    fileName: 'port.txt',
    range: { min: 20000, max: 20020, step: 10 },
    services: { api: { offset: 0 }, web: { offset: 1 } },
    ...extra,
  })
}
const withMain = () => config({ services: { api: { offset: 0, mainPort: 8080 }, web: { offset: 1, mainPort: 3000 } } })

test('main checkout with mainPorts reserves nothing and writes no file', (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const loc = locateWorktree(repo.main)
  assert.deepEqual(reservePorts(loc, withMain()), { source: 'main' })
  assert.equal(existsSync(join(repo.main, '.git', 'port.txt')), false)
})

test('main checkout without mainPorts allocates like any worktree', (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const r = reservePorts(locateWorktree(repo.main), config())
  assert.equal(r.source, 'allocated')
  assert.ok(existsSync(join(repo.main, '.git', 'port.txt')))
})

test('a linked worktree allocates a block, writes it, and keeps it', (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const loc = locateWorktree(repo.addWorktree('a'))
  const first = reservePorts(loc, withMain())
  assert.equal(first.source, 'allocated')
  assert.ok([20000, 20010, 20020].includes(first.base))
  assert.equal(reservationPath(loc, withMain()), join(repo.main, '.git', 'worktrees', 'a', 'port.txt'))
  assert.equal(readFileSync(reservationPath(loc, withMain()), 'utf8'), `${first.base}\n`)
  assert.deepEqual(reservePorts(loc, withMain()), { source: 'existing', base: first.base })
})

test('skips blocks held by siblings', (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const a = locateWorktree(repo.addWorktree('a'))
  const b = locateWorktree(repo.addWorktree('b'))
  const c = locateWorktree(repo.addWorktree('c'))
  writeFileSync(join(a.gitDir, 'port.txt'), '20000\n')
  writeFileSync(join(b.gitDir, 'port.txt'), '20020\n')
  assert.deepEqual(reservePorts(c, config(), { random: () => 0 }), { source: 'allocated', base: 20010 })
  assert.deepEqual(
    readSiblingReservations(c, config())
      .map((s) => s.base)
      .sort(),
    [20000, 20020],
  )
})

test('throws when every block is taken', (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  for (const [name, base] of [
    ['a', 20000],
    ['b', 20010],
    ['c', 20020],
  ] as const) {
    writeFileSync(join(locateWorktree(repo.addWorktree(name)).gitDir, 'port.txt'), `${base}\n`)
  }
  const d = locateWorktree(repo.addWorktree('d'))
  assert.throws(() => reservePorts(d, config()), /no free port block/)
})

test('a fresh claim yields when a concurrent claimer lands on the same block', (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const rival = locateWorktree(repo.addWorktree('a'))
  const me = locateWorktree(repo.addWorktree('z'))
  const candidates: number[] = []
  const r = reservePorts(me, config(), {
    random: () => 0,
    afterWrite: (candidate) => {
      candidates.push(candidate)
      // The rival writes the same block between our write and our scan — on the first round only.
      if (candidates.length === 1) writeFileSync(join(rival.gitDir, 'port.txt'), `${candidate}\n`)
    },
  })
  assert.deepEqual(candidates, [20000, 20010])
  assert.deepEqual(r, { source: 'allocated', base: 20010 })
  assert.equal(readFileSync(join(rival.gitDir, 'port.txt'), 'utf8'), '20000\n')
})

test('a fresh claim yields even when it sorts first', (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const me = locateWorktree(repo.addWorktree('a'))
  const rival = locateWorktree(repo.addWorktree('z'))
  const r = reservePorts(me, config(), {
    random: () => 0,
    afterWrite: (candidate) => {
      if (candidate === 20000) writeFileSync(join(rival.gitDir, 'port.txt'), '20000\n')
    },
  })
  assert.notEqual(r.source === 'main' ? undefined : r.base, 20000)
})

test('two settled reservations that clash: only the later-sorting git dir moves', (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const a = locateWorktree(repo.addWorktree('a'))
  const b = locateWorktree(repo.addWorktree('b'))
  writeFileSync(join(a.gitDir, 'port.txt'), '20000\n')
  writeFileSync(join(b.gitDir, 'port.txt'), '20000\n')
  assert.deepEqual(reservePorts(a, config()), { source: 'existing', base: 20000 })
  const moved = reservePorts(b, config(), { random: () => 0 })
  assert.deepEqual(moved, { source: 'allocated', base: 20010 })
  assert.deepEqual(reservePorts(a, config()), { source: 'existing', base: 20000 })
})

test('ignores unreadable, misaligned, out-of-range and temp files', (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const a = locateWorktree(repo.addWorktree('a'))
  const b = locateWorktree(repo.addWorktree('b'))
  const c = locateWorktree(repo.addWorktree('c'))
  writeFileSync(join(a.gitDir, 'port.txt'), 'banana')
  writeFileSync(join(b.gitDir, 'port.txt'), '20005\n')
  writeFileSync(join(c.gitDir, 'port.txt.123.tmp'), '20000\n')
  assert.deepEqual(readSiblingReservations(c, config()), [])
  assert.equal(reservePorts(a, config(), { random: () => 0 }).source, 'allocated')
})

test('removing a worktree frees its block', (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const oneBlock = config({ range: { min: 20000, max: 20000, step: 10 } })
  const aPath = repo.addWorktree('a')
  const a = locateWorktree(aPath)
  const b = locateWorktree(repo.addWorktree('b'))
  assert.deepEqual(reservePorts(a, oneBlock), { source: 'allocated', base: 20000 })
  assert.throws(() => reservePorts(b, oneBlock), /no free port block/)
  repo.removeWorktree(aPath)
  assert.deepEqual(reservePorts(b, oneBlock), { source: 'allocated', base: 20000 })
})

test('a lock held by someone else times out, then succeeds once released', (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const loc = locateWorktree(repo.main)
  const lockPath = join(loc.commonDir, 'port.txt.lock')
  mkdirSync(lockPath)
  assert.throws(
    () => reservePorts(loc, config(), { lockTimeoutMs: 200 }),
    (err: unknown) =>
      err instanceof Error && /timed out .* waiting for/.test(err.message) && err.message.includes(lockPath),
  )
  rmSync(lockPath, { recursive: true, force: true })
  assert.equal(reservePorts(loc, config()).source, 'allocated')
})

test('a stale lock is broken and the claim proceeds', (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const loc = locateWorktree(repo.main)
  const lockPath = join(loc.commonDir, 'port.txt.lock')
  mkdirSync(lockPath)
  const past = new Date(Date.now() - 60_000)
  utimesSync(lockPath, past, past)
  const r = reservePorts(loc, config(), { staleLockMs: 10_000 })
  assert.equal(r.source, 'allocated')
  assert.equal(existsSync(lockPath), false)
})

test("the default lock timeout outlives a crashed claim's lock and breaks it", { timeout: 20_000 }, (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const loc = locateWorktree(repo.main)
  const lockPath = join(loc.commonDir, 'port.txt.lock')
  mkdirSync(lockPath) // fresh mtime (age 0): a claim that crashed just now
  const r = reservePorts(loc, config(), { staleLockMs: 6_000 })
  assert.equal(r.source, 'allocated')
  assert.equal(existsSync(lockPath), false)
})

test('the claim lock is released after success and after a throw', (t) => {
  const repo1 = makeRepo()
  t.after(() => repo1.cleanup())
  const loc1 = locateWorktree(repo1.main)
  const lockPath1 = join(loc1.commonDir, 'port.txt.lock')
  reservePorts(loc1, config())
  assert.equal(existsSync(lockPath1), false)

  const repo2 = makeRepo()
  t.after(() => repo2.cleanup())
  for (const [name, base] of [
    ['a', 20000],
    ['b', 20010],
    ['c', 20020],
  ] as const) {
    writeFileSync(join(locateWorktree(repo2.addWorktree(name)).gitDir, 'port.txt'), `${base}\n`)
  }
  const d = locateWorktree(repo2.addWorktree('d'))
  const lockPath2 = join(d.commonDir, 'port.txt.lock')
  assert.throws(() => reservePorts(d, config()), /no free port block/)
  assert.equal(existsSync(lockPath2), false)
})

test('a yielded claim does not leave its own file behind when it then fails', (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const oneBlock = config({ range: { min: 20000, max: 20000, step: 10 } })
  const rival = locateWorktree(repo.addWorktree('a'))
  const me = locateWorktree(repo.addWorktree('z'))
  const own = reservationPath(me, oneBlock)
  let calls = 0
  assert.throws(
    () =>
      reservePorts(me, oneBlock, {
        afterWrite: () => {
          calls++
          if (calls === 1) writeFileSync(join(rival.gitDir, 'port.txt'), '20000\n')
        },
      }),
    /no free port block/,
  )
  assert.equal(existsSync(own), false)
})

test('a sibling reservation path that is unreadable for a real reason propagates', (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const b = locateWorktree(repo.addWorktree('b'))
  mkdirSync(join(b.gitDir, 'port.txt'))
  const a = locateWorktree(repo.addWorktree('a'))
  assert.throws(
    () => reservePorts(a, config()),
    (err: unknown) => (err as NodeJS.ErrnoException).code === 'EISDIR',
  )
})

test(
  'nine real processes across three worktrees each converge on one block per worktree',
  { timeout: 30_000 },
  async (t) => {
    const repo = makeRepo()
    t.after(() => repo.cleanup())
    const wtConfig = {
      fileName: 'port.txt',
      range: { min: 20000, max: 20040, step: 10 },
      services: { api: { offset: 0 } },
    }
    const worktrees = ['x', 'y', 'z'].map((name) => ({ name, path: repo.addWorktree(name) }))

    const reserveUrl = pathToFileURL(join(import.meta.dirname, '../src/reserve.ts')).href
    const configUrl = pathToFileURL(join(import.meta.dirname, '../src/config.ts')).href
    const gitUrl = pathToFileURL(join(import.meta.dirname, '../src/git.ts')).href
    const script = [
      `import { reservePorts } from ${JSON.stringify(reserveUrl)}`,
      `import { parseConfig } from ${JSON.stringify(configUrl)}`,
      `import { locateWorktree } from ${JSON.stringify(gitUrl)}`,
      `const config = parseConfig(${JSON.stringify(wtConfig)})`,
      'const loc = locateWorktree(process.cwd())',
      'const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }',
      'const r = reservePorts(loc, config, { afterWrite: () => sleep(30) })',
      "process.stdout.write(JSON.stringify({ base: r.source === 'main' ? null : r.base }))",
    ].join('\n')

    function runChild(cwd: string): Promise<{ base: number }> {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (d) => (stdout += d))
        child.stderr.on('data', (d) => (stderr += d))
        child.on('close', (code) => {
          if (code !== 0) reject(new Error(`child exited ${code}: ${stderr}`))
          else resolve(JSON.parse(stdout))
        })
        child.on('error', reject)
      })
    }

    const results = await Promise.all(worktrees.flatMap(({ path }) => [runChild(path), runChild(path), runChild(path)]))

    // Group the 9 results back into 3 worktrees of 3, in the same order they were launched above.
    const perWorktree: number[][] = worktrees.map(() => [])
    for (let i = 0; i < results.length; i++) perWorktree[Math.floor(i / 3)]!.push(results[i]!.base)

    for (let i = 0; i < perWorktree.length; i++) {
      const bases = perWorktree[i]!
      assert.ok(
        bases.every((b) => b === bases[0]),
        `worktree ${worktrees[i]!.name} split across bases: ${bases}`,
      )
    }
    const distinctBases = new Set(perWorktree.map((bases) => bases[0]))
    assert.equal(distinctBases.size, 3, `expected 3 distinct bases, got ${[...distinctBases]}`)

    for (let i = 0; i < worktrees.length; i++) {
      const loc = locateWorktree(worktrees[i]!.path)
      const onDisk = Number(readFileSync(join(loc.gitDir, 'port.txt'), 'utf8').trim())
      assert.equal(onDisk, perWorktree[i]![0])
    }
  },
)
