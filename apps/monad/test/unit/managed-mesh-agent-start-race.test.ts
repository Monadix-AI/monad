import type { MeshAgentConfig } from '@monad/environment';
import type { MeshSessionView, Session } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { expect, test } from 'bun:test';

import { createManagedMeshAgentDelivery } from '#/handlers/session/handlers/managed-mesh-agent-delivery.ts';

function buildHarness() {
  const starts: string[] = [];
  const startRefs: (string | undefined)[] = [];
  const inputs: string[] = [];
  const meshAgentHost = {
    start: async (args: { agentName: string; providerSessionRef?: string }) => {
      starts.push(args.agentName);
      startRefs.push(args.providerSessionRef);
      await Bun.sleep(20);
      return { id: `mesh_${args.agentName}_${starts.length}`, agentName: args.agentName } as MeshSessionView;
    },
    input: (_id: string, { input }: { input: string }) => {
      inputs.push(input.trim());
    }
  };
  const ctx = {
    deps: { store: {}, log: undefined, meshAgentHost },
    makeEmit: () => () => {},
    persistAndRetire: () => {}
  } as unknown as SessionContext;
  return { delivery: createManagedMeshAgentDelivery(ctx), starts, startRefs, inputs, meshAgentHost };
}

const session = { id: 'ses_race00000000', cwd: '/tmp/prj' } as unknown as Session;
const spec = { name: 'codex', provider: 'codex' } as unknown as MeshAgentConfig;

function startArgs(input: string, runtimeAgentName = 'codex') {
  return {
    session,
    spec,
    runtimeAgentName,
    templateAgentName: 'codex',
    displayName: 'Codex',
    input
  };
}

test('concurrent starts for the same member share one runtime and deliver each distinct input once', async () => {
  const { delivery, starts, inputs } = buildHarness();
  const [a, b, c] = await Promise.all([
    delivery.startManagedMeshAgentRuntimeWithRecovery(startArgs('greeting')),
    delivery.startManagedMeshAgentRuntimeWithRecovery(startArgs('greeting')),
    delivery.startManagedMeshAgentRuntimeWithRecovery(startArgs('message B'))
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
    delivery.startManagedMeshAgentRuntimeWithRecovery(startArgs('hello', 'codex')),
    delivery.startManagedMeshAgentRuntimeWithRecovery(startArgs('hello', 'claude'))
  ]);
  await delivery.startManagedMeshAgentRuntimeWithRecovery(startArgs('hello again', 'codex'));
  expect(starts.sort()).toEqual(['claude', 'codex', 'codex']);
  expect(inputs.filter((text) => text === 'hello')).toHaveLength(2);
  expect(inputs.filter((text) => text === 'hello again')).toHaveLength(1);
});

test('resume failure cold-start input restores from shared memory and project inbox', async () => {
  const { delivery, starts, startRefs, inputs, meshAgentHost } = buildHarness();
  meshAgentHost.start = async (args: { agentName: string; providerSessionRef?: string }) => {
    starts.push(args.agentName);
    startRefs.push(args.providerSessionRef);
    if (args.providerSessionRef === 'archived-thread') throw new Error('session archived');
    return { id: `mesh_${args.agentName}_${starts.length}`, agentName: args.agentName } as MeshSessionView;
  };

  await delivery.startManagedMeshAgentRuntimeWithRecovery({
    ...startArgs('recover this project message'),
    providerSessionRef: 'archived-thread'
  });

  expect(startRefs).toEqual(['archived-thread', undefined]);
  expect(inputs).toHaveLength(1);
});
