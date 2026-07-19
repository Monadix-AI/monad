# MeshAgent Session Event Runtime Design

Date: 2026-07-19  
Status: reviewed design, pending implementation plan

## Summary

MeshAgent must not expose Codex app-server, PTY, JSON stream, WebSocket, Unix socket, or another provider execution mechanism as a first-class Mesh domain concept.

A provider qualifies as a MeshAgent by producing a stable structured stream of session events. Its adapter chooses one of two internal process models:

- **resident**: one long-lived provider process or channel carries multiple turns;
- **per-turn**: each turn starts a process that streams structured events and exits, while provider session identity resumes the next turn.

The daemon owns generic process and transport supervision, security policy, bounded capture, lifecycle deadlines, cleanup, and persistence. It does not understand provider methods, request IDs, handshake vocabulary, or protocol state.

PTY is not a MeshAgent session runtime. It remains available only for authentication, setup, status probes, and explicit diagnostics.

## Goals

- Remove app-server and transport vocabulary from Mesh protocol, public session APIs, daemon domain state, and generic UI.
- Replace launch-mode-driven hosting with one internal SessionEventRuntimePlan.
- Support resident and per-turn providers without changing the MeshAgent product model.
- Give each MeshAgent session its own provider driver and protocol state.
- Separate logical session lifecycle from current execution activity.
- Preserve daemon ownership of security, supervision, transport resources, observation capture, and cleanup.
- Derive controls from effective runtime capabilities rather than provider identity or topology.
- Preserve provider-native raw events and stable convenience projection.

## Non-goals

- Redesign Mesh project routing, fanout, membership, prompts, or managed-project semantics.
- Add distributed or remote-daemon Mesh.
- Expose provider process topology as a user-selectable Mesh enum.
- Make PTY text parsing an accepted session-event source.
- Standardize provider event vocabularies below the normalized MeshAgent event contract.
- Move process or socket ownership into atom adapters.
- Change model-provider contracts or the built-in Monad agent loop.

## Current problems

The implementation currently makes app-server a cross-layer concept:

- @monad/protocol defines MeshAgentLaunchMode, MeshAgentAppServerTransport, public launch-mode fields, and supported transport fields.
- @monad/sdk-atom exposes MeshAgentAppServerConnection, handle.appServer, pendingRequests, and nextRequestId.
- The daemon launcher has app-server-specific startup waits, socket branches, reconnect state, logs, and teardown paths.
- HTTP responses, Studio forms, Workplace configuration, docs, and raw observation labels expose app-server vocabulary.
- Provider protocol state leaks into the generic live-session handle.
- The pty, json-stream, app-server, remote-control, and cli-oneshot values mix user capability, process lifetime, transport, provider protocol, and controls into one enum.
- remote-control is advertised by the Codex and Claude Code presets but has no independent host launch path. It is a control-capability label, not a process model, and must not be converted into a third runtime plan.

The current state contract also conflates logical session lifetime with child-process lifetime. That fails for per-turn runtimes: a successful child exit completes one turn, not the MeshAgent session.

## Architecture

### Mesh domain

@monad/protocol owns only provider-neutral session facts:

- agent and provider identity;
- logical session lifecycle;
- current execution activity;
- effective user-facing controls;
- provider session identity;
- normalized observation, approval, usage, and error contracts.

The Mesh domain does not include process model, transport, framing, app-server, JSON-RPC, or PTY.

### Provider adapter

@monad/sdk-atom defines the authoring contract. Each adapter:

- validates and interprets provider configuration;
- builds one internal runtime plan;
- creates a new provider driver for every session;
- translates provider events into normalized MeshAgent output events;
- owns provider handshake, session start and resume, request correlation, approvals, steering, interruption, and protocol failures;
- reports effective capabilities from the runtime it created.

Built-in implementations remain in @monad/atoms.

Codex may call its implementation app-server. OpenClaw and Hermes may call theirs gateways. These names remain inside their adapters, fixtures, provenance, and provider documentation.

### Runtime plan

The only MeshAgent session runtime plan is:

    type SessionEventRuntimePlan =
      | ResidentSessionEventPlan
      | PerTurnSessionEventPlan

The process model is internal to the SDK and daemon. It is not a protocol enum and is not returned by Mesh session APIs.

A resident plan describes:

    interface ResidentSessionEventPlan {
      processModel: 'resident'
      launch: ProcessLaunchPlan
      channel:
        | ChildStdioChannelPlan
        | { kind: 'websocket'; endpoint: 'daemon-loopback' }
        | { kind: 'unix-socket'; endpoint: 'daemon-runtime' }
      startup: StartupPolicy
      reconnect?: ReconnectPolicy
      suspend?: SuspendPolicy
    }

A per-turn plan describes:

    interface PerTurnSessionEventPlan {
      processModel: 'per-turn'
      buildTurnLaunch(
        context: { providerSessionRef?: string }
      ): ProcessLaunchPlan
      encodeTurnInput(input: MeshAgentTurnInput): EncodedTurnInput
      startup: StartupPolicy
      continuation: { strategy: 'provider-session-ref' }
    }

    interface MeshAgentTurnInput {
      text: string
      attachments: readonly MeshAgentTurnAttachment[]
    }

    type MeshAgentTurnAttachment = Pick<
      MessageAttachmentRef,
      'id' | 'path' | 'name' | 'mime' | 'bytes'
    >

    type EncodedTurnInput =
      | { delivery: 'stdin'; bytes: Uint8Array }
      | { delivery: 'argv-tail'; separator: '--'; values: readonly string[] }

Both plans produce the same semantic provider session events. Physical byte chunks, JSONL boundaries, WebSocket message boundaries, and Unix socket framing remain channel and codec details.

A per-turn plan must support provider session resume. A stateless command that cannot continue a provider session does not satisfy the MeshAgent multi-turn contract.

ProcessLaunchPlan references the executable resolved by the daemon from the validated MeshAgent configuration; an adapter cannot replace it with an arbitrary path. buildTurnLaunch receives no user content. The daemon validates and registers attachments before constructing MeshAgentTurnInput, so adapters receive bounded references rather than arbitrary attachment objects. User text and attachment references flow only through encodeTurnInput, and the daemon accepts only stdin or values placed after an explicit end-of-options separator. A provider that supports neither safe form does not qualify for per-turn hosting.

remote-control has no target-plan equivalent. During migration, adapters map a legacy remote-control selection to their canonical structured runtime and report the concrete controls that runtime implements. An adapter that cannot do so returns an unresolved-migration error rather than manufacturing a runtime mode.

### Provider driver

The adapter creates a session-scoped driver. The process-model discriminant makes the model-specific methods required and prevents impossible method combinations:

    interface ProviderDriverBase {
      controls: ProviderDriverControls
      openSession(context: DriverContext): Promise<DriverReady>
      accept(packet: SessionEventPacket, sink: MeshAgentEventSink): Promise<void>
      dispose(): Promise<void>
    }

    interface ResidentProviderDriver extends ProviderDriverBase {
      processModel: 'resident'
      attachChannel(
        channel: SessionEventChannel,
        context: ChannelContext
      ): Promise<DriverReady | void>
      sendTurn(input: MeshAgentTurnInput): Promise<void>
    }

    interface PerTurnProviderDriver extends ProviderDriverBase {
      processModel: 'per-turn'
      attachTurnChannel(
        channel: SessionEventChannel,
        context: TurnChannelContext
      ): Promise<void>
      completeTurn(result: TurnProcessResult): Promise<void>
    }

    type MeshAgentProviderDriver =
      | ResidentProviderDriver
      | PerTurnProviderDriver

    interface ProviderDriverControls {
      approvalResolution: false | { resolve(resolution): Promise<void> }
      steer: false | { send(input: MeshAgentTurnInput): Promise<void> }
      interrupt: false | { run(): Promise<void> }
    }

For a per-turn plan, buildTurnLaunch builds only trusted executable options and encodeTurnInput supplies the separately typed untrusted payload. The host attaches the resulting event channel to the same logical driver for the duration of that turn. For a resident plan, attachChannel establishes the long-lived channel and sendTurn submits later turns through it.

The exact host-to-driver binding is discriminated by the runtime plan. It must not be an optional-field god object.

The driver instance owns:

- request ID generation and request-kind correlation;
- ephemeral provider connection identifiers;
- initialization and resume state;
- incremental decoder state;
- approval correlation;
- provider protocol readiness.

These fields leave LiveMeshSession. Adapters must not use module-level or WeakMap state when it belongs to one session driver.

accept is asynchronous and emits through an awaitable daemon-owned sink. The sink enforces maximum packet size, maximum normalized events per packet, bounded queued bytes, and slow-consumer cancellation. Drivers never return an unbounded event array. Server-to-client provider requests can be answered only through an attached bidirectional channel. A runtime reports approvalResolution false when that channel cannot remain writable for the request lifetime; the initial Codex exec and Claude stream-json per-turn adapters therefore report false.

### Generic daemon host

The daemon executes runtime plans and owns:

- argv-only process spawn;
- working-directory validation;
- child environment filtering;
- process supervision and reaping;
- stdio, WebSocket, and Unix socket resources;
- startup and reconnect deadlines;
- ordered delivery, backpressure, and bounded buffers;
- raw event capture before decoding or projection;
- observation epochs;
- persistent session and execution state;
- exactly-once teardown.

The host branches only on the internal runtime-plan and channel discriminants. It never branches on provider ID and never interprets provider methods or event names.

Atom-provided channel plans describe only the channel kind. They cannot provide a host, port, Unix path, or remote URL. The daemon binds WebSocket channels to loopback and injects the allocated port. It allocates Unix sockets under its private runtime directory, keeps the directory owner-only, creates sockets with mode 0600, rejects symlink traversal, and injects the path. A plan containing an adapter-selected endpoint is invalid.

## Event flow

### Resident runtime

1. The adapter creates a plan and a fresh driver.
2. The daemon validates the plan, spawns the provider, and establishes its channel.
3. The daemon binds the channel to the driver.
4. openSession and attachChannel perform provider initialization or resume.
5. DriverReady returns effective capabilities and may include an already-known provider session identity.
6. The daemon persists ready state.
7. Incoming packets are captured raw before driver decoding.
8. The driver emits normalized output events.
9. Observation projection produces raw and convenience views.
10. Reconnect creates a new channel and invokes rebind. The daemon does not guess the provider handshake.

### Per-turn runtime

1. The adapter creates a logical session driver with no resident child.
2. The session becomes active with execution activity idle.
3. Input calls buildTurnLaunch with the persisted provider session reference.
4. The daemon starts the turn process and marks execution running.
5. Structured output is captured and decoded as session events.
6. The driver emits provider-session-identified when it learns or confirms provider session identity from the stream.
7. Successful child exit completes the turn and returns execution to idle.
8. The logical session remains active.
9. The next turn resumes the same provider session in a new process.

provider-session-identified is a normalized driver output event for both models. The daemon validates and persists providerSessionRef when it consumes that event. DriverReady may carry the same identity as an initialization optimization, but persistence does not depend on identity being known before the event stream starts.

Codex exec with JSONL output and Claude Code print mode with stream-json are valid per-turn event sources because they stream structured events during the invocation and support session resume.

## State model

Logical session lifecycle and execution activity are separate persisted axes. Connection condition is a runtime-derived view field; it resets to inactive on daemon boot and is recomputed as channels are restored.

    type MeshSessionLifecycle =
      | { state: 'starting' }
      | { state: 'active' }
      | {
          state: 'terminal'
          termination: {
            kind: 'exited' | 'stopped' | 'failed'
            at: string
            exitCode?: number | null
            error?: MeshAgentRuntimeFailure
          }
        }

    type MeshExecutionActivity =
      | { state: 'idle'; pid: null; queuedTurnCount: 0 }
      | { state: 'starting'; pid: number | null; queuedTurnCount: number }
      | { state: 'running'; pid: number; queuedTurnCount: number }
      | {
          state: 'suspended'
          pid: null
          suspendedAt: string
          queuedTurnCount: number
        }

    type MeshConnectionCondition =
      | { state: 'inactive' }
      | { state: 'connecting' }
      | { state: 'connected' }
      | { state: 'reconnecting'; attempt: number; nextAttemptAt?: string }

Invariants:

- Per-turn sessions are active plus idle between turns.
- A successful per-turn child exit returns execution to idle; it does not terminate the session.
- A per-turn spawn, process, or turn-protocol failure emits a turn-scoped failure and returns execution to idle when the driver says the provider session can continue. It terminates the logical session only when the driver reports the provider session unrecoverable or a host security invariant is violated.
- Resident idle unloading is active plus suspended and retains provider session identity.
- A resident exit caused by daemon-initiated suspend or stop follows the requested transition and is not an unexpected-process failure, regardless of exit code.
- Suspended is durable and resumable. Daemon restart must not reconcile it as an orphaned running process.
- Stopped requires an explicit user or daemon policy stop.
- Failed means an unrecoverable host or driver failure.
- Exited requires the provider session to end naturally and no longer accept turns.
- A resident child exit not caused by suspend or stop, and without a provider terminal signal, is a failure even when its exit code is zero.
- A null PID never determines suspension by itself.
- Reconnecting is represented by MeshConnectionCondition, not by logical lifecycle or execution activity.
- Exactly one turn may execute per logical session. Ordinary input received while running enters a bounded FIFO queue; explicit steer uses the steer control and never enters that queue. Queue overflow rejects the newest input with a stable busy error.
- A new observation epoch begins for every physical provider-channel activation: initial resident connection, resident reconnect or restoration, and every per-turn child. Logical session identity and normalized event sequencing remain stable across epochs.
- On clean daemon shutdown, per-turn sessions with no child remain active plus idle. An active turn is aborted with a turn-scoped daemon-shutdown result and returns to idle if continuation is still valid. A resident runtime with runtime restoration becomes active plus suspended; one without restoration becomes terminal stopped with reason daemon_shutdown.

Public session views expose lifecycle, execution activity, connection condition, and effective capabilities. They do not expose process model or transport. Current state combinations can make a process model inferable, but that is incidental and not a consumer contract; clients must not branch on the inference.

## Capabilities

Controls derive from the effective runtime definition and driver methods:

    interface MeshAgentRuntimeCapabilities {
      input: boolean
      steer: boolean
      interrupt: boolean
      approvalResolution: boolean
      providerSessionContinuation: boolean
      runtimeRestoration: boolean
      sessionReopen: boolean
    }

Rules:

- UI and handlers read effective session capabilities.
- No consumer infers controls from provider ID, app-server, transport, or process model.
- A per-turn runtime requires providerSessionContinuation and can support interrupt while lacking steer or live approval resolution.
- A resident runtime gains no control automatically. Its driver must implement and report it.
- runtimeRestoration means the daemon may release and rebuild runtime resources without ending the logical session. sessionReopen means a terminal or explicitly closed UI flow can create a new logical runtime from persisted provider identity. Neither is inferred from providerSessionContinuation.
- Resize is not a MeshAgent runtime capability. Resize remains on the separate PTY authentication-session contract only.

## Authentication and probes

Authentication, setup, and diagnostics remain separate from MeshAgent session runtime.

The auth host may use PTY because its purpose is provider-owned human interaction. PTY output:

- is not parsed as authoritative MeshAgent session events;
- does not create a Mesh session;
- does not satisfy provider conformance;
- cannot be selected as a session launch mode.

Auth status and usage probes may use bounded non-interactive processes and provider-owned parsers.

## Errors

Host infrastructure failures include:

- invalid runtime plan;
- spawn failure;
- startup timeout;
- channel connection failure;
- unexpected resident-process exit without a valid session-terminal condition;
- reconnect exhaustion;
- resource or security policy violation.

Provider-driver failures include:

- authentication required;
- protocol violation;
- session initialization or resume rejection;
- malformed provider event;
- unsupported provider request;
- unrecoverable provider session failure.

Ordinary tool, model, rate-limit, and turn failures remain normalized provider events when the session can continue. Only unrecoverable failures terminate the logical session.

Per-turn spawn and exit failures are turn-scoped by default. They return activity to idle after draining bounded output and clearing the active process. The driver may promote them to session-scoped failure only when its provider-session state is invalid or continuation is impossible. Daemon-initiated suspend, stop, and shutdown exits are classified before generic process-exit handling and can never be promoted merely because a provider terminal event is absent.

## Teardown

Every terminal path uses one teardown coordinator:

1. Stop accepting new input.
2. Abort the active turn or resident channel.
3. Dispose the provider driver.
4. Close channel resources.
5. Stop and reap the resident or active per-turn process.
6. Reject pending host operations.
7. Remove sockets, runtime tokens, and live observation resources.
8. Persist execution activity and terminal lifecycle exactly once.
9. Emit connection and session lifecycle events exactly once.

Idle suspension uses the same resource-release primitives but does not enter terminal lifecycle or delete resumable provider identity.

## Protocol and UI changes

The target protocol removes:

- MeshAgentLaunchMode;
- MeshAgentAppServerTransport;
- MeshAgentView.defaultLaunchMode;
- MeshAgentView.appServerTransport;
- MeshAgentPresetView.supportedLaunchModes;
- MeshAgentPresetView.supportedAppServerTransports;
- StartMeshAgentRequest.launchMode;
- MeshSessionView.launchMode;
- MeshAgentResizeRequest and the Mesh session resize endpoint.

It adds lifecycle, execution activity, and effective capabilities.

The 0.0.3 compatibility release keeps deprecated response aliases and the Mesh session resize route as a no-op compatibility facade after the new fields are available. The 0.0.4 contract removes them and increments the daemon API compatibility version. An older client connecting to 0.0.4 must fail version negotiation with an upgrade-required error before it parses a changed Treaty response; it must not fail later as an unexplained schema error.

The PTY authentication-session resize request and endpoint remain unchanged.

Studio may render provider-specific advanced settings from adapterSettings. A Codex adapter may expose an app-server preference there, but the daemon treats the key and value as opaque. There is no new public top-level runtimeProfile replacement.

Generic raw observation sources use provider-neutral labels such as provider-channel, stdout, and stderr. Provider provenance may retain names such as codex-app-server.

## Configuration migration

Existing configuration must not silently change behavior.

The compatibility window is exactly release 0.0.3. Release 0.0.4 removes legacy parsing:

1. @monad/environment accepts deprecated launch and transport fields without interpreting provider semantics.
2. After atom adapters register, the daemon invokes an adapter migration hook.
3. The adapter maps legacy fields, including remote-control, to provider-owned adapterSettings and a canonical structured runtime.
4. ConfigManager records a migration ID and source checksum, writes a rollback journal, then atomically writes canonical configuration and removes migrated fields.
5. Re-running the migration with the same ID and checksum is a no-op. A changed source is re-evaluated once and atomically replaces the journal entry.
6. Unknown, uninstalled, or unresolved third-party providers retain legacy values and receive a clear warning; their entries are not partially migrated.
7. Successfully migrated adapterSettings remain in the MeshAgent configuration even if the adapter is later uninstalled. The 0.0.3 rollback journal retains the original legacy fragment through the 0.0.4 cutover.
8. On 0.0.4 startup, any still-unresolved legacy entry is disabled with a named provider and recovery action rather than silently selecting a fallback. Legacy parsing is then removed.

The daemon never maps provider IDs to app-server or gateway settings itself.

All built-in presets receive an explicit mapping before PTY session fallback is removed: Codex selects its structured resident runtime by default, Claude Code, Gemini, and Qwen select their structured event streams, and OpenClaw and Hermes select their structured gateway or resumable per-turn runtime. A third-party PTY-only adapter cannot start a Mesh session in 0.0.4. The localized error names the provider, states that PTY output is not a stable session-event source, and tells the user to update the adapter or disable that MeshAgent.

## Migration sequence

### Phase 1: additive contracts

- Add runtime-plan, driver, channel, state, and capability contracts.
- Add exact contract and state-transition tests.
- Keep existing adapters and host behavior operational.

### Phase 2: generic executor

- Extract generic process, channel, deadline, capture, and teardown services.
- Add a temporary bridge from existing launch specs.
- Prove equivalent behavior before provider conversion.
- Keep the bridge internal and delete it before completion.

### Phase 3: reference provider cutover

- Convert Codex resident app-server to a resident session-event runtime.
- Convert Claude Code structured CLI streaming to the unified runtime.
- Add Codex exec JSONL and Claude stream-json per-turn conformance fixtures.
- Confirm both process models project the same normalized turn semantics.

### Phase 4: remaining providers

- Convert OpenClaw and Hermes gateways.
- Convert Gemini and Qwen structured event streams.
- Assign every built-in legacy PTY and remote-control selection a canonical structured-runtime migration.
- Remove PTY session fallback after those mappings pass conformance.
- Reject providers without stable structured events or per-turn resume.

### Phase 5a: internal state persistence

- Persist the two-axis state model.
- Model connection condition and persist bounded turn-queue state and shutdown transitions.
- Update orphan reconciliation, suspension, restoration, and observation-epoch rotation without changing public response shapes.
- Backfill existing rows and prove restart behavior before the public cutover.

### Phase 5b: protocol and UI cutover

- Update API schemas, version negotiation, clients, RTK, Studio, Workplace, docs, and i18n.
- Migrate stored configuration through adapter hooks.
- Switch controls to effective capabilities.
- Keep the 0.0.3 compatibility facade and warnings measurable.

### Phase 6: deletion

- Delete compatibility bridges and legacy launch-mode types.
- Delete app-server-named daemon services and generic handle fields.
- Delete provider-state WeakMap workarounds.
- Enforce the final boundary with a repository check.

## Verification

### Contracts

- Assert exact lifecycle, execution, and capability shapes.
- Assert final APIs reject legacy launch and transport fields.
- Require stable session identity, event validation, deterministic turn terminal behavior, and truthful capabilities.

### Runtime matrix

Exercise:

- resident child stdio;
- resident WebSocket;
- resident Unix socket;
- per-turn structured output;
- resume across per-turn processes;
- bounded FIFO turn serialization and overflow;
- turn-scoped spawn, process, and protocol failure returning to idle;
- startup timeout;
- reconnect and reconnect exhaustion;
- suspension and restoration;
- daemon-initiated suspend and clean shutdown exits;
- natural provider termination;
- explicit stop;
- unrecoverable host and driver failures;
- exactly-once teardown.

### Provider fixtures

Use sanitized real fixtures for:

- Codex app-server initialization, resume, steer, interrupt, approval, and history;
- Codex exec JSONL streaming and resume;
- Claude stream-json, terminal result, retry, and resume;
- OpenClaw challenge and routing;
- Hermes persistent and ephemeral identity;
- Gemini and Qwen events and permission controls.

### State transitions

Assert exact transitions:

- starting to active plus running;
- active plus running to suspended and back;
- active plus idle to running and back for per-turn;
- active plus running to active plus idle after a recoverable turn failure;
- explicit stop to terminal stopped;
- provider-declared natural end to terminal exited;
- unexpected process or protocol failure to terminal failed;
- daemon restart preserves active plus suspended;
- daemon restart reconciles only genuinely orphaned running executions.
- clean daemon shutdown preserves resumable sessions and stops non-restorable resident sessions.

### Security and reliability

Verify environment stripping, daemon-resolved executables, argv-only spawn, stdin or post-`--` turn payload delivery, rejection of input in flag position, working-directory scope, daemon-only endpoint allocation, loopback WebSocket binding, owner-only runtime directories, 0600 Unix sockets, symlink rejection, bounded packets, events, queues, and output, secret redaction, raw capture before decoding, protocol validation, slow-consumer disposal, and reconnect bounds.

### Transport parity

Every daemon-facing behavior must match over TCP loopback and the daemon Unix socket.

### Boundary check

The final repository check permits app-server only in:

- Codex adapter implementation and generated bindings;
- provider-specific fixtures and provenance;
- migration documentation.

It rejects app-server vocabulary from generic protocol, daemon runtime-host abstractions, public Mesh APIs, and generic UI.

## Source grounding

- Codex non-interactive mode documents JSONL event streaming from codex exec and provider-session resume: https://learn.chatgpt.com/docs/non-interactive-mode.md
- Claude Code programmatic mode documents print-mode stream-json events and session resume: https://code.claude.com/docs/en/headless
- Current repository anchors include packages/protocol/src/mesh-agent/mesh-agent-config.ts, packages/sdk-atom/src/agent-adapter.ts, packages/atoms/src/agent-adapters/codex, packages/atoms/src/agent-adapters/claude-code, and apps/monad/src/services/mesh-agent/host.

## Implementation constraints

- Implement directly on main as explicitly requested.
- Preserve all pre-existing staged and unstaged work.
- Do not commit unrelated user changes.
- Use Bun-only repository commands.
- Follow exact-contract test rules and avoid weak existence assertions.
- Collect complete applicable failures before editing and rerun each verification scope once after the batch.
- Treat current Mesh observation and host changes as overlapping WIP and reconcile rather than overwrite them.
