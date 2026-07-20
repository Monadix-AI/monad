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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
      cwd: '/workspace/project',
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
      cwd: '/workspace',
      stdin: new TextEncoder().encode('hello')
    });
    expect(
      materializeTurnLaunch({
        executable: '/bin/provider',
        allowedWorkingRoot: '/workspace',
        plan: launch,
        input: { delivery: 'argv-tail', separator: '--', values: ['hello', '--danger'] }
      })
    ).toEqual({ argv: ['/bin/provider', 'exec', '--json', '--', 'hello', '--danger'], cwd: '/workspace' });
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
      },
      result: args?.pending ? new Promise(() => {}) : Promise.resolve({ exitCode: args?.exitCode ?? 0 })
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
      lifecycle: { state: 'terminal', termination: { kind: 'stopped' } }
    });
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
    rmSync(cwd, { recursive: true, force: true });
  }
});
