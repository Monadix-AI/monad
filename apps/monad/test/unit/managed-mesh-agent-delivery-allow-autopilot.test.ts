import type { MeshAgentConfig } from '@monad/environment';
import type { Event, MeshSessionView, Session } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { expect, test } from 'bun:test';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';

import { createManagedMeshAgentDelivery } from '#/handlers/session/handlers/managed-mesh-agent-delivery.ts';
import { EventBus, makeEvent } from '#/services/event-bus.ts';
import { registerAgentAdapterImpl } from '#/services/mesh-agent/index.ts';

// Notice-building (e.g. `usesMcpProjectBridge`) reads the adapter registry, so it must be populated
// like every other mesh-agent test — mirrors mesh-agent-host.test.ts / mesh-agent-adapters.test.ts.
for (const adapter of builtinAgentAdapters) registerAgentAdapterImpl(adapter);

async function rejectUnexpectedDeliveryError(command: { text: string }): Promise<never> {
  throw new Error(`unexpected managed MeshAgent delivery error: ${command.text}`);
}

// Regression test: `deliverProjectMessageToManagedMeshAgentMembers` (inbox delivery) and
// `deliverDirectMessageToManagedMeshAgentMember` (direct-message delivery) both build their
// `startManagedMeshAgentRuntimeWithRecovery` call from the same member `settings` object — they must
// thread every field identically, including `allowAutopilot`. A prior version of the direct-message
// path silently dropped it, so a member with `allowAutopilot: false` (delegated approvals) would
// start in full autopilot when a direct message (not a project message) cold-started its session.
function buildHarness() {
  const startCalls: Array<{ agentName: string; allowAutopilot?: boolean }> = [];
  const meshAgentHost = {
    start: async (args: { agentName: string; allowAutopilot?: boolean }) => {
      startCalls.push({
        agentName: args.agentName,
        allowAutopilot: args.allowAutopilot
      });
      return {
        id: 'mesh_codex0000000',
        agentName: args.agentName
      } as unknown as MeshSessionView;
    },
    input: () => {},
    list: () => ({ sessions: [] }),
    preflight: async () => ({ state: 'ready' as const })
  };
  const store = {
    maxMessageSeq: () => 0,
    markMeshAgentInboxDelivered: () => {},
    markMeshAgentInboxVisible: () => {},
    findManagedMeshAgentStreamingMessage: () => undefined,
    insertMessage: () => {},
    // Track B: managed members are now read from session_members, not origin.ext.
    listSessionMembers: () => [
      {
        sessionId: 'ses_delegated000',
        memberId: 'codex',
        templateId: null,
        type: 'mesh-agent',
        meshSessionId: null,
        data: {
          name: 'codex',
          settings: { managedProjectAgent: true, allowAutopilot: false }
        },
        createdAt: '',
        updatedAt: ''
      }
    ]
  };
  const ctx = {
    deps: { store, log: undefined, meshAgentHost },
    messageIngress: {
      begin: () => Promise.resolve({ id: 'msg_delegated00' }),
      deliver: rejectUnexpectedDeliveryError
    },
    makeEmit: () => () => {},
    persistAndRetire: () => {}
  } as unknown as SessionContext;
  return { delivery: createManagedMeshAgentDelivery(ctx), startCalls };
}

const meshAgents: MeshAgentConfig[] = [
  {
    name: 'codex',
    provider: 'codex',
    command: 'codex',
    enabled: true
  } as unknown as MeshAgentConfig
];

function sessionWithDelegatedCodexMember(): Session {
  return {
    id: 'ses_delegated000',
    cwd: '/tmp/prj',
    origin: { client: 'workplace' }
  } as unknown as Session;
}

test('project-message delivery threads a delegated member allowAutopilot to host.start', async () => {
  const { delivery, startCalls } = buildHarness();
  const session = sessionWithDelegatedCodexMember();
  await delivery.deliverProjectMessageToManagedMeshAgentMembers({
    session,
    meshAgents,
    text: 'hi'
  });
  expect(startCalls).toEqual([{ agentName: 'codex', allowAutopilot: false }]);
});

test('direct-message delivery threads a delegated member allowAutopilot to host.start (matches project delivery)', async () => {
  const { delivery, startCalls } = buildHarness();
  const session = sessionWithDelegatedCodexMember();
  await delivery.deliverDirectMessageToManagedMeshAgentMember({
    session,
    meshAgents,
    fromAgentName: 'monad',
    to: 'codex',
    text: 'hi'
  });
  expect(startCalls).toEqual([{ agentName: 'codex', allowAutopilot: false }]);
});

test('project-message fan-out keeps every member inbox pinned to the original message', async () => {
  let maxMessageSeq = 340;
  const enqueued: Array<{
    meshSessionId: string;
    messageSeq: number;
    triggerMessageId?: string;
  }> = [];
  const members = ['gpt', 'sonnet'].map((name) => ({
    sessionId: 'ses_fanout000000',
    memberId: name,
    templateId: null,
    type: 'mesh-agent',
    meshSessionId: name === 'gpt' ? 'mesh_gpt000000000' : 'mesh_sonnet000000',
    data: {
      name,
      displayName: name.toUpperCase(),
      settings: { managedProjectAgent: true }
    },
    createdAt: '',
    updatedAt: ''
  }));
  const sessions = ['gpt', 'sonnet'].map(
    (agentName) =>
      ({
        id: agentName === 'gpt' ? 'mesh_gpt000000000' : 'mesh_sonnet000000',
        agentName,
        runtimeRole: 'managed-project-agent',
        lifecycle: { state: 'active' },
        activity: { state: 'idle', pid: null, queuedTurnCount: 0 },
        lastDeliveredSeq: 0,
        lastVisibleSeq: 0
      }) as unknown as MeshSessionView
  );
  const store = {
    listSessionMembers: () => members,
    maxMessageSeq: () => maxMessageSeq,
    messageIdForSeq: () => 'msg_sonnet_thinking',
    messageSeq: (_sessionId: string, messageId: string) => (messageId === 'msg_opus_original' ? 338 : 0),
    enqueueMeshAgentInboxItem: (meshSessionId: string, messageSeq: number, metadata: { triggerMessageId?: string }) => {
      enqueued.push({
        meshSessionId,
        messageSeq,
        triggerMessageId: metadata.triggerMessageId
      });
      return true;
    },
    markMeshAgentInboxDelivered: () => {},
    markMeshAgentInboxVisible: () => {},
    findManagedMeshAgentStreamingMessage: () => undefined,
    insertMessage: () => {
      maxMessageSeq += 1;
    }
  };
  const meshAgentHost = {
    list: () => ({ sessions }),
    input: async () => {},
    preflight: async () => ({ state: 'ready' as const })
  };
  const ctx = {
    deps: { store, log: undefined, meshAgentHost },
    messageIngress: {
      begin: () => {
        maxMessageSeq += 1;
        return Promise.resolve({
          id: maxMessageSeq === 339 ? 'msg_gpt_thinking' : 'msg_sonnet_thinking'
        });
      },
      deliver: rejectUnexpectedDeliveryError
    },
    makeEmit: () => () => {},
    persistAndRetire: () => {}
  } as unknown as SessionContext;
  const fanoutAgents = ['gpt', 'sonnet'].map(
    (name) =>
      ({
        name,
        provider: name === 'gpt' ? 'codex' : 'claude-code',
        command: name,
        enabled: true
      }) as unknown as MeshAgentConfig
  );

  await createManagedMeshAgentDelivery(ctx).deliverProjectMessageToManagedMeshAgentMembers({
    session: {
      id: 'ses_fanout000000',
      cwd: '/tmp/prj',
      origin: { client: 'workplace' }
    } as unknown as Session,
    meshAgents: fanoutAgents,
    text: 'Opus message',
    triggerMessageId: 'msg_opus_original'
  });

  expect(enqueued).toEqual([
    {
      meshSessionId: 'mesh_gpt000000000',
      messageSeq: 338,
      triggerMessageId: 'msg_opus_original'
    },
    {
      meshSessionId: 'mesh_sonnet000000',
      messageSeq: 338,
      triggerMessageId: 'msg_opus_original'
    }
  ]);
});

test('active project-message fan-out returns after queueing without waiting for the recipient turn', async () => {
  let resolveInputStarted!: () => void;
  let resolveInputCompletion!: () => void;
  const inputStarted = new Promise<void>((resolve) => {
    resolveInputStarted = resolve;
  });
  const inputCompletion = new Promise<void>((resolve) => {
    resolveInputCompletion = resolve;
  });
  const transitions: string[] = [];
  const store = {
    listSessionMembers: () => [
      {
        sessionId: 'ses_nonblocking00',
        memberId: 'sonnet',
        templateId: null,
        type: 'mesh-agent',
        meshSessionId: 'mesh_sonnet000000',
        data: {
          name: 'sonnet',
          displayName: 'Sonnet',
          settings: { managedProjectAgent: true }
        },
        createdAt: '',
        updatedAt: ''
      }
    ],
    messageSeq: () => 21,
    enqueueMeshAgentInboxItem: () => true,
    markMeshAgentInboxVisible: (_meshSessionId: string, seq: number) => {
      transitions.push(`visible:${seq}`);
    },
    markMeshAgentInboxDelivered: (_meshSessionId: string, seq: number) => {
      transitions.push(`delivered:${seq}`);
    },
    findManagedMeshAgentStreamingMessage: () => undefined
  };
  const meshAgentHost = {
    list: () => ({
      sessions: [
        {
          id: 'mesh_sonnet000000',
          agentName: 'sonnet',
          runtimeRole: 'managed-project-agent',
          lifecycle: { state: 'active' },
          activity: { state: 'running', pid: 123, queuedTurnCount: 0 },
          lastDeliveredSeq: 20,
          lastVisibleSeq: 20
        } as unknown as MeshSessionView
      ]
    }),
    input: async () => {
      transitions.push('input-started');
      resolveInputStarted();
      await inputCompletion;
      transitions.push('input-finished');
    },
    preflight: async () => ({ state: 'ready' as const })
  };
  const ctx = {
    deps: { store, log: undefined, meshAgentHost },
    messageIngress: {
      begin: () => Promise.resolve({ id: 'msg_sonnet_thinking' }),
      deliver: rejectUnexpectedDeliveryError
    },
    makeEmit: () => () => {},
    persistAndRetire: () => {}
  } as unknown as SessionContext;

  const fanout = createManagedMeshAgentDelivery(ctx)
    .deliverProjectMessageToManagedMeshAgentMembers({
      session: {
        id: 'ses_nonblocking00',
        cwd: '/tmp/prj',
        origin: { client: 'workplace' }
      } as unknown as Session,
      meshAgents: [
        {
          name: 'sonnet',
          provider: 'claude-code',
          command: 'claude',
          enabled: true
        } as unknown as MeshAgentConfig
      ],
      text: 'queued reply',
      triggerMessageId: 'msg_trigger000000'
    })
    .then(() => {
      transitions.push('fanout-returned');
    });

  await inputStarted;
  await Bun.sleep(0);
  try {
    expect(transitions).toEqual(['input-started', 'fanout-returned']);
  } finally {
    resolveInputCompletion();
    await fanout;
  }
  await Bun.sleep(0);
  expect(transitions).toEqual(['input-started', 'fanout-returned', 'input-finished', 'visible:21', 'delivered:21']);
});

test('project-message fan-out resumes a pending unauthenticated member after login resolves', async () => {
  const bus = new EventBus();
  const inputs: Array<{ id: string; input: string }> = [];
  const starts: Array<{ agentName: string; templateAgentName?: string; initialInput: string }> = [];
  let preflightCalls = 0;
  const store = {
    listSessionMembers: () => [
      {
        sessionId: 'ses_loginretry00',
        memberId: 'sonnet',
        templateId: null,
        type: 'mesh-agent',
        meshSessionId: null,
        data: {
          name: 'claude-code',
          instanceId: 'sonnet',
          settings: { managedProjectAgent: true }
        },
        createdAt: '',
        updatedAt: ''
      }
    ],
    maxMessageSeq: () => 12,
    messageSeq: (_sessionId: string, messageId: string) => (messageId === 'msg_userlogin000' ? 12 : 0),
    messageIdForSeq: () => 'msg_userlogin000',
    enqueueMeshAgentInboxItem: () => true,
    markMeshAgentInboxDelivered: () => {},
    markMeshAgentInboxVisible: () => {},
    findManagedMeshAgentStreamingMessage: () => undefined,
    insertMessage: () => {}
  };
  const meshAgentHost = {
    list: () => ({ sessions: [] }),
    preflight: async () =>
      preflightCalls++ === 0
        ? {
            state: 'not_authenticated' as const,
            agentName: 'claude-code',
            provider: 'claude-code',
            checkedAt: new Date(0).toISOString(),
            action: 'reconnect_in_studio' as const,
            reason: 'Reconnect claude-code in Studio before using it in this project.'
          }
        : {
            state: 'ready' as const,
            agentName: 'claude-code',
            provider: 'claude-code',
            checkedAt: new Date(0).toISOString()
          },
    start: async (args: { agentName: string; templateAgentName?: string; initialInput: string }) => {
      starts.push({
        agentName: args.agentName,
        templateAgentName: args.templateAgentName,
        initialInput: args.initialInput
      });
      return {
        id: 'mesh_sonnetretry0',
        agentName: args.agentName,
        runtimeRole: 'managed-project-agent',
        lifecycle: { state: 'active' },
        activity: { state: 'idle', pid: null, queuedTurnCount: 0 },
        lastDeliveredSeq: 0,
        lastVisibleSeq: 0
      } as unknown as MeshSessionView;
    },
    input: async (id: string, payload: { input: string }) => {
      inputs.push({ id, input: payload.input });
    }
  };
  const ctx = {
    deps: { store, log: undefined, meshAgentHost, bus },
    messageIngress: {
      begin: () => Promise.resolve({ id: 'msg_thinking0001' }),
      deliver: rejectUnexpectedDeliveryError
    },
    makeEmit: (round: Event[]) => (event: Event) => {
      round.push(event);
      bus.publish(event);
    },
    persistAndRetire: () => {}
  } as unknown as SessionContext;

  await createManagedMeshAgentDelivery(ctx).deliverProjectMessageToManagedMeshAgentMembers({
    session: {
      id: 'ses_loginretry00',
      cwd: '/tmp/prj',
      projectId: 'prj_loginretry00',
      origin: { client: 'workplace' }
    } as unknown as Session,
    meshAgents: [
      {
        name: 'claude-code',
        provider: 'claude-code',
        command: 'claude',
        enabled: true
      } as unknown as MeshAgentConfig
    ],
    text: 'initial project task',
    triggerMessageId: 'msg_userlogin000'
  });

  expect(starts).toEqual([]);
  expect(inputs).toEqual([]);
  bus.publish(
    makeEvent('ses_loginretry00' as never, 'mesh.login_resolved', {
      agentName: 'sonnet',
      provider: 'claude-code'
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(starts).toEqual([
    {
      agentName: 'sonnet',
      templateAgentName: 'claude-code',
      initialInput: expect.stringContaining('initial project task')
    }
  ]);
  expect(inputs).toEqual([]);
});

test('project-message fan-out treats provider auth start failures as login-required and retries after login', async () => {
  const bus = new EventBus();
  const connectionRequired: unknown[] = [];
  const inputs: Array<{ id: string; input: string }> = [];
  const startInputs: string[] = [];
  let startCalls = 0;
  bus.subscribe('ses_loginthrow00' as never, (event) => {
    if (event.type === 'mesh.connection_required') connectionRequired.push(event.payload);
  });
  const store = {
    listSessionMembers: () => [
      {
        sessionId: 'ses_loginthrow00',
        memberId: 'opus',
        templateId: null,
        type: 'mesh-agent',
        meshSessionId: null,
        data: {
          name: 'claude-code',
          instanceId: 'opus',
          settings: { managedProjectAgent: true }
        },
        createdAt: '',
        updatedAt: ''
      }
    ],
    maxMessageSeq: () => 15,
    messageSeq: (_sessionId: string, messageId: string) => (messageId === 'msg_userthrow000' ? 15 : 0),
    messageIdForSeq: () => 'msg_userthrow000',
    enqueueMeshAgentInboxItem: () => true,
    markMeshAgentInboxDelivered: () => {},
    markMeshAgentInboxVisible: () => {},
    findManagedMeshAgentStreamingMessage: () => undefined,
    insertMessage: () => {}
  };
  const meshAgentHost = {
    list: () => ({ sessions: [] }),
    preflight: async () => ({
      state: 'ready' as const,
      agentName: 'claude-code',
      provider: 'claude-code',
      checkedAt: new Date(0).toISOString()
    }),
    start: async (args: { agentName: string; initialInput: string }) => {
      startCalls += 1;
      startInputs.push(args.initialInput);
      if (startCalls === 1) throw new Error('Claude Code is not logged in; please run /login');
      return {
        id: 'mesh_opusretry000',
        agentName: args.agentName,
        runtimeRole: 'managed-project-agent',
        lifecycle: { state: 'active' },
        activity: { state: 'idle', pid: null, queuedTurnCount: 0 },
        lastDeliveredSeq: 0,
        lastVisibleSeq: 0
      } as unknown as MeshSessionView;
    },
    input: async (id: string, payload: { input: string }) => {
      inputs.push({ id, input: payload.input });
    }
  };
  const ctx = {
    deps: { store, log: undefined, meshAgentHost, bus },
    messageIngress: {
      begin: () => Promise.resolve({ id: 'msg_throwthink00' }),
      deliver: rejectUnexpectedDeliveryError
    },
    makeEmit: (round: Event[]) => (event: Event) => {
      round.push(event);
      bus.publish(event);
    },
    persistAndRetire: () => {}
  } as unknown as SessionContext;

  await createManagedMeshAgentDelivery(ctx).deliverProjectMessageToManagedMeshAgentMembers({
    session: {
      id: 'ses_loginthrow00',
      cwd: '/tmp/prj',
      projectId: 'prj_loginthrow00',
      origin: { client: 'workplace' }
    } as unknown as Session,
    meshAgents: [
      {
        name: 'claude-code',
        provider: 'claude-code',
        command: 'claude',
        enabled: true
      } as unknown as MeshAgentConfig
    ],
    text: 'retry after thrown auth failure',
    triggerMessageId: 'msg_userthrow000'
  });

  expect(connectionRequired).toEqual([
    expect.objectContaining({
      agentName: 'opus',
      authAgentName: 'claude-code',
      provider: 'claude-code',
      code: 'provider_connection_required'
    })
  ]);
  expect(inputs).toEqual([]);
  bus.publish(
    makeEvent('ses_loginthrow00' as never, 'mesh.login_resolved', {
      agentName: 'opus',
      provider: 'claude-code'
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(startCalls).toBe(2);
  expect(startInputs).toEqual([
    expect.stringContaining('retry after thrown auth failure'),
    expect.stringContaining('retry after thrown auth failure')
  ]);
  expect(inputs).toEqual([]);
});

test('project-message fan-out emits connection_required when a project member adapter is disabled', async () => {
  const emitted: Event[] = [];
  const store = {
    listSessionMembers: () => [
      {
        sessionId: 'ses_disabled0000',
        memberId: 'pmem_claude_opus',
        templateId: null,
        type: 'mesh-agent',
        meshSessionId: null,
        data: {
          name: 'claude-code',
          instanceId: 'pmem_claude_opus',
          displayName: 'Opus',
          settings: { managedProjectAgent: true }
        },
        createdAt: '',
        updatedAt: ''
      }
    ]
  };
  const ctx = {
    deps: { store, log: undefined },
    messageIngress: {
      begin: () => Promise.resolve({ id: 'msg_unused0000' }),
      deliver: rejectUnexpectedDeliveryError
    },
    makeEmit: (round: Event[]) => (event: Event) => {
      round.push(event);
      emitted.push(event);
    },
    persistAndRetire: () => {}
  } as unknown as SessionContext;

  await createManagedMeshAgentDelivery(ctx).deliverProjectMessageToManagedMeshAgentMembers({
    session: {
      id: 'ses_disabled0000',
      cwd: '/tmp/prj',
      origin: { client: 'workplace' }
    } as unknown as Session,
    meshAgents: [
      {
        name: 'claude-code',
        provider: 'claude-code',
        command: 'claude',
        enabled: false
      } as unknown as MeshAgentConfig
    ],
    text: 'wake disabled claude'
  });

  expect(emitted.map((event) => [event.type, event.payload])).toEqual([
    [
      'mesh.connection_required',
      {
        agentName: 'pmem_claude_opus',
        authAgentName: 'claude-code',
        provider: 'claude-code',
        code: 'provider_disabled',
        reason: 'MeshAgent adapter "claude-code" is disabled. Enable it in Studio before using it in this project.',
        reconnectIn: 'studio'
      }
    ]
  ]);
});

test('direct managed MeshAgent delivery emits connection_required when the project member adapter is missing', async () => {
  const emitted: Event[] = [];
  const store = {
    listSessionMembers: () => [
      {
        sessionId: 'ses_missing00000',
        memberId: 'pmem_claude_sonnet',
        templateId: null,
        type: 'mesh-agent',
        meshSessionId: null,
        data: {
          name: 'claude-code',
          instanceId: 'pmem_claude_sonnet',
          displayName: 'Sonnet',
          settings: { managedProjectAgent: true }
        },
        createdAt: '',
        updatedAt: ''
      }
    ]
  };
  const ctx = {
    deps: { store, log: undefined },
    messageIngress: {
      begin: () => Promise.resolve({ id: 'msg_unused0001' }),
      deliver: rejectUnexpectedDeliveryError
    },
    makeEmit: (round: Event[]) => (event: Event) => {
      round.push(event);
      emitted.push(event);
    },
    persistAndRetire: () => {}
  } as unknown as SessionContext;

  await createManagedMeshAgentDelivery(ctx).deliverDirectMessageToManagedMeshAgentMember({
    session: {
      id: 'ses_missing00000',
      cwd: '/tmp/prj',
      origin: { client: 'workplace' }
    } as unknown as Session,
    meshAgents: [],
    fromAgentName: 'monad',
    to: 'pmem_claude_sonnet',
    text: 'direct wake'
  });

  expect(emitted.map((event) => [event.type, event.payload])).toEqual([
    [
      'mesh.connection_required',
      {
        agentName: 'pmem_claude_sonnet',
        authAgentName: 'claude-code',
        provider: 'claude-code',
        code: 'provider_unavailable',
        reason:
          'MeshAgent adapter "claude-code" is not configured. Reconnect it in Studio before using it in this project.',
        reconnectIn: 'studio'
      }
    ]
  ]);
});

test('a stale unreadable delivery does not suppress the wake for a new readable inbox item', async () => {
  const inputs: Array<{ id: string; input: string }> = [];
  const store = {
    listSessionMembers: () => [
      {
        sessionId: 'ses_fanout000000',
        memberId: 'sonnet',
        templateId: null,
        type: 'mesh-agent',
        meshSessionId: 'mesh_sonnet000000',
        data: {
          name: 'sonnet',
          displayName: 'Sonnet',
          settings: { managedProjectAgent: true }
        },
        createdAt: '',
        updatedAt: ''
      }
    ],
    messageSeq: (_sessionId: string, messageId: string) => (messageId === 'msg_gpt_reply' ? 345 : 0),
    countMeshAgentInbox: () => 0,
    enqueueMeshAgentInboxItem: () => true,
    markMeshAgentInboxDelivered: () => {},
    markMeshAgentInboxVisible: () => {},
    findManagedMeshAgentStreamingMessage: () => undefined
  };
  const meshAgentHost = {
    list: () => ({
      sessions: [
        {
          id: 'mesh_sonnet000000',
          agentName: 'sonnet',
          runtimeRole: 'managed-project-agent',
          lifecycle: { state: 'active' },
          activity: { state: 'idle', pid: null, queuedTurnCount: 0 },
          lastDeliveredSeq: 344,
          lastVisibleSeq: 341
        } as unknown as MeshSessionView
      ]
    }),
    input: async (id: string, payload: { input: string }) => {
      inputs.push({ id, input: payload.input });
    },
    preflight: async () => ({ state: 'ready' as const })
  };
  const ctx = {
    deps: { store, log: undefined, meshAgentHost },
    messageIngress: {
      begin: () => Promise.resolve({ id: 'msg_sonnet_thinking' }),
      deliver: rejectUnexpectedDeliveryError
    },
    makeEmit: () => () => {},
    persistAndRetire: () => {}
  } as unknown as SessionContext;

  await createManagedMeshAgentDelivery(ctx).deliverProjectMessageToManagedMeshAgentMembers({
    session: {
      id: 'ses_fanout000000',
      cwd: '/tmp/prj',
      origin: { client: 'workplace' }
    } as unknown as Session,
    meshAgents: [
      {
        name: 'sonnet',
        provider: 'claude-code',
        command: 'claude',
        enabled: true
      } as unknown as MeshAgentConfig
    ],
    text: 'GPT reply',
    sender: { kind: 'mesh-agent', name: 'gpt', id: 'gpt' },
    triggerMessageId: 'msg_gpt_reply'
  });

  expect(inputs).toEqual([
    {
      id: 'mesh_sonnet000000',
      input:
        'New Workplace Project message is available.\nProcess this project message now.\n\nMessage metadata:\nSender kind: mesh-agent\nSender name: gpt\nSender id: gpt\nSender mention token: @[name="gpt" id="mesh-agent:gpt"]\n\nProject message body:\nGPT reply\n'
    }
  ]);
});
