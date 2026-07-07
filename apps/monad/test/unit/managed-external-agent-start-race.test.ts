import type { ExternalAgentConfig } from '@monad/home';
import type { ExternalAgentSessionView, TranscriptTarget } from '@monad/protocol';
import type { SessionContext } from '@/handlers/session/context.ts';

import { expect, test } from 'bun:test';

import { createManagedExternalAgentDelivery } from '@/handlers/session/handlers/managed-external-agent-delivery.ts';

function buildHarness() {
  const starts: string[] = [];
  const startRefs: (string | undefined)[] = [];
  const inputs: string[] = [];
  const externalAgentHost = {
    start: async (args: { agentName: string; providerSessionRef?: string }) => {
      starts.push(args.agentName);
      startRefs.push(args.providerSessionRef);
      await Bun.sleep(20);
      return { id: `exa_${args.agentName}_${starts.length}`, agentName: args.agentName } as ExternalAgentSessionView;
    },
    input: (_id: string, { input }: { input: string }) => {
      inputs.push(input.trim());
    }
  };
  const ctx = {
    deps: { store: {}, log: undefined, externalAgentHost },
    makeEmit: () => () => {},
    persistAndRetire: () => {}
  } as unknown as SessionContext;
  return { delivery: createManagedExternalAgentDelivery(ctx), starts, startRefs, inputs, externalAgentHost };
}

const session = { id: 'prj_race', cwd: '/tmp/prj' } as unknown as TranscriptTarget;
const spec = { name: 'codex', provider: 'codex' } as unknown as ExternalAgentConfig;

function startArgs(input: string, runtimeAgentName = 'codex') {
  return {
    session,
    spec,
    runtimeAgentName,
    templateAgentName: 'codex',
    displayName: 'Codex',
    launchMode: 'app-server' as const,
    input
  };
}

test('concurrent starts for the same member share one runtime and deliver each distinct input once', async () => {
  const { delivery, starts, inputs } = buildHarness();
  const [a, b, c] = await Promise.all([
    delivery.startManagedExternalAgentRuntimeWithRecovery(startArgs('greeting')),
    delivery.startManagedExternalAgentRuntimeWithRecovery(startArgs('greeting')),
    delivery.startManagedExternalAgentRuntimeWithRecovery(startArgs('message B'))
  ]);
  expect(starts).toEqual(['codex']);
  expect(a.id).toBe(b.id);
  expect(b.id).toBe(c.id);
  expect(inputs.filter((text) => text === 'greeting')).toHaveLength(1);
  expect(inputs.filter((text) => text === 'message B')).toHaveLength(1);
});

test('different members start independently and a settled start does not dedupe later ones', async () => {
  const { delivery, starts, inputs } = buildHarness();
  await Promise.all([
    delivery.startManagedExternalAgentRuntimeWithRecovery(startArgs('hello', 'codex')),
    delivery.startManagedExternalAgentRuntimeWithRecovery(startArgs('hello', 'claude'))
  ]);
  await delivery.startManagedExternalAgentRuntimeWithRecovery(startArgs('hello again', 'codex'));
  expect(starts.sort()).toEqual(['claude', 'codex', 'codex']);
  expect(inputs.filter((text) => text === 'hello')).toHaveLength(2);
  expect(inputs.filter((text) => text === 'hello again')).toHaveLength(1);
});

test('resume failure cold-start input restores from shared memory and project inbox', async () => {
  const { delivery, starts, startRefs, inputs, externalAgentHost } = buildHarness();
  externalAgentHost.start = async (args: { agentName: string; providerSessionRef?: string }) => {
    starts.push(args.agentName);
    startRefs.push(args.providerSessionRef);
    if (args.providerSessionRef === 'archived-thread') throw new Error('session archived');
    return { id: `exa_${args.agentName}_${starts.length}`, agentName: args.agentName } as ExternalAgentSessionView;
  };

  await delivery.startManagedExternalAgentRuntimeWithRecovery({
    ...startArgs('recover this project message'),
    providerSessionRef: 'archived-thread'
  });

  expect(startRefs).toEqual(['archived-thread', undefined]);
  expect(inputs).toHaveLength(1);
});
