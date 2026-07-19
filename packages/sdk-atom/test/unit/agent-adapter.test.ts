import type { MeshAgentView } from '@monad/protocol';
import type {
  MeshAgentEventSource,
  MeshAgentProviderAdapter,
  MeshAgentProviderEventContext,
  MeshAgentSessionRuntimeContext,
  SessionEventRuntimeDefinition
} from '../../src/index.ts';

import { expect, test } from 'bun:test';

test('MeshAgent event source returns raw and convenience views through one page contract', async () => {
  const source: MeshAgentEventSource = {
    projectLive: () => ({ events: [] }),
    readPage: async (_context, request) =>
      request.view === 'raw'
        ? { state: 'available', view: 'raw', records: [], coverage: 'exact', nextCursor: 'next' }
        : { state: 'available', view: 'convenience', events: [], nextCursor: 'next' }
  };
  const eventContext: MeshAgentProviderEventContext = {
    providerSessionRef: 'provider-session',
    workingPath: '/tmp/project'
  };

  expect(await source.readPage?.(eventContext, { view: 'convenience', limit: 20 })).toEqual({
    state: 'available',
    view: 'convenience',
    events: [],
    nextCursor: 'next'
  });
  expect(await source.readPage?.(eventContext, { view: 'raw', limit: 20 })).toEqual({
    state: 'available',
    view: 'raw',
    records: [],
    coverage: 'exact',
    nextCursor: 'next'
  });
});

test('MeshAgent adapters can add a session runtime factory without changing legacy hooks', () => {
  let receivedContext: MeshAgentSessionRuntimeContext | undefined;
  const runtime: SessionEventRuntimeDefinition = {
    plan: {
      processModel: 'per-turn',
      buildTurnLaunch: ({ providerSessionRef }) => ({
        args: providerSessionRef ? ['resume', providerSessionRef] : ['start'],
        cwd: '/tmp/project'
      }),
      encodeTurnInput: (input) => ({ delivery: 'stdin', bytes: new TextEncoder().encode(input.text) }),
      startup: { timeoutMs: 1_000 },
      continuation: { strategy: 'provider-session-ref' }
    },
    driver: {
      processModel: 'per-turn',
      controls: { approvalResolution: false, steer: false, interrupt: false },
      openSession: async () => ({
        capabilities: {
          input: true,
          steer: false,
          interrupt: false,
          approvalResolution: false,
          providerSessionContinuation: true,
          runtimeRestoration: false,
          sessionReopen: true
        }
      }),
      accept: async () => {},
      attachTurnChannel: async () => {},
      completeTurn: async () => {},
      dispose: async () => {}
    }
  };
  const adapter = {
    createSessionRuntime: (_agent, context) => {
      receivedContext = context;
      return runtime;
    }
  } satisfies Pick<MeshAgentProviderAdapter, 'createSessionRuntime'>;
  const agent = {
    name: 'codex',
    provider: 'codex',
    command: 'codex',
    enabled: true,
    allowAutopilot: true,
    approvalOwnership: 'provider-owned'
  } satisfies MeshAgentView;

  const result = adapter.createSessionRuntime(agent, {
    workingPath: '/tmp/project',
    providerSessionRef: 'thread-1'
  });

  expect({ context: receivedContext, processModel: result.plan.processModel }).toEqual({
    context: { workingPath: '/tmp/project', providerSessionRef: 'thread-1' },
    processModel: 'per-turn'
  });
});
