// Core-owned channel conversation→session mapping. The atom pack never touches these tables;
// the gateway resolves/repoints sessions through them (see apps/monad services/channel).

import { expect, test } from 'bun:test';

import { createStore } from '@/store/db/index.ts';

test('getActiveConversation returns null before any binding', () => {
  const store = createStore();
  expect(store.getActiveConversation('chn_A', 'chn_A|chat1')).toBeNull();
  expect(store.countActiveConversations('chn_A')).toBe(0);
});

test('setActiveSession binds a conversation and records history', () => {
  const store = createStore();
  store.setActiveSession({
    channelId: 'chn_A',
    conversationKey: 'chn_A|chat1',
    sessionId: 'ses_1',
    principalId: 'prn_A',
    label: 'first'
  });

  const conv = store.getActiveConversation('chn_A', 'chn_A|chat1');
  expect(conv?.activeSessionId).toBe('ses_1');
  expect(conv?.principalId).toBe('prn_A');

  const sessions = store.listConversationSessions('chn_A', 'chn_A|chat1');
  expect(sessions.map((s) => s.sessionId)).toEqual(['ses_1']);
  expect(store.countActiveConversations('chn_A')).toBe(1);
});

test('repointing keeps history and updates the active pointer (/new, /switch)', () => {
  const store = createStore();
  store.setActiveSession({ channelId: 'chn_A', conversationKey: 'k', sessionId: 'ses_1', principalId: 'prn_A' });
  store.setActiveSession({ channelId: 'chn_A', conversationKey: 'k', sessionId: 'ses_2', principalId: 'prn_A' });

  expect(store.getActiveConversation('chn_A', 'k')?.activeSessionId).toBe('ses_2'); // pointer moved
  expect(store.listConversationSessions('chn_A', 'k').map((s) => s.sessionId)).toEqual(['ses_1', 'ses_2']); // both kept
  expect(store.countActiveConversations('chn_A')).toBe(1); // still one conversation

  // switching back is just a repoint to an existing history entry — no duplicate row
  store.setActiveSession({ channelId: 'chn_A', conversationKey: 'k', sessionId: 'ses_1', principalId: 'prn_A' });
  expect(store.getActiveConversation('chn_A', 'k')?.activeSessionId).toBe('ses_1');
  expect(store.listConversationSessions('chn_A', 'k').length).toBe(2);
});

test('distinct conversations are counted per channel and isolated', () => {
  const store = createStore();
  store.setActiveSession({ channelId: 'chn_A', conversationKey: 'k1', sessionId: 'ses_1', principalId: 'prn_A' });
  store.setActiveSession({ channelId: 'chn_A', conversationKey: 'k2', sessionId: 'ses_2', principalId: 'prn_A' });
  store.setActiveSession({ channelId: 'chn_B', conversationKey: 'k1', sessionId: 'ses_3', principalId: 'prn_B' });

  expect(store.countActiveConversations('chn_A')).toBe(2);
  expect(store.countActiveConversations('chn_B')).toBe(1);
  expect(store.getActiveConversation('chn_A', 'k1')?.activeSessionId).toBe('ses_1');
  expect(store.getActiveConversation('chn_B', 'k1')?.activeSessionId).toBe('ses_3');
});

test('touchConversation advances last_seen_at without changing the session', () => {
  const store = createStore();
  store.setActiveSession({ channelId: 'chn_A', conversationKey: 'k', sessionId: 'ses_1', principalId: 'prn_A' });
  // biome-ignore lint/style/noNonNullAssertion: just set above
  const before = store.getActiveConversation('chn_A', 'k')!;
  store.touchConversation('chn_A', 'k');
  // biome-ignore lint/style/noNonNullAssertion: just set above
  const after = store.getActiveConversation('chn_A', 'k')!;
  expect(after.activeSessionId).toBe(before.activeSessionId);
  expect(Date.parse(after.lastSeenAt)).toBeGreaterThanOrEqual(Date.parse(before.lastSeenAt));
});

test('moderator rounds persist open task batches and settle them', () => {
  const store = createStore();
  store.createChannelModeratorRound({
    id: 'rnd_1',
    channelId: 'chn_A',
    moderatorKey: 'chn_A|chat|a:agt_MOD',
    moderatorAgentId: 'agt_MOD',
    originalInbound: {
      chatId: 'chat',
      userId: 'u',
      text: 'coordinate',
      kind: 'text',
      commandArgs: [],
      nativeMessageId: 'msg_1',
      isSelf: false,
      media: [],
      at: '2026-06-25T00:00:00.000Z'
    },
    depth: 0,
    deadlineAt: '2026-06-25T00:02:00.000Z',
    tasks: [
      {
        index: 0,
        agentId: 'agt_CODER',
        agentName: 'Coder',
        title: 'code',
        task: { agentId: 'agt_CODER', title: 'code', prompt: 'inspect' }
      }
    ]
  });

  const [open] = store.listOpenChannelModeratorRounds('chn_A');
  expect(open?.id).toBe('rnd_1');
  expect(open?.tasks[0]?.task.prompt).toBe('inspect');

  store.updateChannelModeratorRoundResults('rnd_1', [
    { index: 0, agentId: 'agt_CODER', agentName: 'Coder', title: 'code', result: 'done' }
  ]);
  expect(store.listOpenChannelModeratorRounds('chn_A')[0]?.results[0]?.result).toBe('done');

  store.settleChannelModeratorRound('rnd_1', [
    { index: 0, agentId: 'agt_CODER', agentName: 'Coder', title: 'code', result: 'done' }
  ]);
  expect(store.listOpenChannelModeratorRounds('chn_A')).toEqual([]);
});
