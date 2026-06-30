import type {
  Event,
  ListNativeCliSessionsResponse,
  NativeCliAgentView,
  NativeCliApprovalResolutionRequest,
  NativeCliAuthSessionView,
  NativeCliAuthState,
  NativeCliAuthStatusResponse,
  NativeCliHistoryPageRequest,
  NativeCliHistoryPageResponse,
  NativeCliInputRequest,
  NativeCliLaunchMode,
  NativeCliResizeRequest,
  NativeCliSessionView,
  SessionId
} from '@monad/protocol';
import type { EventBus } from '@/services/event-bus.ts';
import type { StructuredLineBufferState } from '@/services/native-cli/structured-lines.ts';
import type {
  NativeCliLaunchSpec,
  NativeCliOutputEvent,
  NativeCliProviderAdapter,
  NativeCliStartPreflight
} from '@/services/native-cli/types.ts';
import type { NativeCliSessionRow, Store } from '@/store/db/index.ts';

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { createLogger } from '@monad/logger';
import { newId } from '@monad/protocol';

import { mergeNativeCliChildEnv } from '@/services/native-cli/env.ts';
import { NativeCliError } from '@/services/native-cli/errors.ts';
import {
  buildNativeCliAuthLaunch,
  buildNativeCliAuthStatusLaunch,
  buildNativeCliLaunch,
  getNativeCliProviderAdapter,
  resolveNativeCliLaunchCommand
} from '@/services/native-cli/index.ts';
import { killNativeCliProcess } from '@/services/native-cli/process.ts';
import { takeCompleteStructuredLines } from '@/services/native-cli/structured-lines.ts';
import { nativeCliOutputEventSchema } from '@/services/native-cli/types.ts';

interface NativeCliTerminal {
  write(input: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface NativeCliStdin {
  write(input: string): void;
  flush?(): void | Promise<void>;
  end?(): void | Promise<void>;
}

type NativeCliProcess = ReturnType<typeof Bun.spawn> & {
  terminal?: NativeCliTerminal;
  stdin?: NativeCliStdin;
  stdout?: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
};

interface LiveNativeCliSession {
  id: string;
  projectSessionId: SessionId;
  agentName: string;
  provider: NativeCliAgentView['provider'];
  proc: NativeCliProcess;
  adapter: NativeCliProviderAdapter;
  launchMode: NativeCliLaunchMode;
  terminal?: NativeCliTerminal;
  stdin?: NativeCliStdin;
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
  /** In-memory bounded output snapshot, flushed to SQLite on a timer (see scheduleSnapshotFlush)
   *  instead of read-modify-writing the 256 KB column on every output chunk. */
  outputBuffer: string;
  snapshotFlushTimer: Timer | null;
  nextRequestId(): number;
  kill(signal?: NodeJS.Signals): void;
}

interface LiveNativeCliAuthSession {
  id: string;
  agentName: string;
  provider: NativeCliAgentView['provider'];
  proc: NativeCliProcess;
  terminal?: NativeCliTerminal;
  adapter: NativeCliProviderAdapter;
  authState: NativeCliAuthState;
  outputSnapshot: string;
  state: NativeCliSessionView['state'];
  pid: number;
  startedAtMs: number;
  updatedAtMs: number;
  exitCode: number | null;
  startedAt: string;
  updatedAt: string;
  exitedAt: string | null;
  kill(signal?: NodeJS.Signals): void;
}

export interface NativeCliHostDeps {
  store: Store;
  bus: EventBus;
  agents: () => Promise<NativeCliAgentView[]>;
  /** Resolve `${env:}`/`${secret:}` refs in an agent's env against fresh auth before spawn. When
   *  absent (tests) the env is used verbatim. */
  resolveAgentEnv?: (env?: Record<string, string>) => Promise<Record<string, string> | undefined>;
  nativeCliProcessRegistryPath?: string;
  authProcessRegistryPath?: string;
}

const MAX_OUTPUT_SNAPSHOT = 256 * 1024;
const SNAPSHOT_FLUSH_MS = 200;
const MAX_STRUCTURED_LINE = 2 * 1024 * 1024;
const AUTH_RUNNING_TTL_MS = 30 * 60 * 1000;
const AUTH_TERMINAL_TTL_MS = 10 * 60 * 1000;
const HISTORY_PAGE_TIMEOUT_MS = 5_000;
const AUTH_STATUS_TIMEOUT_MS = 2_000;
type NativeCliOutputStream = 'stdout' | 'stderr' | 'pty';

function toView(row: NativeCliSessionRow): NativeCliSessionView {
  return {
    ...row,
    projectSessionId: row.projectSessionId,
    approvalOwnership: 'provider-owned'
  };
}

function authToView(session: LiveNativeCliAuthSession): NativeCliAuthSessionView {
  return {
    id: session.id,
    agentName: session.agentName,
    provider: session.provider,
    approvalOwnership: 'provider-owned',
    authState: session.authState,
    state: session.state,
    pid: session.pid,
    outputSnapshot: session.outputSnapshot,
    exitCode: session.exitCode,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    exitedAt: session.exitedAt
  };
}

function appendBounded(existing: string, chunk: string, max: number): string {
  const next = `${existing}${chunk}`;
  return next.length <= max ? next : next.slice(next.length - max);
}

async function collectText(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!stream) return '';
  const decoder = new TextDecoder();
  let output = '';
  for await (const data of stream) {
    output = appendBounded(output, decoder.decode(data), MAX_OUTPUT_SNAPSHOT);
  }
  return output;
}

function readProcessRegistry(path: string | undefined): number[] {
  if (!path || !existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) =>
        entry && typeof entry === 'object' && typeof (entry as { pid?: unknown }).pid === 'number'
          ? (entry as { pid: number }).pid
          : undefined
      )
      .filter((pid): pid is number => typeof pid === 'number');
  } catch {
    return [];
  }
}

function writeProcessRegistry(path: string | undefined, pids: number[]): void {
  if (!path) return;
  if (pids.length === 0) {
    try {
      unlinkSync(path);
    } catch {
      /* registry already absent */
    }
    return;
  }
  const parent = dirname(path);
  if (existsSync(parent) && !statSync(parent).isDirectory()) return;
  mkdirSync(parent, { recursive: true });
  writeFileSync(path, JSON.stringify(pids.map((pid) => ({ pid }))));
}

export class NativeCliHost {
  private readonly log = createLogger('native-cli');

  private readonly live = new Map<string, LiveNativeCliSession>();
  private readonly liveAuth = new Map<string, LiveNativeCliAuthSession>();
  private readonly structuredOutputBuffers = new Map<
    string,
    Partial<Record<NativeCliOutputStream, StructuredLineBufferState>>
  >();

  constructor(private readonly deps: NativeCliHostDeps) {}

  /** Resolve secret refs in the launch env, then merge with the daemon env (minus nested-session
   *  markers and injection vectors) to form the child CLI's environment. */
  private async buildSpawnEnv(launchEnv?: Record<string, string>): Promise<Record<string, string>> {
    const resolved = this.deps.resolveAgentEnv ? await this.deps.resolveAgentEnv(launchEnv) : launchEnv;
    return mergeNativeCliChildEnv(resolved);
  }

  private async requireAgent(name: string): Promise<NativeCliAgentView> {
    const agent = (await this.deps.agents()).find((candidate) => candidate.name === name && candidate.enabled);
    if (!agent) throw new Error(`native CLI agent not found or disabled: ${name}`);
    return agent;
  }

  reconcileOrphanedSessions(): number {
    const native = this.deps.store.reconcileOrphanedNativeCliSessions((pid) => killNativeCliProcess(pid));
    const orphanedNative = readProcessRegistry(this.deps.nativeCliProcessRegistryPath);
    for (const pid of orphanedNative) killNativeCliProcess(pid);
    writeProcessRegistry(this.deps.nativeCliProcessRegistryPath, []);
    const auth = readProcessRegistry(this.deps.authProcessRegistryPath);
    for (const pid of auth) killNativeCliProcess(pid);
    writeProcessRegistry(this.deps.authProcessRegistryPath, []);
    return native + orphanedNative.length + auth.length;
  }

  private trackNativeCliProcess(pid: number): void {
    writeProcessRegistry(this.deps.nativeCliProcessRegistryPath, [
      ...new Set([...readProcessRegistry(this.deps.nativeCliProcessRegistryPath), pid])
    ]);
  }

  private untrackNativeCliProcess(pid: number): void {
    writeProcessRegistry(
      this.deps.nativeCliProcessRegistryPath,
      readProcessRegistry(this.deps.nativeCliProcessRegistryPath).filter((candidate) => candidate !== pid)
    );
  }

  private trackAuthProcess(pid: number): void {
    writeProcessRegistry(this.deps.authProcessRegistryPath, [
      ...new Set([...readProcessRegistry(this.deps.authProcessRegistryPath), pid])
    ]);
  }

  private untrackAuthProcess(pid: number): void {
    writeProcessRegistry(
      this.deps.authProcessRegistryPath,
      readProcessRegistry(this.deps.authProcessRegistryPath).filter((candidate) => candidate !== pid)
    );
  }

  async start(args: {
    projectSessionId: SessionId;
    agentName: string;
    workingPath: string;
    launchMode?: NativeCliLaunchMode;
    providerSessionRef?: string;
  }): Promise<NativeCliSessionView> {
    const agent = await this.requireAgent(args.agentName);
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

    let pendingCR = false;
    const decoder = new TextDecoder();
    let launch: NativeCliLaunchSpec;
    let proc: NativeCliProcess;
    try {
      launch = resolveNativeCliLaunchCommand(
        adapter,
        buildNativeCliLaunch(agent, {
          workingPath,
          launchMode: args.launchMode,
          providerSessionRef: args.providerSessionRef
        })
      );
    } catch (error) {
      const failedAt = new Date().toISOString();
      this.deps.store.upsertNativeCliSession({
        id,
        projectSessionId: args.projectSessionId,
        agentName: agent.name,
        provider: agent.provider,
        workingPath,
        launchMode: args.launchMode ?? agent.defaultLaunchMode,
        state: 'failed',
        pid: null,
        providerSessionRef: args.providerSessionRef ?? null,
        outputSnapshot: error instanceof Error ? error.message : String(error),
        exitCode: null,
        startedAt: now,
        updatedAt: failedAt,
        exitedAt: failedAt
      });
      this.emit(args.projectSessionId, 'native_cli.exited', {
        nativeCliSessionId: id,
        exitCode: null,
        state: 'failed'
      });
      this.log.error(
        {
          sessionId: args.projectSessionId,
          event: 'native_cli.launch_failed',
          nativeCliSessionId: id,
          agentName: agent.name,
          provider: agent.provider,
          err: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
        },
        'native cli launch failed'
      );
      throw error;
    }
    this.log.debug(
      {
        sessionId: args.projectSessionId,
        event: 'native_cli.launch',
        nativeCliSessionId: id,
        agentName: agent.name,
        provider: agent.provider,
        argv: launch.argv,
        cwd: launch.cwd,
        launchMode: launch.launchMode,
        providerSessionRef: args.providerSessionRef ?? null
      },
      'native cli launch'
    );
    const spawnEnv = await this.buildSpawnEnv(launch.env);
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
                  if (text) this.output(args.projectSessionId, id, text, 'pty', adapter);
                }
              }
            } as Bun.SpawnOptions.OptionsObject<'ignore', 'ignore', 'ignore'>) as NativeCliProcess)
          : (Bun.spawn(launch.argv, {
              cwd: launch.cwd,
              env: spawnEnv,
              detached: true,
              stdin: 'pipe',
              stdout: 'pipe',
              stderr: 'pipe'
            }) as NativeCliProcess);
    } catch (error) {
      const failedAt = new Date().toISOString();
      this.deps.store.upsertNativeCliSession({
        id,
        projectSessionId: args.projectSessionId,
        agentName: agent.name,
        provider: agent.provider,
        workingPath,
        launchMode: launch.launchMode,
        state: 'failed',
        pid: null,
        providerSessionRef: args.providerSessionRef ?? null,
        outputSnapshot: error instanceof Error ? error.message : String(error),
        exitCode: null,
        startedAt: now,
        updatedAt: failedAt,
        exitedAt: failedAt
      });
      this.emit(args.projectSessionId, 'native_cli.exited', {
        nativeCliSessionId: id,
        exitCode: null,
        state: 'failed'
      });
      this.log.error(
        {
          sessionId: args.projectSessionId,
          event: 'native_cli.launch_failed',
          nativeCliSessionId: id,
          agentName: agent.name,
          provider: agent.provider,
          err: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
        },
        'native cli launch failed'
      );
      throw error;
    }

    const row: NativeCliSessionRow = {
      id,
      projectSessionId: args.projectSessionId,
      agentName: agent.name,
      provider: agent.provider,
      workingPath,
      launchMode: launch.launchMode,
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
      projectSessionId: args.projectSessionId,
      agentName: agent.name,
      provider: agent.provider,
      proc,
      adapter,
      launchMode: launch.launchMode,
      terminal: proc.terminal,
      stdin: proc.stdin,
      providerSessionRef: args.providerSessionRef ?? null,
      pendingApprovals: new Map(),
      pendingHistoryPages: new Map(),
      outputBuffer: '',
      snapshotFlushTimer: null,
      nextRequestId: () => requestSeq++,
      kill: (signal) => killNativeCliProcess(proc.pid, signal)
    };
    this.live.set(id, live);
    this.trackNativeCliProcess(proc.pid);
    if (launch.launchMode !== 'pty') {
      this.readPipe(args.projectSessionId, id, proc.stdout, 'stdout', adapter);
      this.readPipe(args.projectSessionId, id, proc.stderr, 'stderr', adapter);
      adapter.initialize?.(live, { workingPath, providerSessionRef: args.providerSessionRef });
    }
    this.emit(args.projectSessionId, 'native_cli.started', {
      nativeCliSessionId: id,
      agentName: agent.name,
      provider: agent.provider,
      launchMode: launch.launchMode,
      workingPath,
      pid: proc.pid
    });
    this.log.debug(
      {
        sessionId: args.projectSessionId,
        event: 'native_cli.started',
        nativeCliSessionId: id,
        agentName: agent.name,
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
      for (const pending of live?.pendingHistoryPages.values() ?? []) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`native CLI session exited before history page response: ${id}`));
      }
      if (pendingCR) this.output(args.projectSessionId, id, '\n', 'pty', adapter);
      this.flushSnapshot(id);
      this.live.delete(id);
      this.untrackNativeCliProcess(proc.pid);
      this.structuredOutputBuffers.delete(id);
      const exitedAt = new Date().toISOString();
      const state = code === 0 ? 'exited' : 'failed';
      this.deps.store.closeNativeCliSession(id, exitedAt, code, state);
      this.emit(args.projectSessionId, 'native_cli.exited', { nativeCliSessionId: id, exitCode: code, state });
      this.log[state === 'failed' ? 'error' : 'debug'](
        {
          sessionId: args.projectSessionId,
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
      { sessionId: live.projectSessionId, event: 'native_cli.input', nativeCliSessionId: id, input: req.input },
      'native cli input'
    );
    live.adapter.sendInput(live, req.input);
  }

  get(id: string): NativeCliSessionView {
    const row = this.deps.store.getNativeCliSession(id);
    if (!row) throw new Error(`native CLI session not found: ${id}`);
    return toView(row);
  }

  list(projectSessionId: SessionId): ListNativeCliSessionsResponse {
    return { sessions: this.deps.store.listNativeCliSessionsForProject(projectSessionId).map(toView) };
  }

  resize(id: string, req: NativeCliResizeRequest): void {
    const live = this.live.get(id);
    if (!live) throw new Error(`native CLI session is not running: ${id}`);
    this.log.debug(
      {
        sessionId: live.projectSessionId,
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
    this.emit(live.projectSessionId, 'native_cli.approval_resolved', {
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
      { sessionId: live.projectSessionId, event: 'native_cli.stop', nativeCliSessionId: id },
      'native cli stop'
    );
    try {
      live.terminal?.close();
      void live.stdin?.end?.();
    } catch {
      /* already closed */
    }
    for (const pending of live.pendingHistoryPages.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`native CLI session stopped before history page response: ${id}`));
    }
    live.pendingHistoryPages.clear();
    live.adapter.stop(live);
    this.flushSnapshot(id);
    this.live.delete(id);
    this.untrackNativeCliProcess(live.proc.pid);
    this.structuredOutputBuffers.delete(id);
    const exitedAt = new Date().toISOString();
    this.deps.store.closeNativeCliSession(id, exitedAt, null, 'stopped');
    this.emit(live.projectSessionId, 'native_cli.exited', { nativeCliSessionId: id, exitCode: null, state: 'stopped' });
  }

  stopProject(projectSessionId: SessionId): void {
    for (const live of [...this.live.values()]) {
      if (live.projectSessionId === projectSessionId) this.stop(live.id);
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

  async startAuth(agentName: string): Promise<NativeCliAuthSessionView> {
    this.pruneAuthSessions();
    const agent = await this.requireAgent(agentName);
    const adapter = getNativeCliProviderAdapter(agent.provider);
    const launch = resolveNativeCliLaunchCommand(adapter, buildNativeCliAuthLaunch(agent));
    const id = newId('ncliauth');
    const now = new Date().toISOString();
    const decoder = new TextDecoder();
    let pendingCR = false;
    let proc: NativeCliProcess;
    proc = Bun.spawn(launch.argv, {
      cwd: launch.cwd,
      env: await this.buildSpawnEnv(launch.env),
      detached: true,
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
      terminal: {
        cols: 100,
        rows: 30,
        data: (_terminal: NativeCliTerminal, data: Uint8Array) => {
          const live = this.liveAuth.get(id);
          if (!live) return;
          let text = decoder.decode(data);
          if (pendingCR) text = `\r${text}`;
          pendingCR = text.endsWith('\r');
          if (pendingCR) text = text.slice(0, -1);
          text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          if (!text) return;
          live.outputSnapshot = appendBounded(live.outputSnapshot, text, MAX_OUTPUT_SNAPSHOT);
          live.updatedAt = new Date().toISOString();
          live.updatedAtMs = Date.now();
        }
      }
    } as Bun.SpawnOptions.OptionsObject<'ignore', 'ignore', 'ignore'>) as NativeCliProcess;

    const live: LiveNativeCliAuthSession = {
      id,
      agentName: agent.name,
      provider: agent.provider,
      proc,
      terminal: proc.terminal,
      adapter,
      authState: 'unknown',
      outputSnapshot: '',
      state: 'running',
      pid: proc.pid,
      startedAtMs: Date.now(),
      updatedAtMs: Date.now(),
      exitCode: null,
      startedAt: now,
      updatedAt: now,
      exitedAt: null,
      kill: (signal) => killNativeCliProcess(proc.pid, signal)
    };
    this.liveAuth.set(id, live);
    this.trackAuthProcess(proc.pid);
    void proc.exited.then((code) => {
      const current = this.liveAuth.get(id);
      if (!current) return;
      if (pendingCR) current.outputSnapshot = appendBounded(current.outputSnapshot, '\n', MAX_OUTPUT_SNAPSHOT);
      if (current.state !== 'stopped') current.state = code === 0 ? 'exited' : 'failed';
      current.authState = current.adapter.parseAuthStatus(current.outputSnapshot, code);
      current.exitCode = code;
      current.updatedAt = new Date().toISOString();
      current.updatedAtMs = Date.now();
      current.exitedAt = current.updatedAt;
      this.untrackAuthProcess(current.pid);
    });
    return authToView(live);
  }

  getAuth(id: string): NativeCliAuthSessionView {
    this.pruneAuthSessions();
    const live = this.liveAuth.get(id);
    if (!live) throw new Error(`native CLI auth session not found: ${id}`);
    return authToView(live);
  }

  inputAuth(id: string, req: NativeCliInputRequest): void {
    this.pruneAuthSessions();
    const live = this.liveAuth.get(id);
    if (!live) throw new Error(`native CLI auth session is not running: ${id}`);
    if (live.state !== 'running') throw new Error(`native CLI auth session is not running: ${id}`);
    live.terminal?.write(req.input);
  }

  resizeAuth(id: string, req: NativeCliResizeRequest): void {
    this.pruneAuthSessions();
    const live = this.liveAuth.get(id);
    if (!live) throw new Error(`native CLI auth session is not running: ${id}`);
    if (live.state !== 'running') throw new Error(`native CLI auth session is not running: ${id}`);
    live.terminal?.resize(req.cols, req.rows);
  }

  stopAuth(id: string): void {
    const live = this.liveAuth.get(id);
    if (!live) return;
    try {
      live.terminal?.close();
    } catch {
      /* already closed */
    }
    live.kill('SIGTERM');
    live.state = 'stopped';
    live.exitCode = null;
    live.updatedAt = new Date().toISOString();
    live.updatedAtMs = Date.now();
    live.exitedAt = live.updatedAt;
    this.untrackAuthProcess(live.pid);
  }

  async authStatus(agentName: string): Promise<NativeCliAuthStatusResponse> {
    this.pruneAuthSessions();
    const agent = await this.requireAgent(agentName);
    const adapter = getNativeCliProviderAdapter(agent.provider);
    const launch = resolveNativeCliLaunchCommand(adapter, buildNativeCliAuthStatusLaunch(agent));
    this.log.debug(
      {
        event: 'native_cli.auth_status',
        agentName: agent.name,
        provider: agent.provider,
        argv: launch.argv,
        cwd: launch.cwd
      },
      'native cli auth status probe'
    );
    const proc = Bun.spawn(launch.argv, {
      cwd: launch.cwd,
      env: await this.buildSpawnEnv(launch.env),
      detached: true,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    });
    const outputPromise = Promise.all([collectText(proc.stdout), collectText(proc.stderr)]).then(([stdout, stderr]) =>
      appendBounded(stdout, stderr, MAX_OUTPUT_SNAPSHOT)
    );
    const timeout = Bun.sleep(AUTH_STATUS_TIMEOUT_MS).then(() => {
      killNativeCliProcess(proc.pid, 'SIGTERM');
      return { timedOut: true as const, code: null };
    });
    const result = await Promise.race([proc.exited.then((code) => ({ timedOut: false as const, code })), timeout]);
    const output = await outputPromise.catch(() => '');
    if (result.timedOut) {
      this.log.warn(
        {
          event: 'native_cli.auth_status_timeout',
          agentName: agent.name,
          provider: agent.provider,
          argv: launch.argv,
          cwd: launch.cwd,
          timeoutMs: AUTH_STATUS_TIMEOUT_MS,
          output
        },
        'native cli auth status probe timed out'
      );
      throw new NativeCliError('provider_timeout', `timed out checking native CLI auth status: ${agent.name}`);
    }
    const state = adapter.parseAuthStatus(output, result.code);
    this.log.debug(
      {
        event: 'native_cli.auth_status_result',
        agentName: agent.name,
        provider: agent.provider,
        exitCode: result.code,
        state,
        output
      },
      'native cli auth status probe result'
    );
    return {
      agentName: agent.name,
      provider: agent.provider,
      state,
      output,
      checkedAt: new Date().toISOString()
    };
  }

  async preflight(agentName: string): Promise<NativeCliStartPreflight> {
    const checkedAt = new Date().toISOString();
    const agent = await this.requireAgent(agentName);
    try {
      const auth = await this.authStatus(agentName);
      if (auth.state === 'authenticated') {
        return { state: 'ready', agentName: agent.name, provider: agent.provider, checkedAt: auth.checkedAt };
      }
      if (auth.state === 'unauthenticated') {
        return {
          state: 'not_authenticated',
          agentName: agent.name,
          provider: agent.provider,
          checkedAt: auth.checkedAt,
          action: 'reconnect_in_studio',
          reason: `Reconnect ${agent.name} in Studio before using it in this project.`
        };
      }
      return {
        state: 'unknown',
        agentName: agent.name,
        provider: agent.provider,
        checkedAt: auth.checkedAt,
        action: 'manual_check_in_studio',
        reason: `Check ${agent.name} connection in Studio before using it in this project.`
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Executable not found|ENOENT/i.test(message)) {
        return {
          state: 'unavailable',
          agentName: agent.name,
          provider: agent.provider,
          checkedAt,
          reason: message
        };
      }
      return {
        state: 'unknown',
        agentName: agent.name,
        provider: agent.provider,
        checkedAt,
        action: 'manual_check_in_studio',
        reason: `Check ${agent.name} connection in Studio before using it in this project.`
      };
    }
  }

  private pruneAuthSessions(nowMs = Date.now()): void {
    for (const [id, live] of this.liveAuth) {
      if (live.state === 'running' && nowMs - live.startedAtMs > AUTH_RUNNING_TTL_MS) {
        try {
          live.terminal?.close();
        } catch {
          /* already closed */
        }
        live.kill('SIGTERM');
        live.state = 'stopped';
        live.exitCode = null;
        live.updatedAt = new Date(nowMs).toISOString();
        live.updatedAtMs = nowMs;
        live.exitedAt = live.updatedAt;
        this.untrackAuthProcess(live.pid);
      }
      if (live.state !== 'running' && nowMs - live.updatedAtMs > AUTH_TERMINAL_TTL_MS) {
        this.liveAuth.delete(id);
      }
    }
  }

  private readPipe(
    projectSessionId: SessionId,
    id: string,
    stream: ReadableStream<Uint8Array> | undefined,
    name: 'stdout' | 'stderr',
    adapter: NativeCliProviderAdapter
  ): void {
    if (!stream) return;
    const decoder = new TextDecoder();
    void (async () => {
      for await (const data of stream) {
        const text = decoder.decode(data);
        if (text) this.output(projectSessionId, id, text, name, adapter);
      }
    })();
  }

  private output(
    projectSessionId: SessionId,
    id: string,
    chunk: string,
    stream: 'stdout' | 'stderr' | 'pty',
    adapter: NativeCliProviderAdapter
  ): void {
    const live = this.live.get(id);
    if (live) {
      // Accumulate in memory and flush the bounded snapshot to SQLite on a timer — avoids a
      // per-chunk 256 KB read-modify-write under a chatty agent.
      live.outputBuffer = appendBounded(live.outputBuffer, chunk, MAX_OUTPUT_SNAPSHOT);
      this.scheduleSnapshotFlush(id);
    } else {
      this.deps.store.appendNativeCliOutput(id, chunk, MAX_OUTPUT_SNAPSHOT);
    }
    this.emit(projectSessionId, 'native_cli.output', { nativeCliSessionId: id, stream, chunk });
    const structuredChunk = stream === 'pty' ? chunk : this.takeCompleteStructuredLines(id, stream, chunk);
    if (!structuredChunk) return;
    for (const event of adapter.parseOutput(structuredChunk)) {
      const parsed = nativeCliOutputEventSchema.safeParse(event);
      if (!parsed.success) continue;
      this.emitStructuredOutputEvent(projectSessionId, id, adapter, parsed.data);
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
    this.deps.store.setNativeCliOutputSnapshot(id, live.outputBuffer, MAX_OUTPUT_SNAPSHOT);
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
    projectSessionId: SessionId,
    id: string,
    adapter: NativeCliProviderAdapter,
    event: NativeCliOutputEvent
  ): void {
    if (event.type === 'session_ref') {
      const providerSessionRef =
        typeof event.payload.providerSessionRef === 'string' ? event.payload.providerSessionRef : undefined;
      if (providerSessionRef) {
        const live = this.live.get(id);
        if (live) live.providerSessionRef = providerSessionRef;
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
      this.emit(projectSessionId, 'native_cli.connection_required', {
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

    if (event.type === 'approval_requested') {
      const requestId =
        typeof event.payload.requestId === 'string' ? event.payload.requestId : String(event.payload.requestId);
      const live = this.live.get(id);
      if (live?.pendingApprovals.has(requestId)) return;
      live?.pendingApprovals.set(requestId, event.payload);
      this.emit(projectSessionId, 'native_cli.approval_requested', {
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
      this.emit(projectSessionId, 'native_cli.approval_resolved', {
        nativeCliSessionId: id,
        provider: adapter.provider,
        requestId,
        allow: event.payload.allow !== false,
        ...(typeof event.payload.reason === 'string' ? { reason: event.payload.reason } : {})
      });
    }
  }

  private emit(sessionId: SessionId, type: Event['type'], payload: Record<string, unknown>): void {
    const event: Event = {
      id: newId('evt'),
      sessionId,
      type,
      actorAgentId: null,
      payload,
      at: new Date().toISOString()
    };
    this.deps.store.appendEvents([event]);
    this.deps.bus.publish(event);
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
