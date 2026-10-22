# worktree-ports example

A two-server app wired to `worktree-ports`: a backend that reports which checkout it runs in, and a frontend that
proxies `/api/*` to it and shows both checkouts side by side. If the two ever differ, the page shows a red banner.
That is the problem `worktree-ports` solves: two worktrees of one project must not end up talking to each other's
servers.

- `worktree-ports.json` declares two services. The scripts pass `--port <service>`, so each server gets its own port as
  `PORT`; the shared `env` map holds only the values every process needs.
- `backend.mjs` and `frontend.mjs` use only `node:http`, with no dependencies and no build step.
- The main checkout gets the defaults (frontend 4000, backend 4100). Every linked worktree gets its own stable block
  of ports, at 20000 or above.

## Two-worktree walkthrough

From this directory, inside a git repository:

```sh
npm install                      # links the tool via "file:.."
git worktree add ../app-feature  # a second checkout of the same project
```

Then, in each checkout's `example/` directory (two terminals each, or run them in the background):

```sh
npm run backend
npm run frontend
```

`npm run ports` prints the ports for the checkout you are in. Open both frontend URLs: each page shows its own
checkout on both lines and no banner. `npm run frontend` uses `exec --verify`, so it refuses to start when the
backend on its port belongs to a different checkout.
