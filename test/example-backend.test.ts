// The example backend's /__worktree route fails closed. These run the backend directly, without installing the
// tarball, so they stay in the fast suite.
import { type ChildProcess, spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { isListening } from '../src/status.ts'

const BACKEND = join(import.meta.dirname, '..', 'example', 'backend.mjs')

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function startBackend(t: TestContext, worktreeRoot: string | undefined): Promise<number> {
  const port = await freePort()
  const env: NodeJS.ProcessEnv = { ...process.env, BACKEND_PORT: String(port) }
  delete env.WORKTREE_ROOT
  if (worktreeRoot !== undefined) env.WORKTREE_ROOT = worktreeRoot
  const child: ChildProcess = spawn(process.execPath, [BACKEND], { env, stdio: 'ignore' })
  t.after(() => child.kill())
  const deadline = Date.now() + 10_000
  while (!(await isListening(port, 250))) {
    if (Date.now() > deadline) assert.fail(`backend did not start listening on ${port}`)
    await new Promise((r) => setTimeout(r, 50))
  }
  return port
}

test('example backend: /__worktree reports the root to a loopback peer when WORKTREE_ROOT is set', async (t) => {
  const port = await startBackend(t, '/tmp/checkout')
  const res = await fetch(`http://127.0.0.1:${port}/__worktree`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { worktreeRoot: '/tmp/checkout' })
})

for (const [label, value] of [
  ['unset', undefined],
  ['empty', ''],
] as const) {
  test(`example backend: /__worktree is a 404 without a root when WORKTREE_ROOT is ${label}`, async (t) => {
    const port = await startBackend(t, value)
    const res = await fetch(`http://127.0.0.1:${port}/__worktree`)
    assert.equal(res.status, 404)
    const body = (await res.json()) as Record<string, unknown>
    assert.equal('worktreeRoot' in body, false)
  })
}
