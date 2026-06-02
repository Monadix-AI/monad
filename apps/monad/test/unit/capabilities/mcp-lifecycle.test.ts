import type { MonadPaths } from '@monad/environment';
import type { McpRuntime } from '#/capabilities/mcp/lifecycle.ts';
import type { ConfigMcpHandle } from '#/capabilities/mcp/service.ts';
import type { McpConnection } from '#/capabilities/tools';
import type { ConfigSnapshot } from '#/config/manager.ts';

import { expect, test } from 'bun:test';
import { createDefaultConfig } from '@monad/environment';

import { createAgentCapabilityRuntime } from '#/capabilities/lifecycle.ts';
import { createMcpLifecycleModule } from '#/capabilities/mcp/lifecycle.ts';
import { RuntimeContext } from '#/runtime/context.ts';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function snapshot(model: string): ConfigSnapshot {
  const cfg = createDefaultConfig('Test');
  return { auth: null, cfg: { ...cfg, model: { ...cfg.model, default: model } } };
}

function connection(name: string, events: string[]): McpConnection {
  return {
    name,
    tools: [],
    close: async () => void events.push(`close:${name}`)
  } as unknown as McpConnection;
}

function disconnectableConnection(
  name: string,
  events: string[]
): { conn: McpConnection; disconnect(reason: string): void } {
  let listener: ((reason: string) => void) | undefined;
  return {
    conn: {
      name,
      tools: [],
      callTool: async () => [],
      onDisconnect(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      close: async () => void events.push(`close:${name}`)
    },
    disconnect(reason) {
      events.push(`disconnect:${name}:${reason}`);
      listener?.(reason);
    }
  };
}

test('owns config and file MCP connections across reload and stop', async () => {
  const events: string[] = [];
  const paths = {} as MonadPaths;
  const capabilities = createAgentCapabilityRuntime({ paths, sandboxRoots: undefined, tools: [] });
  const configA = connection('config-a', events);
  const configB = connection('config-b', events);
  const fileA = connection('file-a', events);
  const fileB = connection('file-b', events);
  let configRound = 0;
  let fileRound = 0;
  const module = createMcpLifecycleModule(
    { initial: snapshot('a'), paths },
    {
      connectConfig: async () => {
        events.push('connect:config');
        const conn = configRound++ === 0 ? configA : configB;
        return {
          seenHttp: new Set([`https://config-${configRound}`]),
          connections: new Map([[conn.name, { spec: {} as never, conn }]]),
          status: new Map([[conn.name, { state: 'ready' as const }]])
        };
      },
      connectFiles: async (_paths, _registry, _auth, seenHttp) => {
        events.push(`connect:files:${[...(seenHttp ?? [])].join(',')}`);
        return [fileRound++ === 0 ? fileA : fileB];
      },
      reloadConfig: async () => {
        events.push('reload:config');
        return {
          seenHttp: new Set(['https://config-reloaded']),
          connections: new Map([[configB.name, { spec: {} as never, conn: configB }]]),
          status: new Map([[configB.name, { state: 'ready' as const }]])
        } satisfies ConfigMcpHandle;
      }
    }
  );
  const context = new RuntimeContext();
  context.commit('capabilities', capabilities);
  context.commit('atoms', {});

  const runtime = (await module.start(context, new AbortController().signal)) as McpRuntime;
  const reloaded = await module.reload?.(runtime, snapshot('b'), context, new AbortController().signal);
  await module.stop?.(reloaded, context);

  expect({
    events,
    id: module.id,
    requires: module.requires,
    stable: runtime === reloaded
  }).toEqual({
    events: [
      'connect:config',
      'connect:files:https://config-1',
      'reload:config',
      'close:file-a',
      'connect:files:https://config-reloaded',
      'close:config-b',
      'close:file-b'
    ],
    id: 'capabilities.mcp',
    requires: ['capabilities', 'atoms'],
    stable: true
  });
});

test('keeps file MCP connections when unrelated config changes preserve auth and HTTP ownership', async () => {
  const events: string[] = [];
  const paths = {} as MonadPaths;
  const capabilities = createAgentCapabilityRuntime({ paths, sandboxRoots: undefined, tools: [] });
  const file = connection('file-a', events);
  const handle = {
    seenHttp: new Set(['https://config']),
    connections: new Map(),
    status: new Map()
  } satisfies ConfigMcpHandle;
  const module = createMcpLifecycleModule(
    { initial: snapshot('a'), paths },
    {
      connectConfig: async () => handle,
      connectFiles: async () => {
        events.push('connect:files');
        return [file];
      },
      reloadConfig: async () => {
        events.push('reload:config');
        return { ...handle, seenHttp: new Set(handle.seenHttp) };
      }
    }
  );
  const context = new RuntimeContext();
  context.commit('capabilities', capabilities);
  context.commit('atoms', {});
  const runtime = (await module.start(context, new AbortController().signal)) as McpRuntime;

  await module.reload?.(runtime, snapshot('b'), context, new AbortController().signal);

  expect(events).toEqual(['connect:files', 'reload:config']);
});

test('starts without waiting for MCP handshakes to finish', async () => {
  const events: string[] = [];
  const paths = {} as MonadPaths;
  const capabilities = createAgentCapabilityRuntime({ paths, sandboxRoots: undefined, tools: [] });
  const configReady = deferred<ConfigMcpHandle>();
  const file = connection('file-a', events);
  const module = createMcpLifecycleModule(
    { initial: snapshot('a'), paths },
    {
      connectConfig: async () => {
        events.push('connect:config:start');
        return configReady.promise;
      },
      connectFiles: async (_paths, _registry, _auth, seenHttp) => {
        events.push(`connect:files:${[...(seenHttp ?? [])].join(',')}`);
        return [file];
      },
      reloadConfig: async () => {
        throw new Error('unused');
      }
    }
  );
  const context = new RuntimeContext();
  context.commit('capabilities', capabilities);
  context.commit('atoms', {});

  const runtime = (await module.start(context, new AbortController().signal)) as McpRuntime;
  let statusChanges = 0;
  const unsubscribe = runtime.onStatusChange(() => {
    statusChanges += 1;
  });

  expect(runtime.config.connections.size).toBe(0);
  expect(runtime.files).toEqual([]);
  expect(events).toEqual(['connect:config:start']);

  configReady.resolve({
    seenHttp: new Set(['https://config']),
    connections: new Map(),
    status: new Map()
  });
  await runtime.ready();

  expect(runtime.files.map((conn) => conn.name)).toEqual(['file-a']);
  expect(events).toEqual(['connect:config:start', 'connect:files:https://config']);
  expect(statusChanges).toBe(2);
  unsubscribe();
});

test('keeps runtime available when background MCP startup fails', async () => {
  const paths = {} as MonadPaths;
  const capabilities = createAgentCapabilityRuntime({ paths, sandboxRoots: undefined, tools: [] });
  const module = createMcpLifecycleModule(
    { initial: snapshot('a'), paths },
    {
      connectConfig: async () => {
        throw new Error('mcp unavailable');
      },
      connectFiles: async () => {
        throw new Error('unused');
      },
      reloadConfig: async () => ({
        seenHttp: new Set(),
        connections: new Map(),
        status: new Map()
      })
    }
  );
  const context = new RuntimeContext();
  context.commit('capabilities', capabilities);
  context.commit('atoms', {});

  const runtime = (await module.start(context, new AbortController().signal)) as McpRuntime;

  await runtime.ready();
  expect(runtime.config.connections.size).toBe(0);
  expect(runtime.files).toEqual([]);
});

test('keeps ready config MCP state when file MCP startup fails', async () => {
  const events: string[] = [];
  const paths = {} as MonadPaths;
  const capabilities = createAgentCapabilityRuntime({ paths, sandboxRoots: undefined, tools: [] });
  const configConn = connection('config-a', events);
  const module = createMcpLifecycleModule(
    { initial: snapshot('a'), paths },
    {
      connectConfig: async () => ({
        seenHttp: new Set(['https://config']),
        connections: new Map([[configConn.name, { spec: {} as never, conn: configConn }]]),
        status: new Map([[configConn.name, { state: 'ready' as const }]])
      }),
      connectFiles: async () => {
        throw new Error('file scan failed');
      },
      reloadConfig: async () => ({
        seenHttp: new Set(),
        connections: new Map(),
        status: new Map()
      })
    }
  );
  const context = new RuntimeContext();
  context.commit('capabilities', capabilities);
  context.commit('atoms', {});

  const runtime = (await module.start(context, new AbortController().signal)) as McpRuntime;
  await runtime.ready();

  expect(runtime.config.connections.get('config-a')?.conn).toBe(configConn);
  expect(runtime.config.status.get('config-a')?.state).toBe('ready');
  expect(runtime.files).toEqual([]);
});

test('retries transient config MCP failures without interactive authorization', async () => {
  const events: string[] = [];
  const paths = {} as MonadPaths;
  const capabilities = createAgentCapabilityRuntime({ paths, sandboxRoots: undefined, tools: [] });
  const recovered = connection('recovering', events);
  const module = createMcpLifecycleModule(
    { initial: snapshot('a'), paths },
    {
      connectConfig: async () => ({
        seenHttp: new Set(),
        connections: new Map(),
        status: new Map([['recovering', { state: 'failed' as const, error: 'connection refused' }]])
      }),
      connectFiles: async () => [],
      reloadConfig: async () => {
        throw new Error('unused');
      },
      reconnectConfig: async (_name, _previous, _cfg, _paths, _registry, _auth, _config, options) => {
        events.push(`retry:${String(options?.interactive)}`);
        return {
          seenHttp: new Set(),
          connections: new Map([['recovering', { spec: {} as never, conn: recovered }]]),
          status: new Map([['recovering', { state: 'ready' as const }]])
        };
      },
      retryDelayMs: () => 1
    }
  );
  const context = new RuntimeContext();
  context.commit('capabilities', capabilities);
  context.commit('atoms', {});
  const runtime = (await module.start(context, new AbortController().signal)) as McpRuntime;
  await runtime.ready();
  for (let attempt = 0; attempt < 50 && runtime.config.status.get('recovering')?.state !== 'ready'; attempt += 1) {
    await Bun.sleep(2);
  }

  expect({
    events,
    state: runtime.config.status.get('recovering'),
    connected: runtime.config.connections.get('recovering')?.conn.name
  }).toEqual({
    events: ['retry:false'],
    state: { state: 'ready' },
    connected: 'recovering'
  });
  await module.stop?.(runtime, context);
});

test('drops tools and reconnects a ready config MCP server after an unexpected disconnect', async () => {
  const events: string[] = [];
  const paths = {} as MonadPaths;
  const capabilities = createAgentCapabilityRuntime({ paths, sandboxRoots: undefined, tools: [] });
  const live = disconnectableConnection('live', events);
  const recovered = connection('live', events);
  const module = createMcpLifecycleModule(
    { initial: snapshot('a'), paths },
    {
      connectConfig: async () => ({
        seenHttp: new Set(),
        connections: new Map([['live', { spec: {} as never, conn: live.conn }]]),
        status: new Map([['live', { state: 'ready' as const }]])
      }),
      connectFiles: async () => [],
      reloadConfig: async () => {
        throw new Error('unused');
      },
      reconnectConfig: async (_name, _previous, _cfg, _paths, _registry, _auth, _config, options) => {
        events.push(`retry:${String(options?.interactive)}`);
        return {
          seenHttp: new Set(),
          connections: new Map([['live', { spec: {} as never, conn: recovered }]]),
          status: new Map([['live', { state: 'ready' as const }]])
        };
      },
      retryDelayMs: () => 1
    }
  );
  const context = new RuntimeContext();
  context.commit('capabilities', capabilities);
  context.commit('atoms', {});
  const runtime = (await module.start(context, new AbortController().signal)) as McpRuntime;
  await runtime.ready();

  live.disconnect('pipe closed');
  for (let attempt = 0; attempt < 50 && runtime.config.connections.get('live')?.conn !== recovered; attempt += 1) {
    await Bun.sleep(2);
  }

  expect({
    events,
    state: runtime.config.status.get('live'),
    recovered: runtime.config.connections.get('live')?.conn === recovered
  }).toEqual({
    events: ['disconnect:live:pipe closed', 'close:live', 'retry:false'],
    state: { state: 'ready' },
    recovered: true
  });
  await module.stop?.(runtime, context);
});
