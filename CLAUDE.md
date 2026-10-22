# worktree-ports

Gives every git worktree of a project its own stable block of local ports.
Design spec: `docs/superpowers/specs/2026-10-21-worktree-ports-design.md`.
Implementation plan: `docs/superpowers/plans/2026-10-21-worktree-ports.md`.

## Commands

- `npm test`: unit and CLI tests (`node --test`, TypeScript run directly; Node >= 22.18).
- `npm run test:e2e`: end-to-end tests in `test/e2e/`.
- `npm run lint`: `prettier --check . && tsc --noEmit`.
- `npm run format`: `prettier --write .`.
- `npm run build`: `tsc -p tsconfig.build.json` into `dist/`.

Before committing, `npm run lint && npm test` must pass.

## Rules

- Every test run is preloaded with `test/setup.ts` (the npm scripts do this). It points the registry, XDG and
  `APPDATA` dirs at a temp dir and clears `CI`, `WORKTREE_PORTS` and `GIT_*` variables. Never run tests without it,
  and never let a test touch the real registry or settings.
- Never mention another project anywhere in this repo (code, docs, tests, examples, commit messages). Use generic
  names and paths. Describe history generically ("the earlier in-repo version"). Both gates must print nothing,
  run after staging and before each commit:
  - `git grep -n -i -w -f "$(git rev-parse --git-common-dir)/reference/forbidden.txt" -- . ':!package-lock.json'`
  - `git log --format=%B "$(git rev-list --max-parents=0 HEAD)"..HEAD | grep -i -w -f "$(git rev-parse --git-common-dir)/reference/forbidden.txt"`
    (also pipe the draft commit message through the second grep)
- Commits use Conventional Commits, with a body that explains why.
- No runtime dependencies. ESM only. Source imports use `.ts` extensions; the build rewrites them.
- Path guards compare real paths with `path.basename` or `path.relative`, never by slicing strings, which breaks at
  the filesystem root.
- Staleness and cleanup err toward keeping claims: any filesystem error they cannot decide counts as in use. Use
  `pathExists`, not `existsSync`, which returns false on `EACCES`.
