// Installs a packed worktree-ports tarball into a fresh git repo with a linked worktree and checks the
// installed CLI from both checkouts. Plain JS so it runs on Node 20: `node scripts/smoke.mjs <tarball>`.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const tarball = process.argv[2] ? resolve(process.argv[2]) : undefined
if (!tarball) {
  console.error('usage: node scripts/smoke.mjs <tarball>')
  process.exit(2)
}

const win = process.platform === 'win32'
const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'worktree-ports-smoke-')))
const stateDir = join(root, 'state')
mkdirSync(stateDir)

const env = { ...process.env, WORKTREE_PORTS_STATE_DIR: stateDir }
delete env.CI
delete env.WORKTREE_PORTS
const gitEnv = {
  ...env,
  GIT_AUTHOR_NAME: 'Smoke',
  GIT_AUTHOR_EMAIL: 'smoke@example.com',
  GIT_COMMITTER_NAME: 'Smoke',
  GIT_COMMITTER_EMAIL: 'smoke@example.com',
}

function run(cmd, args, cwd, e = env) {
  // Node 20+ refuses to spawn npm/npx (.cmd shims) on Windows without a shell.
  const shell = win && (cmd === 'npm' || cmd === 'npx')
  const res = execFileSync(cmd, args, { cwd, env: e, encoding: 'utf8', shell, stdio: ['ignore', 'pipe', 'pipe'] })
  return res
}

function check(cond, message) {
  if (!cond) throw new Error(message)
}

function ports(cwd) {
  const shown = JSON.parse(run('npx', ['worktree-ports', 'show', '--json'], cwd))
  return shown.ports
}

try {
  const main = join(root, 'repo')
  const linked = join(root, 'linked')
  mkdirSync(main)
  const git = (args, cwd = main) =>
    run('git', ['-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...args], cwd, gitEnv)
  git(['init', '-q'])
  const config = {
    services: { api: { offset: 0, default: 8080 }, web: { offset: 1, default: 3000 } },
    env: { WORKTREE_API_PORT: '{api}', WORKTREE_WEB_PORT: '{web}' },
  }
  writeFileSync(join(main, 'worktree-ports.json'), JSON.stringify(config))
  git(['add', 'worktree-ports.json'])
  git(['commit', '-q', '-m', 'init'])
  git(['worktree', 'add', '-q', linked, '-b', 'feature'])

  for (const dir of [main, linked]) {
    run('npm', ['init', '-y'], dir)
    run('npm', ['i', '--no-audit', '--no-fund', tarball], dir)
  }

  const m = ports(main)
  check(m.api === 8080 && m.web === 3000, `main checkout should get the defaults, got ${JSON.stringify(m)}`)
  const w = ports(linked)
  check(w.api >= 20000 && w.web >= 20000, `worktree ports should be >= 20000, got ${JSON.stringify(w)}`)
  check(w.api !== m.api && w.web !== m.web, `worktree ports should differ from main: ${JSON.stringify(w)}`)

  for (const dir of [main, linked]) {
    const out = run('npx', ['worktree-ports', 'env'], dir)
    check(out.includes('export'), `env output should contain "export" in ${dir}:\n${out}`)
    // Run the installed bin without a shell: under `shell: true` on Windows the -e script would lose its quoting.
    run(
      process.execPath,
      [
        join(dir, 'node_modules', 'worktree-ports', 'dist', 'bin', 'worktree-ports.js'),
        'exec',
        '--port',
        'web',
        '--',
        'node',
        '-e',
        'process.exit(process.env.WORKTREE_API_PORT && process.env.PORT ? 0 : 1)',
      ],
      dir,
    )
    // exec must start a .cmd shim too (npm is npm.cmd on Windows), as the README's `exec -- npm run dev` needs.
    const npmVersion = run(
      process.execPath,
      [
        join(dir, 'node_modules', 'worktree-ports', 'dist', 'bin', 'worktree-ports.js'),
        'exec',
        '--',
        'npm',
        '--version',
      ],
      dir,
    )
    check(/^\d+\.\d+\.\d+/.test(npmVersion.trim()), `exec -- npm --version printed ${JSON.stringify(npmVersion)}`)
  }

  const claims = JSON.parse(run('npx', ['worktree-ports', 'list', '--json'], linked))
  check(
    Array.isArray(claims) && claims.length === 1,
    `list should show exactly one claim, got ${JSON.stringify(claims)}`,
  )

  console.log('smoke ok')
} catch (err) {
  const detail = err && typeof err === 'object' && 'stderr' in err ? `\n${err.stderr}` : ''
  console.error(`smoke failed: ${err instanceof Error ? err.message : err}${detail}`)
  process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
}
