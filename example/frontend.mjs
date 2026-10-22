// Page server. Proxies /api/* to the backend and shows which checkout each side belongs to.
import { createServer, request } from 'node:http'

const port = Number(process.env.PORT)
const origin = new URL(process.env.BACKEND_ORIGIN ?? 'http://127.0.0.1:4100')
const worktreeRoot = process.env.WORKTREE_ROOT ?? ''

if (!Number.isInteger(port)) {
  console.error('PORT is not set. Start this with: npm run frontend')
  process.exit(2)
}

const page = `<!doctype html>
<meta charset="utf-8">
<title>worktree-ports example</title>
<body style="font-family: sans-serif; max-width: 40rem; margin: 2rem auto">
<h1>worktree-ports example</h1>
<div id="banner" hidden style="background: #c00; color: #fff; padding: 1rem">
  Mismatch: this frontend is talking to a backend from another checkout.</div>
<p>Frontend checkout: <code id="mine"></code></p>
<p>Backend checkout: <code id="theirs">loading...</code></p>
<script>
  const mine = ${JSON.stringify(worktreeRoot)}
  document.getElementById('mine').textContent = mine
  fetch('/api/hello')
    .then((r) => r.json())
    .then((hello) => {
      document.getElementById('theirs').textContent = hello.worktreeRoot + ' (port ' + hello.port + ')'
      document.getElementById('banner').hidden = hello.worktreeRoot === mine
    })
    .catch((err) => (document.getElementById('theirs').textContent = 'unreachable: ' + err))
</script>
`

createServer((req, res) => {
  if (!req.url?.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page)
    return
  }
  const upstream = request(
    { host: origin.hostname, port: origin.port, path: req.url, method: req.method, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    },
  )
  upstream.on('error', () => {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'backend unreachable' }))
  })
  req.pipe(upstream)
}).listen(port, '127.0.0.1', () => {
  console.log(`frontend for ${worktreeRoot} listening on http://127.0.0.1:${port}`)
})
