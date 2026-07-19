import type { ExternalAgentConfig } from '@monad/environment';
import type { ExternalAgentSessionView, Session } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { expect, test } from 'bun:test';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';

import { createManagedExternalAgentDelivery } from '#/handlers/session/handlers/managed-external-agent-delivery.ts';
import { registerAgentAdapterImpl } from '#/services/external-agent/index.ts';

// Notice-building (e.g. `usesMcpProjectBridge`) reads the adapter registry, so it must be populated
// like every other external-agent test — mirrors external-agent-host.test.ts / external-agent-adapters.test.ts.
for (const adapter of builtinAgentAdapters) registerAgentAdapterImpl(adapter);

async function rejectUnexpectedDeliveryError(command: { text: string }): Promise<never> {
  throw new Error(`unexpected managed external agent delivery error: ${command.text}`);
}

// Regression test: `deliverProjectMessageToManagedExternalAgentMembers` (inbox delivery) and
// `deliverDirectMessageToManagedExternalAgentMember` (direct-message delivery) both build their
// `startManagedExternalAgentRuntimeWithRecovery` call from the same member `settings` object — they must
// thread every field identically, including `allowAutopilot`. A prior version of the direct-message
// path silently dropped it, so a member with `allowAutopilot: false` (delegated approvals) would
// start in full autopilot when a direct message (not a project message) cold-started its session.
function buildHarness() {
  const startCalls: Array<{ agentName: string; allowAutopilot?: boolean }> = [];
  const externalAgentHost = {
    start: async (args: { agentName: string; allowAutopilot?: boolean }) => {
      startCalls.push({ agentName: args.agentName, allowAutopilot: args.allowAutopilot });
      return { id: 'exa_codex0000000', agentName: args.agentName } as unknown as ExternalAgentSessionView;
    },
    input: () => {},
    list: () => ({ sessions: [] }),
    preflight: async () => ({ state: 'ready' as const })
  };
  const store = {
    maxMessageSeq: () => 0,
    markExternalAgentInboxDelivered: () => {},
    markExternalAgentInboxVisible: () => {},
    findManagedExternalAgentStreamingMessage: () => undefined,
    insertMessage: () => {},
    // Track B: managed members are now read from session_members, not origin.ext.
    listSessionMembers: () => [
      {
        sessionId: 'ses_delegated000',
        memberId: 'codex',
        templateId: null,
        type: 'external-agent',
        externalAgentSessionId: null,
        data: { name: 'codex', settings: { managedProjectAgent: true, allowAutopilot: false } },
        createdAt: '',
        updatedAt: ''
      }
    ]
  };
  const ctx = {
    deps: { store, log: undefined, externalAgentHost },
    messageIngress: {
      begin: () => Promise.resolve({ id: 'msg_delegated00' }),
      deliver: rejectUnexpectedDeliveryError
    },
    makeEmit: () => () => {},
    persistAndRetire: () => {}
  } as unknown as SessionContext;
  return { delivery: createManagedExternalAgentDelivery(ctx), startCalls };
}

const externalAgents: ExternalAgentConfig[] = [
  {
    name: 'codex',
    provider: 'codex',
    command: 'codex',
    enabled: true,
    defaultLaunchMode: 'app-server'
  } as unknown as ExternalAgentConfig
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
  await delivery.deliverProjectMessageToManagedExternalAgentMembers({ session, externalAgents, text: 'hi' });
  expect(startCalls).toEqual([{ agentName: 'codex', allowAutopilot: false }]);
});

test('direct-message delivery threads a delegated member allowAutopilot to host.start (matches project delivery)', async () => {
  const { delivery, startCalls } = buildHarness();
  const session = sessionWithDelegatedCodexMember();
  await delivery.deliverDirectMessageToManagedExternalAgentMember({
    session,
    externalAgents,
    fromAgentName: 'monad',
    to: 'codex',
    text: 'hi'
  });
  expect(startCalls).toEqual([{ agentName: 'codex', allowAutopilot: false }]);
});

test('project-message fan-out keeps every member inbox pinned to the original message', async () => {
  let maxMessageSeq = 340;
  const enqueued: Array<{ externalAgentSessionId: string; messageSeq: number; triggerMessageId?: string }> = [];
  const members = ['gpt', 'sonnet'].map((name) => ({
    sessionId: 'ses_fanout000000',
    memberId: name,
    templateId: null,
    type: 'external-agent',
    externalAgentSessionId: name === 'gpt' ? 'exa_gpt000000000' : 'exa_sonnet000000',
    data: { name, displayName: name.toUpperCase(), settings: { managedProjectAgent: true } },
    createdAt: '',
    updatedAt: ''
  }));
  const sessions = ['gpt', 'sonnet'].map(
    (agentName) =>
      ({
        id: agentName === 'gpt' ? 'exa_gpt000000000' : 'exa_sonnet000000',
        agentName,
        runtimeRole: 'managed-project-agent',
        state: 'running',
        launchMode: 'app-server',
        lastDeliveredSeq: 0,
        lastVisibleSeq: 0
      }) as unknown as ExternalAgentSessionView
  );
  const store = {
    listSessionMembers: () => members,
    maxMessageSeq: () => maxMessageSeq,
    messageIdForSeq: () => 'msg_sonnet_thinking',
    messageSeq: (_sessionId: string, messageId: string) => (messageId === 'msg_opus_original' ? 338 : 0),
    enqueueExternalAgentInboxItem: (
      externalAgentSessionId: string,
      messageSeq: number,
      metadata: { triggerMessageId?: string }
    ) => {
      enqueued.push({ externalAgentSessionId, messageSeq, triggerMessageId: metadata.triggerMessageId });
      return true;
    },
    markExternalAgentInboxDelivered: () => {},
    markExternalAgentInboxVisible: () => {},
    findManagedExternalAgentStreamingMessage: () => undefined,
    insertMessage: () => {
      maxMessageSeq += 1;
    }
  };
  const externalAgentHost = {
    list: () => ({ sessions }),
    input: async () => {},
    preflight: async () => ({ state: 'ready' as const })
  };
  const ctx = {
    deps: { store, log: undefined, externalAgentHost },
    messageIngress: {
      begin: () => {
        maxMessageSeq += 1;
        return Promise.resolve({ id: maxMessageSeq === 339 ? 'msg_gpt_thinking' : 'msg_sonnet_thinking' });
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
        enabled: true,
        defaultLaunchMode: 'app-server'
      }) as unknown as ExternalAgentConfig
  );

  await createManagedExternalAgentDelivery(ctx).deliverProjectMessageToManagedExternalAgentMembers({
    session: {
      id: 'ses_fanout000000',
      cwd: '/tmp/prj',
      origin: { client: 'workplace' }
    } as unknown as Session,
    externalAgents: fanoutAgents,
    text: 'Opus message',
    triggerMessageId: 'msg_opus_original'
  });

  expect(enqueued).toEqual([
    { externalAgentSessionId: 'exa_gpt000000000', messageSeq: 338, triggerMessageId: 'msg_opus_original' },
    { externalAgentSessionId: 'exa_sonnet000000', messageSeq: 338, triggerMessageId: 'msg_opus_original' }
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
        type: 'external-agent',
        externalAgentSessionId: 'exa_sonnet000000',
        data: { name: 'sonnet', displayName: 'Sonnet', settings: { managedProjectAgent: true } },
        createdAt: '',
        updatedAt: ''
      }
    ],
    messageSeq: (_sessionId: string, messageId: string) => (messageId === 'msg_gpt_reply' ? 345 : 0),
    countExternalAgentInbox: () => 0,
    enqueueExternalAgentInboxItem: () => true,
    markExternalAgentInboxDelivered: () => {},
    markExternalAgentInboxVisible: () => {},
    findManagedExternalAgentStreamingMessage: () => undefined
  };
  const externalAgentHost = {
    list: () => ({
      sessions: [
        {
          id: 'exa_sonnet000000',
          agentName: 'sonnet',
          runtimeRole: 'managed-project-agent',
          state: 'running',
          launchMode: 'app-server',
          lastDeliveredSeq: 344,
          lastVisibleSeq: 341
        } as unknown as ExternalAgentSessionView
      ]
    }),
    input: async (id: string, payload: { input: string }) => {
      inputs.push({ id, input: payload.input });
    },
    preflight: async () => ({ state: 'ready' as const })
  };
  const ctx = {
    deps: { store, log: undefined, externalAgentHost },
    messageIngress: {
      begin: () => Promise.resolve({ id: 'msg_sonnet_thinking' }),
      deliver: rejectUnexpectedDeliveryError
    },
    makeEmit: () => () => {},
    persistAndRetire: () => {}
  } as unknown as SessionContext;

  await createManagedExternalAgentDelivery(ctx).deliverProjectMessageToManagedExternalAgentMembers({
    session: {
      id: 'ses_fanout000000',
      cwd: '/tmp/prj',
      origin: { client: 'workplace' }
    } as unknown as Session,
    externalAgents: [
      {
        name: 'sonnet',
        provider: 'claude-code',
        command: 'claude',
        enabled: true,
        defaultLaunchMode: 'app-server'
      } as unknown as ExternalAgentConfig
    ],
    text: 'GPT reply',
    sender: { kind: 'external-agent', name: 'gpt', id: 'gpt' },
    triggerMessageId: 'msg_gpt_reply'
  });

  expect(inputs).toEqual([
    {
      id: 'exa_sonnet000000',
      input:
        'New Workplace Project message is available.\nYou are being woken to process the pending project inbox now.\n\nPending message metadata:\nSender kind: external-agent\nSender name: gpt\nSender id: gpt\nSender mention token: @[name="gpt" id="external-agent:gpt"]\n\nThe message body is in your project inbox. Follow your managed runtime instructions to read it before deciding whether to reply.\n'
    }
  ]);
});
