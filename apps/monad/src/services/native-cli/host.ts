import type {
  ListNativeCliSessionsResponse,
  NativeCliAgentView,
  NativeCliApprovalResolutionRequest,
  NativeCliAppServerTransport,
  NativeCliAuthSessionView,
  NativeCliAuthStatusResponse,
  NativeCliHistoryPageRequest,
  NativeCliHistoryPageResponse,
  NativeCliInputRequest,
  NativeCliLaunchMode,
  NativeCliObservationAccessResponse,
  NativeCliResizeRequest,
  NativeCliSessionView,
  NativeCliUsageResponse,
  ProjectId,
  TranscriptTargetId
} from '@monad/protocol';
import type {
  LiveNativeCliSession,
  ManagedProjectOutputHandler,
  NativeCliHostDeps,
  NativeCliObservationListener
} from '@/services/native-cli/host-types.ts';
import type { NativeCliProcess, NativeCliTerminal } from '@/services/native-cli/runtime-types.ts';
import type { NativeCliLaunchSpec, NativeCliStartPreflight } from '@/services/native-cli/types.ts';
import type { NativeCliSessionRow } from '@/store/db/index.ts';

import { chmodSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { createLogger } from '@monad/logger';
import { newId } from '@monad/protocol';

import { NativeCliAppServerConnectionManager } from '@/services/native-cli/app-server-connection.ts';
import { connectAppServerStdio } from '@/services/native-cli/app-server-stdio.ts';
import { connectAppServerUnix } from '@/services/native-cli/app-server-unix.ts';
import { connectAppServerWs, dialAppServerWs, dialAppServerWsWithRetry } from '@/services/native-cli/app-server-ws.ts';
import { NativeCliAuthHost, type NativeCliAuthListener } from '@/services/native-cli/auth-host.ts';
import { BoundedOutputBuffer } from '@/services/native-cli/bounded-output-buffer.ts';
import { NativeCliOneshotRunner } from '@/services/native-cli/cli-oneshot.ts';
import { MAX_OUTPUT_SNAPSHOT } from '@/services/native-cli/constants.ts';
import { NativeCliError } from '@/services/native-cli/errors.ts';
import { NativeCliEventLog } from '@/services/native-cli/event-log.ts';
import { providerHistoryOutputFromLocal, providerHistoryOutputViaCli } from '@/services/native-cli/history-backfill.ts';
import { APP_SERVER_STARTUP_TIMEOUT_MS, HISTORY_PAGE_TIMEOUT_MS } from '@/services/native-cli/host-constants.ts';
import { isManagedProjectRuntime, toView } from '@/services/native-cli/host-helpers.ts';
import {
  buildNativeCliLaunch,
  getNativeCliProviderAdapter,
  resolveNativeCliLaunchCommand
} from '@/services/native-cli/index.ts';
import {
  cleanupManagedProjectOrphanTokens,
  cleanupManagedProjectRuntimeToken,
  managedProjectRuntimeWorkspace,
  prepareManagedProjectRuntime
} from '@/services/native-cli/managed-project.ts';
import { NativeCliObservationHub } from '@/services/native-cli/observation-hub.ts';
import { NativeCliOutputPipeline } from '@/services/native-cli/output-pipeline.ts';
import {
  killNativeCliProcess,
  pickPtyFallbackLaunchMode,
  readProcessRegistry,
  writeProcessRegistry
} from '@/services/native-cli/process.ts';
import { buildNativeCliSpawnEnv, requireNativeCliAgent } from '@/services/native-cli/spawn-support.ts';
import { createStreamingTextDecoder } from '@/services/native-cli/stream-decoder.ts';

export type { NativeCliHostDeps };

export class NativeCliHost {
  private readonly log = createLogger('native-cli');

  private readonly live = new Map<string, LiveNativeCliSession>();
  private readonly observation = new NativeCliObservationHub({
    getLive: (id) => this.live.get(id),
    observe: (id, afterSeq) => this.observe(id, afterSeq)
  });
  private managedProjectOutputHandler: ManagedProjectOutputHandler | null = null;
  /** Provider-login (auth) sessions and one-shot auth/usage probes live in their own host; they share
   *  no state with interactive sessions. Public auth methods below delegate straight through. */
  private readonly authHost: NativeCliAuthHost;
  /** Builds and dispatches durable/ephemeral native-CLI session events. */
  private readonly events: NativeCliEventLog;
  /** Owns app-server socket/port allocation and the disconnect→redial→give-up flow. */
  private readonly appServerConnections: NativeCliAppServerConnectionManager;
  /** Owns the child-process output path: buffering, snapshot flush, and structured-event decoding. */
  private readonly outputPipeline: NativeCliOutputPipeline;
  /** Runs `cli-oneshot` sessions: a logical session with no persistent process. */
  private readonly oneshotRunner: NativeCliOneshotRunner;
  /** Serializes read-modify-write access to the native-CLI process registry file: the reads/writes
   *  are async (never block the event loop), so overlapping track/untrack calls are chained onto
   *  this promise instead of racing each other and losing an update. */
  private registryQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: NativeCliHostDeps) {
    this.authHost = new NativeCliAuthHost(deps);
    this.events = new NativeCliEventLog({ store: deps.store, bus: deps.bus });
    this.appServerConnections = new NativeCliAppServerConnectionManager({
      live: this.live,
      emit: (sessionId, type, payload) => this.events.emit(sessionId, type, payload),
      stop: (id) => this.stop(id),
      log: this.log
    });
    this.outputPipeline = new NativeCliOutputPipeline({
      live: this.live,
      store: deps.store,
      events: this.events,
      observation: this.observation,
      stop: (id) => this.stop(id),
      getManagedProjectOutputHandler: () => this.managedProjectOutputHandler,
      log: this.log
    });
    this.oneshotRunner = new NativeCliOneshotRunner({
      live: this.live,
      store: deps.store,
      events: this.events,
      outputPipeline: this.outputPipeline,
      buildSpawnEnv: (env) => this.buildSpawnEnv(env),
      trackProcess: (pid) => this.trackNativeCliProcess(pid),
      untrackProcess: (pid) => this.untrackNativeCliProcess(pid)
    });
  }

  setManagedProjectOutputHandler(handler: ManagedProjectOutputHandler): void {
    this.managedProjectOutputHandler = handler;
  }

  private buildSpawnEnv(launchEnv?: Record<string, string>): Promise<Record<string, string>> {
    return buildNativeCliSpawnEnv(this.deps.resolveAgentEnv, launchEnv);
  }

  private requireAgent(name: string): Promise<NativeCliAgentView> {
    return requireNativeCliAgent(this.deps.agents, name);
  }

  private managedRuntimeWorkspace(
    row: Pick<NativeCliSessionRow, 'agentName' | 'transcriptTargetId' | 'workingPath'>
  ): string {
    return managedProjectRuntimeWorkspace({
      monadHome: this.deps.monadHome ?? dirname(this.deps.nativeCliProcessRegistryPath ?? row.workingPath),
      projectId: row.transcriptTargetId,
      agentName: row.agentName
    });
  }

  async reconcileOrphanedSessions(): Promise<number> {
    const native = this.deps.store.reconcileOrphanedNativeCliSessions((pid) => killNativeCliProcess(pid));
    const orphanedTokens = this.deps.monadHome ? cleanupManagedProjectOrphanTokens(this.deps.monadHome) : 0;
    const orphanedNative = await readProcessRegistry(this.deps.nativeCliProcessRegistryPath);
    for (const pid of orphanedNative) killNativeCliProcess(pid);
    await writeProcessRegistry(this.deps.nativeCliProcessRegistryPath, []);
    const auth = await readProcessRegistry(this.deps.authProcessRegistryPath);
    for (const pid of auth) killNativeCliProcess(pid);
    await writeProcessRegistry(this.deps.authProcessRegistryPath, []);
    return native + orphanedTokens + orphanedNative.length + auth.length;
  }

  private trackNativeCliProcess(pid: number): void {
    this.registryQueue = this.registryQueue
      .then(() => readProcessRegistry(this.deps.nativeCliProcessRegistryPath))
      .then((pids) => writeProcessRegistry(this.deps.nativeCliProcessRegistryPath, [...new Set([...pids, pid])]))
      .catch(() => {
        /* best-effort registry write — never blocks or breaks the queue for later calls */
      });
  }

  private untrackNativeCliProcess(pid: number): void {
    this.registryQueue = this.registryQueue
      .then(() => readProcessRegistry(this.deps.nativeCliProcessRegistryPath))
      .then((pids) =>
        writeProcessRegistry(
          this.deps.nativeCliProcessRegistryPath,
          pids.filter((candidate) => candidate !== pid)
        )
      )
      .catch(() => {
        /* best-effort registry write — never blocks or breaks the queue for later calls */
      });
  }

  async start(args: {
    transcriptTargetId: TranscriptTargetId;
    agentName: string;
    displayName?: string;
    templateAgentName?: string;
    workingPath: string;
    launchMode?: NativeCliLaunchMode;
    appServerTransport?: NativeCliAppServerTransport;
    runtimeRole?: NativeCliSessionView['runtimeRole'];
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
  }): Promise<NativeCliSessionView> {
    const runtimeAgentName = args.agentName;
    let agent = await this.requireAgent(args.templateAgentName ?? args.agentName);
    if (!isAbsolute(args.workingPath)) throw new Error('workingPath must be absolute');
    let workingPath: string;
    try {
      workingPath = realpathSync(args.workingPath);
    } catch {
      throw new Error(`workingPath must be an existing directory: ${args.workingPath}`);
    }
    if (!statSync(workingPath).isDirectory())
      throw new Error(`workingPath must be an existing directory: ${args.workingPath}`);
    const adapter = getNativeCliProviderAdapter(agent.provider);
    const id = newId('ncli');
    const now = new Date().toISOString();
    let requestSeq = 0;
    const runtimeRole = args.runtimeRole ?? 'interactive';
    const willBeManaged = runtimeRole === 'managed-project-agent';

    // A managed agent runs autopilot unless the operator turned it OFF *and* the adapter can actually
    // project + resolve approvals in this launch mode. When it can't, the skip flag stays on —
    // dropping it would leave the CLI blocked on an approval it has no channel to resolve. The member
    // setting overrides the agent template's `allowAutopilot`. Computed before `prepareManagedProjectRuntime`
    // so `skipProviderApprovals` can reach `managedRuntime.env` for a provider whose autopilot toggle has
    // no CLI-flag equivalent (OpenClaw) and must instead write its own config into the managed workspace.
    const effectiveLaunchMode = args.launchMode ?? agent.defaultLaunchMode;
    const allowAutopilot = args.allowAutopilot ?? agent.allowAutopilot;
    const proxyApprovals =
      willBeManaged && allowAutopilot === false && (adapter.supportsApprovalResolution?.(effectiveLaunchMode) ?? false);
    const skipProviderApprovals = willBeManaged && !proxyApprovals;
    // Reflect the resolved (member-override-aware) value back onto `agent` before it reaches
    // `buildNativeCliLaunch` — that call's `assertSafeArgs` gates dangerous static argv on
    // `agent.allowAutopilot` too, and it must see the same resolved value this session actually runs
    // with, not the template's raw default.
    if (allowAutopilot !== agent.allowAutopilot) agent = { ...agent, allowAutopilot };

    const managed = willBeManaged
      ? prepareManagedProjectRuntime({
          monadHome: this.deps.monadHome ?? dirname(this.deps.nativeCliProcessRegistryPath ?? workingPath),
          serverUrl: this.deps.serverUrl ?? `http://127.0.0.1:${Bun.env.MONAD_PORT || '52749'}`,
          agentName: runtimeAgentName,
          displayName: args.displayName,
          projectId: args.transcriptTargetId as ProjectId,
          nativeCliSessionId: id,
          provider: agent.provider,
          modelName: args.modelName,
          modelId: args.modelId,
          reasoningEffort: args.reasoningEffort,
          speed: args.speed,
          customPrompt: args.customPrompt,
          baseEnvPath: Bun.env.PATH,
          skipProviderApprovals
        })
      : null;

    let pendingCR = false;
    const decoder = createStreamingTextDecoder();
    let launch: NativeCliLaunchSpec;
    let proc: NativeCliProcess;
    // A `unix` app-server transport needs the daemon to pick the socket path the child listens on
    // (browser-unreachable channel). Allocate it before the launch so it lands in both the argv and
    // the dial target.
    const wantsUnixAppServer =
      effectiveLaunchMode === 'app-server' && (args.appServerTransport ?? agent.appServerTransport) === 'unix';
    const appServerSocketPath = wantsUnixAppServer ? this.appServerConnections.allocateSocketPath(id) : undefined;
    // A `ws` app-server MAY prefer a daemon-assigned port over self-announcing one (see
    // `NativeCliAppServerWsHints.port`) — allocate a candidate up front so `buildLaunch` can put it in
    // argv if it wants to. Gated on the adapter's own opt-in (not just transport === 'ws'), since a
    // self-announcing ws provider (e.g. codex) never reads the allocated port and the bind+release
    // syscall would otherwise run on every one of its app-server launches for nothing.
    const wantsWsAppServer =
      effectiveLaunchMode === 'app-server' &&
      (args.appServerTransport ?? agent.appServerTransport ?? 'ws') === 'ws' &&
      !!adapter.usesDaemonAssignedAppServerPort;
    const appServerPort = wantsWsAppServer ? await this.appServerConnections.allocatePort() : undefined;
    // Reusable so a pty-spawn failure (e.g. Bun's ConPTY support unavailable on the host) can rebuild
    // the launch spec for a fallback launchMode without duplicating every option.
    const buildLaunchOpts = (overrides?: {
      launchMode?: NativeCliLaunchMode;
      appServerTransport?: NativeCliAppServerTransport;
    }) => ({
      workingPath,
      extraWorkingPaths: managed ? [managed.workspace] : undefined,
      launchMode: overrides?.launchMode ?? args.launchMode,
      appServerTransport: overrides?.appServerTransport ?? args.appServerTransport,
      appServerSocketPath,
      appServerPort,
      systemPromptFile: adapter.managedRuntime?.usesSystemPromptFile ? (managed?.promptFile ?? undefined) : undefined,
      skipProviderApprovals,
      providerSessionRef: args.providerSessionRef,
      modelName: args.modelName,
      reasoningEffort: args.reasoningEffort,
      speed: args.speed,
      modelId: args.modelId,
      mcpConfigArgs: managed?.mcpConfigArgs
    });
    try {
      launch = resolveNativeCliLaunchCommand(adapter, buildNativeCliLaunch(agent, buildLaunchOpts()));
    } catch (error) {
      if (managed) cleanupManagedProjectRuntimeToken(managed.workspace);
      const failedAt = new Date().toISOString();
      this.deps.store.upsertNativeCliSession({
        id,
        transcriptTargetId: args.transcriptTargetId,
        agentName: runtimeAgentName,
        provider: agent.provider,
        workingPath,
        launchMode: effectiveLaunchMode,
        runtimeRole,
        agentRuntimeId: runtimeRole === 'managed-project-agent' ? id : null,
        agentRuntimeTokenHash: managed?.tokenHash ?? null,
        lastDeliveredSeq: 0,
        lastVisibleSeq: 0,
        state: 'failed',
        pid: null,
        providerSessionRef: args.providerSessionRef ?? null,
        outputSnapshot: error instanceof Error ? error.message : String(error),
        exitCode: null,
        startedAt: now,
        updatedAt: failedAt,
        exitedAt: failedAt
      });
      this.events.emit(args.transcriptTargetId, 'native_cli.exited', {
        nativeCliSessionId: id,
        exitCode: null,
        state: 'failed'
      });
      this.log.error(
        {
          sessionId: args.transcriptTargetId,
          event: 'native_cli.launch_failed',
          nativeCliSessionId: id,
          agentName: runtimeAgentName,
          provider: agent.provider,
          err: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
        },
        'native cli launch failed'
      );
      throw error;
    }
    this.log.debug(
      {
        sessionId: args.transcriptTargetId,
        event: 'native_cli.launch',
        nativeCliSessionId: id,
        agentName: runtimeAgentName,
        provider: agent.provider,
        argv: launch.argv,
        cwd: launch.cwd,
        launchMode: launch.launchMode,
        providerSessionRef: args.providerSessionRef ?? null
      },
      'native cli launch'
    );
    launch = managed ? { ...launch, env: { ...(launch.env ?? {}), ...managed.env } } : launch;
    // cli-oneshot spawns a fresh process PER TURN (no persistent child), so it forks off the shared
    // spawn path here — the session is a logical entity and each `input()` runs one process.
    if (launch.launchMode === 'cli-oneshot') {
      return this.oneshotRunner.start({
        id,
        transcriptTargetId: args.transcriptTargetId,
        agentName: runtimeAgentName,
        provider: agent.provider,
        workingPath,
        runtimeRole,
        launch,
        adapter,
        managed,
        providerSessionRef: args.providerSessionRef ?? null,
        startedAt: now
      });
    }
    let spawnEnv = await this.buildSpawnEnv(launch.env);
    // ws/unix app-server: codex listens on a socket and speaks the protocol over it, so the daemon
    // ignores stdin and treats stdout/stderr as logs (for ws, stderr also carries the listen port).
    let isAppServerWs = launch.launchMode === 'app-server' && launch.appServerTransport === 'ws';
    let isAppServerUnix = launch.launchMode === 'app-server' && launch.appServerTransport === 'unix';
    let isAppServerSocket = isAppServerWs || isAppServerUnix;
    const spawnPipeMode = (): NativeCliProcess =>
      Bun.spawn(launch.argv, {
        cwd: launch.cwd,
        env: spawnEnv,
        detached: true,
        stdin: isAppServerSocket ? 'ignore' : 'pipe',
        stdout: 'pipe',
        stderr: 'pipe'
      }) as NativeCliProcess;
    try {
      if (launch.launchMode === 'pty') {
        try {
          proc = Bun.spawn(launch.argv, {
            cwd: launch.cwd,
            env: spawnEnv,
            detached: true,
            stdout: 'ignore',
            stderr: 'ignore',
            stdin: 'ignore',
            terminal: {
              cols: 100,
              rows: 30,
              data: (_terminal: NativeCliTerminal, data: Uint8Array) => {
                let text = decoder.decode(data);
                if (pendingCR) text = `\r${text}`;
                pendingCR = text.endsWith('\r');
                if (pendingCR) text = text.slice(0, -1);
                text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                if (text) this.outputPipeline.output(args.transcriptTargetId, id, text, 'pty', adapter);
              }
            }
          } as Bun.SpawnOptions.OptionsObject<'ignore', 'ignore', 'ignore'>) as NativeCliProcess;
        } catch (ptyError) {
          // Bun's pty (`terminal:`) needs a working POSIX pty or ConPTY; hosts where that's
          // unavailable (older Windows, some sandboxes) throw here. Degrade to a non-interactive
          // launch mode instead of failing the whole session, mirroring the sandboxed process
          // tool's own pty→pipe fallback (apps/monad/src/capabilities/tools/registry/process.ts).
          const preset = adapter.detect();
          const fallbackMode = pickPtyFallbackLaunchMode(
            preset.supportedLaunchModes,
            preset.supportedAppServerTransports
          );
          if (!fallbackMode) throw ptyError;
          this.log.warn(
            {
              sessionId: args.transcriptTargetId,
              nativeCliSessionId: id,
              provider: agent.provider,
              fallbackMode,
              err: ptyError instanceof Error ? ptyError.message : String(ptyError)
            },
            'native cli pty spawn failed — falling back to non-pty launch mode'
          );
          launch = resolveNativeCliLaunchCommand(
            adapter,
            buildNativeCliLaunch(
              agent,
              buildLaunchOpts({
                launchMode: fallbackMode,
                appServerTransport: fallbackMode === 'app-server' ? 'stdio' : undefined
              })
            )
          );
          launch = managed ? { ...launch, env: { ...(launch.env ?? {}), ...managed.env } } : launch;
          spawnEnv = await this.buildSpawnEnv(launch.env);
          isAppServerWs = launch.launchMode === 'app-server' && launch.appServerTransport === 'ws';
          isAppServerUnix = launch.launchMode === 'app-server' && launch.appServerTransport === 'unix';
          isAppServerSocket = isAppServerWs || isAppServerUnix;
          proc = spawnPipeMode();
        }
      } else {
        proc = spawnPipeMode();
      }
    } catch (error) {
      if (managed) cleanupManagedProjectRuntimeToken(managed.workspace);
      const failedAt = new Date().toISOString();
      this.deps.store.upsertNativeCliSession({
        id,
        transcriptTargetId: args.transcriptTargetId,
        agentName: runtimeAgentName,
        provider: agent.provider,
        workingPath,
        launchMode: launch.launchMode,
        runtimeRole,
        agentRuntimeId: runtimeRole === 'managed-project-agent' ? id : null,
        agentRuntimeTokenHash: managed?.tokenHash ?? null,
        lastDeliveredSeq: 0,
        lastVisibleSeq: 0,
        state: 'failed',
        pid: null,
        providerSessionRef: args.providerSessionRef ?? null,
        outputSnapshot: error instanceof Error ? error.message : String(error),
        exitCode: null,
        startedAt: now,
        updatedAt: failedAt,
        exitedAt: failedAt
      });
      this.events.emit(args.transcriptTargetId, 'native_cli.exited', {
        nativeCliSessionId: id,
        exitCode: null,
        state: 'failed'
      });
      this.log.error(
        {
          sessionId: args.transcriptTargetId,
          event: 'native_cli.launch_failed',
          nativeCliSessionId: id,
          agentName: runtimeAgentName,
          provider: agent.provider,
          err: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
        },
        'native cli launch failed'
      );
      throw error;
    }

    const row: NativeCliSessionRow = {
      id,
      transcriptTargetId: args.transcriptTargetId,
      agentName: runtimeAgentName,
      provider: agent.provider,
      workingPath,
      launchMode: launch.launchMode,
      runtimeRole,
      agentRuntimeId: runtimeRole === 'managed-project-agent' ? id : null,
      agentRuntimeTokenHash: managed?.tokenHash ?? null,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      state: 'running',
      pid: proc.pid,
      providerSessionRef: args.providerSessionRef ?? null,
      outputSnapshot: '',
      exitCode: null,
      startedAt: now,
      updatedAt: now,
      exitedAt: null
    };
    this.deps.store.upsertNativeCliSession(row);
    const live: LiveNativeCliSession = {
      id,
      transcriptTargetId: args.transcriptTargetId,
      agentName: runtimeAgentName,
      provider: agent.provider,
      runtimeRole,
      proxyApprovals,
      proc,
      adapter,
      launchMode: launch.launchMode,
      terminal: proc.terminal,
      stdin: proc.stdin,
      providerSessionRef: args.providerSessionRef ?? null,
      appServerSocketPath,
      pendingApprovals: new Map(),
      pendingHistoryPages: new Map(),
      pendingRequests: new Map(),
      startup: undefined,
      outputBuffer: new BoundedOutputBuffer(MAX_OUTPUT_SNAPSHOT),
      outputSeq: 0,
      snapshotFlushTimer: null,
      nextRequestId: () => requestSeq++,
      kill: (signal) => killNativeCliProcess(proc.pid, signal)
    };
    this.live.set(id, live);
    this.trackNativeCliProcess(proc.pid);
    const waitForAppServerStartup =
      launch.launchMode === 'app-server'
        ? new Promise<string>((resolve, reject) => {
            live.startup = {
              resolve,
              reject,
              timeout: setTimeout(
                () => reject(new Error(`native CLI app-server thread did not become ready: ${id}`)),
                APP_SERVER_STARTUP_TIMEOUT_MS
              )
            };
          })
        : null;
    const initializeContext = {
      workingPath,
      providerSessionRef: args.providerSessionRef,
      developerInstructions: adapter.managedRuntime?.usesDeveloperInstructions
        ? (managed?.prompt ?? undefined)
        : undefined,
      modelName: args.modelName,
      reasoningEffort: args.reasoningEffort,
      speed: args.speed,
      modelId: args.modelId,
      env: agent.env
    };
    live.initializeContext = initializeContext;
    if (isAppServerSocket) {
      // Protocol travels over a socket (ws: an announced loopback port, or a daemon-assigned one; unix:
      // the path we allocated), exposed as `live.appServer` so initialize/turn/approval frames go over
      // it. The child's stdout/stderr are only logs here — drained so their pipe buffers can't fill and
      // stall the child. stderr drains immediately EXCEPT for the self-announcing ws path below, where
      // reading stderr for the announced port IS the connect step; delaying the drain there is
      // deliberate, not incidental.
      this.appServerConnections.drainStream(proc.stdout);
      const isSelfAnnouncingWs = !isAppServerUnix && launch.appServerWs?.port === undefined;
      if (!isSelfAnnouncingWs) this.appServerConnections.drainStream(proc.stderr);
      const onMessage = (text: string): void =>
        this.outputPipeline.output(args.transcriptTargetId, id, text, 'app-server', adapter);
      const onClose = (): void => this.appServerConnections.handleDisconnect(id);
      try {
        if (isAppServerUnix) {
          const socketPath = appServerSocketPath ?? '';
          live.appServer = await this.appServerConnections.raceAgainstExit(
            connectAppServerUnix({ socketPath, onMessage, onClose, timeoutMs: APP_SERVER_STARTUP_TIMEOUT_MS }),
            proc.exited
          );
          live.appServerRedial = () =>
            connectAppServerUnix({ socketPath, onMessage, onClose, timeoutMs: APP_SERVER_STARTUP_TIMEOUT_MS });
        } else if (launch.appServerWs?.port !== undefined) {
          // Daemon-assigned port (see NativeCliAppServerWsHints.port): dial it directly with retries —
          // there's nothing to parse, the daemon already chose the port before spawning the child.
          const wsPort = launch.appServerWs.port;
          const dialOpts = {
            onMessage,
            onClose,
            timeoutMs: APP_SERVER_STARTUP_TIMEOUT_MS,
            path: launch.appServerWs.path,
            query: launch.appServerWs.query
          };
          live.appServer = await this.appServerConnections.raceAgainstExit(
            dialAppServerWsWithRetry(wsPort, dialOpts),
            proc.exited
          );
          live.appServerRedial = () => dialAppServerWsWithRetry(wsPort, dialOpts);
        } else {
          live.appServer = await this.appServerConnections.raceAgainstExit(
            connectAppServerWs({
              stderr: proc.stderr,
              onMessage,
              onClose,
              timeoutMs: APP_SERVER_STARTUP_TIMEOUT_MS,
              path: launch.appServerWs?.path,
              query: launch.appServerWs?.query,
              onPort: (port) => {
                live.appServerRedial = () =>
                  dialAppServerWs(port, { onMessage, onClose, timeoutMs: APP_SERVER_STARTUP_TIMEOUT_MS });
              }
            }),
            proc.exited
          );
          this.appServerConnections.drainStream(proc.stderr);
        }
        // The socket dir is already 0700; lock the socket itself to owner-only as defense in depth.
        if (appServerSocketPath) {
          try {
            chmodSync(appServerSocketPath, 0o600);
          } catch {
            /* socket already gone / not chmod-able */
          }
        }
        adapter.initialize?.(live, initializeContext);
      } catch (error) {
        live.startup?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    } else if (launch.launchMode !== 'pty') {
      this.outputPipeline.readPipe(args.transcriptTargetId, id, proc.stdout, 'stdout', adapter);
      this.outputPipeline.readPipe(args.transcriptTargetId, id, proc.stderr, 'stderr', adapter);
      // stdio app-server: frames travel over the child's stdin pipe, wrapped as the same
      // transport-neutral connection the ws leg produces. json-stream adapters keep writing to
      // `live.stdin` directly and never touch `appServer`.
      if (launch.launchMode === 'app-server') live.appServer = connectAppServerStdio(proc.stdin);
      adapter.initialize?.(live, initializeContext);
    }
    if (waitForAppServerStartup) {
      try {
        await waitForAppServerStartup;
      } catch (error) {
        if (live.startup) clearTimeout(live.startup.timeout);
        live.startup = undefined;
        if (runtimeRole === 'managed-project-agent' && managed) cleanupManagedProjectRuntimeToken(managed.workspace);
        this.live.delete(id);
        this.untrackNativeCliProcess(proc.pid);
        this.outputPipeline.dropStructuredBuffer(id);
        this.appServerConnections.unlinkSocket(appServerSocketPath);
        killNativeCliProcess(proc.pid);
        const failedAt = new Date().toISOString();
        this.deps.store.upsertNativeCliSession({
          ...row,
          state: 'failed',
          pid: null,
          outputSnapshot: error instanceof Error ? error.message : String(error),
          exitCode: null,
          updatedAt: failedAt,
          exitedAt: failedAt
        });
        throw error;
      }
    }
    this.events.emit(args.transcriptTargetId, 'native_cli.started', {
      nativeCliSessionId: id,
      agentName: runtimeAgentName,
      provider: agent.provider,
      productIcon: adapter.productIcon,
      launchMode: launch.launchMode,
      workingPath,
      pid: proc.pid
    });
    this.log.debug(
      {
        sessionId: args.transcriptTargetId,
        event: 'native_cli.started',
        nativeCliSessionId: id,
        agentName: runtimeAgentName,
        provider: agent.provider,
        launchMode: launch.launchMode,
        workingPath,
        pid: proc.pid
      },
      'native cli started'
    );

    void proc.exited.then((code) => {
      if (!this.live.has(id)) return;
      const live = this.live.get(id);
      if (live?.startup) {
        clearTimeout(live.startup.timeout);
        live.startup.reject(new Error(`native CLI session exited before app-server thread was ready: ${id}`));
        live.startup = undefined;
      }
      for (const pending of live?.pendingHistoryPages.values() ?? []) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`native CLI session exited before history page response: ${id}`));
      }
      let remainingText = decoder.flush();
      if (pendingCR) remainingText = `\r${remainingText}`;
      pendingCR = remainingText.endsWith('\r');
      if (pendingCR) remainingText = remainingText.slice(0, -1);
      remainingText = remainingText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (remainingText) this.outputPipeline.output(args.transcriptTargetId, id, remainingText, 'pty', adapter);
      if (pendingCR) this.outputPipeline.output(args.transcriptTargetId, id, '\n', 'pty', adapter);
      this.outputPipeline.flushSnapshot(id);
      this.live.delete(id);
      if (runtimeRole === 'managed-project-agent' && managed) cleanupManagedProjectRuntimeToken(managed.workspace);
      this.untrackNativeCliProcess(proc.pid);
      this.outputPipeline.dropStructuredBuffer(id);
      this.appServerConnections.unlinkSocket(appServerSocketPath);
      const exitedAt = new Date().toISOString();
      const state = code === 0 ? 'exited' : 'failed';
      this.deps.store.closeNativeCliSession(id, exitedAt, code, state);
      this.events.emit(args.transcriptTargetId, 'native_cli.exited', { nativeCliSessionId: id, exitCode: code, state });
      this.observation.publish(id, true);
      this.log[state === 'failed' ? 'error' : 'debug'](
        {
          sessionId: args.transcriptTargetId,
          event: 'native_cli.exited',
          nativeCliSessionId: id,
          exitCode: code,
          state
        },
        'native cli exited'
      );
    });

    return toView(row);
  }

  input(id: string, req: NativeCliInputRequest): void {
    const live = this.live.get(id);
    if (!live) throw new Error(`native CLI session is not running: ${id}`);
    this.log.debug(
      { sessionId: live.transcriptTargetId, event: 'native_cli.input', nativeCliSessionId: id, input: req.input },
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
    // Between a socket drop and a completed redial, `live.appServer` still references the dead
    // connection (`reconnectAppServer` only reassigns it on success) — it stays truthy, so an adapter's
    // own `!handle.appServer` guard doesn't catch this window. Sending into it would silently vanish
    // (a closed socket's `send` typically no-ops rather than throwing), so fail loudly here instead.
    if (live.appServerReconnecting) {
      throw new NativeCliError('provider_timeout', `native CLI app-server is reconnecting, cannot send input: ${id}`);
    }
    live.adapter.sendInput(live, req.input);
  }

  /** Cancel the in-flight turn while keeping the session/thread alive. If the provider adapter offers
   *  no graceful interrupt, fall back to stopping the session so the request is never a no-op. */
  interrupt(id: string): void {
    const live = this.live.get(id);
    if (!live) throw new Error(`native CLI session is not running: ${id}`);
    this.log.debug(
      { sessionId: live.transcriptTargetId, event: 'native_cli.interrupt', nativeCliSessionId: id },
      'native cli interrupt'
    );
    if (live.adapter.interrupt) live.adapter.interrupt(live);
    else this.stop(id);
  }

  steer(id: string, req: NativeCliInputRequest): void {
    const live = this.live.get(id);
    if (!live) throw new Error(`native CLI session is not running: ${id}`);
    if (!live.adapter.steer)
      throw new NativeCliError('unsupported_capability', `native CLI provider does not support steering: ${id}`);
    this.log.debug(
      { sessionId: live.transcriptTargetId, event: 'native_cli.steer', nativeCliSessionId: id },
      'native cli steer'
    );
    live.adapter.steer(live, req.input);
  }

  get(id: string): NativeCliSessionView {
    const row = this.deps.store.getNativeCliSession(id);
    if (!row) throw new Error(`native CLI session not found: ${id}`);
    const live = this.live.get(id);
    return toView(row, live?.pendingApprovals.size ?? 0, live);
  }

  list(transcriptTargetId: TranscriptTargetId): ListNativeCliSessionsResponse {
    return {
      sessions: this.deps.store.listNativeCliSessionsForTranscriptTarget(transcriptTargetId).map((row) => {
        const live = this.live.get(row.id);
        return toView(row, live?.pendingApprovals.size ?? 0, live);
      })
    };
  }

  /** Every native CLI runtime across the daemon without output buffers. Used by overview surfaces
   *  that need durable counters such as unread messages even after a runtime exits. */
  listAllSummaries(): ListNativeCliSessionsResponse {
    return {
      sessions: this.deps.store.listNativeCliSessions().map((row) => {
        const live = this.live.get(row.id);
        return { ...toView(row, live?.pendingApprovals.size ?? 0, live), outputSnapshot: '' };
      })
    };
  }

  /** Every live (starting/running) runtime across the daemon, all projects — for the daemon-wide
   *  runtime overview, so the web polls once instead of once per project. Output snapshots are
   *  dropped: this is a status list (state/provider/name), and shipping every live session's
   *  (up to 256 KB) buffer on each poll is bandwidth no overview consumer reads. */
  listLive(): ListNativeCliSessionsResponse {
    return {
      sessions: this.deps.store.listLiveNativeCliSessions().map((row) => {
        const live = this.live.get(row.id);
        return { ...toView(row, live?.pendingApprovals.size ?? 0, live), outputSnapshot: '' };
      })
    };
  }

  observe(id: string, afterSeq?: number): NativeCliObservationAccessResponse {
    return this.observeFromStore(id, afterSeq);
  }

  async observeWithProviderHistory(id: string): Promise<NativeCliObservationAccessResponse> {
    const base = this.observeFromStore(id);
    if (base.state !== 'unavailable') return base;
    const row = this.deps.store.getNativeCliSession(id);
    if (!row || !isManagedProjectRuntime(row) || !row.providerSessionRef) return base;
    const adapter = getNativeCliProviderAdapter(row.provider);
    const cliOutput = await providerHistoryOutputViaCli(row, adapter, {
      agents: this.deps.agents,
      buildSpawnEnv: (env) => this.buildSpawnEnv(env),
      takeStructuredLines: (structuredId, stream, chunk) =>
        this.outputPipeline.takeCompleteStructuredLines(structuredId, stream, chunk),
      dropStructuredBuffer: (structuredId) => this.outputPipeline.dropStructuredBuffer(structuredId)
    }).catch(() => null);
    if (cliOutput) {
      return {
        state: 'history',
        nativeCliSessionId: id,
        provider: row.provider,
        output: cliOutput,
        observedAt: row.updatedAt
      };
    }
    const localOutput = await providerHistoryOutputFromLocal(row, adapter);
    if (localOutput) {
      return {
        state: 'history',
        nativeCliSessionId: id,
        provider: row.provider,
        output: localOutput,
        observedAt: row.updatedAt
      };
    }
    return base;
  }

  private observeFromStore(id: string, afterSeq?: number): NativeCliObservationAccessResponse {
    const live = this.live.get(id);
    if (live) {
      const snapshot = live.outputBuffer.snapshot();
      // Resume: if the caller's cursor is still within the bounded tail, hand back only the delta
      // beyond it instead of the whole snapshot (a reconnecting client backfills from last-event-id).
      if (afterSeq !== undefined && live.outputSeq > afterSeq && live.outputSeq - afterSeq <= snapshot.length) {
        return {
          state: 'live',
          nativeCliSessionId: id,
          provider: live.provider,
          append: snapshot.slice(snapshot.length - (live.outputSeq - afterSeq)),
          seq: live.outputSeq,
          observedAt: new Date().toISOString()
        };
      }
      return {
        state: 'live',
        nativeCliSessionId: id,
        provider: live.provider,
        output: snapshot,
        seq: live.outputSeq,
        observedAt: new Date().toISOString()
      };
    }
    const row = this.deps.store.getNativeCliSession(id);
    if (!row) {
      return {
        state: 'unavailable',
        nativeCliSessionId: id,
        reason: 'native CLI session not found'
      };
    }
    if (!isManagedProjectRuntime(row) && row.outputSnapshot) {
      return {
        state: 'history',
        nativeCliSessionId: id,
        provider: row.provider,
        output: row.outputSnapshot,
        observedAt: row.updatedAt
      };
    }
    return {
      state: 'unavailable',
      nativeCliSessionId: id,
      provider: row.provider,
      reason: 'provider history unavailable'
    };
  }

  subscribeObservation(
    id: string,
    listener: NativeCliObservationListener,
    afterSeq?: number
  ): { access: NativeCliObservationAccessResponse; live: boolean; dispose: () => void } {
    return this.observation.subscribe(id, listener, afterSeq);
  }

  resize(id: string, req: NativeCliResizeRequest): void {
    const live = this.live.get(id);
    if (!live) throw new Error(`native CLI session is not running: ${id}`);
    this.log.debug(
      {
        sessionId: live.transcriptTargetId,
        event: 'native_cli.resize',
        nativeCliSessionId: id,
        cols: req.cols,
        rows: req.rows
      },
      'native cli resize'
    );
    live.adapter.resize(live, req.cols, req.rows);
  }

  resolveApproval(id: string, req: NativeCliApprovalResolutionRequest): void {
    const live = this.live.get(id);
    if (!live) throw new Error(`native CLI session is not running: ${id}`);
    const request = live.pendingApprovals.get(req.requestId);
    live.adapter.resolveApproval(live, { ...req, request });
    live.pendingApprovals.delete(req.requestId);
    this.events.emit(live.transcriptTargetId, 'native_cli.approval_resolved', {
      nativeCliSessionId: id,
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
      { sessionId: live.transcriptTargetId, event: 'native_cli.stop', nativeCliSessionId: id },
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
    for (const pending of live.pendingHistoryPages.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`native CLI session stopped before history page response: ${id}`));
    }
    live.pendingHistoryPages.clear();
    if (live.startup) {
      clearTimeout(live.startup.timeout);
      live.startup.reject(new Error(`native CLI session stopped before app-server thread was ready: ${id}`));
      live.startup = undefined;
    }
    live.adapter.stop(live);
    // cli-oneshot has no persistent proc; kill any in-flight per-turn process instead.
    if (live.oneshotTurnProc) {
      killNativeCliProcess(live.oneshotTurnProc.pid);
      this.untrackNativeCliProcess(live.oneshotTurnProc.pid);
      live.oneshotTurnProc = undefined;
    }
    this.outputPipeline.flushSnapshot(id);
    this.live.delete(id);
    const row = this.deps.store.getNativeCliSession(id);
    if (row?.runtimeRole === 'managed-project-agent')
      cleanupManagedProjectRuntimeToken(this.managedRuntimeWorkspace(row));
    if (live.proc) this.untrackNativeCliProcess(live.proc.pid);
    this.outputPipeline.dropStructuredBuffer(id);
    this.appServerConnections.unlinkSocket(live.appServerSocketPath);
    const exitedAt = new Date().toISOString();
    this.deps.store.closeNativeCliSession(id, exitedAt, null, 'stopped');
    this.events.emit(live.transcriptTargetId, 'native_cli.exited', {
      nativeCliSessionId: id,
      exitCode: null,
      state: 'stopped'
    });
  }

  stopTranscriptTarget(transcriptTargetId: TranscriptTargetId): void {
    for (const live of [...this.live.values()]) {
      if (live.transcriptTargetId === transcriptTargetId) this.stop(live.id);
    }
  }

  historyPage(id: string, req: NativeCliHistoryPageRequest): Promise<NativeCliHistoryPageResponse> {
    const live = this.live.get(id);
    if (!live) throw new Error(`native CLI session is not running: ${id}`);
    if (!live.adapter.requestHistoryPage) {
      throw new NativeCliError('unsupported_capability', `native CLI provider does not support paged history: ${id}`);
    }
    const requestId = live.nextRequestId();
    const responseId = String(requestId);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        live.pendingHistoryPages.delete(responseId);
        reject(new NativeCliError('provider_timeout', `timed out waiting for native CLI history page: ${id}`));
      }, HISTORY_PAGE_TIMEOUT_MS);
      live.pendingHistoryPages.set(responseId, {
        timeout,
        resolve: (page) => resolve({ page }),
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

  startAuth(agentName: string): Promise<NativeCliAuthSessionView> {
    return this.authHost.startAuth(agentName);
  }

  getAuth(id: string, controlToken: string): NativeCliAuthSessionView {
    return this.authHost.getAuth(id, controlToken);
  }

  subscribeAuth(
    id: string,
    controlToken: string,
    listener: NativeCliAuthListener
  ): { session: NativeCliAuthSessionView; dispose: () => void } {
    return this.authHost.subscribeAuth(id, controlToken, listener);
  }

  inputAuth(id: string, controlToken: string, req: NativeCliInputRequest): void {
    this.authHost.inputAuth(id, controlToken, req);
  }

  resizeAuth(id: string, controlToken: string, req: NativeCliResizeRequest): void {
    this.authHost.resizeAuth(id, controlToken, req);
  }

  heartbeatAuth(id: string, controlToken: string): void {
    this.authHost.heartbeatAuth(id, controlToken);
  }

  stopAuth(id: string, controlToken: string): void {
    this.authHost.stopAuth(id, controlToken);
  }

  authStatus(agentName: string): Promise<NativeCliAuthStatusResponse> {
    return this.authHost.authStatus(agentName);
  }

  usage(agentName: string): Promise<NativeCliUsageResponse> {
    return this.authHost.usage(agentName);
  }

  preflight(agentName: string): Promise<NativeCliStartPreflight> {
    return this.authHost.preflight(agentName);
  }
}
