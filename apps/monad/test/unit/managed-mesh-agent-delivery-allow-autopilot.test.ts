import type { MeshAgentConfig } from '@monad/environment';
import type { Event, MeshSessionId, MeshSessionView, Session, SessionId } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { expect, test } from 'bun:test';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';

import { createManagedMeshAgentDelivery } from '#/handlers/session/handlers/managed-mesh-agent-delivery.ts';
import { EventBus, makeEvent } from '#/services/event-bus.ts';
import { registerAgentAdapterImpl } from '#/services/mesh-agent/index.ts';
import { createStore } from '#/store/db/index.ts';

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
  const lifecycleCalls: Array<{ kind: 'queue' | 'start' | 'settle'; deliveryId: string }> = [];
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
    enqueueNativeAgentIngressItem: () => ({ deliveryId: 'deliv_test00000000' }),
    bindNativeAgentIngressDelivery: () => true,
    getNativeAgentMemberGate: () => null,
    markMeshAgentInboxDelivered: () => {},
    markMeshAgentInboxVisible: () => {},
    findManagedMeshAgentStreamingMessage: () => undefined,
    insertMessage: () => {},
    // Project-message delivery still reads session_members; direct delivery reads the canonical graph.
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
    ],
    getSession: () => ({ id: 'ses_delegated000', projectId: 'prj_delegated00' }),
    listSessionBindings: () => [{ sessionId: 'ses_delegated000', projectMemberId: 'codex', lifecycle: 'active' }],
    getProjectMember: (_projectId: string, id: string) =>
      id === 'codex'
        ? {
            id: 'codex',
            projectId: 'prj_delegated00',
            profileId: 'codex',
            type: 'mesh-agent',
            displayName: 'codex',
            customPrompt: null,
            launchOverrides: { managedProjectAgent: true, allowAutopilot: false },
            workingDirectoryOverride: null,
            lifecycle: 'enabled'
          }
        : null
  };
  const ctx = {
    deps: { store, log: undefined, meshAgentHost },
    managedAgentSessions: {
      queue: ({ deliveryId }: { deliveryId: string }) => lifecycleCalls.push({ kind: 'queue', deliveryId }),
      startTurn: ({ deliveryId }: { deliveryId: string }) => lifecycleCalls.push({ kind: 'start', deliveryId }),
      settleTurn: ({ deliveryId }: { deliveryId: string }) => lifecycleCalls.push({ kind: 'settle', deliveryId })
    },
    messageIngress: {
      begin: () => Promise.resolve({ id: 'msg_delegated00' }),
      deliver: rejectUnexpectedDeliveryError
    },
    makeEmit: () => () => {},
    persistAndRetire: () => {}
  } as unknown as SessionContext;
  return { delivery: createManagedMeshAgentDelivery(ctx), lifecycleCalls, startCalls };
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
    projectId: 'prj_delegated00',
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

test('project-message runtime failures stay on the MeshSession contract instead of persisting chat errors', async () => {
  const persistedErrors: string[] = [];
  const store = {
    maxMessageSeq: () => 0,
    listSessionMembers: () => [
      {
        sessionId: 'ses_runtimefail00',
        memberId: 'codex',
        templateId: null,
        type: 'mesh-agent',
        meshSessionId: null,
        data: { name: 'codex', settings: { managedProjectAgent: true } },
        createdAt: '',
        updatedAt: ''
      }
    ],
    getNativeAgentMemberGate: () => null,
    findManagedMeshAgentStreamingMessage: () => undefined
  };
  const ctx = {
    deps: {
      store,
      log: undefined,
      meshAgentHost: {
        list: () => ({ sessions: [] }),
        preflight: async () => ({ state: 'ready' as const }),
        start: async () => {
          throw new Error('gateway process exited with status 78');
        }
      }
    },
    messageIngress: {
      begin: () => Promise.resolve({ id: 'msg_runtimefail0' }),
      deliver: async (command: { text: string }) => {
        persistedErrors.push(command.text);
        return {} as never;
      }
    },
    makeEmit: () => () => {},
    persistAndRetire: () => {}
  } as unknown as SessionContext;

  await createManagedMeshAgentDelivery(ctx).deliverProjectMessageToManagedMeshAgentMembers({
    session: {
      id: 'ses_runtimefail00',
      cwd: '/tmp/prj',
      origin: { client: 'workplace' }
    } as unknown as Session,
    meshAgents,
    text: 'start the task'
  });

  expect(persistedErrors).toEqual([]);
});

test('direct-message delivery threads a delegated member allowAutopilot to host.start (matches project delivery)', async () => {
  const { delivery, lifecycleCalls, startCalls } = buildHarness();
  const session = sessionWithDelegatedCodexMember();
  await delivery.deliverDirectMessageToManagedMeshAgentMember({
    session,
    meshAgents,
    message: {
      id: 'msg_direct000001',
      sessionId: session.id,
      meshSessionId: 'mesh_sender00001',
      fromAgent: 'monad',
      peer: 'codex',
      text: 'hi',
      createdAt: '2026-07-21T00:00:00.000Z'
    },
    noticeText: 'hi'
  });
  expect(startCalls).toEqual([{ agentName: 'codex', allowAutopilot: false }]);
  expect(lifecycleCalls).toEqual([
    { kind: 'queue', deliveryId: 'deliv_test00000000' },
    { kind: 'start', deliveryId: 'deliv_test00000000' },
    { kind: 'settle', deliveryId: 'deliv_test00000000' }
  ]);
});

test('direct delivery to a provider-available canonical member cold-starts a runtime, takes ownership, and delivers the DM', async () => {
  const store = createStore();
  const at = '2026-07-21T00:00:00.000Z';
  const sessionId = 'ses_directlive01' as SessionId;
  const projectId = 'prj_directlive01';
  const recipient = 'pmem_recipient01';
  const newRuntimeId = 'mesh_reclive00001' as MeshSessionId;
  try {
    // Canonical fixture only: project + session (with a working path) + a recipient ProjectMember + active
    // SessionBinding whose profile matches an enabled spec — NO running runtime and NO legacy session_members.
    store.insertWorkplaceProject({
      id: projectId,
      title: 'live',
      state: 'active',
      archived: false,
      memberTemplates: [],
      createdAt: at,
      updatedAt: at
    });
    store.insertSession({
      id: sessionId,
      projectId,
      title: 'live',
      state: 'active',
      agentIds: [],
      archived: false,
      restoreCount: 0,
      cwd: '/tmp/prj',
      activityAt: at,
      createdAt: at,
      updatedAt: at
    } as unknown as Session);
    store.insertProjectMember({
      id: recipient,
      projectId,
      profileId: 'codex',
      type: 'mesh-agent',
      displayName: 'Recipient',
      customPrompt: null,
      launchOverrides: { managedProjectAgent: true },
      workingDirectoryOverride: null,
      lifecycle: 'enabled',
      createdAt: at,
      updatedAt: at
    });
    store.insertSessionBinding({
      sessionId,
      projectMemberId: recipient,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      lifecycle: 'active',
      createdAt: at,
      updatedAt: at
    });
    store.insertNativeAgentDirectMessage({
      id: 'msg_directlive01',
      sessionId,
      meshSessionId: 'mesh_sender000001',
      fromAgent: 'pmem_senderlive1',
      peer: recipient,
      text: 'live handoff',
      createdAt: at
    });

    const startCalls: Array<{ agentName: string; projectMemberId: string; initialInput: string }> = [];
    const emitted: Event[] = [];
    const meshAgentHost = {
      list: () => ({ sessions: [] }),
      preflight: async () => ({ state: 'ready' as const }),
      // Mirror the real host: record the start, create the runtime row, and take ownership of the binding.
      start: async (args: {
        agentName: string;
        projectMemberId: string;
        initialInput: string;
        transcriptTargetId: string;
      }) => {
        startCalls.push({
          agentName: args.agentName,
          projectMemberId: args.projectMemberId,
          initialInput: args.initialInput
        });
        store.upsertMeshSession({
          id: newRuntimeId,
          transcriptTargetId: sessionId,
          agentName: args.agentName,
          provider: 'codex',
          workingPath: '/tmp/prj',
          runtimeRole: 'managed-project-agent',
          agentRuntimeId: newRuntimeId,
          agentRuntimeTokenHash: null,
          lastDeliveredSeq: 0,
          lastVisibleSeq: 0,
          state: 'running',
          pid: 123,
          providerSessionRef: null,
          outputSnapshot: '',
          exitCode: null,
          startedAt: at,
          updatedAt: at,
          exitedAt: null
        });
        store.replaceSessionBindingRuntime({
          sessionId,
          projectMemberId: args.projectMemberId,
          currentNativeRuntimeSessionId: newRuntimeId,
          updatedAt: at
        });
        return { id: newRuntimeId, agentName: args.agentName } as unknown as MeshSessionView;
      },
      input: async () => {}
    };
    const meshAgents = [
      { name: 'codex', provider: 'codex', command: 'codex', enabled: true } as unknown as MeshAgentConfig
    ];
    const ctx = {
      deps: { store, log: undefined, meshAgentHost },
      managedAgentSessions: { queue: () => {}, startTurn: () => {}, settleTurn: () => {} },
      messageIngress: {
        begin: () => Promise.resolve({ id: 'msg_thinking0001' }),
        deliver: async () => {}
      },
      makeEmit: (round: Event[]) => (event: Event) => {
        round.push(event);
        emitted.push(event);
      },
      persistAndRetire: () => {}
    } as unknown as SessionContext;

    await createManagedMeshAgentDelivery(ctx).deliverDirectMessageToManagedMeshAgentMember({
      session: store.getSession(sessionId) as Session,
      meshAgents,
      message: store.getNativeAgentDirectMessage('msg_directlive01') as NonNullable<
        ReturnType<typeof store.getNativeAgentDirectMessage>
      >,
      noticeText: 'live handoff'
    });

    // 1. runtime start called exactly once, addressed by the recipient's canonical projectMemberId.
    expect(startCalls.map(({ agentName, projectMemberId }) => ({ agentName, projectMemberId }))).toEqual([
      { agentName: recipient, projectMemberId: recipient }
    ]);
    // 3. the DM body reached the runtime as its initial input — proof delivery crossed the host guard.
    expect(startCalls[0]?.initialInput).toContain('live handoff');
    // 2. ownership established: the recipient's binding now points at the freshly started runtime.
    expect(store.getSessionBinding(sessionId, recipient)?.currentNativeRuntimeSessionId).toBe(newRuntimeId);
    // 4. no synthetic connection-required event was emitted along the way.
    expect(emitted.map((event) => event.type)).not.toContain('mesh.connection_required');
  } finally {
    store.close();
  }
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
        projectMemberId: agentName,
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
    enqueueNativeAgentIngressItem: () => ({ deliveryId: 'deliv_test00000001' }),
    bindNativeAgentIngressDelivery: () => true,
    getNativeAgentMemberGate: () => null,
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
    enqueueMeshAgentInboxItem: () => {
      transitions.push('ingress-persisted');
      return true;
    },
    enqueueNativeAgentIngressItem: () => ({ deliveryId: 'deliv_test00000002' }),
    claimNativeAgentIngressBatch: ({ id }: { id: string }) => ({
      id,
      highWaterSeq: 1,
      itemIds: ['ingress_nonblocking']
    }),
    listClaimedNativeAgentIngress: () => [
      {
        ingressSeq: 1,
        source: 'project' as const,
        deliveryId: 'deliv_test00000002',
        text: 'queued reply',
        createdAt: '2026-07-30T00:00:00.000Z',
        messageSeq: 21,
        messageId: 'msg_trigger000000',
        sender: { kind: 'human' as const, name: 'Human' }
      }
    ],
    markNativeAgentIngressBatchDelivered: () => true,
    consumeNativeAgentIngressBatch: () => {
      transitions.push('ingress-consumed');
    },
    releaseNativeAgentIngressBatch: () => {
      transitions.push('ingress-released');
    },
    bindNativeAgentIngressDelivery: () => true,
    getNativeAgentMemberGate: () => null,
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
          projectMemberId: 'sonnet',
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
    persistAndRetire: () => {},
    managedAgentSessions: {
      queue: () => transitions.push('session-queued'),
      startTurn: () => transitions.push('turn-started'),
      settleTurn: () => transitions.push('turn-settled')
    }
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
    expect(transitions).toEqual([
      'ingress-persisted',
      'session-queued',
      'turn-started',
      'input-started',
      'fanout-returned'
    ]);
  } finally {
    resolveInputCompletion();
    await fanout;
  }
  await Bun.sleep(0);
  expect(transitions).toEqual([
    'ingress-persisted',
    'session-queued',
    'turn-started',
    'input-started',
    'fanout-returned',
    'input-finished',
    'ingress-consumed',
    'delivered:21',
    'visible:21',
    'turn-settled'
  ]);
});

test('project-message fan-out resumes a pending unauthenticated member after login resolves', async () => {
  const bus = new EventBus();
  const inputs: Array<{ id: string; input: string }> = [];
  const starts: Array<{ agentName: string; templateAgentName?: string; initialInput: string }> = [];
  const lifecycle: Array<{ kind: 'queue' | 'start' | 'settle'; deliveryId: string }> = [];
  let ingressState: 'queued' | 'claimed' | 'consumed' = 'queued';
  let claimBatchId: string | undefined;
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
    enqueueNativeAgentIngressItem: () => ({ deliveryId: 'deliv_test00000003' }),
    claimNativeAgentIngressBatch: ({ id }: { id: string }) => {
      claimBatchId = id;
      if (ingressState === 'queued') ingressState = 'claimed';
      return { id, highWaterSeq: 1, itemIds: ingressState === 'claimed' ? ['ingress_loginretry'] : [] };
    },
    listClaimedNativeAgentIngress: (id: string) =>
      ingressState === 'claimed' && id === claimBatchId
        ? [
            {
              ingressSeq: 1,
              source: 'project' as const,
              deliveryId: 'deliv_test00000003',
              text: 'initial project task',
              createdAt: '2026-07-22T00:00:00.000Z',
              messageSeq: 12,
              messageId: 'msg_userlogin000',
              sender: { kind: 'human' as const, name: 'Human' }
            }
          ]
        : [],
    markNativeAgentIngressBatchDelivered: () => true,
    consumeNativeAgentIngressBatch: () => {
      ingressState = 'consumed';
    },
    releaseNativeAgentIngressBatch: () => {
      if (ingressState === 'claimed') ingressState = 'queued';
    },
    bindNativeAgentIngressDelivery: () => true,
    getNativeAgentMemberGate: () => null,
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
    managedAgentSessions: {
      queue: ({ deliveryId }: { deliveryId: string }) => lifecycle.push({ kind: 'queue', deliveryId }),
      startTurn: ({ deliveryId }: { deliveryId: string }) => lifecycle.push({ kind: 'start', deliveryId }),
      settleTurn: ({ deliveryId }: { deliveryId: string }) => lifecycle.push({ kind: 'settle', deliveryId })
    },
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
  expect(lifecycle.map((entry) => entry.kind)).toEqual(['queue', 'settle']);
  bus.publish(
    makeEvent('ses_loginretry00' as never, 'mesh.login_resolved', {
      agentName: 'sonnet',
      authAgentName: 'claude-code',
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
  expect(starts[0]?.initialInput).toContain('"messages":[{"ingressSeq":1,"source":"project"');
  expect(lifecycle.map((entry) => entry.kind)).toEqual(['queue', 'settle', 'queue', 'start', 'settle']);
  expect(String(ingressState)).toBe('consumed');
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
    enqueueNativeAgentIngressItem: () => ({ deliveryId: 'deliv_test00000004' }),
    bindNativeAgentIngressDelivery: () => true,
    getNativeAgentMemberGate: () => null,
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
      authAgentName: 'claude-code',
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
    maxMessageSeq: () => 0,
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
    getSession: () => ({ id: 'ses_missing00000', projectId: 'prj_missing00000' }),
    listSessionBindings: () => [
      { sessionId: 'ses_missing00000', projectMemberId: 'pmem_claude_sonnet', lifecycle: 'active' }
    ],
    getProjectMember: (_projectId: string, id: string) =>
      id === 'pmem_claude_sonnet'
        ? {
            id: 'pmem_claude_sonnet',
            projectId: 'prj_missing00000',
            profileId: 'claude-code',
            type: 'mesh-agent',
            displayName: 'Sonnet',
            customPrompt: null,
            launchOverrides: { managedProjectAgent: true },
            workingDirectoryOverride: null,
            lifecycle: 'enabled'
          }
        : null
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
    message: {
      id: 'msg_direct000002',
      sessionId: 'ses_missing00000',
      meshSessionId: 'mesh_sender00002',
      fromAgent: 'monad',
      peer: 'pmem_claude_sonnet',
      text: 'direct wake',
      createdAt: '2026-07-21T00:00:00.000Z'
    },
    noticeText: 'direct wake'
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
    enqueueNativeAgentIngressItem: () => ({ deliveryId: 'deliv_test00000005' }),
    bindNativeAgentIngressDelivery: () => true,
    getNativeAgentMemberGate: () => null,
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
          projectMemberId: 'sonnet',
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
        'New Workplace Project message is available.\nReview this room broadcast now.\nA broadcast wake does not require a public reply. Reply only if you can add concrete task value; otherwise take no public action.\n\nMessage metadata:\nSender kind: mesh-agent\nSender name: gpt\nSender id: gpt\nSender mention token: @[name="gpt" id="mesh-agent:gpt"]\n\nProject message body:\nGPT reply\n'
    }
  ]);
});
