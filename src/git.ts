import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

export interface WorktreeLocation {
  /** Top-level directory of this worktree. */
  root: string
  /** This worktree's private git dir: the common dir for the main checkout, `<common>/worktrees/<name>` otherwise. */
  gitDir: string
  /** The repository's shared git dir. */
  commonDir: string
  isMain: boolean
  /** `main` for the main checkout; git's admin-dir name for a linked worktree. */
  name: string
}

export type LinkedState = 'present' | 'missing' | 'locked' | 'not-linked'

export class NotAGitWorktreeError extends Error {
  override name = 'NotAGitWorktreeError'
}

/**
 * Env for the child `git` process: never inherit a `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR`/
 * `GIT_INDEX_FILE` set by a hook or a wrapping script — otherwise `git rev-parse` reports
 * whatever repository those name instead of the one containing `cwd`.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_COMMON_DIR
  delete env.GIT_INDEX_FILE
  return env
}

/** Locate the worktree containing `cwd`. All paths are absolute and symlink-resolved. */
export function locateWorktree(cwd: string = process.cwd()): WorktreeLocation {
  let out: string
  try {
    out = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv() },
    )
  } catch (err) {
    throw new NotAGitWorktreeError(`${cwd} is not inside a git worktree: ${(err as Error).message.trim()}`)
  }
  const [root, gitDir, commonDir] = out
    .trim()
    .split('\n')
    .map((p) => realpathSync.native(p.trim()))
  if (root === undefined || gitDir === undefined || commonDir === undefined) {
    throw new NotAGitWorktreeError(`unexpected \`git rev-parse\` output: ${JSON.stringify(out)}`)
  }
  const isMain = gitDir === commonDir
  return { root, gitDir, commonDir, isMain, name: isMain ? 'main' : basename(gitDir) }
}

/**
 * How git sees the linked worktree whose private git dir (admin dir) is `gitDir`:
 * - `not-linked`: `gitDir` is not a linked worktree's admin dir (a main checkout's `.git`, or gone);
 * - `locked`: `git worktree lock` was run on it, so it must be treated as present whatever the disk says;
 * - `missing`: the admin dir is there but the worktree folder it points at has gone;
 * - `present`: the worktree folder exists.
 *
 * It makes the same check `git worktree prune` does: the admin dir's `gitdir` file holds the path of the
 * worktree's `.git` file. It only reads the admin dir and never changes it.
 */
export function linkedWorktreeState(gitDir: string): LinkedState {
  let pointer: string
  try {
    pointer = readFileSync(join(gitDir, 'gitdir'), 'utf8').trim()
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'not-linked'
    throw err
  }
  if (pathExists(join(gitDir, 'locked'))) return 'locked'
  // git may write the pointer relative to the admin dir (`worktree.useRelativePaths`).
  return pathExists(resolve(gitDir, pointer)) ? 'present' : 'missing'
}

/** True unless the path is definitely absent. An error other than "not found" (e.g. EACCES) counts as present. */
export function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code !== 'ENOENT' && code !== 'ENOTDIR'
  }
}
