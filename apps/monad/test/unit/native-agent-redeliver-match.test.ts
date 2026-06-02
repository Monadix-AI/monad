import { expect, test } from 'bun:test';

import { pendingIngressTargetMatchesAlias } from '#/handlers/session/handlers/managed-mesh-agent-delivery.ts';

test('a login wakes every member sharing the resolved alias, not just the first', () => {
  // One session, two managed members (pmem_a, pmem_b) both running under the runtime alias 'codex', plus an
  // unrelated member under 'claude'. A `.find` on the first alias holder would strand pmem_b's durable target.
  const meshSessions = [
    { agentName: 'codex', projectMemberId: 'pmem_a' },
    { agentName: 'codex', projectMemberId: 'pmem_b' },
    { agentName: 'claude', projectMemberId: 'pmem_c' }
  ];

  expect(pendingIngressTargetMatchesAlias(meshSessions, 'codex', 'pmem_a')).toBe(true);
  expect(pendingIngressTargetMatchesAlias(meshSessions, 'codex', 'pmem_b')).toBe(true);
  // A target whose member is not bound to this alias in the session is not woken by it.
  expect(pendingIngressTargetMatchesAlias(meshSessions, 'codex', 'pmem_c')).toBe(false);
  expect(pendingIngressTargetMatchesAlias(meshSessions, 'claude', 'pmem_a')).toBe(false);
  // An unstamped runtime (projectMemberId null) never matches a canonical target.
  expect(pendingIngressTargetMatchesAlias([{ agentName: 'codex', projectMemberId: null }], 'codex', 'pmem_a')).toBe(
    false
  );
});
