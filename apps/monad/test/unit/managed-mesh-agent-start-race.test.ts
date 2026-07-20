import type { MeshAgentConfig } from '@monad/environment';
import type { Event, MeshSessionView, Session } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { expect, test } from 'bun:test';
import { eventDefinition } from '@monad/protocol';

import { createManagedMeshAgentDelivery } from '#/handlers/session/handlers/managed-mesh-agent-delivery.ts';

function buildHarness() {
  const starts: string[] = [];
  const startRefs: (string | undefined)[] = [];
  const startInputs: string[] = [];
  const inputs: string[] = [];
  const events: Event[] = [];
  const meshAgentHost = {
    start: async (args: { agentName: string; providerSessionRef?: string; initialInput: string }) => {
      starts.push(args.agentName);
      startRefs.push(args.providerSessionRef);
      startInputs.push(args.initialInput.trim());
      await Bun.sleep(20);
      return { id: `mesh_${args.agentName}_${starts.length}`, agentName: args.agentName } as MeshSessionView;
    },
    input: (_id: string, { input }: { input: string }) => {
      inputs.push(input.trim());
    }
  };
  const ctx = {
    deps: { store: {}, log: undefined, meshAgentHost },
    makeEmit: (round: Event[]) => (event: Event) => {
      round.push(event);
      events.push(event);
    },
    persistAndRetire: (_sessionId: string, round: Event[]) => {
      for (const event of round) eventDefinition(event.type).schema.parse(event.payload);
    }
  } as unknown as SessionContext;
  return {
    delivery: createManagedMeshAgentDelivery(ctx),
    events,
    starts,
    startRefs,
    startInputs,
    inputs,
    meshAgentHost
  };
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
  const { delivery, starts, startInputs, inputs } = buildHarness();
  const [a, b, c] = await Promise.all([
    delivery.startManagedMeshAgentRuntimeWithRecovery(startArgs('greeting')),
    delivery.startManagedMeshAgentRuntimeWithRecovery(startArgs('greeting')),
    delivery.startManagedMeshAgentRuntimeWithRecovery(startArgs('message B'))
  ]);
  expect(starts).toEqual(['codex']);
  expect(a.id).toBe(b.id);
  expect(b.id).toBe(c.id);
  expect(startInputs).toEqual(['greeting']);
  expect(inputs.filter((text) => text === 'message B')).toHaveLength(1);
});

test('different members start independently and a settled start does not dedupe later ones', async () => {
  const { delivery, starts, startInputs, inputs } = buildHarness();
  await Promise.all([
    delivery.startManagedMeshAgentRuntimeWithRecovery(startArgs('hello', 'codex')),
    delivery.startManagedMeshAgentRuntimeWithRecovery(startArgs('hello', 'claude'))
  ]);
  await delivery.startManagedMeshAgentRuntimeWithRecovery(startArgs('hello again', 'codex'));
  expect(starts.sort()).toEqual(['claude', 'codex', 'codex']);
  expect(startInputs.sort()).toEqual(['hello', 'hello', 'hello again']);
  expect(inputs).toEqual([]);
});

test('resume failure without a provider error code cold-starts with a valid lifecycle event', async () => {
  const { delivery, events, starts, startRefs, startInputs, inputs, meshAgentHost } = buildHarness();
  meshAgentHost.start = async (args: { agentName: string; providerSessionRef?: string; initialInput: string }) => {
    starts.push(args.agentName);
    startRefs.push(args.providerSessionRef);
    startInputs.push(args.initialInput.trim());
    if (args.providerSessionRef === 'archived-thread') throw new Error('session archived');
    return { id: `mesh_${args.agentName}_${starts.length}`, agentName: args.agentName } as MeshSessionView;
  };

  await delivery.startManagedMeshAgentRuntimeWithRecovery({
    ...startArgs('recover this project message'),
    providerSessionRef: 'archived-thread'
  });

  expect(startRefs).toEqual(['archived-thread', undefined]);
  expect(startInputs[0]).toBe('recover this project message');
  expect(startInputs[1]).toContain('recover this project message');
  expect(inputs).toEqual([]);
  expect(events.map((event) => ({ type: event.type, payload: event.payload }))).toEqual([
    {
      type: 'mesh.resume_failed',
      payload: {
        agentName: 'codex',
        provider: 'codex',
        providerSessionRef: 'archived-thread',
        code: 'resume_failed',
        message: 'session archived',
        fallback: 'cold-start'
      }
    }
  ]);
});
