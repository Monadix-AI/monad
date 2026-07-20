# Managed MeshAgent Instruction Delivery Design

Date: 2026-07-20
Status: approved

## Summary

Starting a managed native agent requires two semantically different inputs:

- immutable instructions: the long-lived Monad bridge contract, project and agent identity, and custom guidance;
- mutable input: the first project message and its attachments.

The generic runtime contract passes both inputs to the provider adapter together when it starts the native agent. It does not classify the immutable value as a developer instruction, system prompt, prompt file, user-message prefix, or compaction concern.

The adapter owns all provider-specific behavior:

- use a developer-instruction or equivalent native instruction channel when available;
- otherwise include the immutable instructions in the first user input;
- detect provider context compaction when the provider exposes a reliable signal;
- after compaction, include the immutable instructions in the next user input exactly once;
- restore any adapter state needed when resuming a native provider session.

Compaction and reinjection are adapter implementation details. They are not SDK capabilities, daemon state, Mesh events, or public protocol concepts.

## Goals

- Pass immutable instructions and the initial mutable turn together at native-agent startup.
- Remove provider-specific `systemPromptFile` and `developerInstructions` selection from the generic launcher.
- Prevent long managed prompts from appearing repeatedly in ordinary provider user turns.
- Preserve managed instructions through provider-native compaction using the best mechanism available to each adapter.
- Preserve the existing cold-start recovery behavior when a native provider session cannot be resumed.
- Provide equivalent behavior for Codex, Claude Code, Gemini CLI, and Qwen Code.
- Keep valid native-session reacquisition invisible to the project transcript.

## Non-goals

- Add instruction-delivery modes or compaction capabilities to `@monad/protocol` or `@monad/sdk-atom`.
- Normalize provider compaction events in the daemon.
- Make the daemon track whether immutable instructions need reinjection.
- Expose instruction delivery or compaction state in the UI.
- Install or modify provider-global hook configuration from generic runtime code.
- Infer a universal compaction lifecycle across providers.
- Treat per-turn process exit as Monad releasing native-session ownership.
- Restore the removed idle ownership-release timer in this change.

## Current problem

`MeshAgentSessionRuntimeContext` currently contains the provider-shaped fields `systemPromptFile` and `developerInstructions`. The managed runtime launcher checks adapter flags and selects one representation before calling `createSessionRuntime`.

Codex then concatenates `developerInstructions` with every encoded user turn. Consequently, the native Codex transcript contains the same long managed prompt before every project message. This is adapter-produced data, not a UI rendering duplication.

Claude Code, Gemini, and Qwen already receive managed guidance through provider launch configuration, but the generic launcher still knows which representation each adapter expects. The abstraction boundary should instead be one immutable value plus the initial mutable turn, leaving delivery semantics inside the adapter.

## Generic contract

The managed runtime materializes one provider-neutral immutable instruction value:

```ts
interface MeshAgentImmutableInstructions {
  text: string;
  file: string;
}
```

`text` and `file` represent the same trusted content. Supplying both lets an adapter use either an inline native instruction parameter or a native prompt-file option without making that choice part of the generic launcher.

Native-agent startup receives the initial mutable turn in the same operation:

```ts
interface MeshAgentSessionStartInput {
  immutableInstructions?: MeshAgentImmutableInstructions;
  initialTurn: MeshAgentTurnInput;
}

interface MeshAgentSessionRuntimeContext {
  workingPath: string;
  providerSessionRef?: string;
  startInput?: MeshAgentSessionStartInput;
  // existing execution, model, environment, and MCP fields
}
```

The exact final type placement may follow existing SDK ownership, but the semantic contract is fixed:

1. `MeshAgentHost.start` receives the immutable instructions and first mutable turn atomically;
2. `createSessionRuntime` receives both before it creates the provider plan and driver;
3. subsequent `MeshAgentHost.input` calls contain only mutable turns;
4. generic daemon code never concatenates immutable and mutable content.

An unmanaged MeshAgent may still start without an initial turn. A managed-project cold start or resume always supplies `startInput`, including immutable instructions and the triggering mutable turn.

The immutable instructions contain stable project and member identity only. `meshSessionId` is an ephemeral Monad runtime binding and is supplied through `MONAD_MESH_SESSION_ID` and `runtime_info`; it is not rendered into the immutable prompt.

## Adapter-owned delivery

An adapter implements one of two internal strategies. These strategies are not represented by a shared enum or capability flag.

### Native instruction strategy

When the provider supports developer instructions, system instructions, or an equivalent provider-owned channel, the adapter uses that channel exclusively.

The immutable value is never copied into a user message. The adapter does not need to observe compaction because the provider's native instruction mechanism owns persistence across context compression.

For a per-turn CLI provider, the adapter may pass the same native instruction option again when launching a process that resumes the provider session only when the provider requires process-local configuration. This must configure the native instruction channel and must not add a repeated user-history item.

### User-message fallback strategy

An adapter without an equivalent native instruction channel combines immutable instructions with mutable user content internally:

- once for the first turn of a newly created native provider session;
- never for an ordinary subsequent turn;
- never merely because Monad resumes an existing native provider session;
- once on the first turn after that adapter reliably determines that provider compaction completed.

The adapter owns its compaction parser, hook integration, transcript inspection, and reinjection state. It must not require the generic runtime to understand provider event names or compaction semantics.

If the provider can compact while Monad is disconnected, the adapter is responsible for recovering enough provider-native state on resume to decide whether reinjection is needed. If it cannot make that determination reliably, it cannot claim a correct managed-runtime fallback implementation.

## Provider mappings

### Codex

Codex uses native developer instructions. On a new native session, the adapter sends the immutable text through `developer_instructions` and sends only `initialTurn` as user input. On resume and all later turns, user input remains mutable-only.

Codex exposes structured context-compaction events through app-server, but the adapter does not need them for instruction delivery because developer instructions remain part of Codex's instruction context.

### Claude Code

Claude Code uses its native appended system-prompt file mechanism. Per-turn CLI invocations may continue supplying that file option on resume because it configures the process rather than adding a user message. Claude reloads instruction files after compaction, so the adapter does not need custom reinjection.

### Gemini CLI

Gemini uses its additive hierarchical context mechanism. The managed instruction file is exposed as managed `GEMINI.md` context through the adapter's included workspace, preserving Gemini's built-in system instructions. The adapter no longer sets `GEMINI_SYSTEM_MD`, which is a full replacement.

The adapter does not use `PreCompress` for correctness because it runs before compression and does not prove compression completed. Gemini reloads the additive context for each CLI invocation, so no fallback reinjection state is required.

### Qwen Code

Qwen uses its native append-system-prompt mechanism. Its compact hooks may remain an adapter-internal diagnostic source, but they are unnecessary for instruction reinjection.

## Startup, resume, and recovery

For a new native provider session:

1. the daemon passes immutable instructions and the first mutable turn together to the adapter;
2. the adapter builds the provider launch and first input using its internal strategy;
3. the provider session reference is persisted when identified.

For a valid native provider session resume:

1. the daemon passes the same immutable instructions, the new mutable turn, and `providerSessionRef` to a fresh adapter runtime;
2. the adapter restores or derives its provider-specific delivery state;
3. a native-instruction adapter configures its native channel as required;
4. a fallback adapter does not treat resume itself as a reason to append immutable instructions.

Resume is an engineering lifecycle transition, not a project message. It must not trigger the explicit join greeting, synthesize an asleep/awake timeline item, or tell the model that it "rejoined". The triggering project message remains the only mutable input.

When resume fails because the native session was deleted or cannot be read, the existing recovery path creates a new native session. The daemon again calls startup with immutable instructions and the recovery turn together. Because no `providerSessionRef` is present, the adapter treats it as a new native session and supplies immutable instructions again.

Moving the first mutable turn into the startup contract also removes the current split `start` followed by `input` lifecycle for managed cold starts. The generic host can fail the whole startup operation if initial delivery fails instead of briefly exposing an active native session that has not received its first turn.

## Native-session ownership lifecycle

The lifecycle terms have a narrow meaning:

- `awake`: Monad owns a live logical CLI-session binding and can deliver to it;
- `asleep`: Monad has released that binding while retaining enough provider identity to reacquire the same native session;
- `wake`: Monad reacquires the same native session and delivers the pending mutable input.

These terms do not describe individual turns or the lifetime of a per-turn child process. A per-turn process exiting while the logical binding remains owned is still `awake`.

The current session-event runtime refactor retains logical ownership after a per-turn process exits, and no longer executes the earlier host idle-release timer. Restoring timed ownership release/reacquisition is a separate host-lifecycle change because it requires a restartable runtime factory and durable binding semantics. This instruction-delivery change nevertheless makes existing resume paths invisible: a valid `providerSessionRef` resume receives no startup prompt in user history and no join greeting. If the provider session is missing or unreadable, cold-start recovery creates a genuinely new native session, supplies immutable instructions again, and sends the recovery notice.

## Internal adapter structure

The SDK does not prescribe an implementation, but a fallback adapter will normally keep a session-scoped coordinator shared by its plan and driver:

```ts
interface AdapterInstructionState {
  immutableText: string;
  includeOnNextTurn: boolean;
}
```

The adapter initializes `includeOnNextTurn` from its own new-versus-resume semantics, changes it when its own driver observes completed compaction, and clears it only after its encoded turn has been accepted for delivery. This state and any persistence mechanism remain private to that adapter.

Native-instruction adapters need no such coordinator.

## Validation and errors

Generic runtime validation checks only structural SDK invariants, including that managed startup contains both immutable instructions and an initial turn. It does not validate a provider's compaction strategy.

Each built-in adapter is responsible for rejecting managed startup when its configured CLI version or launch mode cannot provide the adapter's required native instruction or fallback behavior. Error text identifies the provider and unsupported mechanism.

## Testing

SDK and host tests assert the generic boundary:

- managed startup passes exact immutable and initial mutable values together;
- subsequent input contains only mutable content;
- the generic launcher no longer branches on `usesSystemPromptFile` or `usesDeveloperInstructions`;
- resume recovery invokes a new atomic startup and therefore supplies immutable instructions again.
- valid resume sends only the triggering mutable input and does not send the join greeting;
- immutable prompt fixtures do not contain `meshSessionId` or an unconditional startup-join rule;
- idle lifecycle events do not project into user-visible transcript items.

Adapter tests assert provider-owned behavior:

- Codex places immutable instructions in native developer configuration and never in encoded user stdin;
- Claude uses its system-prompt file on initial and resumed CLI processes without changing user input;
- Gemini uses native system instructions, preserves provider defaults, and does not depend on `PreCompress`;
- Qwen uses append-system-prompt without changing user content;
- a synthetic fallback adapter injects on a new native session, does not inject on ordinary turns or resume, and injects exactly once after its own completed-compaction signal.

Applicable daemon behavior is exercised over TCP loopback and Unix socket transports.

## Alternatives considered

### Put delivery mode and compaction events in the generic contract

Rejected. Whether a provider has a durable system instruction and how it reports compaction are adapter implementation details. Exposing them would leak provider lifecycle into the daemon and SDK.

### Repeat immutable instructions on every user turn

Rejected. It creates repeated provider history, increases token use, obscures the real conversation, and reproduces the current bug.

### Require every adapter to expose compaction

Rejected. Native developer/system instruction channels already own compaction semantics. Parsing compaction events adds no correctness for those adapters.

### Infer compaction from generic token usage

Rejected. Thresholds and accounting differ across providers, and a threshold crossing does not prove that compaction completed.
