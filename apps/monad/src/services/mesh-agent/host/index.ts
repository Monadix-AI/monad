import type {
  AgentObservationEvent,
  ListMeshAgentRuntimesQuery,
  ListMeshAgentRuntimesResponse,
  ListMeshSessionsResponse,
  MeshAgentApprovalResolutionRequest,
  MeshAgentAppServerTransport,
  MeshAgentAuthSessionView,
  MeshAgentAuthStatusResponse,
  MeshAgentInputRequest,
  MeshAgentLaunchMode,
  MeshAgentResizeRequest,
  MeshAgentUsageResponse,
  MeshAgentView,
  MeshConnectionSnapshot,
  MeshConvenienceEventPage,
  MeshConvenienceFrame,
  MeshEventPageRequest,
  MeshRawEvent,
  MeshRawEventPage,
  MeshSessionView
} from '@monad/protocol';
import type { MeshAgentEventPageRequest, MeshAgentProjectionPage } from '@monad/sdk-atom';
import type {
  LiveMeshSession,
  ManagedProjectOutputHandler,
  MeshAgentHostDeps
} from '#/services/mesh-agent/host/host-types.ts';
import type {
  MeshAgentConvenienceObservationResult,
  MeshAgentRawObservationResult
} from '#/services/mesh-agent/host/observation-resolve.ts';
import type { MeshAgentProviderAdapter, MeshAgentStartPreflight } from '#/services/mesh-agent/types.ts';
import type { MeshSessionRow } from '#/store/db/index.ts';
import type { MeshAgentTargetId } from '#/store/db/mesh-sessions.ts';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createLogger } from '@monad/logger';
import {
  formatObservationCursor,
  newId,
  observationCursorSchema,
  observationResume,
  parseObservationAfter
} from '@monad/protocol';
import { toFallbackAgentObservationEvent } from '@monad/sdk-atom';

import { MeshAgentAuthHost, type MeshAgentAuthListener } from '#/services/mesh-agent/auth-host.ts';
import { MAX_OUTPUT_SNAPSHOT } from '#/services/mesh-agent/constants.ts';
import { MeshAgentError } from '#/services/mesh-agent/errors.ts';
import { MeshAgentAppServerConnectionManager } from '#/services/mesh-agent/host/app-server-connection.ts';
import { MeshAgentOneshotRunner } from '#/services/mesh-agent/host/cli-oneshot.ts';
import { providerEventPageViaCli } from '#/services/mesh-agent/host/event-backfill.ts';
import { decodeEventCursor, type EventCursor, encodeEventCursor } from '#/services/mesh-agent/host/event-cursor.ts';
import { MeshAgentEventLog } from '#/services/mesh-agent/host/event-log.ts';
import { EVENT_PAGE_TIMEOUT_MS, MESH_AGENT_IDLE_TIMEOUT_MS } from '#/services/mesh-agent/host/host-constants.ts';
import { toView } from '#/services/mesh-agent/host/host-helpers.ts';
import { conveniencePatchFrame } from '#/services/mesh-agent/host/observation-dual.ts';
import { MeshAgentObservationHub } from '#/services/mesh-agent/host/observation-hub.ts';
import { MeshAgentObservationResolver } from '#/services/mesh-agent/host/observation-resolve.ts';
import { MeshAgentOutputPipeline } from '#/services/mesh-agent/host/output-pipeline.ts';
import { MeshAgentProcessLifecycle } from '#/services/mesh-agent/host/process-lifecycle.ts';
import { MeshSessionLauncher } from '#/services/mesh-agent/host/session-launcher.ts';
import { getMeshAgentProviderAdapter } from '#/services/mesh-agent/index.ts';
import {
  cleanupStaleLiveRawStores,
  LiveRawCursorExpiredError,
  LiveRawStore,
  liveRawRowsOutput
} from '#/services/mesh-agent/live-raw-store.ts';
import { MeshAgentLoginNudge } from '#/services/mesh-agent/login-nudge.ts';
import {
  cleanupManagedProjectRuntimeToken,
  managedProjectRuntimeWorkspace
} from '#/services/mesh-agent/managed-project.ts';
import { killMeshAgentProcess } from '#/services/mesh-agent/process.ts';
import { buildMeshAgentSpawnEnv, requireMeshAgent } from '#/services/mesh-agent/spawn-support.ts';

export type { MeshAgentHostDeps };

function providerEventPageRequest(req: MeshAgentEventPageRequest, cursor: EventCursor): MeshAgentEventPageRequest {
  const { before: _ignored, ...rest } = req;
  return { ...rest, ...(cursor.kind === 'provider' && cursor.token ? { before: cursor.token } : {}) };
}

const RUNTIME_LIST_DEFAULT_LIMIT = 100;

/** Positions are read back through the codec, never by re-parsing the cursor as a bare integer. A
 *  cursor from another epoch yields no position here, so it can never be mistaken for a row sequence
 *  in the current one. */
function lastRawSeq(frames: MeshRawEvent[]): number | undefined {
  return parseObservationAfter(frames.at(-1)?.cursor)?.seq;
}

/** The delivered position of a convenience batch: the `ready` anchor, or the patch that followed it. */
function conveniencePatchSeq(frames: MeshConvenienceFrame[], epoch: string): number | undefined {
  for (const frame of [...frames].reverse()) {
    const cursor = frame.kind === 'patch' ? frame.cursor : frame.kind === 'ready' ? frame.cursor : undefined;
    const position = parseObservationAfter(cursor);
    if (position?.observationEpoch === epoch) return position.seq;
  }
  return undefined;
}

/** Slices an already-ordered array by an opaque position cursor (`before` = index to stop before).
 *  Used by the daemon-wide runtime overview lists, which are in-memory/SQLite arrays, not a keyset
 *  index — a numeric offset-as-cursor is sufficient since these lists are read-mostly per poll. */
function sliceByCursor<T>(items: T[], query: ListMeshAgentRuntimesQuery): { page: T[]; nextCursor?: string } {
  const end = query.before ? Math.max(0, Math.min(items.length, Number.parseInt(query.before, 10) || 0)) : items.length;
  const limit = query.limit ?? RUNTIME_LIST_DEFAULT_LIMIT;
  const start = Math.max(0, end - limit);
  return { page: items.slice(start, end), ...(start > 0 ? { nextCursor: String(start) } : {}) };
}

export class MeshAgentHost {
  private readonly log = createLogger('mesh-agent');

  private readonly live = new Map<string, LiveMeshSession>();
  private readonly observation = new MeshAgentObservationHub({
    getLive: (id) => this.live.get(id)
  });
  private managedProjectOutputHandler: ManagedProjectOutputHandler | null = null;
  /** Provider-login (auth) sessions and one-shot auth/usage probes live in their own host; they share
   *  no state with interactive sessions. Public auth methods below delegate straight through. */
  private readonly authHost: MeshAgentAuthHost;
  /** In-chat re-login nudge: verifies a connection_required is a real auth failure, then publishes the
   *  ephemeral login_required/login_resolved pair. */
  private readonly loginNudge: MeshAgentLoginNudge;
  private readonly disposeLoginNudge: () => void;
  /** Builds and dispatches durable/ephemeral MeshAgent session events. */
  private readonly events: MeshAgentEventLog;
  /** Owns app-server socket/port allocation and the disconnect→redial→give-up flow. */
  private readonly appServerConnections: MeshAgentAppServerConnectionManager;
  /** Owns lossless live capture and structured-event decoding for child-process output. */
  private readonly outputPipeline: MeshAgentOutputPipeline;
  /** Runs `cli-oneshot` sessions: a logical session with no persistent process. */
  private readonly oneshotRunner: MeshAgentOneshotRunner;
  /** Mirrors spawned/exited child pids into the daemon-wide child-process registry and the durable
   *  on-disk registry file, and reconciles orphans left by an uncleanly-stopped daemon. */
  private readonly processLifecycle: MeshAgentProcessLifecycle;
  /** Builds and spawns a fresh MeshAgent session (agent/launch resolution, process spawn, stream
   *  wiring, exit/idle-resume bookkeeping). */
  private readonly sessionLauncher: MeshSessionLauncher;
  /** Resolves observation from the ephemeral live store or earlier provider events. */
  private readonly observationResolver: MeshAgentObservationResolver;
  private readonly liveRawStoreDirectory: string;
  private readonly liveRawStoreCleanup: Promise<Error | undefined>;

  constructor(private readonly deps: MeshAgentHostDeps) {
    this.liveRawStoreDirectory =
      deps.meshAgentLiveStoreDirectory ?? join(tmpdir(), `monad-mesh-agent-live-${process.pid}`);
    this.liveRawStoreCleanup = cleanupStaleLiveRawStores(this.liveRawStoreDirectory)
      .then(() => undefined)
      .catch((error) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.log.error(
          { event: 'mesh.live_observation_cleanup_failed', err: failure.message },
          'stale native cli live observation cleanup failed'
        );
        return failure;
      });
    this.loginNudge = new MeshAgentLoginNudge({
      bus: deps.bus,
      authStatus: (agentName) => this.authHost.authStatus(agentName)
    });
    this.disposeLoginNudge = this.loginNudge.start();
    this.authHost = new MeshAgentAuthHost({
      ...deps,
      onAuthenticated: (info) => this.loginNudge.resolveAuthenticated(info)
    });
    this.events = new MeshAgentEventLog({ store: deps.store, bus: deps.bus });
    this.appServerConnections = new MeshAgentAppServerConnectionManager({
      live: this.live,
      emit: (sessionId, type, payload) => this.events.emit(sessionId, type, payload),
      stop: (id) => this.stop(id),
      log: this.log,
      reconnectBaseMs: deps.appServerReconnectBaseMs,
      disconnectGraceMs: deps.appServerDisconnectGraceMs,
      rotateLiveCapture: (live) => this.rotateLiveCapture(live)
    });
    this.outputPipeline = new MeshAgentOutputPipeline({
      live: this.live,
      store: deps.store,
      events: this.events,
      observation: this.observation,
      stop: (id) => this.stop(id),
      getManagedProjectOutputHandler: () => this.managedProjectOutputHandler,
      log: this.log,
      armIdleSuspend: (live) => this.armIdleSuspend(live)
    });
    this.processLifecycle = new MeshAgentProcessLifecycle({
      store: deps.store,
      monadHome: deps.monadHome,
      meshAgentProcessRegistryPath: deps.meshAgentProcessRegistryPath,
      authProcessRegistryPath: deps.authProcessRegistryPath
    });
    this.oneshotRunner = new MeshAgentOneshotRunner({
      live: this.live,
      store: deps.store,
      events: this.events,
      outputPipeline: this.outputPipeline,
      buildSpawnEnv: (adapter, env) => this.buildSpawnEnv(adapter, env),
      trackProcess: (pid) => this.processLifecycle.track(pid),
      untrackProcess: (pid) => this.processLifecycle.untrack(pid),
      openLiveRawStore: (id, epoch) => this.openLiveRawStore(id, epoch)
    });
    this.sessionLauncher = new MeshSessionLauncher({
      deps,
      live: this.live,
      log: this.log,
      events: this.events,
      observation: this.observation,
      appServerConnections: this.appServerConnections,
      outputPipeline: this.outputPipeline,
      oneshotRunner: this.oneshotRunner,
      requireAgent: (name) => this.requireAgent(name),
      buildSpawnEnv: (adapter, env) => this.buildSpawnEnv(adapter, env),
      trackProcess: (pid) => this.processLifecycle.track(pid),
      untrackProcess: (pid) => this.processLifecycle.untrack(pid),
      armIdleSuspend: (live) => this.armIdleSuspend(live),
      idleTimeoutMs: () => this.idleTimeoutMs(),
      updateMeshAgentPid: (id, pid) => this.updateMeshAgentPid(id, pid),
      openLiveRawStore: (id, epoch) => this.openLiveRawStore(id, epoch),
      emitConnectionClosed: (live, reason) => this.emitConnectionClosed(live, reason)
    });
    this.observationResolver = new MeshAgentObservationResolver({
      live: this.live,
      store: deps.store
    });
  }

  private openLiveRawStore(id: string, epoch: string): LiveRawStore {
    return LiveRawStore.open({ directory: this.liveRawStoreDirectory, sessionId: id, epoch });
  }

  private rotateLiveCapture(live: LiveMeshSession): void {
    void live.liveRawStore?.closeAndDelete();
    live.outputSeq = 0;
    live.observationEpoch = newId('oep');
    live.liveRawStore = this.openLiveRawStore(live.id, live.observationEpoch);
    live.observationEpochReady = false;
    this.observation.publish(live.id);
  }

  setManagedProjectOutputHandler(handler: ManagedProjectOutputHandler): void {
    this.managedProjectOutputHandler = handler;
  }

  private buildSpawnEnv(
    adapter: MeshAgentProviderAdapter,
    launchEnv?: Record<string, string>
  ): Promise<Record<string, string>> {
    return buildMeshAgentSpawnEnv(this.deps.resolveAgentEnv, adapter, launchEnv);
  }

  private requireAgent(name: string): Promise<MeshAgentView> {
    return requireMeshAgent(this.deps.agents, name);
  }

  private managedRuntimeWorkspace(
    row: Pick<MeshSessionRow, 'agentName' | 'transcriptTargetId' | 'workingPath'>
  ): string {
    return managedProjectRuntimeWorkspace({
      monadHome: this.deps.monadHome ?? dirname(this.deps.meshAgentProcessRegistryPath ?? row.workingPath),
      projectId: row.transcriptTargetId,
      agentName: row.agentName
    });
  }

  private idleTimeoutMs(): number {
    return this.deps.meshAgentIdleTimeoutMs ?? MESH_AGENT_IDLE_TIMEOUT_MS;
  }

  private canIdleSuspend(live: LiveMeshSession): boolean {
    return Boolean(
      live.restartRuntime &&
        live.idleTimeoutMs &&
        live.idleTimeoutMs > 0 &&
        live.launchMode !== 'pty' &&
        live.launchMode !== 'cli-oneshot' &&
        live.pendingApprovals.size === 0 &&
        live.pendingEventPages.size === 0 &&
        live.pendingRequests.size === 0 &&
        !live.startup &&
        !live.appServerReconnecting &&
        !live.suspended
    );
  }

  private armIdleSuspend(live: LiveMeshSession): void {
    if (live.idleTimer) {
      clearTimeout(live.idleTimer);
      live.idleTimer = undefined;
    }
    if (!this.canIdleSuspend(live)) return;
    live.idleTimer = setTimeout(() => this.suspendIdleRuntime(live.id), live.idleTimeoutMs);
  }

  private updateMeshAgentPid(id: string, pid: number | null): void {
    const row = this.deps.store.getMeshSession(id);
    if (row?.state !== 'running') return;
    this.deps.store.upsertMeshSession({
      ...row,
      pid,
      updatedAt: new Date().toISOString()
    });
  }

  private suspendIdleRuntime(id: string): void {
    const live = this.live.get(id);
    if (!live || !this.canIdleSuspend(live)) return;
    const idleTimeoutMs = live.idleTimeoutMs;
    if (idleTimeoutMs === undefined) return;
    live.suspended = true;
    if (live.idleTimer) {
      clearTimeout(live.idleTimer);
      live.idleTimer = undefined;
    }
    try {
      live.terminal?.close();
      void live.stdin?.end?.();
      live.appServer?.close();
    } catch {
      /* already closed */
    }
    live.adapter.stop(live);
    const pid = live.proc?.pid;
    if (pid !== undefined) {
      killMeshAgentProcess(pid);
      this.processLifecycle.untrack(pid);
    }
    live.proc = undefined;
    live.terminal = undefined;
    live.stdin = undefined;
    live.appServer = undefined;
    live.appServerRedial = undefined;
    live.appServerReconnecting = false;
    live.pendingRequests.clear();
    this.appServerConnections.unlinkSocket(live.appServerSocketPath);
    void live.liveRawStore?.closeAndDelete();
    this.emitConnectionClosed(live, 'disconnected');
    this.updateMeshAgentPid(id, null);
    this.observation.publish(id);
    this.events.emit(live.transcriptTargetId, 'mesh.idle_suspended', {
      agentId: live.agentName,
      agentName: live.displayName ?? live.agentName,
      type: 'idle_suspended',
      payload: { meshSessionId: live.id, idleTimeoutMs }
    });
    this.log.debug(
      { sessionId: live.transcriptTargetId, event: 'mesh.idle_suspended', meshSessionId: id },
      'native cli idle suspended'
    );
  }

  private async sendInputAfterResume(live: LiveMeshSession, input: string): Promise<void> {
    const send = async (): Promise<void> => {
      if (live.suspended) {
        if (!live.restartRuntime)
          throw new MeshAgentError('unsupported_capability', `MeshAgent cannot resume: ${live.id}`);
        await this.prepareObservationEpoch(live);
        await live.restartRuntime();
      } else {
        await this.prepareObservationEpoch(live);
      }
      this.armIdleSuspend(live);
      live.adapter.sendInput(live, input);
    };
    const run = (live.resumeQueue ?? Promise.resolve()).then(send);
    live.resumeQueue = run.catch(() => undefined);
    try {
      await run;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.outputPipeline.output(live.transcriptTargetId, live.id, message, 'stderr', live.adapter);
      throw error;
    }
  }

  // Provider connectivity (observation-source readiness), distinct from process lifecycle. These are
  // transient control-plane facts the Observation panel keys its subscription on; `connectionOpen`
  // makes the pair idempotent. Emitted here (Observation Task 5) since the epoch lifecycle is owned by
  // the host, not the launcher.
  private emitConnectionOpened(live: LiveMeshSession): void {
    live.connectionOpen = true;
    this.events.publish(live.transcriptTargetId, 'mesh.session.connection.opened', {
      meshSessionId: live.id,
      provider: live.provider,
      observationEpoch: live.observationEpoch
    });
  }

  private emitConnectionClosed(live: LiveMeshSession, reason: 'exited' | 'failed' | 'stopped' | 'disconnected'): void {
    if (!live.connectionOpen) return;
    live.connectionOpen = false;
    this.events.publish(live.transcriptTargetId, 'mesh.session.connection.closed', {
      meshSessionId: live.id,
      provider: live.provider,
      observationEpoch: live.observationEpoch,
      reason
    });
  }

  private async prepareObservationEpoch(live: LiveMeshSession): Promise<void> {
    if (live.observationEpochReady) return;
    if (live.observationEpochPreparation) return live.observationEpochPreparation;
    const prepare = async () => {
      let checkpoint: string | undefined;
      const identities = new Set<string>();
      const providerSessionRef = live.providerSessionRef ?? live.initializeContext?.providerSessionRef ?? undefined;
      const workingPath = live.initializeContext?.workingPath;
      if (providerSessionRef && workingPath && live.adapter.events.readPage) {
        try {
          const result = await live.adapter.events.readPage(
            { providerSessionRef, workingPath, limitBytes: MAX_OUTPUT_SNAPSHOT },
            { view: 'convenience', limit: 100 }
          );
          if (result.state === 'available' && result.view === 'convenience') {
            for (const event of result.events) {
              if (event.dedupeKey) identities.add(event.dedupeKey);
            }
            checkpoint = result.events.findLast((event) => event.dedupeKey)?.dedupeKey;
          }
        } catch (error) {
          this.log.debug(
            {
              event: 'mesh.event_checkpoint_failed',
              meshSessionId: live.id,
              provider: live.provider,
              err: error instanceof Error ? error.message : String(error)
            },
            'provider event checkpoint unavailable'
          );
        }
      }
      live.providerEventCheckpoint = checkpoint;
      live.providerEventIdentities = identities;
      live.outputSeq = 0;
      this.emitConnectionClosed(live, 'disconnected');
      void live.liveRawStore?.closeAndDelete();
      live.observationEpoch = newId('oep');
      live.liveRawStore = this.openLiveRawStore(live.id, live.observationEpoch);
      live.observationEpochReady = true;
      this.emitConnectionOpened(live);
      this.observation.publish(live.id);
    };
    const pending = prepare();
    live.observationEpochPreparation = pending;
    try {
      await pending;
    } finally {
      if (live.observationEpochPreparation === pending) live.observationEpochPreparation = undefined;
    }
  }

  reconcileOrphanedSessions(): Promise<number> {
    return this.processLifecycle.reconcileOrphanedSessions();
  }

  async start(args: {
    transcriptTargetId: MeshAgentTargetId;
    agentName: string;
    displayName?: string;
    templateAgentName?: string;
    workingPath: string;
    launchMode?: MeshAgentLaunchMode;
    appServerTransport?: MeshAgentAppServerTransport;
    runtimeRole?: MeshSessionView['runtimeRole'];
    providerSessionRef?: string;
    modelName?: string;
    modelId?: string;
    reasoningEffort?: string;
    speed?: 'standard' | 'fast';
    customPrompt?: string;
    /** Per-member override of the agent template's `allowAutopilot`. When OFF and the adapter can
     *  proxy approvals in the effective launch mode, a managed agent delegates its provider approvals
     *  to the human instead of running unattended. */
    allowAutopilot?: boolean;
  }): Promise<MeshSessionView> {
    const cleanupFailure = await this.liveRawStoreCleanup;
    if (cleanupFailure) throw cleanupFailure;
    return this.sessionLauncher.start(args);
  }

  async input(id: string, req: MeshAgentInputRequest): Promise<void> {
    const live = this.live.get(id);
    if (!live) throw new Error(`MeshAgent session is not running: ${id}`);
    this.log.debug(
      {
        sessionId: live.transcriptTargetId,
        event: 'mesh.input',
        meshSessionId: id,
        input: req.input
      },
      'native cli input'
    );
    // cli-oneshot has no persistent process to write to — spawn a fresh process for this turn instead.
    // Turns are chained on a per-session queue so concurrent deliveries run sequentially (one process
    // at a time), never clobbering the in-flight turn or interleaving output.
    if (live.launchMode === 'cli-oneshot') {
      live.oneshotQueue = (live.oneshotQueue ?? Promise.resolve())
        .then(() => this.oneshotRunner.runTurn(live, req.input))
        .catch(() => undefined);
      return;
    }
    if (live.suspended) {
      await this.sendInputAfterResume(live, req.input);
      return;
    }
    // Between a socket drop and a completed redial, `live.appServer` still references the dead
    // connection (`reconnectAppServer` only reassigns it on success) — it stays truthy, so an adapter's
    // own `!handle.appServer` guard doesn't catch this window. Sending into it would silently vanish
    // (a closed socket's `send` typically no-ops rather than throwing), so fail loudly here instead.
    if (live.appServerReconnecting) {
      throw new MeshAgentError('provider_timeout', `MeshAgent app-server is reconnecting, cannot send input: ${id}`);
    }
    await this.prepareObservationEpoch(live);
    this.armIdleSuspend(live);
    live.adapter.sendInput(live, req.input);
  }

  /** Cancel the in-flight turn while keeping the session/thread alive. If the provider adapter offers
   *  no graceful interrupt, fall back to stopping the session so the request is never a no-op. */
  interrupt(id: string): void {
    const live = this.live.get(id);
    if (!live) throw new Error(`MeshAgent session is not running: ${id}`);
    this.log.debug(
      { sessionId: live.transcriptTargetId, event: 'mesh.interrupt', meshSessionId: id },
      'native cli interrupt'
    );
    if (live.adapter.interrupt) live.adapter.interrupt(live);
    else this.stop(id);
  }

  steer(id: string, req: MeshAgentInputRequest): void {
    const live = this.live.get(id);
    if (!live) throw new Error(`MeshAgent session is not running: ${id}`);
    if (!live.adapter.steer)
      throw new MeshAgentError('unsupported_capability', `MeshAgent provider does not support steering: ${id}`);
    this.log.debug({ sessionId: live.transcriptTargetId, event: 'mesh.steer', meshSessionId: id }, 'native cli steer');
    live.adapter.steer(live, req.input);
  }

  get(id: string): MeshSessionView {
    const row = this.deps.store.getMeshSession(id);
    if (!row) throw new Error(`MeshAgent session not found: ${id}`);
    const live = this.live.get(id);
    return toView(row, live?.pendingApprovals.size ?? 0);
  }

  list(transcriptTargetId: MeshAgentTargetId): ListMeshSessionsResponse {
    return {
      sessions: this.deps.store.listMeshSessionsForTranscriptTarget(transcriptTargetId).map((row) => {
        const live = this.live.get(row.id);
        return toView(row, live?.pendingApprovals.size ?? 0);
      })
    };
  }

  /** Every MeshAgent runtime across the daemon without output buffers. Used by overview surfaces
   *  that need durable counters such as unread messages even after a runtime exits. */
  listAllSummaries(query: ListMeshAgentRuntimesQuery = {}): ListMeshAgentRuntimesResponse {
    const views = this.deps.store.listMeshSessions().map((row) => {
      const live = this.live.get(row.id);
      return toView(row, live?.pendingApprovals.size ?? 0);
    });
    const { page, nextCursor } = sliceByCursor(views, query);
    return { sessions: page, ...(nextCursor ? { nextCursor } : {}) };
  }

  /** Every live (starting/running) runtime across the daemon, all projects — for the daemon-wide
   *  runtime overview, so the web polls once instead of once per project. Output snapshots are
   *  dropped: this is a status list (state/provider/name), and shipping every live session's
   *  (up to 256 KB) buffer on each poll is bandwidth no overview consumer reads. */
  listLive(query: ListMeshAgentRuntimesQuery = {}): ListMeshAgentRuntimesResponse {
    const views = this.deps.store.listLiveMeshSessions().map((row) => {
      const live = this.live.get(row.id);
      return toView(row, live?.pendingApprovals.size ?? 0);
    });
    const { page, nextCursor } = sliceByCursor(views, query);
    return { sessions: page, ...(nextCursor ? { nextCursor } : {}) };
  }

  observeRaw(id: string, afterSeq?: number): MeshAgentRawObservationResult {
    return this.observationResolver.observeRaw(id, afterSeq);
  }

  observeConvenience(id: string, afterSeq?: number): MeshAgentConvenienceObservationResult {
    return this.observationResolver.observeConvenience(id, afterSeq);
  }

  connectionSnapshot(id: string): MeshConnectionSnapshot {
    return this.observationResolver.connectionSnapshot(id);
  }

  /** The raw diagnostic plane over SSE: rides the observation hub's throttle/lifecycle but, on every
   *  tick, reads only the committed raw rows AFTER the last delivered cursor, so a subscriber receives
   *  each verbatim provider frame exactly once and in order (never a re-derived list). */
  subscribeRawObservation(
    id: string,
    handlers: { onFrame: (frame: MeshRawEvent) => void; onDone: () => void },
    opts?: { after?: string }
  ): { frames: MeshRawEvent[]; live: boolean; dispose: () => void } {
    const probe = this.observeRaw(id);
    if (probe.state !== 'live') return { frames: [], live: false, dispose: () => {} };
    // `observationResume` is the one place a stale cursor is judged, so this plane and the
    // convenience plane cannot answer the same cursor differently.
    const resume = observationResume(opts?.after, probe.observationEpoch);
    const initial = resume.kind === 'after' ? this.observeRaw(id, resume.seq) : probe;
    if (initial.state !== 'live') return { frames: [], live: false, dispose: () => {} };
    let lastEpoch = initial.observationEpoch;
    let lastSeq = lastRawSeq(initial.frames) ?? (resume.kind === 'after' ? resume.seq : undefined);
    const initialFrames = [...initial.frames];
    while (lastSeq !== undefined) {
      const next = this.observeRaw(id, lastSeq);
      if (next.state !== 'live' || next.frames.length === 0) break;
      initialFrames.push(...next.frames);
      const seq = lastRawSeq(next.frames);
      if (seq === undefined || seq === lastSeq) break;
      lastSeq = seq;
    }
    const sub = this.observation.subscribe(
      id,
      (signal, done) => {
        // An epoch rotation (idle resume / reconnect) restarts the row cursor from 1, so a `seq` from the
        // previous epoch would skip the new epoch's opening frames — re-read the whole epoch instead.
        const epoch = signal.state === 'live' ? signal.observationEpoch : undefined;
        const epochChanged = epoch !== undefined && epoch !== lastEpoch;
        let next = this.observeRaw(id, epochChanged ? undefined : lastSeq);
        while (next.state === 'live') {
          for (const frame of next.frames) handlers.onFrame(frame);
          lastEpoch = next.observationEpoch;
          const seq = lastRawSeq(next.frames);
          if (seq === undefined) {
            if (epochChanged) lastSeq = undefined;
            break;
          }
          if (seq === lastSeq) break;
          lastSeq = seq;
          next = this.observeRaw(id, lastSeq);
        }
        if (done) handlers.onDone();
      },
      lastSeq
    );
    if (!sub.live) return { frames: initialFrames, live: false, dispose: () => {} };
    return { frames: initialFrames, live: true, dispose: sub.dispose };
  }

  /** The convenience plane over SSE: a `ready` handshake then one atomic patch per tick carrying only
   *  what the projection actually changed since the last delivered position. On disconnect it emits a
   *  terminal `unavailable`. */
  subscribeConvenienceObservation(
    id: string,
    onFrame: (frame: MeshConvenienceFrame, done: boolean) => void,
    opts?: { after?: string }
  ): { frames: MeshConvenienceFrame[]; live: boolean; dispose: () => void } {
    const probe = this.observeConvenience(id);
    if (probe.state !== 'live')
      return { frames: [{ kind: 'unavailable', reason: probe.reason }], live: false, dispose: () => {} };
    const resume = observationResume(opts?.after, probe.observationEpoch);
    const initial = resume.kind === 'after' ? this.observeConvenience(id, resume.seq) : probe;
    if (initial.state !== 'live')
      return { frames: [{ kind: 'unavailable', reason: initial.reason }], live: false, dispose: () => {} };
    let lastEpoch = initial.observationEpoch;
    let lastSeq = conveniencePatchSeq(initial.frames, lastEpoch) ?? (resume.kind === 'after' ? resume.seq : undefined);
    const sub = this.observation.subscribe(
      id,
      (signal, done) => {
        // An epoch rotation restarts row sequences at 1, so a position from the previous epoch would
        // diff against the wrong baseline — re-project the new epoch from its start instead.
        const epoch = signal.state === 'live' ? signal.observationEpoch : undefined;
        const epochChanged = epoch !== undefined && epoch !== lastEpoch;
        const next = this.observeConvenience(id, epochChanged ? undefined : lastSeq);
        if (next.state === 'live') {
          lastEpoch = next.observationEpoch;
          lastSeq = conveniencePatchSeq(next.frames, lastEpoch) ?? lastSeq;
          for (const frame of next.frames) {
            if (frame.kind === 'patch' || (epochChanged && frame.kind === 'ready')) onFrame(frame, false);
          }
        }
        if (done) onFrame({ kind: 'unavailable', reason: `MeshAgent disconnected: ${id}` }, true);
      },
      lastSeq
    );
    if (!sub.live) return { frames: initial.frames, live: false, dispose: () => {} };
    return { frames: initial.frames, live: true, dispose: sub.dispose };
  }

  /** A page of exact provider-native events before projection, merging, or deduplication. */
  async rawEventsPage(id: string, req: Omit<MeshEventPageRequest, 'view'>): Promise<MeshRawEventPage> {
    const live = this.live.get(id);
    if (live && !live.suspended) {
      const providerSessionRef = live.providerSessionRef ?? live.initializeContext?.providerSessionRef ?? undefined;
      if (req.before?.startsWith('live:') && live.liveRawStore) {
        try {
          const before = live.liveRawStore.parseCursor(req.before);
          const page = live.liveRawStore.page({
            before,
            limit: req.limit,
            maxBytes: MAX_OUTPUT_SNAPSHOT,
            sortDirection: 'desc'
          });
          return {
            records: page.rows.map((row) => ({
              cursor: live.liveRawStore.cursorBefore(row.seq),
              data: row.payload,
              observedAt: row.observedAt
            })),
            coverage: 'exact',
            ...(page.nextBefore !== undefined
              ? { nextCursor: live.liveRawStore.cursorBefore(page.nextBefore) }
              : providerSessionRef
                ? { nextCursor: encodeEventCursor('') }
                : {})
          };
        } catch (error) {
          if (!(error instanceof LiveRawCursorExpiredError)) throw error;
        }
      }
      const workingPath = live.initializeContext?.workingPath;
      const cursor = decodeEventCursor(req.before);
      if (live.adapter.events.readPage && providerSessionRef && workingPath) {
        const result = await live.adapter.events.readPage(
          {
            providerSessionRef,
            workingPath,
            limitBytes: MAX_OUTPUT_SNAPSHOT,
            requestProviderPage: (send) => this.requestProviderEventPage(live, send)
          },
          {
            ...(cursor.kind === 'provider' && cursor.token ? { before: cursor.token } : {}),
            view: 'raw',
            limit: req.limit
          }
        );
        if (result.state === 'available' && result.view === 'raw') {
          return {
            records: result.records,
            coverage: result.coverage,
            ...(result.nextCursor ? { nextCursor: encodeEventCursor(result.nextCursor) } : {})
          };
        }
      }
      return { records: [], coverage: 'settled' };
    }
    const row = this.deps.store.getMeshSession(id);
    if (row?.providerSessionRef) {
      const adapter = getMeshAgentProviderAdapter(row.provider);
      const cursor = decodeEventCursor(req.before);
      if (adapter.events.readPage) {
        const result = await adapter.events.readPage(
          { providerSessionRef: row.providerSessionRef, workingPath: row.workingPath, limitBytes: MAX_OUTPUT_SNAPSHOT },
          {
            ...(cursor.kind === 'provider' && cursor.token ? { before: cursor.token } : {}),
            view: 'raw',
            limit: req.limit
          }
        );
        if (result.state === 'available' && result.view === 'raw') {
          return {
            records: result.records,
            coverage: result.coverage,
            ...(result.nextCursor ? { nextCursor: encodeEventCursor(result.nextCursor) } : {})
          };
        }
      }
    }
    return { records: [], coverage: 'settled' };
  }

  /** Earlier provider events projected into the neutral convenience plane and mapped to `upsert`
   *  frames a consumer merges into its timeline. */
  async convenienceEventsPage(id: string, req: Omit<MeshEventPageRequest, 'view'>): Promise<MeshConvenienceEventPage> {
    const provider = this.live.get(id)?.provider ?? this.deps.store.getMeshSession(id)?.provider;
    if (!provider) return { frames: [] };
    let page: MeshAgentProjectionPage;
    try {
      page = await this.projectedEventsPage(id, { ...req, view: 'convenience' });
    } catch (error) {
      if (error instanceof MeshAgentError && error.code === 'unsupported_capability') return { frames: [] };
      throw error;
    }
    const adapter = getMeshAgentProviderAdapter(provider);
    const runtime = adapter.observationRuntime;
    const events = page.events
      .map((event) =>
        runtime ? runtime.toAgentObservationEvent(event) : toFallbackAgentObservationEvent(event, adapter.observation)
      )
      .filter((event): event is AgentObservationEvent => event !== null);
    // An event page is request/response, so its patch carries the provider position the page was
    // taken at (an absent `before` being the latest page) rather than a live row sequence.
    const requestedCursor = decodeEventCursor(req.before);
    const patch = conveniencePatchFrame(
      requestedCursor.kind === 'none'
        ? formatObservationCursor({ kind: 'provider', token: '' })
        : formatObservationCursor(requestedCursor),
      events.map((event) => ({ op: 'upsert', event }))
    );
    return {
      frames: patch ? [patch] : [],
      ...(page.nextCursor ? { nextCursor: observationCursorSchema.parse(page.nextCursor) } : {})
    };
  }

  resize(id: string, req: MeshAgentResizeRequest): void {
    const live = this.live.get(id);
    if (!live) throw new Error(`MeshAgent session is not running: ${id}`);
    this.log.debug(
      {
        sessionId: live.transcriptTargetId,
        event: 'mesh.resize',
        meshSessionId: id,
        cols: req.cols,
        rows: req.rows
      },
      'native cli resize'
    );
    live.adapter.resize(live, req.cols, req.rows);
  }

  resolveApproval(id: string, req: MeshAgentApprovalResolutionRequest): void {
    const live = this.live.get(id);
    if (!live) throw new Error(`MeshAgent session is not running: ${id}`);
    const request = live.pendingApprovals.get(req.requestId);
    live.adapter.resolveApproval(live, { ...req, request });
    live.pendingApprovals.delete(req.requestId);
    this.events.emit(live.transcriptTargetId, 'mesh.approval_resolved', {
      meshSessionId: id,
      provider: live.adapter.provider,
      requestId: req.requestId,
      allow: req.allow,
      ...(req.reason ? { reason: req.reason } : {})
    });
  }

  stop(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    this.log.debug({ sessionId: live.transcriptTargetId, event: 'mesh.stop', meshSessionId: id }, 'native cli stop');
    try {
      live.terminal?.close();
      void live.stdin?.end?.();
      live.appServer?.close();
    } catch {
      /* already closed */
    }
    if (live.appServerStreakResetTimer) {
      clearTimeout(live.appServerStreakResetTimer);
      live.appServerStreakResetTimer = undefined;
    }
    if (live.idleTimer) {
      clearTimeout(live.idleTimer);
      live.idleTimer = undefined;
    }
    for (const pending of live.pendingEventPages.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`MeshAgent session stopped before event page response: ${id}`));
    }
    live.pendingEventPages.clear();
    if (live.startup) {
      clearTimeout(live.startup.timeout);
      live.startup.reject(new Error(`MeshAgent session stopped before app-server thread was ready: ${id}`));
      live.startup = undefined;
    }
    live.adapter.stop(live);
    // cli-oneshot has no persistent proc; kill any in-flight per-turn process instead.
    if (live.oneshotTurnProc) {
      if (live.oneshotTurnProc.supervision) live.oneshotTurnProc.supervision.stop('manual', 'SIGTERM');
      else {
        killMeshAgentProcess(live.oneshotTurnProc.pid);
        this.processLifecycle.untrack(live.oneshotTurnProc.pid);
      }
      live.oneshotTurnProc = undefined;
    }
    void live.liveRawStore?.closeAndDelete();
    this.live.delete(id);
    const row = this.deps.store.getMeshSession(id);
    if (row?.runtimeRole === 'managed-project-agent')
      cleanupManagedProjectRuntimeToken(this.managedRuntimeWorkspace(row));
    if (live.proc) {
      if (live.proc.supervision) live.proc.supervision.stop('manual', 'SIGTERM');
      else {
        killMeshAgentProcess(live.proc.pid);
        this.processLifecycle.untrack(live.proc.pid);
      }
    }
    this.outputPipeline.dropStructuredBuffer(id);
    this.appServerConnections.unlinkSocket(live.appServerSocketPath);
    const exitedAt = new Date().toISOString();
    this.emitConnectionClosed(live, 'stopped');
    this.deps.store.closeMeshSession(id, exitedAt, null, 'stopped');
    this.events.emit(live.transcriptTargetId, 'mesh.exited', {
      meshSessionId: id,
      exitCode: null,
      state: 'stopped'
    });
  }

  stopSession(sessionId: MeshAgentTargetId): void {
    for (const live of [...this.live.values()]) {
      if (live.transcriptTargetId === sessionId) this.stop(live.id);
    }
  }

  stopAll(): void {
    this.disposeLoginNudge();
    for (const id of [...this.live.keys()]) {
      try {
        this.stop(id);
      } catch (error) {
        this.log.error(
          {
            event: 'mesh.stop_all_failed',
            meshSessionId: id,
            err: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
          },
          'native cli stop-all failed'
        );
      }
    }
  }

  stopAgentProvider(provider: MeshAgentView['provider']): void {
    let stopped = 0;
    for (const live of [...this.live.values()]) {
      if (live.provider === provider) {
        stopped++;
        this.stop(live.id);
      }
    }
    if (stopped > 0)
      this.log.debug(
        { event: 'mesh.stop_agent_provider', provider, stopped },
        'native cli stopped sessions for agent provider'
      );
  }

  async projectedEventsPage(id: string, req: MeshAgentEventPageRequest): Promise<MeshAgentProjectionPage> {
    const live = this.live.get(id);
    if (!live) return this.storedProjectedEventsPage(id, req);
    // Decode rather than prefix-match: a hand-rolled `startsWith` is how a second grammar creeps back
    // in, and it would accept a malformed `live:` string the codec rejects.
    const livePosition = parseObservationAfter(req.before);
    if (livePosition && live.liveRawStore && !live.suspended) {
      try {
        const before = live.liveRawStore.parseCursor(req.before as string);
        const page = live.liveRawStore.page({
          before,
          limit: req.limit,
          maxBytes: MAX_OUTPUT_SNAPSHOT,
          sortDirection: 'desc'
        });
        const output = liveRawRowsOutput(page.rows);
        return {
          events: live.adapter.events.projectLive({ id, output, mode: 'events' }).events,
          ...(page.nextBefore !== undefined
            ? { nextCursor: live.liveRawStore.cursorBefore(page.nextBefore) }
            : live.providerSessionRef
              ? { nextCursor: encodeEventCursor('') }
              : {})
        };
      } catch (error) {
        if (!(error instanceof LiveRawCursorExpiredError)) throw error;
      }
    }
    const cursor = decodeEventCursor(req.before);
    const providerSessionRef = live.providerSessionRef ?? live.initializeContext?.providerSessionRef ?? undefined;
    const workingPath = live.initializeContext?.workingPath;
    const providerReq = providerEventPageRequest(req, cursor);
    if (live.adapter.events.readPage && providerSessionRef && workingPath) {
      const result = await live.adapter.events.readPage(
        {
          providerSessionRef,
          workingPath,
          limitBytes: MAX_OUTPUT_SNAPSHOT,
          requestProviderPage: (send) => this.requestProviderEventPage(live, send)
        },
        { view: 'convenience', before: providerReq.before, limit: providerReq.limit }
      );
      if (result.state === 'available' && result.view === 'convenience') {
        return {
          events: result.events,
          ...(result.nextCursor ? { nextCursor: encodeEventCursor(result.nextCursor) } : {})
        };
      }
    }
    throw new MeshAgentError('unsupported_capability', `provider events unavailable for live session: ${id}`);
  }

  private requestProviderEventPage(
    live: LiveMeshSession,
    send: (handle: LiveMeshSession) => string | number
  ): Promise<{ items: unknown[]; nextCursor?: string }> {
    return new Promise((resolve, reject) => {
      let responseId: string;
      try {
        responseId = String(send(live));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const timeout = setTimeout(() => {
        live.pendingEventPages.delete(responseId);
        reject(new MeshAgentError('provider_timeout', `timed out waiting for MeshAgent event page: ${live.id}`));
      }, EVENT_PAGE_TIMEOUT_MS);
      live.pendingEventPages.set(responseId, {
        timeout,
        resolve,
        reject
      });
    });
  }

  private async storedProjectedEventsPage(
    id: string,
    req: MeshAgentEventPageRequest
  ): Promise<MeshAgentProjectionPage> {
    const row = this.deps.store.getMeshSession(id);
    const cursor = decodeEventCursor(req.before);
    if (row?.providerSessionRef) {
      const adapter = getMeshAgentProviderAdapter(row.provider);
      const pageRequest = {
        view: 'convenience' as const,
        before: cursor.kind === 'provider' && cursor.token ? cursor.token : undefined,
        limit: req.limit
      };
      const local = await adapter.events
        .readPage?.(
          {
            providerSessionRef: row.providerSessionRef,
            workingPath: row.workingPath,
            limitBytes: MAX_OUTPUT_SNAPSHOT
          },
          pageRequest
        )
        .catch(() => undefined);
      if (local?.state === 'available' && local.view === 'convenience') {
        return {
          events: local.events,
          ...(local.nextCursor ? { nextCursor: encodeEventCursor(local.nextCursor) } : {})
        };
      }
      if (row.launchMode === 'app-server') {
        const bridged = await providerEventPageViaCli(row, adapter, pageRequest, {
          agents: this.deps.agents,
          buildSpawnEnv: (adapter, env) => this.buildSpawnEnv(adapter, env),
          takeStructuredLines: (structuredId, stream, chunk) =>
            this.outputPipeline.takeCompleteStructuredLines(structuredId, stream, chunk),
          dropStructuredBuffer: (structuredId) => this.outputPipeline.dropStructuredBuffer(structuredId)
        }).catch(() => null);
        if (bridged?.state === 'available' && bridged.view === 'convenience') {
          return {
            events: bridged.events,
            ...(bridged.nextCursor ? { nextCursor: encodeEventCursor(bridged.nextCursor) } : {})
          };
        }
      }
    }
    throw new MeshAgentError('unsupported_capability', `provider events unavailable for stopped session: ${id}`);
  }

  startAuth(agentName: string): Promise<MeshAgentAuthSessionView> {
    return this.authHost.startAuth(agentName);
  }

  getAuth(id: string, controlToken: string): MeshAgentAuthSessionView {
    return this.authHost.getAuth(id, controlToken);
  }

  subscribeAuth(
    id: string,
    controlToken: string,
    listener: MeshAgentAuthListener
  ): { session: MeshAgentAuthSessionView; dispose: () => void } {
    return this.authHost.subscribeAuth(id, controlToken, listener);
  }

  inputAuth(id: string, controlToken: string, req: MeshAgentInputRequest): void {
    this.authHost.inputAuth(id, controlToken, req);
  }

  resizeAuth(id: string, controlToken: string, req: MeshAgentResizeRequest): void {
    this.authHost.resizeAuth(id, controlToken, req);
  }

  heartbeatAuth(id: string, controlToken: string): void {
    this.authHost.heartbeatAuth(id, controlToken);
  }

  stopAuth(id: string, controlToken: string): void {
    this.authHost.stopAuth(id, controlToken);
  }

  authStatus(agentName: string): Promise<MeshAgentAuthStatusResponse> {
    return this.authHost.authStatus(agentName);
  }

  usage(agentName: string): Promise<MeshAgentUsageResponse> {
    return this.authHost.usage(agentName);
  }

  preflight(agentName: string): Promise<MeshAgentStartPreflight> {
    return this.authHost.preflight(agentName);
  }
}
