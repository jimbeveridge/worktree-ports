# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

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
