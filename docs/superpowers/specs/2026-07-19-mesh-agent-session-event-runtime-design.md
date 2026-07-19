# MeshAgent Session Event Runtime Design

Date: 2026-07-19  
Status: implemented on `main`; legacy daemon hosting removed

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

## Replaced implementation

The replaced implementation made app-server a cross-layer concept:

- @monad/protocol defines MeshAgentLaunchMode, MeshAgentAppServerTransport, public launch-mode fields, and supported transport fields.
- @monad/sdk-atom exposes MeshAgentAppServerConnection, handle.appServer, pendingRequests, and nextRequestId.
- The daemon launcher has app-server-specific startup waits, socket branches, reconnect state, logs, and teardown paths.
- HTTP responses, Studio forms, Workplace configuration, docs, and raw observation labels expose app-server vocabulary.
- Provider protocol state leaks into the generic live-session handle.
- The pty, json-stream, app-server, and cli-oneshot values mix user capability, process lifetime, transport, and provider protocol into one enum.
- The former remote-control value was advertised by the Codex and Claude Code presets but had no independent host launch path. It is void, removed from the launch-mode schema, presets, settings, and launch capabilities, and must not be converted into a runtime plan or capability.

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

The removed remote-control value has no target-plan equivalent and no compatibility mapping. Configuration containing it is invalid and must name the affected MeshAgent and require the operator to select a supported structured runtime; the daemon must not silently choose one.

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

The implementation removes these fields and the Mesh resize route directly. There is no launch-mode compatibility facade: current schemas retain only canonical fields and strip obsolete launch and transport keys when older stored objects are parsed.

The PTY authentication-session resize request and endpoint remain unchanged.

Studio may render provider-specific advanced settings from adapterSettings. A Codex adapter may expose an app-server preference there, but the daemon treats the key and value as opaque. There is no new public top-level runtimeProfile replacement.

Generic raw observation sources use provider-neutral labels such as provider-channel, stdout, and stderr. Provider provenance may retain names such as codex-app-server.

## Configuration cutover

The cutover does not map launch modes or transports to new daemon concepts. The environment and protocol schemas remove those fields, including `remote-control`, and provider adapters choose their runtime definition from provider-owned settings.

Codex, Claude Code, Gemini, and Qwen implement `createSessionRuntime` with structured session events. OpenClaw, Hermes, and third-party adapters without that contract remain valid adapter definitions for non-Mesh features, but Mesh session start rejects them until they provide a structured runtime. There is no PTY fallback and the daemon never maps a provider ID to app-server, gateway, framing, or transport behavior.

## Implementation record

- Added the provider-neutral runtime-plan, driver, channel, lifecycle, activity, connection, and capability contracts.
- Added one generic daemon executor and resource factory; removed the old app-server and CLI-one-shot daemon hosts.
- Converted Codex, Claude Code, and Gemini to resumable per-turn structured streams and Qwen to a resident structured stream.
- Removed PTY session fallback, launch-mode selection, Mesh resize, and `remote-control` from protocol, configuration, persistence, Studio, Workplace, and generic runtime state.
- Kept PTY as a separate provider-authentication surface.
- Persisted lifecycle and execution activity independently and made startup failures terminal ledger entries.
- Rejected adapters without `createSessionRuntime` instead of guessing a provider topology.

## Verification

### Contracts

- Assert exact lifecycle, execution, and capability shapes.
- Assert final API shapes do not expose legacy launch and transport fields.
- Require stable session identity, event validation, deterministic turn terminal behavior, and truthful capabilities.

### Runtime coverage

The landed tests exercise resident child stdio, per-turn structured output, resume across per-turn processes, turn completion, explicit stop and deletion, startup and executable failures, unexpected resident exit, provider authentication separation, working-directory containment, and matching TCP-loopback and daemon-Unix-socket behavior. WebSocket/Unix provider channels, reconnect, idle suspension, and runtime restoration remain contract extension points; they are not advertised as implemented Mesh behavior.

### Provider fixtures

The provider tests cover Codex exec JSONL resume, Claude stream-json resume, Gemini structured events, and Qwen resident events. OpenClaw and Hermes are deliberately excluded from Mesh runtime conformance until their adapters implement the session-event runtime contract.

### State transitions

The landed assertions cover starting to active, per-turn active-plus-idle to running and back, explicit stop to terminal stopped, setup and unexpected-process failures to terminal failed, and deletion of terminal state. Suspended/restored and provider-declared natural exit remain distinct contract states but are not synthesized from process exit or null PID.

### Security and reliability

The implementation keeps daemon-resolved executables, argv-only spawn, structured stdin or post-`--` turn delivery, working-directory containment, bounded capture, raw capture before decoding, protocol validation, and exactly-once cleanup inside the generic executor. Provider socket allocation, reconnect policy, and restoration must pass their own conformance coverage before any adapter advertises those extension points.

### Transport parity

Every daemon-facing behavior must match over TCP loopback and the daemon Unix socket.

### Boundary check

The final repository check permits app-server only in provider-specific adapter implementations, generated bindings, fixtures, provenance, and historical migration documentation.

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
