import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import {
  assertDefaultsOutsideRange,
  blockSize,
  CONFIG_FILE_NAME,
  findConfig,
  loadConfig,
  type VerifySpec,
  type WorktreePortsConfig,
} from './config.ts'
import { detectContext, readMode, type Context } from './context.ts'
import { renderTemplate, type TemplateContext } from './env.ts'
import { claimBlock, openRegistry, type Claim, type ClaimHooks, type Registry } from './registry/index.ts'
import { loadSettings } from './settings.ts'

/** No `worktree-ports.json` in the directory or any parent, and no `configPath` given. */
export class NoConfigError extends Error {
  override name = 'NoConfigError'
}

export interface ResolveOptions {
  /** Any directory inside the checkout. Defaults to `process.cwd()`. */
  cwd?: string
  /** An explicit config file (`--config`); relative paths resolve against `cwd`. Default: discovery upward from `cwd`. */
  configPath?: string
  /**
   * Where `WORKTREE_PORTS` and `CI` are read from. Defaults to `process.env`. The state dir and settings file
   * always come from `process.env` (or from `registry`).
   */
  env?: NodeJS.ProcessEnv
  /** Value of `{home}`. Defaults to `os.homedir()`. */
  home?: string
  /** The registry to claim in; its range is the effective range. Default: `openRegistry()`. */
  registry?: Registry
  /** Test seams passed to `claimBlock`. */
  hooks?: ClaimHooks
}

export interface ResolvedPorts {
  context: Context
  /** Absolute, symlink-resolved path of the config file; `''` when off. */
  configPath: string
  config: WorktreePortsConfig
  /** `{root}`: the checkout's top-level dir, or the config's dir outside git. */
  root: string
  /** `{name}`: git's admin-dir name in a linked worktree, otherwise `main`. */
  name: string
  /** The claimed block, when the context claims. */
  claim?: Claim
  ports: Record<string, number>
  /** Rendered `config.env`. */
  env: Record<string, string>
  /** Rendered `config.verify`, when configured. */
  verify?: VerifySpec
}

/** The claim's `config` key: relative to `root` with `/` separators, or absolute when the file is outside `root`. */
function relOrAbs(root: string, configPath: string): string {
  const rel = relative(root, configPath)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return configPath
  return rel.split(sep).join('/')
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path // loadConfig reports the unreadable path
  }
}

/** Find the config, work out the context, claim or look up the block, and render `env` and `verify` (spec §11). */
export async function resolvePorts(opts: ResolveOptions = {}): Promise<ResolvedPorts> {
  const env = opts.env ?? process.env
  const givenCwd = resolve(opts.cwd ?? process.cwd())
  if (readMode(env) === 'off') {
    return {
      context: { kind: 'off', mode: 'off', claims: false, reason: 'WORKTREE_PORTS=off' },
      configPath: '',
      config: { services: {}, mainCheckout: 'default', env: {} },
      root: givenCwd,
      name: 'main',
      ports: {},
      env: {},
    }
  }

  const cwd = realpathSync(givenCwd)
  let configPath: string
  if (opts.configPath !== undefined) {
    configPath = realpathOr(resolve(cwd, opts.configPath))
  } else {
    const found = findConfig(cwd)
    if (found === undefined) {
      throw new NoConfigError(`no ${CONFIG_FILE_NAME} found in ${cwd} or any parent directory`)
    }
    configPath = found
  }
  const config = loadConfig(configPath)

  const range = opts.registry?.range ?? loadSettings().range
  assertDefaultsOutsideRange(config, range, configPath)

  const context = detectContext(cwd, env, config)
  const location = context.location
  const root = location?.root ?? dirname(configPath)
  const name = location?.name ?? 'main'

  let claim: Claim | undefined
  const ports: Record<string, number> = {}
  if (context.claims && location !== undefined) {
    const registry = opts.registry ?? openRegistry({ settings: { range } })
    const owner = { gitDir: location.gitDir, root: location.root, config: relOrAbs(location.root, configPath) }
    claim = (await claimBlock(owner, blockSize(config), registry, opts.hooks)).claim
    for (const [service, spec] of Object.entries(config.services)) ports[service] = claim.base + spec.offset
  } else {
    for (const [service, spec] of Object.entries(config.services)) ports[service] = spec.default
  }

  const ctx: TemplateContext = { root, name, home: opts.home ?? homedir(), ports }
  const rendered: Record<string, string> = {}
  for (const [key, template] of Object.entries(config.env)) rendered[key] = renderTemplate(template, ctx)
  const resolved: ResolvedPorts = { context, configPath, config, root, name, ports, env: rendered }
  if (claim !== undefined) resolved.claim = claim
  if (config.verify) {
    resolved.verify = {
      url: renderTemplate(config.verify.url, ctx),
      field: config.verify.field,
      expect: renderTemplate(config.verify.expect, ctx),
    }
  }
  return resolved
}
