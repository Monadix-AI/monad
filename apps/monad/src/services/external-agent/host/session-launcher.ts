import type { Logger } from '@monad/logger';
import type {
  ExternalAgentAppServerTransport,
  ExternalAgentLaunchMode,
  ExternalAgentSessionView,
  ExternalAgentView,
  ProjectId
} from '@monad/protocol';
import type { ExternalAgentHostDeps, LiveExternalAgentSession } from '#/services/external-agent/host/host-types.ts';
import type { LiveRawStore } from '#/services/external-agent/live-raw-store.ts';
import type { ExternalAgentProcess, ExternalAgentTerminal } from '#/services/external-agent/runtime-types.ts';
import type { ExternalAgentLaunchSpec } from '#/services/external-agent/types.ts';
import type { ExternalAgentTargetId } from '#/store/db/external-agent-sessions.ts';
import type { ExternalAgentSessionRow } from '#/store/db/index.ts';

import { chmodSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { resolveDaemonUrl } from '@monad/environment';
import { newId } from '@monad/protocol';

import { daemonTrackedSpawnOptions, redactedSpawnArgv, supervisedSpawn } from '#/infra/spawn-supervisor.ts';
import { connectAppServerStdio } from '#/services/external-agent/app-server-stdio.ts';
import { connectAppServerUnix } from '#/services/external-agent/app-server-unix.ts';
import {
  connectAppServerWs,
  dialAppServerWs,
  dialAppServerWsWithRetry
} from '#/services/external-agent/app-server-ws.ts';
import { ExternalAgentAppServerConnectionManager } from '#/services/external-agent/host/app-server-connection.ts';
import { ExternalAgentOneshotRunner } from '#/services/external-agent/host/cli-oneshot.ts';
import { ExternalAgentEventLog } from '#/services/external-agent/host/event-log.ts';
import { APP_SERVER_STARTUP_TIMEOUT_MS } from '#/services/external-agent/host/host-constants.ts';
import { toView } from '#/services/external-agent/host/host-helpers.ts';
import { ExternalAgentObservationHub } from '#/services/external-agent/host/observation-hub.ts';
import { ExternalAgentOutputPipeline } from '#/services/external-agent/host/output-pipeline.ts';
import {
  buildExternalAgentLaunch,
  getExternalAgentProviderAdapter,
  resolveExternalAgentLaunchCommand
} from '#/services/external-agent/index.ts';
import {
  cleanupManagedProjectRuntimeToken,
  prepareManagedProjectRuntime
} from '#/services/external-agent/managed-project.ts';
import { killExternalAgentProcess, pickPtyFallbackLaunchMode } from '#/services/external-agent/process.ts';
import { createStreamingTextDecoder } from '#/services/external-agent/stream-decoder.ts';

export function resolveExternalAgentManagedServerUrl(opts: {
  serverUrl?: string;
  networkHttps?: { enabled: boolean };
  port?: number | string;
}): string {
  return resolveDaemonUrl({
    network: {
      https: opts.networkHttps,
      ...(opts.port ? { port: Number(opts.port) } : {})
    },
    env: {
      ...Bun.env,
      ...(opts.port === undefined ? {} : { MONAD_PORT: String(opts.port) }),
      ...(opts.serverUrl ? { MONAD_URL: opts.serverUrl } : {})
    }
  });
}

export interface ExternalAgentSessionLauncherContext {
  deps: ExternalAgentHostDeps;
  live: Map<string, LiveExternalAgentSession>;
  log: Logger;
  events: ExternalAgentEventLog;
  observation: ExternalAgentObservationHub;
  appServerConnections: ExternalAgentAppServerConnectionManager;
  outputPipeline: ExternalAgentOutputPipeline;
  oneshotRunner: ExternalAgentOneshotRunner;
  requireAgent(name: string): Promise<ExternalAgentView>;
  buildSpawnEnv(launchEnv?: Record<string, string>): Promise<Record<string, string>>;
  trackProcess(pid: number): Promise<void>;
  untrackProcess(pid: number): void;
  armIdleSuspend(live: LiveExternalAgentSession): void;
  idleTimeoutMs(): number;
  updateExternalAgentPid(id: string, pid: number | null): void;
  openLiveRawStore(id: string, epoch: string): LiveRawStore;
}

/** Builds a fresh external agent session: resolves the agent + launch spec, spawns the child process (or
 *  hands off to the cli-oneshot runner), wires up its output/app-server streams, and registers the
 *  live/exit/idle-resume bookkeeping shared with the rest of ExternalAgentHost. */
export class ExternalAgentSessionLauncher {
  constructor(private readonly ctx: ExternalAgentSessionLauncherContext) {}

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
    const runtimeAgentName = args.agentName;
    let agent = await this.ctx.requireAgent(args.templateAgentName ?? args.agentName);
    if (!isAbsolute(args.workingPath)) throw new Error('workingPath must be absolute');
    let workingPath: string;
    try {
      workingPath = realpathSync(args.workingPath);
    } catch {
      throw new Error(`workingPath must be an existing directory: ${args.workingPath}`);
    }
    if (!statSync(workingPath).isDirectory())
      throw new Error(`workingPath must be an existing directory: ${args.workingPath}`);
    const adapter = getExternalAgentProviderAdapter(agent.provider);
    const id = newId('exa');
    const now = new Date().toISOString();
    let requestSeq = 0;
    const runtimeRole = args.runtimeRole ?? 'interactive';
    const willBeManaged = runtimeRole === 'managed-project-agent';

    // A managed agent runs autopilot unless the operator turned it OFF *and* the adapter can actually
    // project + resolve approvals in this launch mode. When it can't, the skip flag stays on —
    // dropping it would leave the CLI blocked on an approval it has no channel to resolve. The member
    // setting overrides the agent template's `allowAutopilot`. Computed before `prepareManagedProjectRuntime`
    // so `skipProviderApprovals` can reach `managedRuntime.env` for a provider whose autopilot toggle has
    // no CLI-flag equivalent and must instead write its own config into the managed workspace.
    const effectiveLaunchMode = args.launchMode ?? agent.defaultLaunchMode;
    const allowAutopilot = args.allowAutopilot ?? agent.allowAutopilot;
    const proxyApprovals =
      willBeManaged && allowAutopilot === false && (adapter.supportsApprovalResolution?.(effectiveLaunchMode) ?? false);
    const skipProviderApprovals = willBeManaged && !proxyApprovals;
    // Reflect the resolved (member-override-aware) value back onto `agent` before it reaches
    // `buildExternalAgentLaunch` — that call's `assertSafeArgs` gates dangerous static argv on
    // `agent.allowAutopilot` too, and it must see the same resolved value this session actually runs
    // with, not the template's raw default.
    if (allowAutopilot !== agent.allowAutopilot) agent = { ...agent, allowAutopilot };

    const managed = willBeManaged
      ? prepareManagedProjectRuntime({
          monadHome: this.ctx.deps.monadHome ?? dirname(this.ctx.deps.externalAgentProcessRegistryPath ?? workingPath),
          serverUrl: resolveExternalAgentManagedServerUrl({
            serverUrl: this.ctx.deps.serverUrl,
            networkHttps: this.ctx.deps.networkHttps
          }),
          agentName: runtimeAgentName,
          displayName: args.displayName,
          projectId: args.transcriptTargetId as ProjectId,
          externalAgentSessionId: id,
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
    let launch: ExternalAgentLaunchSpec;
    let proc: ExternalAgentProcess;
    // A `unix` app-server transport needs the daemon to pick the socket path the child listens on
    // (browser-unreachable channel). Allocate it before the launch so it lands in both the argv and
    // the dial target.
    const wantsUnixAppServer =
      effectiveLaunchMode === 'app-server' && (args.appServerTransport ?? agent.appServerTransport) === 'unix';
    const appServerSocketPath = wantsUnixAppServer ? this.ctx.appServerConnections.allocateSocketPath(id) : undefined;
    // A `ws` app-server MAY prefer a daemon-assigned port over self-announcing one (see
    // `ExternalAgentAppServerWsHints.port`) — allocate a candidate up front so `buildLaunch` can put it in
    // argv if it wants to. Gated on the adapter's own opt-in (not just transport === 'ws'), since a
    // self-announcing ws provider (e.g. codex) never reads the allocated port and the bind+release
    // syscall would otherwise run on every one of its app-server launches for nothing.
    const wantsWsAppServer =
      effectiveLaunchMode === 'app-server' &&
      (args.appServerTransport ?? agent.appServerTransport ?? 'ws') === 'ws' &&
      !!adapter.usesDaemonAssignedAppServerPort;
    const appServerPort = wantsWsAppServer ? await this.ctx.appServerConnections.allocatePort() : undefined;
    // Reusable so a pty-spawn failure (e.g. Bun's ConPTY support unavailable on the host) can rebuild
    // the launch spec for a fallback launchMode without duplicating every option.
    const buildLaunchOpts = (overrides?: {
      launchMode?: ExternalAgentLaunchMode;
      appServerTransport?: ExternalAgentAppServerTransport;
      providerSessionRef?: string;
    }) => ({
      workingPath,
      extraWorkingPaths: managed ? [managed.workspace] : undefined,
      launchMode: overrides?.launchMode ?? args.launchMode,
      appServerTransport: overrides?.appServerTransport ?? args.appServerTransport,
      appServerSocketPath,
      appServerPort,
      systemPromptFile: adapter.managedRuntime?.usesSystemPromptFile ? (managed?.promptFile ?? undefined) : undefined,
      skipProviderApprovals,
      providerSessionRef: overrides?.providerSessionRef ?? args.providerSessionRef,
      modelName: args.modelName,
      reasoningEffort: args.reasoningEffort,
      speed: args.speed,
      modelId: args.modelId,
      mcpConfigArgs: managed?.mcpConfigArgs
    });
    try {
      launch = resolveExternalAgentLaunchCommand(adapter, buildExternalAgentLaunch(agent, buildLaunchOpts()));
    } catch (error) {
      if (managed) cleanupManagedProjectRuntimeToken(managed.workspace);
      const failedAt = new Date().toISOString();
      this.ctx.deps.store.upsertExternalAgentSession({
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
      this.ctx.events.emit(args.transcriptTargetId, 'external_agent.exited', {
        externalAgentSessionId: id,
        exitCode: null,
        state: 'failed'
      });
      this.ctx.log.error(
        {
          sessionId: args.transcriptTargetId,
          event: 'external_agent.launch_failed',
          externalAgentSessionId: id,
          agentName: runtimeAgentName,
          provider: agent.provider,
          err: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
        },
        'native cli launch failed'
      );
      throw error;
    }
    this.ctx.log.debug(
      {
        sessionId: args.transcriptTargetId,
        event: 'external_agent.launch',
        externalAgentSessionId: id,
        agentName: runtimeAgentName,
        provider: agent.provider,
        argv: redactedSpawnArgv(launch.argv),
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
      return this.ctx.oneshotRunner.start({
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
    let spawnEnv = await this.ctx.buildSpawnEnv(launch.env);
    const observationEpoch = newId('oep');
    const liveRawStore = this.ctx.openLiveRawStore(id, observationEpoch);
    // ws/unix app-server: codex listens on a socket and speaks the protocol over it, so the daemon
    // ignores stdin and treats stdout/stderr as logs (for ws, stderr also carries the listen port).
    let isAppServerWs = launch.launchMode === 'app-server' && launch.appServerTransport === 'ws';
    let isAppServerUnix = launch.launchMode === 'app-server' && launch.appServerTransport === 'unix';
    let isAppServerSocket = isAppServerWs || isAppServerUnix;
    const spawnLogContext = () => ({
      sessionId: args.transcriptTargetId,
      externalAgentSessionId: id,
      agentName: runtimeAgentName,
      provider: agent.provider,
      launchMode: launch.launchMode,
      appServerTransport: launch.appServerTransport ?? null
    });
    const spawnPipeMode = (): ExternalAgentProcess =>
      supervisedSpawn(
        launch.argv,
        {
          cwd: launch.cwd,
          env: spawnEnv,
          detached: true,
          stdin: isAppServerSocket ? 'ignore' : 'pipe',
          stdout: 'pipe',
          stderr: 'pipe'
        },
        {
          ...daemonTrackedSpawnOptions({
            event: 'external_agent.spawn',
            log: this.ctx.log,
            context: spawnLogContext(),
            kill: (child, signal) => killExternalAgentProcess(child.pid, signal),
            trackLabel: 'external-agent',
            tracker: {
              track: (pid) => this.ctx.trackProcess(pid),
              untrack: (pid) => this.ctx.untrackProcess(pid)
            }
          })
        }
      ) as ExternalAgentProcess;
    try {
      if (launch.launchMode === 'pty') {
        try {
          proc = supervisedSpawn(
            launch.argv,
            {
              cwd: launch.cwd,
              env: spawnEnv,
              detached: true,
              stdout: 'ignore',
              stderr: 'ignore',
              stdin: 'ignore',
              terminal: {
                cols: 100,
                rows: 30,
                data: (_terminal: ExternalAgentTerminal, data: Uint8Array) => {
                  let text = decoder.decode(data);
                  if (pendingCR) text = `\r${text}`;
                  pendingCR = text.endsWith('\r');
                  if (pendingCR) text = text.slice(0, -1);
                  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                  if (text) this.ctx.outputPipeline.output(args.transcriptTargetId, id, text, 'pty', adapter);
                }
              }
            } as Bun.SpawnOptions.OptionsObject<'ignore', 'ignore', 'ignore'>,
            {
              ...daemonTrackedSpawnOptions({
                event: 'external_agent.spawn',
                log: this.ctx.log,
                context: spawnLogContext(),
                kill: (child, signal) => killExternalAgentProcess(child.pid, signal),
                trackLabel: 'external-agent',
                tracker: {
                  track: (pid) => this.ctx.trackProcess(pid),
                  untrack: (pid) => this.ctx.untrackProcess(pid)
                }
              })
            }
          ) as ExternalAgentProcess;
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
          this.ctx.log.warn(
            {
              sessionId: args.transcriptTargetId,
              externalAgentSessionId: id,
              provider: agent.provider,
              fallbackMode,
              err: ptyError instanceof Error ? ptyError.message : String(ptyError)
            },
            'native cli pty spawn failed — falling back to non-pty launch mode'
          );
          launch = resolveExternalAgentLaunchCommand(
            adapter,
            buildExternalAgentLaunch(
              agent,
              buildLaunchOpts({
                launchMode: fallbackMode,
                appServerTransport: fallbackMode === 'app-server' ? 'stdio' : undefined
              })
            )
          );
          launch = managed ? { ...launch, env: { ...(launch.env ?? {}), ...managed.env } } : launch;
          spawnEnv = await this.ctx.buildSpawnEnv(launch.env);
          isAppServerWs = launch.launchMode === 'app-server' && launch.appServerTransport === 'ws';
          isAppServerUnix = launch.launchMode === 'app-server' && launch.appServerTransport === 'unix';
          isAppServerSocket = isAppServerWs || isAppServerUnix;
          proc = spawnPipeMode();
        }
      } else {
        proc = spawnPipeMode();
      }
    } catch (error) {
      void liveRawStore.closeAndDelete();
      if (managed) cleanupManagedProjectRuntimeToken(managed.workspace);
      const failedAt = new Date().toISOString();
      this.ctx.deps.store.upsertExternalAgentSession({
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
      this.ctx.events.emit(args.transcriptTargetId, 'external_agent.exited', {
        externalAgentSessionId: id,
        exitCode: null,
        state: 'failed'
      });
      this.ctx.log.error(
        {
          sessionId: args.transcriptTargetId,
          event: 'external_agent.launch_failed',
          externalAgentSessionId: id,
          agentName: runtimeAgentName,
          provider: agent.provider,
          err: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
        },
        'native cli launch failed'
      );
      throw error;
    }

    const row: ExternalAgentSessionRow = {
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
    this.ctx.deps.store.upsertExternalAgentSession(row);
    const live: LiveExternalAgentSession = {
      id,
      transcriptTargetId: args.transcriptTargetId,
      agentName: runtimeAgentName,
      displayName: args.displayName,
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
      liveRawStore,
      observationEpoch,
      observationEpochReady: false,
      outputSeq: 0,
      nextRequestId: () => requestSeq++,
      kill: (signal) => {
        if (!live.proc) return;
        if (live.proc.supervision) live.proc.supervision.stop('manual', signal ?? 'SIGTERM');
        else killExternalAgentProcess(live.proc.pid, signal);
      }
    };
    this.ctx.live.set(id, live);
    // Awaited so the durable process registry is on disk before the caller reports the session as
    // started (crash-safety: a daemon restart right after this point can still find and reap it).
    await proc.supervision?.tracked;
    const waitForAppServerThread = () =>
      launch.launchMode === 'app-server'
        ? new Promise<string>((resolve, reject) => {
            live.startup = {
              resolve,
              reject,
              timeout: setTimeout(
                () => reject(new Error(`external agent app-server thread did not become ready: ${id}`)),
                APP_SERVER_STARTUP_TIMEOUT_MS
              )
            };
          })
        : null;
    const waitForAppServerStartup = waitForAppServerThread();
    const makeInitializeContext = () => {
      const providerSessionRef = live.providerSessionRef ?? args.providerSessionRef;
      return {
        workingPath,
        ...(providerSessionRef ? { providerSessionRef } : {}),
        developerInstructions: adapter.managedRuntime?.usesDeveloperInstructions
          ? (managed?.prompt ?? undefined)
          : undefined,
        modelName: args.modelName,
        reasoningEffort: args.reasoningEffort,
        speed: args.speed,
        modelId: args.modelId,
        env: agent.env
      };
    };
    live.initializeContext = makeInitializeContext();
    const attachRuntimeStreams = async (runtimeProc: ExternalAgentProcess): Promise<void> => {
      live.proc = runtimeProc;
      live.terminal = runtimeProc.terminal;
      live.stdin = runtimeProc.stdin;
      live.appServer = undefined;
      live.appServerRedial = undefined;
      live.appServerReconnecting = false;
      if (isAppServerSocket) {
        // Protocol travels over a socket (ws: an announced loopback port, or a daemon-assigned one; unix:
        // the path we allocated), exposed as `live.appServer` so initialize/turn/approval frames go over
        // it. The child's stdout/stderr are only logs here — drained so their pipe buffers can't fill and
        // stall the child. stderr drains immediately EXCEPT for the self-announcing ws path below, where
        // reading stderr for the announced port IS the connect step; delaying the drain there is
        // deliberate, not incidental.
        this.ctx.appServerConnections.drainStream(runtimeProc.stdout);
        const isSelfAnnouncingWs = !isAppServerUnix && launch.appServerWs?.port === undefined;
        if (!isSelfAnnouncingWs) this.ctx.appServerConnections.drainStream(runtimeProc.stderr);
        const onMessage = (text: string): void =>
          this.ctx.outputPipeline.output(args.transcriptTargetId, id, text, 'app-server', adapter);
        const onClose = (): void => this.ctx.appServerConnections.handleDisconnect(id);
        if (isAppServerUnix) {
          const socketPath = appServerSocketPath ?? '';
          live.appServer = await this.ctx.appServerConnections.raceAgainstExit(
            connectAppServerUnix({ socketPath, onMessage, onClose, timeoutMs: APP_SERVER_STARTUP_TIMEOUT_MS }),
            runtimeProc.exited
          );
          live.appServerRedial = () =>
            connectAppServerUnix({ socketPath, onMessage, onClose, timeoutMs: APP_SERVER_STARTUP_TIMEOUT_MS });
        } else if (launch.appServerWs?.port !== undefined) {
          // Daemon-assigned port (see ExternalAgentAppServerWsHints.port): dial it directly with retries —
          // there's nothing to parse, the daemon already chose the port before spawning the child.
          const wsPort = launch.appServerWs.port;
          const dialOpts = {
            onMessage,
            onClose,
            timeoutMs: APP_SERVER_STARTUP_TIMEOUT_MS,
            path: launch.appServerWs.path,
            query: launch.appServerWs.query
          };
          live.appServer = await this.ctx.appServerConnections.raceAgainstExit(
            dialAppServerWsWithRetry(wsPort, dialOpts),
            runtimeProc.exited
          );
          live.appServerRedial = () => dialAppServerWsWithRetry(wsPort, dialOpts);
        } else {
          live.appServer = await this.ctx.appServerConnections.raceAgainstExit(
            connectAppServerWs({
              stderr: runtimeProc.stderr,
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
            runtimeProc.exited
          );
          this.ctx.appServerConnections.drainStream(runtimeProc.stderr);
        }
        // The socket dir is already 0700; lock the socket itself to owner-only as defense in depth.
        if (appServerSocketPath) {
          try {
            chmodSync(appServerSocketPath, 0o600);
          } catch {
            /* socket already gone / not chmod-able */
          }
        }
        const initializeContext = makeInitializeContext();
        live.initializeContext = initializeContext;
        adapter.initialize?.(live, initializeContext);
      } else if (launch.launchMode !== 'pty') {
        this.ctx.outputPipeline.readPipe(args.transcriptTargetId, id, runtimeProc.stdout, 'stdout', adapter);
        this.ctx.outputPipeline.readPipe(args.transcriptTargetId, id, runtimeProc.stderr, 'stderr', adapter);
        // stdio app-server: frames travel over the child's stdin pipe, wrapped as the same
        // transport-neutral connection the ws leg produces. json-stream adapters keep writing to
        // `live.stdin` directly and never touch `appServer`.
        if (launch.launchMode === 'app-server') live.appServer = connectAppServerStdio(runtimeProc.stdin);
        const initializeContext = makeInitializeContext();
        live.initializeContext = initializeContext;
        adapter.initialize?.(live, initializeContext);
      }
    };
    const attachExitHandler = (runtimeProc: ExternalAgentProcess): void => {
      void runtimeProc.exited.then((code) => {
        const live = this.ctx.live.get(id);
        if (!live || live.proc !== runtimeProc || live.suspended) return;
        if (live.idleTimer) {
          clearTimeout(live.idleTimer);
          live.idleTimer = undefined;
        }
        if (live.startup) {
          clearTimeout(live.startup.timeout);
          live.startup.reject(new Error(`external agent session exited before app-server thread was ready: ${id}`));
          live.startup = undefined;
        }
        for (const pending of live.pendingHistoryPages.values()) {
          clearTimeout(pending.timeout);
          pending.reject(new Error(`external agent session exited before history page response: ${id}`));
        }
        let remainingText = decoder.flush();
        if (pendingCR) remainingText = `\r${remainingText}`;
        pendingCR = remainingText.endsWith('\r');
        if (pendingCR) remainingText = remainingText.slice(0, -1);
        remainingText = remainingText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (remainingText) this.ctx.outputPipeline.output(args.transcriptTargetId, id, remainingText, 'pty', adapter);
        if (pendingCR) this.ctx.outputPipeline.output(args.transcriptTargetId, id, '\n', 'pty', adapter);
        void live.liveRawStore?.closeAndDelete();
        this.ctx.live.delete(id);
        if (runtimeRole === 'managed-project-agent' && managed) cleanupManagedProjectRuntimeToken(managed.workspace);
        this.ctx.outputPipeline.dropStructuredBuffer(id);
        this.ctx.appServerConnections.unlinkSocket(appServerSocketPath);
        const exitedAt = new Date().toISOString();
        const state = code === 0 ? 'exited' : 'failed';
        this.ctx.deps.store.closeExternalAgentSession(id, exitedAt, code, state);
        this.ctx.events.emit(args.transcriptTargetId, 'external_agent.exited', {
          externalAgentSessionId: id,
          exitCode: code,
          state
        });
        this.ctx.observation.publish(id, true);
        this.ctx.log[state === 'failed' ? 'error' : 'debug'](
          {
            sessionId: args.transcriptTargetId,
            event: 'external_agent.exited',
            externalAgentSessionId: id,
            exitCode: code,
            state
          },
          'native cli exited'
        );
      });
    };
    live.restartRuntime = launch.capabilities.includes('session-resume')
      ? async () => {
          if (!live.suspended) return;
          if (this.ctx.live.get(id) !== live) return;
          launch = resolveExternalAgentLaunchCommand(
            adapter,
            buildExternalAgentLaunch(
              agent,
              buildLaunchOpts({
                launchMode: launch.launchMode,
                appServerTransport: launch.appServerTransport,
                providerSessionRef: live.providerSessionRef ?? undefined
              })
            )
          );
          launch = managed ? { ...launch, env: { ...(launch.env ?? {}), ...managed.env } } : launch;
          spawnEnv = await this.ctx.buildSpawnEnv(launch.env);
          isAppServerWs = launch.launchMode === 'app-server' && launch.appServerTransport === 'ws';
          isAppServerUnix = launch.launchMode === 'app-server' && launch.appServerTransport === 'unix';
          isAppServerSocket = isAppServerWs || isAppServerUnix;
          const nextProc = spawnPipeMode();
          await nextProc.supervision?.tracked;
          attachExitHandler(nextProc);
          const waitForAppServerResume = waitForAppServerThread();
          try {
            await attachRuntimeStreams(nextProc);
            if (waitForAppServerResume) await waitForAppServerResume;
          } catch (error) {
            if (live.startup) {
              clearTimeout(live.startup.timeout);
              live.startup.reject(error instanceof Error ? error : new Error(String(error)));
              live.startup = undefined;
            }
            if (waitForAppServerResume) await waitForAppServerResume.catch(() => undefined);
            nextProc.supervision?.stop('manual', 'SIGTERM');
            throw error;
          }
          live.suspended = false;
          this.ctx.updateExternalAgentPid(id, nextProc.pid);
          this.ctx.observation.publish(id);
          this.ctx.events.emit(live.transcriptTargetId, 'external_agent.idle_resumed', {
            agentId: live.agentName,
            agentName: live.displayName ?? live.agentName,
            type: 'idle_resumed',
            payload: { externalAgentSessionId: live.id }
          });
          this.ctx.log.debug(
            { sessionId: live.transcriptTargetId, event: 'external_agent.idle_resumed', externalAgentSessionId: id },
            'native cli idle resumed'
          );
        }
      : undefined;
    live.idleTimeoutMs = live.restartRuntime ? this.ctx.idleTimeoutMs() : undefined;
    try {
      await attachRuntimeStreams(proc);
    } catch (error) {
      live.startup?.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (waitForAppServerStartup) {
      try {
        await waitForAppServerStartup;
      } catch (error) {
        if (live.startup) clearTimeout(live.startup.timeout);
        live.startup = undefined;
        if (runtimeRole === 'managed-project-agent' && managed) cleanupManagedProjectRuntimeToken(managed.workspace);
        this.ctx.live.delete(id);
        this.ctx.outputPipeline.dropStructuredBuffer(id);
        this.ctx.appServerConnections.unlinkSocket(appServerSocketPath);
        proc.supervision?.stop('manual', 'SIGTERM');
        const failedAt = new Date().toISOString();
        this.ctx.deps.store.upsertExternalAgentSession({
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
    attachExitHandler(proc);
    this.ctx.armIdleSuspend(live);
    this.ctx.events.emit(args.transcriptTargetId, 'external_agent.started', {
      externalAgentSessionId: id,
      agentName: runtimeAgentName,
      provider: agent.provider,
      productIcon: adapter.productIcon,
      launchMode: launch.launchMode,
      workingPath,
      pid: proc.pid
    });
    this.ctx.log.debug(
      {
        sessionId: args.transcriptTargetId,
        event: 'external_agent.started',
        externalAgentSessionId: id,
        agentName: runtimeAgentName,
        provider: agent.provider,
        launchMode: launch.launchMode,
        workingPath,
        pid: proc.pid
      },
      'native cli started'
    );

    return toView(row);
  }
}
