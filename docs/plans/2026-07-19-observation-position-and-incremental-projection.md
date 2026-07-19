# Observation Position and Incremental Projection

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **This plan does not add capability.** It closes the dual-stream migration's position contract.

**Goal:** Make "where a consumer is" a single, typed, server-owned concept across both observation
planes, and make the convenience plane a genuinely incremental projection driven by that position.

**Supersedes** the separately-tracked items "fix false resume", "make convenience incremental", and
the cursor half of "delete the output snapshot contract". They are one defect; see below.

**Source design:** [`2026-07-18-chat-experience-realtime-planes-design.md`](./2026-07-18-chat-experience-realtime-planes-design.md).
Where this plan and that design disagree, the design wins.

---

## Why these are one defect, not three

`cursor` is declared `z.string().min(1)` and has no owner
([`external-agent-observation-dual.ts:19,59,65`](../../packages/protocol/src/external-agent/external-agent-observation-dual.ts)).
Six different representations of position exist over one `LiveRawStore`:

| Producer | Grammar | What it actually is |
|---|---|---|
| raw live frame ([`observation-dual.ts:24`](../../apps/monad/src/services/external-agent/host/observation-dual.ts)) | `String(row.seq)` | row sequence, **no epoch** |
| raw resume read-back ([`host/index.ts:97`](../../apps/monad/src/services/external-agent/host/index.ts)) | `Number(last.cursor)` | inverse assumption of the above |
| convenience upsert ([`observation-dual.ts:41`](../../apps/monad/src/services/external-agent/host/observation-dual.ts)) | `event.id` | **projection identity, not a position** |
| `historyBefore` ([`observation-resolve.ts:168`](../../apps/monad/src/services/external-agent/host/observation-resolve.ts)) | `live:<epoch>:<seq>` | position |
| history paging ([`history-cursor.ts`](../../apps/monad/src/services/external-agent/host/history-cursor.ts)) | `snapshot:` / `journal:` | transitional projected-reader offset / dead journal grammar |
| history paging | `provider:` | provider-native position |

Consequences, each previously filed as its own item:

1. **Resume is advertised but absent.** The client engine already threads the last position back as
   *both* the `last-event-id` header and `?after=`
   ([`client/src/index.ts:446-448`](../../packages/client/src/index.ts)) and both streams set
   `resume: true` ([`:312`, `:337`](../../packages/client/src/index.ts)). No stream route reads
   either ([`transports/http/external-agent.ts:294-312`](../../apps/monad/src/transports/http/external-agent.ts)),
   and `subscribeRawObservation` takes no resume argument. Reconnect silently replays from the epoch
   start. A bare `seq` could not express resume correctly anyway: sequences restart at 1 on every
   epoch rotation, so an epoch-less cursor cannot distinguish "after row 42 of this epoch" from
   "row 42 of a rotated one".
2. **Convenience cannot be incremental — this is caused by (1), not independent.** With
   `cursor = event.id` the server has no way to say "everything after here", so every hub tick reads
   the whole 256 KB snapshot, re-runs `projectLive()`, and re-emits every event as an upsert
   ([`observation-resolve.ts:150-180`](../../apps/monad/src/services/external-agent/host/observation-resolve.ts),
   [`host/index.ts:695-711`](../../apps/monad/src/services/external-agent/host/index.ts)). The cost
   grows with session length. Fixing the projector without fixing the cursor is not possible.
3. **The planes cannot be joined.** Raw, convenience, and `historyBefore` positions live in three
   grammars, so a client cannot align a convenience frame with the raw frame it came from — despite
   the design's rule that convenience *is* a projection of the same committed raw frame.

---

## Decision: batching (the question this plan had to answer first)

One raw position can produce more than one convenience operation. If several SSE frames share a
cursor, a client that disconnects mid-batch resumes at `> seq` and **silently drops the rest of that
batch**. Two candidate fixes:

| Option | Shape | Verdict |
|---|---|---|
| **Atomic patch** | one frame per raw position: `{ cursor, operations: [...] }` | **Chosen** |
| Per-operation frame + ordinal | `live:<epoch>:<seq>:<opIndex>` | Rejected |

**Why the ordinal is rejected:** it makes the resume position depend on *projector implementation*
rather than on committed data. `opIndex` is only meaningful under the exact projection logic that
produced it; any change to merge/dedupe rules silently re-numbers the operations a given raw row
yields, so cursors held by in-flight clients (or persisted by a panel across a reload) start pointing
at a different operation. A raw row sequence is committed data and has no such coupling. The ordinal
also re-mixes delivery structure back into the position, which is the exact conflation this plan
exists to remove.

**Atomic patch semantics:**

- **The SSE frame is the atomic unit.** SSE never splits a frame, so a patch is delivered whole or
  not at all. There is no partial-batch state to resume into.
- **`patch.cursor` is the highest raw position whose consumption is fully reflected in the patch.**
  Consuming rows that yield no operations emits no frame; the next patch's cursor covers them. A
  client resuming from its last received cursor therefore re-consumes only rows it has not seen
  applied.
- **Operations are ordered within the patch** and applied in order.
- **A convenience patch's cursor is the same value as the raw frame's cursor for that position**, so
  the two planes are exactly joinable — the design's stated intent.
- **Operations stay idempotent by `event.id`**, so a replay (stale epoch, retained-state miss) is
  safe to re-apply.

---

## Boundaries this plan pins down

1. **`ObservationCursor` is a protocol schema + codec.** No surface takes or returns a bare `string`
   for a position. One producer in `@monad/protocol`; every consumer imports it.
2. **`event.id` is projection-entity identity; `cursor` is acquisition/delivery position.** Neither
   is ever derived from the other. This is a *rendering* invariant too, not only a wire one:

   ```text
   patch.cursor advances the consumption position, nothing else.
   event.id / row.id are React and VirtualList identity.
   A cursor MUST NOT be used as a row key.
   ```

   The observation list is virtualized and keys rows through `getKey`
   ([`panel.tsx:545`](../../packages/atoms/src/workspace-experiences/chat-room/components/observation/panel.tsx),
   feeding the virtualizer's `getItemKey` in
   [`VirtualList.tsx`](../../packages/ui/src/components/VirtualList.tsx)), which is what preserves row
   measurement and the scroll anchor across set changes. It currently keys on `observationRowId` —
   correct, and it must stay that way. Keying on `patch.cursor` would collide for every patch that
   carries more than one operation, which is precisely the shape this plan introduces.
3. **Live and provider-history positions are one union type, validated per use site.** `after`
   (live subscribe) accepts only the `live:` variant; `before` (history paging) accepts `provider:`
   plus the transitional `snapshot:` variant. A wrong-variant or corrupt value degrades to "no position" — it must not
   400 a reconnect, and must never be forwarded to a provider as an opaque token.
4. **Stale epoch is decided once, server-side, at the codec/resolve boundary**, and the client's
   recovery is defined, not retried: the server replays the current epoch beginning with a `ready`
   frame carrying the new `observationEpoch`. **`ready` must itself carry an SSE `id:`.** Without
   that, the client's engine keeps its stale `afterEventId` and re-sends the dead cursor on every
   reconnect forever — this is the concrete infinite-retry hole, and the `id:` on `ready` is what
   closes it.
5. **Both planes write `id:`; the server accepts `Last-Event-ID` and `?after=`; the header wins.**
   Reason: a native `EventSource` replays its *original* URL on reconnect, so a `?after=` in that URL
   is frozen at subscribe time while the header is current. Header-wins is the only priority under
   which a browser reconnect makes forward progress. `?after=` remains the explicit override for
   callers that cannot set headers.
6. **The projector advances by raw position.** Cursor unification is a precondition, not the whole
   fix: the host keeps per-epoch projector state, and must retain a deterministic replay-from-store
   path for a resume position older than the retained state. Projection failure isolates to the
   convenience plane; raw delivery is unaffected.
7. **`journal:` is deleted; `snapshot:` remains an explicit transitional codec variant.** The active
   projected `readPage()` acquisition chain still emits offsets, and deleting its cursor without also
   collapsing acquisition would either break paging or disguise the offset as a provider token.
   `snapshot:` is removed with that acquisition chain in the follow-on; `historyBefore` moves onto the
   shared codec now.
8. **Two existing assertions are inverted, not preserved** — see Task 6.
9. **Every behavior is proven over TCP loopback and the Unix socket.** SSE `id:`/header/query framing
   is HTTP-specific and tested separately from the shared domain handler.
10. **Not every position-shaped string is a position.** The panel's history bootstrap keys its
    in-flight request with the literal `'disconnected:latest'`
    ([`observation-panel-orchestration.ts:91`](../../packages/atoms/src/workspace-experiences/chat-room/components/observation/observation-panel-orchestration.ts)),
    paired with a request whose `before` is *omitted*. That string is a **request-dedup key**, not a
    cursor: it must never be typed as `ObservationCursor`, parsed by the codec, or sent as `before`.
    The contract is:
    - an absent `before` is the legal, explicit spelling of "start from the latest page";
    - only a provider-supplied `nextCursor` ever enters the typed codec as `before`;
    - client-side dedup/identity keys stay a separate, untyped concern.

    Codec `parse` degrading an unknown string to "no position" (boundary 3) is what keeps a sentinel
    that *looks* prefixed from being silently accepted as one.

---

## Task 1: The position contract

**Files:** new `packages/protocol/src/external-agent/observation-cursor.ts`; barrel
`packages/protocol/src/external-agent/index.ts`; test
`packages/protocol/test/observation-cursor.test.ts`.

Grammar (epoch percent-encoded so the separators stay unambiguous):

```
live:<observationEpoch>:<seq>     a row in that epoch's live raw store
provider:<token>                  an adapter-native provider-history position
snapshot:<token>                  transitional projected readPage() offset
```

- [ ] Add failing tests: round-trip both variants; a token containing `:`; an epoch containing `:`;
      corrupt/foreign values degrade to no position; `after` accepts only `live:`; `before` accepts
      only `provider:`; the stale-epoch resolution returns "restart epoch" for a rotated epoch, a
      provider variant, and an absent or corrupt value.
- [ ] Implement the type, schema, `format`/`parse`, the two use-site schemas (`after`, `before`), and
      a single `observationResume(cursor, currentEpoch)` that is the *only* place the stale rule is
      decided — so the raw and convenience planes cannot drift into different answers. `before`
      accepts `provider:` plus the transitional `snapshot:` variant until raw acquisition is unified.

## Task 2: Frame contracts

**Files:** `packages/protocol/src/external-agent/external-agent-observation-dual.ts`; its test.

- [ ] Replace `cursor: z.string()` with the codec type on the raw frame.
- [ ] Replace the per-operation convenience `upsert`/`remove` frames with the atomic patch:
      `{ kind: 'patch', cursor, operations: Array<{ op: 'upsert', event } | { op: 'remove', eventId }> }`.
      `operations` is non-empty (a patch with nothing to apply is never emitted).
- [ ] Add `cursor` to the `ready` frame — the resume anchor a client holds before any patch arrives.
- [ ] Exact `toEqual` contract tests for each frame shape; a patch with an empty `operations` array
      must fail to parse.

## Task 3: Host — resume and the incremental projector

**Files:** `host/index.ts`, `observation-resolve.ts`, `observation-dual.ts`, `observation-hub.ts`,
`live-raw-store.ts`; host/resolver/live-raw-store unit suites.

- [ ] Add failing tests: raw subscribe resumes strictly after a same-epoch cursor and replays the
      epoch for a rotated one; the projector consumes only rows after its last position; a patch's
      cursor equals the highest raw position it reflects; a projection throw omits only the
      convenience patch while raw delivery continues; a resume older than retained projector state
      falls back to deterministic replay and produces the same event set.
- [ ] Thread a resume position into `subscribeRawObservation` / `subscribeConvenienceObservation`.
- [ ] Add `createLiveProjector({ id }) -> { advance(delta) }` to the adapter event-source contract.
      Replace whole-snapshot re-projection with per-epoch projector state advanced by raw position,
      emitting patches diffed against the previous event set (`upsert` on new/changed by `event.id`,
      `remove` on disappearance). Built-in Codex and Claude projectors must prove prefix-by-prefix
      equivalence against `projectLive()` using the captured real-provider fixtures.
- [ ] Delete `lastRawSeq`'s `Number(cursor)` inverse assumption; positions are parsed by the codec.

## Task 4: Transport — routes, framing, and parity

**Files:** `transports/http/external-agent.ts`, `handlers/external-agent/index.ts`,
`transports/jsonrpc/methods.ts`, `packages/protocol/src/rpc/method-table.ts`.

- [ ] Add failing tests: `Last-Event-ID` honoured; `?after=` honoured; **both present and
      conflicting → header wins**; corrupt cursor replays rather than 400s; convenience frames carry
      an SSE `id:`; `ready` carries an SSE `id:`; disconnecting after `ready` but before its bootstrap
      patch resumes from the ready baseline and still receives that patch.
- [ ] Read the resume position on both stream routes and pass it through the handler.
- [ ] Emit `id:` on every convenience frame including `ready`.
- [ ] Prove the JSON-RPC/Unix control transport exposes the same subscribe/resume semantics against
      the shared domain handler; HTTP SSE framing is asserted separately (boundary 9).

## Task 5: Client, RTK, and panel — apply a patch as one commit

The frame contract change stops at the transport without this task. The consumers are:
`packages/client/src/index.ts`, `packages/client-rtk/.../stream-external-agent-convenience.ts`,
[`timeline-merge.ts`](../../packages/atoms/src/workspace-experiences/chat-room/components/observation/timeline-merge.ts),
[`use-observation-panel.ts`](../../packages/atoms/src/workspace-experiences/chat-room/components/observation/use-observation-panel.ts),
and their unit suites.

`mergeConvenienceFrame` currently folds one `ready`/`upsert`/`remove` at a time, and every `upsert`
allocates a fresh `events` array. Under the atomic patch, folding operation-by-operation through a
state setter would turn one wire frame into N array allocations and N React commits — re-introducing
per-operation cost at the render layer immediately after removing it at the projection layer.

- [ ] Add failing tests: a patch carrying an insert, an in-place replace, and a remove yields **one**
      resulting event array and **one** subscriber notification; operations apply in array order; a
      patch replayed after a stale-epoch reset is idempotent by `event.id`; the reducer never keys
      anything by `patch.cursor`.
- [ ] Reduce a whole patch in a single call: apply all `operations` against one working copy, emit
      one new timeline. Keep `ready`/`unavailable` handling as-is.
- [ ] Thread the resume position through the client stream method and the RTK endpoint; the panel
      keeps the last received cursor as its resume anchor (including the one on `ready`).
- [ ] Confirm the SSE lifecycle stays owned by the parent controller
      ([`use-observation-panel.ts:130`](../../packages/atoms/src/workspace-experiences/chat-room/components/observation/use-observation-panel.ts)):
      a detail/summary toggle mounts or unmounts the `VirtualList`, and must not tear down the
      subscription or reset the resume anchor. The raw view stays on the non-virtualized
      [`raw-observation-list.tsx`](../../packages/atoms/src/workspace-experiences/chat-room/components/observation/raw-observation-list.tsx)
      and is unaffected.

## Task 6: Retire the dead position grammar

**Files:** `history-cursor.ts`, `observation-resolve.ts`, history-backfill/pagination call sites.

- [ ] Delete `journal:`; move `provider:`, transitional `snapshot:`, and `historyBefore` onto the codec.
- [ ] `rg` proves no remaining producer or consumer of the removed prefixes, and no bare-`string`
      position on any observation surface.

## Task 7: Invert the assertions that pinned the defect

The existing suite passes today *because* two assertions encode the defect as the specification.
This is why "66 pass" did not catch the missing resume.

- [ ] [`external-agent-observation-dual.test.ts:343`](../../apps/monad/test/e2e/external-agent-observation-dual.test.ts)
      `expect(upsert?.cursor).toBe(upsert?.event.id)` — asserts cursor *is* the projection identity.
      Invert to: the patch cursor equals the raw frame cursor for the same position, and is not
      derived from any `event.id`.
- [ ] [`external-agent-observation-dual.test.ts:314`](../../apps/monad/test/e2e/external-agent-observation-dual.test.ts)
      `expect(typeof ready?.cursor).toBe('string')` — a weak assertion of the kind
      [`testing.md`](../engineering/testing.md) bans (if it flipped, it would catch no user-visible
      bug). Replace with an exact parse to `{ kind: 'live', observationEpoch, seq }`.
- [ ] Add the three regression classes, each over **both** transports:
      1. **Same-epoch resume** — reconnect after a cursor delivers only later positions and does not
         re-deliver the opening frames.
      2. **Stale epoch** — a cursor from a rotated epoch replays the current epoch exactly once,
         beginning with a `ready` that carries the new epoch *and* an SSE `id:`, and the client's
         next reconnect uses the new cursor (proving no infinite retry of the dead one).
      3. **Multi-operation batch** — a raw frame that projects to several operations, disconnected
         mid-stream, loses nothing on resume: the operation set after replay equals the
         never-disconnected set.
- [ ] Add one observation-specific UI/E2E prepend-anchoring case. The generic virtual-list suite
      already covers plain prepend ([`virtual-list-follow.spec.ts:157`](../../apps/web/test/e2e/virtual-list-follow.spec.ts)),
      but observation additionally re-groups adjacent tool events into `tool-group:*` rows
      ([`timeline.tsx:501`](../../packages/atoms/src/workspace-experiences/chat-room/components/observation/timeline.tsx)),
      so a prepend can *merge into* the existing first row rather than only inserting above it —
      a row-identity change the generic case never exercises. Assert: user scrolled away from the
      bottom → provider history prepended → the prepended history tool-group-merges with the current
      first row → the top visible row and its pixel offset are preserved → a subsequent live patch
      does **not** force a jump back to the bottom.

## Task 8: Verification

- [ ] `bun run lint`, `bun run typecheck`, `bun run test` once each; collect the whole failure
      surface, fix as one batch, re-run each scope once.
- [ ] Confirm no observation surface accepts or emits a bare-`string` position, and that the stale
      rule appears in exactly one place in the codebase.

---

## Follow-on, explicitly out of scope here

Single raw acquisition chain (delete the projected `readPage()` and then the transitional
`snapshot:` cursor), legacy `ui-observation` removal, the remaining non-cursor half of the
output-snapshot contract, the SessionId-only collapse, and the
`host/index.ts` / `agent-tasks-rail.tsx` splits. The file splits in particular are cheaper *after*
this plan lands: the observation-epoch and subscription seams only become visible once position
ownership is settled.
