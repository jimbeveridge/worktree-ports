import { homedir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_FILE_NAME, loadConfig, type VerifySpec, type WorktreePortsConfig } from './config.ts'
import { renderTemplate, type TemplateContext } from './env.ts'
import { locateWorktree, type WorktreeLocation } from './git.ts'
import { reservePorts, type Reservation, type ReserveHooks } from './reserve.ts'

export interface ResolveOptions {
  /** Any directory inside the worktree. Defaults to `process.cwd()`. */
  cwd?: string
  /** Defaults to `<worktree root>/worktree-ports.json`. */
  configPath?: string
  /** Value of `{home}`. Defaults to `os.homedir()`. */
  home?: string
  hooks?: ReserveHooks
}

export interface ResolvedPorts {
  location: WorktreeLocation
  config: WorktreePortsConfig
  reservation: Reservation
  ports: Record<string, number>
  /** Rendered `config.env`. */
  env: Record<string, string>
  /** Rendered `config.verify`, when configured. */
  verify?: VerifySpec
}

export function portsFor(config: WorktreePortsConfig, reservation: Reservation): Record<string, number> {
  const ports: Record<string, number> = {}
  for (const [name, spec] of Object.entries(config.services)) {
    ports[name] = reservation.source === 'main' ? spec.mainPort! : reservation.base + spec.offset
  }
  return ports
}

export function resolvePorts(opts: ResolveOptions = {}): ResolvedPorts {
  const location = locateWorktree(opts.cwd ?? process.cwd())
  const config = loadConfig(opts.configPath ?? join(location.root, CONFIG_FILE_NAME))
  const reservation = reservePorts(location, config, opts.hooks)
  const ports = portsFor(config, reservation)
  const ctx: TemplateContext = { root: location.root, name: location.name, home: opts.home ?? homedir(), ports }
  const env: Record<string, string> = {}
  for (const [key, template] of Object.entries(config.env)) env[key] = renderTemplate(template, ctx)
  const resolved: ResolvedPorts = { location, config, reservation, ports, env }
  if (config.verify) {
    resolved.verify = {
      url: renderTemplate(config.verify.url, ctx),
      field: config.verify.field,
      expect: renderTemplate(config.verify.expect, ctx),
    }
  }
  return resolved
}
