# Member Resume Consistency Design

## Problem

Project membership, session membership, message authorship, and provider history currently drift independently:

- updating a project's member templates does not reconcile existing active sessions;
- removing a template can leave its stale session member and managed runtime active;
- message projection resolves an author only through the current project member catalog, so a removed member falls back to its internal `pmem_*` identifier;
- a resumed live runtime has an observation epoch before it has a provider checkpoint, while the UI requires both and therefore never requests its initial history page.

For `prj_Hp5QxIAdpCg8` / `ses_heN3EUtBUB8x`, these defects combine into one visible failure: the removed Fable member can still speak, Opus is not present to observe the session, Fable's historical message is shown as `pmem_claude-code_6c9b3c101028`, and a newly resumed member cannot bootstrap its history panel.

## Selected Semantics

Project membership is the desired roster for every active, non-archived session under that project.

- Adding a project template adds and starts the corresponding managed member in each active session.
- Editing a project template updates the data of the matching template-bound session member.
- Removing a project template stops and removes the matching template-bound session member.
- Ad-hoc session members whose `templateId` is null remain session-local and are never removed by project reconciliation.
- Completed or archived sessions retain their historical roster and are not restarted or rewritten.

Message authorship is immutable historical data. A message keeps its runtime member ID as `agentName` / author ID and stores a separate display-name snapshot. Removing or renaming a member never reattributes an old message to a different member.

## Architecture

### Active-session roster reconciliation

Introduce one daemon-owned reconciliation operation at the project lifecycle boundary. `updateProject` persists the new template catalog and then reconciles all sessions matching `projectId`, `state: active`, and `archived: false`.

For each session, it compares template-bound rows by `templateId`:

1. update retained rows from the latest template name, display name, type, and settings;
2. insert missing rows and invoke the existing managed-member spawn path;
3. before deleting removed rows, preserve their historical author display names, stop any linked external-agent runtime, and delete the row.

The existing explicit invite/remove endpoints use the same insert, snapshot, stop, and delete primitives. This keeps project-driven reconciliation and targeted session repair behavior identical. Managed-agent authentication or startup failure does not roll back the desired roster: the member remains invited, and existing lifecycle/error reporting explains why its runtime did not start.

### Immutable author display-name snapshots

Add optional `agentDisplayName` to the canonical agent message UI/event contract. Managed external-agent message creation persists both:

- `agentName`: stable runtime member ID, such as `pmem_claude-code_6c9b3c101028`;
- `agentDisplayName`: display name at authorship time, such as `Fable`.

The live event projector and persisted-message projector carry the snapshot into `UIMessageItem`. Chat projection prefers `item.agentDisplayName`, then falls back to the current member metadata map, then to the raw ID. This preserves compatibility with old records.

Before a template-bound member is deleted, a targeted store operation fills `agentDisplayName` only on that member's assistant messages that do not already have a snapshot. It never changes `agentName`, message text, ordering, or messages belonging to another author. This one-time compatibility backfill makes legacy messages survive roster removal with the correct label.

### Resumed history bootstrap

`observationHistoryLoadScope` will allow a live observation frame with an established `observationEpoch` even when `providerHistoryCheckpoint` is absent. The bootstrap scope is stable for that external-agent session and epoch. `AgentTasksRail` will permit the first history request under the same condition.

`findOlderObservationPage` already defines the required no-checkpoint behavior: request the provider's first page. `prependObservationHistory` already deduplicates canonical event IDs and provider identities, so the bootstrapped page can be merged with live events without duplicated turns. Once a checkpoint appears, the existing checkpoint-aware paging path remains unchanged.

## Data Flow

1. A client updates project member templates.
2. The daemon saves the project, enumerates only active non-archived project sessions, and reconciles template-bound member rows.
3. Removed members have legacy author snapshots filled, their runtime stopped, and their row deleted. Added members are inserted and started through the existing join path.
4. Managed-agent outputs persist and emit the stable member ID plus display-name snapshot.
5. UI projection renders the snapshot independent of the current project catalog.
6. On wake/resume, an epoch-only live observation frame requests the first provider history page and merges it with live items.

## Error and Concurrency Handling

- Reconciliation is daemon-owned so TCP, Unix-socket, web, CLI, and future clients share one behavior.
- Existing managed-runtime start deduplication remains the concurrency guard for simultaneous project updates and message fan-out.
- Reconciliation is idempotent by `sessionId + templateId`; repeating the same project update does not create duplicate members or runtimes.
- Runtime stop occurs before member deletion. A missing/stopped runtime is treated as already stopped.
- Snapshot backfill is additive and idempotent: existing `agentDisplayName` values are never overwritten.
- Project persistence remains authoritative even if a provider is unauthenticated; the existing connection-required event exposes that runtime condition.

## Verification

Tests will cover:

- active session add/update/remove reconciliation, ad-hoc member preservation, and completed/archived session exclusion;
- daemon project update behavior over TCP loopback and Unix socket;
- author snapshot persistence in managed messages and preservation when a member is removed;
- UI projection preference for historical `agentDisplayName` over current member metadata;
- live epoch history bootstrap without a checkpoint, checkpoint-aware paging, and merge deduplication;
- focused lint and typecheck for touched packages, followed by the repository quality gates required before merge.

## Local Repair and Acceptance

After merge and daemon deployment, create a recoverable SQLite backup and repair only `ses_heN3EUtBUB8x` through the deployed session-member APIs:

1. remove stale Fable member `pmem_claude-code_6c9b3c101028`, which also snapshots legacy Fable messages and ensures its runtime is stopped;
2. invite Opus member `pmem_claude-code_f2654d392ff2` from the current project template;
3. wake or start Opus through the normal managed-member flow;
4. verify the roster contains GPT and Opus, no live Fable runtime remains, `msg_yZF8ijIQJbaN` renders as Fable, a new Opus message renders as Opus, and Opus can load the session projection and provider history.

No historical author ID will be rewritten from Fable to Opus.
