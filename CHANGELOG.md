# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

### Security

- A config's `env` names must start with `WORKTREE_` (not `WORKTREE_PORTS`), so an untrusted checkout's config can
  never set `PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, `PS1` or any other variable that changes how a program loads code,
  whether through `exec` or an `eval` of `env`. A server's own `PORT` comes from `exec --port`.
- Config discovery stops at the checkout's top level (a submodule's, inside one). On macOS and Linux, a config found
  outside any checkout is refused when it belongs to another user, or when other users could write it or its
  directory; `--config` bypasses the check.
- On Windows, `exec` looks commands up on `PATH` itself, skipping relative entries, and spawns the path it found, so a
  checkout can't plant `npm.cmd` or `node.exe` in the current directory.

### Added

- Stable, machine-wide port blocks: every linked git worktree of a project gets its own block of local
  ports, claimed once and kept across runs, with the main checkout keeping its configured defaults.
- A claim registry shared by all projects on the machine, protected by a lock, with stale-claim pruning.
- Context-aware port resolution for the main checkout, linked worktrees, CI (defaults only) and
  directories outside git.
- The `show`, `status`, `env`, `exec`, `list`, `release` and `prune` commands, with `--json` output where
  it applies and `--verify` checks that a port is served by this checkout.
- A JSON config file with services, port offsets, defaults, environment templates and a `verify` block, plus
  a published JSON schema.
- A typed library API alongside the command line tool.
- `exec --port <service>` sets `PORT` to that service's port for one child only, so each server can get its own
  without a shared `PORT` in the config's `env`. `env --port <service>` prints the same lines.
- `WORKTREE_PORTS_PORT`, set by `exec --port` to mark the `PORT` it gave, so a nested `exec --port` can replace its
  own `PORT` without overwriting one a person or CI pinned.
- `exec -v` / `--verbose` prints which variables the tool set or kept, never the rest of the environment.
- `WORKTREE_PORTS_ACTIVE=1`, set by `exec` in every child, so a launcher that re-runs itself under `exec` can
  avoid recursing.
