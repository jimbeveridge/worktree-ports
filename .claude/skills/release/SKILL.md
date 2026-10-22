---
name: release
description: Cut a worktree-ports release - bump the version, date the CHANGELOG heading, verify, commit and tag vX.Y.Z, then push only after confirmation. Use when the user runs /release.
disable-model-invocation: true
---

# Release worktree-ports

Target version: `$ARGUMENTS` (X.Y.Z, no `v`). If empty, release the current `package.json` version (the first
release, where the version is already set). Pushing the tag publishes to npm through
`.github/workflows/release.yml`; nothing is published until then.

## 1. Preflight (stop and report on any failure)

- On `main`, working tree clean (`git status --porcelain` empty), and up to date with `origin/main` after
  `git fetch`.
- The version is valid semver, greater than the last `v*` tag (`git tag -l 'v*' --sort=-v:refname | head -1`), and
  the tag `vX.Y.Z` does not already exist locally or on `origin`.
- `CHANGELOG.md` has a `## [X.Y.Z] - Unreleased` or `## [Unreleased]` section with at least one entry. The release
  workflow uses that section as the GitHub release notes, so an empty section is a stop.

## 2. Bump and date

- If the version changes: `npm version X.Y.Z --no-git-tag-version` (updates `package.json` and
  `package-lock.json`).
- Rewrite the changelog heading to exactly `## [X.Y.Z] - YYYY-MM-DD` with today's date. Release CI checks it with
  `grep -qxE "## \[X\.Y\.Z\] - [0-9]{4}-[0-9]{2}-[0-9]{2}"`; confirm that grep matches locally.

## 3. Verify

Run all of these; every one must pass:

```sh
npm run lint && npm test && npm run build && npm run test:e2e
```

Then, after staging, run both forbidden-word gates from `CLAUDE.md`; they must print nothing. Pipe the draft commit
message through the second gate too.

## 4. Commit and tag

- Commit `package.json`, `package-lock.json` and `CHANGELOG.md` as `chore(release): vX.Y.Z`, with a body saying
  why (the release, and the changelog section it ships).
- Create an annotated tag: `git tag -a vX.Y.Z -m "vX.Y.Z"`.

## 5. Push (ask first)

Show the commit, the tag, and the changelog section that will become the release notes, then ask the user before
running `git push origin main vX.Y.Z`. Pushing publishes the package to npm and cannot be undone. After the
push, report the Actions run: `gh run list --workflow=release.yml --limit 1`.
