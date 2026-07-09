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
    sessionId: 'ses_100000000000',
    memberId: 'pmem_codex_a',
    templateId: 'tpl_codex',
    type: 'external-agent',
    data: { name: 'codex', displayName: 'Codex' },
    createdAt: now,
    updatedAt: now
  });

  const member = store.getSessionMember('ses_100000000000', 'pmem_codex_a');
  expect(member).toEqual({
    sessionId: 'ses_100000000000',
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
    sessionId: 'ses_100000000000',
    memberId: 'pmem_ad_hoc',
    type: 'external-agent',
    data: { name: 'claude' },
    createdAt: now,
    updatedAt: now
  });

  expect(store.getSessionMember('ses_100000000000', 'pmem_ad_hoc')?.templateId).toBeNull();
});

test('the same template invited into two different sessions produces two independent bindings', () => {
  store.insertSessionMember({
    sessionId: 'ses_100000000000',
    memberId: 'pmem_codex_a',
    templateId: 'tpl_codex',
    type: 'external-agent',
    data: {},
    createdAt: now,
    updatedAt: now
  });
  store.insertSessionMember({
    sessionId: 'ses_200000000000',
    memberId: 'pmem_codex_a',
    templateId: 'tpl_codex',
    type: 'external-agent',
    data: {},
    createdAt: now,
    updatedAt: now
  });
  store.updateSessionMember('ses_100000000000', 'pmem_codex_a', {
    externalAgentSessionId: 'exa_ses100000000',
    updatedAt: now
  });
  store.updateSessionMember('ses_200000000000', 'pmem_codex_a', {
    externalAgentSessionId: 'exa_ses200000000',
    updatedAt: now
  });

  expect(store.getSessionMember('ses_100000000000', 'pmem_codex_a')?.externalAgentSessionId).toBe('exa_ses100000000');
  expect(store.getSessionMember('ses_200000000000', 'pmem_codex_a')?.externalAgentSessionId).toBe('exa_ses200000000');
});

test('listSessionMembers scopes strictly to one session', () => {
  store.insertSessionMember({
    sessionId: 'ses_100000000000',
    memberId: 'pmem_a',
    type: 'external-agent',
    data: {},
    createdAt: now,
    updatedAt: now
  });
  store.insertSessionMember({
    sessionId: 'ses_100000000000',
    memberId: 'pmem_b',
    type: 'acp',
    data: {},
    createdAt: now,
    updatedAt: now
  });
  store.insertSessionMember({
    sessionId: 'ses_200000000000',
    memberId: 'pmem_c',
    type: 'external-agent',
    data: {},
    createdAt: now,
    updatedAt: now
  });

  const members = store.listSessionMembers('ses_100000000000');
  expect(members.map((m) => m.memberId).sort()).toEqual(['pmem_a', 'pmem_b']);
});

test('deleteSessionMember removes exactly one binding; deleteSessionMembers clears the whole session', () => {
  store.insertSessionMember({
    sessionId: 'ses_100000000000',
    memberId: 'pmem_a',
    type: 'external-agent',
    data: {},
    createdAt: now,
    updatedAt: now
  });
  store.insertSessionMember({
    sessionId: 'ses_100000000000',
    memberId: 'pmem_b',
    type: 'external-agent',
    data: {},
    createdAt: now,
    updatedAt: now
  });

  store.deleteSessionMember('ses_100000000000', 'pmem_a');
  expect(store.listSessionMembers('ses_100000000000').map((m) => m.memberId)).toEqual(['pmem_b']);

  store.deleteSessionMembers('ses_100000000000');
  expect(store.listSessionMembers('ses_100000000000')).toEqual([]);
});

test('getSessionMember returns null for an unknown binding', () => {
  expect(store.getSessionMember('ses_missing00000', 'pmem_missing')).toBeNull();
});
