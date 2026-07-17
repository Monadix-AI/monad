# Monad Memory System — Design

> Status: **original design document, kept for history and rationale.** The shipped system is
> described in [docs/internals/memory.md](../internals/memory.md) — where this document and the
> code differ, the code wins. L1 shipped as §0's "design A"; L2 (graph) and L3 (laws) have since
> shipped too, re-rooted per [l2-knowledge-graph.md](l2-knowledge-graph.md) rather than the
> event-log model of §3–§5.
> Scope of this doc: the layered, scope-isolated memory subsystem the agent loop
> reads from (prefetch) and writes to (observe / consolidate / infer). Code lives in
> `apps/monad/src/agent/memory` (L1Adapter contract + sanitize/render),
> `apps/monad/src/store/db` (MemoryDir), and `apps/monad/src/services/memory`
> (orchestration + the `memory` tool + mem0).

---

## 0. As built (L1) — authoritative

The shipped L1 follows **"design A"** (self-curated Markdown), a rework of the original design.
What actually runs, and where it **deliberately diverges** from §1–§13:

### 0.1 Two layers by dynamism: static core (injected) + dynamic facts (tool-read)

- **Static core** — identity/persona, **always injected** into the system prompt (frozen, prefix-cache
  friendly): `SOUL.md` (persona) + `AGENT.md`/`AGENTS.md` (operating rules) + **`USER.md`** (durable
  user facts). Seeded as workspace files, hot-reloaded, human-curated.
- **Dynamic facts** — what the agent learns; **not** dumped into the prompt. The agent reads/curates
  them through one `memory` tool; recall injects only a cheap pointer (see 0.3/0.4).

### 0.2 Storage — flat scope-keyed Markdown + an index

Machine-written Markdown — *not* the append-only `mem_fact_events` table of
§3.2/§13.1 (D17/F5 **reversed**). One flat dir, one file per scope, frontmatter the store stamps:

```
<home>/memory/MEMORY.md                  ← index (per-scope description + fact count); injected
<home>/memory/MEMORY_global.md           ← the one user, shared across agents
<home>/memory/MEMORY_agent_<agentId>.md  ← that agent, private, across sessions
<home>/memory/MEMORY_session_<sid>.md    ← ephemeral; dropped at session end
```

Each fact is one `- bullet`; per-file frontmatter (`scope`/`updated`/`facts` count) is **system-
stamped** (the model supplies only fact text + a scope intent). `MemoryDir` does atomic writes + a
**normalized string-dedup floor**; every write regenerates the index. No event log, no cursors, no
embeddings. **Consequence:** L2/L3 must drive cursors off the `messages` stream; delete-propagation
degrades to re-derive-on-next-pass.

### 0.3 Write path — one `memory` tool, backend-routed

The built-in backend follows the **self-curated Markdown model**: the agent curates its own memory inline.

- One tool: `memory(action, …)` — `view` (read the index, or a scope's facts) / `record` / `update` /
  `delete`, with `scope` = `agent` (default) or `global`. NOT raw file read/write: the action surface
  is backend-agnostic so the service routes built-in (MD edits) vs mem0 (passive) behind it, and every
  write is sanitized (`sanitizeFact`: injection / secret-redaction / invisible-Unicode).
- **No per-turn LLM** and **no session-end rewrite** for built-in. Cleanup is (a) the agent inline,
  (b) a **background auto-consolidate** of a single scope once it exceeds ~2000 chars (compress the
  one file, don't split it), and (c) a manual **`/consolidate-memory`** command (LLM dedup/merge/
  correct across scopes + rebuild the index).
- **mem0 stays passive**: per-turn `observe()` + semantic recall; the `memory` tool is a no-op for it.
- **mem0 persists by default**: mem0-JS has no embedded on-disk vector store, so the daemon downloads +
  manages a local **qdrant** on first mem0 use (`services/memory/qdrant.ts`, NOT bundled — same model as
  `bun add mem0ai`), loopback-bound, data in `paths.dbDir/qdrant` (all binary DBs live under `db/`,
  never in user-readable `memory/`), killed on exit. Override via
  `memory.mem0.vectorStore` (e.g. external pgvector, or `{ provider: 'memory' }` to opt out → in-RAM).

### 0.4 Read path — static injected, dynamic pointer-injected (frozen per session)

Static core is injected verbatim. For dynamic facts the built-in recall injects, **frozen per session**
(prefix-cache safe): the **global facts inlined** (small, always about the user → the agent never has
to remember to look) + a **count/pointer for the agent-private scope** (read on demand via `view`). A
mid-session write lands on disk + is readable live via `view`, but the injected snapshot only refreshes
next session. (mem0 recall is query-dependent semantic, not frozen.)

### 0.5 Surfaces

Control API + a web **Memory** settings panel (backend selector, mem0 model pickers, per-scope
browse/add/remove, raw file editor) + the **`/consolidate-memory`** slash command. The legacy
session-KV note-store stays as a degenerate path.

### 0.6 Not built / removed

Built since the original §1–§13: USER.md static core (0.1), the single `memory` tool, per-scope
auto-consolidate, `/consolidate-memory`, **and** L2 (knowledge graph) + L3 (inferred laws) —
see [docs/internals/memory.md](../internals/memory.md), re-rooted on the flat-MD store rather
than the `mem_fact_events` event log below. **Removed:** OTR (§2.3) — it was never wired and is
deleted; its intent (a run that records nothing) is now a planned **incognito run mode** (not yet
built). Still not built: the **Advanced Mode on/off state machine with backfill** (D10/D19 below),
automatic agent→global promotion as a standalone policy, embedding-based semantic recall, and
topic-file splitting (the >2000-char single-file consolidation is the current stopgap).

§1–§7 and §10–§13 below describe the *original* design — an event-sourced `bun:sqlite` schema
(`mem_fact_events`/`mem_nodes`/`mem_edges`) that was **not** what shipped (§0.2 reversed it in
favor of flat scope-keyed Markdown). They're kept only as historical rationale for decisions
D1–D28 in §8; do not treat any schema or contract below as current. For the real schema, read
`docs/internals/memory.md` and the code it points to.

---

## 8. Decisions made

| # | Decision | Choice |
|---|----------|--------|
| D1 | L1 backend | pluggable adapter — default self-built, optional mem0 |
| D2 | L3 trigger | scheduled cron (background, per-scope cadence) |
| D3 | L1↔L2 boundary | normalized `Fact` DTO; L2/L3 backend-agnostic |
| D4 | Provider abstraction | L1 ✅ provider, L2 ✅ provider, L3 ❌ (internal `InferenceStrategy`) |
| D5 | Capability negotiation | generalized `capabilities` bits (e.g. `provenance`) → graceful degrade (Q1: C+A) |
| D6 | L1 split | L1.1 always-injected MD core (role×scope) + L1.2 recalled SQLite corpus, hot/cold tiered |
| D7 | Off the Record | OTR writes L1 **at session scope only** (forced), tagged `otr=true`, never promoted, never L2/L3, ephemeral with the session. OTR session ⟂ OTR session ⟂ normal session. (Q2, revised — session-local isolation) |
| D8 | Storage | single `bun:sqlite`; only L1.1 is files (MD). L1.2/L2/L3 in DB; embeddings rebuildable; JS cosine default |
| D9 | L2 input | consolidate from L1 + all available context (history, tool outputs, task results) |
| D10 | Advanced Mode | per-agent setting; on-enable prompt to backfill L2/L3 from the agent's historical sessions (background, cost-gated, idempotent) |
| D11 | L1/L2 same-source | a backend declares `covers: ('L1'\|'L2')[]`. A backend covering both (e.g. a bundled extract+graph vendor) cannot be stacked under a separate L2 — either use its L1+L2 wholesale, or pair the vendor L2 with self-built L1. Default: all self-built, `covers` independent per layer. Constraint only kicks in when a bundled vendor is introduced. (Q5) |
| D12 | Scope promotion | no separate policy — session→agent→global promotion is performed by the L3 cron as one of its generalizations (§5.3). (Q3) |
| D13 | OTR persistence | `observe` under OTR forces `scope=session:<this>` + `otr=true`; facts are session-lifetime, never promoted, excluded from drain/consolidate/infer/backfill. No agent/global OTR fact exists to recall later → closes the read-leak. (F1, revised) |
| D14 | observe↔consolidate | non-blocking & eventually consistent — consolidation never blocks the task; late facts caught by a **periodic L2 catch-up job** (§4.2), not by L3; L3 cron runs catch-up first. Bounded gap accepted. (F2, revised F-2) |
| D15 | L2 idempotency | L2 has its own `consolidatedThrough` cursor (≠ L3's `derivedThrough`); edges key on `(scope,src,dst,relation,provenanceClass,validFrom)` and carry a `support` set of `{factId,eventId,taskId}` merged idempotently by `eventId` — late facts extend support, relation changes open a new window. (F3; F-5; provenanceClass F-P3) |
| D16 | Conflict rule | one canonical rule at read time: `provenance > specificity > recency` (specificity `session>agent>global>org`). L2 temporal supersession only closes same-`(scope,src,dst,relation,provenance)` edges; it is not a second rule. (F4) |
| D17 | L1.2 storage model | append-only event **table** in `bun:sqlite` (`fact_added/edited/tombstoned`) is truth; fact table + index materialized by replay; `memory export` → JSONL for readability. (F5, revised — table over file for consistency) |
| D18 | Scope model | one Monad instance = one user, so `global` = that user (no per-user partition). `org:<id>` reserved as a future paid tier above `global`. (Open-Q1, revised) |
| D19 | Advanced Mode state | a state machine with pinned transitions (§5.5); `on/declined/failed` are all "Advanced ON" terminal states; `decline`→`declined` (not `off`); only `setAdvanced(off)`→`off`; `failed`/`declined` resume via `backfill`. (F6, pinned F-6) |
| D20 | Package boundary | agent-core = interfaces/types/pure logic; store = persistence + replay + queries; daemon = single-writer, cron, backfill, control API, OTR enforcement. (Open-Q2, §12) |
| D21 | L2/L3 are background jobs | L2 consolidation, L2 catch-up, and L3 inference are independent background jobs — never block an agent turn; in-flight jobs surfaced via `memoryJobs` so the user waits or continues. (F-1) |
| D22 | observe write contract | `observe(turn, WriteCtx{sessionId, scope, otr})` — explicit in the signature, not inferred from `Turn`; tags L1 facts with `otr` (L1 written even under OTR). (F-4) |
| D23 | Storage schema | authoritative tables pinned in §13.1 (`mem_fact_events` w/ `seq`+`eventId`, `mem_facts`, `mem_nodes`, `mem_edges` w/ `provenanceClass`, `mem_laws`, `mem_cursors`, `otr` on sessions/tasks/messages). |
| D24 | Job gating | gate checked *inside* each job. **Forward jobs (consolidate/catch-up/infer) run in any state ≠ `off`**; **backfill runs only in `backfilling`**. `off` ⇒ no graph/laws ever. OTR excludes `otr=true`. (§13.2, Point 1; F-3) |
| D25 | Event/cursor/support IDs | cursor axis = `mem_fact_events.seq` (monotonic, not task-based); `eventId` stable `evt_` nanoid; `support` = set of `{factId,eventId,taskId}`; **tombstone propagates by `factId`** (same factId, new eventId) so dependents are found. (§13.3, Point 2; F-2) |
| D26 | Promotion policy | L3 **decides**, a store/daemon promotion job **applies**. One step at a time; ≥N distinct sessions; `→global` needs `user` provenance or (machine ∧ ≥N sessions ∧ confidence≥τ); otr never eligible; reversible. (§13.4, Point 5) |
| D-P3 | L2 edge provenance | `provenanceClass` is part of the edge unique key — `user` and `machine` edges for the same relation/window never merge. (§4 / §13.1, Point 3) |
| D27 | L3 write boundary | L3 mutates **only `mem_laws`**; never the L2 graph, fact events, or MD. Promotion/demotion are decisions applied by a separate job. (§5.3, F-4) |
| D28 | L1 backend capabilities | L2/L3 + OTR require `{eventLog, tombstone, otrIsolation, drainByCursor}` (plus `provenance` for full fidelity). A backend missing them (mem0) is **recall-only L1**, with Advanced Mode + OTR disabled on it. (§3.5, F-6) |

## 9. Open questions

None were open in the original design — D1–D28 (+D-P3) resolved them all. Some `§N` cross-refs
in the table above point at now-deleted sections (the original event-log schema and package-map
sections were cut from this doc as superseded by [docs/internals/memory.md](../internals/memory.md));
the decisions themselves remain accurate as historical rationale for *why* the shipped design
looks the way it does. Genuinely still open in the real system: the Advanced Mode on/off state
machine with backfill (D19/D10), and incognito run mode (OTR's replacement, §0.6).

