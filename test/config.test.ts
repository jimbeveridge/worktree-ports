import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, DEFAULT_FILE_NAME, DEFAULT_RANGE, loadConfig, parseConfig, usesMainPorts } from '../src/config.ts'

const minimal = { services: { api: { offset: 0 }, web: { offset: 1 } } }

test('applies defaults to a minimal config', () => {
  const c = parseConfig(minimal)
  assert.equal(c.fileName, DEFAULT_FILE_NAME)
  assert.deepEqual(c.range, DEFAULT_RANGE)
  assert.deepEqual(c.env, {})
  assert.equal(c.verify, undefined)
  assert.equal(usesMainPorts(c), false)
})

test('accepts a full config', () => {
  const c = parseConfig({
    fileName: 'api-port.txt',
    range: { min: 30000, max: 30090, step: 10 },
    services: { api: { offset: 0, mainPort: 8080 }, web: { offset: 1, mainPort: 3000 } },
    env: { PORT: '{api}', ORIGIN: 'http://localhost:{web}', ROOT: '{root}', NAME: '{name}', TOKEN: '{home}/t' },
    verify: { url: 'http://localhost:{api}/health', field: 'root', expect: '{root}' },
  })
  assert.equal(c.fileName, 'api-port.txt')
  assert.equal(usesMainPorts(c), true)
  assert.deepEqual(c.verify, { url: 'http://localhost:{api}/health', field: 'root', expect: '{root}' })
})

const rejects: Array<[string, unknown, RegExp]> = [
  ['non-object', 42, /expected a JSON object/],
  ['no services', { services: {} }, /at least one service/],
  ['offset >= step', { services: { api: { offset: 10 } } }, /offset must be in 0\.\.9/],
  ['duplicate offset', { services: { api: { offset: 0 }, web: { offset: 0 } } }, /offset 0 is used by another service/],
  ['reserved service name', { services: { root: { offset: 0 } } }, /reserved/],
  ['bad service name', { services: { 'my api': { offset: 0 } } }, /must match/],
  ['mainPort inside range', { services: { api: { offset: 0, mainPort: 20005 } } }, /inside the allocation range/],
  [
    'mainPort on some services only',
    { services: { api: { offset: 0, mainPort: 8080 }, web: { offset: 1 } } },
    /every service or on none/,
  ],
  [
    'range not a multiple of step',
    { range: { min: 20000, max: 20015, step: 10 }, services: minimal.services },
    /multiple of range.step/,
  ],
  ['range below 1024', { range: { min: 80, max: 90, step: 10 }, services: minimal.services }, />= 1024/],
  [
    'range past 65535',
    { range: { min: 65530, max: 65530, step: 10 }, services: minimal.services },
    /exceeds port 65535/,
  ],
  ['fileName with a slash', { fileName: 'a/b.txt', services: minimal.services }, /bare file name/],
  ['unknown env token', { services: minimal.services, env: { X: '{nope}' } }, /env\.X uses unknown token \{nope\}/],
  ['non-string env value', { services: minimal.services, env: { X: 1 } }, /env\.X must be a string/],
  [
    'unknown verify token',
    { services: minimal.services, verify: { url: '{nope}', field: 'f', expect: 'e' } },
    /verify\.url uses unknown token/,
  ],
]

for (const [label, raw, pattern] of rejects) {
  test(`rejects: ${label}`, () => {
    assert.throws(
      () => parseConfig(raw),
      (err: unknown) => err instanceof ConfigError && pattern.test(err.message),
    )
  })
}

test('loadConfig names the file in parse and read errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worktree-ports-config-'))
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{ not json')
  assert.throws(
    () => loadConfig(bad),
    (e: unknown) => e instanceof ConfigError && e.message.includes(bad) && /invalid JSON/.test(e.message),
  )
  const missing = join(dir, 'missing.json')
  assert.throws(
    () => loadConfig(missing),
    (e: unknown) => e instanceof ConfigError && e.message.includes(missing),
  )
  const good = join(dir, 'good.json')
  writeFileSync(good, JSON.stringify(minimal))
  assert.deepEqual(Object.keys(loadConfig(good).services), ['api', 'web'])
})
