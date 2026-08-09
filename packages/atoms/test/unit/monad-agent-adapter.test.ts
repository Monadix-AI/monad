import type { MeshAgentView } from '@monad/protocol';
import type { MeshAgentSessionEvent } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { MonadSessionEventDriver } from '../../src/agent-adapters/monad/driver.ts';
import { createMonadEventSource } from '../../src/agent-adapters/monad/event-pages.ts';
import { monadMeshAgentAdapter } from '../../src/agent-adapters/monad/index.ts';
import { monadObservationProjection } from '../../src/agent-adapters/monad/observation.ts';
import { toAgentObservationEvent } from '../../src/agent-adapters/neutral-observation.ts';

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

test('Monad opens managed sessions with immutable instructions in the app-server contract', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const driver = new MonadSessionEventDriver(
    'agt_1234567890ab',
    '/workspace',
    undefined,
    undefined,
    'Managed Monad instructions'
  );
  const sink = { async emit() {} };
  const channel = {
    async send(value: string) {
      const request = JSON.parse(value) as Record<string, unknown>;
      requests.push(request);
      const method = request.method;
      const response =
        method === 'initialize'
          ? {
              kind: 'response',
              id: request.id,
              method,
              result: {
                protocolVersion: 1,
                capabilities: {
                  input: true,
                  steer: true,
                  interrupt: true,
                  approvalResolution: true,
                  providerSessionContinuation: true,
                  runtimeRestoration: true,
                  sessionReopen: true
                }
              }
            }
          : {
              kind: 'response',
              id: request.id,
              method,
              result: { sessionId: 'ses_MsSXceRDb7hX' }
            };
      queueMicrotask(() => {
        void driver.accept(
          {
            source: 'stdout',
            bytes: new TextEncoder().encode(`${JSON.stringify(response)}\n`),
            receivedAt: '2026-08-09T00:00:00.000Z'
          },
          sink
        );
      });
    },
    async close() {}
  };

  await driver.attachChannel(channel, {});

  expect(requests[1]).toEqual({
    kind: 'request',
    id: '2',
    method: 'session/open',
    params: {
      agentId: 'agt_1234567890ab',
      cwd: '/workspace',
      immutableInstructions: 'Managed Monad instructions'
    }
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
    },
    {
      role: 'tool',
      text: 'Tool call shell_exec',
      providerEventType: 'tool.called',
      activity: 'tool-call'
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
    { role: 'agent', text: 'OK', providerEventType: 'session.message.completed' },
    { role: 'tool', text: 'Tool call shell_exec', providerEventType: 'tool.called' }
  ]);
});

test('Monad projects a compact directive as one context compaction event with its summary', () => {
  const output = [
    eventRecord({
      id: 'evt_200000000001',
      type: 'session.message.created',
      at: '2026-08-09T16:31:44.246Z',
      payload: {
        transcriptTargetId: 'ses_MsSXceRDb7hX',
        producer: { kind: 'system', subsystem: 'command' },
        message: {
          id: 'msg_200000000001',
          sessionId: 'ses_MsSXceRDb7hX',
          role: 'user',
          text: '/compact',
          type: 'directive',
          stream: { status: 'settled' },
          active: true,
          createdAt: '2026-08-09T16:31:44.245Z'
        },
        messageRevision: 23
      }
    }),
    eventRecord({
      id: 'evt_200000000002',
      type: 'session.message.created',
      at: '2026-08-09T16:31:44.249Z',
      payload: {
        transcriptTargetId: 'ses_MsSXceRDb7hX',
        producer: { kind: 'system', subsystem: 'command' },
        message: {
          id: 'msg_200000000002',
          sessionId: 'ses_MsSXceRDb7hX',
          role: 'assistant',
          text: 'Context compacted.',
          type: 'directive',
          data: { effect: { type: 'compacted', compacted: 16, summary: 'Earlier project context.' } },
          stream: { status: 'settled' },
          active: true,
          createdAt: '2026-08-09T16:31:44.249Z'
        },
        messageRevision: 24
      }
    })
  ].join('\n');
  const projected = monadMeshAgentAdapter.events.projectLive({
    id: 'mesh_monad_compact',
    output,
    providerSessionRef: 'ses_MsSXceRDb7hX'
  }).events;

  expect(
    projected.map((event) => {
      const neutral = toAgentObservationEvent(event, monadObservationProjection);
      return {
        id: neutral?.id,
        kind: neutral?.kind,
        streaming: neutral?.streaming,
        text: neutral?.text,
        summary: neutral?.summary,
        at: neutral?.at,
        providerEventType: event.providerEventType
      };
    })
  ).toEqual([
    {
      id: 'mesh_monad_compact:message:msg_200000000002:context-compaction',
      kind: 'context-compaction',
      streaming: false,
      text: 'Context compacted',
      summary: 'Earlier project context.',
      at: '2026-08-09T16:31:44.249Z',
      providerEventType: 'contextCompaction'
    }
  ]);
});

test('Monad provider history restores tool events before later assistant messages', async () => {
  const output = [
    eventRecord({
      id: 'evt_100000000003',
      type: 'session.message.completed',
      at: '2026-08-09T13:21:39.987Z',
      payload: {
        transcriptTargetId: 'ses_MsSXceRDb7hX',
        producer: { kind: 'system', subsystem: 'agent-loop' },
        message: {
          id: 'msg_100000000003',
          sessionId: 'ses_MsSXceRDb7hX',
          role: 'assistant',
          text: 'The project post completed.',
          type: 'text',
          stream: { status: 'complete' },
          active: true,
          createdAt: '2026-08-09T13:21:39.148Z',
          updatedAt: '2026-08-09T13:21:39.987Z'
        },
        messageRevision: 7
      }
    }),
    eventRecord({
      id: 'evt_100000000001',
      type: 'tool.called',
      at: '2026-08-09T13:21:07.641Z',
      payload: {
        toolCallId: 'call_project_post',
        tool: 'monad__project_post',
        input: { text: 'Joined', requestId: 'req_join' }
      }
    }),
    eventRecord({
      id: 'evt_100000000002',
      type: 'tool.result',
      at: '2026-08-09T13:21:33.656Z',
      payload: {
        toolCallId: 'call_project_post',
        tool: 'monad__project_post',
        ok: true,
        result: '{"ok":true}'
      }
    }),
    eventRecord({
      id: 'evt_100000000004',
      type: 'session.message.created',
      at: '2026-08-09T13:21:07.642Z',
      payload: {
        transcriptTargetId: 'ses_MsSXceRDb7hX',
        producer: { kind: 'system', subsystem: 'agent-loop' },
        message: {
          id: 'msg_100000000004',
          sessionId: 'ses_MsSXceRDb7hX',
          role: 'assistant',
          text: '{"tool":"monad__project_post","input":{"text":"Joined"}}',
          type: 'tool_call',
          data: {
            toolCallId: 'call_project_post',
            toolName: 'monad__project_post',
            input: { text: 'Joined' }
          },
          stream: { status: 'settled' },
          active: true,
          createdAt: '2026-08-09T13:21:07.642Z'
        },
        messageRevision: 4
      }
    }),
    eventRecord({
      id: 'evt_100000000005',
      type: 'session.message.created',
      at: '2026-08-09T13:21:33.657Z',
      payload: {
        transcriptTargetId: 'ses_MsSXceRDb7hX',
        producer: { kind: 'system', subsystem: 'agent-loop' },
        message: {
          id: 'msg_100000000005',
          sessionId: 'ses_MsSXceRDb7hX',
          role: 'tool',
          text: '{"ok":true}',
          type: 'tool_result',
          data: {
            toolCallId: 'call_project_post',
            toolName: 'monad__project_post',
            output: '{"ok":true}',
            ok: true
          },
          stream: { status: 'settled' },
          active: true,
          createdAt: '2026-08-09T13:21:33.657Z'
        },
        messageRevision: 5
      }
    }),
    eventRecord({
      id: 'evt_100000000006',
      type: 'session.message.created',
      at: '2026-08-09T13:21:34.000Z',
      payload: {
        transcriptTargetId: 'ses_MsSXceRDb7hX',
        producer: { kind: 'system', subsystem: 'agent-loop' },
        message: {
          id: 'msg_100000000006',
          sessionId: 'ses_MsSXceRDb7hX',
          role: 'assistant',
          text: '{"tool":"monad__agent_send","input":{"text":"Continue"}}',
          type: 'tool_call',
          data: {
            toolCallId: 'call_message_only',
            toolName: 'monad__agent_send',
            input: { text: 'Continue' }
          },
          stream: { status: 'settled' },
          active: true,
          createdAt: '2026-08-09T13:21:34.000Z'
        },
        messageRevision: 6
      }
    }),
    eventRecord({
      id: 'evt_100000000007',
      type: 'session.message.created',
      at: '2026-08-09T13:21:35.000Z',
      payload: {
        transcriptTargetId: 'ses_MsSXceRDb7hX',
        producer: { kind: 'system', subsystem: 'agent-loop' },
        message: {
          id: 'msg_100000000007',
          sessionId: 'ses_MsSXceRDb7hX',
          role: 'tool',
          text: 'Delivered',
          type: 'tool_result',
          data: {
            toolCallId: 'call_message_only',
            toolName: 'monad__agent_send',
            output: 'Delivered',
            ok: true
          },
          stream: { status: 'settled' },
          active: true,
          createdAt: '2026-08-09T13:21:35.000Z'
        },
        messageRevision: 7
      }
    })
  ].join('\n');
  const source = createMonadEventSource(async () => output);
  const page = await source.readPage?.(
    { providerSessionRef: 'ses_MsSXceRDb7hX', workingPath: '/workspace' },
    { view: 'convenience', limit: 20 }
  );
  const events = page?.state === 'available' && page.view === 'convenience' ? page.events : [];

  expect(
    events.map((event) => ({
      id: event.id,
      role: event.role,
      text: event.text,
      at: event.createdAt,
      providerEventType: event.providerEventType,
      dedupeKey: event.dedupeKey
    }))
  ).toEqual([
    {
      id: 'ses_MsSXceRDb7hX:tool:call_project_post:call',
      role: 'tool',
      text: 'Tool call monad__project_post',
      at: '2026-08-09T13:21:07.641Z',
      providerEventType: 'tool.called',
      dedupeKey: 'monad:tool:call_project_post:tool:tool.called'
    },
    {
      id: 'ses_MsSXceRDb7hX:tool:call_project_post:result',
      role: 'tool',
      text: '{"ok":true}',
      at: '2026-08-09T13:21:33.656Z',
      providerEventType: 'tool.result',
      dedupeKey: 'monad:tool:call_project_post:tool:tool.result'
    },
    {
      id: 'ses_MsSXceRDb7hX:tool:call_message_only:call',
      role: 'tool',
      text: 'Tool call monad__agent_send',
      at: '2026-08-09T13:21:34.000Z',
      providerEventType: 'tool.called',
      dedupeKey: 'monad:tool:call_message_only:tool:tool.called'
    },
    {
      id: 'ses_MsSXceRDb7hX:tool:call_message_only:result',
      role: 'tool',
      text: 'Delivered',
      at: '2026-08-09T13:21:35.000Z',
      providerEventType: 'tool.result',
      dedupeKey: 'monad:tool:call_message_only:tool:tool.result'
    },
    {
      id: 'ses_MsSXceRDb7hX:message:msg_100000000003:text',
      role: 'agent',
      text: 'The project post completed.',
      at: '2026-08-09T13:21:39.987Z',
      providerEventType: 'session.message.completed',
      dedupeKey: 'monad:f34ba295:agent:session.message.completed'
    }
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
