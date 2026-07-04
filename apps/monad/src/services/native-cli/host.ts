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
import type { EventBus } from '@/services/event-bus.ts';
import type { NativeCliProcess, NativeCliStdin, NativeCliTerminal } from '@/services/native-cli/runtime-types.ts';
import type { StructuredLineBufferState } from '@/services/native-cli/structured-lines.ts';
import type {
  NativeCliAppServerConnection,
  NativeCliInitializeContext,
  NativeCliLaunchSpec,
  NativeCliOutputEvent,
  NativeCliProviderAdapter,
  NativeCliStartPreflight
} from '@/services/native-cli/types.ts';
import type { NativeCliSessionRow, Store } from '@/store/db/index.ts';

import { chmodSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createLogger } from '@monad/logger';
import { newId } from '@monad/protocol';

import { connectAppServerStdio } from '@/services/native-cli/app-server-stdio.ts';
import { connectAppServerUnix } from '@/services/native-cli/app-server-unix.ts';
import { connectAppServerWs, dialAppServerWs } from '@/services/native-cli/app-server-ws.ts';
import { NativeCliAuthHost, type NativeCliAuthListener } from '@/services/native-cli/auth-host.ts';
import { BoundedOutputBuffer } from '@/services/native-cli/bounded-output-buffer.ts';
import { MAX_OUTPUT_SNAPSHOT } from '@/services/native-cli/constants.ts';
import { NativeCliError } from '@/services/native-cli/errors.ts';
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
import { killNativeCliProcess, readProcessRegistry, writeProcessRegistry } from '@/services/native-cli/process.ts';
import { buildNativeCliSpawnEnv, requireNativeCliAgent } from '@/services/native-cli/spawn-support.ts';
import { createStreamingTextDecoder } from '@/services/native-cli/stream-decoder.ts';
import { takeCompleteStructuredLines } from '@/services/native-cli/structured-lines.ts';
import { nativeCliOutputEventSchema } from '@/services/native-cli/types.ts';

interface ManagedProjectOutput {
  sessionId: TranscriptTargetId;
  nativeCliSessionId: string;
  agentName: string;
  text: string;
  error?: boolean;
  post?: boolean;
}

type ManagedProjectOutputHandler = (output: ManagedProjectOutput) => void | Promise<void>;
type NativeCliObservationListener = (access: NativeCliObservationAccessResponse, done: boolean) => void;

interface LiveNativeCliSession {
  id: string;
  transcriptTargetId: TranscriptTargetId;
  agentName: string;
  provider: NativeCliAgentView['provider'];
  runtimeRole: NativeCliSessionView['runtimeRole'];
  /** The long-lived child process. Absent for `cli-oneshot`, which spawns a fresh process per turn
   *  (see `oneshotTurnProc`) rather than keeping one alive for the session. */
  proc?: NativeCliProcess;
  adapter: NativeCliProviderAdapter;
  launchMode: NativeCliLaunchMode;
  terminal?: NativeCliTerminal;
  stdin?: NativeCliStdin;
  /** cli-oneshot only: the base launch spec (argv/env/cwd) reused for every per-turn spawn. */
  oneshotSpec?: NativeCliLaunchSpec;
  /** cli-oneshot only: the managed-project prompt, prepended to EVERY turn's directive (there is no
   *  session.start to carry it as developer instructions, and each turn is a stateless fresh process). */
  managedPrompt?: string | null;
  /** cli-oneshot only: the in-flight turn's process, so interrupt/stop can kill it. */
  oneshotTurnProc?: NativeCliProcess;
  /** cli-oneshot only: serializes turns so two concurrent deliveries (moderator fan-out + a user
   *  message) run one process at a time instead of racing/clobbering `oneshotTurnProc` + interleaving
   *  output into the shared buffer. */
  oneshotQueue?: Promise<void>;
  /** app-server frame channel, transport-neutral (stdio pipe or ws socket). Set once the chosen
   *  transport is connected; the adapter sends JSON-RPC frames through it. */
  appServer?: NativeCliAppServerConnection;
  /** Filesystem path of a `unix` app-server socket the daemon allocated, so it can be unlinked on
   *  teardown. Absent for stdio/ws. */
  appServerSocketPath?: string;
  /** Re-dial the app-server socket (ws port / unix path) after an unexpected drop. Absent for stdio
   *  (no socket) — a stdio drop means the child died, handled by `proc.exited`. */
  appServerRedial?: () => Promise<NativeCliAppServerConnection>;
  /** Guards against overlapping reconnect attempts. */
  appServerReconnecting?: boolean;
  /** The initialize context, retained so a reconnect can re-establish the thread via `thread/resume`. */
  initializeContext?: NativeCliInitializeContext;
  providerSessionRef?: string | null;
  pendingApprovals: Map<string, Record<string, unknown>>;
  pendingHistoryPages: Map<
    string,
    {
      resolve(page: NativeCliHistoryPageResponse['page']): void;
      reject(error: Error): void;
      timeout: Timer;
    }
  >;
  startup?: {
    resolve(providerSessionRef: string): void;
    reject(error: Error): void;
    timeout: Timer;
  };
  /** In-memory tail-bounded output snapshot, flushed to SQLite on a timer (see scheduleSnapshotFlush)
   *  instead of read-modify-writing the 256 KB column on every output chunk. Chunk-list backed so a
   *  per-token append stays O(chunk), not O(buffer). */
  outputBuffer: BoundedOutputBuffer;
  /** Cumulative length of all output ever appended (monotonic, unbounded — unlike `outputBuffer`,
   *  which keeps only the tail). Serves as the observation cursor so the stream can push deltas. */
  outputSeq: number;
  snapshotFlushTimer: Timer | null;
  /** JSON-RPC request→kind ledger for app-server sessions: the adapter records what each outbound
   *  request id was for so a response can be dispatched by id rather than by guessing its shape. */
  pendingRequests: Map<string | number, string>;
  nextRequestId(): number;
  kill(signal?: NodeJS.Signals): void;
}

export interface NativeCliHostDeps {
  store: Store;
  bus: EventBus;
  agents: () => Promise<NativeCliAgentView[]>;
  monadHome?: string;
  serverUrl?: string;
  /** Resolve `${env:}`/`${secret:}` refs in an agent's env against fresh auth before spawn. When
   *  absent (tests) the env is used verbatim. */
  resolveAgentEnv?: (env?: Record<string, string>) => Promise<Record<string, string> | undefined>;
  nativeCliProcessRegistryPath?: string;
  authProcessRegistryPath?: string;
  authHeartbeatTimeoutMs?: number;
}

const SNAPSHOT_FLUSH_MS = 200;
// observe() returns the whole output buffer, and a chatty CLI emits many chunks a second, so pushing
// a fresh full snapshot per chunk is quadratic bandwidth. Coalesce non-terminal pushes to this cadence.
const OBSERVATION_THROTTLE_MS = 200;
const HISTORY_BACKFILL_TIMEOUT_MS = 5_000;
const MAX_STRUCTURED_LINE = 2 * 1024 * 1024;
const HISTORY_PAGE_TIMEOUT_MS = 5_000;
const APP_SERVER_STARTUP_TIMEOUT_MS = 15_000;
// Grace after an app-server socket drops before we treat it as a real disconnect. Process death is
// handled by `proc.exited` (which fires within this window and cleans up with the right exit state);
// if the session is still live afterward the child is alive but the socket dropped — a genuine hang.
const APP_SERVER_DISCONNECT_GRACE_MS = 500;
const APP_SERVER_RECONNECT_ATTEMPTS = 3;
const APP_SERVER_RECONNECT_BASE_MS = 400;
type NativeCliOutputStream = 'stdout' | 'stderr' | 'pty';

function isManagedProjectRuntime(runtime: Pick<NativeCliSessionRow | LiveNativeCliSession, 'runtimeRole'>): boolean {
  return runtime.runtimeRole === 'managed-project-agent';
}

function toView(row: NativeCliSessionRow, pendingApprovalCount = 0, live?: LiveNativeCliSession): NativeCliSessionView {
  const { transcriptTargetId, ...view } = row;
  return {
    ...view,
    transcriptTargetId: transcriptTargetId,
    productIcon: getNativeCliProviderAdapter(row.provider).productIcon,
    pendingApprovalCount,
    approvalOwnership: 'provider-owned',
    outputSnapshot: live ? live.outputBuffer.snapshot() : row.outputSnapshot
  };
}

function nativeAgentMcpToolError(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return record.event === 'native_agent_mcp_tool_error' ? record : null;
  } catch {
    return null;
  }
}

export class NativeCliHost {
  private readonly log = createLogger('native-cli');

  private readonly live = new Map<string, LiveNativeCliSession>();
  private readonly observationListeners = new Map<string, Set<NativeCliObservationListener>>();
  private readonly observationFlush = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per-session `outputSeq` already delivered to the observation stream, so the next tick emits only
   *  the delta beyond it. Seeded to the buffer position when the first listener subscribes. */
  private readonly observationEmitted = new Map<string, number>();
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

  /** Notify live observers of the current output snapshot. Non-terminal pushes are coalesced to one
   *  per OBSERVATION_THROTTLE_MS (the trailing fire reads the latest full buffer, so no update is
   *  lost); a `done` push fires immediately and cancels any pending timer. */
  private publishObservation(id: string, done = false): void {
    if (done) {
      this.clearObservationFlush(id);
      this.emitObservation(id, true);
      return;
    }
    if (!this.observationListeners.get(id)?.size) return;
    if (this.observationFlush.has(id)) return; // an update is already scheduled; it reads the latest buffer
    this.observationFlush.set(
      id,
      setTimeout(() => {
        this.observationFlush.delete(id);
        this.emitObservation(id, false);
      }, OBSERVATION_THROTTLE_MS)
    );
  }

  /** Push an observation update to live listeners. Between snapshots this sends only the delta since
   *  the last tick (`append` + cursor `seq`), not the whole 256 KB buffer — the consumer accumulates.
   *  If a listener fell so far behind that the delta is no longer wholly in the bounded tail, it falls
   *  back to a full snapshot (resync). The terminal `done` push always fires so the stream can close. */
  private emitObservation(id: string, done: boolean): void {
    const listeners = this.observationListeners.get(id);
    if (!listeners?.size) return;
    const live = this.live.get(id);
    if (!live) {
      const access = this.observe(id);
      for (const listener of listeners) listener(access, done);
      if (done) {
        this.observationListeners.delete(id);
        this.observationEmitted.delete(id);
      }
      return;
    }
    const emitted = this.observationEmitted.get(id) ?? live.outputSeq;
    const deltaLen = live.outputSeq - emitted;
    if (deltaLen <= 0 && !done) return; // nothing new since the last tick
    const snapshot = live.outputBuffer.snapshot();
    const access: NativeCliObservationAccessResponse =
      deltaLen > 0 && deltaLen <= snapshot.length
        ? {
            state: 'live',
            nativeCliSessionId: id,
            provider: live.provider,
            append: snapshot.slice(snapshot.length - deltaLen),
            seq: live.outputSeq,
            observedAt: new Date().toISOString()
          }
        : {
            state: 'live',
            nativeCliSessionId: id,
            provider: live.provider,
            output: snapshot,
            seq: live.outputSeq,
            observedAt: new Date().toISOString()
          };
    this.observationEmitted.set(id, live.outputSeq);
    for (const listener of listeners) listener(access, done);
    if (done) {
      this.observationListeners.delete(id);
      this.observationEmitted.delete(id);
    }
  }

  private clearObservationFlush(id: string): void {
    const timer = this.observationFlush.get(id);
    if (timer) {
      clearTimeout(timer);
      this.observationFlush.delete(id);
    }
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
  }): Promise<NativeCliSessionView> {
    const runtimeAgentName = args.agentName;
    const agent = await this.requireAgent(args.templateAgentName ?? args.agentName);
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
    const managed =
      runtimeRole === 'managed-project-agent'
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
            baseEnvPath: Bun.env.PATH
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
      (args.launchMode ?? agent.defaultLaunchMode) === 'app-server' &&
      (args.appServerTransport ?? agent.appServerTransport) === 'unix';
    const appServerSocketPath = wantsUnixAppServer ? this.allocateAppServerSocketPath(id) : undefined;
    try {
      launch = resolveNativeCliLaunchCommand(
        adapter,
        buildNativeCliLaunch(agent, {
          workingPath,
          extraWorkingPaths: managed ? [managed.workspace] : undefined,
          launchMode: args.launchMode,
          appServerTransport: args.appServerTransport,
          appServerSocketPath,
          systemPromptFile: adapter.managedRuntime?.usesSystemPromptFile
            ? (managed?.promptFile ?? undefined)
            : undefined,
          skipProviderApprovals: !!managed,
          providerSessionRef: args.providerSessionRef,
          modelName: args.modelName,
          reasoningEffort: args.reasoningEffort,
          speed: args.speed,
          modelId: args.modelId,
          mcpConfigArgs: managed?.mcpConfigArgs
        })
      );
    } catch (error) {
      if (managed) cleanupManagedProjectRuntimeToken(managed.workspace);
      const failedAt = new Date().toISOString();
      this.deps.store.upsertNativeCliSession({
        id,
        transcriptTargetId: args.transcriptTargetId,
        agentName: runtimeAgentName,
        provider: agent.provider,
        workingPath,
        launchMode: args.launchMode ?? agent.defaultLaunchMode,
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
    const spawnEnv = await this.buildSpawnEnv(launch.env);
    // ws/unix app-server: codex listens on a socket and speaks the protocol over it, so the daemon
    // ignores stdin and treats stdout/stderr as logs (for ws, stderr also carries the listen port).
    const isAppServerWs = launch.launchMode === 'app-server' && launch.appServerTransport === 'ws';
    const isAppServerUnix = launch.launchMode === 'app-server' && launch.appServerTransport === 'unix';
    const isAppServerSocket = isAppServerWs || isAppServerUnix;
    try {
      proc =
        launch.launchMode === 'pty'
          ? (Bun.spawn(launch.argv, {
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
            } as Bun.SpawnOptions.OptionsObject<'ignore', 'ignore', 'ignore'>) as NativeCliProcess)
          : (Bun.spawn(launch.argv, {
              cwd: launch.cwd,
              env: spawnEnv,
              detached: true,
              stdin: isAppServerSocket ? 'ignore' : 'pipe',
              stdout: 'pipe',
              stderr: 'pipe'
            }) as NativeCliProcess);
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
      modelId: args.modelId
    };
    live.initializeContext = initializeContext;
    if (isAppServerSocket) {
      // Protocol travels over a socket (ws: an announced loopback port; unix: the path we allocated),
      // exposed as `live.appServer` so initialize/turn/approval frames go over it. The child's
      // stdout/stderr are only logs here — drained so their pipe buffers can't fill and stall codex,
      // but stderr only AFTER the ws leg parses the announced port from it.
      this.drainStream(proc.stdout);
      const onMessage = (text: string): void => this.output(args.transcriptTargetId, id, text, 'app-server', adapter);
      const onClose = (): void => this.handleAppServerDisconnect(id);
      try {
        if (isAppServerUnix) {
          const socketPath = appServerSocketPath ?? '';
          live.appServer = await connectAppServerUnix({
            socketPath,
            onMessage,
            onClose,
            timeoutMs: APP_SERVER_STARTUP_TIMEOUT_MS
          });
          live.appServerRedial = () =>
            connectAppServerUnix({ socketPath, onMessage, onClose, timeoutMs: APP_SERVER_STARTUP_TIMEOUT_MS });
        } else {
          live.appServer = await connectAppServerWs({
            stderr: proc.stderr,
            onMessage,
            onClose,
            timeoutMs: APP_SERVER_STARTUP_TIMEOUT_MS,
            onPort: (port) => {
              live.appServerRedial = () =>
                dialAppServerWs(port, { onMessage, onClose, timeoutMs: APP_SERVER_STARTUP_TIMEOUT_MS });
            }
          });
        }
        this.drainStream(proc.stderr);
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
      this.publishObservation(id, true);
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
    const cliOutput = await this.providerHistoryOutputViaCli(row, adapter).catch(() => null);
    if (cliOutput) {
      return {
        state: 'history',
        nativeCliSessionId: id,
        provider: row.provider,
        output: cliOutput,
        observedAt: row.updatedAt
      };
    }
    const localOutput = await this.providerHistoryOutputFromLocal(row, adapter);
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

  private async providerHistoryOutputFromLocal(
    row: NativeCliSessionRow,
    adapter: NativeCliProviderAdapter
  ): Promise<string | null> {
    if (!row.providerSessionRef) return null;
    return (
      (await adapter.historyOutput?.({
        providerSessionRef: row.providerSessionRef,
        workingPath: row.workingPath,
        limitBytes: MAX_OUTPUT_SNAPSHOT
      })) ?? null
    );
  }

  private async providerHistoryOutputViaCli(
    row: NativeCliSessionRow,
    adapter: NativeCliProviderAdapter
  ): Promise<string | null> {
    const providerSessionRef = row.providerSessionRef ?? undefined;
    const historyPageOutput = adapter.historyPageOutput;
    if (!providerSessionRef || !adapter.requestHistoryPage || !historyPageOutput) return null;
    const agent = (await this.deps.agents()).find(
      (candidate) => candidate.enabled && (candidate.name === row.agentName || candidate.provider === row.provider)
    );
    if (!agent) return null;
    const launch = resolveNativeCliLaunchCommand(
      adapter,
      buildNativeCliLaunch(agent, {
        workingPath: row.workingPath,
        launchMode: 'app-server',
        providerSessionRef
      })
    );
    if (launch.launchMode !== 'app-server') return null;
    const spawnEnv = await this.buildSpawnEnv(launch.env);
    const proc = Bun.spawn(launch.argv, {
      cwd: launch.cwd,
      env: spawnEnv,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    }) as NativeCliProcess;
    let requestSeq = 0;
    let settled = false;
    let expectedResponseId: string | null = null;
    const historyId = `history:${row.id}:${Date.now()}`;
    const decoder = createStreamingTextDecoder();
    const handle = {
      launchMode: 'app-server' as const,
      appServer: connectAppServerStdio(proc.stdin),
      providerSessionRef,
      pendingRequests: new Map<string | number, string>(),
      nextRequestId: () => requestSeq++,
      kill: (signal?: NodeJS.Signals) => killNativeCliProcess(proc.pid, signal)
    };
    return await new Promise<string | null>((resolve) => {
      const finish = (output: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.structuredOutputBuffers.delete(historyId);
        try {
          void proc.stdin?.end?.();
        } catch {}
        killNativeCliProcess(proc.pid);
        resolve(output);
      };
      const timeout = setTimeout(() => finish(null), HISTORY_BACKFILL_TIMEOUT_MS);
      void (async () => {
        try {
          for await (const data of proc.stdout ?? []) {
            const text = decoder.decode(data);
            if (!text) continue;
            const structured = this.takeCompleteStructuredLines(historyId, 'stdout', text);
            if (!structured) continue;
            for (const event of adapter.parseOutput(structured, handle)) {
              const parsed = nativeCliOutputEventSchema.safeParse(event);
              if (!parsed.success || parsed.data.type !== 'history_page') continue;
              if (expectedResponseId && String(parsed.data.payload.responseId) !== expectedResponseId) continue;
              const output = historyPageOutput({
                providerSessionRef,
                workingPath: row.workingPath,
                limitBytes: MAX_OUTPUT_SNAPSHOT,
                page: {
                  items: Array.isArray(parsed.data.payload.items) ? parsed.data.payload.items : [],
                  nextCursor:
                    typeof parsed.data.payload.nextCursor === 'string' ? parsed.data.payload.nextCursor : null,
                  backwardsCursor:
                    typeof parsed.data.payload.backwardsCursor === 'string' ? parsed.data.payload.backwardsCursor : null
                }
              });
              finish(output ?? null);
              return;
            }
          }
          const remaining = decoder.flush();
          if (remaining) this.takeCompleteStructuredLines(historyId, 'stdout', remaining);
          finish(null);
        } catch {
          finish(null);
        }
      })();
      void (async () => {
        try {
          for await (const _ of proc.stderr ?? []) {
          }
        } catch {}
      })();
      try {
        adapter.initialize?.(handle, { workingPath: row.workingPath, providerSessionRef });
        const requestHistoryPage = adapter.requestHistoryPage;
        if (!requestHistoryPage) {
          finish(null);
          return;
        }
        expectedResponseId = String(
          requestHistoryPage(handle, { limit: 20, sortDirection: 'desc', itemsView: 'full' })
        );
      } catch {
        finish(null);
      }
    });
  }

  subscribeObservation(
    id: string,
    listener: NativeCliObservationListener,
    afterSeq?: number
  ): { access: NativeCliObservationAccessResponse; live: boolean; dispose: () => void } {
    const access = this.observe(id, afterSeq);
    if (access.state !== 'live') return { access, live: false, dispose: () => {} };
    let listeners = this.observationListeners.get(id);
    if (!listeners) {
      listeners = new Set();
      this.observationListeners.set(id, listeners);
      // Seed the delta cursor at this subscriber's snapshot position; a later subscriber gets a fresh
      // full snapshot and its client trims any overlap with the shared delta stream.
      this.observationEmitted.set(id, this.live.get(id)?.outputSeq ?? 0);
    }
    listeners.add(listener);
    return {
      access,
      live: true,
      dispose: () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          this.observationListeners.delete(id);
          this.observationEmitted.delete(id);
          this.clearObservationFlush(id);
        }
      }
    };
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
      if (current.startup) {
        clearTimeout(current.startup.timeout);
        current.startup.reject(new Error(`native CLI app-server socket dropped before ready: ${id}`));
        current.startup = undefined;
        this.stop(id);
        return;
      }
      if (current.appServerRedial) {
        void this.reconnectAppServer(id);
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
      this.publishObservation(id);
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
      if (live?.runtimeRole === 'managed-project-agent') {
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

function nativeCliApprovalText(event: NativeCliOutputEvent): string {
  const action = typeof event.payload.action === 'string' ? event.payload.action : undefined;
  const command = typeof event.payload.command === 'string' ? event.payload.command : undefined;
  const reason = typeof event.payload.reason === 'string' ? event.payload.reason : undefined;
  const kind = typeof event.payload.kind === 'string' ? event.payload.kind : 'approval';
  if (action) return action;
  if (command && reason) return `${kind}: ${command} (${reason})`;
  if (command) return `${kind}: ${command}`;
  if (reason) return `${kind}: ${reason}`;
  return kind;
}
