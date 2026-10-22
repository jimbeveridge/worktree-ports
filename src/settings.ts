import { readFileSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'

export interface PortRange {
  min: number
  /** Last usable port (inclusive). */
  max: number
}

/** Well below the OS ephemeral ranges (32768+ on Linux, 49152+ on macOS, BSD and Windows). */
export const DEFAULT_RANGE: PortRange = { min: 20000, max: 32759 }

export interface Settings {
  range: PortRange
}

export class SettingsError extends Error {
  override name = 'SettingsError'
}

const APP_DIR = 'worktree-ports'

function realOrSelf(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}

/** Tests must never touch a real registry or settings file: under test, the result has to live in the temp dir. */
function guardUnderTest(path: string, env: NodeJS.ProcessEnv, what: string): string {
  if (env.WORKTREE_PORTS_UNDER_TEST !== '1') return path
  const tmp = realOrSelf(tmpdir())
  // The path may not exist yet; resolve its deepest existing ancestor so symlinked temp dirs compare equal.
  let existing = resolve(path)
  const tail: string[] = []
  for (;;) {
    try {
      existing = realpathSync.native(existing)
      break
    } catch {
      const parent = resolve(existing, '..')
      if (parent === existing) break
      tail.unshift(basename(existing))
      existing = parent
    }
  }
  const real = join(existing, ...tail)
  const rel = relative(tmp, real)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`refusing to use ${what} ${path} while WORKTREE_PORTS_UNDER_TEST=1: it is not under ${tmp}`)
  }
  return path
}

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || homedir()
}

function nonEmpty(v: string | undefined): string | undefined {
  return v === undefined || v === '' ? undefined : v
}

/** Directory holding `lock/` and `claims/`. */
export function stateDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const explicit = nonEmpty(env.WORKTREE_PORTS_STATE_DIR)
  let dir: string
  if (explicit) dir = explicit
  else if (platform === 'win32') {
    const base = nonEmpty(env.LOCALAPPDATA) ?? win32.join(home(env), 'AppData', 'Local')
    dir = win32.join(base, APP_DIR)
  } else {
    const xdg = nonEmpty(env.XDG_STATE_HOME)
    dir = xdg ? join(xdg, APP_DIR) : join(home(env), '.local', 'state', APP_DIR)
  }
  return guardUnderTest(dir, env, 'state dir')
}

/** The optional per-user settings file. */
export function settingsPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  let file: string
  if (platform === 'win32') {
    const base = nonEmpty(env.APPDATA) ?? win32.join(home(env), 'AppData', 'Roaming')
    file = win32.join(base, APP_DIR, 'config.json')
  } else {
    const xdg = nonEmpty(env.XDG_CONFIG_HOME)
    file = xdg ? join(xdg, APP_DIR, 'config.json') : join(home(env), '.config', APP_DIR, 'config.json')
  }
  return guardUnderTest(file, env, 'settings file')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function port(v: unknown, what: string, source: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new SettingsError(`${source}: ${what} must be an integer`)
  return v
}

function parseSettings(raw: unknown, source: string): Settings {
  if (!isRecord(raw)) throw new SettingsError(`${source}: expected a JSON object`)
  for (const key of Object.keys(raw)) {
    if (key !== 'range') throw new SettingsError(`${source}: unknown field "${key}"`)
  }
  if (raw.range === undefined) return { range: { ...DEFAULT_RANGE } }
  if (!isRecord(raw.range)) throw new SettingsError(`${source}: range must be an object`)
  for (const key of Object.keys(raw.range)) {
    if (key !== 'min' && key !== 'max') throw new SettingsError(`${source}: unknown field "range.${key}"`)
  }
  const min = port(raw.range.min, 'range.min', source)
  const max = port(raw.range.max, 'range.max', source)
  if (min < 1024) throw new SettingsError(`${source}: range.min must be >= 1024 (lower ports are privileged)`)
  if (min % 10 !== 0) throw new SettingsError(`${source}: range.min must be a multiple of 10, got ${min}`)
  if (max > 65535) throw new SettingsError(`${source}: range.max must be <= 65535, got ${max}`)
  if (max < min + 9) {
    throw new SettingsError(`${source}: range.max must be at least range.min + 9 (room for one ten-port block)`)
  }
  return { range: { min, max } }
}

/** Reads the settings file. A missing file means the defaults; a malformed one is an error. */
export function loadSettings(path: string = settingsPath()): Settings {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { range: { ...DEFAULT_RANGE } }
    throw new SettingsError(`cannot read ${path}: ${(err as Error).message}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new SettingsError(`${path}: invalid JSON: ${(err as Error).message}`)
  }
  return parseSettings(raw, path)
}
