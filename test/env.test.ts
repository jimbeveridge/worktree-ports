import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError } from '../src/config.ts'
import { mergeEnv, renderTemplate } from '../src/env.ts'

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
