import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { mergeEnv } from './env.ts'
import { NotAGitWorktreeError } from './git.ts'
import { resolvePorts, type ResolvedPorts } from './resolve.ts'
import { serviceStatus } from './status.ts'
import { verifyIdentity } from './verify.ts'

export interface CliIo {
  stdout(line: string): void
  stderr(line: string): void
  env: Record<string, string | undefined>
  cwd: string
}

export class UsageError extends Error {
  override name = 'UsageError'
}

export interface ParsedArgs {
  command: 'show' | 'env' | 'exec' | 'status'
  json: boolean
  verify: boolean
  config?: string
  rest: string[]
}

const USAGE = `usage:
  worktree-ports show [--json] [--config <path>]
  worktree-ports status [--json] [--config <path>]
  worktree-ports env [--config <path>]
  worktree-ports exec [--verify] [--config <path>] -- <command> [args...]`

const PREFIX = '[worktree-ports]'

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...args] = argv
  if (command !== 'show' && command !== 'env' && command !== 'exec' && command !== 'status') {
    throw new UsageError(command === undefined ? 'missing command' : `unknown command "${command}"`)
  }
  const parsed: ParsedArgs = { command, json: false, verify: false, rest: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') {
      parsed.rest = args.slice(i + 1)
      break
    }
    if (arg === '--json' && (command === 'show' || command === 'status')) parsed.json = true
    else if (arg === '--verify') {
      if (command !== 'exec') throw new UsageError('--verify only applies to exec')
      parsed.verify = true
    } else if (arg === '--config') {
      const value = args[++i]
      if (value === undefined) throw new UsageError('--config needs a path')
      parsed.config = value
    } else throw new UsageError(`unknown option ${arg}`)
  }
  if (command === 'exec' && parsed.rest.length === 0) throw new UsageError('exec needs a command after --')
  return parsed
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function spawnChild(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const [cmd, ...args] = argv
  return new Promise((resolve) => {
    const child = spawn(cmd!, args, { stdio: 'inherit', env, cwd: io.cwd })
    // Forward SIGTERM only: a Ctrl-C SIGINT already reaches the whole foreground
    // process group (this wrapper AND the child) directly from the terminal, so
    // forwarding it too would deliver it to the child twice. We still need a
    // SIGINT listener here, though: without one, Node's default SIGINT handling
    // would terminate this wrapper immediately, before the child (which got its
    // own copy of the signal) has had a chance to exit and report a code.
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

function describePorts(r: ResolvedPorts): string {
  return Object.entries(r.ports)
    .map(([service, port]) => `${service}=${port}`)
    .join(' ')
}

function defaultIo(): CliIo {
  return {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    cwd: process.cwd(),
  }
}

export async function run(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (err) {
    io.stderr(`${PREFIX} ${(err as Error).message}\n${USAGE}`)
    return 2
  }

  let resolved: ResolvedPorts
  try {
    resolved = resolvePorts({ cwd: io.cwd, ...(args.config === undefined ? {} : { configPath: args.config }) })
  } catch (err) {
    if (err instanceof NotAGitWorktreeError && args.command === 'exec') {
      io.stderr(`${PREFIX} not inside a git worktree; running without worktree ports`)
      return spawnChild(args.rest, io.env, io)
    }
    io.stderr(`${PREFIX} ${(err as Error).message}`)
    return 1
  }

  if (args.command === 'show') {
    const summary = {
      name: resolved.location.name,
      root: resolved.location.root,
      isMain: resolved.location.isMain,
      reservation: resolved.reservation,
      ports: resolved.ports,
      env: resolved.env,
    }
    if (args.json) {
      io.stdout(JSON.stringify(summary, null, 2))
    } else {
      const r = resolved.reservation
      io.stdout(`worktree  ${summary.name}${summary.isMain ? ' (main checkout)' : ''}`)
      io.stdout(`root      ${summary.root}`)
      io.stdout(`block     ${r.source === 'main' ? 'fixed main-checkout ports' : `${r.base} (${r.source})`}`)
      for (const [service, port] of Object.entries(resolved.ports)) io.stdout(`${service.padEnd(9)} ${port}`)
    }
    return 0
  }

  if (args.command === 'env') {
    for (const [key, value] of Object.entries(resolved.env)) io.stdout(`export ${key}=${shellQuote(value)}`)
    return 0
  }

  if (args.command === 'status') {
    const { name, root, isMain } = resolved.location
    const services = await serviceStatus(resolved)
    if (args.json) {
      io.stdout(JSON.stringify({ name, root, isMain, services }, null, 2))
    } else {
      io.stdout(`worktree  ${name}${isMain ? ' (main checkout)' : ''}`)
      for (const s of services) {
        const state = s.listening ? 'listening' : 'free'
        let owner = ''
        if (s.owner === 'mine') owner = '  mine'
        else if (s.owner === 'other') owner = `  OTHER worktree: ${s.ownerRoot}`
        else if (s.owner === 'unknown') owner = '  owner unknown'
        else if (s.listening) owner = '  (owner not checked)'
        io.stdout(`${s.service.padEnd(9)} ${String(s.port).padEnd(5)} ${state.padEnd(9)}${owner}`)
      }
    }
    return 0
  }

  const { env, kept } = mergeEnv(io.env, resolved.env)
  for (const key of kept) {
    if (io.env[key] !== resolved.env[key]) {
      io.stderr(
        `${PREFIX} ${key} is already set to "${io.env[key]}"; keeping it (this worktree would use "${resolved.env[key]}")`,
      )
    }
  }

  if (args.verify) {
    const spec = resolved.verify
    if (!spec) {
      io.stderr(`${PREFIX} --verify needs a "verify" section in the config`)
      return 2
    }
    const result = await verifyIdentity(spec)
    if (result.status === 'mismatch') {
      io.stderr(
        `${PREFIX} ${spec.url} belongs to "${result.actual}", not this worktree ("${spec.expect}"). ` +
          'Refusing to start: requests would reach the wrong worktree.',
      )
      return 1
    }
    if (result.status === 'unreachable') {
      io.stderr(`${PREFIX} nothing is answering at ${spec.url} (${result.reason}); start it first. Continuing.`)
    } else if (result.status === 'unreported') {
      io.stderr(
        `${PREFIX} ${spec.url} did not report "${spec.field}"; cannot confirm it belongs to this worktree. Continuing.`,
      )
    }
  }

  io.stderr(`${PREFIX} ${resolved.location.name}: ${describePorts(resolved)}`)
  return spawnChild(args.rest, env, io)
}
