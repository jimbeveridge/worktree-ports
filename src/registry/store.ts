import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PortRange } from '../settings.ts'

/** One checkout's block of ports: the interval `[base, base + size)`, owned by the pair (`gitDir`, `config`). */
export interface Claim {
  base: number
  size: number
  /** The owner's private git dir, absolute and symlink-resolved. */
  gitDir: string
  /** The owner's worktree root; for `list` output only. */
  root: string
  /** The config file's path relative to `root` with `/` separators, or absolute when it is outside `root`. */
  config: string
  /** ISO timestamp; for `list` output only. */
  claimedAt: string
  /** Local date, `YYYY-MM-DD`. */
  lastUsed: string
}

const CLAIM_FILE = /^[1-9][0-9]*\.json$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** `<state>/claims`, created (with its parents) if missing. */
export function claimsDir(stateDir: string): string {
  const dir = join(stateDir, 'claims')
  mkdirSync(dir, { recursive: true })
  return dir
}

function isPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535
}

function isText(v: unknown): v is string {
  return typeof v === 'string' && v !== ''
}

/** The claim a parsed file describes, or undefined if it is not a well-formed claim. */
function toClaim(raw: unknown): Claim | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const { base, size, gitDir, root, config, claimedAt, lastUsed } = r
  if (!isPort(base) || typeof size !== 'number' || !Number.isInteger(size) || size < 1) return undefined
  if (base + size - 1 > 65535) return undefined
  if (!isText(gitDir) || !isText(root) || !isText(config) || !isText(claimedAt)) return undefined
  if (typeof lastUsed !== 'string' || !DATE.test(lastUsed)) return undefined
  return { base, size, gitDir, root, config, claimedAt, lastUsed }
}

/**
 * Every well-formed claim, whatever the range: files that aren't `<base>.json`, aren't JSON, miss a field
 * or disagree with their own name are ignored, as if absent. A claim file that exists but can't be read
 * throws, since treating it as absent could hand a live block to someone else. Sorted by base.
 */
export function readAllClaims(stateDir: string): Claim[] {
  const dir = join(stateDir, 'claims')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const claims: Claim[] = []
  for (const name of names) {
    if (!CLAIM_FILE.test(name)) continue
    const file = join(dir, name)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EISDIR') continue // deleted since the listing, or not a file
      throw new Error(`cannot read claim file ${file}: ${(err as Error).message}`, { cause: err })
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      continue
    }
    const claim = toClaim(raw)
    if (claim === undefined || name !== `${claim.base}.json`) continue
    claims.push(claim)
  }
  return claims.sort((a, b) => a.base - b.base)
}

/** True when the claim is a valid block of `range`: aligned to 10 from `min`, a multiple of 10 long, inside. */
export function inRange(claim: Claim, range: PortRange): boolean {
  return (
    claim.base >= range.min &&
    (claim.base - range.min) % 10 === 0 &&
    claim.size % 10 === 0 &&
    claim.base + claim.size - 1 <= range.max
  )
}

/** The well-formed claims that are valid blocks of `range` (see `readAllClaims` for what is ignored). */
export function readClaims(stateDir: string, range: PortRange): Claim[] {
  return readAllClaims(stateDir).filter((c) => inRange(c, range))
}

/** Writes `<state>/claims/<base>.json` atomically (temp file, then rename), so no reader sees half a file. */
export function writeClaim(stateDir: string, claim: Claim): void {
  const dir = claimsDir(stateDir)
  const file = join(dir, `${claim.base}.json`)
  const tmp = `${file}.${process.pid}.tmp`
  const { base, size, gitDir, root, config, claimedAt, lastUsed } = claim
  const text = `${JSON.stringify({ base, size, gitDir, root, config, claimedAt, lastUsed }, null, 2)}\n`
  try {
    writeFileSync(tmp, text)
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/** Deletes `<state>/claims/<base>.json`; a missing file is fine. */
export function deleteClaim(stateDir: string, base: number): void {
  try {
    unlinkSync(join(stateDir, 'claims', `${base}.json`))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

/** A date as local `YYYY-MM-DD`, the format of `Claim.lastUsed`. */
export function localDate(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
