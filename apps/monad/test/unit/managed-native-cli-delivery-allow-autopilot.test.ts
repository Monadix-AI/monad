import type { NativeCliAgentConfig } from '@monad/home';
import type { NativeCliSessionView, TranscriptTarget } from '@monad/protocol';
import type { SessionContext } from '@/handlers/session/context.ts';

import { expect, test } from 'bun:test';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';
import { workplaceProjectMembersExtKey } from '@monad/protocol';

import { createManagedNativeCliDelivery } from '@/handlers/session/handlers/managed-native-cli-delivery.ts';
import { registerAgentAdapterImpl } from '@/services/native-cli/index.ts';

// Notice-building (e.g. `usesMcpProjectBridge`) reads the adapter registry, so it must be populated
// like every other native-cli test — mirrors native-cli-host.test.ts / native-cli-adapters.test.ts.
for (const adapter of builtinAgentAdapters) registerAgentAdapterImpl(adapter);

// Regression test: `deliverProjectMessageToManagedNativeCliMembers` (inbox delivery) and
// `deliverDirectMessageToManagedNativeCliMember` (direct-message delivery) both build their
// `startManagedNativeCliRuntimeWithRecovery` call from the same member `settings` object — they must
// thread every field identically, including `allowAutopilot`. A prior version of the direct-message
// path silently dropped it, so a member with `allowAutopilot: false` (delegated approvals) would
// start in full autopilot when a direct message (not a project message) cold-started its session.
function buildHarness() {
  const startCalls: Array<{ agentName: string; allowAutopilot?: boolean }> = [];
  const nativeCliHost = {
    start: async (args: { agentName: string; allowAutopilot?: boolean }) => {
      startCalls.push({ agentName: args.agentName, allowAutopilot: args.allowAutopilot });
      return { id: `ncli_${args.agentName}`, agentName: args.agentName } as NativeCliSessionView;
    },
    input: () => {},
    list: () => ({ sessions: [] }),
    preflight: async () => ({ state: 'ready' as const })
  };
  const store = {
    maxMessageSeq: () => 0,
    markNativeCliInboxDelivered: () => {},
    markNativeCliInboxVisible: () => {},
    findManagedNativeCliStreamingMessage: () => undefined,
    insertMessage: () => {}
  };
  const ctx = {
    deps: { store, log: undefined, nativeCliHost },
    makeEmit: () => () => {},
    persistAndRetire: () => {}
  } as unknown as SessionContext;
  return { delivery: createManagedNativeCliDelivery(ctx), startCalls };
}

const nativeCliAgents: NativeCliAgentConfig[] = [
  {
    name: 'codex',
    provider: 'codex',
    command: 'codex',
    enabled: true,
    defaultLaunchMode: 'app-server'
  } as unknown as NativeCliAgentConfig
];

function sessionWithDelegatedCodexMember(): TranscriptTarget {
  return {
    id: 'prj_delegated',
    cwd: '/tmp/prj',
    origin: {
      ext: {
        [workplaceProjectMembersExtKey]: [
          {
            type: 'native-cli',
            name: 'codex',
            settings: { managedProjectAgent: true, allowAutopilot: false }
          }
        ]
      }
    }
  } as unknown as TranscriptTarget;
}

test('project-message delivery threads a delegated member allowAutopilot to host.start', async () => {
  const { delivery, startCalls } = buildHarness();
  const session = sessionWithDelegatedCodexMember();
  await delivery.deliverProjectMessageToManagedNativeCliMembers({ session, nativeCliAgents, text: 'hi' });
  expect(startCalls).toEqual([{ agentName: 'codex', allowAutopilot: false }]);
});

test('direct-message delivery threads a delegated member allowAutopilot to host.start (matches project delivery)', async () => {
  const { delivery, startCalls } = buildHarness();
  const session = sessionWithDelegatedCodexMember();
  await delivery.deliverDirectMessageToManagedNativeCliMember({
    session,
    nativeCliAgents,
    fromAgentName: 'monad',
    to: 'codex',
    text: 'hi'
  });
  expect(startCalls).toEqual([{ agentName: 'codex', allowAutopilot: false }]);
});
