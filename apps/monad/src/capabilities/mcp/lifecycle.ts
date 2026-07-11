import type { MonadAuth, MonadPaths } from '@monad/home';
import type { CapabilitiesRuntime } from '#/capabilities/lifecycle.ts';
import type { McpConnection } from '#/capabilities/tools';
import type { ConfigSnapshot } from '#/config/service.ts';
import type { RuntimeModule } from '#/runtime/types.ts';

import { type ConfigMcpHandle, connectFileMcpServers, connectMcpServers, reloadConfigMcpServers } from './service.ts';

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
  private fileConnections: McpConnection[];
  private stopped = false;

  constructor(
    private readonly paths: MonadPaths,
    private readonly registry: CapabilitiesRuntime['registry'],
    config: ConfigMcpHandle,
    files: McpConnection[],
    private readonly deps: McpLifecycleDeps
  ) {
    this.configHandle = config;
    this.fileConnections = files;
  }

  get config(): ConfigMcpHandle {
    return this.configHandle;
  }

  get files(): readonly McpConnection[] {
    return this.fileConnections;
  }

  async reload(snapshot: ConfigSnapshot): Promise<void> {
    this.configHandle = await this.deps.reloadConfig(
      this.configHandle.connections,
      snapshot.cfg,
      this.paths,
      this.registry,
      snapshot.auth ?? undefined
    );
    await this.reconnectFiles(snapshot.auth);
  }

  async reconnectFiles(auth?: MonadAuth | null): Promise<void> {
    await Promise.allSettled(this.fileConnections.map((connection) => connection.close()));
    this.registry.clearToolsFrom('file-mcp');
    this.fileConnections = await this.deps.connectFiles(
      this.paths,
      this.registry,
      auth ?? undefined,
      this.configHandle.seenHttp
    );
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const connections = [
      ...[...this.configHandle.connections.values()].map((entry) => entry.conn),
      ...this.fileConnections
    ];
    this.configHandle = { seenHttp: new Set(), connections: new Map() };
    this.fileConnections = [];
    await Promise.allSettled(connections.map((connection) => connection.close()));
  }
}

export async function createMcpRuntime(
  options: McpLifecycleOptions,
  registry: CapabilitiesRuntime['registry'],
  deps: McpLifecycleDeps = defaultDeps
): Promise<McpRuntime> {
  const config = await deps.connectConfig(
    options.initial.cfg,
    options.paths,
    registry,
    options.initial.auth ?? undefined
  );
  const files = await deps.connectFiles(options.paths, registry, options.initial.auth ?? undefined, config.seenHttp);
  return new LiveMcpRuntime(options.paths, registry, config, files, deps);
}

export function createMcpLifecycleModule(
  options: McpLifecycleOptions,
  deps: McpLifecycleDeps = defaultDeps
): RuntimeModule<ConfigSnapshot> {
  return {
    id: 'capabilities.mcp',
    criticality: 'required',
    requires: ['capabilities', 'atoms'],
    start: (context) => {
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
