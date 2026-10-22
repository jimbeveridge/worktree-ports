import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError } from '../src/config.ts'
import { PORT_MARKER, buildChildEnv, mergeEnv, renderTemplate } from '../src/env.ts'

const ctx = { root: '/r', name: 'feat', home: '/h', ports: { api: 20000, web: 20001 } }

test('renders builtin and service tokens', () => {
  assert.equal(
    renderTemplate('http://localhost:{api},http://localhost:{web} {root} {name} {home}/x', ctx),
    'http://localhost:20000,http://localhost:20001 /r feat /h/x',
  )
  assert.equal(renderTemplate('no tokens', ctx), 'no tokens')
})

test('an unknown token throws ConfigError', () => {
  assert.throws(() => renderTemplate('{nope}', ctx), ConfigError)
})

test('mergeEnv fills only unset variables and reports both lists', () => {
  const r = mergeEnv({ PORT: '9999', HOME: '/h' }, { PORT: '20000', ORIGIN: 'http://x' })
  assert.deepEqual(r.env, { PORT: '9999', HOME: '/h', ORIGIN: 'http://x' })
  assert.deepEqual(r.applied, ['ORIGIN'])
  assert.deepEqual(r.kept, ['PORT'])
})

test('mergeEnv treats an empty string as set', () => {
  assert.deepEqual(mergeEnv({ PORT: '' }, { PORT: '1' }).kept, ['PORT'])
})

const web = { service: 'web', port: 27421 }

test('buildChildEnv without a port behaves like mergeEnv', () => {
  const { env, outcomes } = buildChildEnv({ A: 'x' }, { A: 'y', B: 'z' })
  assert.equal(env.A, 'x')
  assert.equal(env.B, 'z')
  assert.equal('PORT' in env, false)
  assert.equal(PORT_MARKER in env, false)
  assert.deepEqual(outcomes, [
    { key: 'A', action: 'kept', value: 'x', rendered: 'y' },
    { key: 'B', action: 'set', value: 'z', rendered: 'z' },
  ])
})

test('--port sets PORT and the marker when PORT is unset', () => {
  const { env, outcomes } = buildChildEnv({}, {}, web)
  assert.equal(env.PORT, '27421')
  assert.equal(env.WORKTREE_PORTS_PORT, '27421')
  assert.deepEqual(
    outcomes.map((o) => `${o.action} ${o.key}`),
    ['set PORT', 'set WORKTREE_PORTS_PORT'],
  )
})

test('--port replaces a PORT an outer exec set', () => {
  const { env, outcomes } = buildChildEnv({ PORT: '27420', WORKTREE_PORTS_PORT: '27420' }, {}, web)
  assert.equal(env.PORT, '27421')
  assert.equal(env.WORKTREE_PORTS_PORT, '27421')
  assert.deepEqual(outcomes, [
    { key: 'PORT', action: 'replaced', value: '27421', rendered: '27421', previous: '27420' },
    { key: 'WORKTREE_PORTS_PORT', action: 'replaced', value: '27421', rendered: '27421', previous: '27420' },
  ])
})

test('--port keeps a pinned PORT', () => {
  const { env, outcomes } = buildChildEnv({ PORT: '9999' }, {}, web)
  assert.equal(env.PORT, '9999')
  assert.equal(PORT_MARKER in env, false)
  assert.deepEqual(outcomes, [{ key: 'PORT', action: 'kept', value: '9999', rendered: '27421' }])
})

test('--port keeps PORT when the marker disagrees', () => {
  const { env, outcomes } = buildChildEnv({ PORT: '9999', WORKTREE_PORTS_PORT: '27420' }, {}, web)
  assert.equal(env.PORT, '9999')
  assert.equal(env.WORKTREE_PORTS_PORT, '27420')
  assert.deepEqual(
    outcomes.map((o) => o.key),
    ['PORT'],
  )
})

test('--port wins over a rendered PORT', () => {
  const { env, outcomes } = buildChildEnv({}, { PORT: '8080', X: '1' }, web)
  assert.equal(env.PORT, '27421')
  assert.equal(env.X, '1')
  assert.equal(outcomes.filter((o) => o.key === 'PORT').length, 1)
})
