import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolvePorts } from '../src/resolve.ts'
import { makeRepo } from './helpers/repo.ts'

const CONFIG = {
  fileName: 'port.txt',
  range: { min: 20000, max: 20020, step: 10 },
  services: { api: { offset: 0, mainPort: 8080 }, web: { offset: 1, mainPort: 3000 } },
  env: { PORT: '{api}', ORIGIN: 'http://localhost:{web}', ROOT: '{root}', TOKEN: '{home}/.tool/token-{name}.json' },
  verify: { url: 'http://localhost:{api}/health', field: 'root', expect: '{root}' },
}

test('main checkout resolves mainPorts and renders env + verify', { skip: 'rewired in Task 5/6' }, (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const configPath = join(repo.dir, 'config.json')
  writeFileSync(configPath, JSON.stringify(CONFIG))
  const r = resolvePorts({ cwd: repo.main, configPath, home: '/home/me' })
  assert.deepEqual(r.reservation, { source: 'main' })
  assert.deepEqual(r.ports, { api: 8080, web: 3000 })
  assert.deepEqual(r.env, {
    PORT: '8080',
    ORIGIN: 'http://localhost:3000',
    ROOT: repo.main,
    TOKEN: '/home/me/.tool/token-main.json',
  })
  assert.deepEqual(r.verify, { url: 'http://localhost:8080/health', field: 'root', expect: repo.main })
})

test(
  'linked worktree resolves base + offset and reads worktree-ports.json from its root by default',
  { skip: 'rewired in Task 5/6' },
  (t) => {
    const repo = makeRepo()
    t.after(() => repo.cleanup())
    const wt = repo.addWorktree('feat')
    writeFileSync(join(wt, 'worktree-ports.json'), JSON.stringify(CONFIG))
    const r = resolvePorts({ cwd: wt, home: '/home/me' })
    assert.deepEqual(r.reservation, { source: 'allocated', base: 20000 })
    assert.deepEqual(r.ports, { api: 20000, web: 20001 })
    assert.equal(r.env.PORT, '20000')
    assert.equal(r.env.TOKEN, '/home/me/.tool/token-feat.json')
    assert.equal(r.location.name, 'feat')
  },
)
