# Context management (the gentle cascade)

How the agent keeps a turn's prompt inside the model's context window without a
single lossy "summarize everything" cliff. Instead of one step, pressure is
relieved in a **cascade**: cheap and lossless first, lossy only when it must be,
each stage doing the least destructive thing that still fits the window — and
every stage is recoverable or observable rather than silent.

This describes the code as it runs today. The original design notes live in
`.claude/plans/`; where they differ, this document and the code win.

Code map:

| Piece | Lives in |
|---|---|
| Cascade engines (eviction, recitation, retrieval, token limiter, composite) | `apps/monad/src/agent/context/` |
| Token accounting + self-calibrating estimator | `apps/monad/src/agent/context/budget.ts`, `estimate.ts` |
| Durable, bounded-load summarizer | `apps/monad/src/agent/history.ts` |
| Per-turn prompt assembly (where each stage splices) | `apps/monad/src/agent/loop/internal/prompt-builder.ts` |
| Tool-output truncation + raw-output spill | `apps/monad/src/agent/loop/internal/tool-execution.ts`, `loop/tool-output.ts` |
| Raw-output store (`tool_raw_outputs`) | `apps/monad/src/store/db/schema.ts`, `index.ts` |
| `read_tool_output` recovery tool | `apps/monad/src/capabilities/tools/registry/read-tool-output.ts` |
| Memory promotion from compacted spans | `apps/monad/src/services/memory/index.ts` (`promoteFacts`) |
| Assembly of the whole thing (config → engines → deps) | `apps/monad/src/agent/execution.ts` |
| Config | `packages/home/src/config/config-schema.ts` (`contextSettingsSchema`) |
| Telemetry / notice events | `packages/protocol/src/event-table.ts` |
| Web surfaces (usage panel, toasts) | `apps/web/src/features/session/` (`use-context-notices.ts`), `packages/ui/src/components/composer/context-usage-panel.tsx` |

Everything is under the `context.*` block in `config.json`, hot-reloaded via
`ConfigService`. The shipped defaults turn on the lossless and lossy stages;
recitation, memory promotion, the handoff nudge, and semantic retrieval are
opt-in (see [Configuration](#configuration)).

## The pressure ladder

Each stage triggers at a fraction of the active model's context limit. Occupancy
is measured by `effectiveInputTokens` ([context/index.ts](../../apps/monad/src/agent/context/index.ts)):
it prefers the provider's **real** input-token count from the previous step
(true occupancy — system prompt + tool schemas + messages) and falls back to a
self-calibrating char/token estimate before any real count exists. The one-step
lag is fine for soft/eviction triggers; the hard overflow guard stays on the
in-turn estimate, which tracks growth without lag.

```
occupancy →   0.5              0.6                        0.9
              │ eviction        │ summarize (soft)          │ summarize (hard) / TokenLimiter
              │ lossless        │ lossy, background          │ lossy, blocking / truncate
```

- **0.5 `eviction.atFraction`** — replace old tool-result *outputs* with a short
  pointer placeholder (lossless — the bytes are recoverable, see below).
- **0.6 `summarize.softFraction`** — fold older turns into a durable rolling
  summary, in the background by default (the turn proceeds at full width; the
  summary lands on a later turn).
- **0.9 `summarize.hardFraction`** — the same summarization, but blocking: a turn
  that starts at/over this waits for any in-flight compaction, then compacts
  synchronously if still over. A per-model-step `TokenLimiterContext` at the same
  fraction is the last-resort hard truncation so the window can never overflow
  mid tool-loop even if summarization lagged.

Tool-output truncation (below) is separate — it fires per result at a fixed char
cap, not on window pressure.

## Two assembly phases

The stages don't all run at the same point. There are two:

**Per turn, once — `PromptBuilder.buildPrompt`.** The durable summarizer
(`DurableSummarizer.assemble`) loads only the messages since the summary boundary
plus the rolling summary; then the summary is folded into the first user message;
then **retrieval** splices related history; then **recitation** appends the plan
anchor. These run once because their inputs (the loaded window, the latest user
message) don't change across a turn's tool round-trips.

**Per model step — `PromptBuilder.prepare`.** On every step of the tool loop the
assembled messages run through the `context` engine — `CompositeContextEngine([
eviction, TokenLimiter ])`. These re-run each step because the message array grows
as tool results are appended, so eviction and the hard cap must re-evaluate.

> A stage that appends to the *prompt* (retrieval, recitation) runs per-turn to
> avoid duplicating its block on every step; a stage that reacts to the *growing
> window* (eviction, token limiter) runs per-step. Getting this wrong duplicates
> injected text or misses mid-loop growth — see the regression tests in
> `test/unit/agent/retrieval.test.ts`.

## Stage 1 — lossless tool-result eviction

Tool results (file reads, command output, search dumps) dominate a long transcript
and go stale fast: once the model has acted on a `read_file`, the raw bytes rarely
matter again. `ToolResultEvictionContext` reclaims that space **without summarizing**
by replacing the `output` of old tool-result parts with a placeholder
(`[context-cleared] …`). The tool-call/tool-result pairing is preserved (only the
output text changes, no message dropped), so strict providers never see an orphan.

- **Recency is measured in ROUNDS, not results.** A round is one assistant→tools
  step; parallel tool calls in one step land in one `tool` message (same age).
  Protecting the last `keepRecentRounds` rounds keeps each recent step whole
  regardless of how many concurrent results it produced — a flat "keep N results"
  count could split one concurrent batch.
- **It fires in batches.** Only once occupancy crosses `atFraction` **and** a
  single pass can reclaim ≥ `clearAtLeast` tokens; results smaller than
  `minResultTokens` are skipped (not worth a placeholder).
- **Idempotent.** An already-evicted placeholder is never re-evicted.

The placeholder points the model at `read_tool_output` when a recovery handle
exists (see the next section) — so eviction upgrades from "re-run the tool (maybe
non-reproducible or side-effecting)" to "read the exact bytes back."

## Recovery by handle — `tool_raw_outputs` + `read_tool_output`

Truncation and eviction both hide bytes the model might still need. Both spill the
**full pre-truncation output** to a store so it can be paged back deterministically
instead of re-run.

**Tool-output truncation (at execution time).** `truncateToolOutput`
([loop/tool-output.ts](../../apps/monad/src/agent/loop/tool-output.ts)) caps a
single result at `toolOutput.maxChars` (24k default) with a head(70%)+tail(30%)
window and an embedded `read_tool_output({ id, offset, limit })` hint. When
`toolOutput.persistRaw` is on, the full output (capped at `rawCapBytes`) is written
to `tool_raw_outputs` keyed by `(transcript_target_id, tool_call_id)`.

**The `read_tool_output` tool.** Pages back a spilled output by its tool-call id,
with `offset`/`limit` or a `grep` substring filter, re-truncated at the same cap so
paging can't itself blow the window. Registered **only** when `persistRaw` is on
(nothing is ever spilled otherwise, so the tool would always report "not found").

**Store semantics** ([store/db/index.ts](../../apps/monad/src/store/db/index.ts)):

- `saveToolRawOutput` upserts on the primary key.
- `getToolRawOutput` is **lineage-aware** — a branched/forked session can read a
  handle spilled by an ancestor (same `provenance()` chain the `messages`/`events`
  reads use), and is scoped to that lineage so one session can't read another's
  bytes.
- Cleaned up on session/project delete and on `session reset` (cascade in
  [store/db/sessions.ts](../../apps/monad/src/store/db/sessions.ts)).

Eviction's own spill covers results that were **never** truncated at execution time
(short enough to send whole), so evicting an old short result still leaves it
recoverable. It skips re-spilling a result that already has a raw output (checked
via `hasRawOutput`) — by eviction time the in-prompt text is already the persisted
copy, so re-spilling would overwrite the correct full-text entry with a truncated
one.

### Redaction safety

An `AfterTool` hook may redact secrets from a tool result. The hook runs **once,
against the full pre-truncation text** — not a truncated preview — so a secret in
the omitted middle of a large output still triggers redaction; the (possibly
rewritten) result is truncated afterward. When the hook redacts, no raw output is
spilled and no recovery handle is advertised, so a redacted secret can't leak back
through `read_tool_output`.

## Stage 2 — durable summarization

`DurableSummarizer` ([history.ts](../../apps/monad/src/agent/history.ts)) is the
lossy stage. Instead of loading the whole transcript and trimming, it loads only
messages **since a durable summary boundary** plus a persisted rolling summary — so
per-turn DB read and memory stay O(window) regardless of session length, and both
survive restarts.

- The summary is a **structured briefing** (`## Objective / ## Decisions & Facts /
  ## Files & State / ## Open Tasks / ## Next Step`), with identifiers quoted
  verbatim — not free prose.
- `keepRecent` most-recent messages are always sent verbatim (never summarized).
- **Background mode (default).** Crossing `softFraction` kicks a non-blocking
  compaction (deduped per session); the turn proceeds at full width and the durable
  result lands whenever it finishes. A turn at/over `hardFraction` waits for any
  in-flight compaction, then compacts synchronously if still over.
- The summary is folded into the **first user message** (not a separate system
  message — `splitSystem` keeps only the first system message, so a second would be
  dropped). The cheapest configured model (the `fast` tier) does the summarization.
- A reflect pass GC-condenses the rolling summary once it exceeds
  ~4000 tokens.

`/compact` forces a compaction immediately regardless of threshold.

## Stage 3 — recitation anchor (opt-in)

After compaction, "what am I doing right now" is buried in dense summary prose.
When `recitation.enabled`, `parsePlanSections`
([context/recitation.ts](../../apps/monad/src/agent/context/recitation.ts)) pulls
the summary's `## Open Tasks` / `## Next Step` sections and appends a `<plan>`
anchor to the **end** of the prompt, closest to where the model generates. No-op
without a summary or when both sections are absent.

## Stage 4 — semantic retrieval reinjection (opt-in)

Eviction and summarization shrink the *sent* window, but the store always keeps
every message's **original** text. So a semantic search over the session's full
history can recover exactly what the lossy/lossless stages hid, when a later turn
needs it again. When `retrieval.enabled` (and an embedding model is configured),
`RetrievalReinjectionContext`
([context/retrieval.ts](../../apps/monad/src/agent/context/retrieval.ts)) embeds the
latest user message, `searchSemantic`-es this session's history (scoped by
transcript target — no cross-session leakage), and splices hits ≥ `minScore`
(capped at `maxResults`, pre-truncated snippets) into a `<related_context>` block
on the user turn. Runs once per turn (see [two phases](#two-assembly-phases));
no-ops silently when embedding is unavailable so a retrieval hiccup never fails a
turn.

## Memory promotion (opt-in)

A span about to be compacted away is the last chance to pull durable facts out of
its **original** text (the summary is already a paraphrase). When
`memoryPromotion.mode` is not `off`, `DurableSummarizer.afterCompact` hands the
folded transcript to `MemoryService.promoteFacts`
([services/memory/index.ts](../../apps/monad/src/services/memory/index.ts)), a
fast-model extraction of durable facts:

- **`suggest`** — emits a persisted `memory.suggestion` event; the user confirms
  via the web toast, which writes through the normal `addMemoryFact` path.
- **`auto`** — writes straight to the resolved scope (the session's agent, or
  `global` when it has none).

Both modes go through the same `sanitizeFact` chokepoint as the manual `memory`
tool ([memory.md](memory.md)) — no weaker validation on the auto path. Best-effort:
a failed extraction never affects the turn.

## Telemetry and UX

Four wire events surface what the cascade did (all data-plane, over per-session
SSE — see [realtime-channels.md](realtime-channels.md)):

| Event | Persisted? | Meaning |
|---|---|---|
| `context.usage` | no | Per-turn window breakdown by category, plus a `reclaimed` field (cumulative tokens freed by eviction — informational, **not** summed into `used`). |
| `context.evicted` | no (transient) | Eviction fired this step: `reclaimedTokens` + `resultCount`. |
| `context.handoff_suggested` | no (transient) | Window past `handoffNudge.atFraction` at a task boundary — offer a fresh session. |
| `memory.suggestion` | **yes** | Extracted facts awaiting user confirmation (must survive a reload). |

`context.evicted` / `context.handoff_suggested` are filtered from persistence in
[handlers/session/context.ts](../../apps/monad/src/handlers/session/context.ts)
alongside `agent.token` — transient notices, not history.

**Web.** The composer's context-usage panel shows the `reclaimed` line when > 0.
`useContextNotices` turns the handoff nudge into a toast and the memory suggestion
into a "remember these N things?" prompt with a Save action. `context.evicted` is
intentionally **not** toasted — it's routine housekeeping already visible in the
usage panel and would fire on nearly every turn once the window fills.

## Configuration

All under `context.*`; hot-reloaded. Fractions are of the active model's context
limit.

| Key | Default | Effect |
|---|---|---|
| `eviction.enabled` | `true` | Lossless tool-result eviction (Stage 1). |
| `eviction.atFraction` | `0.5` | Occupancy fraction that starts eviction. |
| `eviction.keepRecentRounds` | `3` | Most-recent tool rounds kept verbatim. |
| `eviction.clearAtLeast` | `2000` | Min tokens a pass must reclaim to fire. |
| `eviction.minResultTokens` | `200` | Skip results smaller than this. |
| `summarize.softFraction` | `0.6` | Background-compaction threshold (Stage 2). |
| `summarize.hardFraction` | `0.9` | Blocking-compaction + hard-truncate threshold. |
| `summarize.background` | `true` | `false` = compact synchronously at the soft threshold. |
| `toolOutput.maxChars` | `24000` | Per-result truncation cap fed to the model. |
| `toolOutput.persistRaw` | `true` | Spill full output for `read_tool_output` recovery. |
| `toolOutput.rawCapBytes` | `2000000` | Cap on a single spilled raw output. |
| `recitation.enabled` | `false` | `<plan>` anchor after compaction (Stage 3). |
| `memoryPromotion.mode` | `off` | `off` \| `suggest` \| `auto` — promote facts from compacted spans. |
| `handoffNudge.enabled` | `false` | Emit `context.handoff_suggested`. |
| `handoffNudge.atFraction` | `0.7` | Occupancy fraction that nudges. |
| `retrieval.enabled` | `false` | Semantic retrieval reinjection (Stage 4); needs an embedding model. |
| `retrieval.minScore` | `0.7` | Min cosine similarity to splice a hit. |
| `retrieval.maxResults` | `3` | Max hits spliced per turn (0 disables the stage). |

## Reverting to pre-cascade behavior

Each stage is independently disable-able:

- `eviction.enabled: false` drops the lossless stage (summarization then carries
  the full load).
- `summarize.background: false` makes compaction synchronous at the soft threshold.
- `toolOutput.persistRaw: false` disables recovery-by-handle (truncation still caps
  the model-visible result; `read_tool_output` is not registered).
- The opt-in stages (recitation, memory promotion, handoff nudge, retrieval) are
  off by default.
