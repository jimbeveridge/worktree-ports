import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { DEFAULT_RANGE, SettingsError, loadSettings, settingsPath, stateDir } from '../src/settings.ts'

const tmp = realpathSync(tmpdir())

test('stateDir honours WORKTREE_PORTS_STATE_DIR, then XDG_STATE_HOME, then ~/.local/state', () => {
  assert.equal(stateDir({ WORKTREE_PORTS_STATE_DIR: '/x/state', XDG_STATE_HOME: '/y' }, 'linux'), '/x/state')
  assert.equal(stateDir({ XDG_STATE_HOME: '/y', HOME: '/home/me' }, 'linux'), join('/y', 'worktree-ports'))
  assert.equal(stateDir({ HOME: '/home/me' }, 'linux'), join('/home/me', '.local', 'state', 'worktree-ports'))
})

test('stateDir on win32 uses LOCALAPPDATA', () => {
  assert.equal(
    stateDir({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32'),
    'C:\\Users\\me\\AppData\\Local\\worktree-ports',
  )
})

test('stateDir refuses a path outside the temp dir under test', () => {
  const env = { WORKTREE_PORTS_UNDER_TEST: '1', HOME: '/home/me' }
  assert.throws(() => stateDir(env, 'linux'), /WORKTREE_PORTS_UNDER_TEST/)
  assert.throws(() => stateDir({ ...env, XDG_STATE_HOME: '/home/me/.local/state' }, 'linux'), /not under/)
  assert.equal(
    stateDir({ ...env, WORKTREE_PORTS_STATE_DIR: join(tmp, 'wtp-x', 'state') }, 'linux'),
    join(tmp, 'wtp-x', 'state'),
  )
  assert.throws(
    () => stateDir({ ...env, WORKTREE_PORTS_STATE_DIR: join(tmp, '..', 'elsewhere') }, 'linux'),
    /not under/,
  )
})

test('the guard compares the real path even when a top-level ancestor does not exist', () => {
  const env = { WORKTREE_PORTS_UNDER_TEST: '1' }
  const mangled = join(sep, `z${tmp.split(sep)[1]}`, ...tmp.split(sep).slice(2), 'x')
  assert.throws(() => stateDir({ ...env, WORKTREE_PORTS_STATE_DIR: mangled }, 'linux'), /not under/)
})

test('settingsPath honours XDG_CONFIG_HOME, then ~/.config, and APPDATA on win32', () => {
  assert.equal(
    settingsPath({ XDG_CONFIG_HOME: '/c', HOME: '/home/me' }, 'linux'),
    join('/c', 'worktree-ports', 'config.json'),
  )
  assert.equal(
    settingsPath({ HOME: '/home/me' }, 'linux'),
    join('/home/me', '.config', 'worktree-ports', 'config.json'),
  )
  assert.equal(
    settingsPath({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32'),
    'C:\\Users\\me\\AppData\\Roaming\\worktree-ports\\config.json',
  )
})

test('settingsPath refuses a path outside the temp dir under test', () => {
  const env = { WORKTREE_PORTS_UNDER_TEST: '1', HOME: '/home/me' }
  assert.throws(() => settingsPath(env, 'linux'), /WORKTREE_PORTS_UNDER_TEST/)
  assert.doesNotThrow(() => settingsPath({ ...env, XDG_CONFIG_HOME: join(tmp, 'wtp-cfg') }, 'linux'))
})

test('the live state dir and settings path under the test preload are inside the temp dir', () => {
  assert.ok(stateDir().startsWith(tmp))
  assert.ok(settingsPath().startsWith(tmp))
})

function settingsFile(t: { after(fn: () => void): void }, body: unknown): string {
  const dir = mkdtempSync(join(tmp, 'wtp-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'config.json')
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
  return file
}

test('loadSettings: a missing file means the default range', (t) => {
  const dir = mkdtempSync(join(tmp, 'wtp-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.deepEqual(loadSettings(join(dir, 'nope.json')), { range: DEFAULT_RANGE })
  assert.deepEqual(DEFAULT_RANGE, { min: 20000, max: 32759 })
})

test('loadSettings loads a valid range, and an empty object means defaults', (t) => {
  assert.deepEqual(loadSettings(settingsFile(t, { range: { min: 30000, max: 30999 } })), {
    range: { min: 30000, max: 30999 },
  })
  assert.deepEqual(loadSettings(settingsFile(t, {})), { range: DEFAULT_RANGE })
})

const bad: Array<[string, unknown, RegExp]> = [
  ['min below 1024', { range: { min: 1000, max: 30000 } }, /range\.min must be >= 1024/],
  ['min not a multiple of 10', { range: { min: 20005, max: 30000 } }, /multiple of 10/],
  ['max above 65535', { range: { min: 20000, max: 70000 } }, /range\.max must be <= 65535/],
  ['max below min + 9', { range: { min: 20000, max: 20008 } }, /range\.max must be at least/],
  ['an unknown top-level key', { range: { min: 20000, max: 30000 }, extra: 1 }, /unknown field "extra"/],
  ['an unknown range key', { range: { min: 20000, max: 30000, step: 10 } }, /unknown field "range\.step"/],
  ['a non-integer min', { range: { min: '20000', max: 30000 } }, /range\.min must be an integer/],
  ['invalid JSON', '{ nope', /invalid JSON/],
]
for (const [what, body, pattern] of bad) {
  test(`loadSettings rejects ${what}`, (t) => {
    assert.throws(
      () => loadSettings(settingsFile(t, body)),
      (e: unknown) => e instanceof SettingsError && pattern.test(e.message),
    )
  })
}

test('loadSettings accepts max = min + 9', (t) => {
  assert.deepEqual(loadSettings(settingsFile(t, { range: { min: 20000, max: 20009 } })).range, {
    min: 20000,
    max: 20009,
  })
})
