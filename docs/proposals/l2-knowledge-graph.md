# L2 — Dynamic Knowledge Graph (design-A grounded)

> Status: **implemented** — shipped in `apps/monad/src/services/memory/graph/` (store, extract, service, `graph_explore`/`graph_node` query tools, unit tests). Supersedes the event-log assumptions of `memory-design.md` §4
> for the actual L1 (design-A: pure Markdown, no `mem_fact_events` log). §4 keeps the original vision;
> this doc is what we build. Scope of v1: a self-built SQLite graph, `agent` scope only, manually
> triggered, queried by a CodeGraph-shaped tool.

## 0. Why a re-root is needed

`memory-design.md` §4 designs L2 against an append-only fact-event log with stable `factId`/`eventId`
and a `consolidatedThrough` cursor over it. **Design-A deleted that** (facts are Markdown bullets keyed
by `sha256(content)`, regenerated every consolidate; deletes are not events). The only durable,
append-only stream left is the **`messages` table** (SQLite, per-session, stable ids, soft-delete via
`active`). L2 re-roots onto it.

## 1. Decisions (locked)

| Dimension | Decision |
|---|---|
| **Cursor** | **Per-session watermark** `l2_cursor(session_id, through_key)`. Each pass: known sessions → messages after their watermark; unknown sessions → from the start. |
| **Deletion** | **Support-liveness reconciliation** (no delete events). Messages are *soft-deleted* (`active=0`) by restore/branch, so an edge survives only while ≥1 supporting message row exists **and is `active=1`**; otherwise it is retracted. A whole-session hard-delete is caught by the same row-existence check. |
| **Query API** | **CodeGraph-shaped**: `graph_explore(query)` → matching entities + the edges/paths between them; `graph_node(entity)` → one entity + its neighbours. |
| **Surfacing** | **Tool, pulled** (not injected) — consistent with design-A "agent queries its own memory"; no prefix-cache pressure. |
| **Storage** | Self-built **`{home}/db/memory.sqlite`** behind an `L2Provider` interface (vendor swap — Zep/Graphiti/Cozo — later; no native bindings in v1). |
| **Extraction** | Reuse the **`memory` model role**; one LLM pass over a message span → `{nodes, edges}`. |
| **Entity dedup** | Per-scope **normalized name + aliases** (lexical; no embeddings in v1). |
| **Edge schema** | `(scope, src, dst, relation)` + `validFrom/validTo` + `support[]` + `confidence` + `provClass ∈ {machine, user}`. |
| **Trigger** | **Manual** `/consolidate-graph` + an **opt-in background timer** (`memory.graph.autoConsolidate`, off by default; `intervalMinutes` default 30). No on-task-success hook yet. |
| **Match** | `graph_explore` matching = **SQLite FTS5** over node name/aliases + relation text. Semantic match deferred (note: `message_embeddings` infra already exists for later). |

## 2. Data model (`memory.sqlite`)

```sql
graph_node(
  id TEXT PRIMARY KEY,        -- stable: hash(scope + normalized_name)
  scope TEXT NOT NULL,        -- 'agent:<id>' (v1) | 'global'
  name TEXT NOT NULL,
  norm_name TEXT NOT NULL,    -- lowercase/trimmed; dedup key within scope
  type TEXT,                  -- person|project|tool|concept|… (LLM-suggested, free-ish)
  aliases TEXT,               -- JSON string[]
  attrs TEXT,                 -- JSON bag
  updated_at INTEGER NOT NULL,
  UNIQUE(scope, norm_name)
)
graph_edge(
  id TEXT PRIMARY KEY,        -- hash(scope + src + dst + relation + provClass + validFrom)
  scope TEXT NOT NULL,
  src TEXT NOT NULL,          -- graph_node.id
  dst TEXT NOT NULL,
  relation TEXT NOT NULL,
  prov_class TEXT NOT NULL,   -- 'machine' | 'user'
  support TEXT NOT NULL,      -- JSON of messageId[]
  confidence REAL NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER            -- NULL = current
)
l2_cursor(session_id TEXT PRIMARY KEY, through_key INTEGER NOT NULL, updated_at INTEGER NOT NULL)
graph_node_fts USING fts5(name, aliases, content='graph_node', content_rowid=…)
```

Edge identity merges by `(scope, src, dst, relation, prov_class)` within a validity window; a re-pass
extends `support` (idempotent by messageId) and bumps confidence; a relation change closes the old
`valid_to` and opens a new window. A `machine` and a `user` edge for the same relation never merge.

## 3. The consolidation pass (`/consolidate-graph`)

1. **Forward (per session):** for each session with `active=1` messages past its `through_key`,
   run `extractGraph(span, memoryModel)` → upsert nodes (dedup by `norm_name`) + edges (merge support).
   Advance `through_key`.
2. **Reconcile (sweep):** for every edge, drop support messageIds whose row is missing or `active=0`;
   any edge left with empty support → retract (`valid_to = now`, hard-delete acceptable in v1 — no
   history consumer yet). Drop `l2_cursor` rows for sessions that no longer exist.
3. v1 reconcile = **full sweep** (graph is small under manual trigger; covers whole-session deletes).
   Later: delete-hook-driven incremental reconcile.

Idempotent throughout → re-running a pass is safe.

**Cost controls (the extraction LLM call is the only real cost):**
- **Prose-only**: only `user`/`assistant` messages with non-empty text are fed to the model; tool
  output/results (often huge, little graph signal) are dropped. If a span has no prose, the cursor
  still advances past it (so noise never re-triggers a call).
- **Char budget**: one extraction sees at most `maxTranscriptChars` (~12k ≈ 3k tokens); a longer span
  is split across passes (cursor advances only to the last *fed* message — no data loss).
- **Cheap model**: extraction runs on the `memory` role — point it at a small/cheap model (entity
  extraction is a structured task a small model handles well).
- **Watermark**: only messages past `through_key` are ever processed — no re-extraction.

## 4. Query tools (exposed to the agent)

- `graph_explore(query: string)` → FTS-match nodes by name/alias → return those nodes + the edges
  among them (the "paths between them"), current (`valid_to IS NULL`) by default.
- `graph_node(entity: string)` → resolve one node → return it + its incident edges (neighbours,
  relations, validity, confidence).

Both read-only; scoped to the calling agent (+ global). No injection into the prompt.

## 5. Build plan

- **P0 — schema + store.** `memory.sqlite` (`bun:sqlite`), `GraphStore` (upsert node/edge, merge
  support, retract, FTS query) behind `L2Provider`. Wired under `paths.dbDir`. Unit tests.
- **P1 — extraction + consolidate.** `extractGraph(messages, model)`; the two-phase pass (forward +
  reconcile); `/consolidate-graph` command across transports. Tests: idempotency, watermark advance,
  soft-delete reconcile.
- **P2 — query tools.** `graph_explore` / `graph_node`, FTS matching, registered in the agent tool set.
- **P3 — polish + tests.** e2e (consolidate → query round-trip), FTS query tests, scope isolation.

### Deferred (explicitly out of v1)
On-task-success trigger; backfill; Advanced-Mode gating; L3; embedding/semantic match
(reuse `message_embeddings`); `provClass` beyond machine/user; in-place message-edit handling (assumes
append/soft-delete — restore/branch confirmed soft-delete, not in-place edit); vendor L2 providers.
