import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { usesMainPorts, type PortRange, type WorktreePortsConfig } from './config.ts'
import type { WorktreeLocation } from './git.ts'

export type Reservation = { source: 'main' } | { source: 'existing' | 'allocated'; base: number }

export interface SiblingReservation {
  gitDir: string
  base: number
}

export interface ReserveHooks {
  /** Candidate picker, `[0, 1)`. Defaults to `Math.random`. */
  random?: () => number
  /** Test seam: runs after our file is written and before we scan for clashes. */
  afterWrite?: (candidate: number) => void
  maxAttempts?: number
  /**
   * How long to wait for the claim lock before giving up. Default 15000ms.
   * Must exceed `staleLockMs` so a waiter always outlives an abandoned lock
   * and breaks it, rather than timing out first — a claim takes milliseconds,
   * so a lock as old as `staleLockMs` is dead, not merely slow.
   */
  lockTimeoutMs?: number
  /** How old an unreleased lock must be before we treat it as abandoned and break it. Default 10000ms. */
  staleLockMs?: number
}

export function reservationPath(loc: WorktreeLocation, config: WorktreePortsConfig): string {
  return join(loc.gitDir, config.fileName)
}

export function isValidBase(n: number, range: PortRange): boolean {
  return Number.isInteger(n) && n >= range.min && n <= range.max && (n - range.min) % range.step === 0
}

function readBase(path: string, range: PortRange): number | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8').trim()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  if (!/^\d+$/.test(text)) return undefined
  const n = Number(text)
  return isValidBase(n, range) ? n : undefined
}

/** Every OTHER worktree's valid reservation: the main checkout's plus each `worktrees/<name>/`. */
export function readSiblingReservations(loc: WorktreeLocation, config: WorktreePortsConfig): SiblingReservation[] {
  const dirs = [loc.commonDir]
  const worktreesDir = join(loc.commonDir, 'worktrees')
  try {
    for (const entry of readdirSync(worktreesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(worktreesDir, entry.name))
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const out: SiblingReservation[] = []
  for (const dir of dirs) {
    if (dir === loc.gitDir) continue
    const base = readBase(join(dir, config.fileName), config.range)
    if (base !== undefined) out.push({ gitDir: dir, base })
  }
  return out
}

/** Readers never observe a half-written file: write beside it, then rename over it. */
function writeAtomically(path: string, base: number): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${base}\n`)
  renameSync(tmp, path)
}

const LOCK_POLL_MS = 25

/**
 * Acquire the repo-wide claim lock: a directory at `<commonDir>/<fileName>.lock`
 * (`mkdirSync` is atomic even on network filesystems). Returns the lock path;
 * the caller MUST release it with `releaseLock` in a `finally`.
 *
 * Why a lock, given the write→scan→yield protocol already handles two claimers
 * racing for one block: that protocol only works BETWEEN worktrees, because
 * `readSiblingReservations` always excludes the caller's own `gitDir` — a
 * process can never see another writer racing it for the SAME worktree's file.
 * Two processes in one worktree (e.g. two dev scripts started together) would
 * each read "no reservation yet", pick different candidates, and each write
 * its own candidate over the other's — both would then "win" a different
 * block while only one is recorded on disk. The lock serializes every claim,
 * across every worktree and every process, so at most one `reservePorts` body
 * ever runs at a time for a given repo. The write→scan→yield loop and the
 * settled-clash tie-break stay in place inside the lock as a backstop for
 * files written by something other than a locked `reservePorts` call (a hand
 * edit, or a lock broken as stale while its holder was still mid-claim).
 */
function acquireLock(loc: WorktreeLocation, config: WorktreePortsConfig, hooks: ReserveHooks): string {
  const lockPath = join(loc.commonDir, `${config.fileName}.lock`)
  const staleLockMs = hooks.staleLockMs ?? 10_000
  const lockTimeoutMs = hooks.lockTimeoutMs ?? 15_000
  const start = Date.now()
  for (;;) {
    try {
      mkdirSync(lockPath)
      return lockPath
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }

    let mtimeMs: number
    try {
      mtimeMs = statSync(lockPath).mtimeMs
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue // released between our mkdir and stat; retry
      throw err
    }

    if (Date.now() - mtimeMs > staleLockMs) {
      // Re-stat immediately before removing and re-check mtime from THIS read
      // (not the outer one): don't clobber a lock someone just took between
      // our first stat and now. Only break it if it's still stale; otherwise
      // loop and retry rather than removing a lock that's alive again.
      let recheckMtimeMs: number
      try {
        recheckMtimeMs = statSync(lockPath).mtimeMs
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw err
      }
      if (Date.now() - recheckMtimeMs > staleLockMs) {
        rmSync(lockPath, { recursive: true, force: true })
      }
      continue
    }

    if (Date.now() - start > lockTimeoutMs) {
      throw new Error(
        `timed out after ${lockTimeoutMs}ms waiting for ${lockPath}; ` +
          'if no other worktree-ports process is running, delete it',
      )
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS)
  }
}

function releaseLock(lockPath: string): void {
  rmSync(lockPath, { recursive: true, force: true })
}

/**
 * Reserve this worktree's port block. Runs entirely under the repo-wide claim
 * lock (see `acquireLock`); see there for why the lock is needed even though a
 * write→scan→yield protocol is also in place.
 *
 * Safety argument for the claim loop: every claimer writes its own file BEFORE
 * it scans. So for two claimers of one block, whichever scans second sees the
 * other's file — at least one of them always detects the clash. A fresh claim
 * therefore ALWAYS yields on a clash; it never "wins", because the other side
 * may already have scanned clean and returned.
 */
export function reservePorts(
  loc: WorktreeLocation,
  config: WorktreePortsConfig,
  hooks: ReserveHooks = {},
): Reservation {
  if (loc.isMain && usesMainPorts(config)) return { source: 'main' }

  const lockPath = acquireLock(loc, config, hooks)
  try {
    return claimLocked(loc, config, hooks)
  } finally {
    releaseLock(lockPath)
  }
}

function claimLocked(loc: WorktreeLocation, config: WorktreePortsConfig, hooks: ReserveHooks): Reservation {
  const { range } = config
  const own = reservationPath(loc, config)
  const existing = readBase(own, range)
  if (existing !== undefined) {
    const clashes = readSiblingReservations(loc, config).filter((s) => s.base === existing)
    // Two SETTLED reservations share a block (a copied or hand-edited file). Exactly one must move,
    // and both sides must agree which without coordinating: the git dir that sorts later moves.
    if (clashes.every((s) => s.gitDir > loc.gitDir)) return { source: 'existing', base: existing }
  }

  const random = hooks.random ?? Math.random
  const maxAttempts = hooks.maxAttempts ?? 20
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const taken = new Set(readSiblingReservations(loc, config).map((s) => s.base))
    const free: number[] = []
    for (let base = range.min; base <= range.max; base += range.step) if (!taken.has(base)) free.push(base)
    if (free.length === 0) {
      rmSync(own, { force: true }) // never leave a stale/clashing file of ours behind on failure
      throw new Error(
        `no free port block in ${range.min}..${range.max} (step ${range.step}); ` +
          'free stale reservations with `git worktree prune`',
      )
    }
    const candidate = free[Math.min(free.length - 1, Math.floor(random() * free.length))]!
    writeAtomically(own, candidate)
    hooks.afterWrite?.(candidate)
    if (!readSiblingReservations(loc, config).some((s) => s.base === candidate)) {
      return { source: 'allocated', base: candidate }
    }
    rmSync(own, { force: true }) // yielding: don't leave our clashing candidate on disk for the next attempt
  }
  rmSync(own, { force: true })
  throw new Error(`could not claim a port block after ${maxAttempts} attempts`)
}
