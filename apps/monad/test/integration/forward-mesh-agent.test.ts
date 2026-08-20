import type { Session, SessionId } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { createForwardMeshAgentHandler } from '#/handlers/session/handlers/forward-mesh-agent.ts';
import { EventBus } from '#/services/event-bus.ts';
import { createMessageIngress } from '#/services/messages/ingress.ts';
import { createStore } from '#/store/db/index.ts';

test('managed forwarding preserves an absent configured display name for the runtime fallback', async () => {
  const store = createStore();
  const now = new Date().toISOString();
  const session = {
    id: newId('ses') as SessionId,
    title: 'Workplace: Test',
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0
    },
    costUsd: 0,
    cwd: process.cwd(),
    createdAt: now,
    updatedAt: now
  } satisfies Session;
  store.insertSession(session);
  store.insertSessionMember({
    sessionId: session.id,
    memberId: 'pmem_codex_1',
    templateId: 'pmem_codex_template',
    type: 'mesh-agent',
    data: {
      name: 'codex',
      instanceId: 'pmem_codex_1',
      settings: { managedProjectAgent: true }
    },
    createdAt: now,
    updatedAt: now
  });
  const starts: Array<Record<string, unknown>> = [];
  const ctx = {
    deps: {
      store,
      configManager: {
        get: () => ({
          cfg: {
            agent: { agents: [] },
            meshAgents: [
              {
                name: 'codex',
                provider: 'codex',
                productIcon: 'codex',
                command: 'codex',
                enabled: true,
                allowAutopilot: false,
                approvalOwnership: 'provider-owned'
              }
            ]
          }
        })
      },
      meshAgentHost: {
        list: () => ({ sessions: [] }),
        preflight: async () => ({ state: 'ready' })
      }
    },
    requireSession: () => session,
    messageIngress: createMessageIngress({ store, bus: new EventBus() }),
    makeEmit: (round: unknown[]) => (event: unknown) => round.push(event),
    persistAndRetire: () => {}
  } as unknown as SessionContext;
  const forward = createForwardMeshAgentHandler(ctx, async (args) => {
    starts.push(args);
    return { id: 'mesh_forward000001' } as never;
  });

  try {
    await forward({ sessionId: session.id, agentName: 'pmem_codex_1', text: 'review this' });

    expect(starts).toEqual([
      {
        session,
        spec: {
          name: 'codex',
          provider: 'codex',
          productIcon: 'codex',
          command: 'codex',
          enabled: true,
          allowAutopilot: false,
          approvalOwnership: 'provider-owned'
        },
        projectMemberId: 'pmem_codex_1',
        runtimeAgentName: 'pmem_codex_1',
        templateAgentName: 'codex',
        displayName: undefined,
        reasoningEffort: undefined,
        modelId: undefined,
        speed: undefined,
        customPrompt: undefined,
        allowAutopilot: undefined,
        providerSessionRef: undefined,
        input: 'review this'
      }
    ]);
  } finally {
    store.close();
  }
});

test('forwarding to an ambiguous template alias starts no runtime and delivers a transcript conflict', async () => {
  const store = createStore();
  const now = new Date().toISOString();
  const session = {
    id: newId('ses') as SessionId,
    title: 'Workplace: Test',
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0
    },
    costUsd: 0,
    cwd: process.cwd(),
    createdAt: now,
    updatedAt: now
  } satisfies Session;
  store.insertSession(session);
  for (const memberId of ['pmem_codex_a', 'pmem_codex_b']) {
    store.insertSessionMember({
      sessionId: session.id,
      memberId,
      templateId: 'pmem_codex_template',
      type: 'mesh-agent',
      data: {
        name: 'codex',
        instanceId: memberId,
        settings: { managedProjectAgent: true }
      },
      createdAt: now,
      updatedAt: now
    });
  }
  const starts: Array<Record<string, unknown>> = [];
  let preflightCalls = 0;
  let inputCalls = 0;
  const ctx = {
    deps: {
      store,
      configManager: {
        get: () => ({
          cfg: {
            agent: { agents: [] },
            meshAgents: [
              {
                name: 'codex',
                provider: 'codex',
                productIcon: 'codex',
                command: 'codex',
                enabled: true,
                allowAutopilot: false,
                approvalOwnership: 'provider-owned'
              }
            ]
          }
        })
      },
      meshAgentHost: {
        list: () => ({ sessions: [] }),
        preflight: async () => {
          preflightCalls += 1;
          return { state: 'ready' };
        },
        input: async () => {
          inputCalls += 1;
        }
      }
    },
    requireSession: () => session,
    messageIngress: createMessageIngress({ store, bus: new EventBus() }),
    makeEmit: (round: unknown[]) => (event: unknown) => round.push(event),
    persistAndRetire: () => {}
  } as unknown as SessionContext;
  const forward = createForwardMeshAgentHandler(ctx, async (args) => {
    starts.push(args);
    return { id: 'mesh_forward000002' } as never;
  });

  try {
    const result = await forward({ sessionId: session.id, agentName: 'codex', text: 'review this' });

    expect(result).toEqual({ accepted: true });
    // Ambiguity must resolve before any runtime side effect: no managed start, no preflight, no input.
    expect(starts).toEqual([]);
    expect(preflightCalls).toBe(0);
    expect(inputCalls).toBe(0);
    const messages = store.listMessages(session.id);
    const errorMessage = messages.at(-1);
    expect(errorMessage?.type).toBe('error');
    expect(errorMessage?.text).toContain('[AMBIGUOUS_MEMBER_TARGET]');
    expect(errorMessage?.data).toEqual({ agentName: 'codex' });
  } finally {
    store.close();
  }
});
