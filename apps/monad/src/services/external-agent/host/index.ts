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
  ExternalAgentProvider,
  ExternalAgentResizeRequest,
  ExternalAgentSessionView,
  ExternalAgentUsageResponse,
  ExternalAgentView,
  ListExternalAgentRuntimesQuery,
  ListExternalAgentRuntimesResponse,
  ListExternalAgentSessionsResponse,
  TranscriptTargetId
} from '@monad/protocol';
import type {
  ExternalAgentHostDeps,
  ExternalAgentObservationListener,
  LiveExternalAgentSession,
  ManagedProjectOutputHandler
} from '@/services/external-agent/host/host-types.ts';
import type { ExternalAgentProviderAdapter, ExternalAgentStartPreflight } from '@/services/external-agent/types.ts';
import type { ExternalAgentSessionRow } from '@/store/db/index.ts';

import { dirname } from 'node:path';
import { externalAgentStreamItems } from '@monad/atoms/external-agent-observation';
import { createLogger } from '@monad/logger';

import { ExternalAgentAuthHost, type ExternalAgentAuthListener } from '@/services/external-agent/auth-host.ts';
import { MAX_OUTPUT_SNAPSHOT } from '@/services/external-agent/constants.ts';
import { ExternalAgentError } from '@/services/external-agent/errors.ts';
import { ExternalAgentAppServerConnectionManager } from '@/services/external-agent/host/app-server-connection.ts';
import { ExternalAgentOneshotRunner } from '@/services/external-agent/host/cli-oneshot.ts';
import { ExternalAgentEventLog } from '@/services/external-agent/host/event-log.ts';
import {
  EXTERNAL_AGENT_IDLE_TIMEOUT_MS,
  HISTORY_PAGE_TIMEOUT_MS
} from '@/services/external-agent/host/host-constants.ts';
import { toView } from '@/services/external-agent/host/host-helpers.ts';
import { ExternalAgentObservationHub } from '@/services/external-agent/host/observation-hub.ts';
import { ExternalAgentObservationResolver } from '@/services/external-agent/host/observation-resolve.ts';
import { ExternalAgentOutputPipeline } from '@/services/external-agent/host/output-pipeline.ts';
import { ExternalAgentProcessLifecycle } from '@/services/external-agent/host/process-lifecycle.ts';
import { ExternalAgentSessionLauncher } from '@/services/external-agent/host/session-launcher.ts';
import { getExternalAgentProviderAdapter } from '@/services/external-agent/index.ts';
import {
  cleanupManagedProjectRuntimeToken,
  managedProjectRuntimeWorkspace
} from '@/services/external-agent/managed-project.ts';
import { killExternalAgentProcess } from '@/services/external-agent/process.ts';
import { buildExternalAgentSpawnEnv, requireExternalAgent } from '@/services/external-agent/spawn-support.ts';

export type { ExternalAgentHostDeps };

const STORED_HISTORY_CURSOR_PREFIX = 'snapshot:';

function storedOutputHistoryPage(
  output: string,
  req: ExternalAgentHistoryPageRequest,
  id: string,
  provider: ExternalAgentProvider
): ExternalAgentHistoryPageResponse {
  const lines = output.split('\n').filter((line) => line.trim().length > 0);
  const end = storedHistoryCursorEnd(req.before, lines.length);
  const start = Math.max(0, end - req.limit);
  const pageLines = lines.slice(start, end);
  const pageOutput = pageLines.join('\n');
  return {
    // The daemon already knows `provider` unambiguously (the session row) — normalize with the same
    // adapter used for parseOutput/historyPageOutput instead of making the client re-derive it. Raw
    // JSONL isn't shipped separately: each event's `raw` already carries its source record(s).
    events: externalAgentStreamItems({
      id: `${id}:history:${start}`,
      adapter: getExternalAgentProviderAdapter(provider),
      output: pageOutput,
      mode: 'history'
    }),
    ...(start > 0 ? { nextCursor: `${STORED_HISTORY_CURSOR_PREFIX}${start}` } : {})
  };
}

function storedHistoryCursorEnd(cursor: string | undefined, fallback: number): number {
  if (!cursor?.startsWith(STORED_HISTORY_CURSOR_PREFIX)) return fallback;
  const value = Number.parseInt(cursor.slice(STORED_HISTORY_CURSOR_PREFIX.length), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(fallback, value));
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
  /** Builds and dispatches durable/ephemeral external agent session events. */
  private readonly events: ExternalAgentEventLog;
  /** Owns app-server socket/port allocation and the disconnect→redial→give-up flow. */
  private readonly appServerConnections: ExternalAgentAppServerConnectionManager;
  /** Owns the child-process output path: buffering, snapshot flush, and structured-event decoding. */
  private readonly outputPipeline: ExternalAgentOutputPipeline;
  /** Runs `cli-oneshot` sessions: a logical session with no persistent process. */
  private readonly oneshotRunner: ExternalAgentOneshotRunner;
  /** Mirrors spawned/exited child pids into the daemon-wide child-process registry and the durable
   *  on-disk registry file, and reconciles orphans left by an uncleanly-stopped daemon. */
  private readonly processLifecycle: ExternalAgentProcessLifecycle;
  /** Builds and spawns a fresh external agent session (agent/launch resolution, process spawn, stream
   *  wiring, exit/idle-resume bookkeeping). */
  private readonly sessionLauncher: ExternalAgentSessionLauncher;
  /** Resolves a session's current observable state (live buffer / durable snapshot / provider
   *  history), independent of the observation subscription/publish side above. */
  private readonly observationResolver: ExternalAgentObservationResolver;

  constructor(private readonly deps: ExternalAgentHostDeps) {
    this.authHost = new ExternalAgentAuthHost(deps);
    this.events = new ExternalAgentEventLog({ store: deps.store, bus: deps.bus });
    this.appServerConnections = new ExternalAgentAppServerConnectionManager({
      live: this.live,
      emit: (sessionId, type, payload) => this.events.emit(sessionId, type, payload),
      stop: (id) => this.stop(id),
      log: this.log
    });
    this.outputPipeline = new ExternalAgentOutputPipeline({
      live: this.live,
      store: deps.store,
      events: this.events,
      observation: this.observation,
      stop: (id) => this.stop(id),
      getManagedProjectOutputHandler: () => this.managedProjectOutputHandler,
      log: this.log,
      armIdleSuspend: (live) => this.armIdleSuspend(live),
      historyPageOutput: (live, request, items) => this.historyPageOutput(live, request, items)
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
      untrackProcess: (pid) => this.processLifecycle.untrack(pid)
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
      updateExternalAgentPid: (id, pid) => this.updateExternalAgentPid(id, pid)
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
    this.outputPipeline.flushSnapshot(id);
    this.updateExternalAgentPid(id, null);
    this.observation.publish(id);
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
        await live.restartRuntime();
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

  reconcileOrphanedSessions(): Promise<number> {
    return this.processLifecycle.reconcileOrphanedSessions();
  }

  start(args: {
    transcriptTargetId: TranscriptTargetId;
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
    return toView(row, live?.pendingApprovals.size ?? 0, live);
  }

  list(transcriptTargetId: TranscriptTargetId): ListExternalAgentSessionsResponse {
    return {
      sessions: this.deps.store.listExternalAgentSessionsForTranscriptTarget(transcriptTargetId).map((row) => {
        const live = this.live.get(row.id);
        return toView(row, live?.pendingApprovals.size ?? 0, live);
      })
    };
  }

  /** Every external agent runtime across the daemon without output buffers. Used by overview surfaces
   *  that need durable counters such as unread messages even after a runtime exits. */
  listAllSummaries(query: ListExternalAgentRuntimesQuery = {}): ListExternalAgentRuntimesResponse {
    const views = this.deps.store.listExternalAgentSessions().map((row) => {
      const live = this.live.get(row.id);
      return { ...toView(row, live?.pendingApprovals.size ?? 0, live), outputSnapshot: '' };
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
      return { ...toView(row, live?.pendingApprovals.size ?? 0, live), outputSnapshot: '' };
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
      killExternalAgentProcess(live.oneshotTurnProc.pid);
      this.processLifecycle.untrack(live.oneshotTurnProc.pid);
      live.oneshotTurnProc = undefined;
    }
    this.outputPipeline.flushSnapshot(id);
    this.live.delete(id);
    const row = this.deps.store.getExternalAgentSession(id);
    if (row?.runtimeRole === 'managed-project-agent')
      cleanupManagedProjectRuntimeToken(this.managedRuntimeWorkspace(row));
    if (live.proc) this.processLifecycle.untrack(live.proc.pid);
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

  stopTranscriptTarget(transcriptTargetId: TranscriptTargetId): void {
    for (const live of [...this.live.values()]) {
      if (live.transcriptTargetId === transcriptTargetId) this.stop(live.id);
    }
  }

  stopAll(): void {
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
    const providerSessionRef = live.providerSessionRef ?? live.initializeContext?.providerSessionRef ?? undefined;
    const workingPath = live.initializeContext?.workingPath;
    if (live.adapter.historyPage && providerSessionRef && workingPath) {
      const page = await live.adapter.historyPage({
        providerSessionRef,
        workingPath,
        limitBytes: MAX_OUTPUT_SNAPSHOT,
        request: req
      });
      if (page) return this.providerHistoryPageResponse(id, live.adapter, providerSessionRef, workingPath, req, page);
    }
    if (!live.adapter.requestHistoryPage) {
      throw new ExternalAgentError(
        'unsupported_capability',
        `external agent provider does not support paged history: ${id}`
      );
    }
    const requestId = live.nextRequestId();
    const responseId = String(requestId);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        live.pendingHistoryPages.delete(responseId);
        reject(new ExternalAgentError('provider_timeout', `timed out waiting for external agent history page: ${id}`));
      }, HISTORY_PAGE_TIMEOUT_MS);
      live.pendingHistoryPages.set(responseId, {
        timeout,
        request: req,
        resolve: (page) =>
          resolve({ events: page.events, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }),
        reject
      });
      try {
        live.adapter.requestHistoryPage?.({ ...live, nextRequestId: () => requestId }, req);
      } catch (error) {
        clearTimeout(timeout);
        live.pendingHistoryPages.delete(responseId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async storedHistoryPage(
    id: string,
    req: ExternalAgentHistoryPageRequest
  ): Promise<ExternalAgentHistoryPageResponse> {
    const row = this.deps.store.getExternalAgentSession(id);
    if (row?.providerSessionRef) {
      const adapter = getExternalAgentProviderAdapter(row.provider);
      const page = await adapter.historyPage?.({
        providerSessionRef: row.providerSessionRef,
        workingPath: row.workingPath,
        limitBytes: MAX_OUTPUT_SNAPSHOT,
        request: req
      });
      if (page)
        return this.providerHistoryPageResponse(id, adapter, row.providerSessionRef, row.workingPath, req, page);
    }
    const access = await this.observeWithProviderHistory(id);
    if (access.state === 'unavailable') {
      throw new ExternalAgentError(
        'unsupported_capability',
        access.reason ?? `external agent history unavailable for stopped session: ${id}`
      );
    }
    return storedOutputHistoryPage(access.output ?? '', req, id, access.provider);
  }

  private providerHistoryPageResponse(
    id: string,
    adapter: ExternalAgentProviderAdapter,
    providerSessionRef: string,
    workingPath: string,
    req: ExternalAgentHistoryPageRequest,
    page: { items: unknown[]; nextCursor?: string }
  ): ExternalAgentHistoryPageResponse {
    const output =
      adapter.historyPageOutput?.({
        providerSessionRef,
        workingPath,
        limitBytes: MAX_OUTPUT_SNAPSHOT,
        page
      }) ?? page.items.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n');
    return {
      events: externalAgentStreamItems({
        id: `${id}:history:provider:${req.before ?? '0'}`,
        adapter,
        output,
        mode: 'history'
      }),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
    };
  }

  private historyPageOutput(
    live: LiveExternalAgentSession,
    request: ExternalAgentHistoryPageRequest,
    items: unknown[]
  ): string | undefined {
    const providerSessionRef = live.providerSessionRef ?? live.initializeContext?.providerSessionRef ?? undefined;
    const workingPath = live.initializeContext?.workingPath;
    const historyPageOutput = live.adapter.historyPageOutput;
    if (!providerSessionRef || !workingPath || !historyPageOutput) return undefined;
    const presentationItems = request.sortDirection === 'desc' ? [...items].reverse() : items;
    return (
      historyPageOutput({
        providerSessionRef,
        workingPath,
        limitBytes: MAX_OUTPUT_SNAPSHOT,
        page: {
          items: presentationItems,
          nextCursor: undefined
        }
      }) ?? undefined
    );
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
