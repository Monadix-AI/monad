import type { MonadPaths } from '@monad/home';
import type { PrincipalId } from '@monad/protocol';
import type { McpRuntime } from '#/capabilities/mcp/lifecycle.ts';
import type { ConfigMcpHandle } from '#/capabilities/mcp/service.ts';
import type { McpConnection } from '#/capabilities/tools';
import type { ConfigSnapshot } from '#/config/service.ts';

import { expect, test } from 'bun:test';
import { createDefaultConfig } from '@monad/home';

import { createCapabilitiesRuntime } from '#/capabilities/lifecycle.ts';
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
  const cfg = createDefaultConfig('usr_test' as PrincipalId, 'Test');
  return { auth: null, cfg: { ...cfg, model: { ...cfg.model, default: model } } };
}

function connection(name: string, events: string[]): McpConnection {
  return {
    name,
    tools: [],
    close: async () => void events.push(`close:${name}`)
  } as unknown as McpConnection;
}

test('owns config and file MCP connections across reload and stop', async () => {
  const events: string[] = [];
  const paths = {} as MonadPaths;
  const capabilities = createCapabilitiesRuntime({ paths, sandboxRoots: undefined, tools: [] });
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
  const capabilities = createCapabilitiesRuntime({ paths, sandboxRoots: undefined, tools: [] });
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
  const capabilities = createCapabilitiesRuntime({ paths, sandboxRoots: undefined, tools: [] });
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
  const capabilities = createCapabilitiesRuntime({ paths, sandboxRoots: undefined, tools: [] });
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
  const capabilities = createCapabilitiesRuntime({ paths, sandboxRoots: undefined, tools: [] });
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
