import type { WorktreePortsConfig } from './config.ts'
import { NotAGitWorktreeError, locateWorktree, type WorktreeLocation } from './git.ts'

/** The `WORKTREE_PORTS` override (spec §5). */
export type Mode = 'auto' | 'default' | 'claim' | 'off'

export type ContextKind = 'linked-worktree' | 'main-checkout' | 'ci' | 'no-git' | 'off'

/** Where the tool is running and whether it claims a block there. */
export interface Context {
  kind: ContextKind
  mode: Mode
  /** True when ports come from a claimed block; false means the service `default`s (or nothing, when off). */
  claims: boolean
  /** Why: e.g. `linked worktree`, `CI`, `WORKTREE_PORTS=default`. */
  reason: string
  /** The git checkout; undefined outside git and when off. */
  location?: WorktreeLocation
}

/** An invalid `WORKTREE_PORTS` value, or `claim` where there is no git. */
export class ModeError extends Error {
  override name = 'ModeError'
}

const MODES: readonly Mode[] = ['auto', 'default', 'claim', 'off']

/** `WORKTREE_PORTS`: unset or empty means `auto`; any value other than the four modes is a `ModeError`. */
export function readMode(env: NodeJS.ProcessEnv): Mode {
  const value = env.WORKTREE_PORTS
  if (value === undefined || value === '') return 'auto'
  if ((MODES as readonly string[]).includes(value)) return value as Mode
  throw new ModeError(`WORKTREE_PORTS must be one of ${MODES.join(', ')}; got "${value}"`)
}

/** `CI` is set and is not `""`, `0` or `false`. */
export function isCI(env: NodeJS.ProcessEnv): boolean {
  const value = env.CI
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false'
}

function locate(cwd: string): WorktreeLocation | undefined {
  try {
    return locateWorktree(cwd)
  } catch (err) {
    if (err instanceof NotAGitWorktreeError) return undefined
    throw err
  }
}

/** Work out the context for `cwd` (spec §5 tables). Runs git unless the mode is `off`. */
export function detectContext(cwd: string, env: NodeJS.ProcessEnv, config: WorktreePortsConfig): Context {
  const mode = readMode(env)
  if (mode === 'off') return { kind: 'off', mode, claims: false, reason: 'WORKTREE_PORTS=off' }

  const location = locate(cwd)
  let kind: ContextKind
  if (location === undefined) kind = 'no-git'
  else if (isCI(env)) kind = 'ci'
  else kind = location.isMain ? 'main-checkout' : 'linked-worktree'
  const withLocation = (claims: boolean, reason: string): Context =>
    location === undefined ? { kind, mode, claims, reason } : { kind, mode, claims, reason, location }

  if (mode === 'default') return withLocation(false, 'WORKTREE_PORTS=default')
  if (mode === 'claim') {
    if (location === undefined) {
      throw new ModeError(`WORKTREE_PORTS=claim needs git, but ${cwd} is not inside a git worktree`)
    }
    return withLocation(true, 'WORKTREE_PORTS=claim')
  }
  switch (kind) {
    case 'no-git':
      return withLocation(false, 'no git')
    case 'ci':
      return withLocation(false, 'CI')
    case 'main-checkout':
      return config.mainCheckout === 'claim'
        ? withLocation(true, 'main checkout (mainCheckout: claim)')
        : withLocation(false, 'main checkout')
    default:
      return withLocation(true, 'linked worktree')
  }
}
