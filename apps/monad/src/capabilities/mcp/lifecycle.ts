import type { MonadAuth, MonadPaths } from '@monad/home';
import type { CapabilitiesRuntime } from '#/capabilities/lifecycle.ts';
import type { McpConnection } from '#/capabilities/tools';
import type { ConfigSnapshot } from '#/config/service.ts';
import type { RuntimeModule } from '#/runtime/types.ts';

import { logger } from '@monad/logger';

import {
  type ConfigMcpHandle,
  connectFileMcpServers,
  connectMcpServers,
  createPendingConfigMcpHandle,
  reloadConfigMcpServers
} from './service.ts';

export interface McpLifecycleOptions {
  initial: ConfigSnapshot;
  paths: MonadPaths;
}

export interface McpLifecycleDeps {
  connectConfig: typeof connectMcpServers;
  connectFiles: typeof connectFileMcpServers;
  reloadConfig: typeof reloadConfigMcpServers;
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
  reloadConfig: reloadConfigMcpServers
};

class LiveMcpRuntime implements McpRuntime {
  private configHandle: ConfigMcpHandle;
  private fileConnections: McpConnection[] = [];
  private readonly statusListeners = new Set<() => void>();
  private operation: Promise<void>;
  private stopped = false;

  constructor(
    private readonly paths: MonadPaths,
    private readonly registry: CapabilitiesRuntime['registry'],
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
    this.configHandle = handle;
    this.notifyStatusChange();
  }

  async reload(snapshot: ConfigSnapshot): Promise<void> {
    await this.operation;
    const previousSeenHttp = this.configHandle.seenHttp;
    const nextConfig = await this.deps.reloadConfig(
      this.configHandle.connections,
      snapshot.cfg,
      this.paths,
      this.registry,
      snapshot.auth ?? undefined
    );
    this.configHandle = nextConfig;
    if (!sameAuth(this.auth, snapshot.auth) || !sameSet(previousSeenHttp, nextConfig.seenHttp)) {
      await this.reconnectFiles(snapshot.auth);
    } else {
      this.notifyStatusChange();
    }
    this.auth = snapshot.auth;
  }

  async reconnectFiles(auth?: MonadAuth | null): Promise<void> {
    await this.operation;
    await Promise.allSettled(this.fileConnections.map((connection) => connection.close()));
    this.registry.clearToolsFrom('file-mcp');
    this.fileConnections = await this.deps.connectFiles(
      this.paths,
      this.registry,
      auth ?? undefined,
      this.configHandle.seenHttp
    );
    this.notifyStatusChange();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
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
    const config = await this.deps.connectConfig(initial.cfg, this.paths, this.registry, initial.auth ?? undefined);
    if (this.stopped) {
      await Promise.allSettled([...config.connections.values()].map((entry) => entry.conn.close()));
      return;
    }
    this.configHandle = config;
    this.notifyStatusChange();
    const files = await this.deps.connectFiles(this.paths, this.registry, initial.auth ?? undefined, config.seenHttp);
    if (this.stopped) {
      await Promise.allSettled(files.map((connection) => connection.close()));
      return;
    }
    this.fileConnections = files;
    this.auth = initial.auth;
    this.notifyStatusChange();
  }

  private markPendingConfigFailed(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    for (const [name, status] of this.configHandle.status) {
      if (status.state === 'starting') this.configHandle.status.set(name, { state: 'failed', error: message });
    }
    this.notifyStatusChange();
  }

  private notifyStatusChange(): void {
    for (const listener of this.statusListeners) listener();
  }
}

function createMcpRuntime(
  options: McpLifecycleOptions,
  registry: CapabilitiesRuntime['registry'],
  deps: McpLifecycleDeps = defaultDeps
): McpRuntime {
  return new LiveMcpRuntime(options.paths, registry, options.initial, options.initial.auth, deps);
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
      const capabilities = context.get<CapabilitiesRuntime>('capabilities');
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
