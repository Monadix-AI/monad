# Web UI router

`apps/web` is a React SPA built by Vite and routed by TanStack Router. Vite emits the
production assets to `apps/web/out`; the release binary embeds those assets and the
web server serves `index.html` as the SPA fallback.

## Route source of truth

Routes live under `apps/web/src/routes`:

```text
__root.tsx             global providers, metadata, and root outlet
_shell.tsx             authenticated/application shell layout
_shell/index.tsx       workspace route
_shell/inbox.tsx       inbox route
init/route.tsx         initialization flow
```

The TanStack Router Vite plugin generates `apps/web/src/routeTree.gen.ts`. Do not edit
that file. Run `bun run --cwd apps/web generate:routes`, `bun run typecheck:prepare`,
or the root quality gate to refresh it.

`apps/web/src/main.tsx` creates the router from the generated tree with intent
preloading, structural sharing, and scroll restoration, then mounts one
`RouterProvider` under React strict mode.

## Development server

`apps/web/vite.config.ts` owns the local server contract:

- `WEB_PORT` selects the strict Vite port; a collision fails instead of silently
  moving the UI to another worktree's port.
- `/api`, `/v1`, and WebSocket traffic proxy to the daemon endpoint resolved from
  `MONAD_PORT` and the worktree configuration.
- HMR stays inside the Vite process; daemon hot reload remains a separate Turbo task.
- devtool ports are injected as compile-time constants for the local UI.

Do not add server authority to Vite routes. Business logic and persistence stay in
the daemon; the browser consumes protocol/client packages through the HTTP and
WebSocket boundaries.

## Navigation state

Use TanStack Router route paths and validated search parameters for state that should
survive refresh or browser navigation. Keep transient interactions—open menus,
unfinished local forms, hover state—in component state. Route layouts own shared
providers; feature components should not create parallel router or history state.

## Code splitting and performance

Use dynamic `import()` and `React.lazy` for heavy routes or panels that are not needed
for the initial shell. Vite's `advancedChunks` configuration already groups Monad
domains and major vendor families; add a new manual group only after measuring a
bundle regression.

## Production serving

`apps/web/server/index.ts` serves the built assets and proxies daemon API routes. API
and health routes take precedence over SPA fallback. Unknown UI paths return
`index.html`, allowing TanStack Router to resolve deep links client-side.
