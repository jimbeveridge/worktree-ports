# worktree-ports

Gives every git worktree of a project its own stable block of local ports.

Design spec: `docs/superpowers/specs/2026-10-21-worktree-ports-design.md`

## Commands

- `npm test`: unit and CLI tests (`node --test`, TypeScript run directly; Node >= 22.18). Run one file or one test
  with the preload: `node --test --import ./test/setup.ts test/cli.test.ts --test-name-pattern="regex"`.
- `npm run test:e2e`: end-to-end tests in `test/e2e/`. They run `npm pack` themselves, which is slow; set
  `WORKTREE_PORTS_TARBALL=<path.tgz>` to reuse a tarball.
- `npm run lint`: `prettier --check . && tsc --noEmit`.
- `npm run format`: `prettier --write .`.
- `npm run build`: `tsc -p tsconfig.build.json` into `dist/`.

Before committing, `npm run lint && npm test` must pass.

## Rules

- Every test run is preloaded with `test/setup.ts` (the npm scripts do this). It points the registry, XDG and
  `APPDATA` dirs at a temp dir, clears `CI`, `WORKTREE_PORTS`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR` and
  `GIT_INDEX_FILE`, and sets `WORKTREE_PORTS_UNDER_TEST=1`, which makes `src/settings.ts` throw on any registry or
  settings path outside `os.tmpdir()`. Never run tests without it, and never let a test touch the real registry or
  settings.
- Never mention another project anywhere in this repo (code, docs, tests, examples, commit messages). Use generic
  names and paths. Describe history generically ("the earlier in-repo version"). Both gates must print nothing,
  run after staging and before each commit:
  - `git grep -n -i -w -f "$(git rev-parse --git-common-dir)/reference/forbidden.txt" -- . ':!package-lock.json'`
  - `git log --format=%B "$(git rev-list --max-parents=0 HEAD)"..HEAD | grep -i -w -f "$(git rev-parse --git-common-dir)/reference/forbidden.txt"`
    (also pipe the draft commit message through the second grep)
- Commits use Conventional Commits, with a body that explains why.
- No runtime dependencies. ESM only. Source imports use `.ts` extensions; the build rewrites them.
- The runtime supports Node >= 20 (`engines`, smoke-tested in CI); only development needs 22.18. `src/` and `bin/`
  must not use APIs newer than Node 20.
- `schema.json` at the root ships in the package; update it with any config-format change.
- Local `npm test` doesn't cover Windows, Node 20 or the packed tarball; CI does. `src/command.ts` uses `path.win32`
  on purpose and runs `.cmd`/`.bat` through `cmd.exe`.
- Path guards compare real paths with `path.basename` or `path.relative`, never by slicing strings, which breaks at
  the filesystem root.
- Staleness and cleanup err toward keeping claims: any filesystem error they cannot decide counts as in use. Use
  `pathExists` (`src/git.ts`), not `existsSync`, which returns false on `EACCES`. Tests may use `existsSync`.

## Releasing

Bump the `package.json` version, change the `CHANGELOG.md` heading to `## [X.Y.Z] - YYYY-MM-DD` (release CI rejects
anything else), commit, then push tag `vX.Y.Z`. CI publishes to npm with provenance; there is no token.
