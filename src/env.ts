import { ConfigError } from './config.ts'

export interface TemplateContext {
  /** `{root}`: the checkout's top-level dir; outside git, the dir holding the config file. */
  root: string
  /** `{name}`: `main` for the main checkout and outside git; git's admin-dir name for a linked worktree. */
  name: string
  home: string
  ports: Record<string, number>
}

/** Replace `{root}`, `{name}`, `{home}` and `{<service>}` tokens. */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{([^{}]*)\}/g, (_match, token: string) => {
    if (token === 'root') return ctx.root
    if (token === 'name') return ctx.name
    if (token === 'home') return ctx.home
    const port = ctx.ports[token]
    if (port === undefined) throw new ConfigError(`unknown template token {${token}}`)
    return String(port)
  })
}

export interface MergedEnv {
  env: Record<string, string | undefined>
  /** Keys taken from `values`. */
  applied: string[]
  /** Keys already present in `base` and left untouched. */
  kept: string[]
}

/** Overlay `values` onto `base` without overwriting anything already set: an explicit variable always wins. */
export function mergeEnv(base: Record<string, string | undefined>, values: Record<string, string>): MergedEnv {
  const env = { ...base }
  const applied: string[] = []
  const kept: string[] = []
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined) {
      env[key] = value
      applied.push(key)
    } else {
      kept.push(key)
    }
  }
  return { env, applied, kept }
}

/** Set to `1` in every child `exec` starts, even when it adds nothing else (spec §8), so a launcher can tell it is wrapped. */
export const ACTIVE_MARKER = 'WORKTREE_PORTS_ACTIVE'

/** The variable `--port` sets alongside `PORT`, so a nested `exec --port` can tell its own `PORT` from a pinned one. */
export const PORT_MARKER = 'WORKTREE_PORTS_PORT'

export type EnvAction = 'set' | 'replaced' | 'kept'

export interface EnvOutcome {
  key: string
  action: EnvAction
  /** The value the child receives. */
  value: string
  /** The value this checkout renders for the key. */
  rendered: string
  /** For `replaced`: the inherited value that was replaced. */
  previous?: string
}

export interface PortRequest {
  service: string
  port: number
}

/**
 * Build the child's environment. Rendered keys follow `mergeEnv`'s never-overwrite rule, except that with `port`
 * the flag owns `PORT` (a rendered `PORT` is ignored) and its marker (spec §8a):
 * - `base.PORT` unset: set `PORT` and the marker.
 * - `base.PORT` equals the inherited marker: an outer `exec --port` set it, so replace both.
 * - otherwise a person or CI pinned `PORT`: keep it, leave the marker alone and emit no marker outcome.
 */
export function buildChildEnv(
  base: Record<string, string | undefined>,
  rendered: Record<string, string>,
  port?: PortRequest,
): { env: Record<string, string | undefined>; outcomes: EnvOutcome[] } {
  const env = { ...base }
  const outcomes: EnvOutcome[] = []
  for (const [key, value] of Object.entries(rendered)) {
    if (port && key === 'PORT') continue
    if (env[key] === undefined) {
      env[key] = value
      outcomes.push({ key, action: 'set', value, rendered: value })
    } else {
      outcomes.push({ key, action: 'kept', value: env[key], rendered: value })
    }
  }
  if (port) {
    const value = String(port.port)
    const current = base.PORT
    if (current === undefined) {
      env.PORT = value
      env[PORT_MARKER] = value
      outcomes.push({ key: 'PORT', action: 'set', value, rendered: value })
      outcomes.push({ key: PORT_MARKER, action: 'set', value, rendered: value })
    } else if (current === base[PORT_MARKER]) {
      env.PORT = value
      env[PORT_MARKER] = value
      outcomes.push({ key: 'PORT', action: 'replaced', value, rendered: value, previous: current })
      outcomes.push({ key: PORT_MARKER, action: 'replaced', value, rendered: value, previous: current })
    } else {
      outcomes.push({ key: 'PORT', action: 'kept', value: current, rendered: value })
    }
  }
  return { env, outcomes }
}
