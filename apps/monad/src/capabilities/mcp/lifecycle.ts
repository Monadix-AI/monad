import type { MonadAuth, MonadPaths } from '@monad/environment';
import type { AgentCapabilityRuntime } from '#/capabilities/lifecycle.ts';
import type { McpConnection } from '#/capabilities/tools';
import type { ConfigAccess, ConfigSnapshot } from '#/config/manager.ts';
import type { RuntimeModule } from '#/runtime/types.ts';

import { logger } from '@monad/logger';

import {
  type ConfigMcpHandle,
  type ConfigMcpStatus,
  configMcpSource,
  connectFileMcpServers,
  connectMcpServers,
  createPendingConfigMcpHandle,
  reconnectOneMcpServer,
  reloadConfigMcpServers
} from './service.ts';

export interface McpLifecycleOptions {
  initial: ConfigSnapshot;
  paths: MonadPaths;
  config?: () => ConfigAccess;
}

export interface McpLifecycleDeps {
  connectConfig: typeof connectMcpServers;
  connectFiles: typeof connectFileMcpServers;
  reloadConfig: typeof reloadConfigMcpServers;
  reconnectConfig?: typeof reconnectOneMcpServer;
  retryDelayMs?: (attempt: number) => number;
}

export interface McpRuntime {
  readonly config: ConfigMcpHandle;
  readonly files: readonly McpConnection[];
  ready(): Promise<void>;
  onStatusChange(listener: () => void): () => void;
  replaceConfig(handle: ConfigMcpHandle): void;
  reload(snapshot: ConfigSnapshot): Promise<void>;
  reconnectFiles(auth?: MonadAuth | null): Promise<void>;
  stop(): Promise<void>;
}

const defaultDeps: McpLifecycleDeps = {
  connectConfig: connectMcpServers,
  connectFiles: connectFileMcpServers,
  reloadConfig: reloadConfigMcpServers,
  reconnectConfig: reconnectOneMcpServer
};

const MCP_RETRY_BASE_MS = 1000;
const MCP_RETRY_MAX_MS = 30_000;

class LiveMcpRuntime implements McpRuntime {
  private configHandle: ConfigMcpHandle;
  private fileConnections: McpConnection[] = [];
  private readonly statusListeners = new Set<() => void>();
  private readonly observedConnections = new WeakSet<McpConnection>();
  private operation: Promise<void>;
  private fileReconnectNeeded = false;
  private retryAttempt = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    private readonly paths: MonadPaths,
    private readonly registry: AgentCapabilityRuntime['registry'],
    private readonly configAccess: ConfigAccess,
    initial: ConfigSnapshot,
    private auth: MonadAuth | null,
    private readonly deps: McpLifecycleDeps
  ) {
    this.configHandle = createPendingConfigMcpHandle(initial.cfg);
    this.operation = this.initialize(initial).catch((error) => {
      this.markPendingConfigFailed(error);
      logger.warn(`monad: MCP startup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  get config(): ConfigMcpHandle {
    return this.configHandle;
  }

  get files(): readonly McpConnection[] {
    return this.fileConnections;
  }

  ready(): Promise<void> {
    return this.operation;
  }

  onStatusChange(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  replaceConfig(handle: ConfigMcpHandle): void {
    this.clearRetry();
    this.configHandle = handle;
    this.observeConfigConnections();
    this.notifyStatusChange();
    this.scheduleRetry();
  }

  async reload(snapshot: ConfigSnapshot): Promise<void> {
    await this.operation;
    this.clearRetry();
    const previousSeenHttp = this.configHandle.seenHttp;
    const nextConfig = await this.deps.reloadConfig(
      this.configHandle.connections,
      snapshot.cfg,
      this.paths,
      this.registry,
      snapshot.auth ?? undefined,
      this.configAccess
    );
    this.configHandle = nextConfig;
    this.observeConfigConnections();
    if (!sameAuth(this.auth, snapshot.auth) || !sameSet(previousSeenHttp, nextConfig.seenHttp)) {
      await this.reconnectFiles(snapshot.auth);
    } else {
      this.notifyStatusChange();
    }
    this.auth = snapshot.auth;
    this.scheduleRetry();
  }

  async reconnectFiles(auth?: MonadAuth | null): Promise<void> {
    await this.operation;
    await this.replaceFileConnections(auth);
  }

  private async replaceFileConnections(auth?: MonadAuth | null): Promise<void> {
    await Promise.allSettled(this.fileConnections.map((connection) => connection.close()));
    this.registry.clearToolsFrom('file-mcp');
    this.fileConnections = await this.deps.connectFiles(
      this.paths,
      this.registry,
      auth ?? undefined,
      this.configHandle.seenHttp
    );
    this.fileReconnectNeeded = false;
    this.observeFileConnections();
    this.notifyStatusChange();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearRetry();
    await this.operation;
    const connections = [
      ...[...this.configHandle.connections.values()].map((entry) => entry.conn),
      ...this.fileConnections
    ];
    this.configHandle = { seenHttp: new Set(), connections: new Map(), status: new Map() };
    this.fileConnections = [];
    await Promise.allSettled(connections.map((connection) => connection.close()));
  }

  private async initialize(initial: ConfigSnapshot): Promise<void> {
    const config = await this.deps.connectConfig(
      initial.cfg,
      this.paths,
      this.registry,
      initial.auth ?? undefined,
      this.configAccess
    );
    if (this.stopped) {
      await Promise.allSettled([...config.connections.values()].map((entry) => entry.conn.close()));
      return;
    }
    this.configHandle = config;
    this.observeConfigConnections();
    this.notifyStatusChange();
    this.scheduleRetry();
    const files = await this.deps.connectFiles(this.paths, this.registry, initial.auth ?? undefined, config.seenHttp);
    if (this.stopped) {
      await Promise.allSettled(files.map((connection) => connection.close()));
      return;
    }
    this.fileConnections = files;
    this.observeFileConnections();
    this.auth = initial.auth;
    this.notifyStatusChange();
  }

  private markPendingConfigFailed(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    for (const [name, status] of this.configHandle.status) {
      if (status.state === 'starting') this.configHandle.status.set(name, { state: 'failed', error: message });
    }
    this.notifyStatusChange();
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer || !this.deps.reconnectConfig) return;
    const failed = [...this.configHandle.status].filter(([, status]) => retryableMcpFailure(status));
    if (!failed.length && !this.fileReconnectNeeded) {
      this.retryAttempt = 0;
      return;
    }
    this.retryAttempt += 1;
    const delay = this.deps.retryDelayMs?.(this.retryAttempt) ?? jitteredRetryDelay(this.retryAttempt);
    const nextRetryAt = new Date(Date.now() + delay).toISOString();
    for (const [name, status] of failed) {
      this.configHandle.status.set(name, { ...status, retryAttempt: this.retryAttempt, nextRetryAt });
    }
    this.notifyStatusChange();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.operation = this.operation
        .then(() => this.retryFailed())
        .catch((error) => {
          logger.warn(
            `monad: MCP automatic reconnect failed: ${error instanceof Error ? error.message : String(error)}`
          );
          this.scheduleRetry();
        });
    }, delay);
  }

  private async retryFailed(): Promise<void> {
    if (this.stopped || !this.deps.reconnectConfig) return;
    const names = [...this.configHandle.status]
      .filter(([, status]) => retryableMcpFailure(status))
      .map(([name]) => name);
    for (const name of names) {
      this.configHandle = await this.deps.reconnectConfig(
        name,
        this.configHandle,
        this.configAccess.get().cfg,
        this.paths,
        this.registry,
        this.auth ?? undefined,
        this.configAccess,
        { interactive: false }
      );
      this.observeConfigConnections();
    }
    if (this.fileReconnectNeeded) await this.replaceFileConnections(this.auth);
    this.notifyStatusChange();
    this.scheduleRetry();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryAttempt = 0;
  }

  private notifyStatusChange(): void {
    for (const listener of this.statusListeners) listener();
  }

  private observeConfigConnections(): void {
    for (const [name, entry] of this.configHandle.connections) {
      if (this.observedConnections.has(entry.conn)) continue;
      this.observedConnections.add(entry.conn);
      entry.conn.onDisconnect?.((reason) => {
        if (this.stopped || this.configHandle.connections.get(name)?.conn !== entry.conn) return;
        this.registry.clearToolsFrom(configMcpSource(name));
        this.configHandle.status.set(name, { state: 'failed', error: reason });
        this.notifyStatusChange();
        this.scheduleRetry();
        void entry.conn.close().catch(() => {});
      });
    }
  }

  private observeFileConnections(): void {
    for (const connection of this.fileConnections) {
      if (this.observedConnections.has(connection)) continue;
      this.observedConnections.add(connection);
      connection.onDisconnect?.(() => {
        if (this.stopped || !this.fileConnections.includes(connection)) return;
        this.fileReconnectNeeded = true;
        this.registry.clearToolsFrom('file-mcp');
        this.notifyStatusChange();
        this.scheduleRetry();
        void connection.close().catch(() => {});
      });
    }
  }
}

function jitteredRetryDelay(attempt: number): number {
  const base = Math.min(MCP_RETRY_MAX_MS, MCP_RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 5));
  return Math.min(MCP_RETRY_MAX_MS, Math.max(1, Math.round(base * (0.8 + Math.random() * 0.4))));
}

function retryableMcpFailure(status: ConfigMcpStatus): boolean {
  return (
    status.state === 'failed' &&
    !status.error?.includes('tool set refused by trust policy') &&
    !status.error?.includes('duplicates already-connected')
  );
}

function createMcpRuntime(
  options: McpLifecycleOptions,
  registry: AgentCapabilityRuntime['registry'],
  deps: McpLifecycleDeps = defaultDeps
): McpRuntime {
  return new LiveMcpRuntime(
    options.paths,
    registry,
    options.config?.() ?? createInitialConfigAccess(options.initial),
    options.initial,
    options.initial.auth,
    deps
  );
}

function createInitialConfigAccess(initial: ConfigSnapshot): ConfigAccess {
  let snapshot = structuredClone(initial);
  return {
    get: () => snapshot,
    status: () => ({ state: 'ready' }),
    subscribe: () => () => {},
    update: async (mutate) => {
      snapshot = (await mutate(structuredClone(snapshot))) ?? snapshot;
      return snapshot;
    },
    updateConfig: async (mutate) => {
      snapshot.cfg = (await mutate(structuredClone(snapshot.cfg))) ?? snapshot.cfg;
      return snapshot;
    },
    updateAuth: async (mutate) => {
      snapshot.auth = await mutate(structuredClone(snapshot.auth));
      return snapshot;
    }
  };
}

function sameAuth(a: MonadAuth | null, b: MonadAuth | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

export function createMcpLifecycleModule(
  options: McpLifecycleOptions,
  deps: McpLifecycleDeps = defaultDeps
): RuntimeModule<ConfigSnapshot> {
  return {
    id: 'capabilities.mcp',
    criticality: 'required',
    requires: ['capabilities', 'atoms'],
    start: async (context) => {
      const capabilities = context.get<AgentCapabilityRuntime>('capabilities');
      return createMcpRuntime(options, capabilities.registry, deps);
    },
    reload: async (output, snapshot) => {
      const runtime = output as McpRuntime;
      await runtime.reload(snapshot);
      return runtime;
    },
    stop: (output) => (output as McpRuntime).stop()
  };
}
