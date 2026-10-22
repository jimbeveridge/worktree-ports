import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotAGitWorktreeError, locateWorktree } from '../src/git.ts'
import { makeRepo } from './helpers/repo.ts'

test('main checkout: gitDir is the common dir and the name is "main"', (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const loc = locateWorktree(repo.main)
  assert.deepEqual(loc, {
    root: repo.main,
    gitDir: join(repo.main, '.git'),
    commonDir: join(repo.main, '.git'),
    isMain: true,
    name: 'main',
  })
})

test('linked worktree: gitDir is .git/worktrees/<name>', (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const wt = repo.addWorktree('feature')
  const loc = locateWorktree(wt)
  assert.deepEqual(loc, {
    root: wt,
    gitDir: join(repo.main, '.git', 'worktrees', 'feature'),
    commonDir: join(repo.main, '.git'),
    isMain: false,
    name: 'feature',
  })
})

test('a subdirectory resolves to the same worktree', (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const wt = repo.addWorktree('feature')
  const sub = join(wt, 'a', 'b')
  mkdirSync(sub, { recursive: true })
  assert.equal(locateWorktree(sub).root, wt)
})

test('outside any repository throws NotAGitWorktreeError', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-ports-nogit-')))
  assert.throws(() => locateWorktree(dir), NotAGitWorktreeError)
})

test('ignores an inherited GIT_DIR pointing at a different repository', (t) => {
  const repoA = makeRepo()
  const repoB = makeRepo()
  t.after(() => {
    repoA.cleanup()
    repoB.cleanup()
  })
  const previous = process.env.GIT_DIR
  process.env.GIT_DIR = join(repoA.main, '.git')
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = previous
  })
  const loc = locateWorktree(repoB.main)
  assert.deepEqual(loc, {
    root: repoB.main,
    gitDir: join(repoB.main, '.git'),
    commonDir: join(repoB.main, '.git'),
    isMain: true,
    name: 'main',
  })
})
