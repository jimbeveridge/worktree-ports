import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConfig } from '../src/config.ts'
import { ModeError, detectContext, isCI, readMode } from '../src/context.ts'
import { makeRepo } from './helpers/repo.ts'

const CONFIG = parseConfig({ services: { api: { offset: 0, default: 8080 } } })
const MAIN_CLAIMS = parseConfig({ services: { api: { offset: 0, default: 8080 } }, mainCheckout: 'claim' })

function noGitDir(t: { after: (fn: () => void) => void }): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'worktree-ports-nogit-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function repoWithWorktree(t: { after: (fn: () => void) => void }) {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  return { main: repo.main, wt: repo.addWorktree('feat') }
}

test('isCI: true for "true" and "1"; false for unset, "", "0" and "false"', () => {
  assert.equal(isCI({ CI: 'true' }), true)
  assert.equal(isCI({ CI: '1' }), true)
  assert.equal(isCI({}), false)
  assert.equal(isCI({ CI: '' }), false)
  assert.equal(isCI({ CI: '0' }), false)
  assert.equal(isCI({ CI: 'false' }), false)
})

test('readMode: unset is auto, each value is read, anything else is a ModeError', () => {
  assert.equal(readMode({}), 'auto')
  for (const mode of ['auto', 'default', 'claim', 'off'] as const)
    assert.equal(readMode({ WORKTREE_PORTS: mode }), mode)
  assert.throws(() => readMode({ WORKTREE_PORTS: 'bogus' }), ModeError)
})

test('a linked worktree claims', (t) => {
  const { wt } = repoWithWorktree(t)
  const ctx = detectContext(wt, {}, CONFIG)
  assert.equal(ctx.kind, 'linked-worktree')
  assert.equal(ctx.mode, 'auto')
  assert.equal(ctx.claims, true)
  assert.equal(ctx.reason, 'linked worktree')
  assert.equal(ctx.location?.root, wt)
  assert.equal(ctx.location?.isMain, false)
})

test('the main checkout uses defaults, but claims with mainCheckout: "claim"', (t) => {
  const { main } = repoWithWorktree(t)
  const ctx = detectContext(main, {}, CONFIG)
  assert.equal(ctx.kind, 'main-checkout')
  assert.equal(ctx.claims, false)
  assert.equal(ctx.location?.root, main)
  const claiming = detectContext(main, {}, MAIN_CLAIMS)
  assert.equal(claiming.kind, 'main-checkout')
  assert.equal(claiming.claims, true)
})

test('CI does not claim, in a linked worktree or the main checkout', (t) => {
  const { main, wt } = repoWithWorktree(t)
  for (const cwd of [wt, main]) {
    const ctx = detectContext(cwd, { CI: 'true' }, MAIN_CLAIMS)
    assert.equal(ctx.kind, 'ci')
    assert.equal(ctx.claims, false)
    assert.equal(ctx.reason, 'CI')
    assert.equal(ctx.location?.root, cwd)
  }
})

test('no git does not claim, and has no location', (t) => {
  const ctx = detectContext(noGitDir(t), {}, CONFIG)
  assert.equal(ctx.kind, 'no-git')
  assert.equal(ctx.claims, false)
  assert.equal(ctx.location, undefined)
})

test('WORKTREE_PORTS=default in a linked worktree does not claim', (t) => {
  const { wt } = repoWithWorktree(t)
  const ctx = detectContext(wt, { WORKTREE_PORTS: 'default' }, CONFIG)
  assert.equal(ctx.kind, 'linked-worktree')
  assert.equal(ctx.mode, 'default')
  assert.equal(ctx.claims, false)
  assert.equal(ctx.reason, 'WORKTREE_PORTS=default')
})

test('WORKTREE_PORTS=claim in CI claims', (t) => {
  const { main } = repoWithWorktree(t)
  const ctx = detectContext(main, { CI: 'true', WORKTREE_PORTS: 'claim' }, CONFIG)
  assert.equal(ctx.kind, 'ci')
  assert.equal(ctx.mode, 'claim')
  assert.equal(ctx.claims, true)
  assert.equal(ctx.reason, 'WORKTREE_PORTS=claim')
})

test('WORKTREE_PORTS=claim with no git is a ModeError', (t) => {
  assert.throws(() => detectContext(noGitDir(t), { WORKTREE_PORTS: 'claim' }, CONFIG), {
    name: 'ModeError',
    message: /needs git/,
  })
})

test('WORKTREE_PORTS=off is kind "off" and never claims', (t) => {
  const { wt } = repoWithWorktree(t)
  const ctx = detectContext(wt, { WORKTREE_PORTS: 'off' }, CONFIG)
  assert.deepEqual(ctx, { kind: 'off', mode: 'off', claims: false, reason: 'WORKTREE_PORTS=off' })
})
