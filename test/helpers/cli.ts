import { spawn } from 'node:child_process'
import { join } from 'node:path'

const BIN = join(import.meta.dirname, '..', '..', 'bin', 'worktree-ports.ts')

export interface CliResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Run `bin/worktree-ports.ts` in a child `node` process, so tests can observe real exit codes and signals.
 * The child inherits the isolated environment from `test/setup.ts` but is not itself preloaded with it
 * (that would make the child create and delete its own state dir). Pass `undefined` in `env` to unset a variable.
 */
export function runCli(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env }
  for (const [k, v] of Object.entries(opts.env ?? {})) if (v === undefined) delete env[k]
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...argv], { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr }))
  })
}
