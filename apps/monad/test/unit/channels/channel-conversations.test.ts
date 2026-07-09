// Core-owned channel conversation→session mapping. The atom pack never touches these tables;
// the gateway resolves/repoints sessions through them (see apps/monad services/channel).

import { expect, test } from 'bun:test';

import { createStore } from '#/store/db/index.ts';

test('getActiveConversation returns null before any binding', () => {
  const store = createStore();
  expect(store.countActiveConversations('chn_A00000000000')).toBe(0);
});

test('setActiveSession binds a conversation and records history', () => {
  const store = createStore();
  store.setActiveSession({
    channelId: 'chn_A00000000000',
    conversationKey: 'chn_A00000000000|chat1',
    sessionId: 'ses_100000000000',
    principalId: 'prn_A00000000000',
    label: 'first'
  });

  const conv = store.getActiveConversation('chn_A00000000000', 'chn_A00000000000|chat1');
  expect(conv?.activeSessionId).toBe('ses_100000000000');
  expect(conv?.principalId).toBe('prn_A00000000000');

  const sessions = store.listConversationSessions('chn_A00000000000', 'chn_A00000000000|chat1');
  expect(sessions.map((s) => s.sessionId)).toEqual(['ses_100000000000']);
  expect(store.countActiveConversations('chn_A00000000000')).toBe(1);
});

test('repointing keeps history and updates the active pointer (/new, /switch)', () => {
  const store = createStore();
  store.setActiveSession({
    channelId: 'chn_A00000000000',
    conversationKey: 'k',
    sessionId: 'ses_100000000000',
    principalId: 'prn_A00000000000'
  });
  store.setActiveSession({
    channelId: 'chn_A00000000000',
    conversationKey: 'k',
    sessionId: 'ses_200000000000',
    principalId: 'prn_A00000000000'
  });

  expect(store.getActiveConversation('chn_A00000000000', 'k')?.activeSessionId).toBe('ses_200000000000'); // pointer moved
  expect(store.listConversationSessions('chn_A00000000000', 'k').map((s) => s.sessionId)).toEqual([
    'ses_100000000000',
    'ses_200000000000'
  ]); // both kept
  expect(store.countActiveConversations('chn_A00000000000')).toBe(1); // still one conversation

  // switching back is just a repoint to an existing history entry — no duplicate row
  store.setActiveSession({
    channelId: 'chn_A00000000000',
    conversationKey: 'k',
    sessionId: 'ses_100000000000',
    principalId: 'prn_A00000000000'
  });
  expect(store.getActiveConversation('chn_A00000000000', 'k')?.activeSessionId).toBe('ses_100000000000');
  expect(store.listConversationSessions('chn_A00000000000', 'k').length).toBe(2);
});

test('distinct conversations are counted per channel and isolated', () => {
  const store = createStore();
  store.setActiveSession({
    channelId: 'chn_A00000000000',
    conversationKey: 'k1',
    sessionId: 'ses_100000000000',
    principalId: 'prn_A00000000000'
  });
  store.setActiveSession({
    channelId: 'chn_A00000000000',
    conversationKey: 'k2',
    sessionId: 'ses_200000000000',
    principalId: 'prn_A00000000000'
  });
  store.setActiveSession({
    channelId: 'chn_B00000000000',
    conversationKey: 'k1',
    sessionId: 'ses_300000000000',
    principalId: 'prn_B00000000000'
  });

  expect(store.countActiveConversations('chn_A00000000000')).toBe(2);
  expect(store.countActiveConversations('chn_B00000000000')).toBe(1);
  expect(store.getActiveConversation('chn_A00000000000', 'k1')?.activeSessionId).toBe('ses_100000000000');
  expect(store.getActiveConversation('chn_B00000000000', 'k1')?.activeSessionId).toBe('ses_300000000000');
});

test('touchConversation advances last_seen_at without changing the session', () => {
  const store = createStore();
  store.setActiveSession({
    channelId: 'chn_A00000000000',
    conversationKey: 'k',
    sessionId: 'ses_100000000000',
    principalId: 'prn_A00000000000'
  });
  // biome-ignore lint/style/noNonNullAssertion: just set above
  const before = store.getActiveConversation('chn_A00000000000', 'k')!;
  store.touchConversation('chn_A00000000000', 'k');
  // biome-ignore lint/style/noNonNullAssertion: just set above
  const after = store.getActiveConversation('chn_A00000000000', 'k')!;
  expect(after.activeSessionId).toBe(before.activeSessionId);
  expect(Date.parse(after.lastSeenAt)).toBeGreaterThanOrEqual(Date.parse(before.lastSeenAt));
});
