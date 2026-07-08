import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createStore } from '#/store/db/index.ts';

let store: ReturnType<typeof createStore>;

beforeEach(() => {
  store = createStore();
});

afterEach(() => {
  store.close();
});

const now = '2026-07-08T00:00:00.000Z';

test('a session member persists its template link, type, and data blob', () => {
  store.insertSessionMember({
    sessionId: 'ses_1',
    memberId: 'pmem_codex_a',
    templateId: 'tpl_codex',
    type: 'external-agent',
    data: { name: 'codex', displayName: 'Codex' },
    createdAt: now,
    updatedAt: now
  });

  const member = store.getSessionMember('ses_1', 'pmem_codex_a');
  expect(member).toEqual({
    sessionId: 'ses_1',
    memberId: 'pmem_codex_a',
    templateId: 'tpl_codex',
    type: 'external-agent',
    externalAgentSessionId: null,
    data: { name: 'codex', displayName: 'Codex' },
    createdAt: now,
    updatedAt: now
  });
});

test('an ad-hoc spawned member has no template link', () => {
  store.insertSessionMember({
    sessionId: 'ses_1',
    memberId: 'pmem_ad_hoc',
    type: 'external-agent',
    data: { name: 'claude' },
    createdAt: now,
    updatedAt: now
  });

  expect(store.getSessionMember('ses_1', 'pmem_ad_hoc')?.templateId).toBeNull();
});

test('the same template invited into two different sessions produces two independent bindings', () => {
  store.insertSessionMember({
    sessionId: 'ses_1',
    memberId: 'pmem_codex_a',
    templateId: 'tpl_codex',
    type: 'external-agent',
    data: {},
    createdAt: now,
    updatedAt: now
  });
  store.insertSessionMember({
    sessionId: 'ses_2',
    memberId: 'pmem_codex_a',
    templateId: 'tpl_codex',
    type: 'external-agent',
    data: {},
    createdAt: now,
    updatedAt: now
  });
  store.updateSessionMember('ses_1', 'pmem_codex_a', { externalAgentSessionId: 'exa_ses1', updatedAt: now });
  store.updateSessionMember('ses_2', 'pmem_codex_a', { externalAgentSessionId: 'exa_ses2', updatedAt: now });

  expect(store.getSessionMember('ses_1', 'pmem_codex_a')?.externalAgentSessionId).toBe('exa_ses1');
  expect(store.getSessionMember('ses_2', 'pmem_codex_a')?.externalAgentSessionId).toBe('exa_ses2');
});

test('listSessionMembers scopes strictly to one session', () => {
  store.insertSessionMember({
    sessionId: 'ses_1',
    memberId: 'pmem_a',
    type: 'external-agent',
    data: {},
    createdAt: now,
    updatedAt: now
  });
  store.insertSessionMember({
    sessionId: 'ses_1',
    memberId: 'pmem_b',
    type: 'acp',
    data: {},
    createdAt: now,
    updatedAt: now
  });
  store.insertSessionMember({
    sessionId: 'ses_2',
    memberId: 'pmem_c',
    type: 'external-agent',
    data: {},
    createdAt: now,
    updatedAt: now
  });

  const members = store.listSessionMembers('ses_1');
  expect(members.map((m) => m.memberId).sort()).toEqual(['pmem_a', 'pmem_b']);
});

test('deleteSessionMember removes exactly one binding; deleteSessionMembers clears the whole session', () => {
  store.insertSessionMember({
    sessionId: 'ses_1',
    memberId: 'pmem_a',
    type: 'external-agent',
    data: {},
    createdAt: now,
    updatedAt: now
  });
  store.insertSessionMember({
    sessionId: 'ses_1',
    memberId: 'pmem_b',
    type: 'external-agent',
    data: {},
    createdAt: now,
    updatedAt: now
  });

  store.deleteSessionMember('ses_1', 'pmem_a');
  expect(store.listSessionMembers('ses_1').map((m) => m.memberId)).toEqual(['pmem_b']);

  store.deleteSessionMembers('ses_1');
  expect(store.listSessionMembers('ses_1')).toEqual([]);
});

test('getSessionMember returns null for an unknown binding', () => {
  expect(store.getSessionMember('ses_missing', 'pmem_missing')).toBeNull();
});
