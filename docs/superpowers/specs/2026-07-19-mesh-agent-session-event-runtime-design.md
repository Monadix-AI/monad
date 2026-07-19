# MeshAgent Session Event Runtime Design

Date: 2026-07-19  
Status: approved design, pending implementation plan

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
- The pty, json-stream, app-server, and cli-oneshot values mix user capability, process lifetime, transport, and provider protocol into one enum.

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
        | WebSocketChannelPlan
        | UnixSocketChannelPlan
      startup: StartupPolicy
      reconnect?: ReconnectPolicy
      suspend?: SuspendPolicy
    }

A per-turn plan describes:

    interface PerTurnSessionEventPlan {
      processModel: 'per-turn'
      buildTurnLaunch(
        input: string,
        providerSessionRef?: string
      ): ProcessLaunchPlan
      startup: StartupPolicy
      resume: { strategy: 'provider-session-ref' }
    }

Both plans produce the same semantic provider session events. Physical byte chunks, JSONL boundaries, WebSocket message boundaries, and Unix socket framing remain channel and codec details.

A per-turn plan must support provider session resume. A stateless command that cannot continue a provider session does not satisfy the MeshAgent multi-turn contract.

### Provider driver

The adapter creates a session-scoped driver. Channel attachment and turn submission are separate because resident turns are sent over an attached channel while per-turn input is normally baked into the launch plan:

    interface MeshAgentProviderDriver {
      openSession(context: DriverContext): Promise<DriverReady>
      attachChannel?(
        channel: SessionEventChannel,
        context: ChannelContext
      ): Promise<DriverReady | void>
      accept(packet: SessionEventPacket): MeshAgentOutputEvent[]
      sendResidentTurn?(input: string): Promise<void> | void
      resolveApproval?(resolution): Promise<void> | void
      steer?(input: string): Promise<void> | void
      interrupt?(): Promise<void> | void
      dispose(): Promise<void> | void
    }

For a per-turn plan, buildTurnLaunch is the provider-owned input encoder and process builder. The host attaches the resulting event channel to the same logical driver for the duration of that turn. For a resident plan, attachChannel establishes the long-lived channel and sendResidentTurn submits later turns through it.

The exact host-to-driver binding is discriminated by the runtime plan. It must not be an optional-field god object.

The driver instance owns:

- request ID generation and request-kind correlation;
- ephemeral provider connection identifiers;
- initialization and resume state;
- incremental decoder state;
- approval correlation;
- provider protocol readiness.

These fields leave LiveMeshSession. Adapters must not use module-level or WeakMap state when it belongs to one session driver.

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

## Event flow

### Resident runtime

1. The adapter creates a plan and a fresh driver.
2. The daemon validates the plan, spawns the provider, and establishes its channel.
3. The daemon binds the channel to the driver.
4. openSession and attachChannel perform provider initialization or resume.
5. DriverReady returns provider session identity and effective capabilities.
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
6. The driver learns or confirms provider session identity from the stream.
7. Successful child exit completes the turn and returns execution to idle.
8. The logical session remains active.
9. The next turn resumes the same provider session in a new process.

Codex exec with JSONL output and Claude Code print mode with stream-json are valid per-turn event sources because they stream structured events during the invocation and support session resume.

## State model

Logical session lifecycle and execution activity are separate persisted axes.

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
      | { state: 'idle'; pid: null }
      | { state: 'starting'; pid: number | null }
      | { state: 'running'; pid: number }
      | {
          state: 'suspended'
          pid: null
          suspendedAt: string
        }

Invariants:

- Per-turn sessions are active plus idle between turns.
- A successful per-turn child exit returns execution to idle; it does not terminate the session.
- Resident idle unloading is active plus suspended and retains provider session identity.
- Suspended is durable and resumable. Daemon restart must not reconcile it as an orphaned running process.
- Stopped requires an explicit user or daemon policy stop.
- Failed means an unrecoverable host or driver failure.
- Exited requires the provider session to end naturally and no longer accept turns.
- A resident child exit without a provider terminal signal is a failure even when its exit code is zero.
- A null PID never determines suspension by itself.
- Reconnecting is a connection condition, not a logical session state.

Public session views expose lifecycle, execution activity, and effective capabilities. They do not expose process model or transport.

## Capabilities

Controls derive from the effective runtime definition and driver methods:

    interface MeshAgentRuntimeCapabilities {
      input: boolean
      steer: boolean
      interrupt: boolean
      resume: boolean
      approvalResolution: boolean
    }

Rules:

- UI and handlers read effective session capabilities.
- No consumer infers controls from provider ID, app-server, transport, or process model.
- A per-turn runtime can support resume and interrupt while lacking steer or live approval resolution.
- A resident runtime gains no control automatically. Its driver must implement and report it.
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
- process exit without a valid session-terminal condition;
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

The PTY authentication-session resize request and endpoint remain unchanged.

Studio may render provider-specific advanced settings from adapterSettings. A Codex adapter may expose an app-server preference there, but the daemon treats the key and value as opaque. There is no new public top-level runtimeProfile replacement.

Generic raw observation sources use provider-neutral labels such as provider-channel, stdout, and stderr. Provider provenance may retain names such as codex-app-server.

## Configuration migration

Existing configuration must not silently change behavior.

During one migration window:

1. @monad/environment accepts deprecated launch and transport fields without interpreting provider semantics.
2. After atom adapters register, the daemon invokes an adapter migration hook.
3. The adapter maps legacy fields to provider-owned adapterSettings.
4. ConfigManager atomically writes canonical configuration and removes migrated fields.
5. Unknown third-party providers retain legacy values and receive a clear warning.
6. Deprecated fields remain readable until every configured provider is migrated or reported unresolved.
7. Final cleanup removes legacy parsing after the compatibility window.

The daemon never maps provider IDs to app-server or gateway settings itself.

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
- Remove PTY session fallback.
- Reject providers without stable structured events or per-turn resume.

### Phase 5: state, protocol, and UI cutover

- Persist the two-axis state model.
- Update orphan reconciliation, suspension, recovery, API schemas, clients, RTK, Studio, Workplace, docs, and i18n.
- Migrate stored configuration through adapter hooks.
- Switch controls to effective capabilities.

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
- startup timeout;
- reconnect and reconnect exhaustion;
- suspension and restoration;
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
- explicit stop to terminal stopped;
- provider-declared natural end to terminal exited;
- unexpected process or protocol failure to terminal failed;
- daemon restart preserves active plus suspended;
- daemon restart reconciles only genuinely orphaned running executions.

### Security and reliability

Verify environment stripping, argv-only spawn, working-directory scope, loopback WebSocket binding, owner-only Unix sockets, bounded packets and output, secret redaction, raw capture before decoding, protocol validation, slow-consumer disposal, and reconnect bounds.

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
