import type { InvitableMeshAgent } from '../src/index.ts';

import { expect, test } from 'bun:test';

import { invitableMeshAgentSchema, listInvitableMeshAgentsResponseSchema } from '../src/index.ts';

const candidate = {
  name: 'monad--agt_000000000000',
  displayName: 'Reviewer',
  provider: 'monad',
  productIcon: 'monad',
  icon: { title: 'Monad adapter', path: 'M1 1h22v22H1z' },
  enabled: true,
  allowAutopilot: true,
  capabilities: {
    auth: 'none',
    events: 'none',
    resume: 'pty',
    approval: 'provider-owned',
    autopilot: false,
    fastMode: false
  },
  modelOptions: [],
  speedsByModel: {},
  reasoningEfforts: [],
  source: 'monad-agent'
} satisfies InvitableMeshAgent;

test('invitable MeshAgent contract exposes only invitation-safe fields', () => {
  expect(invitableMeshAgentSchema.parse(candidate)).toEqual(candidate);
  expect(listInvitableMeshAgentsResponseSchema.parse({ agents: [candidate] })).toEqual({ agents: [candidate] });
  expect(() => invitableMeshAgentSchema.parse({ ...candidate, command: 'monad' })).toThrow();
  expect(() =>
    invitableMeshAgentSchema.parse({ ...candidate, adapterSettings: { agentId: 'agt_000000000000' } })
  ).toThrow();
});
