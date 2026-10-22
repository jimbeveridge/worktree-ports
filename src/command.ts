import { statSync } from 'node:fs'
import { win32 } from 'node:path'

const { extname, isAbsolute, join, resolve } = win32

/** How to spawn `exec`'s child: the file, its argv, and whether Node must pass the argv to Windows as-is. */
export interface SpawnPlan {
  file: string
  args: string[]
  windowsVerbatimArguments: boolean
}

export interface PlanOptions {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  cwd: string
  /** True when `path` is a regular file. Injected by tests. */
  isFile?: (path: string) => boolean
}

// cmd.exe metacharacters, escaped with `^` (the same set cross-spawn uses).
const META = /([()\][%!^"`<>&|;, *?])/g
// npm's `.cmd` shims in node_modules/.bin re-expand their arguments once more, so they need a second escape.
const CMD_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i

function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Windows env names are case-insensitive: find `name` under any casing. */
function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase())
  return key === undefined ? undefined : env[key]
}

/**
 * Find the file to run for `command`: each `PATH` entry, trying the name as given (when its extension is in
 * `PATHEXT`) and then with each `PATHEXT` extension. A command with a directory part is looked up only there.
 * Unlike cmd.exe, a bare name is never taken from the current directory: a checkout controls that directory, so a
 * planted `npm.cmd` would otherwise run in place of the real one. Write `.\tool` to run one from there.
 */
export function resolveWindowsCommand(command: string, opts: PlanOptions): string | undefined {
  const isFile = opts.isFile ?? defaultIsFile
  const exts = (envValue(opts.env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter((e) => e !== '')
    .map((e) => e.toLowerCase())
  const hasDir = /[\\/]/.test(command) || isAbsolute(command)
  // A relative entry (`.`, `bin`) would resolve against the current directory, so only absolute ones count.
  const dirs = hasDir ? [''] : (envValue(opts.env, 'PATH') ?? '').split(';').filter((d) => isAbsolute(d))
  const names = exts.includes(extname(command).toLowerCase()) ? [command] : []
  names.push(...exts.map((e) => command + e))
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = hasDir ? resolve(opts.cwd, name) : join(dir, name)
      if (isFile(candidate)) return candidate
    }
  }
  return undefined
}

function escapeCommand(command: string): string {
  return command.replace(META, '^$1')
}

function escapeArgument(arg: string, twice: boolean): string {
  // Quote for the C runtime's argv parser (backslashes before a quote, or before the closing quote, double up),
  // then escape every cmd.exe metacharacter, quotes included, so cmd passes the quoted argument through literally.
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')
  quoted = `"${quoted}"`.replace(META, '^$1')
  return twice ? quoted.replace(META, '^$1') : quoted
}

/**
 * Plan the spawn of `argv`. Off Windows it's a plain spawn. On Windows the command is replaced by the path
 * `resolveWindowsCommand` found, because both CreateProcess and cmd.exe would search the current directory first:
 * a `.exe`/`.com` is a plain spawn of that path, and a `.cmd`/`.bat` (`npm`, `npx`, anything in
 * `node_modules/.bin`), which can't be spawned without a shell, runs through `cmd.exe /d /s /c` with the path and
 * every argument escaped for cmd. A command that can't be found stays a plain spawn of the bare name, which fails
 * with ENOENT, so `exec` exits 127.
 */
export function planSpawn(argv: string[], opts: PlanOptions): SpawnPlan {
  const [command, ...args] = argv
  const plain: SpawnPlan = { file: command!, args, windowsVerbatimArguments: false }
  if (opts.platform !== 'win32') return plain
  const resolved = resolveWindowsCommand(command!, opts)
  if (resolved === undefined) return plain
  if (!/\.(?:bat|cmd)$/i.test(resolved)) return { ...plain, file: resolved }
  const twice = CMD_SHIM.test(resolved)
  const line = [escapeCommand(resolved), ...args.map((a) => escapeArgument(a, twice))].join(' ')
  return {
    file: envValue(opts.env, 'ComSpec') ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  }
}
