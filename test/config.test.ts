import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync as symlink,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONFIG_FILE_NAME,
  ConfigError,
  ENV_NAME,
  assertDefaultsOutsideRange,
  blockSize,
  findConfig,
  loadConfig,
  parseConfig,
  type WorktreePortsConfig,
} from '../src/config.ts'
import { DEFAULT_RANGE } from '../src/settings.ts'

const POSIX_ONLY = process.platform === 'win32' ? 'POSIX ownership and modes' : false
const example = {
  $schema: 'https://unpkg.com/worktree-ports/schema.json',
  services: {
    api: { offset: 0, default: 8080 },
    web: { offset: 1, default: 3000 },
  },
  mainCheckout: 'default',
  env: {
    WORKTREE_API_ADDR: '127.0.0.1:{api}',
    WORKTREE_API_ORIGIN: 'http://127.0.0.1:{api}',
    WORKTREE_ROOT: '{root}',
  },
  verify: { url: 'http://127.0.0.1:{api}/__worktree', field: 'worktreeRoot', expect: '{root}' },
}

const minimal = { services: { api: { offset: 0, default: 8080 } } }

function withServices(services: unknown): unknown {
  return { services }
}

test('parseConfig accepts the spec example verbatim', () => {
  const c = parseConfig(example)
  assert.deepEqual(c.services, { api: { offset: 0, default: 8080 }, web: { offset: 1, default: 3000 } })
  assert.equal(c.mainCheckout, 'default')
  assert.equal(c.env.WORKTREE_API_ORIGIN, 'http://127.0.0.1:{api}')
  assert.deepEqual(c.verify, { url: 'http://127.0.0.1:{api}/__worktree', field: 'worktreeRoot', expect: '{root}' })
})

test('parseConfig defaults mainCheckout and env, and ignores $schema', () => {
  const c = parseConfig({ $schema: 'whatever', ...minimal })
  assert.equal(c.mainCheckout, 'default')
  assert.deepEqual(c.env, {})
  assert.equal(c.verify, undefined)
  assert.equal(parseConfig({ ...minimal, mainCheckout: 'claim' }).mainCheckout, 'claim')
})

const rejects: Array<[string, unknown, RegExp]> = [
  ['a missing default', withServices({ api: { offset: 0 } }), /services\.api\.default is required/],
  ['a default of 0', withServices({ api: { offset: 0, default: 0 } }), /services\.api\.default must be 1\.\.65535/],
  ['a default above 65535', withServices({ api: { offset: 0, default: 65536 } }), /services\.api\.default/],
  [
    'a duplicate offset',
    withServices({ api: { offset: 1, default: 8080 }, web: { offset: 1, default: 3000 } }),
    /services\.web\.offset 1 is already used by service "api"/,
  ],
  ['a negative offset', withServices({ api: { offset: -1, default: 8080 } }), /services\.api\.offset must be >= 0/],
  [
    'a fractional offset',
    withServices({ api: { offset: 0.5, default: 8080 } }),
    /services\.api\.offset must be an integer/,
  ],
  ['mainCheckout "other"', { ...minimal, mainCheckout: 'other' }, /mainCheckout must be "default" or "claim"/],
  ['an unknown top-level field', { ...minimal, range: { min: 1, max: 2 } }, /unknown field "range"/],
  [
    'an unknown service field',
    withServices({ api: { offset: 0, default: 8080, mainPort: 8080 } }),
    /unknown field "services\.api\.mainPort"/,
  ],
  [
    'an unknown env token',
    { ...minimal, env: { WORKTREE_X: '{nope}' } },
    /env\.WORKTREE_X uses unknown token \{nope\}/,
  ],
  ['an unknown verify token', { ...minimal, verify: { url: '{nope}', field: 'f', expect: '{root}' } }, /verify\.url/],
  ['a bad service name', withServices({ '9api': { offset: 0, default: 8080 } }), /service name "9api"/],
  [
    'an env name with shell code',
    { ...minimal, env: { 'WORKTREE_X=1; echo PWNED #': 'v' } },
    /env name "WORKTREE_X=1; echo PWNED #"/,
  ],
  [
    'an env name without the WORKTREE_ prefix',
    { ...minimal, env: { API_ORIGIN: '{root}' } },
    /env name "API_ORIGIN" must start with WORKTREE_/,
  ],
  [
    'NODE_OPTIONS in env',
    { ...minimal, env: { NODE_OPTIONS: '--require ./x.js' } },
    /env name "NODE_OPTIONS" must start with WORKTREE_/,
  ],
  ['PORT in env', { ...minimal, env: { PORT: '{api}' } }, /env name "PORT".*exec --port/],
  ['a lower-case prefix', { ...minimal, env: { worktree_root: '{root}' } }, /env name "worktree_root"/],
  ['the bare prefix', { ...minimal, env: { WORKTREE_: '{root}' } }, /env name "WORKTREE_"/],
  ["the tool's own WORKTREE_PORTS names", { ...minimal, env: { WORKTREE_PORTS: 'off' } }, /env name "WORKTREE_PORTS"/],
  ['a WORKTREE_PORTS_ name', { ...minimal, env: { WORKTREE_PORTS_ACTIVE: '0' } }, /env name "WORKTREE_PORTS_ACTIVE"/],
  ['a reserved service name', withServices({ root: { offset: 0, default: 8080 } }), /"root" is reserved/],
  ['no services', { services: {} }, /services must be an object/],
  ['a non-object', [], /expected a JSON object/],
]
for (const [what, input, pattern] of rejects) {
  test(`parseConfig rejects ${what}`, () => {
    assert.throws(
      () => parseConfig(input, 'my.json'),
      (err: unknown) => err instanceof ConfigError && pattern.test(err.message) && err.message.startsWith('my.json:'),
    )
  })
}

test('blockSize rounds max offset + 1 up to a multiple of 10', () => {
  const sized = (...offsets: number[]): WorktreePortsConfig =>
    parseConfig(withServices(Object.fromEntries(offsets.map((o, i) => [`s${i}`, { offset: o, default: 8000 + i }]))))
  assert.equal(blockSize(sized(0, 1, 2)), 10)
  assert.equal(blockSize(sized(0, 9)), 10)
  assert.equal(blockSize(sized(0, 10)), 20)
  assert.equal(blockSize(sized(0, 14)), 20)
})

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'wtp-config-')))
  return dir
}

test('findConfig walks up and the nearest file wins', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const deep = join(root, 'a', 'b', 'c')
  mkdirSync(deep, { recursive: true })
  writeFileSync(join(root, 'a', CONFIG_FILE_NAME), JSON.stringify(minimal))
  assert.equal(findConfig(deep), join(root, 'a', CONFIG_FILE_NAME))
  writeFileSync(join(root, 'a', 'b', CONFIG_FILE_NAME), JSON.stringify(minimal))
  assert.equal(findConfig(deep), join(root, 'a', 'b', CONFIG_FILE_NAME))
})

test('findConfig works without .git and returns undefined when there is no config', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(existsSync(join(root, '.git')), false)
  // Nothing between here and the filesystem root, as long as the temp dir has no config above it.
  if (findConfig(tmpdir()) === undefined) assert.equal(findConfig(root), undefined)
  writeFileSync(join(root, CONFIG_FILE_NAME), JSON.stringify(minimal))
  assert.equal(findConfig(root), join(root, CONFIG_FILE_NAME))
})

test('findConfig stops at a nested repository or submodule, whose .git is a file', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, CONFIG_FILE_NAME), JSON.stringify(minimal))
  const sub = join(root, 'vendor', 'lib')
  mkdirSync(join(sub, 'src'), { recursive: true })
  writeFileSync(join(sub, '.git'), 'gitdir: ../../.git/modules/lib\n')
  // The outer repository's config doesn't apply inside the submodule.
  assert.equal(findConfig(join(sub, 'src')), undefined)
  assert.equal(findConfig(join(root, 'vendor')), join(root, CONFIG_FILE_NAME))
})

test('findConfig stops at the git worktree top-level', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(root, CONFIG_FILE_NAME), JSON.stringify(minimal))
  assert.equal(findConfig(join(repo, 'src')), undefined)
  // A linked worktree's .git is a file; it is a boundary too.
  const wt = join(root, 'wt')
  mkdirSync(wt)
  writeFileSync(join(wt, '.git'), 'gitdir: /elsewhere\n')
  assert.equal(findConfig(wt), undefined)
  writeFileSync(join(repo, CONFIG_FILE_NAME), JSON.stringify(minimal))
  assert.equal(findConfig(join(repo, 'src')), join(repo, CONFIG_FILE_NAME))
})

test('findConfig outside a checkout refuses a config writable by other users', { skip: POSIX_ONLY }, (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, CONFIG_FILE_NAME)
  writeFileSync(file, JSON.stringify(minimal))
  chmodSync(file, 0o666)
  assert.throws(
    () => findConfig(root),
    (err: Error) => err instanceof ConfigError && /writable by other users.*--config/.test(err.message),
  )
  // Group-writable is fine: many systems create files that way for a user's private group.
  chmodSync(file, 0o664)
  assert.equal(findConfig(root), file)
})

test(
  'findConfig outside a checkout refuses a directory others can write, unless it is sticky',
  { skip: POSIX_ONLY },
  (t) => {
    const root = scratch()
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const dir = join(root, 'shared')
    mkdirSync(dir)
    writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify(minimal))
    chmodSync(dir, 0o777)
    assert.throws(() => findConfig(dir), /could replace it/)
    chmodSync(dir, 0o1777) // like /tmp: others can't replace a file they don't own
    assert.equal(findConfig(dir), join(dir, CONFIG_FILE_NAME))
  },
)

test('findConfig outside a checkout refuses a config owned by another user', { skip: POSIX_ONLY }, (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, CONFIG_FILE_NAME), JSON.stringify(minimal))
  const uid = process.getuid!()
  let fake = uid + 1
  t.mock.method(process as { getuid(): number }, 'getuid', () => fake)
  assert.throws(() => findConfig(root), /owned by another user.*--config/)
  // Under sudo the process is root, and SUDO_UID names the invoking user, who owns the file.
  fake = 0
  const before = process.env.SUDO_UID
  t.after(() => {
    if (before === undefined) delete process.env.SUDO_UID
    else process.env.SUDO_UID = before
  })
  process.env.SUDO_UID = String(uid)
  assert.equal(findConfig(root), join(root, CONFIG_FILE_NAME))
})

test('findConfig inside a checkout skips the ownership check', { skip: POSIX_ONLY }, (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, 'src'))
  const file = join(root, 'src', CONFIG_FILE_NAME)
  writeFileSync(file, JSON.stringify(minimal))
  chmodSync(file, 0o666) // as on a Windows drive mounted in WSL
  assert.equal(findConfig(join(root, 'src')), file)
})

test("findConfig doesn't let another user's .git switch the check off", { skip: POSIX_ONLY }, (t) => {
  // Another user plants /tmp/.git beside /tmp/worktree-ports.json; this user runs from /tmp/mine.
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, 'mine'))
  writeFileSync(join(root, CONFIG_FILE_NAME), JSON.stringify(minimal))
  const uid = process.getuid!()
  t.mock.method(process as { getuid(): number }, 'getuid', () => uid + 1)
  assert.throws(() => findConfig(join(root, 'mine')), /owned by another user/)
})

test('findConfig resolves symlinks', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'real'))
  writeFileSync(join(root, 'real', CONFIG_FILE_NAME), JSON.stringify(minimal))
  try {
    symlink(join(root, 'real'), join(root, 'link'))
  } catch {
    return // symlinks unavailable (Windows without privilege)
  }
  assert.equal(findConfig(join(root, 'link')), join(root, 'real', CONFIG_FILE_NAME))
})

test('loadConfig reports unreadable and invalid files with the path', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bad = join(root, 'bad.json')
  writeFileSync(bad, '{ nope')
  assert.throws(() => loadConfig(join(root, 'missing.json')), /cannot read .*missing\.json/)
  assert.throws(
    () => loadConfig(bad),
    (e: unknown) => e instanceof ConfigError && e.message.startsWith(`${bad}: invalid JSON`),
  )
  writeFileSync(bad, JSON.stringify(minimal))
  assert.equal(loadConfig(bad).services.api?.default, 8080)
})

test('assertDefaultsOutsideRange names the service and the range', () => {
  const inside = parseConfig(withServices({ api: { offset: 0, default: 20005 } }))
  assert.throws(
    () => assertDefaultsOutsideRange(inside, DEFAULT_RANGE, 'my.json'),
    (e: unknown) =>
      e instanceof ConfigError && /my\.json/.test(e.message) && /api/.test(e.message) && /20000-32759/.test(e.message),
  )
  assert.doesNotThrow(() => assertDefaultsOutsideRange(parseConfig(minimal), DEFAULT_RANGE, 'my.json'))
})

test("schema.json's properties match the fields parseConfig accepts", () => {
  const schema = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'schema.json'), 'utf8'))
  assert.deepEqual(Object.keys(schema.properties).sort(), ['$schema', 'env', 'mainCheckout', 'services', 'verify'])
  const service = schema.properties.services.additionalProperties
  assert.deepEqual(Object.keys(service.properties).sort(), ['default', 'offset'])
  assert.deepEqual(Object.keys(schema.properties.verify.properties).sort(), ['expect', 'field', 'url'])
  assert.equal(schema.additionalProperties, false)
  assert.equal(service.additionalProperties, false)
  assert.deepEqual(schema.required, ['services'])
  // Everything the schema lists is accepted, and one extra of each kind is rejected.
  parseConfig(example)
  assert.throws(() => parseConfig({ ...example, extra: 1 }), ConfigError)
  // The schema states the parser's env name rule without a lookahead, which not every validator supports.
  const names = schema.properties.env.propertyNames
  const bySchema = (k: string) => new RegExp(names.pattern).test(k) && !new RegExp(names.not.pattern).test(k)
  for (const k of [
    'WORKTREE_ROOT',
    'WORKTREE_PORT',
    'WORKTREE_PORTAL',
    'WORKTREE_PORTS',
    'WORKTREE_PORTS_X',
    'WORKTREE_',
    'PORT',
    'worktree_x',
  ]) {
    assert.equal(bySchema(k), ENV_NAME.test(k), k)
  }
  parseConfig({ ...example, env: { WORKTREE_A1: '{root}' } })
})

test('parseConfig accepts WORKTREE_ names, including ones close to the reserved prefix', () => {
  for (const key of ['WORKTREE_ROOT', 'WORKTREE_API_ORIGIN', 'WORKTREE_PORT', 'WORKTREE_PORTAL_URL', 'WORKTREE_9']) {
    parseConfig({ ...minimal, env: { [key]: '{root}' } })
  }
})

test('example/worktree-ports.json parses when present', { skip: !existsSync(examplePath()) }, () => {
  parseConfig(JSON.parse(readFileSync(examplePath(), 'utf8')), examplePath())
})

function examplePath(): string {
  return join(import.meta.dirname, '..', 'example', CONFIG_FILE_NAME)
}
