// Preloaded by every test run (`node --test --import ./test/setup.ts`). It isolates the tests from the
// developer's machine and from CI: no real registry, settings or git identity is ever touched.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MIN_GIT = [2, 31]

function checkGit(): void {
  let out = ''
  try {
    out = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()
  } catch (err) {
    throw new Error(`worktree-ports tests need git >= ${MIN_GIT.join('.')}, but running git failed: ${err}`)
  }
  const m = /(\d+)\.(\d+)/.exec(out)
  const major = Number(m?.[1])
  const minor = Number(m?.[2])
  if (!m || major < MIN_GIT[0]! || (major === MIN_GIT[0] && minor < MIN_GIT[1]!)) {
    throw new Error(`worktree-ports tests need git >= ${MIN_GIT.join('.')}, found "${out}"`)
  }
}

checkGit()

const root = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), 'worktree-ports-test-')))
const dirs = {
  state: join(root, 'state'),
  xdgState: join(root, 'xdg-state'),
  xdgConfig: join(root, 'xdg-config'),
  appdata: join(root, 'appdata'),
  localappdata: join(root, 'localappdata'),
}
for (const dir of Object.values(dirs)) mkdirSync(dir)

const env = process.env
env.WORKTREE_PORTS_STATE_DIR = dirs.state
env.XDG_STATE_HOME = dirs.xdgState
env.XDG_CONFIG_HOME = dirs.xdgConfig
env.APPDATA = dirs.appdata
env.LOCALAPPDATA = dirs.localappdata
for (const name of ['CI', 'WORKTREE_PORTS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) {
  delete env[name]
}
env.GIT_AUTHOR_NAME = 'test'
env.GIT_AUTHOR_EMAIL = 'test@example.com'
env.GIT_COMMITTER_NAME = 'test'
env.GIT_COMMITTER_EMAIL = 'test@example.com'
env.WORKTREE_PORTS_UNDER_TEST = '1'

process.on('exit', () => {
  rmSync(root, { recursive: true, force: true })
})

/** This test file's (process's) temp state dir. */
export function testStateDir(): string {
  return dirs.state
}
