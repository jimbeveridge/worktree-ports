# worktree-ports

Give every git worktree its own stable block of local ports, so the dev servers of two checkouts never collide.

[![npm](https://img.shields.io/npm/v/worktree-ports)](https://www.npmjs.com/package/worktree-ports)
[![CI](https://github.com/jimbeveridge/worktree-ports/actions/workflows/ci.yml/badge.svg)](https://github.com/jimbeveridge/worktree-ports/actions/workflows/ci.yml)
[![licence](https://img.shields.io/npm/l/worktree-ports)](LICENSE)

## The problem

Run the dev servers of two worktrees at once and the second to start fails with "address already in use": both
backends want 8080 and both frontends want 3000.

Moving one server to a free port does not fix it, because the servers in a checkout depend on each other's ports. The
frontend proxies to the backend, the backend's CORS list names the frontend's origin, and tests and browsers need both.
A server that picks its own port learns it only after it starts, too late to tell the others. Miss one and the failure
is silent: worktree B's frontend still proxies to `localhost:8080`, which is worktree A's backend, so B's UI shows A's
code and A's data with no error.

So the ports have to be decided before any server starts, outside all of them, and handed to every server in the
checkout together with the values built from them (origins, URLs). `worktree-ports` does that. Each checkout gets its
own ports. They stay the same on every run, never clash with another checkout of any repository on the machine, and
leave the main checkout and CI on the ports your project already uses.

## Quick start

Install it as a dev dependency, or run it with `npx`:

```sh
npm i -D worktree-ports
```

Describe your servers in `worktree-ports.json` at the root of your project's repo:

```json
{
  "$schema": "https://unpkg.com/worktree-ports/schema.json",
  "services": {
    "api": { "offset": 0, "default": 8080 },
    "web": { "offset": 1, "default": 3000 }
  },
  "env": {
    "API_ADDR": "127.0.0.1:{api}",
    "API_ORIGIN": "http://127.0.0.1:{api}",
    "WORKTREE_ROOT": "{root}"
  }
}
```

Wrap each dev script with `exec`, which runs the command with those variables set. `--port <service>` also sets `PORT`
to that service's port, for that process only:

```sh
npx worktree-ports exec --port web -- npm run dev
```

`show` prints the ports for the checkout you are in. In the main checkout it prints your defaults:

```console
$ npx worktree-ports show
context: main checkout
name: main
root: /home/me/src/app
config: /home/me/src/app/worktree-ports.json
block: none (defaults)
api: 8080
web: 3000
```

In a second worktree it prints a block of its own, and prints the same one every time:

```console
$ git worktree add ../app-feat -b feat && cd ../app-feat
$ npx worktree-ports show
context: linked worktree
name: app-feat
root: /home/me/src/app-feat
config: /home/me/src/app-feat/worktree-ports.json
block: 27420-27429
api: 27420
web: 27421
```

[`example/`](example) is a runnable two-server version of this.

## Integration checklist

To add support to an existing repository, work through these in order. The [Quick start](#quick-start) config is the
starting point.

- [ ] **Install it.** Run `npm i -D worktree-ports` in the package that runs your dev servers. `npx worktree-ports`
      looks only in the nearest package's `node_modules/.bin`, so in a repository whose root is not a Node package,
      scripts outside that package call it by path (`frontend/node_modules/.bin/worktree-ports`) or as
      `npx worktree-ports@<version>`. For editor completion, point `$schema` at the shipped file by a path relative to
      the config (`./frontend/node_modules/worktree-ports/schema.json`), or keep the unpkg URL.
- [ ] **Find every port.** Search the repository for the port numbers your servers use (`8080`, `3000`, ...) in source,
      scripts, `.env` files, proxy and CORS settings, and test configs (Playwright `webServer` and `baseURL`, for
      example). Each server that listens becomes a service; everything else is a value built from one. Leave
      container-internal ports, Docker Compose files (see [the limitation](#faq-and-limitations)), deployment config,
      docs and saved request collections on the defaults.
- [ ] **Declare the services.** Add `worktree-ports.json` at the repository root with one entry per listening server.
      Set each `default` to the port it uses today, so the main checkout and CI keep running on it. Give each a distinct
      `offset`. See the [configuration reference](#configuration-reference).
- [ ] **Render the derived values.** Add an `env` entry for each origin, proxy target, CORS origin, callback URL and
      test base URL you found, built from `{service}` tokens. A value left hard-coded is the silent cross-checkout
      failure described in [the problem](#the-problem).
- [ ] **Choose how each server gets its own port.** Every process run under `exec` receives the whole `env` map, so
      never put a generic name such as `PORT` in `env`: a backend that reads it would bind to the frontend's port. For a
      server that reads `PORT` (Next.js and many other dev servers), start it with `exec --port <service>`, which sets
      `PORT` for that process only. `PORT` carries no host, though, and many servers listen on all interfaces when given
      only a port, which exposes them to your network and can trigger a firewall prompt. For a server that should stay
      on loopback, or that has more than one listener (HTTP and gRPC, say), render a full address under a name only it
      reads (`"API_ADDR": "127.0.0.1:{api}"`) and start it without `--port`.
- [ ] **Make the servers read the environment.** Replace each hard-coded port or address with the variable the config
      names, or `PORT` for a server started with `--port`. A fallback in the source is optional, since the tool renders
      your `default`s outside worktrees, but keep it if the server is also started without the tool.
- [ ] **Wrap every entry point.** Prefix each script that starts a server, or runs anything that talks to one (tests,
      e2e suites, seed scripts), with `worktree-ports exec --`, or `exec --port <service> --` for a server that reads
      `PORT`. On Windows, npm scripts run under `cmd.exe`, so pass ports through the server's config file rather than
      `sh -c` (see [wiring examples](#wiring-examples)). A launcher that re-runs itself under `exec` needs a guard
      against recursing: test `WORKTREE_PORTS_ACTIVE`, which `exec` always sets, not a variable the config renders. The
      refusal test below sets `WORKTREE_ROOT` by hand, and a launcher guarded on it would skip `exec` and fall back
      to the default ports. A launcher that starts its server with `--port` should use a variable of its own instead,
      since under an outer `exec` (a wrapped test run, say) `WORKTREE_PORTS_ACTIVE` is already set and it would skip
      its `--port`.
- [ ] **Check what could override it.** `exec` never overwrites a variable that is already set, so anything that sets a
      port variable first wins. Remove port variables exported in shell profiles. In your own start scripts, replace
      `export API_PORT=8080` with `export API_PORT="${API_PORT:-8080}"`. A `.env` loader that overrides the environment
      (such as dotenv with `override: true`) beats the tool too.
- [ ] **Optionally guard the backend.** Add a `/__worktree` route to the server others depend on, set `verify` in the
      config, and start the dependent server with `exec --verify`. The route must fail closed, answering only loopback
      requests when `WORKTREE_ROOT` is set and returning 404 otherwise; see
      [`--verify`](#guarding-against-the-wrong-backend---verify) for why and for snippets.
- [ ] **Commit the config.** CI needs no changes: with `CI` set the tool uses your `default`s and never claims ports.
- [ ] **Test it in two checkouts.** Run `npx worktree-ports show` in the main checkout; it should print your defaults.
      Then `git worktree add` a second checkout and install its dependencies (a real install: some bundlers reject a
      symlinked `node_modules`). Start its backend before its frontend, since `--verify` with nothing answering warns
      and starts anyway, and run both while the main checkout's servers are up. A passing `--verify` prints only the
      usual `worktree-ports: <name> (<context>): ...` line. `npx worktree-ports status` in each checkout should report
      its own ports as `listening`, and as `mine` if you set up `verify`. `owner unknown` means the server did not
      answer the route, often because it was started before you added it; restart it.
- [ ] **Test the refusal.** If you set up `verify`, start the second checkout's backend with a wrong root, such as
      `WORKTREE_ROOT=/elsewhere npx worktree-ports exec -- <backend command>` (`exec` keeps a value you set). Starting
      the frontend with `exec --verify` should now refuse and exit 1.

## How it works

- **Blocks.** A block is ten or more consecutive ports. A service's port is the block's base plus its `offset`. Blocks
  are aligned to ten from the bottom of the range (20000, 20010, ...).
- **The registry.** Each claim is a small JSON file in a per-user state directory, shared by every repository on the
  machine. A lock around claiming keeps the blocks disjoint with no coordination between projects.
- **Stable ports.** A claim is keyed by the worktree's private git directory and the config file's path, so a worktree
  finds the same block on every run. Lookups need no lock and cost one directory read.
- **Freeing.** Once a worktree goes away (`git worktree remove`, `git worktree prune`, a deleted clone, or a worktree
  folder removed by hand), its claim is removed by the next claim anywhere on the machine, or by `prune`. Until then
  `list` shows it as stale. Nothing else expires a claim, because an idle worktree keeps
  its ports. `worktree-ports prune` cleans up on demand.
- **No daemon.** Nothing runs in the background. The tool works out the ports, then runs your command and exits.

Which ports you get depends on the context:

| Context         | How it is detected                                | Ports used                                                                          |
| --------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Linked worktree | `git rev-parse`: git dir differs from common dir  | Its claimed block                                                                   |
| Main checkout   | git dir equals common dir                         | Service `default`s, or a claimed block if the config sets `"mainCheckout": "claim"` |
| CI              | `CI` is set and is not `""`, `0` or `false`       | Service `default`s. Never claims, never writes the registry.                        |
| No git          | `git rev-parse` fails, but a config file is found | Service `default`s                                                                  |
| No config found | -                                                 | `exec` warns and runs the command unchanged. `show`, `env` and `status` exit 1.     |

Outside worktrees the tool renders from your `default`s rather than leaving the environment empty. A config's `env`
section holds more than ports (origins, callback URLs and the like), and with an empty environment each app falls back
to defaults in its own source, which drift from the config. Rendering from `default`s keeps CI and fresh checkouts on
the same values developers run.

`WORKTREE_PORTS` overrides the detection; see [Environment variables](#environment-variables).

The full claim protocol (locking, the backstop scan, staleness rules) is in
[section 7 of the design spec](https://github.com/jimbeveridge/worktree-ports/blob/main/docs/superpowers/specs/2026-10-21-worktree-ports-design.md#7-per-user-settings-and-the-registry).

## Configuration reference

The tool looks for `worktree-ports.json` from the current directory upward, and the nearest one wins. The search stops
at the checkout's top level (the first directory holding `.git`), so a config above a repository never applies to it;
outside git it goes on to the filesystem root. On macOS and Linux, a config owned by another user or writable by other
users is refused. `--config <path>` overrides the search. Git is not needed to find the config. In a monorepo the usual layout is
one file at the root; a sub-project may carry its own, and each config file in a worktree gets its own claim.

| Field                               | Rule                                                                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services.<name>.offset`            | Required integer >= 0, unique per service. The service's port is the block base plus its offset.                                                                                                                                         |
| `services.<name>.default`           | Required port 1-65535, used by every context that does not claim. It must lie outside the claim range, so a claimed block can never hand out another project's default. A clash is an error that names both.                             |
| `mainCheckout`                      | `"default"` (the default) or `"claim"`.                                                                                                                                                                                                  |
| `env`                               | Optional map of variable name to template. Names that pick what code a program loads or runs are rejected: `PATH`, `HOME`, `NODE_OPTIONS`, `PYTHON*`, `LD_*`, `DYLD_*`, `GIT_*`, `NPM_CONFIG_*`, `WORKTREE_PORTS*` and similar.          |
| `verify.url` / `.field` / `.expect` | Optional. Where `exec --verify` asks a running service who it belongs to, which JSON field holds the answer, and the value meaning "this checkout" (typically `{root}`). See [`--verify`](#guarding-against-the-wrong-backend---verify). |
| `$schema`                           | Optional and ignored. The package ships a JSON Schema for editor completion.                                                                                                                                                             |

Unknown fields are an error, so typos surface at once.

**Template tokens**, usable in `env` and `verify`:

| Token       | Value                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `{root}`    | The worktree's top-level directory. Outside git: the directory holding the config file.                                    |
| `{name}`    | `main` for the main checkout and outside git. For a linked worktree, git's admin-directory name.                           |
| `{home}`    | The user's home directory.                                                                                                 |
| `{service}` | That service's resolved port, for each service name you declared (`{api}`, `{web}`). Service names cannot reuse the above. |

**Block size** is not configured. A config needs `max(offset) + 1` ports, rounded up to a multiple of 10. Offsets 0 to 2
claim 10 ports; offsets up to 14 claim 20. If a config grows past its block, the block is replaced, keeping the same
base when it can.

**Editor completion.** Keep the `$schema` line shown above, or point it at `./node_modules/worktree-ports/schema.json`.

## CLI reference

```text
worktree-ports show    [--json] [--config <path>]
worktree-ports status  [--json] [--config <path>]
worktree-ports env     [--port <service>] [--config <path>]
worktree-ports exec    [--port <service>] [--verify] [-v | --verbose] [--config <path>] -- <command> [args...]
worktree-ports list    [--json]
worktree-ports release [--config <path>]
worktree-ports prune   [--unused-for <duration>] [--dry-run]
worktree-ports --version | --help
```

- **`show`** prints the context and why it was chosen, the checkout's name and root, its block (if any) and each
  service's port. It claims a block if the context calls for one and none exists yet. `--json` prints the full
  resolution, including the rendered `env`, for scripting.
- **`status`** reports, for each service port, whether something is listening. It probes both `127.0.0.1` and `::1`,
  because a dev server bound to `localhost` may listen on only one. For the service that `verify.url` points at, it also
  says whose server it is: `mine`, `OTHER checkout: <root>`, or `owner unknown`. Exits 0 once the ports resolve.

  ```console
  $ npx worktree-ports status
  context: linked worktree
  name: app-feat
  api  27420  listening  mine
  web  27421  free
  ```

  `--json` prints `{ context, name, root, services: [{ service, port, listening, owner?, ownerRoot? }] }`.

- **`env`** prints shell-quoted `export KEY=value` lines, for `eval "$(npx worktree-ports env)"`. Unlike `exec`, these
  lines overwrite whatever the shell has. That is the point of evaluating them.

  ```console
  $ npx worktree-ports env
  export API_ADDR='127.0.0.1:27420'
  export API_ORIGIN='http://127.0.0.1:27420'
  export WORKTREE_ROOT='/home/me/src/app-feat'
  ```

  `env --port <service>` adds the two lines `exec --port` would set, after the rendered ones. If `env` also renders
  `PORT`, that line is left out, so `PORT` is printed once.

  ```console
  $ npx worktree-ports env --port web
  export API_ADDR='127.0.0.1:27420'
  export API_ORIGIN='http://127.0.0.1:27420'
  export WORKTREE_ROOT='/home/me/src/app-feat'
  export PORT='27421'
  export WORKTREE_PORTS_PORT='27421'
  ```

- **`exec -- <command>`** runs the command with the rendered environment merged in, and exits with its result. It never
  overwrites a variable that is already set (see [Environment variables](#environment-variables)). It forwards
  `SIGTERM` to the child. It does not forward `SIGINT`: Ctrl-C in a terminal already reaches the whole foreground
  process group, and a second delivery would break tools that treat a second Ctrl-C as "force quit". The wrapper ignores
  `SIGINT` itself while the child runs, so it can still report the child's exit code. With no config found, it warns and
  runs the command unchanged. It always sets `WORKTREE_PORTS_ACTIVE=1` in the child, even then and under
  `WORKTREE_PORTS=off`, so a launcher can tell it is already running under `exec`.
- **`exec --port <service> -- <command>`** also sets `PORT` to that service's port in the current context (the claimed
  port in a linked worktree, the `default` in the main checkout and CI), for this child only. It adds to the rendered
  `env`; it never replaces it. It always sets the variable named `PORT`; a server that reads another name keeps getting
  it from `env`. If `env` also renders `PORT`, the flag's value is used for this child instead. An unknown service
  exits 1 and names the declared ones. With `WORKTREE_PORTS=off` or no config, nothing is added, `PORT` included.

  `exec` often runs inside `exec` without anyone planning it, such as a wrapped test script that starts a wrapped
  server. So `--port` also sets `WORKTREE_PORTS_PORT` to the value it gave `PORT`, marking it as the tool's. An inner
  `exec --port` finding `PORT` equal to that marker replaces both silently; a `PORT` that differs (pinned by a person
  or CI) is kept, with the usual warning. See [Environment variables](#environment-variables).

- **`exec -v` / `--verbose`** prints, to stderr after the banner, what reached the child, after the never-overwrite
  rule and the `--port` exception: one line per variable the tool manages, then the command, shell-quoted so it can be
  rerun. Each line says `set`, `kept` (with the value this checkout would have used) or `replaced` (only `PORT` and
  `WORKTREE_PORTS_PORT`, when an outer `exec --port` set them). Only managed variables appear: every key the config's
  `env` renders, plus `PORT` and `WORKTREE_PORTS_PORT` with `--port`. The rest of your environment, which often holds
  tokens, is never printed. With `--verify`, a `verify: <url> reports this checkout` line precedes the command.

  ```console
  $ npx worktree-ports exec -v --port web -- node -v
  worktree-ports: app-feat (linked worktree): api=27420 web=27421
  worktree-ports:   set      API_ADDR=127.0.0.1:27420
  worktree-ports:   set      API_ORIGIN=http://127.0.0.1:27420
  worktree-ports:   set      WORKTREE_ROOT=/home/me/src/app-feat
  worktree-ports:   set      PORT=27421 (--port web)
  worktree-ports:   set      WORKTREE_PORTS_PORT=27421
  worktree-ports: running: node -v
  v22.18.0
  ```

- **`exec --verify -- <command>`** first checks that the server at `verify.url` belongs to this checkout. See
  [below](#guarding-against-the-wrong-backend---verify).
- **`list`** prints every claim in the registry across all repositories: base, size, last use, whether it is stale (and
  why), root and config. It does not need a config.

  ```console
  $ npx worktree-ports list
  BASE  SIZE  LAST-USED   STALE         ROOT  CONFIG
  27420 10    2026-10-21  -             /home/me/src/app-feat  worktree-ports.json
  27440 10    2026-10-02  worktree-gone /home/me/src/app-old  worktree-ports.json
  ```

- **`release`** deletes this checkout's claim. The next run claims afresh. This is the fix for "my block clashes with
  something that does not use this tool".
- **`prune`** removes stale claims and claims whose config file has gone, and reports each removal.
  `--unused-for <duration>` (a whole number of days or weeks, such as `90d` or `12w`) also removes claims not used for
  that long. `--dry-run` reports what would go without removing anything.

  ```console
  $ npx worktree-ports prune --dry-run
  would remove 27440 (worktree-gone) /home/me/src/app-old
  $ npx worktree-ports prune
  removed 27440 (worktree-gone) /home/me/src/app-old
  ```

Exit codes:

| Code           | Meaning                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `0`            | Success, or the child's own `0`.                                                                                  |
| (child's code) | Whatever `<command>` exited with.                                                                                 |
| `1`            | Port resolution failed (bad config, no free block, lock timeout, registry error), or `--verify` found a mismatch. |
| `2`            | Usage error (bad flags, missing command).                                                                         |
| `127`          | The child failed to spawn.                                                                                        |
| `128 + n`      | The child was killed by signal `n`.                                                                               |

## Environment variables

| Variable                   | Effect                                                                                                                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKTREE_PORTS`           | Overrides context detection. Unset or `auto`: the table above. `default`: use `default`s everywhere. `claim`: claim a block even in the main checkout or CI (needs git). `off`: `exec` runs the command with nothing added, and other commands report that the tool is off. |
| `WORKTREE_PORTS_STATE_DIR` | Where the registry lives. See [Per-user settings](#per-user-settings).                                                                                                                                                                                                      |
| `WORKTREE_PORTS_ACTIVE`    | Set to `1` by `exec` in every child, even when the tool is off or finds no config, so a launcher that re-runs itself under `exec` can avoid recursing. `env` never prints it.                                                                                               |
| `WORKTREE_PORTS_PORT`      | Set by `exec --port` (and printed by `env --port`) to the value it gave `PORT`, so a nested `exec --port` can tell its own `PORT` from one you pinned. Don't set it yourself.                                                                                               |
| `CI`                       | When set and not `""`, `0` or `false`, the tool uses `default`s and never writes the registry.                                                                                                                                                                              |

**`exec` never overwrites.** It only fills in variables that are unset in its own environment. When an existing value
differs from the rendered one, it warns on stderr so it is clear which one won:

```console
$ PORT=9999 npx worktree-ports exec --port web -- sh -c 'echo $PORT'
worktree-ports: PORT is already set to "9999"; keeping it (this checkout would use "27421")
worktree-ports: app-feat (linked worktree): api=27420 web=27421
9999
```

There are two exceptions. Under `--port`, a `PORT` equal to `WORKTREE_PORTS_PORT` was set by an outer `exec --port`, so
the inner one replaces both silently; any other `PORT` is yours and is kept. And `WORKTREE_PORTS_ACTIVE` is always set
to `1`.

A CI job or a developer that pins `PORT` keeps it. The flip side is a warning to heed: a stale `PORT` exported in your
shell profile silently beats the tool in every worktree.

## Per-user settings

| Item                 | Path                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State dir (registry) | `$WORKTREE_PORTS_STATE_DIR`, else `$XDG_STATE_HOME/worktree-ports`, else `~/.local/state/worktree-ports`. On Windows: `%LOCALAPPDATA%\worktree-ports`.    |
| Settings file        | `$XDG_CONFIG_HOME/worktree-ports/config.json`, else `~/.config/worktree-ports/config.json`. On Windows: `%APPDATA%\worktree-ports\config.json`. Optional. |

The only setting is the range blocks are drawn from:

```json
{ "range": { "min": 20000, "max": 32759 } }
```

The default range is 20000-32759, which is 1,276 ten-port blocks. It ends below 32768 because that is where Linux
starts handing out ephemeral ports for outbound connections (49152 on macOS, BSD and Windows), and a block in that
range could be taken by an unrelated connection at any moment. `min` must be at least 1024 and a multiple of 10, and
`max` must be at most 65535. A service `default` inside the range is an error.

If you narrow or move the range, a claim outside it is treated as invalid: the checkout gets a new block and the old
claim is replaced.

## Guarding against the wrong backend (`--verify`)

The silent failure from [the problem](#the-problem) is a server left running from another checkout, perhaps one since
deleted, answering on a port this checkout now uses. `exec --verify` catches it before your command starts. It asks the
server at `verify.url` for a JSON field and compares it with `verify.expect`:

- **Match** (the field equals `verify.expect`): the command starts.
- **Mismatch** (the field names another checkout): it refuses and exits 1.
- **Unreachable or unreported** (nothing answered, or the response has no such field, as with a 404 or a body that
  isn't JSON): it warns and starts anyway, since there is nothing yet to conflict with.

```console
$ npx worktree-ports exec --verify -- npm run dev
worktree-ports: http://127.0.0.1:27420/__worktree belongs to "/home/me/src/other", not this checkout ("/home/me/src/app-feat"). Refusing to start: requests would reach the wrong checkout.
```

Put the check on the service that depends on the others (usually the frontend) and point `verify.url` at the service it
depends on (the backend). `npx worktree-ports status` runs the same check without starting anything.

The checked server must expose the checkout root, or another per-checkout value, on a dev-only route such as
`/__worktree`. Use a route of its own rather than your health endpoint: health endpoints are often polled by load
balancers and monitors, sometimes from outside, and their response is a contract with that monitoring. The root is a
local filesystem path, so the route should fail closed: answer with `{"worktreeRoot": ...}` only when `WORKTREE_ROOT` is
set (only `worktree-ports exec` sets it, through `env` as in the configuration above, so a deployed server never has it)
and the request's direct peer is a loopback address, and return 404 otherwise. Loopback alone isn't enough: behind a
reverse proxy on the same host every request arrives from loopback. The loopback check still keeps the path off the
network if `WORKTREE_ROOT` ever leaks into a deployment. Don't gate on `NODE_ENV` or `APP_ENV` either, since a
deployment that forgets to set them exposes the path. Read the peer from the socket, not from `X-Forwarded-For` or any
other header, and don't enable proxy trust for it (Express `trust proxy`, Werkzeug `ProxyFix`).

**Node (Express):**

```js
app.get('/__worktree', (req, res) => {
  // The socket's peer, not req.ip, which depends on `trust proxy`.
  const peer = req.socket.remoteAddress ?? ''
  const local = peer === '::1' || /^(::ffff:)?127\./.test(peer)
  const root = process.env.WORKTREE_ROOT
  if (!root || !local) return res.sendStatus(404)
  res.json({ worktreeRoot: root })
})
```

**Go:**

```go
http.HandleFunc("/__worktree", func(w http.ResponseWriter, r *http.Request) {
	root := os.Getenv("WORKTREE_ROOT")
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if root == "" || err != nil || !net.ParseIP(host).IsLoopback() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"worktreeRoot": root})
})
```

**Python (Flask):**

```python
def is_loopback(addr):
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    # Before Python 3.13, ::ffff:127.0.0.1 doesn't count as loopback.
    return (getattr(ip, "ipv4_mapped", None) or ip).is_loopback

@app.get("/__worktree")
def worktree():
    root = os.environ.get("WORKTREE_ROOT")
    # remote_addr is the socket's peer unless ProxyFix rewrites it.
    if not root or not is_loopback(request.remote_addr):
        abort(404)
    return jsonify(worktreeRoot=root)
```

## Wiring examples

The contract with a server is only environment variables: it reads its port, or its listen address, from the variable
the config names, or from `PORT` when you start it with `exec --port`.

**`package.json` scripts.** Wrap each server's script, with `--port` for the port it listens on:

```json
{
  "scripts": {
    "api": "worktree-ports exec --port api -- node server.js",
    "web": "worktree-ports exec --port web --verify -- vite",
    "ports": "worktree-ports show"
  }
}
```

**A Vite or Next-style dev server.** Next.js and many other dev servers read `PORT`, which `exec --port web`
sets. Vite does not; read the variable in `vite.config.js` instead:

```js
export default { server: { port: Number(process.env.PORT) || 5173, strictPort: true } }
```

Prefer a config file over `sh -c 'vite --port "$PORT"'`, which fails on Windows, where npm scripts run under `cmd.exe`.

Proxy targets read the other variables, for example `process.env.API_ORIGIN` in `vite.config.js`.

**A server in another language.** The config can render a full listen address, not only a port. This Go server listens
on `API_ADDR`:

```go
log.Fatal(http.ListenAndServe(os.Getenv("API_ADDR"), nil))
```

**A Makefile target:**

```make
dev:
	npx worktree-ports exec --port web -- npm run dev

ports:
	npx worktree-ports show
```

**A CI job.** Nothing needs to change. `CI` is set, so the tool renders your `default`s and never touches the registry.
The same `exec` lines work locally and in CI:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: npm ci
      - run: npx worktree-ports exec -- npm test
```

## Programmatic API

Everything the CLI does is available as a typed library:

```js
import { resolvePorts } from 'worktree-ports'

const { ports, env, context } = await resolvePorts()
console.log(context.reason, ports.api, env.API_ORIGIN)
```

`resolvePorts(opts?)` finds the config, works out the context, claims or looks up the block, and renders `env` and
`verify`. The other exports include `findConfig`, `parseConfig`, `loadConfig`, `locateWorktree`, `claimBlock`,
`openRegistry` (with `list`, `release` and `prune`), `renderTemplate`, `mergeEnv`, `verifyIdentity`, `serviceStatus`,
`isListening` and `probe`. The full signatures are in the shipped `.d.ts` files. The API is governed by semantic
versioning from 1.0; 0.x releases may break it.

## Platforms and requirements

- Node 20 or later at runtime. Developing this package needs Node 22.18 or later.
- git 2.31 or later.
- macOS and Linux are supported and tested in CI.
- Windows is supported for `show`, `env`, `exec`, `status`, `list`, `release` and `prune`, and tested in CI. Locking and
  atomic rename work there. Signal handling differs: there is no `SIGTERM` to forward, and Ctrl-C reaches the whole
  console group anyway, so the child exits and the wrapper reports its code. The signal tests are skipped on Windows.
  `exec` runs a `.cmd` or `.bat` command (`npm`, `npx`, anything in `node_modules/.bin`) through `cmd.exe`, with its
  arguments escaped, since Node can't start those files directly. Unlike `cmd.exe`, it never runs a bare command name
  from the current directory, so a checkout can't plant its own `npm.cmd`; write `.\tool` to run one from there.
- No runtime dependencies.

## FAQ and limitations

**Why not port 0, or find a free port at startup?** The port changes on every run, which breaks bookmarks, saved
callback URLs and anything else that remembers a URL. It is also unknown until the server is already up, too late for
the other servers' configuration. And OS-assigned ports come from the same range the OS uses for outbound connections,
so a port reported free can be taken a moment later.

**How are blocks freed?** Automatically, whenever any claim runs and on `prune`, a claim is deleted when its `gitDir` no
longer exists, or when it belongs to a linked worktree whose working directory has gone (the check `git worktree prune`
itself makes). A claim is never collected while its worktree has a `locked` file (`git worktree lock`). A claim whose
config file has gone but whose worktree remains is kept by the automatic pass, since a branch checkout can remove the
file for a while; `prune` removes it. A claim that is merely old is kept too, because stable ports are the point. The tool
only reads git's admin directory and never deletes it.

**What happens when the range is full?** The claim fails with exit 1 and a message listing every claim, oldest first,
suggesting `worktree-ports prune --unused-for 30d` and `worktree-ports release` (run in a worktree you are done with),
and noting that the range can be widened in the settings file. Running out in practice means claims are leaking, not real
demand.

**Unmounted drives.** A clone on an external or network drive that is unmounted when another claim runs looks deleted,
so its claim is collected and it gets new ports on its next run. That is a one-time port change, never a collision.
Linked worktrees can avoid it with `git worktree lock`.

**Something outside the tool already uses my block.** Claiming probes every port in a candidate block on `127.0.0.1` and
`::1` and skips any that are listening, but the check is best-effort: a program that starts later can still take a port.
Run `worktree-ports release` in that checkout and the next run claims a different block.

**Can I link checkouts of different repositories?** No. Blocks are per checkout, so a frontend in one repository cannot
be told its partner backend's port in another repository's worktree. Set the partner's address by hand, for example
`API_ORIGIN=http://127.0.0.1:27420`. `exec` never overwrites a variable that is already set, so the value you export
wins over the config.

**After integrating, I get a firewall prompt (or a server is reachable from my network). What do I do?** `PORT` carries
only a port, no host, and many servers given only a port listen on all interfaces, including your network address. That
is what triggers the firewall prompt. Don't start that server with `--port`. Instead, render a full loopback address
under a variable only that server reads, such as `"API_ADDR": "127.0.0.1:{api}"` in the config's `env`, and have the
server listen on it. See the integration checklist's step on
[choosing how each server gets its port](#integration-checklist).

**Docker Compose.** Host port mappings (`"8080:8080"`) are fixed, so two checkouts running `compose up` at once, or one
running Compose while another runs native servers, collide on the host with "port is already allocated". Ports inside
the containers never collide. Run Compose in one checkout at a time. Per-checkout host ports are an open design
question; feedback is welcome.

**Loopback only.** Probes and checks use `127.0.0.1` and `::1`. The tool does not manage ports on other interfaces.

## Contributing and licence

Contributions are welcome. The repository's `CLAUDE.md` lists the commands, and `npm run lint && npm test` must pass
before a change is committed. The design is in
[`docs/superpowers/specs/`](docs/superpowers/specs/2026-10-21-worktree-ports-design.md).

Released under the [MIT licence](LICENSE).
