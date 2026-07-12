import type { RuntimeModule } from '#/runtime/types.ts';

import { expect, test } from 'bun:test';

import { RuntimeKernel } from '#/runtime/kernel.ts';

interface ModuleOptions<Snapshot> {
  after?: string[];
  criticality?: 'optional' | 'required';
  reload?: RuntimeModule<Snapshot>['reload'];
  requires?: string[];
  stop?: RuntimeModule<Snapshot>['stop'];
}

function runtimeModule<Snapshot = unknown>(
  id: string,
  start: RuntimeModule<Snapshot>['start'],
  options: ModuleOptions<Snapshot> = {}
): RuntimeModule<Snapshot> {
  return { id, criticality: 'required', start, ...options };
}

test('starts one topological layer concurrently and waits before dependents', async () => {
  const events: string[] = [];
  let releaseStore = () => {};
  let releaseModel = () => {};
  const storeReady = new Promise<void>((resolve) => {
    releaseStore = resolve;
  });
  const modelReady = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });

  const kernel = new RuntimeKernel([
    runtimeModule('store', async () => {
      events.push('store:start');
      await storeReady;
      events.push('store:done');
      return 'store';
    }),
    runtimeModule('model', async () => {
      events.push('model:start');
      await modelReady;
      events.push('model:done');
      return 'model';
    }),
    runtimeModule(
      'agent',
      async () => {
        events.push('agent:start');
        return 'agent';
      },
      { requires: ['store', 'model'] }
    )
  ]);

  const starting = kernel.start();
  await Bun.sleep(0);
  expect(events).toEqual(['model:start', 'store:start']);
  releaseStore();
  releaseModel();
  await starting;
  expect(events.slice(2, 4).sort()).toEqual(['model:done', 'store:done']);
  expect(events[4]).toBe('agent:start');
  expect(kernel.state.getState().phase).toBe('ready');
});

test('required failure aborts startup and rolls back reverse layers', async () => {
  const stopped: string[] = [];
  const kernel = new RuntimeKernel([
    runtimeModule('store', async () => 'store', { stop: () => void stopped.push('store') }),
    runtimeModule('model', async () => 'model', { stop: () => void stopped.push('model') }),
    runtimeModule(
      'agent',
      async () => {
        throw new Error('bad agent');
      },
      { requires: ['store', 'model'] }
    )
  ]);

  await expect(kernel.start()).rejects.toThrow('required runtime module "agent" failed: bad agent');
  expect(stopped.sort()).toEqual(['model', 'store']);
  expect(kernel.state.getState().phase).toBe('failed');
  expect(kernel.state.getState().modules.agent).toMatchObject({
    error: { message: 'bad agent', name: 'Error' },
    status: 'failed'
  });
});

test('optional failure degrades runtime and blocks its hard dependent', async () => {
  const kernel = new RuntimeKernel([
    runtimeModule('store', async () => 'store'),
    runtimeModule(
      'mcp',
      async () => {
        throw new Error('offline');
      },
      { criticality: 'optional' }
    ),
    runtimeModule('mcp-index', async () => 'index', { criticality: 'optional', requires: ['mcp'] })
  ]);

  await kernel.start();
  expect(kernel.state.getState()).toMatchObject({
    phase: 'degraded',
    modules: {
      mcp: { error: { message: 'offline', name: 'Error' }, status: 'degraded' },
      'mcp-index': { status: 'blocked' },
      store: { generation: 1, status: 'ready' }
    }
  });
});

test('reload keeps the previous output when an optional module fails', async () => {
  const kernel = new RuntimeKernel<{ fail: boolean }>([
    runtimeModule('mcp', async () => 'old', {
      criticality: 'optional',
      reload: async (_current, snapshot) => {
        if (snapshot.fail) throw new Error('reconnect failed');
        return 'new';
      }
    })
  ]);
  await kernel.start();

  const report = await kernel.reload({ fail: true });

  expect(report).toEqual({ degraded: ['mcp'], reloaded: [] });
  expect(kernel.context.get<string>('mcp')).toBe('old');
  expect(kernel.state.getState()).toMatchObject({
    phase: 'degraded',
    modules: { mcp: { error: { message: 'reconnect failed', name: 'Error' }, generation: 1, status: 'degraded' } }
  });
});

test('required reload failure rejects the snapshot and skips dependent layers', async () => {
  const events: string[] = [];
  const kernel = new RuntimeKernel<{ fail: boolean }>([
    runtimeModule('model', async () => 'old', {
      reload: async (_current, snapshot) => {
        events.push('model');
        if (snapshot.fail) throw new Error('provider reload failed');
        return 'new';
      }
    }),
    runtimeModule('agent', async () => 'agent:old', {
      requires: ['model'],
      reload: async () => {
        events.push('agent');
        return 'agent:new';
      }
    })
  ]);
  await kernel.start();

  await expect(kernel.reload({ fail: true })).rejects.toThrow(
    'required runtime module "model" failed to reload: provider reload failed'
  );

  expect(events).toEqual(['model']);
  expect([kernel.context.get<string>('model'), kernel.context.get<string>('agent')]).toEqual(['old', 'agent:old']);
  expect(kernel.state.getState()).toMatchObject({
    phase: 'degraded',
    modules: { model: { status: 'failed' }, agent: { generation: 1, status: 'ready' } }
  });
});

test('reloads independent modules before their dependent and commits new outputs', async () => {
  const events: string[] = [];
  const kernel = new RuntimeKernel<{ value: string }>([
    runtimeModule('store', async () => 'store:old', {
      reload: async (_current, snapshot) => {
        events.push('store');
        return `store:${snapshot.value}`;
      }
    }),
    runtimeModule('model', async () => 'model:old', {
      reload: async (_current, snapshot) => {
        events.push('model');
        return `model:${snapshot.value}`;
      }
    }),
    runtimeModule('agent', async () => 'agent:old', {
      requires: ['store', 'model'],
      reload: async (_current, snapshot) => {
        events.push('agent');
        return `agent:${snapshot.value}`;
      }
    })
  ]);
  await kernel.start();

  const report = await kernel.reload({ value: 'new' });

  expect(events.slice(0, 2).sort()).toEqual(['model', 'store']);
  expect(events[2]).toBe('agent');
  expect(report).toEqual({ degraded: [], reloaded: ['agent', 'model', 'store'] });
  expect([
    kernel.context.get<string>('agent'),
    kernel.context.get<string>('model'),
    kernel.context.get<string>('store')
  ]).toEqual(['agent:new', 'model:new', 'store:new']);
  expect(kernel.state.getState().modules.agent).toMatchObject({ generation: 2, status: 'ready' });
});

test('stops dependents before dependencies', async () => {
  const stopped: string[] = [];
  const kernel = new RuntimeKernel([
    runtimeModule('store', async () => 'store', { stop: () => void stopped.push('store') }),
    runtimeModule('agent', async () => 'agent', {
      requires: ['store'],
      stop: () => void stopped.push('agent')
    })
  ]);
  await kernel.start();

  await kernel.stop();

  expect(stopped).toEqual(['agent', 'store']);
  expect(kernel.state.getState()).toMatchObject({
    phase: 'stopping',
    modules: { agent: { status: 'stopped' }, store: { status: 'stopped' } }
  });
});

test('stop aborts the lifetime signal after a reload', async () => {
  const events: string[] = [];
  const kernel = new RuntimeKernel<{ value: string }>([
    runtimeModule(
      'channel',
      async (_ctx, signal) => {
        signal.addEventListener('abort', () => events.push('aborted'));
        return 'channel';
      },
      {
        reload: async () => {
          events.push('reloaded');
          return 'channel:new';
        },
        stop: () => void events.push('stopped')
      }
    )
  ]);
  await kernel.start();
  await kernel.reload({ value: 'new' });

  await kernel.stop();

  expect(events).toEqual(['reloaded', 'aborted', 'stopped']);
});
