import { mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export interface LockOptions {
  /** How long to wait for a held lock before giving up. Default 15 s. */
  lockTimeoutMs?: number
  /** A lock untouched for this long was left by a dead process and is broken. Default 10 s. */
  staleLockMs?: number
}

export const DEFAULT_LOCK_TIMEOUT_MS = 15_000
export const DEFAULT_STALE_LOCK_MS = 10_000
const POLL_MS = 25

export class LockTimeoutError extends Error {
  override name = 'LockTimeoutError'
  readonly lockPath: string
  constructor(lockPath: string, waitedMs: number) {
    super(
      `timed out after ${waitedMs} ms waiting for the registry lock ${lockPath}. ` +
        `If no worktree-ports process is running, remove that directory.`,
    )
    this.lockPath = lockPath
  }
}

interface LockId {
  ino: number
  dev: number
  mtimeMs: number
}

/**
 * Identity of a lock dir, so we never remove a lock that another process created after ours went away.
 * The mtime is part of it because a freed inode number is often reused at once; nothing writes inside
 * the lock dir, so its mtime stays its creation time.
 */
function lockId(path: string): LockId | undefined {
  try {
    const st = statSync(path)
    return { ino: st.ino, dev: st.dev, mtimeMs: st.mtimeMs }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

function sameLock(a: LockId | undefined, b: LockId | undefined): boolean {
  return a !== undefined && b !== undefined && a.ino === b.ino && a.dev === b.dev && a.mtimeMs === b.mtimeMs
}

/**
 * Runs `fn` while holding the machine-wide registry lock: an atomic `mkdir` of `<stateDir>/lock`.
 * A held lock is polled every 25 ms until `lockTimeoutMs`; one older than `staleLockMs` is broken.
 */
export async function withLock<T>(stateDir: string, fn: () => T | Promise<T>, opts: LockOptions = {}): Promise<T> {
  const timeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const staleMs = opts.staleLockMs ?? DEFAULT_STALE_LOCK_MS
  const lockPath = join(stateDir, 'lock')
  mkdirSync(stateDir, { recursive: true })
  const start = Date.now()
  let mine: LockId | undefined
  for (;;) {
    try {
      mkdirSync(lockPath)
      mine = lockId(lockPath)
      if (mine !== undefined) break
      continue // broken by another process the instant we made it: start over
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const held = lockId(lockPath)
    if (held === undefined) continue // released between our mkdir and stat: try again at once
    if (Date.now() - held.mtimeMs > staleMs) {
      // Re-check just before breaking it, so a lock that a faster waiter has already broken and retaken is
      // left alone. A narrow race remains; the claim backstop scan (spec §7c) covers it.
      if (sameLock(lockId(lockPath), held)) {
        rmSync(lockPath, { recursive: true, force: true })
      }
      continue
    }
    const waited = Date.now() - start
    if (waited >= timeoutMs) throw new LockTimeoutError(lockPath, waited)
    await sleep(Math.min(POLL_MS, timeoutMs - waited))
  }
  try {
    return await fn()
  } finally {
    // Only remove the lock if it is still ours: if we overran staleLockMs, another process may hold it now.
    if (sameLock(lockId(lockPath), mine)) {
      rmSync(lockPath, { recursive: true, force: true })
    }
  }
}
