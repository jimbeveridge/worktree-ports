import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planSpawn, resolveWindowsCommand, type PlanOptions } from '../src/command.ts'

const files = new Set([
  'C:\\Program Files\\nodejs\\node.exe',
  'C:\\Program Files\\nodejs\\npm.cmd',
  'C:\\app\\node_modules\\.bin\\vite.cmd',
  'C:\\app\\tools\\build.bat',
  'C:\\app\\local.cmd',
  // Planted in the checkout: a bare `node` or `npm` must never pick these up.
  'C:\\app\\node.exe',
  'C:\\app\\npm.cmd',
])
const win = (env: Record<string, string> = {}): PlanOptions => ({
  platform: 'win32',
  env: { Path: 'C:\\app\\node_modules\\.bin;C:\\Program Files\\nodejs', PATHEXT: '.COM;.EXE;.BAT;.CMD', ...env },
  cwd: 'C:\\app',
  isFile: (p) => files.has(p),
})

test('planSpawn spawns argv unchanged off Windows', () => {
  assert.deepEqual(planSpawn(['npm', 'run', 'dev'], { platform: 'darwin', env: {}, cwd: '/x', isFile: () => true }), {
    file: 'npm',
    args: ['run', 'dev'],
    windowsVerbatimArguments: false,
  })
})

test('resolveWindowsCommand searches PATH with PATHEXT, ignoring env-name case', () => {
  assert.equal(resolveWindowsCommand('npm', win()), 'C:\\Program Files\\nodejs\\npm.cmd')
  // A bare name is never taken from the current directory, which a checkout controls; name it explicitly.
  assert.equal(resolveWindowsCommand('local', win()), undefined)
  assert.equal(resolveWindowsCommand('.\\local', win()), 'C:\\app\\local.cmd')
  assert.equal(resolveWindowsCommand('npm.cmd', win()), 'C:\\Program Files\\nodejs\\npm.cmd')
  assert.equal(resolveWindowsCommand('tools\\build', win()), 'C:\\app\\tools\\build.bat')
  assert.equal(resolveWindowsCommand('nope', win()), undefined)
  assert.equal(resolveWindowsCommand('npm', win({ PATHEXT: '.EXE' })), undefined)
})

test('planSpawn spawns a Windows .exe, or an unknown command, without a shell', () => {
  // The resolved path, not the bare name: Windows would search the current directory first.
  assert.deepEqual(planSpawn(['node', '-e', 'x y'], win()), {
    file: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['-e', 'x y'],
    windowsVerbatimArguments: false,
  })
  // Not found: a plain spawn fails with ENOENT, so exec still exits 127.
  assert.equal(planSpawn(['nope'], win()).file, 'nope')
})

test('planSpawn runs a Windows .cmd through cmd.exe with every argument escaped', () => {
  assert.deepEqual(planSpawn(['npm', 'run', 'dev'], win({ ComSpec: 'C:\\Windows\\system32\\cmd.exe' })), {
    file: 'C:\\Windows\\system32\\cmd.exe',
    args: ['/d', '/s', '/c', '"C:\\Program^ Files\\nodejs\\npm.cmd ^"run^" ^"dev^""'],
    windowsVerbatimArguments: true,
  })
  // Quotes, trailing backslashes and cmd metacharacters (& % space) arrive literally; ComSpec defaults to cmd.exe.
  const plan = planSpawn(['build', 'a "b"', 'c\\', '50% & x'], win({ Path: 'C:\\app\\tools' }))
  assert.equal(plan.file, 'cmd.exe')
  assert.equal(plan.args[3], '"C:\\app\\tools\\build.bat ^"a^ \\^"b\\^"^" ^"c\\\\^" ^"50^%^ ^&^ x^""')
})

test('planSpawn escapes twice for a node_modules/.bin shim', () => {
  const plan = planSpawn(['vite', '--host', 'a&b'], win())
  assert.equal(plan.args[3], '"C:\\app\\node_modules\\.bin\\vite.cmd ^^^"--host^^^" ^^^"a^^^&b^^^""')
})

test('resolveWindowsCommand skips relative PATH entries, which would search the current directory', () => {
  assert.equal(resolveWindowsCommand('local', win({ Path: '.;tools;C:\\Program Files\\nodejs' })), undefined)
  assert.equal(
    resolveWindowsCommand('npm', win({ Path: '.;C:\\Program Files\\nodejs' })),
    'C:\\Program Files\\nodejs\\npm.cmd',
  )
})
