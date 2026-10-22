import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { resolvePorts } from '../src/resolve.ts'
import { isListening, probe, serviceStatus } from '../src/status.ts'
import { makeRepo } from './helpers/repo.ts'

async function listen(host: string, body = '{}', type = 'application/json'): Promise<{ port: number; server: Server }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': type })
    res.end(body)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => resolve())
  })
  return { port: (server.address() as AddressInfo).port, server }
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()))

async function freePort(): Promise<number> {
  const { port, server } = await listen('127.0.0.1')
  await close(server)
  return port
}

test('a closed port is not listening', async () => {
  const port = await freePort()
  assert.equal(await probe(port, '127.0.0.1'), false)
  assert.equal(await isListening(port), false)
})

test('an IPv4 loopback listener is listening', async (t) => {
  const { port, server } = await listen('127.0.0.1')
  t.after(() => close(server))
  assert.equal(await isListening(port), true)
})

test('an IPv6-only loopback listener is listening (dev servers bound to localhost may use only ::1)', async (t) => {
  let l: { port: number; server: Server }
  try {
    l = await listen('::1')
  } catch {
    t.skip('IPv6 loopback unavailable on this host')
    return
  }
  t.after(() => close(l.server))
  assert.equal(await probe(l.port, '127.0.0.1'), false, 'precondition: not reachable on IPv4')
  assert.equal(await isListening(l.port), true)
})

/** A main-checkout repo whose config pins `api` to `apiPort` and `web` to `webPort`, with verify on api. */
function repoWith(t: { after: (fn: () => void) => void }, apiPort: number, webPort: number) {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const configPath = join(repo.dir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      fileName: 'port.txt',
      range: { min: 2000, max: 2000, step: 10 },
      services: { api: { offset: 0, mainPort: apiPort }, web: { offset: 1, mainPort: webPort } },
      verify: { url: 'http://127.0.0.1:{api}/health', field: 'root', expect: '{root}' },
    }),
  )
  return { repo, resolved: resolvePorts({ cwd: repo.main, configPath }) }
}

test(
  'the verify target reports owner "mine" when it answers with this worktree root',
  { skip: 'rewired in Task 5/6' },
  async (t) => {
    const repo0 = makeRepo()
    t.after(() => repo0.cleanup())
    // The health server must answer with the repo's root, which we only know after creating the repo,
    // so build the repo first, then start a server that echoes that root.
    const api = await listen('127.0.0.1', JSON.stringify({ root: repo0.main }))
    t.after(() => close(api.server))
    const webPort = await freePort()
    const configPath = join(repo0.dir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        fileName: 'port.txt',
        range: { min: 2000, max: 2000, step: 10 },
        services: { api: { offset: 0, mainPort: api.port }, web: { offset: 1, mainPort: webPort } },
        verify: { url: 'http://127.0.0.1:{api}/health', field: 'root', expect: '{root}' },
      }),
    )
    const statuses = await serviceStatus(resolvePorts({ cwd: repo0.main, configPath }))
    assert.deepEqual(statuses, [
      { service: 'api', port: api.port, listening: true, owner: 'mine', ownerRoot: repo0.main },
      { service: 'web', port: webPort, listening: false },
    ])
  },
)

test(
  'the verify target reports owner "other" with the root it reported',
  { skip: 'rewired in Task 5/6' },
  async (t) => {
    const api = await listen('127.0.0.1', JSON.stringify({ root: '/somewhere/else' }))
    t.after(() => close(api.server))
    const { resolved } = repoWith(t, api.port, await freePort())
    const [apiStatus] = await serviceStatus(resolved)
    assert.deepEqual(apiStatus, {
      service: 'api',
      port: api.port,
      listening: true,
      owner: 'other',
      ownerRoot: '/somewhere/else',
    })
  },
)

test(
  'the verify target reports owner "unknown" when it answers without the field',
  { skip: 'rewired in Task 5/6' },
  async (t) => {
    const api = await listen('127.0.0.1', '<!doctype html>', 'text/html')
    t.after(() => close(api.server))
    const { resolved } = repoWith(t, api.port, await freePort())
    const [apiStatus] = await serviceStatus(resolved)
    assert.deepEqual(apiStatus, { service: 'api', port: api.port, listening: true, owner: 'unknown' })
  },
)

test(
  'a listening service that is not the verify target carries no owner',
  { skip: 'rewired in Task 5/6' },
  async (t) => {
    const web = await listen('127.0.0.1')
    t.after(() => close(web.server))
    const { resolved } = repoWith(t, await freePort(), web.port)
    const statuses = await serviceStatus(resolved)
    assert.deepEqual(statuses[1], { service: 'web', port: web.port, listening: true })
    assert.deepEqual(statuses[0]?.listening, false)
    assert.equal(statuses[0]?.owner, undefined, 'a free verify target gets no owner')
  },
)
