import type {
  Event,
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
import type { StructuredLineBufferState } from '@/services/native-cli/structured-lines.ts';
import type {
  NativeCliLaunchSpec,
  NativeCliOutputEvent,
  NativeCliProviderAdapter,
  NativeCliStartPreflight
} from '@/services/native-cli/types.ts';
import type { NativeCliSessionRow } from '@/store/db/index.ts';

import { chmodSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createLogger } from '@monad/logger';
import { newId } from '@monad/protocol';

import { daemonChildProcesses } from '@/infra/daemon-child-processes.ts';
import { connectAppServerStdio } from '@/services/native-cli/app-server-stdio.ts';
import { connectAppServerUnix } from '@/services/native-cli/app-server-unix.ts';
import { connectAppServerWs, dialAppServerWs, dialAppServerWsWithRetry } from '@/services/native-cli/app-server-ws.ts';
import { NativeCliAuthHost, type NativeCliAuthListener } from '@/services/native-cli/auth-host.ts';
import { BoundedOutputBuffer } from '@/services/native-cli/bounded-output-buffer.ts';
import { MAX_OUTPUT_SNAPSHOT } from '@/services/native-cli/constants.ts';
import { NativeCliError } from '@/services/native-cli/errors.ts';
import { providerHistoryOutputFromLocal, providerHistoryOutputViaCli } from '@/services/native-cli/history-backfill.ts';
import {
  APP_SERVER_DISCONNECT_GRACE_MS,
  APP_SERVER_MAX_DISCONNECT_CYCLES,
  APP_SERVER_RECONNECT_ATTEMPTS,
  APP_SERVER_RECONNECT_BASE_MS,
  APP_SERVER_RECONNECT_STREAK_RESET_MS,
  APP_SERVER_STARTUP_TIMEOUT_MS,
  HISTORY_PAGE_TIMEOUT_MS,
  MAX_STRUCTURED_LINE,
  type NativeCliOutputStream,
  SNAPSHOT_FLUSH_MS
} from '@/services/native-cli/host-constants.ts';
import {
  isManagedProjectRuntime,
  nativeAgentMcpToolError,
  nativeCliApprovalText,
  toView
} from '@/services/native-cli/host-helpers.ts';
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
import {
  killNativeCliProcess,
  pickPtyFallbackLaunchMode,
  readProcessRegistry,
  writeProcessRegistry
} from '@/services/native-cli/process.ts';
import { buildNativeCliSpawnEnv, requireNativeCliAgent } from '@/services/native-cli/spawn-support.ts';
import { createStreamingTextDecoder } from '@/services/native-cli/stream-decoder.ts';
import { takeCompleteStructuredLines } from '@/services/native-cli/structured-lines.ts';
import { nativeCliOutputEventSchema } from '@/services/native-cli/types.ts';

export type { NativeCliHostDeps };

export class NativeCliHost {
  private readonly log = createLogger('native-cli');

  private readonly live = new Map<string, LiveNativeCliSession>();
  private readonly observation = new NativeCliObservationHub({
    getLive: (id) => this.live.get(id),
    observe: (id, afterSeq) => this.observe(id, afterSeq)
  });
  private readonly structuredOutputBuffers = new Map<
    string,
    Partial<Record<NativeCliOutputStream, StructuredLineBufferState>>
  >();
  private managedProjectOutputHandler: ManagedProjectOutputHandler | null = null;
  /** Provider-login (auth) sessions and one-shot auth/usage probes live in their own host; they share
   *  no state with interactive sessions. Public auth methods below delegate straight through. */
  private readonly authHost: NativeCliAuthHost;
  /** Serializes read-modify-write access to the native-CLI process registry file: the reads/writes
   *  are async (never block the event loop), so overlapping track/untrack calls are chained onto
   *  this promise instead of racing each other and losing an update. */
  private registryQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: NativeCliHostDeps) {
    this.authHost = new NativeCliAuthHost(deps);
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
    daemonChildProcesses.track(pid, 'native-cli', () => killNativeCliProcess(pid));
    this.registryQueue = this.registryQueue
      .then(() => readProcessRegistry(this.deps.nativeCliProcessRegistryPath))
      .then((pids) => writeProcessRegistry(this.deps.nativeCliProcessRegistryPath, [...new Set([...pids, pid])]))
      .catch(() => {
        /* best-effort registry write — never blocks or breaks the queue for later calls */
      });
  }

  private untrackNativeCliProcess(pid: number): void {
    daemonChildProcesses.untrack(pid);
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
    const appServerSocketPath = wantsUnixAppServer ? this.allocateAppServerSocketPath(id) : undefined;
    // A `ws` app-server MAY prefer a daemon-assigned port over self-announcing one (see
    // `NativeCliAppServerWsHints.port`) — allocate a candidate up front so `buildLaunch` can put it in
    // argv if it wants to. Gated on the adapter's own opt-in (not just transport === 'ws'), since a
    // self-announcing ws provider (e.g. codex) never reads the allocated port and the bind+release
    // syscall would otherwise run on every one of its app-server launches for nothing.
    const wantsWsAppServer =
      effectiveLaunchMode === 'app-server' &&
      (args.appServerTransport ?? agent.appServerTransport ?? 'ws') === 'ws' &&
      !!adapter.usesDaemonAssignedAppServerPort;
    const appServerPort = wantsWsAppServer ? await this.allocateAppServerPort() : undefined;
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
      this.emit(args.transcriptTargetId, 'native_cli.exited', {
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
      return this.startCliOneshot({
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
                if (text) this.output(args.transcriptTargetId, id, text, 'pty', adapter);
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
      this.emit(args.transcriptTargetId, 'native_cli.exited', {
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
      this.drainStream(proc.stdout);
      const isSelfAnnouncingWs = !isAppServerUnix && launch.appServerWs?.port === undefined;
      if (!isSelfAnnouncingWs) this.drainStream(proc.stderr);
      const onMessage = (text: string): void => this.output(args.transcriptTargetId, id, text, 'app-server', adapter);
      const onClose = (): void => this.handleAppServerDisconnect(id);
      try {
        if (isAppServerUnix) {
          const socketPath = appServerSocketPath ?? '';
          live.appServer = await this.raceAgainstExit(
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
          live.appServer = await this.raceAgainstExit(dialAppServerWsWithRetry(wsPort, dialOpts), proc.exited);
          live.appServerRedial = () => dialAppServerWsWithRetry(wsPort, dialOpts);
        } else {
          live.appServer = await this.raceAgainstExit(
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
          this.drainStream(proc.stderr);
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
      this.readPipe(args.transcriptTargetId, id, proc.stdout, 'stdout', adapter);
      this.readPipe(args.transcriptTargetId, id, proc.stderr, 'stderr', adapter);
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
        this.structuredOutputBuffers.delete(id);
        this.unlinkAppServerSocket(appServerSocketPath);
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
    this.emit(args.transcriptTargetId, 'native_cli.started', {
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
      if (remainingText) this.output(args.transcriptTargetId, id, remainingText, 'pty', adapter);
      if (pendingCR) this.output(args.transcriptTargetId, id, '\n', 'pty', adapter);
      this.flushSnapshot(id);
      this.live.delete(id);
      if (runtimeRole === 'managed-project-agent' && managed) cleanupManagedProjectRuntimeToken(managed.workspace);
      this.untrackNativeCliProcess(proc.pid);
      this.structuredOutputBuffers.delete(id);
      this.unlinkAppServerSocket(appServerSocketPath);
      const exitedAt = new Date().toISOString();
      const state = code === 0 ? 'exited' : 'failed';
      this.deps.store.closeNativeCliSession(id, exitedAt, code, state);
      this.emit(args.transcriptTargetId, 'native_cli.exited', { nativeCliSessionId: id, exitCode: code, state });
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

  /** Register a `cli-oneshot` session: a logical session with NO persistent process. Each turn spawns a
   *  fresh CLI (see runCliOneshotTurn). Mirrors the persistent path's row/live/started bookkeeping. */
  private startCliOneshot(args: {
    id: string;
    transcriptTargetId: TranscriptTargetId;
    agentName: string;
    provider: NativeCliSessionRow['provider'];
    workingPath: string;
    runtimeRole: NativeCliSessionView['runtimeRole'];
    launch: NativeCliLaunchSpec;
    adapter: NativeCliProviderAdapter;
    managed: ReturnType<typeof prepareManagedProjectRuntime> | null;
    providerSessionRef: string | null;
    startedAt: string;
  }): NativeCliSessionView {
    const { id, transcriptTargetId, agentName, provider, workingPath, runtimeRole, launch, adapter, managed } = args;
    const row: NativeCliSessionRow = {
      id,
      transcriptTargetId,
      agentName,
      provider,
      workingPath,
      launchMode: 'cli-oneshot',
      runtimeRole,
      agentRuntimeId: runtimeRole === 'managed-project-agent' ? id : null,
      agentRuntimeTokenHash: managed?.tokenHash ?? null,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      state: 'running',
      pid: null,
      providerSessionRef: args.providerSessionRef,
      outputSnapshot: '',
      exitCode: null,
      startedAt: args.startedAt,
      updatedAt: args.startedAt,
      exitedAt: null
    };
    this.deps.store.upsertNativeCliSession(row);
    const live: LiveNativeCliSession = {
      id,
      transcriptTargetId,
      agentName,
      provider,
      runtimeRole,
      // cli-oneshot spawns a fresh stateless process per turn — no persistent channel to resolve an
      // approval through, so it never delegates (autopilot only).
      proxyApprovals: false,
      adapter,
      launchMode: 'cli-oneshot',
      oneshotSpec: launch,
      managedPrompt: managed?.prompt ?? null,
      providerSessionRef: args.providerSessionRef,
      pendingApprovals: new Map(),
      pendingHistoryPages: new Map(),
      pendingRequests: new Map(),
      startup: undefined,
      outputBuffer: new BoundedOutputBuffer(MAX_OUTPUT_SNAPSHOT),
      outputSeq: 0,
      snapshotFlushTimer: null,
      nextRequestId: () => 0,
      kill: (signal) => {
        const l = this.live.get(id);
        if (l?.oneshotTurnProc) killNativeCliProcess(l.oneshotTurnProc.pid, signal);
      }
    };
    this.live.set(id, live);
    this.emit(transcriptTargetId, 'native_cli.started', {
      nativeCliSessionId: id,
      agentName,
      provider,
      productIcon: adapter.productIcon,
      launchMode: 'cli-oneshot',
      workingPath,
      pid: null
    });
    return toView(row);
  }

  /** Run one `cli-oneshot` turn: spawn a fresh CLI with the directive baked into argv, stream its stdout
   *  into the transcript, and let it exit. The member's actual reply reaches the project via its
   *  `monad project post` callback (managed runtime), so we only need to run the process to completion. */
  private async runCliOneshotTurn(live: LiveNativeCliSession, input: string): Promise<void> {
    const spec = live.oneshotSpec;
    const turnArgsFn = live.adapter.oneshotTurnArgs;
    if (!spec || !turnArgsFn) return;
    // cli-oneshot is STATELESS per turn (a fresh process, no --resume selector), so the managed
    // collaboration prompt must ride EVERY turn's directive — not just the first — or turns 2+ forget
    // the `monad project post/ask/read` contract and their reply never reaches the project.
    const directive = live.managedPrompt ? `${live.managedPrompt}\n\n---\n\n${input}` : input;
    const turnArgs = turnArgsFn(directive, { providerSessionRef: live.providerSessionRef });
    const spawnEnv = await this.buildSpawnEnv(spec.env);
    let proc: NativeCliProcess;
    try {
      proc = Bun.spawn([...spec.argv, ...turnArgs], {
        cwd: spec.cwd,
        env: spawnEnv,
        detached: true,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe'
      }) as NativeCliProcess;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output(live.transcriptTargetId, live.id, message, 'stderr', live.adapter);
      this.flushSnapshot(live.id);
      return;
    }
    live.oneshotTurnProc = proc;
    this.trackNativeCliProcess(proc.pid);
    // Surface BOTH streams into the transcript (stderr carries a provider's real errors), and await both
    // drains so all output is emitted before the turn is considered done.
    const pump = (stream: ReadableStream<Uint8Array> | undefined, name: 'stdout' | 'stderr'): Promise<void> => {
      if (!stream) return Promise.resolve();
      const decoder = createStreamingTextDecoder();
      return (async () => {
        for await (const data of stream) {
          const text = decoder.decode(data);
          if (text) this.output(live.transcriptTargetId, live.id, text, name, live.adapter);
        }
        const rest = decoder.flush();
        if (rest) this.output(live.transcriptTargetId, live.id, rest, name, live.adapter);
      })();
    };
    const drains = Promise.all([pump(proc.stdout, 'stdout'), pump(proc.stderr, 'stderr')]);
    const code = await proc.exited;
    await drains;
    this.untrackNativeCliProcess(proc.pid);
    if (live.oneshotTurnProc === proc) live.oneshotTurnProc = undefined;
    this.flushSnapshot(live.id);
    if (code !== 0) {
      this.output(
        live.transcriptTargetId,
        live.id,
        `\n[${live.provider} turn exited with code ${code}]\n`,
        'stderr',
        live.adapter
      );
    }
    // The turn's process has exited. For a managed member the real reply arrives via its
    // `monad project post` callback (which already completed the thinking indicator); but if the CLI
    // finished WITHOUT posting, retire the dangling spinner so the member doesn't look stuck forever.
    // No-op when a post already settled it (nothing pending) — process exit is the definitive turn end.
    if (live.runtimeRole === 'managed-project-agent') {
      this.emitManagedProjectOutput(live.transcriptTargetId, live.id, '', false, false);
    }
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
        .then(() => this.runCliOneshotTurn(live, req.input))
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
        this.takeCompleteStructuredLines(structuredId, stream, chunk),
      dropStructuredBuffer: (structuredId) => this.structuredOutputBuffers.delete(structuredId)
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
    this.emit(live.transcriptTargetId, 'native_cli.approval_resolved', {
      nativeCliSessionId: id,
      provider: live.adapter.provider,
      requestId: req.requestId,
      allow: req.allow,
      ...(req.reason ? { reason: req.reason } : {})
    });
  }

  /** Allocate the AF_UNIX socket path a `unix` app-server child will listen on. The path must stay
   *  under the OS SUN_LEN limit and sit in a real (non-symlink) directory codex is willing to bind in
   *  — a private, owner-only subdir of the resolved temp dir satisfies both (macOS `/tmp` is a symlink
   *  and codex refuses to bind directly in the sticky temp root). */
  private allocateAppServerSocketPath(id: string): string {
    const dir = join(realpathSync(tmpdir()), 'monad-appserver');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is a no-op if the dir already exists (e.g. a looser dir pre-created by another
    // local user in a shared tmp), so tighten it explicitly to owner-only.
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* not chmod-able (e.g. Windows) */
    }
    const path = join(dir, `${id.replace(/[^a-zA-Z0-9]/g, '').slice(-12)}.sock`);
    if (Buffer.byteLength(path) > 100) {
      throw new NativeCliError(
        'unsupported_capability',
        'app-server unix socket path exceeds the OS limit; use the stdio or ws transport'
      );
    }
    rmSync(path, { force: true });
    return path;
  }

  /** Pick a free loopback TCP port for a `ws` app-server the daemon wants to assign an explicit
   *  `--port` to (see `NativeCliAppServerWsHints.port`) rather than parsing a self-announced one. Binds
   *  to port 0 and immediately releases it — a standard, small-window TOCTOU (acceptable for a
   *  same-process child the daemon spawns milliseconds later) rather than a hard guarantee. */
  private allocateAppServerPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() => {
          if (address && typeof address === 'object') resolve(address.port);
          else reject(new Error('app-server ws transport: could not allocate a loopback port'));
        });
      });
    });
  }

  private unlinkAppServerSocket(socketPath: string | undefined): void {
    if (!socketPath) return;
    try {
      rmSync(socketPath, { force: true });
    } catch {
      /* already gone */
    }
  }

  /** An app-server byte channel closed on its own. On loopback this is almost always the child
   *  exiting — `proc.exited` handles that within the grace window and records the real exit state. If
   *  the session is still live after the grace the child is alive but the socket dropped: re-dial the
   *  same socket and re-establish the thread via `thread/resume`. Only if reconnect fails do we tear
   *  the session down and prompt a manual reconnect. A drop during startup (no thread yet) fails fast. */
  private handleAppServerDisconnect(id: string): void {
    if (!this.live.has(id)) return;
    setTimeout(() => {
      const current = this.live.get(id);
      if (!current || current.appServerReconnecting) return;
      this.log.warn(
        {
          sessionId: current.transcriptTargetId,
          event: 'native_cli.app_server_disconnected',
          nativeCliSessionId: id,
          provider: current.provider
        },
        'native cli app-server socket dropped while the process is still alive'
      );
      // A gateway can close the socket on its very first handshake attempt (e.g. OpenClaw rejects
      // `connect` with `retryable:true` while its sidecar plugins are still loading, then drops the
      // connection) — redial first if the launch mode supports it, even while `live.startup` is still
      // pending. `reconnectAppServer`'s own bounded attempts keep this fast, and its failure path already
      // calls `stop()`, which rejects a still-pending `startup` with a clear message — so this doesn't
      // weaken the original guarantee, it just gives a slow-starting gateway a few quick retries first.
      //
      // `reconnectAppServer` declares success as soon as the socket TRANSPORT reopens, before the
      // app-level handshake completes — so its own attempt counter only bounds transport-dial failures
      // within ONE call. A gateway whose socket keeps reopening but whose handshake keeps failing (e.g.
      // an adapter that swallows a transient handshake rejection expecting the resulting socket-close to
      // trigger redial) would restart that counter every cycle and never reach an exhaustion path.
      // `appServerDisconnectCycles` is the cross-invocation ceiling that closes that gap.
      if (current.appServerStreakResetTimer) {
        clearTimeout(current.appServerStreakResetTimer);
        current.appServerStreakResetTimer = undefined;
      }
      if (current.appServerRedial) {
        current.appServerDisconnectCycles = (current.appServerDisconnectCycles ?? 0) + 1;
        if (current.appServerDisconnectCycles <= APP_SERVER_MAX_DISCONNECT_CYCLES) {
          void this.reconnectAppServer(id);
          return;
        }
        this.log.warn(
          {
            sessionId: current.transcriptTargetId,
            event: 'native_cli.app_server_reconnect_churn_exceeded',
            nativeCliSessionId: id,
            provider: current.provider,
            cycles: current.appServerDisconnectCycles
          },
          'native cli app-server exceeded its reconnect churn budget — giving up'
        );
      }
      if (current.startup) {
        clearTimeout(current.startup.timeout);
        current.startup.reject(new Error(`native CLI app-server socket dropped before ready: ${id}`));
        current.startup = undefined;
        this.stop(id);
        return;
      }
      this.emitAppServerReconnectRequired(id, current);
      this.stop(id);
    }, APP_SERVER_DISCONNECT_GRACE_MS);
  }

  private emitAppServerReconnectRequired(id: string, live: LiveNativeCliSession): void {
    this.emit(live.transcriptTargetId, 'native_cli.connection_required', {
      nativeCliSessionId: id,
      agentName: live.agentName,
      provider: live.provider,
      reason: `${live.provider} app-server connection dropped`,
      reconnectIn: 'studio'
    });
  }

  /** Re-dial the app-server socket and resume the thread, with a few backoff attempts. On success the
   *  session keeps running on the fresh connection; on exhaustion it is torn down with a reconnect
   *  prompt. Stale request ids from the dropped socket are cleared — their responses will never come. */
  private async reconnectAppServer(id: string): Promise<void> {
    const live = this.live.get(id);
    if (!live?.appServerRedial || live.appServerReconnecting) return;
    live.appServerReconnecting = true;
    for (let attempt = 1; attempt <= APP_SERVER_RECONNECT_ATTEMPTS; attempt++) {
      if (!this.live.has(id)) return; // torn down meanwhile
      await Bun.sleep(APP_SERVER_RECONNECT_BASE_MS * attempt);
      const current = this.live.get(id);
      if (!current?.appServerRedial) return;
      try {
        const connection = await current.appServerRedial();
        current.appServer = connection;
        current.pendingRequests.clear();
        current.appServerReconnecting = false;
        current.adapter.initialize?.(current, {
          ...(current.initializeContext ?? { workingPath: '' }),
          providerSessionRef: current.providerSessionRef ?? undefined
        });
        // This call only proves the socket TRANSPORT reopened, not that the app-level handshake will
        // succeed — so don't reset the churn counter yet. Reset it once this connection survives a
        // stretch without dropping again; a fresh disconnect cancels this timer (see
        // `handleAppServerDisconnect`), so a persistently-flapping gateway can't reset its own count by
        // surviving just long enough between drops.
        current.appServerStreakResetTimer = setTimeout(() => {
          const stillLive = this.live.get(id);
          if (stillLive) {
            stillLive.appServerDisconnectCycles = 0;
            stillLive.appServerStreakResetTimer = undefined;
          }
        }, APP_SERVER_RECONNECT_STREAK_RESET_MS);
        this.log.debug(
          { sessionId: current.transcriptTargetId, event: 'native_cli.app_server_reconnected', nativeCliSessionId: id },
          'native cli app-server reconnected'
        );
        return;
      } catch {
        /* retry */
      }
    }
    const current = this.live.get(id);
    if (current) {
      current.appServerReconnecting = false;
      this.emitAppServerReconnectRequired(id, current);
      this.stop(id);
    }
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
    this.flushSnapshot(id);
    this.live.delete(id);
    const row = this.deps.store.getNativeCliSession(id);
    if (row?.runtimeRole === 'managed-project-agent')
      cleanupManagedProjectRuntimeToken(this.managedRuntimeWorkspace(row));
    if (live.proc) this.untrackNativeCliProcess(live.proc.pid);
    this.structuredOutputBuffers.delete(id);
    this.unlinkAppServerSocket(live.appServerSocketPath);
    const exitedAt = new Date().toISOString();
    this.deps.store.closeNativeCliSession(id, exitedAt, null, 'stopped');
    this.emit(live.transcriptTargetId, 'native_cli.exited', {
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

  stopAll(): void {
    for (const id of [...this.live.keys()]) {
      try {
        this.stop(id);
      } catch (error) {
        this.log.error(
          {
            event: 'native_cli.stop_all_failed',
            nativeCliSessionId: id,
            err: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
          },
          'native cli stop-all failed'
        );
      }
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

  private readPipe(
    transcriptTargetId: TranscriptTargetId,
    id: string,
    stream: ReadableStream<Uint8Array> | undefined,
    name: 'stdout' | 'stderr',
    adapter: NativeCliProviderAdapter
  ): void {
    if (!stream) return;
    const decoder = createStreamingTextDecoder();
    void (async () => {
      for await (const data of stream) {
        const text = decoder.decode(data);
        if (text) this.output(transcriptTargetId, id, text, name, adapter);
      }
      const remainingText = decoder.flush();
      if (remainingText) this.output(transcriptTargetId, id, remainingText, name, adapter);
    })();
  }

  /** Consume-and-discard a child stream. For ws app-server sessions the protocol arrives over the
   *  WebSocket, so stdout/stderr are only logs — but they must still be drained or a full pipe buffer
   *  will stall the child. */
  private drainStream(stream: ReadableStream<Uint8Array> | undefined): void {
    if (!stream) return;
    void (async () => {
      try {
        const reader = stream.getReader();
        for (;;) {
          const { done } = await reader.read();
          if (done) return;
        }
      } catch {
        /* stream closed */
      }
    })();
  }

  /** Race an app-server connect attempt against the child exiting. Without this, a child that crashes
   *  immediately after spawn (missing dependency, port stolen between allocation and bind, etc.) is only
   *  noticed once the connect's own timeout elapses — the daemon keeps retrying against a port that will
   *  never open for the full app-server startup timeout instead of failing within milliseconds. */
  private async raceAgainstExit<T>(connect: Promise<T>, exited: Promise<number>): Promise<T> {
    let settled = false;
    const exitGuard = exited.then((code) => {
      if (settled) return undefined as T;
      throw new Error(`native CLI process exited (code ${code}) before the app-server became ready`);
    });
    try {
      return await Promise.race([connect, exitGuard]);
    } finally {
      settled = true;
    }
  }

  private output(
    transcriptTargetId: TranscriptTargetId,
    id: string,
    chunk: string,
    // 'app-server' is a single pre-framed JSON-RPC message (one ws text frame) — already a complete
    // line, so it skips the newline-reassembly buffer that stdout/stderr byte chunks need.
    stream: 'stdout' | 'stderr' | 'pty' | 'app-server',
    adapter: NativeCliProviderAdapter
  ): void {
    // Keep the observation snapshot newline-delimited so the web parser can split records; a ws frame
    // carries no trailing newline of its own.
    const buffered = stream === 'app-server' ? `${chunk}\n` : chunk;
    const live = this.live.get(id);
    if (live) {
      // Accumulate in memory and flush the bounded snapshot to SQLite on a timer — avoids a
      // per-chunk 256 KB read-modify-write under a chatty agent.
      live.outputBuffer.append(buffered);
      live.outputSeq += buffered.length;
      if (!isManagedProjectRuntime(live)) this.scheduleSnapshotFlush(id);
      this.observation.publish(id);
    } else {
      const row = this.deps.store.getNativeCliSession(id);
      if (!row || !isManagedProjectRuntime(row))
        this.deps.store.appendNativeCliOutput(id, buffered, MAX_OUTPUT_SNAPSHOT);
    }
    this.publishEphemeral(transcriptTargetId, 'native_cli.output', {
      nativeCliSessionId: id,
      stream: stream === 'app-server' ? 'stdout' : stream,
      chunk: buffered
    });
    const structuredChunk =
      stream === 'pty' || stream === 'app-server' ? chunk : this.takeCompleteStructuredLines(id, stream, chunk);
    if (!structuredChunk) return;
    if (stream === 'stderr') {
      for (const line of structuredChunk.split('\n')) {
        const record = nativeAgentMcpToolError(line.trim());
        if (!record) continue;
        const liveSession = this.live.get(id);
        this.log.error(
          {
            ...record,
            transcriptTargetId,
            nativeCliSessionId: id,
            agentName: liveSession?.agentName,
            provider: liveSession?.provider
          },
          'managed native cli agent-facing MCP tool failed'
        );
      }
    }
    for (const event of adapter.parseOutput(structuredChunk, this.live.get(id))) {
      const parsed = nativeCliOutputEventSchema.safeParse(event);
      if (!parsed.success) continue;
      this.emitStructuredOutputEvent(transcriptTargetId, id, adapter, parsed.data);
    }
  }

  private scheduleSnapshotFlush(id: string): void {
    const live = this.live.get(id);
    if (!live || live.snapshotFlushTimer) return;
    live.snapshotFlushTimer = setTimeout(() => {
      const current = this.live.get(id);
      if (current) current.snapshotFlushTimer = null;
      this.flushSnapshot(id);
    }, SNAPSHOT_FLUSH_MS);
  }

  /** Persist the in-memory snapshot now and cancel any pending flush. Called on the timer and once
   *  more on exit/stop so the final output isn't lost. */
  private flushSnapshot(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    if (live.snapshotFlushTimer) {
      clearTimeout(live.snapshotFlushTimer);
      live.snapshotFlushTimer = null;
    }
    if (!isManagedProjectRuntime(live))
      this.deps.store.setNativeCliOutputSnapshot(id, live.outputBuffer.snapshot(), MAX_OUTPUT_SNAPSHOT);
  }

  private takeCompleteStructuredLines(id: string, stream: 'stdout' | 'stderr', chunk: string): string {
    const buffers = this.structuredOutputBuffers.get(id) ?? {};
    const state = buffers[stream] ?? { text: '', discarding: false };
    const completeLines = takeCompleteStructuredLines(state, chunk, MAX_STRUCTURED_LINE);
    buffers[stream] = state;
    this.structuredOutputBuffers.set(id, buffers);
    return completeLines;
  }

  private emitStructuredOutputEvent(
    transcriptTargetId: TranscriptTargetId,
    id: string,
    adapter: NativeCliProviderAdapter,
    event: NativeCliOutputEvent
  ): void {
    if (event.type === 'agent_message') {
      // A managed provider's own message is diagnostic output — observable through the native_cli
      // output card, never auto-posted to the Workplace Project wall. A reply reaches the room only
      // when the agent explicitly posts via the bridge (`monad project post`), which the wake notice
      // instructs it to do. This keeps every provider consistent (codex never carried a terminal
      // `final` marker) and avoids double-posting the same text via both paths. Errors still surface
      // below via the provider_error branch.
      if (event.payload.final === true) {
        this.emitManagedProjectOutput(
          transcriptTargetId,
          id,
          typeof event.payload.text === 'string' ? event.payload.text : '',
          false,
          false
        );
      }
      return;
    }

    if (event.type === 'session_ref') {
      const providerSessionRef =
        typeof event.payload.providerSessionRef === 'string' ? event.payload.providerSessionRef : undefined;
      if (providerSessionRef) {
        const live = this.live.get(id);
        if (live) {
          live.providerSessionRef = providerSessionRef;
          if (live.startup) {
            clearTimeout(live.startup.timeout);
            live.startup.resolve(providerSessionRef);
            live.startup = undefined;
          }
        }
        this.deps.store.updateNativeCliSessionRef(id, providerSessionRef);
      }
      return;
    }

    if (event.type === 'history_page') {
      const responseId =
        typeof event.payload.responseId === 'string' ? event.payload.responseId : String(event.payload.responseId);
      const live = this.live.get(id);
      const pending = live?.pendingHistoryPages.get(responseId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      live?.pendingHistoryPages.delete(responseId);
      pending.resolve({
        items: Array.isArray(event.payload.items) ? event.payload.items : [],
        nextCursor: typeof event.payload.nextCursor === 'string' ? event.payload.nextCursor : null,
        backwardsCursor: typeof event.payload.backwardsCursor === 'string' ? event.payload.backwardsCursor : null
      });
      return;
    }

    if (event.type === 'connection_required') {
      const live = this.live.get(id);
      this.emit(transcriptTargetId, 'native_cli.connection_required', {
        nativeCliSessionId: id,
        agentName: live?.agentName ?? adapter.provider,
        provider: adapter.provider,
        reason:
          typeof event.payload.reason === 'string'
            ? event.payload.reason
            : `${adapter.provider} requires reconnect in Studio`,
        reconnectIn: 'studio'
      });
      this.stop(id);
      return;
    }

    if (event.type === 'provider_error') {
      const live = this.live.get(id);
      const message =
        typeof event.payload.message === 'string' ? event.payload.message : `${adapter.provider} provider error`;
      if (live?.startup) {
        clearTimeout(live.startup.timeout);
        live.startup.reject(new NativeCliError('provider_protocol_error', message));
        live.startup = undefined;
      }
      this.emit(transcriptTargetId, 'native_cli.output', {
        nativeCliSessionId: id,
        stream: 'stderr',
        chunk: message,
        provider: adapter.provider,
        code: event.payload.code,
        responseId: event.payload.responseId
      });
      this.emitManagedProjectOutput(transcriptTargetId, id, message, true);
      return;
    }

    if (event.type === 'approval_requested') {
      const requestId =
        typeof event.payload.requestId === 'string' ? event.payload.requestId : String(event.payload.requestId);
      const live = this.live.get(id);
      // Autopilot managed sessions auto-deny any approval that leaks past the skip flag. A managed
      // session that delegates approvals (autopilot off + resolvable adapter) instead falls through
      // to the same projection path interactive sessions use — monad is only the UI proxy.
      if (live?.runtimeRole === 'managed-project-agent' && !live.proxyApprovals) {
        const text = nativeCliApprovalText(event);
        try {
          live.adapter.resolveApproval(live, {
            requestId,
            allow: false,
            reason: 'managed project native CLI provider approvals are disabled',
            request: event.payload
          });
        } catch (err) {
          this.log.debug(
            {
              sessionId: transcriptTargetId,
              event: 'native_cli.managed_project_provider_approval_suppress_error',
              nativeCliSessionId: id,
              provider: adapter.provider,
              requestId,
              text,
              err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err)
            },
            'managed native cli provider approval suppress failed'
          );
        }
        this.log.debug(
          {
            sessionId: transcriptTargetId,
            event: 'native_cli.managed_project_provider_approval_suppressed',
            nativeCliSessionId: id,
            provider: adapter.provider,
            requestId,
            text
          },
          'managed native cli provider approval suppressed'
        );
        return;
      }
      if (live?.pendingApprovals.has(requestId)) return;
      live?.pendingApprovals.set(requestId, event.payload);
      this.emit(transcriptTargetId, 'native_cli.approval_requested', {
        nativeCliSessionId: id,
        provider: adapter.provider,
        requestId,
        text: nativeCliApprovalText(event),
        data: event.payload
      });
      return;
    }

    if (event.type === 'approval_resolved') {
      const requestId =
        typeof event.payload.requestId === 'string' ? event.payload.requestId : String(event.payload.requestId);
      const live = this.live.get(id);
      if (!live?.pendingApprovals.has(requestId)) return;
      live.pendingApprovals.delete(requestId);
      this.emit(transcriptTargetId, 'native_cli.approval_resolved', {
        nativeCliSessionId: id,
        provider: adapter.provider,
        requestId,
        allow: event.payload.allow !== false,
        ...(typeof event.payload.reason === 'string' ? { reason: event.payload.reason } : {})
      });
    }
  }

  private emitManagedProjectOutput(
    transcriptTargetId: TranscriptTargetId,
    id: string,
    text: string,
    error = false,
    post = true
  ): void {
    const live = this.live.get(id);
    const row = this.deps.store.getNativeCliSession(id);
    const runtimeRole = live?.runtimeRole ?? row?.runtimeRole;
    if (runtimeRole !== 'managed-project-agent') return;
    if (post && !this.deps.store.hasUnconsumedNativeCliInbox(id)) return;
    const agentName = live?.agentName ?? row?.agentName;
    if (!agentName || !this.managedProjectOutputHandler) return;
    // Consume only what the agent actually saw in its input (visible), never items merely
    // delivered mid-turn (busy notice sent without the message body) — those must survive
    // this turn's settle so a later wake or `monad project inbox` can still surface them.
    const cursor = row?.lastVisibleSeq ?? 0;
    if (cursor > 0) this.deps.store.markNativeCliInboxConsumed(id, cursor);
    void Promise.resolve(
      this.managedProjectOutputHandler({
        sessionId: transcriptTargetId,
        nativeCliSessionId: id,
        agentName,
        text,
        error,
        post
      })
    ).catch((err: unknown) => {
      this.log.debug(
        {
          sessionId: transcriptTargetId,
          event: 'native_cli.managed_project_output_error',
          nativeCliSessionId: id,
          agentName,
          err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err)
        },
        'managed native cli provider output failed to project'
      );
    });
  }

  private buildEvent(sessionId: TranscriptTargetId, type: Event['type'], payload: Record<string, unknown>): Event {
    return {
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type,
      actorAgentId: null,
      payload,
      at: new Date().toISOString()
    };
  }

  /** Durable milestone event (started/exited/approval/…): persisted to the event log and published. */
  private emit(sessionId: TranscriptTargetId, type: Event['type'], payload: Record<string, unknown>): void {
    const event = this.buildEvent(sessionId, type, payload);
    this.deps.store.appendEvents([event]);
    this.deps.bus.publish(event);
  }

  /** Publish-only (never persisted). For high-frequency `native_cli.output` chunks: delivered live over
   *  the bus and captured in the bounded per-session output snapshot, so one durable row per chunk would
   *  grow the event log without bound. Hydration rebuilds the tool card from that snapshot instead
   *  (see SessionUiProjector.hydrateNativeCliSessions), so no durable output rows are needed. */
  private publishEphemeral(sessionId: TranscriptTargetId, type: Event['type'], payload: Record<string, unknown>): void {
    this.deps.bus.publish(this.buildEvent(sessionId, type, payload));
  }
}
