import type {
  MeshAgentProviderDriver,
  PerTurnProviderDriver,
  ResidentProviderDriver,
  ResidentSessionEventPlan,
  SessionEventRuntimeDefinition
} from '@monad/sdk-atom';
import type {
  SessionEventRuntimeActivation,
  SessionEventRuntimeResourceFactory
} from '#/services/mesh-agent/session-event-runtime/types.ts';

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { BunSessionEventRuntimeResourceFactory } from '#/services/mesh-agent/session-event-runtime/bun-resource-factory.ts';
import { BoundedSessionEventIngress } from '#/services/mesh-agent/session-event-runtime/event-sink.ts';
import { SessionEventRuntimeExecutor } from '#/services/mesh-agent/session-event-runtime/executor.ts';
import { materializeProcessLaunch, materializeTurnLaunch } from '#/services/mesh-agent/session-event-runtime/launch.ts';
import { validateSessionEventRuntimeDefinition } from '#/services/mesh-agent/session-event-runtime/validation.ts';

const controls = {
  approvalResolution: false,
  steer: false,
  interrupt: false
} as const;

async function removeRuntimeDirectory(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || attempt === 49) throw error;
      // biome-ignore lint/plugin: backoff inside a bounded retry loop; the next attempt is the condition, and Windows keeps directory handles open past the unlink.
      await Bun.sleep(100);
    }
  }
}

function driver(processModel: 'resident'): ResidentProviderDriver;
function driver(processModel: 'per-turn'): PerTurnProviderDriver;
function driver(processModel: 'resident' | 'per-turn'): MeshAgentProviderDriver {
  const base = {
    processModel,
    controls,
    async openSession() {
      return {
        capabilities: {
          input: true,
          steer: false,
          interrupt: false,
          approvalResolution: false,
          providerSessionContinuation: true,
          runtimeRestoration: true,
          sessionReopen: true
        }
      };
    },
    async accept() {},
    async dispose() {}
  };
  if (processModel === 'resident') {
    return { ...base, processModel, async attachChannel() {}, async sendTurn() {} };
  }
  return { ...base, processModel, async attachTurnChannel() {}, async completeTurn() {} };
}

function residentDefinition(): SessionEventRuntimeDefinition {
  return {
    plan: {
      processModel: 'resident',
      launch: { args: ['serve'], cwd: '/workspace', env: { PROVIDER_MODE: 'mesh' } },
      channel: { kind: 'websocket', endpoint: 'daemon-loopback' },
      startup: { timeoutMs: 10_000 },
      reconnect: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
      suspend: { idleTimeoutMs: 60_000 }
    },
    driver: driver('resident')
  };
}

describe('session-event runtime definition validation', () => {
  test('accepts exact resident and per-turn definitions', () => {
    const resident = residentDefinition();
    const perTurn: SessionEventRuntimeDefinition = {
      plan: {
        processModel: 'per-turn',
        buildTurnLaunch: () => ({ args: ['exec', '--json'], cwd: '/workspace' }),
        encodeTurnInput: ({ text }) => ({ delivery: 'stdin', bytes: new TextEncoder().encode(text) }),
        startup: { timeoutMs: 10_000 },
        continuation: { strategy: 'provider-session-ref' }
      },
      driver: driver('per-turn')
    };

    expect(validateSessionEventRuntimeDefinition(resident)).toBe(resident);
    expect(validateSessionEventRuntimeDefinition(perTurn)).toBe(perTurn);
  });

  test('accepts a dynamic resident launch and rejects a non-function builder', () => {
    const dynamic: SessionEventRuntimeDefinition = {
      plan: {
        processModel: 'resident',
        launch: { args: ['serve'], cwd: '/workspace' },
        buildLaunch: ({ providerSessionRef }) => ({
          args: providerSessionRef ? ['serve', '--resume', providerSessionRef] : ['serve'],
          cwd: '/workspace'
        }),
        channel: { kind: 'child-stdio' },
        startup: { timeoutMs: 10_000 }
      },
      driver: driver('resident')
    };
    expect(validateSessionEventRuntimeDefinition(dynamic)).toBe(dynamic);

    const invalid = residentDefinition() as unknown as { plan: Record<string, unknown> };
    invalid.plan.buildLaunch = true;
    expect(() => validateSessionEventRuntimeDefinition(invalid)).toThrow('resident buildLaunch must be a function');
  });

  test('accepts driver methods inherited from a provider class prototype', () => {
    const inheritedDriver = Object.create(driver('per-turn')) as PerTurnProviderDriver;
    const definition: SessionEventRuntimeDefinition = {
      plan: {
        processModel: 'per-turn',
        buildTurnLaunch: () => ({ args: ['exec', '--json'], cwd: '/workspace' }),
        encodeTurnInput: ({ text }) => ({ delivery: 'stdin', bytes: new TextEncoder().encode(text) }),
        startup: { timeoutMs: 10_000 },
        continuation: { strategy: 'provider-session-ref' }
      },
      driver: inheritedDriver
    };

    expect(validateSessionEventRuntimeDefinition(definition)).toBe(definition);
  });

  test('rejects a mismatched driver and unsafe runtime policy values', () => {
    const mismatched = residentDefinition() as unknown as Record<string, unknown>;
    mismatched.driver = driver('per-turn');
    expect(() => validateSessionEventRuntimeDefinition(mismatched)).toThrow('driver process model');

    const badTimeout = residentDefinition();
    (badTimeout.plan as ResidentSessionEventPlan).startup.timeoutMs = 0;
    expect(() => validateSessionEventRuntimeDefinition(badTimeout)).toThrow('startup timeout');

    const badCwd = residentDefinition();
    (badCwd.plan as ResidentSessionEventPlan).launch.cwd = 'relative/path';
    expect(() => validateSessionEventRuntimeDefinition(badCwd)).toThrow('absolute working directory');
  });

  test('rejects adapter-selected endpoints and unknown channel fields', () => {
    const selectedEndpoint = residentDefinition() as unknown as {
      plan: { channel: Record<string, unknown> };
    };
    selectedEndpoint.plan.channel.host = 'example.com';
    selectedEndpoint.plan.channel.port = 443;
    expect(() => validateSessionEventRuntimeDefinition(selectedEndpoint)).toThrow('channel fields');

    const wrongEndpoint = residentDefinition() as unknown as {
      plan: { channel: Record<string, unknown> };
    };
    wrongEndpoint.plan.channel.endpoint = 'ws://example.com';
    expect(() => validateSessionEventRuntimeDefinition(wrongEndpoint)).toThrow('daemon-loopback');
  });
});

describe('session-event runtime launch materialization', () => {
  test('keeps the daemon-resolved executable and constrains the working directory', () => {
    expect(
      materializeProcessLaunch({
        executable: '/usr/local/bin/provider',
        allowedWorkingRoot: '/workspace',
        plan: { args: ['exec', '--json'], cwd: '/workspace/project', env: { MODE: 'mesh' } }
      })
    ).toEqual({
      argv: ['/usr/local/bin/provider', 'exec', '--json'],
      cwd: resolve('/workspace/project'),
      env: { MODE: 'mesh' }
    });
    expect(() =>
      materializeProcessLaunch({
        executable: '/usr/local/bin/provider',
        allowedWorkingRoot: '/workspace',
        plan: { args: [], cwd: '/workspace-escape' }
      })
    ).toThrow('outside the allowed root');
    expect(() =>
      materializeProcessLaunch({
        executable: 'provider',
        allowedWorkingRoot: '/workspace',
        plan: { args: [], cwd: '/workspace' }
      })
    ).toThrow('absolute executable');
  });

  test('delivers turn input only through bounded stdin or a literal argv separator', () => {
    const launch = { args: ['exec', '--json'], cwd: '/workspace' };
    expect(
      materializeTurnLaunch({
        executable: '/bin/provider',
        allowedWorkingRoot: '/workspace',
        plan: launch,
        input: { delivery: 'stdin', bytes: new TextEncoder().encode('hello') }
      })
    ).toEqual({
      argv: ['/bin/provider', 'exec', '--json'],
      cwd: resolve('/workspace'),
      stdin: new TextEncoder().encode('hello')
    });
    expect(
      materializeTurnLaunch({
        executable: '/bin/provider',
        allowedWorkingRoot: '/workspace',
        plan: launch,
        input: { delivery: 'argv-tail', separator: '--', values: ['hello', '--danger'] }
      })
    ).toEqual({
      argv: ['/bin/provider', 'exec', '--json', '--', 'hello', '--danger'],
      cwd: resolve('/workspace')
    });
    expect(() =>
      materializeTurnLaunch({
        executable: '/bin/provider',
        allowedWorkingRoot: '/workspace',
        plan: launch,
        input: { delivery: 'stdin', bytes: new Uint8Array(1024 * 1024 + 1) }
      })
    ).toThrow('turn input exceeds');
  });
});

describe('bounded session-event ingress', () => {
  test('serializes concurrent packets and consumes validated events in order', async () => {
    const consumed: string[] = [];
    const ingress = new BoundedSessionEventIngress({
      consume: async (event) => {
        await Bun.sleep(event.type === 'agent_message' ? 2 : 0);
        consumed.push(event.type);
      }
    });
    const packet = (value: string) => ({
      bytes: new TextEncoder().encode(value),
      source: 'stdout' as const,
      receivedAt: '2026-07-19T00:00:00.000Z'
    });

    await Promise.all([
      ingress.ingest(packet('one'), async (_packet, sink) => {
        await sink.emit({ type: 'agent_message', payload: { text: 'one' } });
        await sink.emit({ type: 'tool_call', payload: { tool: 'shell' } });
      }),
      ingress.ingest(packet('two'), async (_packet, sink) => {
        await sink.emit({ type: 'tool_result', payload: { output: 'done' } });
      })
    ]);

    expect(consumed).toEqual(['agent_message', 'tool_call', 'tool_result']);
  });

  test('deduplicates a stable provider identity and rejects identity changes', async () => {
    const refs: string[] = [];
    const ingress = new BoundedSessionEventIngress({
      consume: async (event) => {
        if (event.type === 'provider_session_identified') refs.push(event.payload.providerSessionRef);
      }
    });
    const packet = {
      bytes: new Uint8Array([1]),
      source: 'provider-channel' as const,
      receivedAt: '2026-07-19T00:00:00.000Z'
    };
    await ingress.ingest(packet, async (_packet, sink) => {
      await sink.emit({ type: 'provider_session_identified', payload: { providerSessionRef: 'provider-1' } });
      await sink.emit({ type: 'provider_session_identified', payload: { providerSessionRef: 'provider-1' } });
    });
    expect(refs).toEqual(['provider-1']);
    await expect(
      ingress.ingest(packet, async (_packet, sink) => {
        await sink.emit({ type: 'provider_session_identified', payload: { providerSessionRef: 'provider-2' } });
      })
    ).rejects.toThrow('provider session identity changed');
  });

  test('cancels on invalid events, excess events, and queued bytes', async () => {
    const cancellations: string[] = [];
    const ingress = new BoundedSessionEventIngress({
      maxEventsPerPacket: 1,
      maxQueuedBytes: 4,
      consume: async () => {},
      onCancel: (error) => cancellations.push(error.message)
    });
    const packet = {
      bytes: new Uint8Array([1]),
      source: 'stdout' as const,
      receivedAt: '2026-07-19T00:00:00.000Z'
    };
    await expect(
      ingress.ingest(packet, async (_packet, sink) => {
        await sink.emit({ type: 'agent_message', payload: { text: 'one' } });
        await sink.emit({ type: 'tool_call', payload: {} });
      })
    ).rejects.toThrow('event limit');
    await expect(ingress.ingest(packet, async () => {})).rejects.toThrow('event limit');
    expect(cancellations).toEqual(['session-event packet exceeded its event limit']);

    const queued = new BoundedSessionEventIngress({ maxQueuedBytes: 1, consume: async () => {} });
    await expect(queued.ingest({ ...packet, bytes: new Uint8Array([1, 2]) }, async () => {})).rejects.toThrow(
      'queued byte limit'
    );
  });
});

function activation(args?: {
  packets?: string[];
  exitCode?: number | null;
  pid?: number;
  order?: string[];
  pending?: boolean;
}): SessionEventRuntimeActivation {
  const order = args?.order ?? [];
  let settlePending: (() => void) | undefined;
  const pendingResult = new Promise<{ exitCode: null; signal: 'SIGTERM' }>((resolve) => {
    settlePending = () => resolve({ exitCode: null, signal: 'SIGTERM' });
  });
  return {
    process: {
      pid: args?.pid ?? 42,
      async writeStdin(bytes) {
        order.push(`stdin:${new TextDecoder().decode(bytes)}`);
      },
      async closeStdin() {
        order.push('stdin:closed');
      },
      async kill() {
        order.push('process:killed');
        settlePending?.();
      },
      result: args?.pending ? pendingResult : Promise.resolve({ exitCode: args?.exitCode ?? 0 })
    },
    channel: { async send() {}, async close() {} },
    async *packets() {
      for (const text of args?.packets ?? []) {
        yield {
          bytes: new TextEncoder().encode(text),
          source: 'stdout' as const,
          receivedAt: '2026-07-19T00:00:00.000Z'
        };
      }
    },
    async close() {
      order.push('activation:closed');
    }
  };
}

describe('generic session-event runtime executor', () => {
  test('runs per-turn processes, captures raw first, and resumes by provider identity', async () => {
    const order: string[] = [];
    const launches: string[][] = [];
    const refs: Array<string | undefined> = [];
    let turn = 0;
    const perTurnDriver = driver('per-turn');
    perTurnDriver.accept = async (packet, sink) => {
      order.push(`decode:${new TextDecoder().decode(packet.bytes)}`);
      await sink.emit({
        type: 'provider_session_identified',
        payload: { providerSessionRef: 'provider-session-1' }
      });
      await sink.emit({ type: 'agent_message', payload: { text: `reply-${turn}` } });
    };
    const definition: SessionEventRuntimeDefinition = {
      plan: {
        processModel: 'per-turn',
        buildTurnLaunch: ({ providerSessionRef }) => {
          refs.push(providerSessionRef);
          return { args: providerSessionRef ? ['resume', providerSessionRef] : ['exec'], cwd: '/workspace' };
        },
        encodeTurnInput: ({ text }) => ({ delivery: 'stdin', bytes: new TextEncoder().encode(text) }),
        startup: { timeoutMs: 1_000 },
        continuation: { strategy: 'provider-session-ref' }
      },
      driver: perTurnDriver
    };
    const factory: SessionEventRuntimeResourceFactory = {
      async start(request) {
        launches.push(request.launch.argv);
        turn += 1;
        return activation({ packets: [`packet-${turn}`], order });
      }
    };
    const events: string[] = [];
    const states: string[] = [];
    const executor = new SessionEventRuntimeExecutor({
      definition,
      executable: '/bin/provider',
      allowedWorkingRoot: '/workspace',
      workingPath: '/workspace',
      resourceFactory: factory,
      createObservationEpoch: () => `epoch-${turn + 1}`,
      captureRaw: async (_packet, epoch) => {
        order.push(`raw:${epoch}`);
      },
      consumeEvent: async (event) => {
        events.push(event.type);
      },
      onSnapshot: (snapshot) => states.push(`${snapshot.lifecycle.state}:${snapshot.activity.state}`)
    });

    await executor.open({ text: 'first', attachments: [] });
    expect(executor.snapshot()).toMatchObject({ lifecycle: { state: 'active' }, activity: { state: 'idle' } });
    await executor.input({ text: 'second', attachments: [] });

    expect(refs).toEqual([undefined, 'provider-session-1']);
    expect(launches).toEqual([
      ['/bin/provider', 'exec'],
      ['/bin/provider', 'resume', 'provider-session-1']
    ]);
    expect(order.indexOf('raw:epoch-1')).toBeLessThan(order.indexOf('decode:packet-1'));
    expect(events).toEqual(['provider_session_identified', 'agent_message', 'agent_message']);
    expect(states).toEqual([
      'active:idle',
      'active:starting',
      'active:running',
      'active:running',
      'active:idle',
      'active:starting',
      'active:running',
      'active:idle'
    ]);
    expect(executor.snapshot()).toMatchObject({
      lifecycle: { state: 'active' },
      activity: { state: 'idle' },
      providerSessionRef: 'provider-session-1'
    });
  });

  test('keeps a per-turn process failure scoped to the turn', async () => {
    const perTurnDriver = driver('per-turn');
    const results: Array<number | null> = [];
    perTurnDriver.completeTurn = async (result) => {
      results.push(result.exitCode);
    };
    const executor = new SessionEventRuntimeExecutor({
      definition: {
        plan: {
          processModel: 'per-turn',
          buildTurnLaunch: () => ({ args: [], cwd: '/workspace' }),
          encodeTurnInput: () => ({ delivery: 'argv-tail', separator: '--', values: ['turn'] }),
          startup: { timeoutMs: 1_000 },
          continuation: { strategy: 'provider-session-ref' }
        },
        driver: perTurnDriver
      },
      executable: '/bin/provider',
      allowedWorkingRoot: '/workspace',
      workingPath: '/workspace',
      resourceFactory: {
        async start() {
          return activation({ exitCode: 7 });
        }
      },
      createObservationEpoch: () => 'epoch-1',
      captureRaw: async () => {},
      consumeEvent: async () => {}
    });
    await executor.open();
    await expect(executor.input({ text: 'fail', attachments: [] })).rejects.toThrow('exited with code 7');
    expect(results).toEqual([7]);
    expect(executor.snapshot()).toMatchObject({ lifecycle: { state: 'active' }, activity: { state: 'idle' } });
  });

  test('starts a resident channel and tears every resource down once', async () => {
    const order: string[] = [];
    const residentDriver = driver('resident');
    residentDriver.openSession = async () => {
      order.push('driver:open');
      return {
        capabilities: {
          input: true,
          steer: false,
          interrupt: false,
          approvalResolution: false,
          providerSessionContinuation: true,
          runtimeRestoration: true,
          sessionReopen: true
        }
      };
    };
    residentDriver.attachChannel = async () => {
      order.push('driver:attached');
    };
    residentDriver.sendTurn = async ({ text }) => {
      order.push(`turn:${text}`);
    };
    residentDriver.dispose = async () => {
      order.push('driver:disposed');
    };
    const executor = new SessionEventRuntimeExecutor({
      definition: {
        plan: {
          processModel: 'resident',
          launch: { args: ['serve'], cwd: '/workspace' },
          channel: { kind: 'child-stdio' },
          startup: { timeoutMs: 1_000 }
        },
        driver: residentDriver
      },
      executable: '/bin/provider',
      allowedWorkingRoot: '/workspace',
      workingPath: '/workspace',
      resourceFactory: {
        async start() {
          return activation({ order, pending: true });
        }
      },
      createObservationEpoch: () => 'epoch-1',
      captureRaw: async () => {},
      consumeEvent: async () => {}
    });
    await executor.open();
    await executor.input({ text: 'hello', attachments: [] });
    await Promise.all([executor.close(), executor.close()]);
    expect(order).toEqual([
      'driver:open',
      'driver:attached',
      'turn:hello',
      'process:killed',
      'activation:closed',
      'driver:disposed'
    ]);
    expect(executor.snapshot()).toMatchObject({
      lifecycle: { state: 'terminal', termination: { kind: 'stopped', exitCode: null, signal: 'SIGTERM' } }
    });
  });

  test('close is a process-exit join barrier before publishing the stopped generation', async () => {
    let releaseExit: ((value: { exitCode: null; signal: 'SIGTERM' }) => void) | undefined;
    const processResult = new Promise<{ exitCode: null; signal: 'SIGTERM' }>((resolve) => {
      releaseExit = resolve;
    });
    const order: string[] = [];
    const executor = new SessionEventRuntimeExecutor({
      definition: {
        plan: {
          processModel: 'resident',
          launch: { args: ['serve'], cwd: '/workspace' },
          channel: { kind: 'child-stdio' },
          startup: { timeoutMs: 1_000 }
        },
        driver: driver('resident')
      },
      executable: '/bin/provider',
      allowedWorkingRoot: '/workspace',
      workingPath: '/workspace',
      resourceFactory: {
        async start() {
          const running = activation({ order });
          running.process.result = processResult;
          return running;
        }
      },
      createObservationEpoch: () => 'epoch-join',
      captureRaw: async () => {},
      consumeEvent: async () => {}
    });
    await executor.open();

    let stopped = false;
    const closing = executor.close().then(() => {
      stopped = true;
    });
    await Bun.sleep(0);
    expect({ order, stopped, lifecycle: executor.snapshot().lifecycle.state }).toEqual({
      order: ['process:killed'],
      stopped: false,
      lifecycle: 'active'
    });

    releaseExit?.({ exitCode: null, signal: 'SIGTERM' });
    await closing;
    expect({ order, stopped, lifecycle: executor.snapshot().lifecycle }).toEqual({
      order: ['process:killed', 'activation:closed'],
      stopped: true,
      lifecycle: {
        state: 'terminal',
        termination: { kind: 'stopped', at: expect.any(String), exitCode: null, signal: 'SIGTERM' }
      }
    });
  });

  test('pumps resident protocol packets before waiting for the channel handshake', async () => {
    const order: string[] = [];
    let releaseHandshake: (() => void) | undefined;
    const handshake = new Promise<void>((resolve) => {
      releaseHandshake = resolve;
    });
    const residentDriver = driver('resident');
    residentDriver.attachChannel = async () => {
      order.push('driver:attaching');
      await handshake;
      order.push('driver:attached');
    };
    residentDriver.accept = async () => {
      order.push('driver:accepted-ready');
      releaseHandshake?.();
    };
    const executor = new SessionEventRuntimeExecutor({
      definition: {
        plan: {
          processModel: 'resident',
          launch: { args: ['serve'], cwd: '/workspace' },
          channel: { kind: 'child-stdio' },
          startup: { timeoutMs: 1_000 }
        },
        driver: residentDriver
      },
      executable: '/bin/provider',
      allowedWorkingRoot: '/workspace',
      workingPath: '/workspace',
      resourceFactory: {
        async start() {
          return activation({ packets: ['ready'], pending: true });
        }
      },
      createObservationEpoch: () => 'epoch-1',
      captureRaw: async () => {},
      consumeEvent: async () => {}
    });

    await executor.open();

    expect(order).toEqual(['driver:attaching', 'driver:accepted-ready', 'driver:attached']);
    expect(executor.snapshot()).toMatchObject({
      lifecycle: { state: 'active' },
      connection: { state: 'connected' }
    });
    await executor.close();
  });

  test('fails resident startup when the channel handshake never becomes ready', async () => {
    const order: string[] = [];
    const residentDriver = driver('resident');
    residentDriver.attachChannel = () => new Promise(() => {});
    residentDriver.dispose = async () => {
      order.push('driver:disposed');
    };
    const executor = new SessionEventRuntimeExecutor({
      definition: {
        plan: {
          processModel: 'resident',
          launch: { args: ['serve'], cwd: '/workspace' },
          channel: { kind: 'child-stdio' },
          startup: { timeoutMs: 5 }
        },
        driver: residentDriver
      },
      executable: '/bin/provider',
      allowedWorkingRoot: '/workspace',
      workingPath: '/workspace',
      resourceFactory: {
        async start() {
          return activation({ order, pending: true });
        }
      },
      createObservationEpoch: () => 'epoch-1',
      captureRaw: async () => {},
      consumeEvent: async () => {}
    });

    await expect(executor.open()).rejects.toThrow('startup timed out after 5ms');

    expect(order).toEqual(['process:killed', 'activation:closed', 'driver:disposed']);
    expect(executor.snapshot()).toMatchObject({
      lifecycle: {
        state: 'terminal',
        termination: { kind: 'failed', error: { message: 'MeshAgent session runtime startup timed out after 5ms' } }
      }
    });
  });

  test('suspends an idle resident process and restores it before accepting the next turn', async () => {
    const order: string[] = [];
    const providerRefs: Array<string | undefined> = [];
    const launches: string[][] = [];
    let starts = 0;
    const residentDriver = driver('resident');
    residentDriver.attachChannel = async () => {
      order.push(`driver:attached:${starts}`);
    };
    residentDriver.sendTurn = async ({ text }) => {
      order.push(`turn:${text}`);
    };
    residentDriver.accept = async (packet, sink) => {
      const message = new TextDecoder().decode(packet.bytes);
      if (message === 'identified') {
        await sink.emit({
          type: 'provider_session_identified',
          payload: { providerSessionRef: 'provider-session-1' }
        });
        return;
      }
      await sink.emit({ type: 'agent_message', payload: { text: 'done', final: true } });
    };
    const executor = new SessionEventRuntimeExecutor({
      definition: {
        plan: {
          processModel: 'resident',
          launch: { args: ['serve'], cwd: '/workspace' },
          buildLaunch: ({ providerSessionRef }) => {
            providerRefs.push(providerSessionRef);
            return {
              args: providerSessionRef ? ['serve', '--resume', providerSessionRef] : ['serve'],
              cwd: '/workspace'
            };
          },
          channel: { kind: 'child-stdio' },
          startup: { timeoutMs: 1_000 },
          suspend: { idleTimeoutMs: 5 }
        },
        driver: residentDriver
      },
      executable: '/bin/provider',
      allowedWorkingRoot: '/workspace',
      workingPath: '/workspace',
      resourceFactory: {
        async start(request) {
          starts += 1;
          launches.push([...request.launch.argv]);
          return activation({
            order,
            pending: true,
            pid: 40 + starts,
            packets: starts === 1 ? ['identified', 'completed'] : []
          });
        }
      },
      createObservationEpoch: () => `epoch-${starts}`,
      captureRaw: async () => {},
      consumeEvent: async () => {}
    });

    await executor.open();
    for (let attempt = 0; attempt < 20 && executor.snapshot().activity.state !== 'suspended'; attempt += 1) {
      await Bun.sleep(5);
    }
    expect(executor.snapshot()).toMatchObject({
      lifecycle: { state: 'active' },
      activity: { state: 'suspended', pid: null }
    });

    await executor.input({ text: 'after idle', attachments: [] });
    expect(starts).toBe(2);
    expect(providerRefs).toEqual([undefined, 'provider-session-1']);
    expect(launches).toEqual([
      ['/bin/provider', 'serve'],
      ['/bin/provider', 'serve', '--resume', 'provider-session-1']
    ]);
    expect(executor.snapshot()).toMatchObject({
      lifecycle: { state: 'active' },
      connection: { state: 'connected' },
      activity: { state: 'running', pid: 42 }
    });
    expect(order).toEqual([
      'driver:attached:1',
      'process:killed',
      'activation:closed',
      'driver:attached:2',
      'turn:after idle'
    ]);
    await executor.close();
  });

  test('returns a resident session to idle when sending a turn fails', async () => {
    const residentDriver = driver('resident');
    residentDriver.sendTurn = async () => {
      throw new Error('send failed');
    };
    const executor = new SessionEventRuntimeExecutor({
      definition: {
        plan: {
          processModel: 'resident',
          launch: { args: ['serve'], cwd: '/workspace' },
          channel: { kind: 'child-stdio' },
          startup: { timeoutMs: 1_000 },
          suspend: { idleTimeoutMs: 60_000 }
        },
        driver: residentDriver
      },
      executable: '/bin/provider',
      allowedWorkingRoot: '/workspace',
      workingPath: '/workspace',
      resourceFactory: {
        async start() {
          return activation({ pending: true });
        }
      },
      createObservationEpoch: () => 'epoch-1',
      captureRaw: async () => {},
      consumeEvent: async () => {}
    });

    await executor.open();
    await expect(executor.input({ text: 'fail to send', attachments: [] })).rejects.toThrow('send failed');
    expect(executor.snapshot()).toMatchObject({
      lifecycle: { state: 'active' },
      connection: { state: 'connected' },
      activity: { state: 'idle', pid: null }
    });
    await executor.close();
  });

  test('treats an unexpected resident process exit as a terminal failure even with exit code zero', async () => {
    const executor = new SessionEventRuntimeExecutor({
      definition: {
        plan: {
          processModel: 'resident',
          launch: { args: ['serve'], cwd: '/workspace' },
          channel: { kind: 'child-stdio' },
          startup: { timeoutMs: 1_000 }
        },
        driver: driver('resident')
      },
      executable: '/bin/provider',
      allowedWorkingRoot: '/workspace',
      workingPath: '/workspace',
      resourceFactory: {
        async start() {
          return activation({ exitCode: 0 });
        }
      },
      createObservationEpoch: () => 'epoch-1',
      captureRaw: async () => {},
      consumeEvent: async () => {}
    });

    await executor.open();
    await Bun.sleep(0);

    expect(executor.snapshot().lifecycle).toMatchObject({
      state: 'terminal',
      termination: {
        kind: 'failed',
        exitCode: 0,
        error: { code: 'session_event_runtime_failed', retryable: false }
      }
    });
  });

  test('stopping mid-attach cancels the attach instead of waiting out the startup timeout', async () => {
    const unhandled: unknown[] = [];
    const track = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', track);
    const order: string[] = [];
    let attachStarted!: () => void;
    const attaching = new Promise<void>((resolve) => {
      attachStarted = resolve;
    });
    const residentDriver = driver('resident');
    let rejectAttach!: (error: Error) => void;
    residentDriver.attachChannel = (channel) => {
      attachStarted();
      // The real driver keeps writing to the child until its own dispose cancels the handshake;
      // model that as an attach that only settles when dispose reaches the driver.
      return new Promise<undefined>((_, reject) => {
        rejectAttach = (error) => {
          void channel.send('late-frame').catch(() => undefined);
          reject(error);
        };
      });
    };
    residentDriver.dispose = async () => {
      order.push('driver:disposed');
      rejectAttach(new Error('EPIPE: broken pipe, write'));
    };
    const definition = residentDefinition();
    definition.driver = residentDriver;
    (definition.plan as ResidentSessionEventPlan).channel = { kind: 'child-stdio' };
    (definition.plan as ResidentSessionEventPlan).startup = { timeoutMs: 30_000 };
    let killed = false;
    const executor = new SessionEventRuntimeExecutor({
      definition,
      executable: '/bin/provider',
      allowedWorkingRoot: '/workspace',
      workingPath: '/workspace',
      resourceFactory: {
        async start() {
          const live = activation({ order, pending: true });
          return {
            ...live,
            process: {
              ...live.process,
              async kill(signal) {
                killed = true;
                await live.process.kill(signal);
              }
            },
            channel: {
              async send() {
                if (killed) throw new Error('EPIPE: broken pipe, write');
              },
              async close() {}
            }
          };
        }
      },
      createObservationEpoch: () => 'epoch-1',
      captureRaw: async () => {},
      consumeEvent: async () => {}
    });

    const opened = executor.open().then(
      () => 'opened',
      (error: unknown) => (error as Error).message
    );
    await attaching;
    const startedAt = Date.now();
    await executor.close();
    const closeMs = Date.now() - startedAt;

    expect(await opened).toBe('EPIPE: broken pipe, write');
    expect(closeMs).toBeLessThan(5_000);
    // The stop tears the child down, disposes the driver to unblock the attach, and the unwinding
    // activation then runs its own idempotent teardown.
    expect(order).toEqual([
      'process:killed',
      'activation:closed',
      'driver:disposed',
      'process:killed',
      'activation:closed'
    ]);
    expect(executor.snapshot().lifecycle).toMatchObject({ state: 'terminal', termination: { kind: 'stopped' } });
    await Bun.sleep(10);
    process.off('unhandledRejection', track);
    expect(unhandled).toEqual([]);
  });
});

test('Bun session-event resources expose child stdio as ordered packets and a framed channel', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'monad-session-event-runtime-'));
  const factory = new BunSessionEventRuntimeResourceFactory({ buildEnv: async (env) => ({ ...env }) });
  try {
    const activation = await factory.start({
      launch: {
        argv: [
          process.execPath,
          '-e',
          "for await (const chunk of Bun.stdin.stream()) { await Bun.write(Bun.stdout, chunk); console.error('err'); break; }"
        ],
        cwd
      },
      channel: { kind: 'child-stdio' },
      startupTimeoutMs: 1_000,
      observationEpoch: 'epoch-test',
      signal: new AbortController().signal
    });
    await activation.channel.send(new TextEncoder().encode('hello'));
    await activation.process.closeStdin?.();
    const packets: Array<{ source: string; text: string }> = [];
    for await (const packet of activation.packets()) {
      packets.push({ source: packet.source, text: new TextDecoder().decode(packet.bytes).trim() });
    }
    expect(await activation.process.result).toEqual({ exitCode: 0 });
    expect(packets).toEqual([
      { source: 'stdout', text: 'hello' },
      { source: 'stderr', text: 'err' }
    ]);
    await activation.close();
  } finally {
    await removeRuntimeDirectory(cwd);
  }
});

test('Bun session-event resources launch and capture a daemon-loopback WebSocket channel', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'monad-session-event-websocket-'));
  const factory = new BunSessionEventRuntimeResourceFactory({ buildEnv: async (env) => ({ ...env }) });
  const controller = new AbortController();
  try {
    const activation = await factory.start({
      launch: {
        argv: [
          process.execPath,
          '-e',
          `const index = process.argv.indexOf('--port');
const port = Number(process.argv[index + 1]);
Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch(request, server) {
    if (server.upgrade(request)) return;
    return new Response('upgrade required', { status: 426 });
  },
  websocket: {
    open(socket) { socket.send('ready'); },
    message(socket, message) { socket.send('echo:' + String(message)); }
  }
});
await new Promise(() => {});`,
          '--'
        ],
        cwd
      },
      channel: {
        kind: 'websocket',
        endpoint: 'daemon-loopback',
        path: '/api/ws',
        query: { token: 'test-token' },
        portArgument: '--port'
      },
      startupTimeoutMs: 3_000,
      observationEpoch: 'epoch-websocket',
      signal: controller.signal
    });
    const iterator = activation.packets()[Symbol.asyncIterator]();
    const ready = await iterator.next();
    await activation.channel.send('hello');
    const echo = await iterator.next();
    expect(
      [ready.value, echo.value].map((packet) => ({
        source: packet?.source,
        text: packet ? new TextDecoder().decode(packet.bytes) : undefined
      }))
    ).toEqual([
      { source: 'provider-channel', text: 'ready' },
      { source: 'provider-channel', text: 'echo:hello' }
    ]);
    controller.abort();
    await activation.close();
  } finally {
    await removeRuntimeDirectory(cwd);
  }
});

test('Bun session-event resources fail closed when unread packets exceed the byte budget', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'monad-session-event-runtime-bounded-'));
  const factory = new BunSessionEventRuntimeResourceFactory({
    buildEnv: async (env) => ({ ...env }),
    maxQueuedPacketBytes: 4
  });
  try {
    const activation = await factory.start({
      launch: { argv: [process.execPath, '-e', "await Bun.write(Bun.stdout, 'overflow')"], cwd },
      channel: { kind: 'child-stdio' },
      startupTimeoutMs: 1_000,
      observationEpoch: 'epoch-bounded',
      signal: new AbortController().signal
    });
    await expect(activation.packets()[Symbol.asyncIterator]().next()).rejects.toThrow('packet queue byte limit');
    await activation.close();
  } finally {
    await removeRuntimeDirectory(cwd);
  }
});
