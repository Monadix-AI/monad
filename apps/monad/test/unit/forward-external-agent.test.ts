import type { Session, SessionId } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { createForwardExternalAgentHandler } from '#/handlers/session/handlers/forward-external-agent.ts';
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
    type: 'external-agent',
    data: {
      name: 'codex',
      instanceId: 'pmem_codex_1',
      settings: { managedProjectAgent: true, launchMode: 'app-server' }
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
            externalAgents: [
              {
                name: 'codex',
                provider: 'codex',
                productIcon: 'codex',
                command: 'codex',
                enabled: true,
                defaultLaunchMode: 'app-server',
                allowAutopilot: false,
                approvalOwnership: 'provider-owned'
              }
            ]
          }
        })
      },
      externalAgentHost: {
        list: () => ({ sessions: [] }),
        preflight: async () => ({ state: 'ready' })
      }
    },
    requireSession: () => session,
    messageIngress: createMessageIngress({ store, bus: new EventBus() }),
    makeEmit: (round: unknown[]) => (event: unknown) => round.push(event),
    persistAndRetire: () => {}
  } as unknown as SessionContext;
  const forward = createForwardExternalAgentHandler(ctx, async (args) => {
    starts.push(args);
    return { id: 'exa_forward000001' } as never;
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
          defaultLaunchMode: 'app-server',
          allowAutopilot: false,
          approvalOwnership: 'provider-owned'
        },
        runtimeAgentName: 'pmem_codex_1',
        templateAgentName: 'codex',
        displayName: undefined,
        reasoningEffort: undefined,
        modelId: undefined,
        speed: undefined,
        customPrompt: undefined,
        launchMode: 'app-server',
        allowAutopilot: undefined,
        providerSessionRef: undefined,
        input: 'review this'
      }
    ]);
  } finally {
    store.close();
  }
});
