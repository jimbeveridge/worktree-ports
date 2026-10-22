import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathExists } from './git.ts'
import type { PortRange } from './settings.ts'

/** File name `findConfig` looks for. */
export const CONFIG_FILE_NAME = 'worktree-ports.json'
export const BUILTIN_TOKENS = ['root', 'name', 'home'] as const

export interface ServiceSpec {
  /** Port = claimed block base + offset. */
  offset: number
  /** Port used by every context that does not claim (see the spec, section 5). */
  default: number
}

export interface VerifySpec {
  /** URL template, e.g. `http://127.0.0.1:{api}/__worktree`. */
  url: string
  /** Top-level JSON field of the response that names the owning worktree. */
  field: string
  /** Template the field must equal, normally `{root}`. */
  expect: string
}

export type MainCheckoutMode = 'default' | 'claim'

export interface WorktreePortsConfig {
  services: Record<string, ServiceSpec>
  mainCheckout: MainCheckoutMode
  /** Environment variable templates rendered for `exec` / `env`. */
  env: Record<string, string>
  verify?: VerifySpec
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

const SERVICE_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/
/**
 * A config's `env` names must start with `WORKTREE_`. No runtime, shell or tool gives such a name a meaning of its
 * own, so a config from an untrusted checkout can't set `NODE_OPTIONS`, `LD_PRELOAD`, `PATH`, `PS1` or the like and
 * turn `exec`, or an `eval` of `env`, into code execution. `WORKTREE_PORTS…` is the tool's own and stays reserved.
 * `PORT` comes from `exec --port` instead. schema.json states the same rule without the lookahead.
 */
export const ENV_NAME = /^WORKTREE_(?!PORTS)[A-Z0-9_]+$/

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function int(v: unknown, what: string, source: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ConfigError(`${source}: ${what} must be an integer`)
  return v
}

function nonEmpty(v: unknown, what: string, source: string): string {
  if (typeof v !== 'string' || v === '') throw new ConfigError(`${source}: ${what} must be a non-empty string`)
  return v
}

/** The `{token}` names a template references, in order. */
export function templateTokens(template: string): string[] {
  return [...template.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1] ?? '')
}

const TOP_FIELDS = ['$schema', 'services', 'mainCheckout', 'env', 'verify'] as const
const SERVICE_FIELDS = ['offset', 'default'] as const

function rejectUnknown(obj: Record<string, unknown>, allowed: readonly string[], where: string, source: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(`${source}: unknown field "${where}${key}"; allowed: ${allowed.join(', ')}`)
    }
  }
}

export function parseConfig(raw: unknown, source: string = CONFIG_FILE_NAME): WorktreePortsConfig {
  if (!isRecord(raw)) throw new ConfigError(`${source}: expected a JSON object`)
  rejectUnknown(raw, TOP_FIELDS, '', source)

  if (!isRecord(raw.services) || Object.keys(raw.services).length === 0) {
    throw new ConfigError(`${source}: services must be an object with at least one service`)
  }
  const services: Record<string, ServiceSpec> = {}
  const offsets = new Map<number, string>()
  for (const [name, spec] of Object.entries(raw.services)) {
    if (!SERVICE_NAME.test(name)) throw new ConfigError(`${source}: service name "${name}" must match ${SERVICE_NAME}`)
    if ((BUILTIN_TOKENS as readonly string[]).includes(name)) {
      throw new ConfigError(`${source}: service name "${name}" is reserved`)
    }
    if (!isRecord(spec)) throw new ConfigError(`${source}: services.${name} must be an object`)
    rejectUnknown(spec, SERVICE_FIELDS, `services.${name}.`, source)
    const offset = int(spec.offset, `services.${name}.offset`, source)
    if (offset < 0) throw new ConfigError(`${source}: services.${name}.offset must be >= 0`)
    const other = offsets.get(offset)
    if (other !== undefined) {
      throw new ConfigError(`${source}: services.${name}.offset ${offset} is already used by service "${other}"`)
    }
    offsets.set(offset, name)
    if (spec.default === undefined) throw new ConfigError(`${source}: services.${name}.default is required`)
    const def = int(spec.default, `services.${name}.default`, source)
    if (def < 1 || def > 65535) throw new ConfigError(`${source}: services.${name}.default must be 1..65535`)
    services[name] = { offset, default: def }
  }

  let mainCheckout: MainCheckoutMode = 'default'
  if (raw.mainCheckout !== undefined) {
    if (raw.mainCheckout !== 'default' && raw.mainCheckout !== 'claim') {
      throw new ConfigError(`${source}: mainCheckout must be "default" or "claim"`)
    }
    mainCheckout = raw.mainCheckout
  }

  if (raw.$schema !== undefined && typeof raw.$schema !== 'string') {
    throw new ConfigError(`${source}: $schema must be a string`)
  }

  const known = new Set<string>([...BUILTIN_TOKENS, ...Object.keys(services)])
  const checkTemplate = (template: string, where: string): void => {
    for (const token of templateTokens(template)) {
      if (!known.has(token)) {
        const list = [...known].map((k) => `{${k}}`).join(', ')
        throw new ConfigError(`${source}: ${where} uses unknown token {${token}}; known tokens: ${list}`)
      }
    }
  }

  const env: Record<string, string> = {}
  if (raw.env !== undefined) {
    if (!isRecord(raw.env)) throw new ConfigError(`${source}: env must be an object`)
    for (const [key, value] of Object.entries(raw.env)) {
      // `env` prints `export KEY=...` for `eval`, so a key must be a plain shell variable name.
      if (!ENV_NAME.test(key)) {
        const hint = key === 'PORT' ? '; set PORT with `exec --port <service>`' : ''
        throw new ConfigError(
          `${source}: env name "${key}" must start with WORKTREE_ (not WORKTREE_PORTS) and use only A-Z, 0-9 and _${hint}`,
        )
      }
      if (typeof value !== 'string') throw new ConfigError(`${source}: env.${key} must be a string`)
      checkTemplate(value, `env.${key}`)
      env[key] = value
    }
  }

  const config: WorktreePortsConfig = { services, mainCheckout, env }
  if (raw.verify !== undefined) {
    if (!isRecord(raw.verify)) throw new ConfigError(`${source}: verify must be an object`)
    rejectUnknown(raw.verify, ['url', 'field', 'expect'], 'verify.', source)
    const verify: VerifySpec = {
      url: nonEmpty(raw.verify.url, 'verify.url', source),
      field: nonEmpty(raw.verify.field, 'verify.field', source),
      expect: nonEmpty(raw.verify.expect, 'verify.expect', source),
    }
    checkTemplate(verify.url, 'verify.url')
    checkTemplate(verify.expect, 'verify.expect')
    config.verify = verify
  }
  return config
}

export function loadConfig(path: string): WorktreePortsConfig {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    throw new ConfigError(`cannot read ${path}: ${(err as Error).message}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new ConfigError(`${path}: invalid JSON: ${(err as Error).message}`)
  }
  return parseConfig(raw, path)
}

/**
 * Nearest `worktree-ports.json` from `cwd` upward. Absolute and symlink-resolved. The search stops at the first
 * directory holding `.git` (a checkout's top level), so a config above a repository never applies to it; outside git
 * it goes on to the filesystem root. A config outside any checkout is checked as git checks a repository's ownership:
 * on POSIX it must belong to this user (or root), and neither it nor its directory may be writable by other users.
 * Inside a checkout the config is part of a repository the user already chose to work in, so it isn't checked.
 */
export function findConfig(cwd: string = process.cwd()): string | undefined {
  let dir = realpathSync.native(resolve(cwd))
  for (;;) {
    const candidate = join(dir, CONFIG_FILE_NAME)
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      const path = realpathSync.native(candidate)
      if (!insideCheckout(dir)) assertTrusted(path)
      return path
    }
    // pathExists counts an unreadable .git as present, so an undecidable boundary stops the search.
    if (pathExists(join(dir, '.git'))) return undefined
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Whether `dir` or any directory above it holds a `.git` this user could have made. A `.git` owned by someone else
 * doesn't count: otherwise another user could plant `/tmp/.git` beside `/tmp/worktree-ports.json` to skip the check.
 */
function insideCheckout(dir: string): boolean {
  for (;;) {
    const git = join(dir, '.git')
    if (pathExists(git)) {
      const stat = lstatSync(git, { throwIfNoEntry: false })
      return stat !== undefined && trustedOwner(stat.uid)
    }
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/** On POSIX: this user, root, or under sudo the invoking user (whose uid sudo keeps in SUDO_UID). Always true on Windows. */
function trustedOwner(owner: number): boolean {
  if (process.platform === 'win32' || process.getuid === undefined) return true
  const uid = process.getuid()
  return owner === uid || owner === 0 || (uid === 0 && owner === Number(process.env.SUDO_UID))
}

/**
 * Refuse a config another user could have written. Its directory counts too: its owner, or anyone who can write
 * there, could replace the file between this check and the read, unless the directory is sticky (as `/tmp` is).
 */
function assertTrusted(path: string): void {
  if (process.platform === 'win32' || process.getuid === undefined) return
  const advice = 'pass --config <path> to use it anyway'
  const file = statSync(path)
  if (!trustedOwner(file.uid)) throw new ConfigError(`${path} is owned by another user; refusing to use it (${advice})`)
  if ((file.mode & 0o002) !== 0) {
    throw new ConfigError(`${path} is writable by other users; refusing to use it (chmod o-w, or ${advice})`)
  }
  const parent = statSync(dirname(path))
  if (!trustedOwner(parent.uid)) {
    throw new ConfigError(`${path} is in a directory owned by another user; refusing to use it (${advice})`)
  }
  if ((parent.mode & 0o002) !== 0 && (parent.mode & 0o1000) === 0) {
    throw new ConfigError(
      `${path} is in a directory other users can write, so they could replace it; refusing to use it (${advice})`,
    )
  }
}

/** Ports a claim needs: `max(offset) + 1` rounded up to a multiple of 10. */
export function blockSize(config: WorktreePortsConfig): number {
  const maxOffset = Math.max(...Object.values(config.services).map((s) => s.offset))
  return Math.ceil((maxOffset + 1) / 10) * 10
}

/** A service default inside the claim range could collide with a claimed block, so it is an error. */
export function assertDefaultsOutsideRange(config: WorktreePortsConfig, range: PortRange, source: string): void {
  for (const [name, spec] of Object.entries(config.services)) {
    if (spec.default >= range.min && spec.default <= range.max) {
      throw new ConfigError(
        `${source}: services.${name}.default ${spec.default} lies inside the claim range ${range.min}-${range.max}; ` +
          `a claimed block could be handed that port. Pick a default outside the range, or change the range in the settings file`,
      )
    }
  }
}
