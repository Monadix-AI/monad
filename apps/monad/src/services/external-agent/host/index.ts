import type {
  ExternalAgentApprovalResolutionRequest,
  ExternalAgentAppServerTransport,
  ExternalAgentAuthSessionView,
  ExternalAgentAuthStatusResponse,
  ExternalAgentHistoryPageRequest,
  ExternalAgentHistoryPageResponse,
  ExternalAgentInputRequest,
  ExternalAgentLaunchMode,
  ExternalAgentObservationAccessResponse,
  ExternalAgentResizeRequest,
  ExternalAgentSessionView,
  ExternalAgentUiObservationFrame,
  ExternalAgentUsageResponse,
  ExternalAgentView,
  ListExternalAgentRuntimesQuery,
  ListExternalAgentRuntimesResponse,
  ListExternalAgentSessionsResponse
} from '@monad/protocol';
import type {
  ExternalAgentHostDeps,
  ExternalAgentObservationListener,
  LiveExternalAgentSession,
  ManagedProjectOutputHandler
} from '#/services/external-agent/host/host-types.ts';
import type { ExternalAgentStartPreflight } from '#/services/external-agent/types.ts';
import type { ExternalAgentTargetId } from '#/store/db/external-agent-sessions.ts';
import type { ExternalAgentSessionRow } from '#/store/db/index.ts';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createLogger } from '@monad/logger';
import { newId } from '@monad/protocol';

import { ExternalAgentAuthHost, type ExternalAgentAuthListener } from '#/services/external-agent/auth-host.ts';
import { MAX_OUTPUT_SNAPSHOT } from '#/services/external-agent/constants.ts';
import { ExternalAgentError } from '#/services/external-agent/errors.ts';
import { ExternalAgentAppServerConnectionManager } from '#/services/external-agent/host/app-server-connection.ts';
import { ExternalAgentOneshotRunner } from '#/services/external-agent/host/cli-oneshot.ts';
import { ExternalAgentEventLog } from '#/services/external-agent/host/event-log.ts';
import { providerHistoryPageViaCli } from '#/services/external-agent/host/history-backfill.ts';
import {
  decodeHistoryCursor,
  encodeProviderHistoryCursor,
  encodeStoredHistoryCursor,
  type HistoryCursor
} from '#/services/external-agent/host/history-cursor.ts';
import {
  EXTERNAL_AGENT_IDLE_TIMEOUT_MS,
  HISTORY_PAGE_TIMEOUT_MS
} from '#/services/external-agent/host/host-constants.ts';
import { toView } from '#/services/external-agent/host/host-helpers.ts';
import { ExternalAgentObservationHub } from '#/services/external-agent/host/observation-hub.ts';
import { ExternalAgentObservationResolver } from '#/services/external-agent/host/observation-resolve.ts';
import { ExternalAgentOutputPipeline } from '#/services/external-agent/host/output-pipeline.ts';
import { ExternalAgentProcessLifecycle } from '#/services/external-agent/host/process-lifecycle.ts';
import { ExternalAgentSessionLauncher } from '#/services/external-agent/host/session-launcher.ts';
import { getExternalAgentProviderAdapter } from '#/services/external-agent/index.ts';
import {
  cleanupStaleLiveRawStores,
  LiveRawCursorExpiredError,
  LiveRawStore,
  liveRawRowsOutput
} from '#/services/external-agent/live-raw-store.ts';
import { ExternalAgentLoginNudge } from '#/services/external-agent/login-nudge.ts';
import {
  cleanupManagedProjectRuntimeToken,
  managedProjectRuntimeWorkspace
} from '#/services/external-agent/managed-project.ts';
import { killExternalAgentProcess } from '#/services/external-agent/process.ts';
import { buildExternalAgentSpawnEnv, requireExternalAgent } from '#/services/external-agent/spawn-support.ts';

export type { ExternalAgentHostDeps };

function providerHistoryPageRequest(
  req: ExternalAgentHistoryPageRequest,
  cursor: HistoryCursor
): ExternalAgentHistoryPageRequest {
  const { before: _ignored, ...rest } = req;
  return { ...rest, ...(cursor.kind === 'provider' && cursor.value ? { before: cursor.value } : {}) };
}

const RUNTIME_LIST_DEFAULT_LIMIT = 100;

/** Slices an already-ordered array by an opaque position cursor (`before` = index to stop before).
 *  Used by the daemon-wide runtime overview lists, which are in-memory/SQLite arrays, not a keyset
 *  index — a numeric offset-as-cursor is sufficient since these lists are read-mostly per poll. */
function sliceByCursor<T>(items: T[], query: ListExternalAgentRuntimesQuery): { page: T[]; nextCursor?: string } {
  const end = query.before ? Math.max(0, Math.min(items.length, Number.parseInt(query.before, 10) || 0)) : items.length;
  const limit = query.limit ?? RUNTIME_LIST_DEFAULT_LIMIT;
  const start = Math.max(0, end - limit);
  return { page: items.slice(start, end), ...(start > 0 ? { nextCursor: String(start) } : {}) };
}

export class ExternalAgentHost {
  private readonly log = createLogger('external-agent');

  private readonly live = new Map<string, LiveExternalAgentSession>();
  private readonly observation = new ExternalAgentObservationHub({
    getLive: (id) => this.live.get(id),
    observe: (id, afterSeq) => this.observe(id, afterSeq)
  });
  private managedProjectOutputHandler: ManagedProjectOutputHandler | null = null;
  /** Provider-login (auth) sessions and one-shot auth/usage probes live in their own host; they share
   *  no state with interactive sessions. Public auth methods below delegate straight through. */
  private readonly authHost: ExternalAgentAuthHost;
  /** In-chat re-login nudge: verifies a connection_required is a real auth failure, then publishes the
   *  ephemeral login_required/login_resolved pair. */
  private readonly loginNudge: ExternalAgentLoginNudge;
  private readonly disposeLoginNudge: () => void;
  /** Builds and dispatches durable/ephemeral external agent session events. */
  private readonly events: ExternalAgentEventLog;
  /** Owns app-server socket/port allocation and the disconnect→redial→give-up flow. */
  private readonly appServerConnections: ExternalAgentAppServerConnectionManager;
  /** Owns lossless live capture and structured-event decoding for child-process output. */
  private readonly outputPipeline: ExternalAgentOutputPipeline;
  /** Runs `cli-oneshot` sessions: a logical session with no persistent process. */
  private readonly oneshotRunner: ExternalAgentOneshotRunner;
  /** Mirrors spawned/exited child pids into the daemon-wide child-process registry and the durable
   *  on-disk registry file, and reconciles orphans left by an uncleanly-stopped daemon. */
  private readonly processLifecycle: ExternalAgentProcessLifecycle;
  /** Builds and spawns a fresh external agent session (agent/launch resolution, process spawn, stream
   *  wiring, exit/idle-resume bookkeeping). */
  private readonly sessionLauncher: ExternalAgentSessionLauncher;
  /** Resolves observation from the ephemeral live store or provider history. */
  private readonly observationResolver: ExternalAgentObservationResolver;
  private readonly liveRawStoreDirectory: string;
  private readonly liveRawStoreCleanup: Promise<Error | undefined>;

  constructor(private readonly deps: ExternalAgentHostDeps) {
    this.liveRawStoreDirectory =
      deps.externalAgentLiveStoreDirectory ?? join(tmpdir(), `monad-external-agent-live-${process.pid}`);
    this.liveRawStoreCleanup = cleanupStaleLiveRawStores(this.liveRawStoreDirectory)
      .then(() => undefined)
      .catch((error) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.log.error(
          { event: 'external_agent.live_observation_cleanup_failed', err: failure.message },
          'stale native cli live observation cleanup failed'
        );
        return failure;
      });
    this.loginNudge = new ExternalAgentLoginNudge({
      bus: deps.bus,
      authStatus: (agentName) => this.authHost.authStatus(agentName)
    });
    this.disposeLoginNudge = this.loginNudge.start();
    this.authHost = new ExternalAgentAuthHost({
      ...deps,
      onAuthenticated: (info) => this.loginNudge.resolveAuthenticated(info)
    });
    this.events = new ExternalAgentEventLog({ store: deps.store, bus: deps.bus });
    this.appServerConnections = new ExternalAgentAppServerConnectionManager({
      live: this.live,
      emit: (sessionId, type, payload) => this.events.emit(sessionId, type, payload),
      stop: (id) => this.stop(id),
      log: this.log,
      reconnectBaseMs: deps.appServerReconnectBaseMs,
      disconnectGraceMs: deps.appServerDisconnectGraceMs,
      rotateLiveCapture: (live) => this.rotateLiveCapture(live)
    });
    this.outputPipeline = new ExternalAgentOutputPipeline({
      live: this.live,
      store: deps.store,
      events: this.events,
      observation: this.observation,
      stop: (id) => this.stop(id),
      getManagedProjectOutputHandler: () => this.managedProjectOutputHandler,
      log: this.log,
      armIdleSuspend: (live) => this.armIdleSuspend(live)
    });
    this.processLifecycle = new ExternalAgentProcessLifecycle({
      store: deps.store,
      monadHome: deps.monadHome,
      externalAgentProcessRegistryPath: deps.externalAgentProcessRegistryPath,
      authProcessRegistryPath: deps.authProcessRegistryPath
    });
    this.oneshotRunner = new ExternalAgentOneshotRunner({
      live: this.live,
      store: deps.store,
      events: this.events,
      outputPipeline: this.outputPipeline,
      buildSpawnEnv: (env) => this.buildSpawnEnv(env),
      trackProcess: (pid) => this.processLifecycle.track(pid),
      untrackProcess: (pid) => this.processLifecycle.untrack(pid),
      openLiveRawStore: (id, epoch) => this.openLiveRawStore(id, epoch)
    });
    this.sessionLauncher = new ExternalAgentSessionLauncher({
      deps,
      live: this.live,
      log: this.log,
      events: this.events,
      observation: this.observation,
      appServerConnections: this.appServerConnections,
      outputPipeline: this.outputPipeline,
      oneshotRunner: this.oneshotRunner,
      requireAgent: (name) => this.requireAgent(name),
      buildSpawnEnv: (env) => this.buildSpawnEnv(env),
      trackProcess: (pid) => this.processLifecycle.track(pid),
      untrackProcess: (pid) => this.processLifecycle.untrack(pid),
      armIdleSuspend: (live) => this.armIdleSuspend(live),
      idleTimeoutMs: () => this.idleTimeoutMs(),
      updateExternalAgentPid: (id, pid) => this.updateExternalAgentPid(id, pid),
      openLiveRawStore: (id, epoch) => this.openLiveRawStore(id, epoch)
    });
    this.observationResolver = new ExternalAgentObservationResolver({
      live: this.live,
      store: deps.store,
      agents: deps.agents,
      buildSpawnEnv: (env) => this.buildSpawnEnv(env),
      takeStructuredLines: (id, stream, chunk) => this.outputPipeline.takeCompleteStructuredLines(id, stream, chunk),
      dropStructuredBuffer: (id) => this.outputPipeline.dropStructuredBuffer(id)
    });
  }

  private openLiveRawStore(id: string, epoch: string): LiveRawStore {
    return LiveRawStore.open({ directory: this.liveRawStoreDirectory, sessionId: id, epoch });
  }

  private rotateLiveCapture(live: LiveExternalAgentSession): void {
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

  private buildSpawnEnv(launchEnv?: Record<string, string>): Promise<Record<string, string>> {
    return buildExternalAgentSpawnEnv(this.deps.resolveAgentEnv, launchEnv);
  }

  private requireAgent(name: string): Promise<ExternalAgentView> {
    return requireExternalAgent(this.deps.agents, name);
  }

  private managedRuntimeWorkspace(
    row: Pick<ExternalAgentSessionRow, 'agentName' | 'transcriptTargetId' | 'workingPath'>
  ): string {
    return managedProjectRuntimeWorkspace({
      monadHome: this.deps.monadHome ?? dirname(this.deps.externalAgentProcessRegistryPath ?? row.workingPath),
      projectId: row.transcriptTargetId,
      agentName: row.agentName
    });
  }

  private idleTimeoutMs(): number {
    return this.deps.externalAgentIdleTimeoutMs ?? EXTERNAL_AGENT_IDLE_TIMEOUT_MS;
  }

  private canIdleSuspend(live: LiveExternalAgentSession): boolean {
    return Boolean(
      live.restartRuntime &&
        live.idleTimeoutMs &&
        live.idleTimeoutMs > 0 &&
        live.launchMode !== 'pty' &&
        live.launchMode !== 'cli-oneshot' &&
        live.pendingApprovals.size === 0 &&
        live.pendingHistoryPages.size === 0 &&
        live.pendingRequests.size === 0 &&
        !live.startup &&
        !live.appServerReconnecting &&
        !live.suspended
    );
  }

  private armIdleSuspend(live: LiveExternalAgentSession): void {
    if (live.idleTimer) {
      clearTimeout(live.idleTimer);
      live.idleTimer = undefined;
    }
    if (!this.canIdleSuspend(live)) return;
    live.idleTimer = setTimeout(() => this.suspendIdleRuntime(live.id), live.idleTimeoutMs);
  }

  private updateExternalAgentPid(id: string, pid: number | null): void {
    const row = this.deps.store.getExternalAgentSession(id);
    if (row?.state !== 'running') return;
    this.deps.store.upsertExternalAgentSession({
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
      killExternalAgentProcess(pid);
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
    this.updateExternalAgentPid(id, null);
    this.observation.publish(id);
    this.events.emit(live.transcriptTargetId, 'external_agent.idle_suspended', {
      agentId: live.agentName,
      agentName: live.displayName ?? live.agentName,
      type: 'idle_suspended',
      payload: { externalAgentSessionId: live.id, idleTimeoutMs }
    });
    this.log.debug(
      { sessionId: live.transcriptTargetId, event: 'external_agent.idle_suspended', externalAgentSessionId: id },
      'native cli idle suspended'
    );
  }

  private async sendInputAfterResume(live: LiveExternalAgentSession, input: string): Promise<void> {
    const send = async (): Promise<void> => {
      if (live.suspended) {
        if (!live.restartRuntime)
          throw new ExternalAgentError('unsupported_capability', `external agent cannot resume: ${live.id}`);
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

  private async prepareObservationEpoch(live: LiveExternalAgentSession): Promise<void> {
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
            { limit: 100, sortDirection: 'desc' }
          );
          if (result.state === 'available') {
            for (const event of result.events) {
              if (event.dedupeKey) identities.add(event.dedupeKey);
            }
            checkpoint = result.events.findLast((event) => event.dedupeKey)?.dedupeKey;
          }
        } catch (error) {
          this.log.debug(
            {
              event: 'external_agent.history_checkpoint_failed',
              externalAgentSessionId: live.id,
              provider: live.provider,
              err: error instanceof Error ? error.message : String(error)
            },
            'provider history checkpoint unavailable'
          );
        }
      }
      live.providerHistoryCheckpoint = checkpoint;
      live.providerHistoryIdentities = identities;
      live.outputSeq = 0;
      void live.liveRawStore?.closeAndDelete();
      live.observationEpoch = newId('oep');
      live.liveRawStore = this.openLiveRawStore(live.id, live.observationEpoch);
      live.observationEpochReady = true;
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
    transcriptTargetId: ExternalAgentTargetId;
    agentName: string;
    displayName?: string;
    templateAgentName?: string;
    workingPath: string;
    launchMode?: ExternalAgentLaunchMode;
    appServerTransport?: ExternalAgentAppServerTransport;
    runtimeRole?: ExternalAgentSessionView['runtimeRole'];
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
  }): Promise<ExternalAgentSessionView> {
    const cleanupFailure = await this.liveRawStoreCleanup;
    if (cleanupFailure) throw cleanupFailure;
    return this.sessionLauncher.start(args);
  }

  async input(id: string, req: ExternalAgentInputRequest): Promise<void> {
    const live = this.live.get(id);
    if (!live) throw new Error(`external agent session is not running: ${id}`);
    this.log.debug(
      {
        sessionId: live.transcriptTargetId,
        event: 'external_agent.input',
        externalAgentSessionId: id,
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
      throw new ExternalAgentError(
        'provider_timeout',
        `external agent app-server is reconnecting, cannot send input: ${id}`
      );
    }
    await this.prepareObservationEpoch(live);
    this.armIdleSuspend(live);
    live.adapter.sendInput(live, req.input);
  }

  /** Cancel the in-flight turn while keeping the session/thread alive. If the provider adapter offers
   *  no graceful interrupt, fall back to stopping the session so the request is never a no-op. */
  interrupt(id: string): void {
    const live = this.live.get(id);
    if (!live) throw new Error(`external agent session is not running: ${id}`);
    this.log.debug(
      { sessionId: live.transcriptTargetId, event: 'external_agent.interrupt', externalAgentSessionId: id },
      'native cli interrupt'
    );
    if (live.adapter.interrupt) live.adapter.interrupt(live);
    else this.stop(id);
  }

  steer(id: string, req: ExternalAgentInputRequest): void {
    const live = this.live.get(id);
    if (!live) throw new Error(`external agent session is not running: ${id}`);
    if (!live.adapter.steer)
      throw new ExternalAgentError(
        'unsupported_capability',
        `external agent provider does not support steering: ${id}`
      );
    this.log.debug(
      { sessionId: live.transcriptTargetId, event: 'external_agent.steer', externalAgentSessionId: id },
      'native cli steer'
    );
    live.adapter.steer(live, req.input);
  }

  get(id: string): ExternalAgentSessionView {
    const row = this.deps.store.getExternalAgentSession(id);
    if (!row) throw new Error(`external agent session not found: ${id}`);
    const live = this.live.get(id);
    return toView(row, live?.pendingApprovals.size ?? 0);
  }

  list(transcriptTargetId: ExternalAgentTargetId): ListExternalAgentSessionsResponse {
    return {
      sessions: this.deps.store.listExternalAgentSessionsForTranscriptTarget(transcriptTargetId).map((row) => {
        const live = this.live.get(row.id);
        return toView(row, live?.pendingApprovals.size ?? 0);
      })
    };
  }

  /** Every external agent runtime across the daemon without output buffers. Used by overview surfaces
   *  that need durable counters such as unread messages even after a runtime exits. */
  listAllSummaries(query: ListExternalAgentRuntimesQuery = {}): ListExternalAgentRuntimesResponse {
    const views = this.deps.store.listExternalAgentSessions().map((row) => {
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
  listLive(query: ListExternalAgentRuntimesQuery = {}): ListExternalAgentRuntimesResponse {
    const views = this.deps.store.listLiveExternalAgentSessions().map((row) => {
      const live = this.live.get(row.id);
      return toView(row, live?.pendingApprovals.size ?? 0);
    });
    const { page, nextCursor } = sliceByCursor(views, query);
    return { sessions: page, ...(nextCursor ? { nextCursor } : {}) };
  }

  observe(id: string, afterSeq?: number): ExternalAgentObservationAccessResponse {
    return this.observationResolver.observe(id, afterSeq);
  }

  observeWithProviderHistory(id: string): Promise<ExternalAgentObservationAccessResponse> {
    return this.observationResolver.observeWithProviderHistory(id);
  }

  subscribeObservation(
    id: string,
    listener: ExternalAgentObservationListener,
    afterSeq?: number
  ): { access: ExternalAgentObservationAccessResponse; live: boolean; dispose: () => void } {
    return this.observation.subscribe(id, listener, afterSeq);
  }

  observeUi(id: string): ExternalAgentUiObservationFrame {
    return this.observationResolver.observeUi(id);
  }

  observeUiWithProviderHistory(id: string): Promise<ExternalAgentUiObservationFrame> {
    return this.observationResolver.observeUiWithProviderHistory(id);
  }

  /** UI plane subscription: rides the raw observation hub (its throttle + lifecycle) but re-projects
   *  the full neutral event list from the whole snapshot on every tick, so the consumer never derives
   *  cards from a delta. Needs no `afterSeq` — each frame is the complete state. */
  subscribeUiObservation(
    id: string,
    onFrame: (frame: ExternalAgentUiObservationFrame, done: boolean) => void
  ): { frame: ExternalAgentUiObservationFrame; live: boolean; dispose: () => void } {
    const frame = this.observeUi(id);
    if (frame.state !== 'live') return { frame, live: false, dispose: () => {} };
    const sub = this.observation.subscribe(id, (_access, done) => onFrame(this.observeUi(id), done));
    if (!sub.live) {
      sub.dispose();
      return { frame: this.observeUi(id), live: false, dispose: () => {} };
    }
    return { frame, live: true, dispose: sub.dispose };
  }

  resize(id: string, req: ExternalAgentResizeRequest): void {
    const live = this.live.get(id);
    if (!live) throw new Error(`external agent session is not running: ${id}`);
    this.log.debug(
      {
        sessionId: live.transcriptTargetId,
        event: 'external_agent.resize',
        externalAgentSessionId: id,
        cols: req.cols,
        rows: req.rows
      },
      'native cli resize'
    );
    live.adapter.resize(live, req.cols, req.rows);
  }

  resolveApproval(id: string, req: ExternalAgentApprovalResolutionRequest): void {
    const live = this.live.get(id);
    if (!live) throw new Error(`external agent session is not running: ${id}`);
    const request = live.pendingApprovals.get(req.requestId);
    live.adapter.resolveApproval(live, { ...req, request });
    live.pendingApprovals.delete(req.requestId);
    this.events.emit(live.transcriptTargetId, 'external_agent.approval_resolved', {
      externalAgentSessionId: id,
      provider: live.adapter.provider,
      requestId: req.requestId,
      allow: req.allow,
      ...(req.reason ? { reason: req.reason } : {})
    });
  }

  stop(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    this.log.debug(
      { sessionId: live.transcriptTargetId, event: 'external_agent.stop', externalAgentSessionId: id },
      'native cli stop'
    );
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
    for (const pending of live.pendingHistoryPages.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`external agent session stopped before history page response: ${id}`));
    }
    live.pendingHistoryPages.clear();
    if (live.startup) {
      clearTimeout(live.startup.timeout);
      live.startup.reject(new Error(`external agent session stopped before app-server thread was ready: ${id}`));
      live.startup = undefined;
    }
    live.adapter.stop(live);
    // cli-oneshot has no persistent proc; kill any in-flight per-turn process instead.
    if (live.oneshotTurnProc) {
      if (live.oneshotTurnProc.supervision) live.oneshotTurnProc.supervision.stop('manual', 'SIGTERM');
      else {
        killExternalAgentProcess(live.oneshotTurnProc.pid);
        this.processLifecycle.untrack(live.oneshotTurnProc.pid);
      }
      live.oneshotTurnProc = undefined;
    }
    void live.liveRawStore?.closeAndDelete();
    this.live.delete(id);
    const row = this.deps.store.getExternalAgentSession(id);
    if (row?.runtimeRole === 'managed-project-agent')
      cleanupManagedProjectRuntimeToken(this.managedRuntimeWorkspace(row));
    if (live.proc) {
      if (live.proc.supervision) live.proc.supervision.stop('manual', 'SIGTERM');
      else {
        killExternalAgentProcess(live.proc.pid);
        this.processLifecycle.untrack(live.proc.pid);
      }
    }
    this.outputPipeline.dropStructuredBuffer(id);
    this.appServerConnections.unlinkSocket(live.appServerSocketPath);
    const exitedAt = new Date().toISOString();
    this.deps.store.closeExternalAgentSession(id, exitedAt, null, 'stopped');
    this.events.emit(live.transcriptTargetId, 'external_agent.exited', {
      externalAgentSessionId: id,
      exitCode: null,
      state: 'stopped'
    });
  }

  stopSession(sessionId: ExternalAgentTargetId): void {
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
            event: 'external_agent.stop_all_failed',
            externalAgentSessionId: id,
            err: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
          },
          'native cli stop-all failed'
        );
      }
    }
  }

  stopAgentProvider(provider: ExternalAgentView['provider']): void {
    let stopped = 0;
    for (const live of [...this.live.values()]) {
      if (live.provider === provider) {
        stopped++;
        this.stop(live.id);
      }
    }
    if (stopped > 0)
      this.log.debug(
        { event: 'external_agent.stop_agent_provider', provider, stopped },
        'native cli stopped sessions for agent provider'
      );
  }

  async historyPage(id: string, req: ExternalAgentHistoryPageRequest): Promise<ExternalAgentHistoryPageResponse> {
    const live = this.live.get(id);
    if (!live) return this.storedHistoryPage(id, req);
    if (req.before?.startsWith('live:') && live.liveRawStore && !live.suspended) {
      try {
        const before = live.liveRawStore.parseCursor(req.before);
        const page = live.liveRawStore.page({
          before,
          limit: req.limit,
          maxBytes: MAX_OUTPUT_SNAPSHOT,
          sortDirection: 'desc'
        });
        const output = liveRawRowsOutput(page.rows);
        return {
          events: live.adapter.events.projectLive({ id, output, mode: 'history' }).events,
          ...(page.nextBefore !== undefined
            ? { nextCursor: live.liveRawStore.cursorBefore(page.nextBefore) }
            : live.providerSessionRef
              ? { nextCursor: encodeProviderHistoryCursor('') }
              : {})
        };
      } catch (error) {
        if (!(error instanceof LiveRawCursorExpiredError)) throw error;
      }
    }
    const cursor = decodeHistoryCursor(req.before);
    const providerSessionRef = live.providerSessionRef ?? live.initializeContext?.providerSessionRef ?? undefined;
    const workingPath = live.initializeContext?.workingPath;
    if (cursor.kind === 'stored' && live.adapter.events.readPage && providerSessionRef && workingPath) {
      const result = await live.adapter.events.readPage(
        { providerSessionRef, workingPath, limitBytes: MAX_OUTPUT_SNAPSHOT },
        { before: cursor.value, limit: req.limit, sortDirection: req.sortDirection }
      );
      if (result.state === 'available') {
        return {
          events: result.events,
          ...(result.nextCursor ? { nextCursor: encodeStoredHistoryCursor(result.nextCursor) } : {})
        };
      }
      throw new ExternalAgentError('unsupported_capability', `local history unavailable for live session: ${id}`);
    }
    const providerReq = providerHistoryPageRequest(req, cursor);
    if (live.adapter.events.readPage && providerSessionRef && workingPath) {
      const result = await live.adapter.events.readPage(
        {
          providerSessionRef,
          workingPath,
          limitBytes: MAX_OUTPUT_SNAPSHOT,
          requestProviderPage: (send) => this.requestProviderHistoryPage(live, send)
        },
        { before: providerReq.before, limit: providerReq.limit, sortDirection: providerReq.sortDirection }
      );
      if (result.state === 'available') {
        return {
          events: result.events,
          ...(result.nextCursor ? { nextCursor: encodeProviderHistoryCursor(result.nextCursor) } : {})
        };
      }
    }
    throw new ExternalAgentError('unsupported_capability', `provider history unavailable for live session: ${id}`);
  }

  private requestProviderHistoryPage(
    live: LiveExternalAgentSession,
    send: (handle: LiveExternalAgentSession) => string | number
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
        live.pendingHistoryPages.delete(responseId);
        reject(
          new ExternalAgentError('provider_timeout', `timed out waiting for external agent history page: ${live.id}`)
        );
      }, HISTORY_PAGE_TIMEOUT_MS);
      live.pendingHistoryPages.set(responseId, {
        timeout,
        resolve,
        reject
      });
    });
  }

  private async storedHistoryPage(
    id: string,
    req: ExternalAgentHistoryPageRequest
  ): Promise<ExternalAgentHistoryPageResponse> {
    const row = this.deps.store.getExternalAgentSession(id);
    const cursor = decodeHistoryCursor(req.before);
    if (row?.providerSessionRef) {
      const adapter = getExternalAgentProviderAdapter(row.provider);
      if (cursor.kind === 'stored') {
        const result = await adapter.events.readPage?.(
          {
            providerSessionRef: row.providerSessionRef,
            workingPath: row.workingPath,
            limitBytes: MAX_OUTPUT_SNAPSHOT
          },
          { before: cursor.value, limit: req.limit, sortDirection: req.sortDirection }
        );
        if (result?.state === 'available') {
          return {
            events: result.events,
            ...(result.nextCursor ? { nextCursor: encodeStoredHistoryCursor(result.nextCursor) } : {})
          };
        }
        throw new ExternalAgentError('unsupported_capability', `local history unavailable for stopped session: ${id}`);
      }
      const pageRequest = {
        before: cursor.kind === 'provider' && cursor.value ? cursor.value : undefined,
        limit: req.limit,
        sortDirection: req.sortDirection
      };
      if (row.launchMode === 'app-server') {
        const bridged = await providerHistoryPageViaCli(row, adapter, pageRequest, {
          agents: this.deps.agents,
          buildSpawnEnv: (env) => this.buildSpawnEnv(env),
          takeStructuredLines: (structuredId, stream, chunk) =>
            this.outputPipeline.takeCompleteStructuredLines(structuredId, stream, chunk),
          dropStructuredBuffer: (structuredId) => this.outputPipeline.dropStructuredBuffer(structuredId)
        }).catch((error) => {
          if (cursor.kind === 'provider') throw error;
          return null;
        });
        if (bridged?.state === 'available') {
          return {
            events: bridged.events,
            ...(bridged.nextCursor ? { nextCursor: encodeProviderHistoryCursor(bridged.nextCursor) } : {})
          };
        }
      }
      if (cursor.kind === 'provider') {
        throw new ExternalAgentError(
          'unsupported_capability',
          `provider history unavailable for stopped session: ${id}`
        );
      }
      const result = await adapter.events.readPage?.(
        {
          providerSessionRef: row.providerSessionRef,
          workingPath: row.workingPath,
          limitBytes: MAX_OUTPUT_SNAPSHOT
        },
        { before: undefined, limit: pageRequest.limit, sortDirection: pageRequest.sortDirection }
      );
      if (result?.state === 'available') {
        return {
          events: result.events,
          ...(result.nextCursor ? { nextCursor: encodeStoredHistoryCursor(result.nextCursor) } : {})
        };
      }
    }
    const access = await this.observeWithProviderHistory(id);
    if (access.state === 'unavailable') {
      throw new ExternalAgentError(
        'unsupported_capability',
        access.reason ?? `external agent history unavailable for stopped session: ${id}`
      );
    }
    return { events: access.events ?? [] };
  }

  startAuth(agentName: string): Promise<ExternalAgentAuthSessionView> {
    return this.authHost.startAuth(agentName);
  }

  getAuth(id: string, controlToken: string): ExternalAgentAuthSessionView {
    return this.authHost.getAuth(id, controlToken);
  }

  subscribeAuth(
    id: string,
    controlToken: string,
    listener: ExternalAgentAuthListener
  ): { session: ExternalAgentAuthSessionView; dispose: () => void } {
    return this.authHost.subscribeAuth(id, controlToken, listener);
  }

  inputAuth(id: string, controlToken: string, req: ExternalAgentInputRequest): void {
    this.authHost.inputAuth(id, controlToken, req);
  }

  resizeAuth(id: string, controlToken: string, req: ExternalAgentResizeRequest): void {
    this.authHost.resizeAuth(id, controlToken, req);
  }

  heartbeatAuth(id: string, controlToken: string): void {
    this.authHost.heartbeatAuth(id, controlToken);
  }

  stopAuth(id: string, controlToken: string): void {
    this.authHost.stopAuth(id, controlToken);
  }

  authStatus(agentName: string): Promise<ExternalAgentAuthStatusResponse> {
    return this.authHost.authStatus(agentName);
  }

  usage(agentName: string): Promise<ExternalAgentUsageResponse> {
    return this.authHost.usage(agentName);
  }

  preflight(agentName: string): Promise<ExternalAgentStartPreflight> {
    return this.authHost.preflight(agentName);
  }
}
