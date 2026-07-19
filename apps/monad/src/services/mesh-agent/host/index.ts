import type {
  ListMeshAgentRuntimesQuery,
  ListMeshAgentRuntimesResponse,
  ListMeshSessionsResponse,
  MeshAgentApprovalResolutionRequest,
  MeshAgentAuthSessionView,
  MeshAgentAuthStatusResponse,
  MeshAgentInputRequest,
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

import { MeshAgentAuthHost, type MeshAgentAuthListener } from '#/services/mesh-agent/auth-host.ts';
import { MeshAgentError } from '#/services/mesh-agent/errors.ts';
import { MeshAgentEventLog } from '#/services/mesh-agent/host/event-log.ts';
import { MeshAgentEventPages } from '#/services/mesh-agent/host/event-pages.ts';
import { toView } from '#/services/mesh-agent/host/host-helpers.ts';
import { MeshAgentObservationEpoch } from '#/services/mesh-agent/host/observation-epoch.ts';
import { MeshAgentObservationHub } from '#/services/mesh-agent/host/observation-hub.ts';
import { MeshAgentObservationResolver } from '#/services/mesh-agent/host/observation-resolve.ts';
import { MeshAgentObservationSubscribe } from '#/services/mesh-agent/host/observation-subscribe.ts';
import { MeshAgentOutputPipeline } from '#/services/mesh-agent/host/output-pipeline.ts';
import { MeshAgentProcessLifecycle } from '#/services/mesh-agent/host/process-lifecycle.ts';
import { disposeLiveCapture } from '#/services/mesh-agent/host/runtime-teardown.ts';
import { MeshSessionEventRuntimeLauncher } from '#/services/mesh-agent/host/session-event-runtime-launcher.ts';
import { cleanupStaleLiveRawStores, LiveRawStore } from '#/services/mesh-agent/live-raw-store.ts';
import { MeshAgentLoginNudge } from '#/services/mesh-agent/login-nudge.ts';
import {
  cleanupManagedProjectRuntimeToken,
  managedProjectRuntimeWorkspace
} from '#/services/mesh-agent/managed-project.ts';
import { buildMeshAgentSpawnEnv, requireMeshAgent } from '#/services/mesh-agent/spawn-support.ts';

export type { MeshAgentHostDeps };

const RUNTIME_LIST_DEFAULT_LIMIT = 100;

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
  private readonly observationEpoch: MeshAgentObservationEpoch;
  /** Owns lossless live capture and structured-event decoding for child-process output. */
  private readonly outputPipeline: MeshAgentOutputPipeline;
  /** Mirrors spawned/exited child pids into the daemon-wide child-process registry and the durable
   *  on-disk registry file, and reconciles orphans left by an uncleanly-stopped daemon. */
  private readonly processLifecycle: MeshAgentProcessLifecycle;
  private readonly sessionEventRuntimeLauncher: MeshSessionEventRuntimeLauncher;
  /** Resolves observation from the ephemeral live store or earlier provider events. */
  private readonly observationResolver: MeshAgentObservationResolver;
  private readonly observationSubscribe: MeshAgentObservationSubscribe;
  private readonly eventPages: MeshAgentEventPages;
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
    this.observationEpoch = new MeshAgentObservationEpoch({
      events: this.events
    });
    this.outputPipeline = new MeshAgentOutputPipeline({
      live: this.live,
      store: deps.store,
      events: this.events,
      stop: (id) => this.stop(id),
      getManagedProjectOutputHandler: () => this.managedProjectOutputHandler,
      log: this.log
    });
    this.processLifecycle = new MeshAgentProcessLifecycle({
      store: deps.store,
      monadHome: deps.monadHome,
      meshAgentProcessRegistryPath: deps.meshAgentProcessRegistryPath,
      authProcessRegistryPath: deps.authProcessRegistryPath
    });
    this.sessionEventRuntimeLauncher = new MeshSessionEventRuntimeLauncher({
      deps,
      live: this.live,
      log: this.log,
      events: this.events,
      observation: this.observation,
      outputPipeline: this.outputPipeline,
      requireAgent: (name) => this.requireAgent(name),
      buildSpawnEnv: (adapter, env) => this.buildSpawnEnv(adapter, env),
      trackProcess: (pid) => this.processLifecycle.track(pid),
      untrackProcess: (pid) => this.processLifecycle.untrack(pid),
      openLiveRawStore: (id, epoch) => this.openLiveRawStore(id, epoch)
    });
    this.observationResolver = new MeshAgentObservationResolver({
      live: this.live,
      store: deps.store
    });
    this.observationSubscribe = new MeshAgentObservationSubscribe({
      observation: this.observation,
      observeRaw: (id, afterSeq) => this.observeRaw(id, afterSeq),
      observeConvenience: (id, afterSeq) => this.observeConvenience(id, afterSeq)
    });
    this.eventPages = new MeshAgentEventPages({
      live: this.live,
      store: deps.store
    });
  }

  private openLiveRawStore(id: string, epoch: string): LiveRawStore {
    return LiveRawStore.open({ directory: this.liveRawStoreDirectory, sessionId: id, epoch });
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

  private emitConnectionClosed(live: LiveMeshSession, reason: 'exited' | 'failed' | 'stopped' | 'disconnected'): void {
    this.observationEpoch.emitConnectionClosed(live, reason);
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
    return this.sessionEventRuntimeLauncher.start(args);
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
    if (!live.sessionEventRuntime) throw new Error(`MeshAgent session runtime is unavailable: ${id}`);
    await live.sessionEventRuntime.input({ text: req.input, attachments: [] });
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
    if (!live.sessionEventRuntime) throw new Error(`MeshAgent session runtime is unavailable: ${id}`);
    void live.sessionEventRuntime.interrupt().catch(() => this.stop(id));
  }

  steer(id: string, req: MeshAgentInputRequest): void {
    const live = this.live.get(id);
    if (!live) throw new Error(`MeshAgent session is not running: ${id}`);
    if (!live.sessionEventRuntime) throw new Error(`MeshAgent session runtime is unavailable: ${id}`);
    if (!live.sessionEventRuntime.snapshot().capabilities.steer)
      throw new MeshAgentError('unsupported_capability', `MeshAgent provider does not support steering: ${id}`);
    void live.sessionEventRuntime.steer({ text: req.input, attachments: [] });
  }

  get(id: string): MeshSessionView {
    const row = this.deps.store.getMeshSession(id);
    if (!row) throw new Error(`MeshAgent session not found: ${id}`);
    const live = this.live.get(id);
    return toView(row, live?.pendingApprovals.size ?? 0, live?.sessionEventRuntime?.snapshot());
  }

  list(transcriptTargetId: MeshAgentTargetId): ListMeshSessionsResponse {
    return {
      sessions: this.deps.store.listMeshSessionsForTranscriptTarget(transcriptTargetId).map((row) => {
        const live = this.live.get(row.id);
        return toView(row, live?.pendingApprovals.size ?? 0, live?.sessionEventRuntime?.snapshot());
      })
    };
  }

  /** Every MeshAgent runtime across the daemon without output buffers. Used by overview surfaces
   *  that need durable counters such as unread messages even after a runtime exits. */
  listAllSummaries(query: ListMeshAgentRuntimesQuery = {}): ListMeshAgentRuntimesResponse {
    const views = this.deps.store.listMeshSessions().map((row) => {
      const live = this.live.get(row.id);
      return toView(row, live?.pendingApprovals.size ?? 0, live?.sessionEventRuntime?.snapshot());
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
      return toView(row, live?.pendingApprovals.size ?? 0, live?.sessionEventRuntime?.snapshot());
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

  subscribeRawObservation(
    id: string,
    handlers: { onFrame: (frame: MeshRawEvent) => void; onDone: () => void },
    opts?: { after?: string }
  ): { frames: MeshRawEvent[]; live: boolean; dispose: () => void } {
    return this.observationSubscribe.subscribeRawObservation(id, handlers, opts);
  }

  subscribeConvenienceObservation(
    id: string,
    onFrame: (frame: MeshConvenienceFrame, done: boolean) => void,
    opts?: { after?: string }
  ): { frames: MeshConvenienceFrame[]; live: boolean; dispose: () => void } {
    return this.observationSubscribe.subscribeConvenienceObservation(id, onFrame, opts);
  }

  async rawEventsPage(id: string, req: Omit<MeshEventPageRequest, 'view'>): Promise<MeshRawEventPage> {
    return this.eventPages.rawEventsPage(id, req);
  }

  async convenienceEventsPage(id: string, req: Omit<MeshEventPageRequest, 'view'>): Promise<MeshConvenienceEventPage> {
    return this.eventPages.convenienceEventsPage(id, req);
  }

  resize(id: string, req: MeshAgentResizeRequest): void {
    const live = this.live.get(id);
    if (!live) throw new Error(`MeshAgent session is not running: ${id}`);
    void req;
    throw new MeshAgentError('unsupported_capability', `MeshAgent sessions do not expose PTY resize: ${id}`);
  }

  resolveApproval(id: string, req: MeshAgentApprovalResolutionRequest): void {
    const live = this.live.get(id);
    if (!live) throw new Error(`MeshAgent session is not running: ${id}`);
    if (!live.sessionEventRuntime) throw new Error(`MeshAgent session runtime is unavailable: ${id}`);
    if (!live.sessionEventRuntime.snapshot().capabilities.approvalResolution)
      throw new MeshAgentError('unsupported_capability', `MeshAgent provider cannot resolve approvals: ${id}`);
    void live.sessionEventRuntime.resolveApproval(req);
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
    if (!live.sessionEventRuntime) throw new Error(`MeshAgent session runtime is unavailable: ${id}`);
    void live.sessionEventRuntime.close();
    disposeLiveCapture(live);
    this.live.delete(id);
    const row = this.deps.store.getMeshSession(id);
    if (row?.runtimeRole === 'managed-project-agent')
      cleanupManagedProjectRuntimeToken(this.managedRuntimeWorkspace(row));
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

  projectedEventsPage(id: string, req: MeshAgentEventPageRequest): Promise<MeshAgentProjectionPage> {
    return this.eventPages.projectedEventsPage(id, req);
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
