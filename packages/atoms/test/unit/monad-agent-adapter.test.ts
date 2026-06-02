import type { MeshAgentView } from '@monad/protocol';
import type { MeshAgentSessionEvent } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { MonadSessionEventDriver } from '../../src/agent-adapters/monad/driver.ts';
import { createMonadEventSource } from '../../src/agent-adapters/monad/event-pages.ts';
import { monadMeshAgentAdapter } from '../../src/agent-adapters/monad/index.ts';
import { monadObservationProjection } from '../../src/agent-adapters/monad/observation.ts';

const agent = {
  name: 'monad',
  provider: 'monad',
  productIcon: 'monad',
  command: 'monad',
  enabled: true,
  allowAutopilot: true,
  approvalOwnership: 'provider-owned'
} satisfies MeshAgentView;

function eventRecord(event: { id: string; type: string; payload: Record<string, unknown>; at: string }) {
  return JSON.stringify({
    kind: 'notification',
    method: 'session/event',
    params: {
      event: {
        ...event,
        sessionId: 'ses_MsSXceRDb7hX',
        actorAgentId: null
      }
    }
  });
}

const monadTranscript = [
  JSON.stringify({
    kind: 'response',
    id: '1',
    method: 'initialize',
    result: { protocolVersion: 1, capabilities: {} }
  }),
  JSON.stringify({
    kind: 'notification',
    method: 'session/identified',
    params: { sessionId: 'ses_MsSXceRDb7hX' }
  }),
  eventRecord({
    id: 'evt_000000000000',
    type: 'session.created',
    at: '2026-07-23T11:15:00.000Z',
    payload: { title: 'Monad MeshAgent' }
  }),
  eventRecord({
    id: 'evt_000000000001',
    type: 'session.message.created',
    at: '2026-07-23T11:15:00.636Z',
    payload: {
      transcriptTargetId: 'ses_MsSXceRDb7hX',
      producer: { kind: 'system', subsystem: 'agent-loop' },
      message: {
        id: 'msg_000000000001',
        sessionId: 'ses_MsSXceRDb7hX',
        role: 'user',
        text: 'hi',
        type: 'text',
        stream: { status: 'settled' },
        active: true,
        createdAt: '2026-07-23T11:15:00.635Z'
      },
      messageRevision: 1
    }
  }),
  eventRecord({
    id: 'evt_000000000002',
    type: 'session.message.delta.appended',
    at: '2026-07-23T11:15:01.000Z',
    payload: {
      transcriptTargetId: 'ses_MsSXceRDb7hX',
      producer: { kind: 'system', subsystem: 'agent-loop' },
      messageId: 'msg_000000000002',
      channel: 'reasoning',
      index: 0,
      delta: 'I should answer briefly.'
    }
  }),
  eventRecord({
    id: 'evt_000000000003',
    type: 'session.message.delta.appended',
    at: '2026-07-23T11:15:02.000Z',
    payload: {
      transcriptTargetId: 'ses_MsSXceRDb7hX',
      producer: { kind: 'system', subsystem: 'agent-loop' },
      messageId: 'msg_000000000002',
      channel: 'text',
      index: 0,
      delta: 'O'
    }
  }),
  eventRecord({
    id: 'evt_000000000004',
    type: 'session.message.completed',
    at: '2026-07-23T11:15:03.000Z',
    payload: {
      transcriptTargetId: 'ses_MsSXceRDb7hX',
      producer: { kind: 'system', subsystem: 'agent-loop' },
      message: {
        id: 'msg_000000000002',
        sessionId: 'ses_MsSXceRDb7hX',
        role: 'assistant',
        text: 'OK',
        type: 'text',
        data: { reasoning: 'I should answer briefly.' },
        stream: { status: 'complete' },
        active: true,
        createdAt: '2026-07-23T11:15:01.000Z',
        updatedAt: '2026-07-23T11:15:03.000Z'
      },
      messageRevision: 2
    }
  }),
  eventRecord({
    id: 'evt_000000000005',
    type: 'session.message.created',
    at: '2026-07-23T11:15:04.000Z',
    payload: {
      transcriptTargetId: 'ses_MsSXceRDb7hX',
      producer: { kind: 'system', subsystem: 'agent-loop' },
      message: {
        id: 'msg_000000000003',
        sessionId: 'ses_MsSXceRDb7hX',
        role: 'assistant',
        text: '{"tool":"shell_exec"}',
        type: 'tool_call',
        stream: { status: 'settled' },
        active: true,
        createdAt: '2026-07-23T11:15:04.000Z'
      },
      messageRevision: 3
    }
  })
].join('\n');

test('Monad discovers Studio agents as independently selectable provider agents', () => {
  const probe = monadMeshAgentAdapter.discoverAgents?.(agent);
  expect(probe?.launch).toEqual({ argv: ['monad', 'app-server', '--list-agents'], cwd: process.cwd() });
  expect(
    probe?.parse(
      JSON.stringify({
        agents: [
          { id: 'agt_1234567890ab', name: 'Architect' },
          { id: 'agt_abcdef123456', name: 'Builder' }
        ]
      }),
      0
    )
  ).toEqual([
    {
      externalId: 'agt_1234567890ab',
      displayName: 'Architect',
      adapterSettings: { agentId: 'agt_1234567890ab' }
    },
    {
      externalId: 'agt_abcdef123456',
      displayName: 'Builder',
      adapterSettings: { agentId: 'agt_abcdef123456' }
    }
  ]);
});

test('Monad detection advertises the native structured resident runtime', () => {
  expect(
    monadMeshAgentAdapter.detect({
      which: (command) => (command === 'monad' ? '/opt/bin/monad' : undefined),
      exists: () => false
    })
  ).toEqual({
    id: 'monad',
    label: 'Monad',
    provider: 'monad',
    productIcon: 'monad',
    command: 'monad',
    args: [],
    installHint: 'Install Monad and start its local daemon.',
    installUrl: 'https://monad.co',
    installed: true,
    resolvedBinPath: '/opt/bin/monad',
    capabilities: {
      auth: 'none',
      events: 'provider-owned',
      resume: 'structured',
      approval: 'provider-owned',
      approvalProxy: true
    }
  });
});

test('Monad preserves a source CLI entry before app-server and auth arguments', () => {
  const sourceAgent = {
    ...agent,
    command: 'bun',
    args: ['/repo/apps/cli/src/main.ts'],
    adapterSettings: { agentId: 'agt_1234567890ab' }
  };
  const definition = monadMeshAgentAdapter.createSessionRuntime?.(sourceAgent, { workingPath: '/workspace' });

  expect(definition?.plan).toEqual({
    processModel: 'resident',
    launch: { args: ['/repo/apps/cli/src/main.ts', 'app-server'], cwd: '/workspace' },
    channel: { kind: 'child-stdio' },
    startup: { timeoutMs: 20_000 }
  });
  expect(monadMeshAgentAdapter.buildAuthLaunch(sourceAgent)).toEqual({
    argv: ['bun', '/repo/apps/cli/src/main.ts', '--version'],
    cwd: process.cwd(),
    env: undefined
  });
  expect(monadMeshAgentAdapter.discoverAgents?.(sourceAgent).launch).toEqual({
    argv: ['bun', '/repo/apps/cli/src/main.ts', 'app-server', '--list-agents'],
    cwd: process.cwd()
  });
});

test('Monad resident events preserve approval gate keys for host escape decisions', async () => {
  const driver = new MonadSessionEventDriver('agt_1234567890ab', '/workspace');
  const events: MeshAgentSessionEvent[] = [];

  await driver.accept(
    {
      source: 'provider-channel',
      bytes: new TextEncoder().encode(
        `${eventRecord({
          id: 'evt_appr00000000',
          type: 'tool.approval_requested',
          at: '2026-07-28T00:00:00.000Z',
          payload: {
            requestId: 'approval-host',
            tool: 'code_execute',
            key: 'target:host',
            input: { code: 'return process.cwd()' }
          }
        })}\n`
      ),
      receivedAt: '2026-07-28T00:00:00.001Z'
    },
    {
      async emit(event) {
        events.push(event);
      }
    }
  );

  expect(events).toEqual([
    {
      type: 'approval_requested',
      payload: {
        requestId: 'approval-host',
        kind: 'tool',
        tool: 'code_execute',
        key: 'target:host',
        input: { code: 'return process.cwd()' }
      }
    }
  ]);
});

test('Monad resident events keep stderr diagnostics out of the JSON protocol stream', async () => {
  const driver = new MonadSessionEventDriver('agt_1234567890ab', '/workspace');
  const events: MeshAgentSessionEvent[] = [];
  const sink = {
    async emit(event: MeshAgentSessionEvent) {
      events.push(event);
    }
  };

  await driver.accept(
    {
      source: 'stderr',
      bytes: new TextEncoder().encode('error: daemon diagnostic\n'),
      receivedAt: '2026-08-03T06:51:47.000Z'
    },
    sink
  );
  await driver.accept(
    {
      source: 'stdout',
      bytes: new TextEncoder().encode(
        `${eventRecord({
          id: 'evt_stderr000001',
          type: 'session.message.delta.appended',
          at: '2026-08-03T06:51:48.000Z',
          payload: {
            transcriptTargetId: 'ses_MsSXceRDb7hX',
            producer: { kind: 'system', subsystem: 'agent-loop' },
            messageId: 'msg_stderr000001',
            channel: 'text',
            index: 0,
            delta: 'OK'
          }
        })}\n`
      ),
      receivedAt: '2026-08-03T06:51:48.001Z'
    },
    sink
  );

  expect(events).toEqual([{ type: 'agent_message', payload: { text: 'OK' } }]);
});

test('Monad channel startup reports a broken pipe without leaving a pending handshake', async () => {
  const driver = new MonadSessionEventDriver('agt_1234567890ab', '/workspace');
  let closes = 0;

  await expect(
    driver.attachChannel(
      {
        async send() {
          const error = new Error('broken pipe') as Error & { code: string };
          error.code = 'EPIPE';
          throw error;
        },
        async close() {
          closes += 1;
        }
      },
      {}
    )
  ).rejects.toMatchObject({ code: 'EPIPE', message: 'broken pipe' });
  await driver.dispose();

  expect(closes).toBe(1);
});

test('Monad channel startup preserves bounded stderr when the app-server exits during handshake', async () => {
  const driver = new MonadSessionEventDriver('agt_1234567890ab', '/workspace');
  const opening = driver.attachChannel(
    {
      async send() {},
      async close() {}
    },
    {}
  );
  await driver.accept(
    {
      source: 'stderr',
      bytes: new TextEncoder().encode('error: local daemon socket is unavailable\n'),
      receivedAt: '2026-08-03T07:30:00.000Z'
    },
    { async emit() {} }
  );
  await driver.dispose();

  await expect(opening).rejects.toThrow('Monad app-server closed: error: local daemon socket is unavailable');
});

test('Monad projects real app-server user, reasoning, and assistant records without delta duplication', () => {
  const events = monadMeshAgentAdapter.events.projectLive({
    id: 'mesh_monad',
    output: monadTranscript,
    providerSessionRef: 'ses_MsSXceRDb7hX'
  }).events;

  expect(
    events.map((event) => ({
      role: event.role,
      text: event.text,
      providerEventType: event.providerEventType,
      activity: monadObservationProjection.classifyActivity(event)
    }))
  ).toEqual([
    {
      role: 'user',
      text: 'hi',
      providerEventType: 'session.message.created',
      activity: 'user'
    },
    {
      role: 'agent',
      text: 'I should answer briefly.',
      providerEventType: 'session.message.completed:reasoning',
      activity: 'thinking'
    },
    {
      role: 'agent',
      text: 'OK',
      providerEventType: 'session.message.completed',
      activity: 'message'
    }
  ]);
});

test('Monad provider history pages use the same projection as live records', async () => {
  const source = createMonadEventSource(async () => monadTranscript);
  const page = await source.readPage?.(
    {
      providerSessionRef: 'ses_MsSXceRDb7hX',
      workingPath: '/workspace'
    },
    { view: 'convenience', limit: 20 }
  );

  expect(
    page?.state === 'available' && page.view === 'convenience'
      ? page.events.map(({ role, text, providerEventType }) => ({ role, text, providerEventType }))
      : page
  ).toEqual([
    { role: 'user', text: 'hi', providerEventType: 'session.message.created' },
    {
      role: 'agent',
      text: 'I should answer briefly.',
      providerEventType: 'session.message.completed:reasoning'
    },
    { role: 'agent', text: 'OK', providerEventType: 'session.message.completed' }
  ]);
});

test('Monad live projection keeps reasoning and assistant identities stable when completed records settle deltas', () => {
  const records = monadTranscript.split('\n');
  const completedIndex = records.findIndex((record) => record.includes('"type":"session.message.completed"'));
  const projector = monadMeshAgentAdapter.events.createLiveProjector?.({
    id: 'mesh_monad',
    providerSessionRef: 'ses_MsSXceRDb7hX'
  });
  const partial = projector?.advance(`${records.slice(0, completedIndex).join('\n')}\n`).events ?? [];
  const settled = projector?.advance(`${records.slice(completedIndex).join('\n')}\n`).events ?? [];

  expect(
    partial
      .filter((event) => event.role === 'agent')
      .map((event) => ({
        id: event.id,
        text: event.text,
        streaming: monadObservationProjection.isStreamingFragment(event)
      }))
  ).toEqual([
    {
      id: 'mesh_monad:message:msg_000000000002:reasoning',
      text: 'I should answer briefly.',
      streaming: true
    },
    {
      id: 'mesh_monad:message:msg_000000000002:text',
      text: 'O',
      streaming: true
    }
  ]);
  expect(
    settled
      .filter((event) => event.role === 'agent')
      .map((event) => ({
        id: event.id,
        text: event.text,
        streaming: monadObservationProjection.isStreamingFragment(event)
      }))
  ).toEqual([
    {
      id: 'mesh_monad:message:msg_000000000002:reasoning',
      text: 'I should answer briefly.',
      streaming: false
    },
    {
      id: 'mesh_monad:message:msg_000000000002:text',
      text: 'OK',
      streaming: false
    }
  ]);
});
