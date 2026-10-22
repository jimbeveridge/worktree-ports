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
  RESERVED_ENV_NAME,
  assertDefaultsOutsideRange,
  blockSize,
  findConfig,
  loadConfig,
  parseConfig,
  type WorktreePortsConfig,
} from '../src/config.ts'
import { DEFAULT_RANGE } from '../src/settings.ts'

const example = {
  $schema: 'https://unpkg.com/worktree-ports/schema.json',
  services: {
    api: { offset: 0, default: 8080 },
    web: { offset: 1, default: 3000 },
  },
  mainCheckout: 'default',
  env: {
    API_ADDR: '127.0.0.1:{api}',
    PORT: '{web}',
    API_ORIGIN: 'http://127.0.0.1:{api}',
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
  assert.equal(c.env.PORT, '{web}')
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
  ['an unknown env token', { ...minimal, env: { X: '{nope}' } }, /env\.X uses unknown token \{nope\}/],
  ['an unknown verify token', { ...minimal, verify: { url: '{nope}', field: 'f', expect: '{root}' } }, /verify\.url/],
  ['a bad service name', withServices({ '9api': { offset: 0, default: 8080 } }), /service name "9api"/],
  ['an env name with shell code', { ...minimal, env: { 'X=1; echo PWNED #': 'v' } }, /env name "X=1; echo PWNED #"/],
  ['an env name with a dash', { ...minimal, env: { 'MY-VAR': '{root}' } }, /env name "MY-VAR" must match/],
  ['an env name starting with a digit', { ...minimal, env: { '1PORT': '{root}' } }, /env name "1PORT"/],
  [
    'NODE_OPTIONS in env',
    { ...minimal, env: { NODE_OPTIONS: '--require ./x.js' } },
    /env name "NODE_OPTIONS" is not allowed/,
  ],
  ['PATH in env, in any case', { ...minimal, env: { Path: '{root}' } }, /env name "Path" is not allowed/],
  [
    'an LD_ variable in env',
    { ...minimal, env: { LD_PRELOAD: '{root}/x.so' } },
    /env name "LD_PRELOAD" is not allowed/,
  ],
  [
    'a DYLD_ variable in env',
    { ...minimal, env: { DYLD_INSERT_LIBRARIES: 'x' } },
    /"DYLD_INSERT_LIBRARIES" is not allowed/,
  ],
  ['a GIT_ variable in env', { ...minimal, env: { GIT_SSH_COMMAND: 'x' } }, /"GIT_SSH_COMMAND" is not allowed/],
  ['PYTHONPATH in env', { ...minimal, env: { PYTHONPATH: '{root}' } }, /"PYTHONPATH" is not allowed/],
  [
    "the tool's own variables in env",
    { ...minimal, env: { WORKTREE_PORTS: 'off' } },
    /"WORKTREE_PORTS" is not allowed/,
  ],
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

test('findConfig refuses a world-writable config', { skip: process.platform === 'win32' }, (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, CONFIG_FILE_NAME)
  writeFileSync(file, JSON.stringify(minimal))
  chmodSync(file, 0o666)
  assert.throws(
    () => findConfig(root),
    (err: Error) => err instanceof ConfigError && /writable by other users/.test(err.message),
  )
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
  // The schema's env name pattern is the parser's.
  assert.equal(schema.properties.env.propertyNames.pattern, ENV_NAME.source)
  parseConfig({ ...example, env: { _A1: '{root}' } })
  // ...and so is its list of names a config may not set.
  assert.equal(schema.properties.env.propertyNames.not.pattern, RESERVED_ENV_NAME.source)
})

test('parseConfig accepts ordinary names near the reserved ones', () => {
  for (const key of [
    'PORT',
    'API_PATH',
    'NODE_ENV_NAME',
    'PYTHON_API_URL',
    'MY_LD_HOST',
    'WORKTREE_ROOT',
    'HOMEPAGE_URL',
  ]) {
    parseConfig({ ...minimal, env: { [key]: '{root}' } })
  }
})

test('example/worktree-ports.json parses when present', { skip: !existsSync(examplePath()) }, () => {
  parseConfig(JSON.parse(readFileSync(examplePath(), 'utf8')), examplePath())
})

function examplePath(): string {
  return join(import.meta.dirname, '..', 'example', CONFIG_FILE_NAME)
}
