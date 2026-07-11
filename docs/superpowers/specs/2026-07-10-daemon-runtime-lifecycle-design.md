# Daemon Runtime Lifecycle Design

## Status

Approved direction: replace the monolithic daemon composition flow with an explicit lifecycle graph, use a daemon-local Zustand store for observable lifecycle state, and consolidate configuration I/O and hot reload behind a `ConfigService`.

This document defines the target architecture. It does not authorize implementation.

## Goals

- Reduce time from process start to full capability readiness by moving shared prerequisites earlier and initializing independent modules concurrently.
- Make module dependencies, criticality, startup, reload, health, and shutdown behavior explicit.
- Replace distributed configuration watchers and `ConfigBus` subscribers with one `ConfigService` and a bounded single-flight reload coordinator.
- Make daemon lifecycle state observable without turning the state store into a service locator or side-effect bus.
- Preserve the existing security boundaries, transport parity, configuration source of truth, and hot-reload user experience.

## Non-goals

- No startup performance budget or percentage target is required for the first migration.
- Do not introduce RxJS.
- Do not add a general dependency-injection container.
- Do not put runtime service instances, credentials, promises, processes, or sockets in Zustand.
- Do not implement a revisioned configuration event log, an event queue, or a cross-module global transaction protocol.
- Do not add configuration environment variables.
- Do not change the REST, SSE, WebSocket, Unix socket, or stdio contracts.

## Current problems

`apps/monad/src/main.ts` is both the composition root and the lifecycle implementation. Its execution order is correct but largely encoded by statement order and mutable late-bound closures. Independent work is often awaited sequentially, while startup, hot reload, and shutdown use separate patterns.

Configuration reload currently spans three concepts:

- `ReloadService` watches files and debounces filesystem events.
- `ConfigBus` broadcasts complete config/auth snapshots and waits for every subscriber.
- `registerHotReload()` manually sequences heterogeneous subsystem updates.

This makes change ownership hard to see, sends every configuration update to broad subscribers, and leaves module failure and lifecycle state distributed across logs and local mutable variables.

`serveDaemon()` also combines HTTP app construction, TCP listeners, Unix socket binding, Mo launch, signal registration, channel startup, and readiness output. Those responsibilities must be separable before the lifecycle graph can schedule or observe them independently.

## Design principles

### One runtime kernel

Use one `RuntimeKernel` for startup, configuration reload, health, and shutdown. Do not create a separate `ReloadKernel`; startup and reload must use the same module registry and dependency graph.

### Explicit dependencies

Every runtime module declares hard dependencies and optional ordering constraints. No module discovers another module through global Zustand state.

### Existing domain directories remain ownership boundaries

Do not create a second hierarchy under `runtime/subsystems` or a flat adapter catalog under `runtime/modules`. The existing `agent`, `capabilities`, `atoms`, `channels`, `store`, `services`, and `transports` directories remain the canonical ownership boundaries. Lifecycle adapters live beside the behavior they manage; `runtime/create.ts` only imports and assembles their descriptors.

### State, objects, and events remain separate

- `RuntimeKernel` owns service instances and lifecycle effects.
- `RuntimeContext` provides typed access to module outputs.
- Zustand stores serializable lifecycle state.
- `ConfigService` owns configuration reads, writes, watching, and reload invalidation.

### Full-ready is truthful

The ready signal is emitted only after every registered module reaches a terminal startup state:

- Every required module is `ready`.
- Every optional module is `ready`, `degraded`, or terminally `blocked` by an unavailable optional dependency.

Enabled channels are included in full-ready. A slow channel handshake therefore delays full-ready; an optional channel failure completes as degraded rather than blocking forever. Every module start must have a bounded timeout or its own bounded connection policy.

## Target structure

```text
apps/monad/src/
├── main.ts
├── runtime/
│   ├── create.ts
│   ├── kernel.ts
│   ├── graph.ts
│   ├── context.ts
│   ├── state.ts
│   └── types.ts
├── config/
│   ├── service.ts
│   ├── reload.ts
│   ├── resolve.ts
│   ├── secrets.ts
│   └── mcp-presets.ts
├── store/
│   ├── lifecycle.ts
│   ├── db/
│   ├── kv/
│   └── home/
├── agent/
│   ├── execution.ts
│   ├── loop/
│   ├── context/
│   ├── history.ts
│   ├── memory/
│   ├── model/
│   │   └── lifecycle.ts
│   ├── prompts/
│   ├── approvals/
│   └── session/
├── capabilities/
│   ├── lifecycle.ts
│   ├── tools/
│   ├── skills/
│   └── mcp/
├── atoms/
│   ├── lifecycle.ts
│   └── install/
├── channels/
│   └── lifecycle.ts
├── transports/
│   ├── lifecycle.ts
│   ├── http/
│   ├── jsonrpc/
│   ├── acp/
│   ├── a2a/
│   └── stdio.ts
├── handlers/
├── services/
├── hooks/
├── infra/
└── platform/
```

`runtime/create.ts` is the thin composition root. A separate `bootstrap/` directory is unnecessary when it would contain only this file. `create.ts` creates the initial configuration source, imports lifecycle descriptors from their owning domains, creates the kernel and ConfigService, starts the kernel, then starts configuration watching.

Lifecycle descriptors are named for their existing domain, such as `store`, `agent.model`, `capabilities`, `atoms`, `channels`, and `transports.unix`. Internal helpers and per-turn AgentLoop components are not lifecycle modules.

Start with coarse co-located adapters that wrap existing functions. Split an adapter only when its internal responsibilities need independent dependencies, failure policy, or reload behavior. A domain may export several descriptors from one `lifecycle.ts`; it does not need one file per lifecycle node.

## Runtime module contract

```ts
type ModuleCriticality = 'required' | 'optional';

interface RuntimeModule<Output> {
  id: ModuleId;
  requires?: readonly ModuleId[];
  after?: readonly ModuleId[];
  criticality: ModuleCriticality;

  start(ctx: RuntimeContext, signal: AbortSignal): Promise<Output>;

  reload?(
    current: Output,
    snapshot: ConfigSnapshot,
    ctx: RuntimeContext,
    signal: AbortSignal
  ): Promise<Output>;

  stop?(current: Output, ctx: RuntimeContext): Promise<void>;
  health?(current: Output): Promise<ModuleHealth>;
}
```

`requires` means the dependency must be ready and its output is available. `after` only constrains scheduling and does not turn an optional failure into a hard dependency.

An optional module consumed by another module must be represented as an optional dependency or a typed Null Object. Consumers must not cast a missing output into existence.

`reload()` must not return until all state it owns has been committed. It may manage background work after returning only when stale work is explicitly cancelled or prevented from committing.

## Runtime context

`RuntimeContext` is the typed owner of module outputs:

```ts
interface RuntimeContext {
  get<Id extends ModuleId>(id: Id): ModuleOutput<Id>;
  optional<Id extends ModuleId>(id: Id): ModuleOutput<Id> | undefined;
}
```

Only the kernel mutates the output registry. Consumers receive dependencies through their module context or constructor. They do not call `runtimeStore.getState()` to locate services.

Prefer stable service facades for reloadable dependencies. A stable MCP or channel service can replace its internal connection handle without forcing agent execution or handlers to capture a new service object.

## Agent execution

The existing `agent/` domain owns everything required to execute a model turn, but it does not assemble an `AgentLoop` during daemon startup.

Startup creates only a lightweight `AgentExecutionService` in `agent/execution.ts`, with stable references to repositories, the model router, capability registries, history storage, prompt replay cache, hooks, oversight, and other long-lived facades. Model availability and required provider configuration are validated by `agent/model/lifecycle.ts` for truthful full-ready.

Every session send or generate operation asks the service to create a turn execution:

```ts
const execution = agentExecution.createTurn({
  sessionId,
  agentId,
  modelOverride,
  sandboxRoots
});

await execution.run(input, emit);
```

`createTurn()` resolves the current model/profile, context limit, summarization thresholds, agent persona, budgets, tools, skills, prompt slots, sandbox roots, policy, and hooks. It then constructs the per-turn `AgentLoop` from the existing modules under `agent/`. This keeps invoke-time configuration live and avoids rebuilding daemon-wide services.

`AgentExecutionService` may retain only state that must survive turns, such as prompt replay cache and durable history access. If it owns no resource requiring start, health, reload, or stop, it is a handler dependency rather than a lifecycle descriptor. There is no top-level `agent-runtime` startup module or duplicate `runtime/agent-loop` directory.

## Dependency graph and startup

The kernel validates the graph before starting:

- Module IDs are unique.
- Every required dependency exists.
- The graph has no cycles.
- Ordering-only edges do not contradict hard dependency edges.

It then computes topological layers. Modules in one layer run through `Promise.allSettled()`; the next layer starts only after the current layer reaches terminal results.

The intended dependency stages are:

```text
L0  mode branch → singleton lock → home initialization → development seed

L1  config/profile + auth    KV/SQLite    version/path metadata
     └────────────────────────── parallel ─────────────────────┘

L2  store    platform/sandbox    agent/model    interrupt services
     └────────────────────────── parallel ──────────────────────────┘

L3  capabilities registry → atoms discovery/materialization → skills / MCP registration
                           └──────── parallelism where shared registries permit ────────┘

L4  agent execution service → handlers / schedule / delegation

L5  transports / channels / Mo
     └────────────── parallel where dependencies permit ──────────────┘
```

Constraints that remain sequential:

- ACP bridge mode branches before the daemon singleton lock and runtime construction.
- Development provider seeding precedes config and provider discovery because it may change their input files.
- Atom discovery requires the base model and capability registries; atom-pack materialization then populates the existing capability managers.
- Per-turn AgentLoop construction requires store, model, capability, memory, and policy facades but happens on session invocation, not cold start.
- Application handlers require `AgentExecutionService`, not a preconstructed `AgentLoop`.
- Schedule and channels require handlers but do not require each other.
- Mo launch follows successful Unix socket binding.

## Startup failure and rollback

When a required module fails:

1. Abort outstanding starts that honor the shared `AbortSignal`.
2. Do not schedule dependent layers.
3. Stop successfully started modules in reverse topological order.
4. Return one startup error containing the failed module and causal chain.

When an optional module fails:

- Mark it degraded.
- Continue modules that do not require it.
- Mark hard dependents blocked.
- Preserve its error for status and diagnostics.

Shutdown also follows reverse topological layers. Dependents stop before dependencies; independent modules in a reverse layer may stop concurrently.

## Runtime state store

Use `zustand/vanilla` for a daemon-local lifecycle store. `apps/monad` must declare Zustand as a direct dependency if this design is implemented; a transitive workspace dependency is not sufficient.

```ts
interface RuntimeState {
  phase: 'booting' | 'ready' | 'degraded' | 'stopping' | 'failed';
  modules: Record<ModuleId, ModuleRuntimeState>;
}

interface ModuleRuntimeState {
  criticality: ModuleCriticality;
  status: 'idle' | 'starting' | 'ready' | 'reloading' | 'degraded' | 'blocked' | 'failed' | 'stopped';
  generation: number;
  startedAt?: string;
  lastReloadAt?: string;
  durationMs?: number;
  error?: SerializedError;
}
```

The store contains no `MonadAuth`, API keys, child processes, sockets, MCP handles, database handles, promises, abort controllers, or module outputs. Store mutations report lifecycle results; they never trigger lifecycle effects.

Selectors may support logs, status endpoints, tests, and future UI surfaces. A UI or handler may observe `modules.mcp.status`; it must not set that status to initiate an MCP reconnect.

## ConfigService boundary

`ConfigService` is a long-lived daemon service and a sibling of `RuntimeKernel`. It does not own the kernel.

```ts
interface ConfigSnapshot {
  cfg: MonadConfig;
  auth: MonadAuth | null;
}

class ConfigService {
  get(): ConfigSnapshot;
  update(mutate: (cfg: MonadConfig) => MonadConfig): Promise<ConfigSnapshot>;
  refresh(): void;
  startWatching(): void;
  stop(): Promise<void>;
}
```

`update()` atomically persists the new configuration, invalidates the coordinator, and waits for the resulting single-flight apply to settle before returning. Concurrent callers share the active apply promise; they do not create per-event queue entries. `refresh()` is the fire-and-forget invalidation path used by filesystem watchers. `stop()` closes watchers and timers, then waits for an active apply to settle before returning.

Responsibilities:

- Delegate disk paths, parsing, validation, initialization, and persistence to `@monad/home`.
- Atomically save application-originated config changes using the existing home-layer APIs.
- Read config, profile, and auth as one logical snapshot.
- Watch config, profile, and auth inputs.
- Suppress unchanged snapshots.
- Feed accepted snapshots to `RuntimeKernel.reloadConfig()`.
- Rate-limit repeated parse warnings.

ConfigService must not redefine config schemas or filesystem layout. `@monad/home` remains the sole producer of those contracts.

Construction avoids a circular dependency:

```ts
const source = new ConfigSource(paths);
const initial = await source.load();

const kernel = new RuntimeKernel({
  initialConfig: initial,
  modules: createRuntimeModules()
});

const configService = new ConfigService({
  source,
  initial,
  apply: (snapshot) => kernel.reloadConfig(snapshot)
});

await kernel.start();
configService.startWatching();
```

Settings handlers call `ConfigService.update()` instead of saving config and publishing to ConfigBus themselves.

## Simplified hot reload

Hot reload exists to improve local UX. It is not a high-throughput event-processing system.

Use a trailing-edge, single-flight coordinator with only these internal concepts:

- `dirty`: at least one input may have changed.
- `applying`: one load/apply operation is running.
- `timer`: the trailing debounce timer.

Filesystem callbacks do not read, parse, compare, or apply configuration. They only invalidate the coordinator and reset the trailing timer.

```ts
request(): void {
  this.dirty = true;
  if (this.applying) return;
  this.scheduleTrailingFlush();
}
```

When the quiet window expires, the coordinator:

1. Clears `dirty`.
2. Marks itself applying.
3. Reads the current config/profile/auth files.
4. Parses and validates the complete snapshot.
5. Skips work if the accepted snapshot is unchanged.
6. Awaits `RuntimeKernel.reloadConfig()`.
7. Clears applying.
8. Schedules one more trailing flush if an event set `dirty` during the apply.

This guarantees:

- An event storm produces bounded work instead of one reload per filesystem event.
- Reload operations never overlap.
- An older reload cannot finish after a newer reload and overwrite it.
- The final file contents are read after the writer becomes quiet.

Do not add `maxWait` initially. A continuously misbehaving writer should not force periodic expensive reloads. Once the writer stops, the trailing flush applies its final output.

Invalid or partially written configuration does not replace the current runtime snapshot. The service logs a rate-limited validation warning and waits for another filesystem event. Application-originated writes remain atomic so normal settings updates do not expose partial JSON.

`reload()` implementations must await their own commits. Detached async mutations would bypass the single-flight guarantee and are prohibited unless guarded against stale commits.

## Configuration reload behavior

`RuntimeKernel.reloadConfig()` compares the accepted snapshot with the current snapshot and invokes only modules whose selected configuration changed. A module may implement its update as:

- In-place mutation of a stable service facade.
- Build, swap, then dispose the old internal resource.
- Stop and restart when an exclusive resource such as a fixed port prevents staging.

There is no global atomic rollback across modules, processes, sockets, and files. A module that cannot apply a new snapshot keeps its healthy old instance where possible and reports degraded state. A failed hot reload must not terminate a healthy daemon merely because that module is required at cold start. If both old and new required instances are unusable, the runtime remains available through its management surface when possible so the user can repair configuration.

## Transport and readiness split

Refactor the current terminal bootstrap responsibilities into lifecycle-owned units:

- HTTP app construction.
- TCP/HTTPS runtime and local HTTP fallback.
- Unix socket listener.
- Mo service and routes.
- Shutdown signal registration.
- Channel startup.
- Readiness reporting.

TCP and Unix socket continue to serve the same Elysia app. WebSocket push remains TCP-only. Unix socket binding remains best effort unless its module is explicitly configured as required. Socket permissions and network validation remain unchanged.

The readiness reporter depends on every full-ready participant. It prints the banner and ready information only after required modules are ready and optional modules have started, degraded, or become terminally blocked by an unavailable optional dependency. It advertises only listeners that actually bound.

## Observability

Measure before and after the migration even though there is no performance gate.

Record per module:

- Scheduled time.
- Start time and completion time.
- Duration.
- Reload duration.
- Criticality and terminal state.
- Error code and bounded message.

Log one startup summary containing total full-ready duration and the slowest modules. Store these values in the lifecycle store so tests and diagnostics use the same source of truth.

Do not add an environment variable for startup tracing. Use existing developer logging and observability configuration.

## Migration strategy

### Phase 1: lifecycle primitives

- Add module, graph, context, kernel, and lifecycle-store primitives.
- Test them entirely with fake modules.
- Keep `startDaemon()` behavior unchanged.

### Phase 2: ConfigService

- Wrap current `@monad/home` loading and persistence.
- Add the single-flight reload coordinator.
- Route settings writes and config/profile/auth watchers through ConfigService.
- Temporarily adapt ConfigService to existing reload functions while consumers migrate.

### Phase 3: co-located lifecycle adapters

- Move each existing bootstrap function toward its current owning domain without rewriting its internals.
- Add coarse lifecycle descriptors beside store, model, capabilities, atoms, channels, and transports.
- Import those descriptors from `runtime/create.ts` and move dependency ordering from statement order into the assembled graph.
- Move invoke-specific AgentLoop assembly into `AgentExecutionService.createTurn()`.
- Preserve current outputs and handler contracts.

### Phase 4: transport and background services

- Split `serveDaemon()` into transport, channel, Mo, shutdown, and readiness modules.
- Await channel terminal startup results for truthful full-ready.
- Preserve TCP/Unix behavior and all transport conformance tests.

### Phase 5: remove legacy orchestration

- Remove `ConfigBus` after its final consumer moves to ConfigService or a stable runtime facade.
- Remove `registerHotReload()` after module reload hooks own the remaining behavior.
- Reduce `startDaemon()` to mode selection, preflight, and `createRuntime()`.
- Split any touched file that remains beyond the repository's responsibility-size guideline.

## Testing

### Runtime graph unit tests

- Reject duplicate IDs, missing required dependencies, and cycles.
- Produce deterministic topological layers.
- Start independent modules concurrently.
- Never start a dependent before its requirements are ready.
- Roll back successful modules in reverse dependency order after a required failure.
- Continue after optional failure and mark hard dependents blocked.
- Stop independent modules concurrently within reverse layers.

### Runtime state tests

- Emit exact state transitions for start, reload, degrade, block, fail, and stop.
- Never expose module outputs or auth secrets through store state.
- Keep generation and timing fields monotonic and bounded.

### ConfigService tests

- Collapse a large filesystem-event burst into one read/apply.
- Never run two applies concurrently.
- If a write occurs during apply, run exactly one later trailing apply.
- Ensure the later apply reads the final file contents.
- Skip unchanged snapshots.
- Retain the current snapshot after parse or validation failure.
- Rate-limit repeated invalid-file warnings.
- Coalesce watcher events caused by an application-originated atomic write.

Use fake clocks and injected watch/load/apply functions; tests must not rely on real timing.

### Integration tests

- Reach full-ready only after required modules and enabled channel attempts complete.
- Verify daemon startup does not construct an `AgentLoop` or invoke a model.
- Verify each turn resolves the current profile, context, tools, skills, persona, policy, and sandbox configuration.
- Verify prompt replay and durable history state survive across turn-local AgentLoop instances.
- Keep a healthy previous module instance after reload failure.
- Reload model, skills, MCP, channels, policy, and locale through ConfigService.
- Preserve behavior over TCP loopback and Unix socket.
- Preserve stdio and ACP mode branching.
- Preserve shutdown cleanup for MCP children, channels, schedule timers, Mo, TCP listeners, and Unix socket listeners.

## Risks and mitigations

### Excessive abstraction

Mitigation: migrate coarse modules first, keep the public lifecycle contract small, and do not create generic hooks without a second concrete use.

### Hidden dependency migration

Mitigation: require every module output access to correspond to a declared dependency and validate access in tests or development mode.

### False concurrency

Mitigation: parallelize only after shared writes and mutable registries are identified. Registry-producing modules precede registry consumers.

### Reload races inside modules

Mitigation: require reload promises to include the commit and prohibit detached stale mutations. Keep stable service facades where possible.

### Startup hangs on external systems

Mitigation: every external connection module uses a bounded timeout and terminates as ready or degraded. Full-ready never waits on an unbounded promise.

### Configuration boundary drift

Mitigation: ConfigService delegates schemas, paths, parsing, and persistence to `@monad/home`; it adds orchestration, not a second config implementation.

## Acceptance criteria

- `startDaemon()` no longer encodes the main runtime dependency graph through statement order.
- The target structure has no one-file `bootstrap/` directory; `runtime/create.ts` is the composition root.
- `runtime/` contains only lifecycle mechanisms and graph assembly, with no duplicate `subsystems/` or flat `modules/` hierarchy.
- Existing agent, capabilities, atoms, channels, store, services, and transports directories remain the code ownership boundaries.
- Lifecycle adapters are colocated with their owning domains and imported by `runtime/create.ts`.
- Skills and MCP remain under capabilities rather than becoming peers of transports.
- Daemon startup creates only the stable agent execution facade; AgentLoop construction and invoke-specific configuration resolution happen per turn.
- Module dependencies and required/optional criticality are declared and validated.
- Independent startup layers run concurrently.
- Full-ready waits for all required modules to become ready and all optional modules to become ready, degraded, or terminally blocked.
- Required startup failure performs reverse-order cleanup.
- Config/profile/auth loading, writing, watching, and hot-apply entry points are unified behind ConfigService.
- A filesystem event storm causes bounded work and the final update is applied after the writer becomes quiet.
- No configuration reload operations overlap.
- Zustand exposes only serializable lifecycle state and is never used as a service locator or command bus.
- RxJS, revision tracking, and an event queue are not introduced.
- TCP and Unix socket behavior remains conformant.
- Existing security constraints, config source-of-truth rules, and cleanup behavior remain intact.
