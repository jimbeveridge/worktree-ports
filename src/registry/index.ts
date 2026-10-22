import { type Settings, type PortRange, loadSettings, stateDir as defaultStateDir } from '../settings.ts'
import { type PruneOptions, type Removal, type StaleReason, pruneCandidates, staleReason } from './cleanup.ts'
import { type LockOptions, withLock } from './lock.ts'
import { type Claim, deleteClaim, localDate, readAllClaims } from './store.ts'

export { LockTimeoutError, withLock } from './lock.ts'
export type { LockOptions } from './lock.ts'
export { claimsDir, deleteClaim, inRange, localDate, readAllClaims, readClaims, writeClaim } from './store.ts'
export type { Claim } from './store.ts'
export { RegistryFullError, claimBlock, lookupClaim } from './claim.ts'
export type { ClaimHooks, ClaimOwner, ClaimResult } from './claim.ts'
export { collectStale, parseDuration, pruneCandidates, staleReason } from './cleanup.ts'
export type { PruneOptions, Removal, StaleReason } from './cleanup.ts'

export interface ListedClaim extends Claim {
  stale?: StaleReason
}

export interface Registry {
  readonly stateDir: string
  readonly range: PortRange
  readonly lock: LockOptions
  /** Every claim on the machine, across all repositories and ranges, by base; marks stale ones. Lock-free. */
  list(): ListedClaim[]
  /** Deletes the owner's claim under the lock and returns it, or undefined when it has none. */
  release(owner: { gitDir: string; config: string }): Promise<Claim | undefined>
  /** Manual cleanup (spec §7d) under the lock; returns what it removed, or would remove with `dryRun`. */
  prune(opts?: PruneOptions): Promise<Removal[]>
}

/** The machine-wide registry. Defaults: the state dir and range from the environment and settings file. */
export function openRegistry(opts: { stateDir?: string; settings?: Settings; lock?: LockOptions } = {}): Registry {
  const dir = opts.stateDir ?? defaultStateDir()
  const range = { ...(opts.settings ?? loadSettings()).range }
  const lock = { ...opts.lock }
  return {
    stateDir: dir,
    range,
    lock,
    list() {
      return readAllClaims(dir).map((claim) => {
        const stale = staleReason(claim, { checkConfig: true })
        return stale === undefined ? { ...claim } : { ...claim, stale }
      })
    },
    release(owner) {
      return withLock(
        dir,
        () => {
          let released: Claim | undefined
          for (const claim of readAllClaims(dir)) {
            if (claim.gitDir !== owner.gitDir || claim.config !== owner.config) continue
            deleteClaim(dir, claim.base)
            released ??= claim
          }
          return released
        },
        lock,
      )
    },
    prune(pruneOpts = {}) {
      return withLock(
        dir,
        () => {
          const removals = pruneCandidates(readAllClaims(dir), { ...pruneOpts, today: pruneOpts.today ?? localDate() })
          if (!pruneOpts.dryRun) for (const { claim } of removals) deleteClaim(dir, claim.base)
          return removals
        },
        lock,
      )
    },
  }
}
