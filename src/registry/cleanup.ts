import { resolve } from 'node:path'
import { linkedWorktreeState, pathExists } from '../git.ts'
import { type Claim, deleteClaim, readAllClaims } from './store.ts'

export type StaleReason = 'git-dir-gone' | 'worktree-gone' | 'config-gone'

/**
 * Why a claim's owner is gone (spec §7d), or undefined if it may still be in use:
 * 1. its git dir no longer exists → `git-dir-gone`;
 * 2. it is a linked worktree whose folder has gone → `worktree-gone`, unless git has it `locked`, which
 *    always means "keep";
 * 3. only with `checkConfig` (manual `prune`, `list`): its config file has gone → `config-gone`.
 * Anything it can't decide (a permissions error, say) counts as in use: a wrong "stale" destroys stable ports.
 */
export function staleReason(claim: Claim, opts: { checkConfig: boolean }): StaleReason | undefined {
  if (!pathExists(claim.gitDir)) return 'git-dir-gone'
  let state: ReturnType<typeof linkedWorktreeState>
  try {
    state = linkedWorktreeState(claim.gitDir)
  } catch {
    return undefined
  }
  if (state === 'locked') return undefined
  if (state === 'missing') return 'worktree-gone'
  // An absolute `config` (one outside the root) resolves to itself.
  if (opts.checkConfig && !pathExists(resolve(claim.root, claim.config))) return 'config-gone'
  return undefined
}

/**
 * Automatic cleanup, run on every claim: deletes every claim whose git dir or worktree has gone, whatever
 * the range, and returns them. A claim whose config has gone is kept. The caller must hold the lock.
 */
export function collectStale(stateDir: string): Claim[] {
  const removed: Claim[] = []
  for (const claim of readAllClaims(stateDir)) {
    if (staleReason(claim, { checkConfig: false }) === undefined) continue
    deleteClaim(stateDir, claim.base)
    removed.push(claim)
  }
  return removed
}

/** A `prune --unused-for` duration in days: `<n>d` or `<n>w`, n a positive integer. `'90d'` → 90, `'12w'` → 84. */
export function parseDuration(text: string): number {
  const m = /^([1-9][0-9]*)([dw])$/.exec(text)
  if (!m)
    throw new Error(`invalid duration "${text}": expected a positive whole number of days or weeks, like 90d or 12w`)
  const n = Number(m[1])
  return m[2] === 'w' ? n * 7 : n
}

export interface PruneOptions {
  /** Also remove claims whose `lastUsed` is more than this many days before `today`. */
  unusedForDays?: number
  /** Report what would be removed without removing anything. */
  dryRun?: boolean
  /** `YYYY-MM-DD`; defaults to the local date. */
  today?: string
}

export interface Removal {
  claim: Claim
  reason: StaleReason | 'unused'
}

function dayNumber(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) throw new Error(`invalid date "${date}": expected YYYY-MM-DD`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000
}

/** What `prune` removes from `claims`: stale ones (config check included), then unused ones. Pure. */
export function pruneCandidates(claims: readonly Claim[], opts: PruneOptions & { today: string }): Removal[] {
  const { unusedForDays } = opts
  if (unusedForDays !== undefined && !(Number.isInteger(unusedForDays) && unusedForDays > 0)) {
    throw new Error(`unusedForDays must be a positive integer, got ${unusedForDays}`)
  }
  const today = dayNumber(opts.today)
  const removals: Removal[] = []
  for (const claim of claims) {
    const stale = staleReason(claim, { checkConfig: true })
    if (stale !== undefined) removals.push({ claim, reason: stale })
    else if (unusedForDays !== undefined && today - dayNumber(claim.lastUsed) > unusedForDays) {
      removals.push({ claim, reason: 'unused' })
    }
  }
  return removals
}
