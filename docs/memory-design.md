# Monad Memory System — Design

> Status: **L1 built & on main; reworked into "design A"** — §0 ("As built") is authoritative for
> what ships. **L2/L3 remain design-only.** The L1 implementation deliberately diverges from several
> decisions below (notably: pure Markdown, *not* the SQLite event log of §3.2/§13.1; a single agent-
> driven `memory` tool, *not* per-turn extraction; OTR §2.3 **removed**; static `USER.md` core +
> dynamic facts via tool). §1–§13 keep the original design + rationale; **read §0 first for reality.**
> Spans (post-refactor): `apps/monad/src/agent/memory` (L1Adapter contract + sanitize/render),
> `apps/monad/src/store/db` MemoryDir, `apps/monad/src/services/memory` (orchestration + the tool + mem0).
> Scope of this doc: the layered, scope-isolated memory subsystem the agent loop
> reads from (prefetch) and writes to (observe / consolidate / infer).
> Rev: multiple design-review rounds (D13–D28). OTR = session-scoped L1 only, never promoted,
> never derived (OTR ⟂ everything); L2/L3 are UI-observable background jobs (forward jobs run
> whenever Advanced ≠ off; backfill only while `backfilling`); tombstone propagates by `factId`;
> L3 writes only laws (promotion via a separate job); mem0 is recall-only L1 (lacks the
> eventLog/tombstone/otrIsolation/drainByCursor capabilities). §13 pins the build contracts.

---

## 0. As built (L1) — authoritative

L1 shipped to main, then was reworked into **"design A"** (Claude Code model) on
`feat/memory-design-a`. What actually runs, and where it **deliberately diverges** from §1–§13:

### 0.1 Two layers by dynamism: static core (injected) + dynamic facts (tool-read)

- **Static core** — identity/persona, **always injected** into the system prompt (frozen, prefix-cache
  friendly): `SOUL.md` (persona) + `AGENT.md`/`AGENTS.md` (operating rules) + **`USER.md`** (durable
  user facts). Seeded as workspace files, hot-reloaded, human-curated.
- **Dynamic facts** — what the agent learns; **not** dumped into the prompt. The agent reads/curates
  them through one `memory` tool; recall injects only a cheap pointer (see 0.3/0.4).

### 0.2 Storage — flat scope-keyed Markdown + an index

Machine-written Markdown, Claude Code-style — *not* the append-only `mem_fact_events` table of
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

The built-in backend follows the **Claude Code model**: the agent curates its own memory inline.

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
auto-consolidate, `/consolidate-memory`. **Removed:** OTR (§2.3) — it was never wired and is deleted;
its intent (a run that records nothing) is now a planned **incognito run mode**. Still forward design:
L2 graph, L3 laws, Advanced Mode + backfill, automatic agent→global promotion, the SQLite event log /
cursors / tombstones, embedding-based semantic recall, and topic-file splitting (the >2000-char
single-file consolidation is the current stopgap).

---

## 1. Goals

A memory system richer than a flat key-value store or a single external provider,
organized as **vertical layers** crossed with **scope isolation**:

- **L1 — Objective facts.** Record what is observably true. Cheap, always on.
  Split into **L1.1 (always-injected core)** and **L1.2 (dynamically recalled corpus)**.
- **L2 — Dynamic knowledge graph.** On task completion, consolidate L1 + all available
  context into entities + time-versioned relations.
- **L3 — Inferred laws.** Periodically (cron) reason over L1 + L2 to derive general,
  falsifiable rules, with support chains and confidence.

L2 + L3 toggle together as a unit — **Advanced Mode**: more tokens, better memory.
L1 is always on. **Off the Record** keeps everything a session learns inside that session —
session-scoped L1 only, no promotion, no L2/L3 (§2.3).

### Design stance

The novelty is a **2-D matrix**: `layer` (vertical pipeline) × `scope` (isolation).

- L1 is the conventional "facts in / recall out" memory most systems stop at.
- **L2 + L3 (facts → graph → laws) is the vertical reasoning stack** that turns recorded
  facts into a consolidated graph and then into generalized rules.

The interface *shape* — prefetch on the way in, sync on the way out, tools self-described by
the backend — is a provider pattern proven to decouple heterogeneous backends.

---

## 2. The two axes

`layer` (vertical pipeline, lower feeds higher) is orthogonal to `scope` (isolation).

```
                   session                  agent                global      
            ┌────────────────────┬─────────────────────────┬─────────────────┐
L1 facts    │ this turn's obs.   │ this agent, long-term   │ cross-agent     │  always on, cheap
L2 graph    │ this task's graph  │ agent knowledge graph   │ global graph    │ ┐
L3 laws     │ (usually none)     │ agent experiential law  │ universal law   │ ┘ Advanced Mode
            └────────────────────┴─────────────────────────┴─────────────────┘
   Off the Record = L1 written at session scope only, never promoted, no L2/L3 (otr session ⟂ everything else)
```

> Scopes: `session`, `agent`, `global` (= the instance's single user). `org` is reserved
> for a future paid tier above `global` (§2.2).

### 2.1 Layers are a pipeline, not peers

Dependency direction: **L1 → L2 → L3**. Higher layers read lower layers. This is *why*
L2+L3 can be one toggle: both build on L1, so turning them off just means "don't
consolidate, don't infer" — L1 keeps recording.

| Layer | What | Write trigger | Cost |
|-------|------|---------------|------|
| L1.1 facts (core)   | bounded, always-injected, human-curated | manual / promotion | ~free |
| L1.2 facts (corpus) | unbounded, machine-extracted, recalled   | every turn | cheap |
| L2 graph | entities + time-versioned relations | task `succeeded` | medium (1 LLM pass/task) |
| L3 laws  | generalized falsifiable rules + support chain | **scheduled cron** | expensive (background) |

### 2.2 Scope isolation

Every record carries `(scopeKind, scopeId)`:

- `session:<sessionId>` — short-term, session lifetime only.
- `agent:<agentId>` — persists for that agent across sessions ("always loaded").
- `global` (`scopeId = '*'`) — **the instance's user. By design one monad instance = one
  user**, so `global` is that single user's cross-agent memory; no per-user partition is
  needed (revises Open-Q1). `USER.md` is global-scoped.
- `org:<orgId>` — **reserved, future paid tier.** A scope *above* `global`, shared across an
  org's many users/instances. Not built now; the scope enum leaves room so it slots in later
  without reshaping records.

**Read resolution:** union the scopes in play for the current `(agent, session)` (+ `org`
when enabled), rank by relevance. **Conflict resolution (single canonical rule, at read/rank
time across all layers):** `provenance > specificity > recency` —

1. **provenance:** `source:user` beats machine-extracted;
2. **specificity:** `session > agent > global > org` (org is broadest ⇒ least specific; a
   user's own fact overrides an org default);
3. **recency:** newer > older.

This is the *one* rule for resolving contradictory records. L2's temporal edge supersession
(§4) is **not** a second conflict rule — it only closes an older edge with the *same*
`(scope, src, dst, relation, provenance-class)`; contradictions that differ in scope or
provenance coexist and are resolved by this rule at read time.

**Scope promotion** (session→agent→global) is folded into the L3 cron (§5), since it is
itself a form of generalization.

### 2.3 Off the Record (OTR) — ⚠️ REMOVED (see §0.6)

> **Not built / removed.** OTR was plumbed but never wired (`session.otr` was never set), and was
> deleted in design A. Its intent — a run that records nothing — is replaced by a planned **incognito
> run mode** (no memory writes at all, rather than write-to-session-then-drop). The original design
> below is kept for rationale only.

OTR confines everything a session learns to **that session and nothing more** (revised — this
makes the name accurate: nothing leaks into future conversations):

1. **Writes forced to `session:<thisSession>` scope.** Under OTR, `observe()` records L1 facts
   **only at session scope** (never `agent` / `global`), tagged `otr = true`. Session-scoped
   L1 is **session-lifetime only** (§2.2), so it disappears when the session ends.
2. **No promotion.** OTR facts are never eligible for session→agent→global promotion (§13.4),
   so they can never escape the session.
3. **No L2/L3.** `drain` / consolidate / infer / backfill exclude `otr = true`, so an OTR
   session never becomes graph or laws.
4. **Reads.** The agent still reads its `agent` / `global` memory normally (it stays capable)
   plus its own in-session facts; by scope isolation it cannot see any *other* session's facts.

**Isolation guarantee: OTR session ⟂ OTR session, and OTR session ⟂ normal session** — neither
direction influences the other, because the only thing an OTR session writes is session-scoped
and ephemeral. Nothing it produces survives it. The read-path leak risk is closed at the
*write* side: there is simply no agent/global OTR fact to recall later.

---

## 3. L1 — Objective facts (two sublayers)

### 3.1 L1.1 — always-injected core (MD files)

- **Storage:** Markdown files, the source of truth. Human writes and reads them.
- **Maps to roles × scope:**

  | File | Role | Scope |
  |------|------|-------|
  | `SOUL.md`   | agent identity / persona / values | agent |
  | `AGENTS.md` | operating instructions / behavior | agent |
  | `USER.md`   | who the user is, preferences | global (= the instance's user — §2.2) |
  | `MEMORY.md` | curated durable notes | agent / global |

- **Bounded** (~1300-token order). Always injected full, no vector needed.
- **Token ceiling enforced:** overflow triggers demotion to L1.2 — keeps the always-injected
  block small so context compaction never truncates it mid-conversation.
- **Audit/edit:** edit the MD file directly.

### 3.2 L1.2 — dynamically recalled corpus

- **Source of truth: an append-only event *table* in `bun:sqlite`** (revised F5 — table, not
  JSONL files). A JSONL file as system-of-record is fragile: machine writes at turn frequency
  make file consistency hard, and a DB is *still* readable (queryable + exportable). So L1.2
  lives in the DB. The **event-sourced model is kept**: rows are *events*
  (`fact_added` / `fact_edited` / `fact_tombstoned`), append-only — an edit or delete inserts
  a new event, never mutates a prior row. This preserves support-chain stability (old
  `factId`s never vanish) and deterministic replay, while gaining **transactional
  consistency** under the daemon's single writer.
- **Materialized state: current-fact table + embeddings**, produced by replaying the event
  table. Rebuildable any time — if the embedding index corrupts or the sqlite-vec ABI breaks
  (§7), re-derive it from the event table. The materialized table/index is a disposable
  cache; the event table is the truth.
- **Readability/audit:** the DB is queryable directly and `memory export` dumps to JSONL on
  demand, so human-readability is retained without files being the system of record.

```
# mem_fact_events rows (append-only):
{op: fact_added,      id: f_01, scope: global, content: "User uses Bun, not Node", source: evt_88, confidence: 0.9, ts: ...}
{op: fact_added,      id: f_02, scope: global, content: "User dislikes emoji-heavy text", source: user, confidence: 1.0, ts: ...}
{op: fact_tombstoned, id: f_01, reason: user, ts: ...}
```

- **Recall:** semantic top-k over the embedding index, scope-filtered. Initially plain JS
  cosine over the (small) scope-filtered candidate set; sqlite-vec is an opt-in upgrade once
  its version is pinned (§7).
- **Feeds L2/L3:** the bulk raw material; `drain()` pulls un-consolidated facts from here.

### 3.3 L1.1 ↔ L1.2 hot/cold tiering

```
L1.2 fact recalled often / flagged important  ->  promote into MEMORY.md (becomes L1.1)
L1.1 entry long-unused / stale                ->  demote back to L1.2 (recallable, not always injected)
```

Promotion is one of the generalizations the L3 cron performs (§5). Demotion is also how the
L1.1 token ceiling is enforced.

### 3.4 Pluggable L1 backend (adapter) — Decision D1

L1 is a **swappable adapter**: default self-built (L1.1 MD files + L1.2 SQLite event table),
optional mem0. L2/L3 are always self-built.

**Impedance mismatch:** self-built L1 yields structured fact rows (content + provenance +
confidence); mem0 returns already-extracted/deduped memory strings with provenance hidden
server-side. So the adapter boundary cannot be `recall() -> string`, or mem0 starves L2.

**Adapter contract (design):**

```
L1Adapter:
  observe(turn, ctx)           -> void        # ctx = WriteCtx {sessionId, scope, otr};
                                               #   if ctx.otr: force scope=session:<sessionId>, tag otr=true
  recall(query, scopes, k)     -> Fact[]       # normalized DTO
  drain(sessionId)             -> Fact[]       # for L2: pull "to-consolidate" facts; excludes otr=true
  capabilities                 -> { provenance, eventLog, tombstone, otrIsolation, drainByCursor: boolean }
```

```
Fact { content; source? (EventId|'user'|null); confidence?; ts; scope }
```

L2/L3 depend only on `Fact`, never on the backend.

### 3.5 Q1 resolved — capability negotiation, and what mem0 can/cannot back (F-6)

`capabilities.provenance` alone is **not enough** (resolves F-6). The L2/L3 + OTR guarantees
depend on four more backend abilities — without them, switching to mem0 silently breaks
privacy and idempotency:

| Capability | Needed for | mem0 |
|------------|-----------|------|
| `provenance` | confidence model, `why` evidence chain | ✗ (server-side, hidden) |
| `eventLog` | append-only events + deterministic replay | ✗ |
| `tombstone` | logical delete + propagation by `factId` (§13.3) | ✗ |
| `otrIsolation` | force session-scope + tag `otr`, never leak (§2.3) | ✗ |
| `drainByCursor` | `drain()` by monotonic cursor for L2 idempotency (§13.3) | ✗ |

**Gating rule:** a backend may serve **L1 recall only** unless it advertises *all of*
`{eventLog, tombstone, otrIsolation, drainByCursor}`. mem0 (lacking them) is therefore usable
as a recall-only L1, but **Advanced Mode and OTR are disabled** on a mem0-backed L1 — they
require the self-built backend. `provenance=false` additionally degrades L2/L3 (confidence
discounted, `why` returns "source not traceable") when a partial backend is in play. Net
framing: **mem0 = cheap shallow recall; the self-built backend = the only one that satisfies
the privacy + idempotency contracts.**

---

## 4. L2 — Dynamic knowledge graph

- **Trigger:** task → `succeeded` ⇒ `consolidate(sessionId, scope)` (fire-and-forget).
- **Non-blocking, eventually consistent (revised F2).** L2/L3 extraction **never blocks the
  task** — the task completes immediately and consolidation runs off to the side. Because
  `observe()` is async, consolidation may run before the last turn's facts are committed;
  **that gap is accepted**. It self-heals via a **periodic L2 catch-up job (§4.2), not via
  L3** (resolves F-2): L3 reasons over L1+L2 — it is *not* an L2 runner — so "next task
  success or L3 cron" would strand a late fact whenever no further task succeeds. The
  catch-up job drains committed-but-unconsolidated facts on a timer regardless of task
  activity. The idempotency below makes re-passing safe.
- **Input: L1 + all available context.** Not just drained L1.2 facts — the consolidation
  reads the full available context of the completed task: conversation history, tool
  outputs, task results/artifacts, and L1.1 entries (as high-confidence seeds). L1 is the
  structured backbone; the surrounding context fills in relations the raw facts miss.
- **Process:** extract entity nodes + relation edges from that combined input → upsert.
- **L2 idempotency — cursor + support set (resolves F3, refined per F-5).** L2 has a
  `consolidatedThrough` cursor (distinct from L3's `derivedThrough`, §5.2) over the source
  event stream. An edge is keyed by `(scope, src, dst, relation, provenanceClass)` **per
  validity window** — **`provenanceClass` is in the key (resolves F-P3)** so a `user` edge and
  a `machine` edge for the same relation never merge and the confidence model stays intact —
  and carries a **`support` set of `{factId, eventId, taskId}`** (not a single `sourceTaskId`;
  `factId` anchors tombstone propagation, §13.3). Consolidation **merges** into that set,
  idempotent by `eventId`:
  - a re-run / overlapping catch-up bearing an already-seen `eventId` → no-op;
  - a **late fact for the same task+relation extends `support`** (and bumps confidence) rather
    than being rejected by a unique constraint;
  - a fact that **changes** the relation opens a new validity window (closes the old `validTo`).

  This replaces the earlier `sourceTaskId`-only unique key, which would have blocked late
  facts and collapsed per-event support chains.
- **"Dynamic":** edges carry `validFrom` / `validTo` (`validTo = null` ⇒ current). Superseding
  a relation closes the old edge's `validTo` and opens a new one — never deletes. **This
  supersession applies only within the same `(scope, src, dst, relation, provenance-class)`**;
  it is *not* a conflict rule. Contradictions across scope or provenance coexist as edges and
  are resolved at read time by the single canonical rule in §2.2.

### 4.1 Pluggable L2 backend (provider) — there IS a vendor ecosystem

Unlike L3, L2 has real vendors (Zep/Graphiti — temporal KG with validity windows, nearly
identical to our design; Cognee; mem0 graph mode). So `L2Provider` is worth abstracting:
default self-built (SQLite edges), future swap to Cozo/Oxigraph/Zep behind the interface,
gated by Bun native-binding compatibility checks.

### 4.2 L2 catch-up job (closes the late-fact gap, F-2)

An independent, timer-driven job that consolidates any committed L1 facts past L2's
`consolidatedThrough` cursor — **independent of task success**, so a late `observe` is never
stranded just because no further task completes. The L3 cron **invokes catch-up first**, so
inference always runs over an up-to-date graph (L3 never doubles as the L2 runner). This job,
the on-success trigger, and backfill are all idempotent (§4 cursor + support set), so they
may overlap safely. Like all consolidation it is a background job surfaced via `memoryJobs`
(§5.4 / §11.2).

---

## 5. L3 — Inferred laws (scheduled cron) — Decision D2

**NOT a pluggable provider** — no commercial vendor ecosystem exists (only academic
prototypes: MemEngine, Meta-Policy Reflexion). It is "run an LLM reasoning pass over your
own L1+L2." Keep it concrete/self-built; expose an internal `InferenceStrategy` hook
(swap model / prompt / promotion policy), which is config, not a vendor boundary.

### 5.1 Cron cadence per scope

- `agent` scope: one cron per active agent, higher frequency.
- `global` scope: a single low-frequency cron (expensive, slow-changing).
- `session` scope: **no L3**.

Crons register on the daemon (monad already has `scheduled-tasks` / daemon plumbing).

### 5.2 Incremental, not full re-inference

Reason only over what changed since the last run (new facts + dirtied subgraph). Requires an
**L3-specific `derivedThrough` watermark** (distinct from L2's `consolidatedThrough`, §4) or
a `dirty` flag on facts/edges. The two cursors are independent: L2 tracks "which source
tasks are turned into graph", L3 tracks "which facts+edges are reasoned into laws".

### 5.3 Law lifecycle (L3 boundary — what L3 may and may NOT do)

L3 **first requests/awaits L2 catch-up** (§4.2) so it reasons over a current graph, then:

- derives / updates **laws** — `mem_laws` is the **only table L3 writes directly**;
- **confidence decay**, **`supersededBy`**, **support-chain invalidation** — all on laws;
- **emits promotion decisions** for scope promotion (§13.4) and L1.1↔L1.2 promotion/demotion
  (§3.3) as *recommendations* — it does **not** apply them.

**Write boundary (resolves F-4).** L3 mutates only `mem_laws`. It never writes the L2 graph,
never writes L1 fact events, never edits MD files. Promotion/demotion **decisions** L3 emits
are applied by a separate **promotion job** in store/daemon, which performs the actual
fact-event inserts (§13.1) and MD edits. (The earlier "consolidation/dream pass" wording is
dropped — it wrongly implied L3 mutates graph/facts.)

### 5.4 L2 and L3 are both background jobs (resolves the blocking contradiction, F-1)

Neither layer runs in the turn chain. **L2 consolidation and L3 inference are independent
background jobs** — their own tasks, triggered by events or cron (§4.2 / §5.1) — that **never
block an agent's normal operation**. Token cost is attributed to those jobs, not to the
interactive turn; the accepted cost is a staleness *gap* (§4), not latency. (This supersedes
the earlier "L2 runs inside the turn chain / user waits" wording.)

**Surfaced to the UI so the user decides.** A memory-generation job is observable while it
runs: the control API exposes in-flight L2/L3 jobs per scope (`memoryJobs`, §11.2), so the
GUI can show "memory updating…" and let the user **wait for it or carry on** — the choice is
the user's, never a forced block.

### 5.5 Enabling Advanced Mode (per-agent) + historical backfill — Decision D10

**Advanced Mode is a per-agent setting** (not a global or per-session flag). Turning it on
for an agent means: from now on, the agent runs L2 consolidation (on task complete) and the
L3 cron as designed — extraction/summarization happens "as needed", lazily, driven by the
normal triggers.

**At enable time, prompt the user once:** *"Initialize L2/L3 from this agent's historical
sessions?"*

- **Yes → backfill.** A one-time background batch job replays the agent's stored history
  (messages / tool outputs / task results already in the store — **excluding any `otr=true`
  sources, §2.3** — plus the L1 facts already recorded; L1 runs regardless of Advanced Mode)
  through the pipeline: `for each historical task/session: L2.consolidate(...)` then a single
  `L3.infer(scope)`.
  - **Background, not blocking** — same lane as the cron; the user does not wait.
  - **Cost-gated:** show an estimate (N sessions × passes) and require explicit confirmation
    before it runs, since it can be large.
  - **Idempotent:** advances L2's `consolidatedThrough` and L3's `derivedThrough` cursors
    (§4 / §5.2), so re-running never double-counts.
  - Scope: operates at `agent` scope (may also contribute to `global`).
- **No → forward-only.** L2/L3 start empty and build only from new tasks going forward.
  Privacy/cost-conscious default-safe choice.

A manual `memory backfill <agentId>` command is also available later, in case the user
declines at enable time but changes their mind.

**Advanced Mode is a state machine, not a boolean (resolves F6, transitions pinned per F-6).**
`off` means L1 only; **every other state means Advanced Mode is ON** (forward L2/L3
consolidation active) and differs only in backfill progress. The only legal transitions:

| From | Event | To |
|------|-------|----|
| `off` | `setAdvanced(on)` | `estimating` |
| `estimating` | estimate ready | `awaiting_confirm` |
| `awaiting_confirm` | `confirmBackfill` | `backfilling` |
| `awaiting_confirm` | `declineBackfill` | `declined` |
| `backfilling` | success | `on` |
| `backfilling` | error | `failed` |
| `failed` | `backfill` (retry) | `backfilling` |
| `declined` | `backfill` (resume) | `backfilling` |
| *any state* | `setAdvanced(off)` | `off` |

- `on` / `declined` / `failed` are all **"Advanced ON"** — forward-only L2/L3 runs in all
  three; they differ only in backfill outcome (`on` = backfilled, `declined` = user skipped,
  `failed` = errored, retryable & idempotent §4).
- **`decline` goes to `declined`, NOT `off`** — only `setAdvanced(off)` disables the mode.
- `failed` keeps forward consolidation running; the error is surfaced but non-fatal, and
  `backfill` retries it.

The control API (§11.2) returns this state, never a bare boolean.

---

## 6. Interface & flows (design-level types)

Evolves the current trivial `Memory` (`remember/recall/forget`); keeps the provider
`prefetch/sync_turn` shape (`recall`/`observe`), adds layers + scopes. The old KV interface
survives as a degenerate implementation for compat.

```ts
type ScopeKind = 'session' | 'agent' | 'global';  // 'org' reserved (future paid tier, §2.2)
interface Scope { kind: ScopeKind; id: string }   // id = sessionId | agentId | '*'

interface RecallCtx {
  query: string;
  sessionId: SessionId;
  agentId: AgentId;
  advanced: boolean; // Advanced Mode: L2+L3 toggle
  // no `otr` here — OTR gates writes, not reads (§2.3); it is a session-level flag
  budget: { core: number; facts: number; graph: number; laws: number }; // per-layer token caps
}

// OTR enforcement is explicit on the write path, not inferred from `Turn` (resolves F-4):
interface WriteCtx { sessionId: SessionId; scope: Scope; otr: boolean }

interface MemoryBlock {        // injected into the prompt
  core: string;        // L1.1 (always)
  facts: Fact[];       // L1.2
  subgraph?: GraphView;// L2 (advanced)
  laws?: Law[];        // L3 (advanced)
  tokens: number;
}

interface LayeredMemory {
  recall(ctx: RecallCtx): Promise<MemoryBlock>;
  observe(turn: Turn, ctx: WriteCtx): Promise<void>;              // L1.2 write; if ctx.otr → scope forced to session, tagged otr
  consolidate(sessionId: SessionId, scope: Scope): Promise<void>; // L2 (background job)
  infer(scope: Scope): Promise<void>;                              // L3 (background job)
  toolSchemas(): ToolSchema[];                                     // mem_search / graph_query / why
  handleToolCall(name: string, args: unknown): Promise<string>;
}
```

### 6.1 Read path (prefetch)

```
recall(ctx):
  core   = L1.1 full (agent: SOUL/AGENTS  +  global: USER/MEMORY)   # always, own budget
  facts  = L1.2.recall(query, scopes, k)                           # dynamic
  if advanced:
    subgraph = L2.neighborhood(entities(facts), scopes)
    laws     = L3.applicable(query, scopes)
  return assemble({ core, facts, subgraph, laws }, budget)
# OTR does NOT affect reads — reads are identical. OTR only gates writes (§2.3).
```

### 6.2 Write path

```
every turn end   -> L1.2.observe(turn, {sessionId, scope, otr})  # async; inserts fact_added tagged otr (L1 written even under OTR)
task succeeded   -> L2.consolidate(sessionId, scope) # fire-and-forget; drains committed facts by cursor (eventual)
cron (per scope) -> L3.infer(scope)                  # inference + tidy + promotion/demotion
manual / promote -> write to L1.1 MD (source:user, high confidence, never auto-pruned)
edit / delete    -> insert fact_edited / fact_tombstoned event (never rewrite a prior row)
```

Consolidation does not wait on `observe`; a fact that lands late is consolidated on the next
pass (§4.2). Under OTR, `observe` forces `scope = session:<this>` and tags `otr=true`; those
facts stay session-local and never promote or feed L2/L3 (§2.3).

---

## 7. Storage (all local, single `bun:sqlite` + files)

monad standardizes on `bun:sqlite` + Drizzle, "no external service". Native graph bindings
(Cozo/Oxigraph via napi) carry Bun-compat risk, so the **default is pure SQLite**. The only
files are L1.1's MD core (human-authored, small, hand-edited); everything machine-written
lives in SQLite (revised F5).

| Layer | Storage | Dynamic via |
|-------|---------|-------------|
| L1.1 | MD files (source of truth — human-authored, small, hand-edited) | n/a (prose) |
| L1.2 | `bun:sqlite` append-only **event table** (truth) → materialized fact table + embeddings (rebuildable by replay) | open JSON content |
| L2   | `bun:sqlite` `nodes` + `edges`; `relation` free string, `props` JSON, `validFrom/validTo` | free relation types + JSON props (≈ poor-man's triples) |
| L3   | `bun:sqlite` `laws`; `support` JSON | structured rows |

> **The authoritative schema is §13.1** — full columns, `eventId`, `provenanceClass`, the
> `mem_cursors` table (both cursors index `mem_fact_events.seq`), and the `otr` flags. This
> section only sketches the *shape*; do not implement from here. (The earlier inline DDL that
> omitted `eventId` and said "cursor over source tasks" is removed to avoid divergence — F-5.)

Shape, per layer: **L1.2** = `mem_fact_events` (append-only truth) → `mem_facts` (materialized
by replay); **L2** = `mem_nodes` + `mem_edges` (temporal, `provenanceClass` in the unique key,
`support` set of `{factId, eventId, taskId}`); **L3** = `mem_laws`. Cursors `consolidatedThrough`
(L2) and `derivedThrough` (L3) both advance over `mem_fact_events.seq`. `sessions/tasks/messages`
carry `otr`; OTR writes are session-scoped (§2.3) and every L2/L3 path excludes `otr=true`.

**Graph traversal** via recursive CTEs. **"Dynamic non-predefined"** is satisfied by
free-string `relation` + JSON `props` — new relation types / property keys need no DDL
(~90% of an RDF triple store's flexibility, zero new dependency).

### 7.1 Storage decisions (with rationale)

- **KùzuDB rejected:** archived Oct 2025, and required immutable schema anyway (not dynamic).
- **sqlite-vec deferred, not default:** real April-2026 ABI bug (precompiled for SQLite
  3.45.x, breaks on 3.51.x). Bun ships its own SQLite version. So **JS cosine over
  scope-filtered candidates is the default**; sqlite-vec is opt-in after pinning the
  SQLite/extension versions.
- **Cozo / Oxigraph = future L2Provider migration targets**, not initial deps.

### 7.2 Audit / edit / delete / add

- **L1.1:** edit MD files directly.
- **L1.2:** the append-only event table is the canonical record (§3.2); `monad memory list
  --scope ...` (CLI in `apps/cli`) + web table (`apps/web`) read the **materialized** view,
  all via the daemon (single writer, transactional). Every mutation **inserts an event** —
  rows are never rewritten, so support-chain refs and reproducible replay are preserved.
  `memory export` dumps to JSONL for offline reading.
  - **modify:** `memory edit <id>` → insert `fact_edited`; re-materialize + reindex; `source`
    becomes `user`.
  - **delete:** `memory forget <id>` → insert `fact_tombstoned` (**logical**, not a physical
    delete); the materialized row is marked tombstoned.
  - **add:** `memory add` → insert `fact_added`; embed; `source:user`, `confidence:1.0`,
    never auto-pruned.
- **Deletion propagation:** a tombstoned L1 fact propagates up the pipeline — the next L2
  consolidate / L3 cron re-derives or down-weights edges/laws whose `support` references it.
  No orphaned graph/laws left contradicting a deleted fact.
- **`source:user` priority:** human-entered facts are authoritative — they supersede
  conflicting machine-extracted facts (§2.2).

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
| D18 | Scope model | one monad instance = one user, so `global` = that user (no per-user partition). `org:<id>` reserved as a future paid tier above `global`. (Open-Q1, revised) |
| D19 | Advanced Mode state | a state machine with pinned transitions (§5.5); `on/declined/failed` are all "Advanced ON" terminal states; `decline`→`declined` (not `off`); only `setAdvanced(off)`→`off`; `failed`/`declined` resume via `backfill`. (F6, pinned F-6) |
| D20 | Package boundary | agent-core = interfaces/types/pure logic; store = persistence + replay + queries; daemon = single-writer, cron, backfill, control API, OTR enforcement. (Open-Q2, §12) |
| D21 | L2/L3 are background jobs | L2 consolidation, L2 catch-up, and L3 inference are independent background jobs — never block an agent turn; in-flight jobs surfaced via `memoryJobs` so the user waits or continues. (F-1) |
| D22 | observe write contract | `observe(turn, WriteCtx{sessionId, scope, otr})` — explicit in the signature, not inferred from `Turn`; tags L1 facts with `otr` (L1 written even under OTR). (F-4) |
| D23 | Storage schema | authoritative tables pinned in §13.1 (`mem_fact_events` w/ `seq`+`eventId`, `mem_facts`, `mem_nodes`, `mem_edges` w/ `provenanceClass`, `mem_laws`, `mem_cursors`, `otr` on sessions/tasks/messages). |
| D24 | Job gating | gate checked *inside* each job. **Forward jobs (consolidate/catch-up/infer) run in any state ≠ `off`**; **backfill runs only in `backfilling`**. `off` ⇒ no graph/laws ever. OTR excludes `otr=true`. (§13.2, Point 1; F-3) |
| D25 | Event/cursor/support IDs | cursor axis = `mem_fact_events.seq` (monotonic, not task-based); `eventId` stable ULID; `support` = set of `{factId,eventId,taskId}`; **tombstone propagates by `factId`** (same factId, new eventId) so dependents are found. (§13.3, Point 2; F-2) |
| D26 | Promotion policy | L3 **decides**, a store/daemon promotion job **applies**. One step at a time; ≥N distinct sessions; `→global` needs `user` provenance or (machine ∧ ≥N sessions ∧ confidence≥τ); otr never eligible; reversible. (§13.4, Point 5) |
| D-P3 | L2 edge provenance | `provenanceClass` is part of the edge unique key — `user` and `machine` edges for the same relation/window never merge. (§4 / §13.1, Point 3) |
| D27 | L3 write boundary | L3 mutates **only `mem_laws`**; never the L2 graph, fact events, or MD. Promotion/demotion are decisions applied by a separate job. (§5.3, F-4) |
| D28 | L1 backend capabilities | L2/L3 + OTR require `{eventLog, tombstone, otrIsolation, drainByCursor}` (plus `provenance` for full fidelity). A backend missing them (mem0) is **recall-only L1**, with Advanced Mode + OTR disabled on it. (§3.5, F-6) |

## 9. Open questions

_None — all resolved. See decisions D1–D28 (+D-P3); §13 holds the mechanical build contracts._

---

## 10. Naming / product concepts

| Concept | Internal term | Product name |
|---------|---------------|--------------|
| L2 + L3 enabled | advanced layers | **Advanced Mode** |
| Identity-kept, memory-dropped private session | OTR | **Off the Record** |
| Always-injected core | L1.1 | core memory |
| Dynamically recalled corpus | L1.2 | recall memory |

---

## 11. GUI contract (consumed by a GUI, NOT part of this package)

**Rendering/visualization is out of scope for this package.** `@monad/agent-core` and
`@monad/store` stay **headless** — they expose data + a control API; any GUI (`apps/web`,
`clients/desktop`) consumes it. Graph-visualization libraries are **dependencies of the
consuming app only**, never of this package.

### 11.1 Dependency direction (one-way)

```
@monad/agent-core  (interfaces + types + pure logic — headless, no I/O)
        ▲
        │ implemented by
@monad/store       (persistence: L1.1 MD files, SQLite event table, replay, CTE queries)
        ▲
        │ orchestrated by
monad daemon       (single writer, cron, backfill, OTR enforcement, control API)
        ▲
        │ depends on (read/mutate via daemon control API)
apps/web / clients/desktop   ── own ALL visualization deps (graph libs, charts, time-slider)
```

This package (`agent-core`) MUST NOT import any rendering/DOM/visualization dependency. The
boundary is the control API below; the layer-by-layer ownership is §12.

### 11.2 Read/query surface the GUI depends on (stable contract)

Served over the daemon control API; shapes reference the domain types in `@monad/protocol`.

| Need | Operation (shape) | Returns |
|------|-------------------|---------|
| core memory (L1.1) | `getCore(scope)` / `putCore(scope, role, md)` | MD text per role × scope |
| recall memory (L1.2) audit | `listFacts({ scope?, query?, page })` | `Fact[]` (materialized rows; `memory export` for JSONL dump) |
| fact mutate | `addFact / editFact / forgetFact(id)` | tombstone on delete (§7.2) |
| graph (L2) explore | `getSubgraph({ node, depth, scope?, at? })` | `{ nodes, edges }` — **server-side neighborhood** (recursive CTE), never the whole graph |
| graph temporal view | `at?: ISO8601` filters edges to `validFrom ≤ at AND (validTo IS NULL OR validTo > at)` | time-sliced subgraph |
| laws (L3) | `listLaws({ scope? })` | `Law[]` |
| evidence chain (`why`) | `getSupport(lawId)` | the fact/edge ids a law rests on — the GUI highlights this path |
| Advanced Mode | `getAdvanced(agentId)` / `setAdvanced(agentId, on)` | the **state** (`off/estimating/awaiting_confirm/backfilling/on/declined/failed`, §5.5) + estimate when awaiting — never a bare boolean |
| confirm/decline backfill | `confirmBackfill(agentId)` / `declineBackfill(agentId)` | advances the state machine from `awaiting_confirm` |
| backfill | `backfill(agentId)` / `backfillStatus(agentId)` | trigger / **retry from `failed`** / **resume from `declined`** + `{ state, progress, error? }` (background, cost-gated, idempotent) |
| in-flight memory jobs | `memoryJobs({ scope? })` | running/queued L2 (consolidate, catch-up) + L3 jobs: `{ kind, scope, progress, startedAt }` — GUI shows "memory updating", user waits or continues (§5.4) |

### 11.3 What the GUI is expected to provide (informational only — built in the app)

So the contract above is designed to support, without this package depending on any of it:

- **Don't fetch the whole graph** — use `getSubgraph` neighborhood + click-to-expand.
- **Temporal scrubbing** via the `at` parameter (replay how relations evolved — the payoff of
  time-versioned edges).
- **Scope coloring** (session / agent / global) and **evidence-chain highlighting** from
  `getSupport` (visual form of `why`).
- Mobile: a degraded list + node-detail view rather than a full interactive graph.

The choice of rendering library lives entirely in the consuming app and is documented there,
not here.

---

## 12. Package ownership map (resolves Open-Q2)

The design spans `agent-core`, `store`, and the daemon. To keep `agent-core` genuinely
storage-agnostic, responsibilities split as:

| Concern | `@monad/agent-core` | `@monad/store` | daemon |
|---------|---------------------|----------------|--------|
| Types (`Scope`, `Fact`, `Law`, `RecallCtx`, `MemoryBlock`) | **defines** | imports | imports |
| Interfaces (`LayeredMemory`, `L1Adapter`, `L2Provider`, `InferenceStrategy`) | **defines** | implements | wires |
| Pure logic (scope resolution §2.2, budget assembly §6.1, capability negotiation §3.5) | **owns** | — | — |
| L1.1 MD files (read/write, token ceiling) | interface | **impl** | exposes via API |
| L1.2 event log + materialize/replay + embeddings | interface | **impl** | exposes via API |
| L2 SQLite graph (upsert, temporal edges, CTE neighborhood) | interface | **impl** | exposes via API |
| L3 inference run | `InferenceStrategy` interface | persists laws | **schedules cron**, runs job |
| Cursors (`consolidatedThrough`, `derivedThrough`) | — | **stores** | advances during runs |
| Single-writer serialization | — | — | **owns** |
| Backfill orchestration + state machine | — | — | **owns** |
| OTR enforcement (`otr` ⇒ session-scope write + tag; no promotion; excluded from L2/L3) | rule in `WriteCtx.otr` contract | forces session scope, tags `otr`; excludes `otr=true` from promotion + L2/L3 paths | **enforces — passes `otr` in `WriteCtx`** |
| Control API (§11.2) | — | — | **serves** |

Rule of thumb: **`agent-core` is import-only of `@monad/protocol`** and defines contracts;
anything that touches disk, SQLite, the clock, or cron lives in `store` (persistence) or the
daemon (orchestration). The trivial in-memory `Memory` (§6) stays in `agent-core` as a
zero-I/O default/test double.

---

## 13. Implementation contracts (mechanical — the build spec)

§1–12 fix the architecture; this section pins the four areas that must be mechanical before
coding so implementation never fills gaps by guesswork: **storage schema, job gating,
event/cursor/support IDs, promotion policy**.

### 13.1 Storage schema (authoritative DDL intent)

All `bun:sqlite`; only L1.1 is files. `id` columns are ULIDs (`@monad/protocol`).

```
-- L1.1: files (SOUL/AGENTS/USER/MEMORY .md per scope) — not in DB.

-- L1.2 truth: append-only event log
mem_fact_events
  seq         INTEGER PRIMARY KEY AUTOINCREMENT   -- the ONE monotonic cursor axis (§13.3)
  eventId     TEXT NOT NULL UNIQUE                -- stable ULID, assigned at observe()
  op          TEXT NOT NULL                       -- 'fact_added' | 'fact_edited' | 'fact_tombstoned'
  factId      TEXT NOT NULL                       -- stable across edits/tombstone of the same fact
  scopeKind   TEXT NOT NULL                       -- 'session'|'agent'|'global'  (+'org' future)
  scopeId     TEXT NOT NULL
  content     TEXT                                -- null for tombstone
  source      TEXT                                -- EventId | 'user'
  provClass   TEXT NOT NULL                       -- 'user' | 'machine'  (derived from source)
  confidence  REAL
  otr         INTEGER NOT NULL DEFAULT 0          -- 1 ⇒ excluded from L2/L3 (§2.3)
  ts          TEXT NOT NULL
  INDEX (scopeKind, scopeId, seq)

-- L1.2 materialized (replay of the log; rebuildable)
mem_facts
  factId PRIMARY KEY, scopeKind, scopeId, content, source, provClass, confidence,
  otr, tombstoned INTEGER NOT NULL DEFAULT 0, lastEventSeq INTEGER, ts

-- L2
mem_nodes
  id PRIMARY KEY, scopeKind, scopeId, entityType, label, props JSON, embedding BLOB, updatedAt
mem_edges
  id PRIMARY KEY, scopeKind, scopeId, src, dst, relation, provenanceClass, weight,
  validFrom, validTo, props JSON, support JSON,    -- support = set of {factId, eventId, taskId}
  UNIQUE (scopeKind, scopeId, src, dst, relation, provenanceClass, validFrom)

-- L3
mem_laws
  id PRIMARY KEY, scopeKind, scopeId, statement, support JSON, confidence,
  derivedAt, supersededBy

-- cursors (one row per (layer, scope)); both index into mem_fact_events.seq
mem_cursors
  layer TEXT, scopeKind TEXT, scopeId TEXT, throughSeq INTEGER,
  PRIMARY KEY (layer, scopeKind, scopeId)          -- layer ∈ {'L2','L3'}

-- session/task/message carry otr (set at session creation, propagated)
sessions.otr, tasks.otr, messages.otr   INTEGER NOT NULL DEFAULT 0
```

### 13.2 Job gating — Advanced Mode is a hard precondition for EVERY background job (Point 1)

No background memory job runs for an `(agent, scope)` unless Advanced Mode is ON. This is a
gate checked **inside each job**, not just at scheduling, so a mode flip mid-flight is honored.

**Forward jobs run in *any* non-`off` state (resolves F-3).** "Advanced ON" = state ≠ `off`,
which includes `estimating` / `awaiting_confirm` / `backfilling` / `on` / `declined` /
`failed`. Forward consolidation is **orthogonal to the historical-backfill choice**: the moment
the user flips Advanced on, new tasks start generating L2/L3 — they don't wait for the backfill
decision. (This reconciles §5.5's "every non-off state is ON" with the gate.)

| Job | Runs only if | Also excludes |
|-----|--------------|---------------|
| L2 consolidate (on task success) | Advanced state **≠ `off`** for the scope | `otr=true` facts |
| L2 catch-up (timer, §4.2) | same | `otr=true` facts |
| L3 infer (cron, §5.1) | same | `otr=true`-derived edges |
| backfill (§5.5) | state **== `backfilling`** + a run token | `otr=true` sources |

`off` ⇒ all forward jobs are no-ops (and not scheduled). This guarantees the product promise:
Advanced Mode OFF means **no graph/laws are ever generated**, even by the timer-driven catch-up.
Only the one-shot **backfill** is restricted to the `backfilling` state; forward consolidation
is not.

### 13.3 Event / cursor / support IDs — the closed loop (Point 2)

Pinned definitions, no ambiguity:

- **`eventId`** — stable ULID, assigned once at `observe()` per event row; never reused.
- **Cursor axis is `mem_fact_events.seq`** (monotonic autoincrement), **not** task-based. L2 and
  L3 each store `throughSeq`; "process new" = `WHERE seq > throughSeq`.
- **`support`** is a set of `{factId, eventId, taskId}` (resolves F-2). **`factId` is the
  durable anchor**, `eventId` the dedupe key, `taskId` the grouping key. Storing `factId` is
  what lets a later delete find its dependents.
- **Idempotency:** consolidation/inference merge by `eventId`; re-seeing an `eventId` is a
  no-op ⇒ overlapping catch-up + on-success + backfill are safe.
- **Late-fact merge:** a new `eventId` for an existing edge key extends `support` (and bumps
  confidence); a relation *change* opens a new validity window.
- **Tombstone propagation (closed loop, by `factId`):** `fact_tombstoned` gets a **new**
  `eventId`/`seq` but carries the **same `factId`**. So dependents are matched **by `factId`,
  not by the tombstone's eventId** (the original `fact_added` eventId is what edge `support`
  holds — matching on the tombstone's own eventId would find nothing, which was the F-2 bug).
  Advancing past the tombstone re-scans: any `mem_edges` whose `support` contains that `factId`
  is recomputed (window closed if now unsupported); any `mem_laws` referencing the affected
  fact/edge is down-weighted (§5.3). Deletes thus flow up L1→L2→L3 with no manual bookkeeping.

### 13.4 Scope promotion policy (Point 5 — minimal but explicit)

Promotion (`session → agent → global`) is **decided** by L3 (§5.3) and **applied** by a
separate promotion job in store/daemon (L3 only emits the decision; the job writes the
fact events / MD). Minimum constraints so a single mis-extraction can't pollute shared memory:

| Rule | Spec |
|------|------|
| Direction | strictly one step at a time; no `session → global` skip. |
| Evidence threshold | promote only if support spans **≥ N distinct sessions** (default N=3), not N events in one session. |
| Provenance gate | `session→agent`: `machine` or `user` allowed. **`→ global`: requires `provClass='user'` OR (`machine` AND ≥ N sessions AND confidence ≥ τ, default τ=0.8).** |
| OTR | `otr=true` facts are never eligible (they aren't even L2/L3). |
| Rollback | a promotion is recorded as a fact event (`promoted_from`); if its supporting evidence is tombstoned, support-chain invalidation (§13.3) demotes/removes the promoted copy — promotion is reversible. |
| org | out of scope until the paid `org` tier ships; the policy table gains one row then. |

These four contracts are the hand-off point: schema, gating, IDs, and promotion are now
mechanical enough to implement without re-deriving intent.
