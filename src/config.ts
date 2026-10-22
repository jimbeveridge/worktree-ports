import { readFileSync } from 'node:fs'

/** File name `resolvePorts` looks for at the worktree root. */
export const CONFIG_FILE_NAME = 'worktree-ports.json'
export const DEFAULT_FILE_NAME = 'worktree-port.txt'
/** Well below the OS ephemeral range (49152+ on macOS/BSD, 32768+ on Linux). */
export const DEFAULT_RANGE: PortRange = { min: 20000, max: 29990, step: 10 }
export const BUILTIN_TOKENS = ['root', 'name', 'home'] as const

export interface PortRange {
  /** First block base (inclusive). */
  min: number
  /** Last block base (inclusive). The last block spans `max .. max + step - 1`. */
  max: number
  /** Block size. Every service offset must be below it. */
  step: number
}

export interface ServiceSpec {
  /** Port = block base + offset. */
  offset: number
  /** Fixed port used by the main checkout. Set on every service or on none. */
  mainPort?: number
}

export interface VerifySpec {
  /** URL template, e.g. `http://localhost:{api}/health`. */
  url: string
  /** Top-level JSON field of the response that names the owning worktree. */
  field: string
  /** Template the field must equal, normally `{root}`. */
  expect: string
}

export interface WorktreePortsConfig {
  /** Reservation file name inside each worktree's git dir. */
  fileName: string
  range: PortRange
  services: Record<string, ServiceSpec>
  /** Environment variable templates rendered for `exec` / `env`. */
  env: Record<string, string>
  verify?: VerifySpec
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

const SERVICE_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/

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

/** True when the main checkout uses fixed `mainPort`s instead of allocating a block. */
export function usesMainPorts(config: WorktreePortsConfig): boolean {
  return Object.values(config.services).every((s) => s.mainPort !== undefined)
}

export function parseConfig(raw: unknown, source: string = CONFIG_FILE_NAME): WorktreePortsConfig {
  if (!isRecord(raw)) throw new ConfigError(`${source}: expected a JSON object`)

  const fileName = raw.fileName === undefined ? DEFAULT_FILE_NAME : nonEmpty(raw.fileName, 'fileName', source)
  if (/[\\/]/.test(fileName)) throw new ConfigError(`${source}: fileName must be a bare file name, got "${fileName}"`)

  let range: PortRange = DEFAULT_RANGE
  if (raw.range !== undefined) {
    if (!isRecord(raw.range)) throw new ConfigError(`${source}: range must be an object`)
    range = {
      min: int(raw.range.min, 'range.min', source),
      max: int(raw.range.max, 'range.max', source),
      step: int(raw.range.step, 'range.step', source),
    }
  }
  if (range.step < 1) throw new ConfigError(`${source}: range.step must be >= 1`)
  if (range.min < 1024) throw new ConfigError(`${source}: range.min must be >= 1024 (lower ports are privileged)`)
  if (range.max < range.min) throw new ConfigError(`${source}: range.max must be >= range.min`)
  if ((range.max - range.min) % range.step !== 0) {
    throw new ConfigError(`${source}: range.max - range.min must be a multiple of range.step`)
  }
  const lastPort = range.max + range.step - 1
  if (lastPort > 65535) {
    throw new ConfigError(`${source}: the last block (${range.max}..${lastPort}) exceeds port 65535`)
  }

  if (!isRecord(raw.services) || Object.keys(raw.services).length === 0) {
    throw new ConfigError(`${source}: services must be an object with at least one service`)
  }
  const services: Record<string, ServiceSpec> = {}
  const offsets = new Set<number>()
  for (const [name, spec] of Object.entries(raw.services)) {
    if (!SERVICE_NAME.test(name)) throw new ConfigError(`${source}: service name "${name}" must match ${SERVICE_NAME}`)
    if ((BUILTIN_TOKENS as readonly string[]).includes(name)) {
      throw new ConfigError(`${source}: service name "${name}" is reserved`)
    }
    if (!isRecord(spec)) throw new ConfigError(`${source}: services.${name} must be an object`)
    const offset = int(spec.offset, `services.${name}.offset`, source)
    if (offset < 0 || offset >= range.step) {
      throw new ConfigError(`${source}: services.${name}.offset must be in 0..${range.step - 1} (below range.step)`)
    }
    if (offsets.has(offset))
      throw new ConfigError(`${source}: services.${name}.offset ${offset} is used by another service`)
    offsets.add(offset)
    const parsed: ServiceSpec = { offset }
    if (spec.mainPort !== undefined) {
      const mainPort = int(spec.mainPort, `services.${name}.mainPort`, source)
      if (mainPort < 1 || mainPort > 65535)
        throw new ConfigError(`${source}: services.${name}.mainPort must be 1..65535`)
      if (mainPort >= range.min && mainPort <= lastPort) {
        throw new ConfigError(
          `${source}: services.${name}.mainPort ${mainPort} lies inside the allocation range; a linked worktree could be handed it`,
        )
      }
      parsed.mainPort = mainPort
    }
    services[name] = parsed
  }
  const withMain = Object.values(services).filter((s) => s.mainPort !== undefined).length
  if (withMain !== 0 && withMain !== Object.keys(services).length) {
    throw new ConfigError(`${source}: mainPort must be set on every service or on none`)
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
      if (typeof value !== 'string') throw new ConfigError(`${source}: env.${key} must be a string`)
      checkTemplate(value, `env.${key}`)
      env[key] = value
    }
  }

  const config: WorktreePortsConfig = { fileName, range, services, env }
  if (raw.verify !== undefined) {
    if (!isRecord(raw.verify)) throw new ConfigError(`${source}: verify must be an object`)
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
