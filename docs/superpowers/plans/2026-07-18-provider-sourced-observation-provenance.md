# Provider-Sourced Observation Provenance Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every observable external-agent item traceable to real provider output, recover active output losslessly from an ephemeral SQLite store, and rebuild stopped-session observation only from an available native provider session.

**Architecture:** Provider frames are committed synchronously to a per-runtime temporary SQLite database before publication. Contract events carry non-empty raw-event provenance, UI entries carry non-empty contract-event provenance, and neither projection layer is persisted. Active history reads committed live rows; stopped history reads the provider; chat records remain the only independent durable transcript. Runtime teardown deletes its live database and daemon startup removes stale databases without exposing them.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, Zod, React, RTK Query, Bun test, Drizzle migrations.

---

## Task 1: Make provenance a required contract invariant

**Files:**
- Modify: `packages/protocol/src/external-agent/external-agent-observation.ts`
- Modify: `packages/protocol/src/agent-observation.ts`
- Modify: `packages/sdk-atom/src/agent-adapter.ts`
- Modify: `packages/atoms/src/agent-adapters/neutral-observation.ts`
- Modify: provider projectors under `packages/atoms/src/agent-adapters/`
- Test: `packages/protocol/test/external-agent-observation.test.ts`
- Test: `packages/atoms/test/agent-adapters/neutral-observation.test.ts`
- Test: `apps/monad/test/unit/external-agent-adapters.test.ts`

1. Add failing schema tests proving an external event without at least one raw source is rejected and one with one or more raw sources round-trips exactly.
2. Add failing neutral-projection tests proving provenance copies all source records exactly and never fabricates a replacement record.
3. Run the focused tests and confirm RED.
4. Define a shared schema-first provenance shape containing a non-empty `rawEvents` array; require it on external and neutral observation events.
5. Update provider record projectors and streaming-run mergers so merged events concatenate the exact source records in source order.
6. Remove the old optional `raw` contract escape hatch after all producers use provenance.
7. Run focused protocol and adapter tests and confirm GREEN.
8. Commit only Task 1 changes.

## Task 2: Add a lossless ephemeral live raw store

**Files:**
- Create: `apps/monad/src/services/external-agent/live-raw-store.ts`
- Create: `apps/monad/test/unit/external-agent-live-raw-store.test.ts`
- Create: `apps/monad/test/performance/external-agent-live-raw-store.bench.ts`
- Modify: `apps/monad/src/services/external-agent/host/host-types.ts`

1. Add failing tests for ordered append/read, byte-exact payload preservation, independent stdout/stderr/app-server streams, reverse paging, epoch-bound cursors, close-and-delete, stale-directory cleanup, and a write failure that never advances the observable sequence.
2. Run the focused store test and confirm RED because the store does not exist.
3. Implement one dedicated SQLite database per live runtime using prepared statements and WAL-safe durability settings appropriate for a temporary recovery source.
4. Store monotonically increasing row sequence, stream, exact payload bytes/text, and observed timestamp; never store projected events.
5. Implement cursor parsing that rejects another runtime epoch and bounded page reads that do not materialize the whole session.
6. Implement idempotent close/delete and asynchronous startup cleanup of stale files that are never opened for observation.
7. Benchmark direct SQLite append/latest-page/page-before operations with representative payloads and record results in the benchmark output; do not add a raw read cache unless measurements demonstrate the need.
8. Run focused tests and benchmark; confirm GREEN and bounded-memory behavior.
9. Commit only Task 2 changes.

## Task 3: Commit output before it becomes observable

**Files:**
- Modify: `apps/monad/src/services/external-agent/host/output-pipeline.ts`
- Modify: `apps/monad/src/services/external-agent/host/session-launcher.ts`
- Modify: `apps/monad/src/services/external-agent/host/host-types.ts`
- Modify: `apps/monad/src/services/external-agent/host/index.ts`
- Modify: `apps/monad/src/handlers/daemon-handlers/index.ts`
- Test: `apps/monad/test/unit/external-agent-host.test.ts`
- Test: `apps/monad/test/unit/external-agent-output-pipeline.test.ts`

1. Add failing tests showing output is absent from observation and event publication until its SQLite append resolves, append failure stops/fails the runtime without publishing the frame, and concurrent stream frames preserve commit order.
2. Add failing lifecycle tests proving intentional stop, child exit, idle transport suspension, and daemon shutdown close/delete the live store; resume creates a new epoch/store.
3. Run focused tests and confirm RED.
4. Make the output path asynchronous and serialized per live runtime; await the live-store append before observation publication, daemon output publication, structured side effects, or UI projection.
5. Keep only bounded decoder/partial-line/backpressure state in memory; reject an over-limit unterminated structured record instead of silently truncating it.
6. On any store write failure, stop accepting provider output, terminate the affected runtime, emit a durable diagnostic through normal daemon logging, and do not publish the uncommitted frame.
7. Wire the runtime directory into the host, create a store for every native-runtime epoch, and clean it on every disconnect path.
8. Remove snapshot flush timers, `BoundedOutputBuffer`, and all in-memory raw snapshot authority.
9. Run focused lifecycle/output tests and confirm GREEN.
10. Commit only Task 3 changes.

## Task 4: Read active observation and history from the committed live store

**Files:**
- Modify: `apps/monad/src/services/external-agent/host/observation-resolve.ts`
- Modify: `apps/monad/src/services/external-agent/host/history-cursor.ts`
- Modify: `apps/monad/src/services/external-agent/host/index.ts`
- Modify: `packages/protocol/src/external-agent/external-agent-observation.ts`
- Modify: `packages/client-rtk/src/endpoints/external-agent/get-external-agent-history-page.ts`
- Modify: `packages/client-rtk/src/endpoints/external-agent/stream-external-agent-ui-observation.ts`
- Test: `apps/monad/test/unit/external-agent-history-cursor.test.ts`
- Test: `apps/monad/test/unit/external-agent-host.test.ts`
- Test: `packages/client-rtk/test/external-agent-observation.test.ts`

1. Add failing tests for refresh during an active native session, latest bounded window loading, older live-page loading, exact event ordering, cursor epoch rejection after runtime replacement, and no full-session materialization.
2. Add a failing regression test where a tool call/result or thinking run crosses a raw page boundary and still becomes one logical UI sequence after page merge.
3. Run focused tests and confirm RED.
4. Replace character-offset snapshot cursors with explicit `live:<epoch>:<row-sequence>` cursors and keep provider cursors namespaced separately.
5. Resolve active raw observation exclusively from committed live rows. Provider history may supplement gaps only when it can prove source identity and must never replace or bypass live capture.
6. Project bounded raw pages on demand. Include sufficient boundary overlap and stable provenance-derived identity for the client to merge cross-page groups without invented events or duplicate cards.
7. Return only a bounded latest window from observe/observe-ui; use history paging for older rows so refresh and long sessions remain bounded.
8. Update RTK merging so pages and stream updates deduplicate by provenance-derived identity while preserving source order.
9. Run focused host/client tests and confirm GREEN.
10. Commit only Task 4 changes.

## Task 5: Make stopped-session observation provider-only

**Files:**
- Modify: `apps/monad/src/services/external-agent/host/observation-resolve.ts`
- Modify: `apps/monad/src/services/external-agent/host/index.ts`
- Modify: `packages/atoms/src/agent-adapters/claude-code/index.ts`
- Test: `apps/monad/test/unit/claude-history-page.test.ts`
- Test: `apps/monad/test/unit/external-agent-host.test.ts`

1. Add failing tests proving a stopped session with readable provider history reconstructs observation, while a missing/deleted/unreadable native session returns the explicit unavailable state and never falls back to Monad-stored output.
2. Add a failing Claude test proving `getSessionInfo()` does not generate a synthetic `system:init` event and every returned contract event maps to one or more actual session messages/raw records.
3. Add tests documenting that Claude SDK messages are conversation history only; raw JSONL is preferred for observation fidelity when available.
4. Run focused tests and confirm RED.
5. Remove stored snapshot/journal fallback from stopped observation/history.
6. Remove synthesized Claude init records and treat direct provider JSONL reads as best-effort unless the adapter declares a stronger provider contract.
7. Return explicit provider/native-session unavailable errors rather than empty or misleading observation cards.
8. Run focused tests and confirm GREEN.
9. Commit only Task 5 changes.

## Task 6: Remove durable observation storage

**Files:**
- Modify: `apps/monad/src/store/db/schema.ts`
- Modify: `apps/monad/src/store/db/external-agent-sessions.ts`
- Delete: `apps/monad/src/store/db/external-agent-observations.ts`
- Modify: `apps/monad/src/store/db/index.ts`
- Modify: `packages/protocol/src/external-agent/external-agent-session.ts`
- Generate: `apps/monad/src/store/db/migrations/`
- Test: `apps/monad/test/unit/store/external-agent-sessions.test.ts`
- Test: `apps/monad/test/unit/store/migrations.test.ts`
- Test: `apps/monad/test/unit/store/migration-drift.test.ts`

1. Change store tests first so the exact session contract contains only the native-session mapping and durable session metadata, not output snapshots or observation journals.
2. Add migration tests proving existing databases drop `external_agent_observation_events` and `external_agent_sessions.output_snapshot` without losing the Monad-session to provider-session reference.
3. Run focused store/migration tests and confirm RED.
4. Delete journal APIs and snapshot append/set APIs from the runtime store and protocol session view.
5. Remove the journal table and snapshot column from the schema.
6. Generate and bundle the Drizzle migration with the repository scripts; inspect the generated SQL for preservation of mapping rows.
7. Run migration drift and focused store tests and confirm GREEN.
8. Search for all removed symbols and prove no runtime fallback remains.
9. Commit only Task 6 changes.

## Task 7: Derive UI raw JSON only from contract provenance

**Files:**
- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/observation/types.ts`
- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/observation/timeline.tsx`
- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/observation/card-shell.tsx`
- Test: observation component tests under `packages/atoms/test/workspace-experiences/chat-room/`

1. Add failing UI tests proving one UI card carries one or more exact contract events, its raw JSON panel renders the concatenated raw provenance in source order, and a card without contract provenance cannot be constructed/rendered as valid projection data.
2. Add regressions for paired shell input/output, multiple raw records in one observation card, and merged thinking-token cards.
3. Run focused component tests and confirm RED.
4. Replace timeline `raw` fields with non-empty `contractEvents` provenance.
5. Derive raw JSON exclusively by flattening `contractEvents[].provenance.rawEvents`; format and syntax-highlight each real raw record without fabricating wrappers.
6. Preserve stable identities from contract provenance so streaming and history pages merge deterministically.
7. Run focused UI tests and confirm GREEN.
8. Commit only Task 7 changes, excluding the pre-existing virtual-list worktree changes.

## Task 8: Verify the complete behavior and integration boundary

**Files:**
- Test: applicable external-agent transport/e2e tests in `apps/monad/test/`
- Verify: all files changed by Tasks 1-7

1. Run the external-agent unit scopes once to completion and fix the collected failures as one batch.
2. Run transport coverage over TCP loopback and Unix socket for active refresh, stopped provider rebuild, and unavailable native session behavior.
3. Run `bun run check:test-assertions` and audit every modified test for exact user-visible assertions.
4. Run `bun run lint`, `bun run typecheck`, and `bun run test` from `main` once each to completion.
5. Separate any unrelated pre-existing failures from changed-path failures with exact command output; do not claim success without fresh passing evidence for every changed path.
6. Inspect `git diff --check`, the final diff, and `git status --short`; confirm unrelated virtual-list changes are untouched and uncommitted.
7. Commit any final integration fixes in a scoped commit and report the benchmark plus verification results.
