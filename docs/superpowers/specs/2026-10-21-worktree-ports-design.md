# worktree-ports — design

**Status:** draft, 2026-10-21

## 1. Problem

Git worktrees let you keep several branches checked out at once: the feature
you're building, a branch under review, one a coding agent is working in. Run
the dev servers in two of them and they collide. Both backends want 8080, both
frontends want 3000, and the second to start fails with "address already in
use".

Moving one server to a free port doesn't fix it, because the servers in a
checkout depend on each other's ports. The frontend proxies to the backend, the
backend's CORS list and callback URLs name the frontend's origin, and tests and
browsers need both. A server that picks its own port (`PORT=0`, or a dev server
that steps to the next free one) learns it only after it starts, too late for
the others' config. Miss one, and the failure is silent: worktree B's frontend
still proxies to `localhost:8080`, which is worktree A's backend, so B's UI
shows A's code and A's data with no error.

So the ports have to be decided before any server starts, outside all of them,
and handed to every server in the checkout along with the values built from
them (origins, URLs). Doing that by hand, with a `.env` file per worktree,
breaks down once several repositories on one machine each have their own idea
of which ports are spare. Grabbing free ports at startup gives different ones
on every run, which breaks bookmarks, saved callback URLs and anything else
that remembers a URL.

What's needed: each checkout gets its own ports automatically. They stay the
same every time, never clash with any other checkout of any repository on the
machine, and leave the main checkout and CI on the ports the project already
uses.

## 2. Goals

1. **Per-checkout ports with no manual steps.** The first run in a worktree
   claims a block of ports; later runs get the same block.
2. **No collisions across the machine.** One registry per user covers every
   repository, so no project has to pick a "safe" range.
3. **One source of truth.** A config file in the repo names the services, their
   normal ports, and the environment variables built from them. It's used in
   every context: linked worktree, main checkout, CI, no git.
4. **Language-agnostic.** Ports reach programs as environment variables, so
   any server in any language can use them. The tool itself is a small CLI.
5. **Catch the wrong-backend case.** An optional check refuses to start a
   frontend when its backend port is answered by another checkout's server.
6. **No daemon, no runtime dependencies.** Everything is files and a lock.
7. **Blocks are freed when checkouts go away**, so the supply doesn't run out
   (§7d).
8. Published on npm as `worktree-ports` (name free as of 2026-10-21), runnable
   with `npx` or installed as a dev dependency.

## 3. Non-goals

- Ports across machines, or binding hosts other than loopback.
- A native binary (Go, Rust, `bun --compile`). Revisit if users without Node
  ask; the test suite pins the behaviour, so a port can be checked against it.
- Process supervision: starting, stopping or restarting servers.
- An `init` command that writes a starter config (nice later, not needed now).

## 4. Implementation language and packaging

- **TypeScript, compiled to JS with `tsc`, published to npm.** The package
  ships `dist/` (JS plus `.d.ts`). The `bin` points at `dist/bin/worktree-ports.js`.
- **Runtime: Node ≥ 20.** Nothing it uses (`fs`, `child_process`, `net`) is
  newer than that.
- **Development: Node ≥ 22.18.** Tests run against the `.ts` sources using
  Node's built-in type stripping (`node --test`), with no build step.
- **No runtime dependencies.** Dev deps only: `typescript`, `@types/node`, `prettier`.
- ESM only. A programmatic API is exported (§11).
- MIT licence (the repo's `LICENSE`).
- Needs git ≥ 2.31 (`git rev-parse --path-format=absolute`) when run inside a
  git repository.

## 5. Contexts and modes

The tool first works out which context it's running in, then which ports to
use.

| Context         | How it's detected                                 | Ports used                                                                          |
| --------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Linked worktree | `git rev-parse`: git dir ≠ common dir             | Its claimed block                                                                   |
| Main checkout   | git dir = common dir                              | Service `default`s, or a claimed block if the config sets `"mainCheckout": "claim"` |
| CI              | `CI` is set and is not `""`, `0` or `false`       | Service `default`s. Never claims, never writes the registry.                        |
| No git          | `git rev-parse` fails, but a config file is found | Service `default`s                                                                  |
| No config found | —                                                 | `exec` warns and runs the command unchanged. `show`, `env` and `status` exit 1.     |

`WORKTREE_PORTS` overrides the detection:

| Value          | Effect                                                                                  |
| -------------- | --------------------------------------------------------------------------------------- |
| unset / `auto` | The table above                                                                         |
| `default`      | Use `default`s everywhere, even in a linked worktree                                    |
| `claim`        | Claim a block even in the main checkout or CI (needs git)                               |
| `off`          | `exec` runs the command with nothing added. Other commands report that the tool is off. |

**Why defaults rather than an empty env outside worktrees:** a config's `env`
section holds more than ports (origins, callback URLs and the like). With an
empty env, each app falls back to defaults in its own source, which drift from
the config. Rendering from `default`s keeps CI and fresh checkouts on the same
values developers run.

**Template tokens:** `{root}` is the worktree's top-level directory (outside
git: the directory holding the config file). `{name}` is `main` for the main
checkout and outside git, and git's admin-dir name for a linked worktree.
`{home}` is the user's home directory. `{<service>}` is that service's
resolved port.

**Never overwrite.** `exec` only fills in variables that are unset in its own
environment. When an existing value differs from the rendered one, it warns on
stderr so it's clear which one won. A CI job or a developer that pins `PORT`
keeps it.

## 6. Repository config

### 6a. Discovery

Search from the current directory up to the filesystem root for
`worktree-ports.json`; the nearest one wins. `--config <path>` overrides the
search. Git is not needed to find the config, which is what makes the no-git
context work. In a monorepo the usual layout is one file at the root; a
sub-project may carry its own. Each config file in a worktree gets its own
claim (§7b), so two sub-projects never share a block.

### 6b. Schema

```json
{
  "$schema": "https://unpkg.com/worktree-ports/schema.json",
  "services": {
    "api": { "offset": 0, "default": 8080 },
    "web": { "offset": 1, "default": 3000 }
  },
  "mainCheckout": "default",
  "env": {
    "API_ADDR": "127.0.0.1:{api}",
    "PORT": "{web}",
    "API_ORIGIN": "http://127.0.0.1:{api}",
    "WORKTREE_ROOT": "{root}"
  },
  "verify": {
    "url": "http://127.0.0.1:{api}/healthz",
    "field": "worktreeRoot",
    "expect": "{root}"
  }
}
```

| Field                               | Rule                                                                                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `services.<name>.offset`            | Required integer ≥ 0, unique per service. The service's port is the block base plus its offset.                                                                                                                                                                                |
| `services.<name>.default`           | **Required** port 1–65535. Used by every context that doesn't claim (§5). Must fall outside the user's claim range, so a claimed block can never hand out another project's default. That's checked at load time against the effective range; a clash is an error naming both. |
| `mainCheckout`                      | `"default"` (the default) or `"claim"`.                                                                                                                                                                                                                                        |
| `env`                               | Optional map of variable name → template (§5 tokens).                                                                                                                                                                                                                          |
| `verify.url` / `.field` / `.expect` | Optional. Where `exec --verify` asks a running service who it belongs to, which JSON field holds the answer, and the value meaning "this checkout" (typically `{root}`). See §8.                                                                                               |
| `$schema`                           | Optional; ignored. A JSON Schema ships in the package for editor completion.                                                                                                                                                                                                   |

Unknown fields are an error, so typos surface at once.

**Block size** is not configured. A config needs `max(offset) + 1` ports,
rounded up to a multiple of 10 so bases stay readable (20000, 20010, …). A
config with offsets 0–2 claims 10 ports; one with offsets up to 14 claims 20.

## 7. Per-user settings and the registry

### 7a. Locations

| Item                 | Path                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State dir (registry) | `$WORKTREE_PORTS_STATE_DIR`, else `$XDG_STATE_HOME/worktree-ports`, else `~/.local/state/worktree-ports`. On Windows: `%LOCALAPPDATA%\worktree-ports`.    |
| Settings file        | `$XDG_CONFIG_HOME/worktree-ports/config.json`, else `~/.config/worktree-ports/config.json`. On Windows: `%APPDATA%\worktree-ports\config.json`. Optional. |

Settings:

```json
{ "range": { "min": 20000, "max": 32759 } }
```

The default range is 20000–32759, which is 1,276 ten-port blocks. It stays
below the ephemeral ranges the OS uses for outbound connections (32768+ on
Linux, 49152+ on macOS, BSD and Windows). `min` must be ≥ 1024 and a multiple
of 10; `max` must be ≤ 65535.

### 7b. Registry layout

```
<state>/
  lock/                 # mkdir-based lock (§7c)
  claims/
    20010.json          # one file per claim, named by its base port
    20040.json
```

A claim file:

```json
{
  "base": 20010,
  "size": 10,
  "gitDir": "/home/me/src/app/.git/worktrees/feat-x",
  "root": "/home/me/src/app/.worktrees/feat-x",
  "config": "worktree-ports.json",
  "claimedAt": "2026-10-21T18:30:00Z",
  "lastUsed": "2026-10-21"
}
```

The owner's identity is the pair (`gitDir`, `config`). `gitDir` is the
worktree's private git dir, absolute and symlink-resolved; git deletes it when
the worktree is removed. `config` is the config file's path relative to
`root`, with `/` separators, so a monorepo with a config per sub-project gets
one claim per sub-project. `root` and `claimedAt` are for `list` output only.
`lastUsed` drives `prune --unused-for` (§7d). Claims are intervals
`[base, base + size)` and must not overlap.

### 7c. Looking up and claiming

1. **Lookup, no lock needed:** scan `claims/` for the file whose `gitDir`
   and `config` equal ours. If found and valid (inside the range, `size` ≥
   what the config now needs), use it. If its `lastUsed` is before today,
   rewrite it with today's date under the lock. That happens at most once a
   day per claim, so lookups stay lock-free and cheap.
2. **Claim, under the lock:**
   1. Re-run the lookup. Another process may have just claimed for this same
      checkout; a backend and a frontend started together do exactly that.
   2. **Garbage-collect stale claims** by the rules in §7d.
   3. If we hold a claim that is now too small (the config grew), release it.
      Then try the same base at the new size first, so ports stay stable when
      possible.
   4. Pick a free aligned interval of the needed size at random. Random
      rather than lowest-first, so claimers racing from a broken lock don't
      all pick the same block.
   5. **Probe** each port in the candidate on `127.0.0.1` and `::1`. If
      anything is listening, skip the candidate. That avoids handing out a
      port held by a program that doesn't use this tool. The probe is
      best-effort: the port can still be taken after the claim.
   6. Write the claim file atomically (write a temp file, then rename), so a
      reader never sees half a file.
   7. **Backstop scan:** re-read every other claim and check none overlaps
      ours. This only matters if a claim file was written outside the lock
      (a hand edit, or a lock broken as stale while its holder was mid-write).
      Because every claimer writes before it scans, whichever of two racing
      claimers scans second sees the other. On a clash with a fresh claim,
      ours yields: it deletes its file and retries. If two _settled_ claims
      overlap, the one whose `gitDir` sorts later moves, so both sides agree
      without coordinating.
3. **The lock** is an atomic `mkdir` of `<state>/lock`. A claimer that finds it
   held retries in short steps for up to `lockTimeoutMs` (default 15 s), then
   fails, naming the lock's path. A lock untouched for `staleLockMs` (default
   10 s) was left by a process that died mid-claim; it's broken so the next
   claimer can proceed. The timeout is deliberately longer than the stale age:
   a claim takes milliseconds, so a waiter must outlive the stale age to be
   the one that breaks a dead lock instead of timing out first.

A claim file that can't be parsed or doesn't describe a valid interval is
ignored, as if absent. One that exists but can't be _read_ (a permissions
error, say) is an error: treating it as absent could hand its block to
someone else while it's still in use.

Because the lock and the claims are machine-wide, every repository on the
machine gets disjoint blocks with no coordination. A claim takes milliseconds,
so one global lock costs nothing in practice.

### 7d. Cleanup and exhaustion

The default range holds 1,276 ten-port blocks. Running out in practice means
claims are leaking, not real demand, so cleanup has to catch every way a
worktree disappears.

**Automatic: on every claim, and on `prune`.** A claim is stale, and deleted,
when either of these holds:

1. **Its `gitDir` no longer exists.** This covers `git worktree remove`,
   `git worktree prune`, `rm -rf` of a whole clone, and a clone that was moved
   or renamed (the moved clone claims afresh).
2. **It's a linked worktree whose working directory has gone.** This is the
   common leak: a worktree folder deleted by hand without git. Git keeps the
   admin dir `<common>/worktrees/<name>/` until `git worktree prune` runs, and
   `git gc` only does that after three months by default. The check is the one
   `git worktree prune` itself makes: read the admin dir's `gitdir` file
   (the absolute path of the worktree's `.git` file), and treat the claim as
   stale if that path doesn't exist. The tool only reads the admin dir and
   never deletes it; tidying git's state stays git's job.

**A claim is never stale, whatever the checks say, when** the admin dir holds
a `locked` file. That is git's own marker for "this worktree is on removable
or network storage; don't prune it" (`git worktree lock`), and the tool
honours it the same way.

**Never collected automatically:** a claim whose config file has gone while
its worktree still exists, since a branch checkout can remove the file for a
while. Also a claim that is merely old. Stable ports are the point, so an
unused worktree keeps its block until someone decides otherwise.

**Manual, via `prune` (§8):**

- `prune` removes stale claims by the rules above, plus claims whose config
  file no longer exists.
- `prune --unused-for <duration>` (e.g. `90d`, `12w`) also removes claims
  whose `lastUsed` is older than that. That's for worktrees that still exist
  but are idle.
- `prune --dry-run` reports what it would remove without removing anything.
- Each removal is reported with its base, root and reason.

**Exhaustion.** When no free interval is left after automatic cleanup, the
claim fails (exit 1) with a message that:

- Lists every claim, oldest `lastUsed` first, with base, size, root and last
  use.
- Suggests `worktree-ports prune --unused-for 30d` and
  `worktree-ports release` (run in a worktree you're done with).
- Notes the range can be widened in the settings file (§7a).

**Accepted trade-off: unmounted storage.** A clone (or main checkout) on an
external or network drive that is unmounted when another claim runs looks
deleted. Its claim is collected and it gets new ports on its next run. That's
a one-time port change, never a collision. Linked worktrees can avoid it with
`git worktree lock`. The README's limitations section says so.

## 8. CLI

```
worktree-ports show    [--json] [--config <path>]
worktree-ports status  [--json] [--config <path>]
worktree-ports env     [--config <path>]
worktree-ports exec    [--verify] [--config <path>] -- <command> [args...]
worktree-ports list    [--json]
worktree-ports release [--config <path>]
worktree-ports prune   [--unused-for <duration>] [--dry-run]
worktree-ports --version | --help
```

- **`show`** prints the context (§5) and why it was chosen (`linked worktree`,
  `main checkout`, `CI`, `no git`, `WORKTREE_PORTS=…`), the checkout's name
  and root, its block (if any), and each service's port. `--json` prints the
  full resolution, including the rendered `env`, for scripting. Claims a block
  if the context calls for one and none exists yet.
- **`status`** reports, for each service port, whether something is listening.
  It probes both `127.0.0.1` and `::1`, because a dev server bound to
  `localhost` may listen on only one. For the service `verify.url` points at,
  it also asks who that server belongs to: `mine`, `other` (with the root it
  reported), or `unknown`. `--json` prints
  `{ context, name, root, services: [{ service, port, listening, owner?, ownerRoot? }] }`.
  Always exits 0 once ports resolve.
- **`env`** prints shell-quoted `export KEY=value` lines for every rendered
  variable, for `eval "$(worktree-ports env)"`. Unlike `exec`, these lines
  overwrite whatever the shell has; that's the point of evaluating them.
- **`exec -- <command>`** runs the command with the rendered env merged in
  (never overwriting, §5) and exits with its result.
  - It forwards `SIGTERM` to the child.
  - It does **not** forward `SIGINT`. Ctrl-C in a terminal already reaches
    the whole foreground process group, including the child; forwarding it
    too would deliver it twice and break tools that treat a second Ctrl-C as
    "force quit". The wrapper ignores `SIGINT` itself while the child runs,
    so it can still report the child's exit code.
  - With no config found, it warns and runs the command unchanged.
- **`exec --verify`** first asks the server at `verify.url` who it belongs to:
  - **match** (the field equals `verify.expect`): start the command.
  - **mismatch** (the field names another checkout): refuse, exit 1. This is
    the case it exists for: a server left running from another checkout,
    perhaps one since deleted, answering on this checkout's port.
  - **unreachable or unreported** (nothing answered, or no such field): warn
    and start anyway, since there's nothing yet to conflict with.

  The checked server must expose its checkout root (or another per-checkout
  value) at that field, and should do so only outside production, since it's
  a local filesystem path.

- **`list`**: every claim in the registry, across all repositories: base,
  size, root, config, last use, and whether it's stale (with the reason from
  §7d). Doesn't need a config.
- **`release`**: delete this checkout's claim (under the lock). The next run
  claims afresh, which is the fix for "my block clashes with something
  that doesn't use this tool".
- **`prune`**: cleanup as described in §7d, reporting what it removed (or
  would remove, with `--dry-run`).

Exit codes:

| Code           | Meaning                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `0`            | Success, or the child's own `0`.                                                                                  |
| (child's code) | Whatever `<command>` exited with.                                                                                 |
| `1`            | Port resolution failed (bad config, no free block, lock timeout, registry error), or `--verify` found a mismatch. |
| `2`            | Usage error (bad flags, missing command).                                                                         |
| `127`          | The child failed to spawn.                                                                                        |
| `128 + n`      | The child was killed by signal `n`.                                                                               |

## 9. Platforms

- macOS and Linux: supported, tested in CI.
- Windows: supported for `show`/`env`/`exec`/`status`/`list`/`release`/`prune`,
  tested in CI. `mkdir` locking and atomic rename work there. `exec`'s signal
  handling differs: there's no `SIGTERM` to forward, and Ctrl-C reaches the
  whole console group anyway, so the child exits and the wrapper reports its
  code. Signal tests are skipped on Windows; the README says so. `exec` finds
  the command through `PATH` and `PATHEXT`; a `.cmd`/`.bat` (`npm`, `npx`,
  `node_modules/.bin` shims) runs through `cmd.exe /d /s /c` with its
  arguments escaped for cmd, since Node won't spawn those without a shell.

## 10. Wiring a server

The contract with servers is just environment variables. A server reads its
port (or listen address) from the variable the config names. For `--verify`, a
backend adds the checkout root to its health response. The handler fails
closed: it includes the root only when `WORKTREE_ROOT` is set (only
`worktree-ports exec` sets it, so a deployment never has it) and the socket's
peer is a loopback address. Loopback alone isn't enough, since a reverse proxy
on the same host makes every request look local; an environment-name gate
(`NODE_ENV !== "production"`) fails open wherever the variable is unset. The
peer comes from the socket, never from a forwarding header or proxy trust:

```ts
app.get('/healthz', (req, res) => {
  const peer = req.socket.remoteAddress ?? ''
  const local = peer === '::1' || /^(::ffff:)?127\./.test(peer)
  const root = process.env.WORKTREE_ROOT
  res.json({ status: 'ok', ...(root && local ? { worktreeRoot: root } : {}) })
})
```

The README carries the same in Go and Python (§13).

## 11. Programmatic API

- `resolvePorts(opts?) → Promise<ResolvedPorts>`: find the config, work out the
  context, claim or look up the block, and render `env` and `verify`.
- `findConfig(cwd?)`, `parseConfig(raw, source?)`, `loadConfig(path)`.
- `locateWorktree(cwd?)`: git location of the checkout containing `cwd`.
- `claimBlock(loc, size, registry, hooks?)`: claim or look up a block directly.
- `openRegistry(opts?) → { list(), release({ gitDir, config }), prune(opts) }`.
- `renderTemplate(template, ctx)`, `mergeEnv(base, values)`.
- `verifyIdentity(spec, opts?)`, `serviceStatus(resolved, opts?)`,
  `isListening(port, timeoutMs?)`, `probe(port, host, timeoutMs?)`.

`hooks` are test seams (random source, a callback between write and scan,
lock timings). The API is semver-governed from 1.0; 0.x releases may break it.

## 12. Repository layout and release

```
src/  bin/  test/  example/  schema.json  README.md  CHANGELOG.md  LICENSE
.github/workflows/ci.yml       # §12a
.github/workflows/release.yml  # §12a
```

Versioning starts at 0.1.0; 1.0 follows once it has run in real projects for a
while.

### 12a. GitHub Actions

**`ci.yml`**, on push to `main` and on every pull request:

- `concurrency` cancels superseded runs of the same ref.
- `permissions: contents: read`.
- Install with `npm ci` from the committed `package-lock.json`.

| Job       | Runs on                                            | Steps                                                                                                                                      |
| --------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `lint`    | ubuntu, Node 24                                    | Prettier check, `tsc --noEmit`                                                                                                             |
| `test`    | ubuntu, macos, windows × Node 22, 24               | `npm test` (unit and integration)                                                                                                          |
| `pack`    | ubuntu, Node 24                                    | `npm run build`, `npm pack`, upload the tarball as an artifact                                                                             |
| `smoke`   | ubuntu, macos, windows × Node 20, 24; needs `pack` | Install the tarball into a fresh temp git repo with a linked worktree; run `show`, `env`, `exec`, `list` from both; assert different ports |
| `example` | ubuntu, macos; needs `pack`                        | The end-to-end example test (§12b) against the tarball                                                                                     |

Smoke and example tests use the packed tarball, not the source tree, so they
test exactly what users install, including the `bin` entry and the `files`
list.

Test environment rules, enforced by the shared test setup (local and CI):

1. **`CI` is removed from every test's environment.** GitHub sets
   `CI=true`. Left in place, it switches the tool to defaults-only (§5), so
   claim and race tests would silently exercise the wrong path. Only the
   CI-context tests set it, explicitly.
2. **`WORKTREE_PORTS_STATE_DIR` must point at a fresh temp dir.** The setup
   creates one per test file. Any code path that resolves the real
   `~/.local/state` (or `%LOCALAPPDATA%`) during tests throws, so nothing a
   test does can touch a developer's real registry.
3. **`WORKTREE_PORTS` and the XDG/`APPDATA` variables are cleared** the same
   way, for the same reason.
4. **Throwaway git repos carry their own git identity.** The repo helper sets
   `GIT_AUTHOR_NAME`/`EMAIL` and `GIT_COMMITTER_NAME`/`EMAIL`, plus
   `-c core.autocrlf=false` and `-c init.defaultBranch=main`. Runners have
   no global git config, and Windows would otherwise rewrite line endings.
5. Git ≥ 2.31 is asserted once at startup with a clear message. All current
   runner images pass.

**`release.yml`**, on a `v*` tag:

1. Fail unless the tag equals `v` + `package.json` `version`, and
   `CHANGELOG.md` has a section for it.
2. Run the full `ci.yml` (as a reusable workflow) against the tag.
3. `npm publish --provenance --access public` via **npm trusted publishing**:
   `permissions: id-token: write`, and no long-lived `NPM_TOKEN` secret.
4. Create a GitHub Release whose body is that version's `CHANGELOG.md`
   section.

### 12b. Example project

`example/` is a tiny two-server app wired to the tool. It serves three
purposes: a hands-on demo linked from the README's quick start, the copyable
reference wiring, and the end-to-end test bed run in CI.

```
example/
  README.md               # what it shows; two-worktree walkthrough
  package.json            # scripts only; devDependency "worktree-ports": "file:.."
  worktree-ports.json
  backend.mjs             # API server
  frontend.mjs            # page server + /api proxy
```

- **No dependencies, no build:** plain ESM JavaScript using only `node:http`.
  Each server is under ~60 lines.
- **`worktree-ports.json`:** services `backend` (offset 0, default 4100) and
  `frontend` (offset 1, default 4000). Env: `BACKEND_PORT`, `PORT`,
  `BACKEND_ORIGIN=http://127.0.0.1:{backend}`, `WORKTREE_ROOT={root}`. A
  `verify` block points at the backend's `/healthz`, field `worktreeRoot`.
- **`backend.mjs`:** listens on `127.0.0.1:$BACKEND_PORT`. It serves
  `/healthz` → `{"status":"ok","worktreeRoot":…}`, with the root included only
  when `WORKTREE_ROOT` is set and the socket's peer is a loopback address
  (§10), and `/api/hello` → the worktree root and its own port.
- **`frontend.mjs`:** listens on `127.0.0.1:$PORT`, proxies `/api/*` to
  `$BACKEND_ORIGIN`, and serves one HTML page. The page shows the worktree the
  frontend runs in next to the one the backend reports, highlighting any
  mismatch. That makes the problem the tool solves visible.
- **Scripts:**
  - `npm run backend`: `worktree-ports exec -- node backend.mjs`
  - `npm run frontend`: `worktree-ports exec --verify -- node frontend.mjs`
  - `npm run ports`: `worktree-ports show`
- The example's config sits in `example/`, not at the repo root, so it also
  demonstrates upward config discovery and per-config claims (§6a, §7b).
- The example contains no other language, by design. The README carries the
  short Go and Python snippets.

**End-to-end test** (`test/e2e/example.test.ts`, run by the `example` CI job
and locally via `npm run test:e2e`):

1. Create a temp repo containing `example/` and a linked worktree, with the
   packed tarball installed.
2. Start backend and frontend in both checkouts at once, then wait for them to
   listen.
3. In each checkout, `GET /api/hello` through the frontend returns that
   checkout's own root. The two checkouts use different ports, and the main
   checkout uses the defaults.
4. Start a backend from the main checkout on the linked worktree's backend
   port (by setting `BACKEND_PORT` explicitly), then start the worktree's
   frontend: `exec --verify` exits 1.
5. With `CI=true`: both checkouts resolve to the defaults and the registry is
   untouched.
6. Every child process is killed in teardown, even when the test fails.

Windows is left out of the e2e job; its process-tree teardown is a source of
flakiness that tests nothing new. The `smoke` job covers Windows.

## 13. README

`README.md` is the project's home page on GitHub and npm, so it is a
deliverable of this work, not an afterthought. It's written for someone who
has never heard of the tool, and it describes the built behaviour. It is the
last task of the implementation plan, checked against the finished CLI, and
every command and config example in it is run during that check.

Contents, in order:

1. **Name, one-line pitch, badges** (npm version, CI status, licence).
2. **The problem**, from §1, led by the coordination point: servers in a
   second worktree can't use the usual ports. A server that picks a free one
   can't tell the others, so the frontend still reaches whichever backend owns
   the usual port. Kept short and concrete.
3. **Quick start**: install (`npm i -D worktree-ports` or `npx`), a minimal
   two-service `worktree-ports.json`, wrapping a dev script with `exec`, and
   `show` printing different ports in two worktrees. Ends with a link to
   `example/` for a runnable version.
4. **How it works**: blocks, the per-user registry, stable ports, freeing on
   worktree removal, no daemon. Then the context table from §5 (linked
   worktree, main checkout, CI, no git) and why defaults are used outside
   worktrees. The full claim protocol stays in `docs/`, linked from here.
5. **Configuration reference**: every field of `worktree-ports.json`, template
   tokens, block sizing, discovery, and the `$schema` line for editor
   completion.
6. **CLI reference**: every command and flag, and the exit-code table.
7. **Environment variables**: `WORKTREE_PORTS`, `WORKTREE_PORTS_STATE_DIR`,
   `CI`, and the never-overwrite rule with its warning.
8. **Per-user settings**: the settings file, its location per platform, and
   the default range with why it ends below 32768.
9. **Guarding against the wrong backend (`--verify`)**: what it checks, the
   match/mismatch/unreachable outcomes, and a health endpoint example in a few
   languages (Node, Go, Python) that exposes the checkout root outside
   production only.
10. **Wiring examples**: `package.json` scripts, a Vite/Next-style dev server
    reading `PORT`, a server in another language reading its address from the
    env, a `Makefile` target, and a CI job.
11. **Programmatic API**: a short summary with one example; the full signatures
    live in the shipped `.d.ts`.
12. **Platforms and requirements**: Node versions, git ≥ 2.31, and the Windows
    signal caveat from §9.
13. **FAQ / limitations**: why not port 0 or free ports found at startup
    (they change every run, and OS-assigned ports come from the range used for
    outbound connections, so one reported free can be taken a moment later),
    how blocks are freed (§7d), what
    happens on exhaustion, unmounted drives and `git worktree lock`, clashes
    with programs that don't use the tool (`release`), loopback only.
14. **Contributing and licence.**

All examples use generic project names, paths and variables.

## 14. Testing

- **Unit:** config parsing and validation (every rule in §6b), template
  rendering, env merging and its warning, block sizing, duration parsing for
  `--unused-for`.
- **Integration, against throwaway git repos and a temp registry:**
  - Claim, sticky re-lookup, and two worktrees getting disjoint blocks.
  - Two repos, one registry: disjoint blocks.
  - Races: two concurrent claimers for one checkout get the same block; two
    for different checkouts get different ones; the write-then-scan backstop
    (via the between-write-and-scan hook); a stale lock is broken; a held
    lock times out with its path in the error.
  - Unparseable claim files are ignored; unreadable ones are an error.
  - A claim that grows when the config adds services, keeping its base when
    it can.
  - The probe skips a listening candidate.
  - Cleanup by each rule in §7d:
    - `gitDir` gone;
    - linked worktree folder deleted while its admin dir remains;
    - a `locked` admin dir is kept;
    - a config-gone claim is kept by automatic cleanup but removed by `prune`;
    - `--unused-for` and `--dry-run`.
  - `lastUsed` written at most once a day.
  - The exhaustion error lists claims oldest first.
  - Every context row in §5 and every `WORKTREE_PORTS` value.
  - Config discovery walking upward, per-config claims, and no git.
  - A `default` inside the range is rejected.
  - CLI: every command's output and `--json` shape, exit codes, `exec`
    never-overwrite, signal forwarding (skipped on Windows), and `--verify`'s
    match / mismatch / unreachable / unreported outcomes against a stub
    server.
- **End-to-end:** the example test (§12b).
- Tests never touch the real registry (§12a rule 2).

## 15. Decisions

1. **No alias bin.** The only command is `worktree-ports`, to avoid clashing
   with other tools.
2. **A `default` inside the claim range is an error (§6b).** The collision
   it prevents is silent, while the error is loud, rare (normal dev ports sit
   far below the range) and fixed in one line.
