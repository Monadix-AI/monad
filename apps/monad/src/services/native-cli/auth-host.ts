import type {
  NativeCliAgentView,
  NativeCliAuthSessionView,
  NativeCliAuthState,
  NativeCliAuthStatusResponse,
  NativeCliInputRequest,
  NativeCliResizeRequest,
  NativeCliSessionView,
  NativeCliUsageResponse
} from '@monad/protocol';
import type { NativeCliProcess, NativeCliTerminal } from '@/services/native-cli/runtime-types.ts';
import type { ResolveAgentEnv } from '@/services/native-cli/spawn-support.ts';
import type { NativeCliProviderAdapter, NativeCliStartPreflight } from '@/services/native-cli/types.ts';

import { randomBytes } from 'node:crypto';
import { createLogger } from '@monad/logger';
import { newId } from '@monad/protocol';

import { daemonChildProcesses } from '@/infra/daemon-child-processes.ts';
import {
  AUTH_RUNNING_TTL_MS,
  AUTH_STATUS_TIMEOUT_MS,
  AUTH_TERMINAL_TTL_MS,
  DEFAULT_AUTH_HEARTBEAT_TIMEOUT_MS,
  MAX_OUTPUT_SNAPSHOT
} from '@/services/native-cli/constants.ts';
import { NativeCliError } from '@/services/native-cli/errors.ts';
import {
  buildNativeCliAuthLaunch,
  getNativeCliProviderAdapter,
  resolveNativeCliLaunchCommand
} from '@/services/native-cli/index.ts';
import { appendBounded, collectProbeResult } from '@/services/native-cli/probe.ts';
import { killNativeCliProcess, readProcessRegistry, writeProcessRegistry } from '@/services/native-cli/process.ts';
import { buildNativeCliSpawnEnv, requireNativeCliAgent } from '@/services/native-cli/spawn-support.ts';
import { createStreamingTextDecoder } from '@/services/native-cli/stream-decoder.ts';

export type NativeCliAuthListener = (session: NativeCliAuthSessionView) => void;

interface LiveNativeCliAuthSession {
  id: string;
  controlToken: string;
  agentName: string;
  provider: NativeCliAgentView['provider'];
  proc?: NativeCliProcess;
  terminal?: NativeCliTerminal;
  adapter: NativeCliProviderAdapter;
  authState: NativeCliAuthState;
  outputSnapshot: string;
  state: NativeCliSessionView['state'];
  pid: number;
  startedAtMs: number;
  updatedAtMs: number;
  lastSeenAtMs: number;
  exitCode: number | null;
  startedAt: string;
  updatedAt: string;
  exitedAt: string | null;
  kill(signal?: NodeJS.Signals): void;
}

/** Just what the auth host reads from the daemon config — a structural subset of NativeCliHostDeps, so
 *  the host can construct it by passing its full deps object. Auth sessions are in-memory only (no
 *  store, no event bus): a provider login is transient and never persisted. */
export interface NativeCliAuthHostDeps {
  agents: () => Promise<NativeCliAgentView[]>;
  resolveAgentEnv?: ResolveAgentEnv;
  authProcessRegistryPath?: string;
  authHeartbeatTimeoutMs?: number;
}

function authToView(session: LiveNativeCliAuthSession): NativeCliAuthSessionView {
  return {
    id: session.id,
    controlToken: session.controlToken,
    agentName: session.agentName,
    provider: session.provider,
    productIcon: getNativeCliProviderAdapter(session.provider).productIcon,
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

function newAuthControlToken(): string {
  return randomBytes(32).toString('hex');
}

/** Owns the provider-login (auth) session lifecycle: spawning the interactive `<cli> login` pty,
 *  streaming its output to subscribers, and the one-shot auth-status / usage probes. Kept separate
 *  from the interactive-session host — it shares no state with it (no `live` map, no store, no bus). */
export class NativeCliAuthHost {
  private readonly log = createLogger('native-cli');
  private readonly liveAuth = new Map<string, LiveNativeCliAuthSession>();
  private readonly authListeners = new Map<string, Set<NativeCliAuthListener>>();
  /** Serializes read-modify-write access to the auth process registry file: the reads/writes are
   *  async (never block the event loop), so overlapping track/untrack calls are chained onto this
   *  promise instead of racing each other and losing an update. */
  private registryQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: NativeCliAuthHostDeps) {}

  private requireAgent(name: string): Promise<NativeCliAgentView> {
    return requireNativeCliAgent(this.deps.agents, name);
  }

  private buildSpawnEnv(launchEnv?: Record<string, string>): Promise<Record<string, string>> {
    return buildNativeCliSpawnEnv(this.deps.resolveAgentEnv, launchEnv);
  }

  /** Returns the queued registry write so the initial start path can await durability before
   *  reporting success — best-effort either way, callers that don't care can ignore the promise. */
  private trackAuthProcess(pid: number): Promise<void> {
    daemonChildProcesses.track(pid, 'native-cli-auth', () => killNativeCliProcess(pid));
    this.registryQueue = this.registryQueue
      .then(() => readProcessRegistry(this.deps.authProcessRegistryPath))
      .then((pids) => writeProcessRegistry(this.deps.authProcessRegistryPath, [...new Set([...pids, pid])]))
      .catch(() => {
        /* best-effort registry write — never blocks or breaks the queue for later calls */
      });
    return this.registryQueue;
  }

  private untrackAuthProcess(pid: number): void {
    daemonChildProcesses.untrack(pid);
    this.registryQueue = this.registryQueue
      .then(() => readProcessRegistry(this.deps.authProcessRegistryPath))
      .then((pids) =>
        writeProcessRegistry(
          this.deps.authProcessRegistryPath,
          pids.filter((candidate) => candidate !== pid)
        )
      )
      .catch(() => {
        /* best-effort registry write — never blocks or breaks the queue for later calls */
      });
  }

  private publishAuth(live: LiveNativeCliAuthSession): void {
    const listeners = this.authListeners.get(live.id);
    if (!listeners?.size) return;
    const session = authToView(live);
    for (const listener of listeners) listener(session);
  }

  async startAuth(agentName: string): Promise<NativeCliAuthSessionView> {
    this.pruneAuthSessions();
    const agent = await this.requireAgent(agentName);
    const adapter = getNativeCliProviderAdapter(agent.provider);
    const preflight = await this.authStatus(agent.name).catch(() => null);
    for (const live of [...this.liveAuth.values()]) {
      if (live.agentName === agent.name && live.state === 'running') this.stopAuth(live.id, live.controlToken);
    }
    if (preflight?.state === 'authenticated') {
      const id = newId('ncliauth');
      const now = new Date().toISOString();
      const live: LiveNativeCliAuthSession = {
        id,
        controlToken: newAuthControlToken(),
        agentName: agent.name,
        provider: agent.provider,
        adapter,
        authState: 'authenticated',
        outputSnapshot: preflight.output,
        state: 'exited',
        pid: 0,
        startedAtMs: Date.now(),
        updatedAtMs: Date.now(),
        lastSeenAtMs: Date.now(),
        exitCode: 0,
        startedAt: now,
        updatedAt: now,
        exitedAt: now,
        kill: () => {}
      };
      this.liveAuth.set(id, live);
      return authToView(live);
    }
    const launch = resolveNativeCliLaunchCommand(adapter, buildNativeCliAuthLaunch(agent));
    const id = newId('ncliauth');
    const now = new Date().toISOString();
    const decoder = createStreamingTextDecoder();
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
          this.publishAuth(live);
        }
      }
    } as Bun.SpawnOptions.OptionsObject<'ignore', 'ignore', 'ignore'>) as NativeCliProcess;

    const live: LiveNativeCliAuthSession = {
      id,
      controlToken: newAuthControlToken(),
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
      lastSeenAtMs: Date.now(),
      exitCode: null,
      startedAt: now,
      updatedAt: now,
      exitedAt: null,
      kill: (signal) => killNativeCliProcess(proc.pid, signal)
    };
    this.liveAuth.set(id, live);
    // Awaited so the durable process registry is on disk before reporting the auth session as
    // started (crash-safety: a daemon restart right after this point can still find and reap it).
    await this.trackAuthProcess(proc.pid);
    void proc.exited.then((code) => {
      const current = this.liveAuth.get(id);
      if (!current) return;
      let remainingText = decoder.flush();
      if (pendingCR) remainingText = `\r${remainingText}`;
      pendingCR = remainingText.endsWith('\r');
      if (pendingCR) remainingText = remainingText.slice(0, -1);
      remainingText = remainingText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (remainingText)
        current.outputSnapshot = appendBounded(current.outputSnapshot, remainingText, MAX_OUTPUT_SNAPSHOT);
      if (pendingCR) current.outputSnapshot = appendBounded(current.outputSnapshot, '\n', MAX_OUTPUT_SNAPSHOT);
      if (current.state !== 'stopped') current.state = code === 0 ? 'exited' : 'failed';
      current.authState = current.adapter.parseAuthStatus(current.outputSnapshot, code);
      current.exitCode = code;
      current.updatedAt = new Date().toISOString();
      current.updatedAtMs = Date.now();
      current.exitedAt = current.updatedAt;
      this.untrackAuthProcess(current.pid);
      this.publishAuth(current);
    });
    return authToView(live);
  }

  private requireAuthSession(id: string, controlToken: string): LiveNativeCliAuthSession {
    this.pruneAuthSessions();
    const live = this.liveAuth.get(id);
    if (!live) throw new Error(`native CLI auth session not found: ${id}`);
    if (live.controlToken !== controlToken) throw new Error(`native CLI auth session not found: ${id}`);
    return live;
  }

  getAuth(id: string, controlToken: string): NativeCliAuthSessionView {
    const live = this.requireAuthSession(id, controlToken);
    return authToView(live);
  }

  subscribeAuth(
    id: string,
    controlToken: string,
    listener: NativeCliAuthListener
  ): { session: NativeCliAuthSessionView; dispose: () => void } {
    const live = this.requireAuthSession(id, controlToken);
    let listeners = this.authListeners.get(id);
    if (!listeners) {
      listeners = new Set();
      this.authListeners.set(id, listeners);
    }
    listeners.add(listener);
    return {
      session: authToView(live),
      dispose: () => {
        listeners.delete(listener);
        if (listeners.size === 0) this.authListeners.delete(id);
      }
    };
  }

  inputAuth(id: string, controlToken: string, req: NativeCliInputRequest): void {
    const live = this.requireAuthSession(id, controlToken);
    if (live.state !== 'running') throw new Error(`native CLI auth session is not running: ${id}`);
    live.terminal?.write(req.input);
  }

  resizeAuth(id: string, controlToken: string, req: NativeCliResizeRequest): void {
    const live = this.requireAuthSession(id, controlToken);
    if (live.state !== 'running') throw new Error(`native CLI auth session is not running: ${id}`);
    live.terminal?.resize(req.cols, req.rows);
  }

  heartbeatAuth(id: string, controlToken: string): void {
    const live = this.requireAuthSession(id, controlToken);
    if (live.state !== 'running') return;
    live.lastSeenAtMs = Date.now();
    live.updatedAt = new Date(live.lastSeenAtMs).toISOString();
    live.updatedAtMs = live.lastSeenAtMs;
  }

  stopAuth(id: string, controlToken: string): void {
    const live = this.requireAuthSession(id, controlToken);
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
    this.publishAuth(live);
  }

  async authStatus(agentName: string): Promise<NativeCliAuthStatusResponse> {
    this.pruneAuthSessions();
    const agent = await this.requireAgent(agentName);
    const adapter = getNativeCliProviderAdapter(agent.provider);
    const statusProbe = adapter.authStatus(agent);
    const launch = resolveNativeCliLaunchCommand(adapter, statusProbe.launch);
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
    const result = await collectProbeResult(proc, AUTH_STATUS_TIMEOUT_MS, MAX_OUTPUT_SNAPSHOT);
    if (result.timedOut) {
      this.log.warn(
        {
          event: 'native_cli.auth_status_timeout',
          agentName: agent.name,
          provider: agent.provider,
          argv: launch.argv,
          cwd: launch.cwd,
          timeoutMs: AUTH_STATUS_TIMEOUT_MS,
          output: result.output
        },
        'native cli auth status probe timed out'
      );
      throw new NativeCliError('provider_timeout', `timed out checking native CLI auth status: ${agent.name}`);
    }
    const state = statusProbe.parse(result.output, result.code);
    this.log.debug(
      {
        event: 'native_cli.auth_status_result',
        agentName: agent.name,
        provider: agent.provider,
        exitCode: result.code,
        state,
        output: result.output
      },
      'native cli auth status probe result'
    );
    return {
      agentName: agent.name,
      provider: agent.provider,
      state,
      output: result.output,
      checkedAt: new Date().toISOString()
    };
  }

  async usage(agentName: string): Promise<NativeCliUsageResponse> {
    const agent = await this.requireAgent(agentName);
    const adapter = getNativeCliProviderAdapter(agent.provider);
    const checkedAt = new Date().toISOString();
    const usageProbe = adapter.usage?.(agent);
    if (!usageProbe) {
      return {
        agentName: agent.name,
        provider: agent.provider,
        checkedAt,
        records: []
      };
    }
    const launch = resolveNativeCliLaunchCommand(adapter, usageProbe.launch);
    this.log.debug(
      {
        event: 'native_cli.usage',
        agentName: agent.name,
        provider: agent.provider,
        argv: launch.argv,
        cwd: launch.cwd
      },
      'native cli usage probe'
    );
    const proc = Bun.spawn(launch.argv, {
      cwd: launch.cwd,
      env: await this.buildSpawnEnv(launch.env),
      detached: true,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    });
    const result = await collectProbeResult(proc, AUTH_STATUS_TIMEOUT_MS, MAX_OUTPUT_SNAPSHOT);
    if (result.timedOut) {
      this.log.warn(
        {
          event: 'native_cli.usage_timeout',
          agentName: agent.name,
          provider: agent.provider,
          argv: launch.argv,
          cwd: launch.cwd,
          timeoutMs: AUTH_STATUS_TIMEOUT_MS,
          output: result.output
        },
        'native cli usage probe timed out'
      );
      throw new NativeCliError('provider_timeout', `timed out checking native CLI usage: ${agent.name}`);
    }
    const records = usageProbe.parse(result.output, result.code);
    this.log.debug(
      {
        event: 'native_cli.usage_result',
        agentName: agent.name,
        provider: agent.provider,
        exitCode: result.code,
        recordCount: records.length
      },
      'native cli usage probe result'
    );
    return {
      agentName: agent.name,
      provider: agent.provider,
      checkedAt: new Date().toISOString(),
      records
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
    const heartbeatTimeoutMs = this.deps.authHeartbeatTimeoutMs ?? DEFAULT_AUTH_HEARTBEAT_TIMEOUT_MS;
    for (const [id, live] of this.liveAuth) {
      if (
        live.state === 'running' &&
        (nowMs - live.lastSeenAtMs > heartbeatTimeoutMs || nowMs - live.startedAtMs > AUTH_RUNNING_TTL_MS)
      ) {
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
        this.publishAuth(live);
      }
      if (live.state !== 'running' && nowMs - live.updatedAtMs > AUTH_TERMINAL_TTL_MS) {
        this.liveAuth.delete(id);
        this.authListeners.delete(id);
      }
    }
  }
}
