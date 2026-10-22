import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { verifyIdentity } from '../src/verify.ts'

async function serve(body: string, type = 'application/json'): Promise<{ url: string; server: Server }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': type })
    res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/health`, server }
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()))

test('match', async (t) => {
  const { url, server } = await serve(JSON.stringify({ status: 'ok', root: '/wt/a' }))
  t.after(() => close(server))
  assert.deepEqual(await verifyIdentity({ url, field: 'root', expect: '/wt/a' }), { status: 'match' })
})

test('mismatch reports the actual owner', async (t) => {
  const { url, server } = await serve(JSON.stringify({ root: '/wt/b' }))
  t.after(() => close(server))
  assert.deepEqual(await verifyIdentity({ url, field: 'root', expect: '/wt/a' }), {
    status: 'mismatch',
    actual: '/wt/b',
  })
})

test('missing field or non-JSON is unreported', async (t) => {
  const json = await serve(JSON.stringify({ status: 'ok' }))
  const html = await serve('<!doctype html>', 'text/html')
  t.after(async () => {
    await close(json.server)
    await close(html.server)
  })
  assert.deepEqual(await verifyIdentity({ url: json.url, field: 'root', expect: '/wt/a' }), { status: 'unreported' })
  assert.deepEqual(await verifyIdentity({ url: html.url, field: 'root', expect: '/wt/a' }), { status: 'unreported' })
})

test('nothing listening is unreachable', async () => {
  const { url, server } = await serve('{}')
  await close(server)
  const r = await verifyIdentity({ url, field: 'root', expect: '/wt/a' })
  assert.equal(r.status, 'unreachable')
})
