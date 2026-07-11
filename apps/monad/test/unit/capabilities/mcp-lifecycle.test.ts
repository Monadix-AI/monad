import type { MonadPaths } from '@monad/home';
import type { PrincipalId } from '@monad/protocol';
import type { ConfigMcpHandle } from '#/capabilities/mcp/service.ts';
import type { McpConnection } from '#/capabilities/tools';
import type { ConfigSnapshot } from '#/config/service.ts';

import { expect, test } from 'bun:test';
import { createDefaultConfig } from '@monad/home';

import { createCapabilitiesRuntime } from '#/capabilities/lifecycle.ts';
import { createMcpLifecycleModule } from '#/capabilities/mcp/lifecycle.ts';
import { RuntimeContext } from '#/runtime/context.ts';

function snapshot(model: string): ConfigSnapshot {
  const cfg = createDefaultConfig('usr_test' as PrincipalId, 'Test');
  return { auth: null, cfg: { ...cfg, model: { ...cfg.model, default: model } } };
}

function connection(name: string, events: string[]): McpConnection {
  return {
    name,
    tools: [],
    close: async () => void events.push(`close:${name}`)
  } as McpConnection;
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
          connections: new Map([[conn.name, { spec: {} as never, conn }]])
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
          connections: new Map([[configB.name, { spec: {} as never, conn: configB }]])
        } satisfies ConfigMcpHandle;
      }
    }
  );
  const context = new RuntimeContext();
  context.commit('capabilities', capabilities);
  context.commit('atoms', {});

  const runtime = await module.start(context, new AbortController().signal);
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
