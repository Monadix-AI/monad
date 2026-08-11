import type {
  Event,
  GetLiveEventReplayFramesQuery,
  ListMeshAgentRuntimesQuery,
  ListMeshAgentRuntimesResponse,
  ListMeshSessionsResponse,
  LiveEventReplayCapture,
  LiveEventReplayFramePage,
  MeshAgentApprovalResolutionRequest,
  MeshAgentAuthSessionView,
  MeshAgentAuthStatusResponse,
  MeshAgentInputRequest,
  MeshAgentLoginRequirement,
  MeshAgentResizeRequest,
  MeshAgentSessionUsage,
  MeshAgentUsageResponse,
  MeshAgentView,
  MeshConnectionSnapshot,
  MeshConvenienceEventPage,
  MeshConvenienceFrame,
  MeshEventPageRequest,
  MeshRawEvent,
  MeshRawEventPage,
  MeshSessionId,
  MeshSessionView,
  MeshUsageOverviewResponse,
  ProjectId,
  SessionId
} from '@monad/protocol';
import type { MeshAgentEventPageRequest, MeshAgentProjectionPage } from '@monad/sdk-atom';
import type {
  LiveMeshSession,
  ManagedProjectLoopEventHandler,
  ManagedProjectOutputHandler,
  MeshAgentHostDeps,
  MeshAgentSessionUsageListener
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
import { MeshFixtureTap } from '#/services/mesh-agent/fixture-tap.ts';
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
import { MeshAgentSessionUsageHub } from '#/services/mesh-agent/host/session-usage-hub.ts';
import { getMeshAgentProviderAdapter, resolveMeshAgentExecutable } from '#/services/mesh-agent/index.ts';
import { MeshLiveEventLog } from '#/services/mesh-agent/live-event-log.ts';
import { cleanupStaleLiveRawStores, LiveRawStore } from '#/services/mesh-agent/live-raw-store.ts';
import { MeshAgentLoginNudge } from '#/services/mesh-agent/login-nudge.ts';
import {
  cleanupManagedProjectRuntimeToken,
  managedProjectRuntimeWorkspace
} from '#/services/mesh-agent/managed-project.ts';
import {
  buildMeshAgentSpawnEnv,
  requireMeshAgent,
  requireMeshSessionAgent
} from '#/services/mesh-agent/spawn-support.ts';

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
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly sessionUsageHub = new MeshAgentSessionUsageHub();
  private readonly observation = new MeshAgentObservationHub({
    getLive: (id) => this.live.get(id)
  });
  private managedProjectOutputHandler: ManagedProjectOutputHandler | null = null;
  private managedProjectLoopEventHandler: ManagedProjectLoopEventHandler | null = null;
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
  private readonly fixtureTap?: MeshFixtureTap;
  private readonly liveEventLog?: MeshLiveEventLog;

  constructor(private readonly deps: MeshAgentHostDeps) {
    if (deps.developerMode) {
      if (!deps.meshFixtureCaptureDirectory)
        throw new Error('meshFixtureCaptureDirectory is required in developer mode');
      this.fixtureTap = new MeshFixtureTap(deps.meshFixtureCaptureDirectory, this.log);
      if (!deps.meshLiveEventLogsDirectory) throw new Error('meshLiveEventLogsDirectory is required in developer mode');
      this.liveEventLog = new MeshLiveEventLog(deps.meshLiveEventLogsDirectory, this.log);
    }
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
      stop: (id) => void this.stop(id),
      getManagedProjectOutputHandler: () => this.managedProjectOutputHandler,
      getManagedProjectLoopEventHandler: () => this.managedProjectLoopEventHandler,
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
      getManagedProjectLoopEventHandler: () => this.managedProjectLoopEventHandler,
      requireAgent: (name) => this.requireAgent(name),
      buildSpawnEnv: (adapter, env) => this.buildSpawnEnv(adapter, env),
      trackProcess: (pid) => this.processLifecycle.track(pid),
      untrackProcess: (pid) => this.processLifecycle.untrack(pid),
      openLiveRawStore: (id, epoch) => this.openLiveRawStore(id, epoch),
      publishSessionUsage: (id, usage) => this.publishSessionUsage(id, usage),
      ...(this.fixtureTap ? { fixtureTap: this.fixtureTap } : {}),
      ...(this.liveEventLog ? { liveEventLog: this.liveEventLog } : {})
    });
    this.observationResolver = new MeshAgentObservationResolver({
      live: this.live,
      log: this.log,
      store: deps.store
    });
    this.observationSubscribe = new MeshAgentObservationSubscribe({
      observation: this.observation,
      observeRaw: (id, afterSeq) => this.observeRaw(id, afterSeq),
      observeConvenience: (id, afterSeq) => this.observeConvenience(id, afterSeq)
    });
    this.eventPages = new MeshAgentEventPages({
      live: this.live,
      monadHome: deps.monadHome,
      resolveAgentEnv: async (agentName) => {
        const agent = (await deps.agents()).find((candidate) => candidate.name === agentName);
        if (!agent) return undefined;
        return (await deps.resolveAgentEnv?.(agent.env)) ?? agent.env;
      },
      store: deps.store
    });
  }

  private openLiveRawStore(id: string, epoch: string): LiveRawStore {
    return LiveRawStore.open({ directory: this.liveRawStoreDirectory, sessionId: id, epoch });
  }

  listLiveEventReplayCaptures(): Promise<LiveEventReplayCapture[]> {
    return (this.liveEventLog?.list() ?? Promise.resolve([])).then((captures) =>
      captures.map((capture) => {
        const projectName = this.deps.store.getWorkplaceProject(capture.projectId)?.title;
        const sessionTitle = this.deps.store.getSession(capture.sessionId)?.title;
        return {
          ...capture,
          ...(projectName ? { projectName } : {}),
          ...(sessionTitle ? { sessionTitle } : {})
        };
      })
    );
  }

  liveEventReplayFrames(
    meshSessionId: MeshSessionId,
    observationEpoch: string,
    query: GetLiveEventReplayFramesQuery
  ): Promise<LiveEventReplayFramePage | undefined> {
    return this.liveEventLog?.page(meshSessionId, observationEpoch, query) ?? Promise.resolve(undefined);
  }

  setManagedProjectOutputHandler(handler: ManagedProjectOutputHandler): void {
    this.managedProjectOutputHandler = handler;
  }

  setManagedProjectLoopEventHandler(handler: ManagedProjectLoopEventHandler): void {
    this.managedProjectLoopEventHandler = handler;
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
    row: Pick<MeshSessionRow, 'agentName' | 'projectMemberId' | 'transcriptTargetId' | 'workingPath'>
  ): string {
    const session = this.deps.store.getSession(row.transcriptTargetId);
    return managedProjectRuntimeWorkspace({
      monadHome: this.deps.monadHome ?? dirname(this.deps.meshAgentProcessRegistryPath ?? row.workingPath),
      projectId: session?.projectId ?? row.transcriptTargetId,
      sessionId: row.transcriptTargetId,
      agentId: row.projectMemberId ?? row.agentName
    });
  }

  private emitConnectionClosed(live: LiveMeshSession, reason: 'exited' | 'failed' | 'stopped' | 'disconnected'): void {
    this.observationEpoch.emitConnectionClosed(live, reason);
  }

  private async applyProviderSessionLifecycle(
    transcriptTargetId: MeshAgentTargetId,
    action: 'archive' | 'unarchive' | 'delete'
  ): Promise<void> {
    await Promise.all(
      this.deps.store.listMeshSessionsForTranscriptTarget(transcriptTargetId).map(async (row) => {
        if (!row.providerSessionRef) return;
        const adapter = getMeshAgentProviderAdapter(row.provider);
        const hook =
          action === 'archive'
            ? adapter.archiveSession
            : action === 'unarchive'
              ? adapter.unarchiveSession
              : adapter.deleteSession;
        if (!hook) return;
        try {
          await hook({
            meshSessionId: row.id,
            transcriptTargetId: row.transcriptTargetId,
            agentName: row.agentName,
            providerSessionRef: row.providerSessionRef,
            workingPath: row.workingPath
          });
        } catch (error) {
          this.log.warn(
            {
              event: 'mesh.provider_session_lifecycle_failed',
              action,
              meshSessionId: row.id,
              provider: row.provider,
              err: error instanceof Error ? { message: error.message } : String(error)
            },
            'provider session lifecycle hook failed'
          );
        }
      })
    );
  }

  reconcileOrphanedSessions(): Promise<number> {
    return this.processLifecycle.reconcileOrphanedSessions();
  }

  async start(args: {
    transcriptTargetId: MeshAgentTargetId;
    projectId?: ProjectId;
    agentName: string;
    projectMemberId?: string;
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
    initialInput?: string;
    beforeInitialTurn?: (meshSessionId: string) => Promise<void>;
    /** Per-member override of the agent template's `allowAutopilot`. When OFF and the adapter can
     *  proxy approvals in the effective launch mode, a managed agent delegates its provider approvals
     *  to the human instead of running unattended. */
    allowAutopilot?: boolean;
  }): Promise<MeshSessionView> {
    const cleanupFailure = await this.liveRawStoreCleanup;
    if (cleanupFailure) throw cleanupFailure;
    return this.sessionEventRuntimeLauncher.start(args);
  }

  async input(id: string, req: MeshAgentInputRequest, options?: { onAccepted?: () => void }): Promise<void> {
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
    if (live.runtimeRole === 'managed-project-agent') {
      this.events.publish(live.transcriptTargetId, 'mesh.turn_started', { meshSessionId: id });
    }
    try {
      const completion = live.sessionEventRuntime.input({ text: req.input, attachments: [] });
      options?.onAccepted?.();
      await completion;
    } catch (error) {
      if (live.runtimeRole === 'managed-project-agent') {
        this.events.publish(live.transcriptTargetId, 'mesh.turn_settled', { meshSessionId: id, error: true });
      }
      throw error;
    }
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

  async sessionUsage(id: string): Promise<MeshAgentSessionUsage | null> {
    const row = this.deps.store.getMeshSession(id);
    if (!row) throw new Error(`MeshAgent session not found: ${id}`);
    const adapter = getMeshAgentProviderAdapter(row.provider);
    if (!adapter.sessionUsage) return null;
    if (!row.providerSessionRef) return null;
    const agent = await requireMeshSessionAgent(this.deps.agents, row.agentName, row.provider);
    const usage = await adapter.sessionUsage.read({
      providerSessionRef: row.providerSessionRef,
      workingPath: row.workingPath,
      executable: resolveMeshAgentExecutable(agent, adapter),
      env: await this.buildSpawnEnv(adapter, agent.env)
    });
    if (usage) this.deps.store.upsertMeshSessionUsageSnapshot(row, usage);
    return usage;
  }

  subscribeSessionUsage(id: string, listener: MeshAgentSessionUsageListener): { dispose: () => void } {
    this.get(id);
    return this.sessionUsageHub.subscribe(id, listener);
  }

  private publishSessionUsage(id: string, usage: MeshAgentSessionUsage): boolean {
    const row = this.deps.store.getMeshSession(id);
    if (row) this.deps.store.upsertMeshSessionUsageSnapshot(row, usage);
    return this.sessionUsageHub.publish(id, usage);
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

  stop(id: string): Promise<void> {
    const pending = this.stopping.get(id);
    if (pending) return pending;
    const live = this.live.get(id);
    if (!live) return Promise.resolve();
    if (!live.sessionEventRuntime) return Promise.reject(new Error(`MeshAgent session runtime is unavailable: ${id}`));
    const runtime = live.sessionEventRuntime;
    const row = this.deps.store.getMeshSession(id);
    const pid = runtime.snapshot().activity.state === 'running' ? runtime.snapshot().activity.pid : row?.pid;
    this.log.debug(
      {
        event: 'mesh.runtime.stop_requested',
        sessionId: live.transcriptTargetId,
        memberId: row?.projectMemberId ?? null,
        meshSessionId: id,
        runtimeGeneration: id,
        pid: pid ?? null
      },
      'native cli stop requested'
    );
    const stopping = (async () => {
      await runtime.close();
      const terminal = runtime.snapshot().lifecycle;
      const termination = terminal.state === 'terminal' ? terminal.termination : undefined;
      disposeLiveCapture(live);
      this.live.delete(id);
      if (row?.runtimeRole === 'managed-project-agent')
        cleanupManagedProjectRuntimeToken(this.managedRuntimeWorkspace(row));
      const exitedAt = termination?.at ?? new Date().toISOString();
      this.emitConnectionClosed(live, 'stopped');
      this.deps.store.closeMeshSession(id, exitedAt, null, 'stopped');
      // Settle only after the old child, stdio readers, and driver have joined. The current-id CAS is the
      // generation guard: a late callback from this runtime can never clear a replacement's ownership.
      if (row?.runtimeRole === 'managed-project-agent' && row.projectMemberId) {
        this.deps.store.settleTerminalSessionBindingRuntime({
          sessionId: row.transcriptTargetId,
          projectMemberId: row.projectMemberId,
          terminatingRuntimeId: id,
          terminalState: 'stopped',
          at: exitedAt
        });
      }
      this.events.emit(live.transcriptTargetId, 'mesh.exited', {
        meshSessionId: id,
        exitCode: null,
        state: 'stopped'
      });
      this.log.debug(
        {
          event: 'mesh.runtime.stop_joined',
          sessionId: live.transcriptTargetId,
          memberId: row?.projectMemberId ?? null,
          meshSessionId: id,
          runtimeGeneration: id,
          pid: pid ?? null,
          exitCode: termination?.exitCode ?? null,
          signal: termination?.signal ?? null
        },
        'native cli stop joined'
      );
    })().finally(() => this.stopping.delete(id));
    this.stopping.set(id, stopping);
    return stopping;
  }

  async stopSession(sessionId: MeshAgentTargetId): Promise<void> {
    await Promise.all(
      [...this.live.values()].filter((live) => live.transcriptTargetId === sessionId).map((live) => this.stop(live.id))
    );
  }

  archiveSession(sessionId: MeshAgentTargetId): Promise<void> {
    return this.applyProviderSessionLifecycle(sessionId, 'archive');
  }

  unarchiveSession(sessionId: MeshAgentTargetId): Promise<void> {
    return this.applyProviderSessionLifecycle(sessionId, 'unarchive');
  }

  deleteSession(sessionId: MeshAgentTargetId): Promise<void> {
    return this.applyProviderSessionLifecycle(sessionId, 'delete');
  }

  async stopAll(): Promise<void> {
    this.disposeLoginNudge();
    await Promise.all(
      [...this.live.keys()].map(async (id) => {
        try {
          await this.stop(id);
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
      })
    );
  }

  async stopAgentProvider(provider: MeshAgentView['provider']): Promise<void> {
    let stopped = 0;
    const matching = [...this.live.values()].filter((live) => live.provider === provider);
    stopped = matching.length;
    await Promise.all(matching.map((live) => this.stop(live.id)));
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

  async usageOverview(): Promise<MeshUsageOverviewResponse> {
    const agents = await this.deps.agents();
    await Promise.all(
      agents.map((agent) =>
        this.authHost.usage(agent.name).catch((error) => {
          this.log.warn(
            {
              event: 'mesh.usage_refresh_failed',
              agentName: agent.name,
              provider: agent.provider,
              err: error instanceof Error ? error.message : String(error)
            },
            'provider usage refresh failed'
          );
        })
      )
    );
    return this.deps.store.listMeshUsageOverview();
  }

  preflight(agentName: string): Promise<MeshAgentStartPreflight> {
    return this.authHost.preflight(agentName);
  }

  pendingLoginRequiredEvents(sessionId: SessionId): Event[] {
    return this.loginNudge.pendingLoginRequiredEvents(sessionId);
  }

  pendingLoginRequirements(sessionId: SessionId): MeshAgentLoginRequirement[] {
    return this.loginNudge.pendingLoginRequirements(sessionId);
  }
}
