# Memory

How the shipped memory subsystem works. This describes the code as it runs today;
the original layered design (with its event-log storage model, OTR, Advanced Mode
state machine, and other ideas that were revised or dropped) is preserved as a
proposal in [proposals/memory-design.md](../proposals/memory-design.md) — where the
two differ, this document and the code win.

Code map:

| Piece | Lives in |
|---|---|
| L1 contracts + sanitize/render | `apps/monad/src/agent/memory/` (`layered.ts`) |
| L1 Markdown store (`MemoryDir`) | `apps/monad/src/store/db/memory-dir.ts` |
| Orchestration (L1 service, L2 graph, L3 laws, pipeline, settings) | `apps/monad/src/services/memory/` + `apps/monad/src/agent/memory/subsystem.ts` |
| Wire/domain types (`Fact`, `MemoryScope`, control API shapes) | `packages/protocol/src/memory.ts` |
| Slash commands (`/consolidate`, `/why`, `/check-memory`, `/memory …`) | `packages/atoms/src/commands/builtins.ts` |
| Web UI (Memory settings panel: backend, facts, graph, laws, mem0 explorer) | `apps/web/src/features/studio/memory-settings/` |

## The three layers

Memory is a vertical pipeline crossed with scope isolation:

- **L1 — facts.** Durable bullets the agent curates itself, stored as Markdown.
  Always on.
- **L2 — knowledge graph.** Entities + time-versioned relations extracted from
  session transcripts into SQLite. Built by the consolidation pipeline.
- **L3 — laws.** General, falsifiable rules inferred from L1 facts + L2 relations,
  injected into recall with confidence decay and contradiction suppression.

The pipeline depth is the `memory.level` config (1–3, default 1): `/consolidate`
runs L1 dedup, then (level ≥ 2) graph extraction, then (level ≥ 3) law inference.

**Scopes.** Every record carries a scope: `global` (the instance's one user, shared
across agents), `agent:<agentId>` (private to one agent, across sessions),
`project:<key>` (a workspace, keyed from its cwd), `session:<sessionId>` (ephemeral,
dropped at session end). `org` is reserved in the schema for a future tier.

## L1 — facts (design A, the Claude Code model)

Two kinds of always-relevant context, split by dynamism:

- **Static core** — identity files (`SOUL.md`, `AGENT.md`/`AGENTS.md`, `USER.md`),
  injected verbatim into the system prompt, human-curated, hot-reloaded.
- **Dynamic facts** — what the agent learns, curated by the agent itself through
  one `memory` tool. Not dumped wholesale into the prompt.

### Storage — flat scope-keyed Markdown

`MemoryDir` writes machine-managed Markdown, one file per scope, plus an index:

```
<home>/memory/MEMORY.md                  ← index (per-scope description + fact count)
<home>/memory/MEMORY_global.md
<home>/memory/MEMORY_agent_<agentId>.md
<home>/memory/MEMORY_project_<key>.md
<home>/memory/MEMORY_session_<sid>.md    ← dropped at session end
```

Each fact is one `- bullet`; frontmatter (scope/updated/count) is system-stamped.
A fact's id is `sha256(normalized content)` (first 12 hex) — there is **no event
log, no cursors, no embeddings** in L1 (a deliberate divergence from the original
design). Writes are atomic and pass a normalized-string dedup floor; every write
regenerates the index.

### Write path — the `memory` tool

The built-in backend exposes one agent-facing tool, `memory(action, …)` with
`view` / `record` / `update` / `delete` and `scope` = `agent` (default) /
`global` / `project` (`apps/monad/src/services/memory/tools.ts`). Every write goes
through `sanitizeFact` (`agent/memory/layered.ts`): secret-shaped substrings are
redacted, invisible/bidi Unicode stripped, instruction-shaped "facts" rejected as
injection. There is no per-turn extraction LLM and no session-end rewrite; cleanup
is (a) the agent inline, (b) a background auto-consolidate of any single scope
that grows past ~2000 chars, and (c) the manual `/consolidate` pass.

### Read path — frozen per session

`recallContext` builds the injected block once per session and freezes it
(prefix-cache safe): **global and project facts inlined** (small, almost always
relevant) plus a **count/pointer for the agent-private scope** (read on demand via
`view`), plus the L3 laws block (below). Mid-session writes land on disk and are
readable live via `view`; the injected snapshot refreshes next session. Lifecycle
wiring is three hooks (`services/memory/hooks.ts`): recall + tool nudge on
`BeforeTurn`, mem0 observe on `AfterTurn`, session-scope drop on `SessionEnd`.

### The mem0 backend

`memory.backend` selects `builtin` (above) or `mem0` (mem0 OSS, lazy-loaded).
mem0 is **passive**: per-turn `observe()` extraction plus query-dependent semantic
recall (not frozen); the `memory` tool's write actions are no-ops on it. Its LLM
and embedder resolve from monad's own model registry (no env vars). Because
mem0-JS has no embedded persistent vector store, the daemon downloads and manages
a local **qdrant** on first use (`services/memory/qdrant.ts`; loopback-bound, data
under `db/qdrant`, port defaults to daemon port + 1000, killed on exit) —
overridable via `memory.mem0.vectorStore`, with in-RAM fallback if qdrant can't
boot.

## L2 — knowledge graph

Shipped in `apps/monad/src/services/memory/graph/`. Design details and the locked
decisions are in [proposals/l2-knowledge-graph.md](../proposals/l2-knowledge-graph.md).

- **Storage:** `<home>/db/memory.sqlite` (shared with L3 and consolidation state).
  `graph_node` (deduped per scope by normalized name, FTS5-indexed), `graph_edge`
  (merged per `(scope, src, dst, relation, provClass)` within a validity window,
  `valid_from`/`valid_to`), `l2_cursor` (per-session watermark).
- **Source stream:** the `messages` table, not a fact-event log. `consolidateGraph`
  (`graph/service.ts`) walks each session's messages past its watermark, filters to
  substantive prose, caps one extraction at ~12k chars, runs one LLM pass
  (`memory` model role), and upserts nodes/edges into every scope the session
  belongs to (`agent:<id>`, plus `project:<key>` when it has a workspace). Edge
  `support` is the messageIds the relation came from.
- **Deletion reconciles by support-liveness:** each pass drops support messageIds
  that no longer exist (soft-deleted or removed session) and retracts edges left
  unsupported.
- **Query tools:** `graph_explore` (FTS entity search + relations among matches)
  and `graph_node` (one entity + neighbours), read-only, scoped to the calling
  agent + workspace — pulled on demand, never injected.

## L3 — laws

- **Storage:** `graph_law` table in the same `memory.sqlite` (`law-store.ts`).
  A law is `{statement, confidence, support, contradictedBy}` where `support`
  holds `fact:<id>` / `edge:<id>` provenance refs.
- **Inference** (`law-infer.ts`): one LLM pass per scope over its L1 facts + L2
  relations, tagged `[f#]`/`[e#]` so the model's citations map back to real ids
  (invented refs are dropped — no hallucinated provenance). Re-derivation is a
  **wholesale per-scope replace**; an incremental fingerprint over the input
  fact/edge ids skips scopes whose inputs haven't changed.
- **Recall injection:** eligible laws are appended to the L1 recall block as
  "Learned rules" — on both backends (laws live in the graph DB, not the L1
  store). A law is eligible only if it is not contradicted and its **decayed
  confidence** clears the floor (`decay.ts`: half-life decay, read-time only;
  defaults `halfLifeDays: 365`, `floor: 0`, configurable via `memory.decay`).
- **Contradiction check** (`contradict.ts`, `/check-memory`): a cheap LLM pass per
  scope asks whether any current fact states the opposite of a law; flagged laws
  are suppressed from recall until the next re-derivation clears the flag.
- **Provenance** (`/why <text>`, `explain.ts` + `subsystem.ts`): lexically match
  the query against the session's laws, then resolve each match's grounding — the
  facts it generalizes, the relations it rests on, and the source messages those
  relations were extracted from. The `getLaws` control API returns the same
  grounding (plus effective decayed confidence and a `stale` flag when a law's
  refs no longer resolve) for the web Laws tab.

## The consolidation pipeline

`runConsolidate(level?)` in `agent/memory/subsystem.ts` is the one pipeline:

1. **L1** — LLM dedup/merge of every durable scope (skipping scopes whose fact set
   is unchanged since the last pass, via `ConsolidationState` fingerprints).
2. **L2** (level ≥ 2) — `consolidateGraph` forward pass + reconcile.
3. **L3** (level ≥ 3) — `inferLawsForScopes` over global, every configured agent,
   and every workspace with sessions.

Triggers:

- `/consolidate [level]` (or `/memory consolidate`) — manual, with optional depth
  override.
- **Background catch-up** — opt-in via `memory.graph.autoConsolidate` +
  `intervalMinutes` (default 30): a 60s tick runs the whole pipeline to the
  configured level when due; one run at a time, hot-reloaded settings apply
  without recreating the timer.
- Per-scope L1 auto-consolidate when a scope file exceeds ~2000 chars
  (fire-and-forget, never blocks a turn).

All consolidation/inference LLM calls use the `memory` model role (per-agent
override → global role → chat default).

## Surfaces

- **Agent:** the `memory` tool (built-in backend), `graph_explore` / `graph_node`.
- **Commands:** `/consolidate [1-3]`, `/why <text>`, `/check-memory`, and the
  `/memory` group wrapping them.
- **Control API + web:** memory status (backend, mem0 models, qdrant phase, level,
  graph settings), per-scope fact browse/add/edit/forget, core-file editor, laws
  with grounding, the read-only graph snapshot, and a mem0 explorer (entries + a
  2D embedding projection via `pca2d.ts`, read from qdrant only when already
  running). UI in `apps/web/src/features/studio/memory-settings/`.
- **Config:** `memory.backend`, `memory.level`, `memory.graph.*`,
  `memory.decay.*`, `memory.mem0.*` — all hot-reloaded.

## Deliberate divergences from the original design

Kept here so the proposal isn't re-litigated piecemeal:

- **No SQLite event log for L1** (`mem_fact_events` / cursors / tombstones) — L1 is
  flat Markdown; fact identity is a content hash. L2 therefore cursors over the
  `messages` table instead.
- **No OTR** ("Off the Record") — never wired, deleted; its intent is a planned
  incognito run mode.
- **No Advanced Mode state machine / backfill flow** — the depth knob is the plain
  `memory.level` setting; L2/L3 build from whatever history the message store
  holds whenever consolidation runs.
- **Law re-derivation is wholesale per scope**, not incremental support
  reconciliation; freshness is handled by fingerprint skips, decay, and the
  contradiction check.
- **No embedding-based L1 recall** in the built-in backend (mem0 covers the
  semantic-recall use case); no automatic agent→global promotion.
