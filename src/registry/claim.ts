import { settingsPath } from '../settings.ts'
import { isListening as probeListening } from '../status.ts'
import { collectStale } from './cleanup.ts'
import type { Registry } from './index.ts'
import { withLock } from './lock.ts'
import { type Claim, deleteClaim, inRange, localDate, readAllClaims, writeClaim } from './store.ts'

/** Who a claim belongs to: the pair (`gitDir`, `config`). `root` is recorded for `list` output only. */
export interface ClaimOwner {
  gitDir: string
  root: string
  config: string
}

/** Test seams. Production code passes none. */
export interface ClaimHooks {
  /** Picks among free candidates; `() => 0` takes the lowest. Default `Math.random`. */
  random?: () => number
  /** Runs after our claim file is written, before the backstop scan. */
  afterWrite?: (claim: Claim) => void | Promise<void>
  /** Is anything listening on this loopback port? Default: a TCP probe of `127.0.0.1` and `::1`. */
  isListening?: (port: number) => Promise<boolean>
  /** Local date, `YYYY-MM-DD`. Default: `now()`'s local date. */
  today?: () => string
  now?: () => Date
  /** Claim attempts before giving up when the backstop keeps finding overlaps. Default 50. */
  maxAttempts?: number
}

export type ClaimResult = { claim: Claim; source: 'existing' | 'allocated' }

/** No free block is left in the range after cleanup (spec §7d). */
export class RegistryFullError extends Error {
  override name = 'RegistryFullError'
  /** Every claim in the registry, oldest `lastUsed` first. */
  readonly claims: Claim[]
  constructor(message: string, claims: Claim[]) {
    super(message)
    this.claims = claims
  }
}

const DEFAULT_MAX_ATTEMPTS = 50
/** Loopback probes get a refusal at once; a short timeout keeps the work inside the lock far below staleLockMs. */
const PROBE_TIMEOUT_MS = 250

function isOwner(claim: Claim, owner: ClaimOwner): boolean {
  return claim.gitDir === owner.gitDir && claim.config === owner.config
}

function overlaps(a: Claim | { base: number; size: number }, b: { base: number; size: number }): boolean {
  return a.base < b.base + b.size && b.base < a.base + a.size
}

/** Settled-overlap order (spec §7c 2.7): the claim that sorts earlier keeps its block. Plain code-unit order. */
function sortsBefore(a: Claim, b: Claim): boolean {
  if (a.gitDir !== b.gitDir) return a.gitDir < b.gitDir
  return a.config < b.config
}

function checkSize(size: number): void {
  if (!Number.isInteger(size) || size < 10 || size % 10 !== 0) {
    throw new Error(`block size must be a positive multiple of 10, got ${size}`)
  }
}

/** The owner's claim in `claims` that is still good for `size`, or undefined. Pure. */
function findValid(claims: readonly Claim[], registry: Registry, owner: ClaimOwner, size: number): Claim | undefined {
  return claims.find(
    (c) =>
      isOwner(c, owner) &&
      inRange(c, registry.range) &&
      c.size >= size &&
      // A settled overlap: the claim that sorts later yields, so both owners agree without coordinating.
      !claims.some((o) => !isOwner(o, owner) && overlaps(c, o) && sortsBefore(o, c)),
  )
}

/**
 * Lock-free lookup (spec §7c step 1): the owner's claim if it is inside the registry's range, at least `size`
 * long, and doesn't overlap a claim that sorts earlier. Never writes.
 */
export function lookupClaim(registry: Registry, owner: ClaimOwner, size: number): Claim | undefined {
  return findValid(readAllClaims(registry.stateDir), registry, owner, size)
}

/** `[0, n)` in the order `random` picks them: each pick removes one of the remaining values. */
function* randomOrder(n: number, random: () => number): Generator<number> {
  const rest = Array.from({ length: n }, (_, i) => i)
  while (rest.length > 0) {
    const r = random()
    const i = Math.min(rest.length - 1, Math.max(0, Math.floor(r * rest.length)))
    yield rest.splice(i, 1)[0]!
  }
}

async function anyListening(ports: number[], isListening: (port: number) => Promise<boolean>): Promise<boolean> {
  const results = await Promise.all(ports.map((p) => isListening(p)))
  return results.some(Boolean)
}

function fullError(claims: Claim[], size: number, registry: Registry, busy: number): RegistryFullError {
  const sorted = [...claims].sort((a, b) =>
    a.lastUsed === b.lastUsed ? a.base - b.base : a.lastUsed < b.lastUsed ? -1 : 1,
  )
  const { min, max } = registry.range
  let settings: string
  try {
    settings = settingsPath()
  } catch {
    settings = 'the worktree-ports settings file'
  }
  const lines = [`no free block of ${size} ports is left in the range ${min}-${max}.`]
  if (busy > 0) lines.push(`${busy} free block(s) were skipped because something is listening on them.`)
  if (sorted.length > 0) {
    lines.push('Claims, oldest last use first:')
    for (const c of sorted) lines.push(`  ${c.base}  size ${c.size}  last used ${c.lastUsed}  ${c.root}`)
  }
  lines.push(
    'Free blocks with `worktree-ports prune --unused-for 30d`, or run `worktree-ports release` in a worktree ' +
      "you're done with.",
    `To widen the range, edit "range" in ${settings}.`,
  )
  return new RegistryFullError(lines.join('\n'), sorted)
}

/**
 * The owner's block of `size` ports (spec §7c): the existing claim when it is still good, otherwise a new
 * one claimed under the machine-wide lock. Throws `RegistryFullError` when the range has no free block.
 */
export async function claimBlock(
  owner: ClaimOwner,
  size: number,
  registry: Registry,
  hooks: ClaimHooks = {},
): Promise<ClaimResult> {
  checkSize(size)
  const now = hooks.now ?? (() => new Date())
  const today = hooks.today?.() ?? localDate(now())
  const random = hooks.random ?? Math.random
  const isListening = hooks.isListening ?? ((port: number) => probeListening(port, PROBE_TIMEOUT_MS))
  const maxAttempts = hooks.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const dir = registry.stateDir

  // 1. Lock-free lookup. Only a stale lastUsed sends a valid claim through the lock, at most once a day.
  const found = lookupClaim(registry, owner, size)
  if (found !== undefined && found.lastUsed >= today) return { claim: found, source: 'existing' }

  return withLock(
    dir,
    async (): Promise<ClaimResult> => {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // 2.1 Re-run the lookup: another process may have just claimed for this same checkout.
        const again = lookupClaim(registry, owner, size)
        if (again !== undefined) {
          if (again.lastUsed >= today) return { claim: again, source: 'existing' }
          const touched = { ...again, lastUsed: today }
          writeClaim(dir, touched)
          return { claim: touched, source: 'existing' }
        }

        // 2.2 Garbage-collect stale claims.
        collectStale(dir)
        const all = readAllClaims(dir)
        const own = all.filter((c) => isOwner(c, owner))
        const others = all.filter((c) => !isOwner(c, owner))

        // 2.3 / 2.4 Candidates: aligned blocks that overlap no other claim. Our own claims don't count, as they
        // are released once a new block is chosen; the same base at the new size is tried first.
        const { min, max } = registry.range
        const candidates: number[] = []
        for (let base = min; base + size - 1 <= max; base += 10) {
          const block = { base, size }
          if (!others.some((o) => overlaps(o, block))) candidates.push(base)
        }
        const previous = own.find((c) => inRange(c, registry.range) && candidates.includes(c.base))
        const order: number[] = previous === undefined ? [] : [previous.base]
        for (const i of randomOrder(candidates.length, random)) {
          if (candidates[i] !== previous?.base) order.push(candidates[i]!)
        }

        // 2.5 Probe every port of a candidate and skip it if anything listens. For our previous base, only
        // the ports it gains: our own servers may well be running on the old ones.
        let chosen: number | undefined
        let busy = 0
        for (const base of order) {
          const ports: number[] = []
          for (let p = base; p < base + size; p++) {
            if (previous !== undefined && base === previous.base && p < previous.base + previous.size) continue
            ports.push(p)
          }
          if (ports.length > 0 && (await anyListening(ports, isListening))) {
            busy++
            continue
          }
          chosen = base
          break
        }
        if (chosen === undefined) throw fullError(all, size, registry, busy)

        // Release every claim of ours that is too small, out of range or overlapped, then write the new one.
        for (const c of own) if (c.base !== chosen) deleteClaim(dir, c.base)
        const claim: Claim = {
          base: chosen,
          size,
          gitDir: owner.gitDir,
          root: owner.root,
          config: owner.config,
          claimedAt: now().toISOString(),
          lastUsed: today,
        }
        // 2.6 Atomic write.
        writeClaim(dir, claim)
        await hooks.afterWrite?.(claim)

        // 2.7 Backstop scan: a claim written outside the lock may overlap ours. A fresh claim always yields.
        const after = readAllClaims(dir)
        const clash = after.some((c) => !isOwner(c, owner) && overlaps(c, claim))
        if (!clash) return { claim, source: 'allocated' }
        // Delete our file only if it still names us: a writer outside the lock may have replaced it.
        if (after.some((c) => c.base === claim.base && isOwner(c, owner))) deleteClaim(dir, claim.base)
      }
      throw new Error(
        `could not claim a block of ${size} ports after ${maxAttempts} attempts: ` +
          `claim files written outside the registry lock kept overlapping ours (${dir})`,
      )
    },
    registry.lock,
  )
}
