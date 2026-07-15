# Performance guidelines

Performance is a feature, but it is the one feature you must **measure before you
change**. The rules below split along the two runtimes in this repo:

- **Backend** — the Bun daemon (`apps/monad`) and its packages (`@monad/store`,
  `@monad/kv`, `@monad/agent-core`, `@monad/protocol`, …). Long-lived process,
  serving REST + a multiplexed WebSocket over TCP/UDS. See [runtime.md](../internals/runtime.md),
  [daemon-architecture.md](../internals/daemon-architecture.md), and
  [engineering/architecture.md](architecture.md).
- **Frontend** — the web client (`apps/web`): Vite, TanStack Router, React 19,
  Redux, Tailwind 4. See [design/ui-guidelines.md](../design/ui-guidelines.md) and
  [web-router.md](../internals/web-router.md).

> **Measure first.** No optimization lands without a before/after number from one of
> the profiling procedures below. "Looks faster" is not a result. A micro-optimization
> that complicates the code without a measured win is a net loss — readability is also
> a budget (see [conventions.md](conventions.md)).

The budget tables below are **starting targets**, not ratified SLAs. Treat a regression
past a budget as a bug to investigate, and update the number here (with a reason) when
the team agrees to move it.

---

## Backend (daemon)

The daemon is a single long-lived process. Its performance story is dominated by three
things: how fast it cold-starts, how cheap a single request/stream tick is, and whether
it leaks memory over a multi-hour session.

### Budgets

| Metric | Target | Why it matters |
|---|---|---|
| Cold start (process → first request served) | < 300 ms | `monad up` should feel instant; the CLI waits on this. |
| REST request p50 / p99 | < 15 ms / < 100 ms | Excludes model/tool latency — measures *our* overhead only. |
| WS push fan-out latency (event → client byte) | < 10 ms | Streaming feels live only if our hop is negligible. |
| Steady-state RSS, idle daemon | < 150 MB | Headroom for many concurrent sessions. |
| RSS growth across a long session | ~0 after GC | Non-trivial growth = a retained-reference leak. |

### Rules

- **Keep the hot path allocation-free.** The per-token streaming tick
  (`stream-session`, agent-core loop) runs thousands of times per response. No JSON
  re-parse, no schema re-`parse`, no array spread per token. Validate once at the
  boundary, then pass typed values through.
- **`parse` at the edge, not in the loop.** Zod validation belongs at the
  HTTP/WS/disk boundary (per [conventions.md](conventions.md) typing rules). Re-parsing
  the same payload deeper in the call stack is wasted CPU on every request.
- **SQLite: prepare once, reuse.** `@monad/store` and `@monad/kv` run on `bun:sqlite`.
  Hoist `db.query(...)` statements to module/instance scope so they are prepared once,
  not per call. Wrap multi-row writes in a single transaction — one `fsync` beats N.
- **Never block the event loop.** No sync FS in a request handler, no unbounded sync
  loops. Use `Bun.file`, streams, and `await`. A blocked loop stalls *every* in-flight
  session, not just the caller's.
- **Bound everything that grows.** Message history, event buffers, in-memory caches —
  give each a ceiling and an eviction rule. An unbounded `Map` keyed by session id is
  the canonical daemon leak.
- **Lazy-load cold modules.** Gate dev-only / rarely-used subsystems behind a dynamic
  `import()` inside a `NODE_ENV` branch so they stay out of the cold-start path (and
  out of the release binary) — see the dead-code-elimination example in
  [conventions.md](conventions.md).
- **Stream, don't buffer.** Large tool outputs and file reads go to the client as a
  stream; never accumulate a multi-MB string in memory to send in one frame.

### Profiling

```sh
# CPU profile the daemon (Bun's built-in inspector → chrome://inspect)
bun --inspect apps/monad/src/main.ts

# Wall-clock + RSS of cold start
/usr/bin/time -l bun apps/monad/src/main.ts   # -l prints peak RSS on macOS

# Microbenchmark a hot function in isolation
bun test --filter <bench-name>      # use bun's `expect`/timing in a *.bench.ts
```

To hunt a leak: drive a long scripted session, then sample RSS at idle between turns.
Flat RSS after GC settles = clean; a staircase = a retained reference. The usual
culprits are event listeners never removed and per-session entries never evicted.

---

## Frontend (web)

The web client's perceived performance is dominated by two phases: **first load**
(bundle + hydrate) and **streaming render** (re-rendering the transcript on every
token). Markdown rendering during streaming is the single biggest hot path.

### Budgets

| Metric | Target | Why it matters |
|---|---|---|
| First-load JS (gzipped, route shell) | < 200 KB | Time-to-interactive on the chat view. |
| LCP (chat view, warm cache) | < 1.5 s | First paint of a usable transcript. |
| INP (typing, sending, scrolling) | < 200 ms | Input must never feel laggy. |
| Re-render cost per streamed token | < 4 ms | Below one 60 fps frame, or streaming janks. |

### Rules

- **The transcript re-renders on every token — make that cheap.** Memoize message
  components (`React.memo`) so a new token only re-renders the *streaming* message,
  not the whole list. Key by stable message id, never by array index.
- **Markdown parsing is the hot path.** `streamdown`/mermaid re-parsing the full
  message text on every token is O(n²) over a response. Parse incrementally and
  memoize rendered blocks that haven't changed; only the trailing block is in flux.
- **Select narrowly from Redux.** A `useSelector` that returns a new object/array each
  render re-renders on every store change. Select primitives, or use a memoized
  selector. The streaming reducer fires constantly — subscribers must be surgical.
- **Virtualize long transcripts.** Past a few hundred messages, render only the visible
  window. Mounting the full DOM tree blows the INP and LCP budgets.
- **Keep the bundle lean.** Import `HugeiconsIcon` plus named icons from `@hugeicons/core-free-icons` (no
  barrel-import of the whole set). Lazy-load heavy, rarely-shown widgets (mermaid
  diagrams, syntax highlighting, settings panels) with `React.lazy` and dynamic imports.
- **Don't fetch on every keystroke.** Debounce search/filter inputs; the daemon's
  `search-sessions` endpoint is not free.
- **No layout thrash in the scroll/stream loop.** Batch DOM reads and writes; avoid
  reading layout (`offsetHeight`, `scrollTop`) and writing styles in the same frame
  during auto-scroll.

### Profiling

```sh
# Production build with per-route bundle sizes in the output table
bun run --cwd apps/web build

# Inspect emitted chunks and source maps in apps/web/out
du -sh apps/web/out/*

# Runtime: React DevTools Profiler (flamegraph of re-renders during streaming)
# Runtime: Chrome DevTools → Performance tab; watch INP and long tasks while typing
```

Compare the named chunks emitted by Vite — a route or vendor chunk that jumps in size
between PRs is a regression to explain. For render cost, record a Performance trace
*while a response streams in* and look for re-renders of components that did not change.

---

## When something is slow

1. **Reproduce and measure** with the relevant tool above — get a number.
2. **Find the dominant cost** (one flamegraph frame, one bundle entry, one query).
   Don't guess; the bottleneck is rarely where intuition points.
3. **Fix the dominant cost only.** Re-measure. If the win is real, keep it; if it
   complicates the code for no measured gain, revert.
4. **Record it** — if a known bottleneck is *acceptable* (e.g. a cold path), say so
   here so the next person doesn't re-investigate.

## Known bottlenecks

_None recorded yet. When you accept a bottleneck as a deliberate trade-off, add it here
with the reason and the number that makes it acceptable._
