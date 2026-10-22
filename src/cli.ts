import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { constants } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planSpawn } from './command.ts'
import { readMode } from './context.ts'
import { buildChildEnv, PORT_MARKER, type PortRequest } from './env.ts'
import { openRegistry, parseDuration, type ListedClaim, type LockOptions, type Registry } from './registry/index.ts'
import { NoConfigError, checkoutOwner, resolvePorts, type ResolvedPorts } from './resolve.ts'
import { serviceStatus } from './status.ts'
import { verifyIdentity } from './verify.ts'

export interface CliIo {
  stdout(line: string): void
  stderr(line: string): void
  /** Where `WORKTREE_PORTS` and `CI` are read from, and the base env for `exec`'s child. */
  env: Record<string, string | undefined>
  cwd: string
}

export class UsageError extends Error {
  override name = 'UsageError'
}

export type Command = 'show' | 'status' | 'env' | 'exec' | 'list' | 'release' | 'prune' | 'version' | 'help'

export interface ParsedArgs {
  command: Command
  json: boolean
  verify: boolean
  verbose: boolean
  dryRun: boolean
  config?: string
  /** `exec`/`env --port`: the service whose port becomes `PORT`. */
  port?: string
  /** `prune --unused-for`, in days. */
  unusedForDays?: number
  /** `exec`'s command and its arguments. */
  rest: string[]
}

const USAGE = `usage:
  worktree-ports show    [--json] [--config <path>]
  worktree-ports status  [--json] [--config <path>]
  worktree-ports env     [--port <service>] [--config <path>]
  worktree-ports exec    [--port <service>] [--verify] [-v | --verbose] [--config <path>] -- <command> [args...]
  worktree-ports list    [--json]
  worktree-ports release [--config <path>]
  worktree-ports prune   [--unused-for <duration>] [--dry-run]
  worktree-ports --version | --help | -h`

const PREFIX = 'worktree-ports:'
const OFF_MESSAGE = 'worktree-ports is off (WORKTREE_PORTS=off)'

/** The options each command accepts. */
const OPTIONS: Record<Command, readonly string[]> = {
  show: ['--json', '--config'],
  status: ['--json', '--config'],
  env: ['--port', '--config'],
  exec: ['--port', '--verify', '-v', '--verbose', '--config'],
  list: ['--json'],
  release: ['--config'],
  prune: ['--unused-for', '--dry-run'],
  version: [],
  help: [],
}

function toCommand(word: string | undefined): Command {
  if (word === undefined) throw new UsageError('missing command')
  if (word === '--version') return 'version'
  if (word === '--help' || word === '-h') return 'help'
  if (Object.hasOwn(OPTIONS, word) && word !== 'version' && word !== 'help') return word as Command
  throw new UsageError(`unknown command "${word}"`)
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [word, ...args] = argv
  const command = toCommand(word)
  const parsed: ParsedArgs = { command, json: false, verify: false, verbose: false, dryRun: false, rest: [] }
  const allowed = OPTIONS[command]
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--' && command === 'exec') {
      parsed.rest = args.slice(i + 1)
      break
    }
    if (!allowed.includes(arg)) {
      if (arg.startsWith('-') && Object.values(OPTIONS).some((opts) => opts.includes(arg))) {
        throw new UsageError(`${arg} does not apply to ${command}`)
      }
      throw new UsageError(arg.startsWith('-') ? `unknown option ${arg}` : `unexpected argument "${arg}"`)
    }
    if (arg === '--json') parsed.json = true
    else if (arg === '--verify') parsed.verify = true
    else if (arg === '--dry-run') parsed.dryRun = true
    else if (arg === '-v' || arg === '--verbose') parsed.verbose = true
    else {
      const value = args[++i]
      if (value === undefined || value === '--') throw new UsageError(`${arg} needs a value`)
      if (arg === '--config') parsed.config = value
      else if (arg === '--port') parsed.port = value
      else {
        try {
          parsed.unusedForDays = parseDuration(value)
        } catch (err) {
          throw new UsageError(`--unused-for: ${(err as Error).message}`)
        }
      }
    }
  }
  if (command === 'exec' && parsed.rest.length === 0) throw new UsageError('exec needs a command after --')
  return parsed
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Quote an argument for the `running:` line only when a shell would need it. */
function quoteArg(arg: string): string {
  return arg !== '' && /^[A-Za-z0-9_/.,:=@%+-]+$/.test(arg) ? arg : shellQuote(arg)
}

/** The `-v` message for a run that adds nothing, then the `running:` line. */
function verboseUnchanged(args: ParsedArgs, why: string, io: CliIo): void {
  if (!args.verbose) return
  io.stderr(`${PREFIX} nothing added (${why})`)
  io.stderr(`${PREFIX} running: ${args.rest.map(quoteArg).join(' ')}`)
}

function spawnChild(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const cmd = argv[0]!
  // On Windows a `.cmd`/`.bat` (npm, npx, node_modules/.bin) is run through cmd.exe; see planSpawn.
  const plan = planSpawn(argv, { platform: process.platform, env, cwd: io.cwd })
  return new Promise((resolve) => {
    const child = spawn(plan.file, plan.args, {
      stdio: 'inherit',
      env,
      cwd: io.cwd,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    })
    // Forward SIGTERM only: a Ctrl-C SIGINT already reaches the whole foreground process group (this wrapper
    // AND the child) directly from the terminal, so forwarding it too would deliver it to the child twice.
    // We still need a SIGINT listener here, though: without one, Node's default SIGINT handling would
    // terminate this wrapper immediately, before the child (which got its own copy of the signal) has had
    // a chance to exit and report a code.
    const forwardTerm = () => child.kill('SIGTERM')
    const ignoreInt = () => {}
    process.on('SIGTERM', forwardTerm)
    process.on('SIGINT', ignoreInt)
    const done = (code: number) => {
      process.off('SIGTERM', forwardTerm)
      process.off('SIGINT', ignoreInt)
      resolve(code)
    }
    child.on('error', (err) => {
      io.stderr(`${PREFIX} could not start "${cmd}": ${err.message}`)
      done(127)
    })
    child.on('exit', (code, signal) => {
      if (code !== null) done(code)
      else done(128 + (signal ? (constants.signals[signal] ?? 0) : 0))
    })
  })
}

function defaultIo(): CliIo {
  return {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    cwd: process.cwd(),
  }
}

/** This package's version: the nearest `package.json` named `worktree-ports` above this file (src/ or dist/src/). */
function packageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
      if (pkg.name === 'worktree-ports' && typeof pkg.version === 'string') return pkg.version
    } catch {
      // no readable package.json here; keep walking up
    }
    const parent = dirname(dir)
    if (parent === dir) return 'unknown'
    dir = parent
  }
}

/**
 * Lock options for the registry. `WORKTREE_PORTS_LOCK_TIMEOUT_MS` is a test-only knob, read only when
 * `WORKTREE_PORTS_UNDER_TEST=1`, so a test can see a lock timeout without waiting 15 s.
 */
function lockOptions(env: Record<string, string | undefined>): LockOptions | undefined {
  if (env.WORKTREE_PORTS_UNDER_TEST !== '1') return undefined
  const ms = Number(env.WORKTREE_PORTS_LOCK_TIMEOUT_MS)
  return env.WORKTREE_PORTS_LOCK_TIMEOUT_MS && Number.isInteger(ms) && ms > 0 ? { lockTimeoutMs: ms } : undefined
}

function registry(io: CliIo): Registry {
  const lock = lockOptions(io.env)
  return openRegistry(lock ? { lock } : {})
}

function resolve(args: ParsedArgs, io: CliIo): Promise<ResolvedPorts> {
  const lock = lockOptions(io.env)
  return resolvePorts({
    cwd: io.cwd,
    env: io.env,
    ...(args.config === undefined ? {} : { configPath: args.config }),
    // Only under test: otherwise resolvePorts opens the registry itself, after finding the config.
    ...(lock ? { registry: openRegistry({ lock }) } : {}),
  })
}

function blockText(r: ResolvedPorts): string {
  return r.claim ? `${r.claim.base}-${r.claim.base + r.claim.size - 1}` : 'none (defaults)'
}

function contextJson(r: ResolvedPorts) {
  return { kind: r.context.kind, mode: r.context.mode, reason: r.context.reason }
}

function show(r: ResolvedPorts, json: boolean, io: CliIo): number {
  if (json) {
    const out = {
      context: contextJson(r),
      name: r.name,
      root: r.root,
      configPath: r.configPath,
      block: r.claim ? { base: r.claim.base, size: r.claim.size } : null,
      ports: r.ports,
      env: r.env,
      ...(r.verify ? { verify: r.verify } : {}),
    }
    io.stdout(JSON.stringify(out, null, 2))
    return 0
  }
  io.stdout(`context: ${r.context.reason}`)
  io.stdout(`name: ${r.name}`)
  io.stdout(`root: ${r.root}`)
  io.stdout(`config: ${r.configPath}`)
  io.stdout(`block: ${blockText(r)}`)
  for (const [service, port] of Object.entries(r.ports)) io.stdout(`${service}: ${port}`)
  return 0
}

async function status(r: ResolvedPorts, json: boolean, io: CliIo): Promise<number> {
  const services = await serviceStatus(r)
  if (json) {
    io.stdout(JSON.stringify({ context: contextJson(r), name: r.name, root: r.root, services }, null, 2))
    return 0
  }
  io.stdout(`context: ${r.context.reason}`)
  io.stdout(`name: ${r.name}`)
  const width = Math.max(...services.map((s) => s.service.length))
  for (const s of services) {
    let owner = ''
    if (s.owner === 'mine') owner = '  mine'
    else if (s.owner === 'other') owner = `  OTHER checkout: ${s.ownerRoot}`
    else if (s.owner === 'unknown') owner = '  owner unknown'
    io.stdout(`${s.service.padEnd(width)}  ${String(s.port).padEnd(5)}  ${s.listening ? 'listening' : 'free'}${owner}`)
  }
  return 0
}

/**
 * The `--port` request, `undefined` when absent or when the tool is off, or 1 (after printing why) when the
 * service is not declared.
 */
function portRequest(r: ResolvedPorts, args: ParsedArgs, io: CliIo): PortRequest | undefined | 1 {
  if (args.port === undefined || r.context.kind === 'off') return undefined
  const port = r.ports[args.port]
  if (port === undefined) {
    io.stderr(
      `${PREFIX} unknown service "${args.port}" for --port; declared services: ${Object.keys(r.ports).join(', ')}`,
    )
    return 1
  }
  return { service: args.port, port }
}

async function exec(r: ResolvedPorts, args: ParsedArgs, io: CliIo): Promise<number> {
  const port = portRequest(r, args, io)
  if (port === 1) return 1
  const { env, outcomes } = buildChildEnv(io.env, r.env, port)
  // With -v the per-variable lines below replace these warnings.
  for (const o of args.verbose ? [] : outcomes) {
    if (o.action === 'kept' && o.value !== o.rendered) {
      io.stderr(
        `${PREFIX} ${o.key} is already set to "${o.value}"; keeping it (this checkout would use "${o.rendered}")`,
      )
    }
  }

  let verified = false
  if (args.verify) {
    const spec = r.verify
    if (!spec) {
      io.stderr(`${PREFIX} --verify needs a "verify" section in the config`)
      return 2
    }
    const result = await verifyIdentity(spec)
    if (result.status === 'mismatch') {
      io.stderr(
        `${PREFIX} ${spec.url} belongs to "${result.actual}", not this checkout ("${spec.expect}"). ` +
          'Refusing to start: requests would reach the wrong checkout.',
      )
      return 1
    }
    if (result.status === 'match') {
      verified = true
    } else if (result.status === 'unreachable') {
      io.stderr(`${PREFIX} nothing is answering at ${spec.url} (${result.reason}); starting anyway`)
    } else if (result.status === 'unreported') {
      io.stderr(`${PREFIX} ${spec.url} did not report "${spec.field}"; cannot confirm whose it is; starting anyway`)
    }
  }

  const ports = Object.entries(r.ports)
    .map(([service, port]) => `${service}=${port}`)
    .join(' ')
  io.stderr(`${PREFIX} ${r.name} (${r.context.reason}): ${ports}`)
  if (args.verbose) {
    // Only variables this tool manages are listed; the rest of the inherited environment may hold secrets.
    for (const o of outcomes) {
      let suffix = ''
      if (o.action === 'kept') suffix = ` (this checkout would use ${o.rendered})`
      else if (o.key === 'PORT' && port) {
        suffix =
          o.action === 'replaced'
            ? ` (--port ${port.service}; was ${o.previous} from an outer exec)`
            : ` (--port ${port.service})`
      }
      io.stderr(`${PREFIX}   ${o.action.padEnd(8)} ${o.key}=${o.value}${suffix}`)
    }
    if (verified) io.stderr(`${PREFIX} verify: ${r.verify!.url} reports this checkout`)
    io.stderr(`${PREFIX} running: ${args.rest.map(quoteArg).join(' ')}`)
  }
  return spawnChild(args.rest, env, io)
}

const LIST_HEADER = `${'BASE'.padEnd(6)}${'SIZE'.padEnd(6)}${'LAST-USED'.padEnd(12)}${'STALE'.padEnd(14)}ROOT  CONFIG`

function list(json: boolean, io: CliIo): number {
  const claims: ListedClaim[] = registry(io)
    .list()
    .sort((a, b) => a.base - b.base)
  if (json) {
    io.stdout(JSON.stringify(claims, null, 2))
    return 0
  }
  io.stdout(LIST_HEADER)
  for (const c of claims) {
    const cells = [
      String(c.base).padEnd(6),
      String(c.size).padEnd(6),
      c.lastUsed.padEnd(12),
      (c.stale ?? '-').padEnd(14),
    ]
    io.stdout(`${cells.join('')}${c.root}  ${c.config}`)
  }
  return 0
}

async function release(args: ParsedArgs, io: CliIo): Promise<number> {
  const owner = checkoutOwner({ cwd: io.cwd, ...(args.config === undefined ? {} : { configPath: args.config }) })
  const released = await registry(io).release(owner)
  io.stdout(released ? `released ${released.base}` : 'no claim for this checkout')
  return 0
}

async function prune(args: ParsedArgs, io: CliIo): Promise<number> {
  const removals = await registry(io).prune({
    dryRun: args.dryRun,
    ...(args.unusedForDays === undefined ? {} : { unusedForDays: args.unusedForDays }),
  })
  if (removals.length === 0) io.stdout('nothing to prune')
  const verb = args.dryRun ? 'would remove' : 'removed'
  for (const { claim, reason } of removals) io.stdout(`${verb} ${claim.base} (${reason}) ${claim.root}`)
  return 0
}

async function dispatch(args: ParsedArgs, io: CliIo): Promise<number> {
  switch (args.command) {
    case 'list':
      return list(args.json, io)
    case 'release':
      return release(args, io)
    case 'prune':
      return prune(args, io)
    default:
      break
  }
  let resolved: ResolvedPorts
  try {
    resolved = await resolve(args, io)
  } catch (err) {
    if (err instanceof NoConfigError && args.command === 'exec') {
      io.stderr(`${PREFIX} ${err.message}; running the command unchanged`)
      verboseUnchanged(args, 'no config found', io)
      return spawnChild(args.rest, io.env, io)
    }
    throw err
  }
  if (args.command === 'show') return show(resolved, args.json, io)
  if (args.command === 'status') return status(resolved, args.json, io)
  if (args.command === 'env') {
    const port = portRequest(resolved, args, io)
    if (port === 1) return 1
    for (const [key, value] of Object.entries(resolved.env)) {
      if (port && key === 'PORT') continue
      io.stdout(`export ${key}=${shellQuote(value)}`)
    }
    if (port) {
      io.stdout(`export PORT=${shellQuote(String(port.port))}`)
      io.stdout(`export ${PORT_MARKER}=${shellQuote(String(port.port))}`)
    }
    return 0
  }
  return exec(resolved, args, io)
}

/**
 * Run the CLI (spec §8) and return its exit code: 0, the child's code, 1 when ports can't be resolved (bad
 * config or settings, no free block, lock timeout, registry error, no git where a claim is needed) or
 * `--verify` finds a mismatch, 2 for a usage error, 127 when the child can't start, 128+n for a signal.
 */
export async function run(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (err) {
    io.stderr(`${PREFIX} ${(err as Error).message}\n${USAGE}`)
    return 2
  }
  if (args.command === 'help') {
    io.stdout(USAGE)
    return 0
  }
  if (args.command === 'version') {
    io.stdout(packageVersion())
    return 0
  }

  try {
    if (readMode(io.env) === 'off') {
      if (args.command === 'exec') {
        verboseUnchanged(args, 'WORKTREE_PORTS=off', io)
        return await spawnChild(args.rest, io.env, io)
      }
      io.stdout(OFF_MESSAGE)
      return 0
    }
    return await dispatch(args, io)
  } catch (err) {
    // ConfigError, SettingsError, ModeError, NoConfigError, LockTimeoutError, RegistryFullError,
    // NotAGitWorktreeError and registry I/O errors all mean the ports could not be resolved.
    io.stderr(`${PREFIX} ${(err as Error).message}`)
    return 1
  }
}
