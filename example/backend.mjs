// API server. Reports which checkout it runs in, so a frontend can tell whether it is talking to its own backend.
import { createServer } from 'node:http'

const port = Number(process.env.BACKEND_PORT)
const worktreeRoot = process.env.WORKTREE_ROOT ?? null

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  if (pathname === '/__worktree') {
    // Dev-only route the tool's verify check reads. Fail closed: answer only when worktree-ports set WORKTREE_ROOT
    // and the socket's peer (never a forwarding header) is loopback; otherwise it is a plain 404.
    const peer = req.socket.remoteAddress ?? ''
    const isLoopback = peer === '::1' || /^(::ffff:)?127\./.test(peer)
    if (worktreeRoot && isLoopback) send(res, 200, { worktreeRoot })
    else send(res, 404, { error: 'not found' })
  } else if (pathname === '/api/hello') {
    send(res, 200, { worktreeRoot, port })
  } else {
    send(res, 404, { error: 'not found' })
  }
})

if (!Number.isInteger(port)) {
  console.error('BACKEND_PORT is not set. Start this with: npm run backend')
  process.exit(2)
}
server.listen(port, '127.0.0.1', () => {
  console.log(`backend for ${worktreeRoot} listening on http://127.0.0.1:${port}`)
})
