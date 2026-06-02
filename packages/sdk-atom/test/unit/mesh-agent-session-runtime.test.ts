import type {
  MeshAgentEventSink,
  MeshAgentProviderDriver,
  MeshAgentSessionEvent,
  PerTurnProviderDriver,
  ResidentProviderDriver,
  SessionEventChannelPlan,
  SessionEventRuntimeDefinition
} from '../../src/index.ts';

import { expect, test } from 'bun:test';

const controls = {
  approvalResolution: false,
  steer: false,
  interrupt: false
} as const;

const residentDriver: ResidentProviderDriver = {
  processModel: 'resident',
  controls,
  openSession: async () => ({
    capabilities: {
      input: true,
      steer: false,
      interrupt: false,
      approvalResolution: false,
      providerSessionContinuation: true,
      runtimeRestoration: true,
      sessionReopen: true
    }
  }),
  accept: async () => {},
  attachChannel: async () => {},
  sendTurn: async () => {},
  dispose: async () => {}
};

const perTurnDriver: PerTurnProviderDriver = {
  processModel: 'per-turn',
  controls,
  openSession: async () => ({
    capabilities: {
      input: true,
      steer: false,
      interrupt: true,
      approvalResolution: false,
      providerSessionContinuation: true,
      runtimeRestoration: false,
      sessionReopen: true
    }
  }),
  accept: async (_packet, sink) => {
    await sink.emit({
      type: 'provider_session_identified',
      payload: { providerSessionRef: 'thread-1' }
    });
  },
  attachTurnChannel: async () => {},
  completeTurn: async () => {},
  dispose: async () => {}
};

const resident = {
  plan: {
    processModel: 'resident',
    launch: { args: ['app-server', '--stdio'], cwd: '/workspace' },
    channel: { kind: 'child-stdio' },
    startup: { timeoutMs: 10_000 }
  },
  driver: residentDriver
} satisfies SessionEventRuntimeDefinition;

const perTurn = {
  plan: {
    processModel: 'per-turn',
    buildTurnLaunch: ({ providerSessionRef }) => ({
      args: providerSessionRef ? ['exec', 'resume', providerSessionRef, '--json'] : ['exec', '--json'],
      cwd: '/workspace'
    }),
    encodeTurnInput: (input) => ({ delivery: 'stdin', bytes: new TextEncoder().encode(input.text) }),
    startup: { timeoutMs: 10_000 },
    continuation: { strategy: 'provider-session-ref' }
  },
  driver: perTurnDriver
} satisfies SessionEventRuntimeDefinition;

test('runtime definitions preserve their process-model discriminants', () => {
  expect([resident.plan.processModel, perTurn.plan.processModel]).toEqual(['resident', 'per-turn']);
  expect([resident.driver.processModel, perTurn.driver.processModel]).toEqual(['resident', 'per-turn']);
});

test('drivers emit provider session identity through the awaitable sink', async () => {
  const events: MeshAgentSessionEvent[] = [];
  const sink: MeshAgentEventSink = {
    emit: async (event) => {
      events.push(event);
    }
  };

  await perTurnDriver.accept(
    { bytes: new Uint8Array(), receivedAt: '2026-07-19T00:00:00.000Z', source: 'provider-channel' },
    sink
  );

  expect(events).toEqual([{ type: 'provider_session_identified', payload: { providerSessionRef: 'thread-1' } }]);
});

// @ts-expect-error resident drivers require attachChannel and sendTurn
const invalidResidentDriver: ResidentProviderDriver = {
  processModel: 'resident',
  controls,
  openSession: residentDriver.openSession,
  accept: residentDriver.accept,
  dispose: residentDriver.dispose
};

// @ts-expect-error per-turn drivers require attachTurnChannel and completeTurn
const invalidPerTurnDriver: PerTurnProviderDriver = {
  processModel: 'per-turn',
  controls,
  openSession: perTurnDriver.openSession,
  accept: perTurnDriver.accept,
  dispose: perTurnDriver.dispose
};

const invalidEndpoint: SessionEventChannelPlan = {
  kind: 'websocket',
  endpoint: 'daemon-loopback',
  // @ts-expect-error adapters cannot choose a channel host
  host: 'example.com'
};

const drivers: MeshAgentProviderDriver[] = [invalidResidentDriver, invalidPerTurnDriver];
void invalidEndpoint;
void drivers;
