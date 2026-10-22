import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TempRepo {
  /** realpath of the temp directory holding the repo and its worktrees */
  dir: string
  /** the main checkout */
  main: string
  addWorktree(name: string): string
  removeWorktree(path: string): void
  cleanup(): void
}

/** Env for child git processes: never inherit a GIT_DIR/GIT_WORK_TREE from a hook. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_COMMON_DIR
  return env
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'core.autocrlf=false',
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv() },
  )
}

export function makeRepo(): TempRepo {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'worktree-ports-')))
  const main = join(dir, 'main')
  git(dir, 'init', '-q', '-b', 'main', main)
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init')
  return {
    dir,
    main,
    addWorktree(name) {
      const path = join(dir, name)
      git(main, 'worktree', 'add', '-q', '-b', name, path)
      return path
    },
    removeWorktree(path) {
      git(main, 'worktree', 'remove', '--force', path)
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
