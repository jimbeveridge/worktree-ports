import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { testStateDir } from './setup.ts'

test('the test run is isolated from the real environment', () => {
  const env = process.env
  for (const name of ['CI', 'WORKTREE_PORTS', 'GIT_DIR', 'GIT_WORK_TREE']) {
    assert.equal(env[name], undefined, `${name} must be unset`)
  }
  const tmp = realpathSync.native(tmpdir())
  for (const name of ['WORKTREE_PORTS_STATE_DIR', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'APPDATA', 'LOCALAPPDATA']) {
    assert.ok(env[name]?.startsWith(tmp), `${name} must be under ${tmp}, got ${env[name]}`)
  }
  assert.equal(env.WORKTREE_PORTS_UNDER_TEST, '1')
  for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
    assert.ok(env[name], `${name} must be set`)
  }
  assert.equal(testStateDir(), env.WORKTREE_PORTS_STATE_DIR)
})
