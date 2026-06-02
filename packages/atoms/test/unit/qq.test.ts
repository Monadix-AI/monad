import { expect, test } from 'bun:test';

import { normalizeQQMessage } from '../../src/channels/qq.ts';

test('QQ1: guild AT message → group keyed by channel, addressed, surface guild', () => {
  const n = normalizeQQMessage('AT_MESSAGE_CREATE', {
    id: 'm1',
    content: '/help',
    channel_id: 'ch1',
    guild_id: 'g1',
    author: { id: 'u1', username: 'Al' }
  });
  expect(n?.surface).toBe('guild');
  expect(n?.msgId).toBe('m1');
  expect(n?.inbound).toMatchObject({
    chatId: 'ch1',
    userId: 'u1',
    chatType: 'group',
    mentionedSelf: true,
    command: 'help',
    kind: 'command',
    senderDisplay: 'Al'
  });
});

test('QQ2: group-at → group surface keyed by group_openid; c2c → dm surface by user_openid', () => {
  const grp = normalizeQQMessage('GROUP_AT_MESSAGE_CREATE', {
    id: 'm2',
    content: 'hi',
    group_openid: 'grp1',
    author: { member_openid: 'mem1' }
  });
  expect(grp).toMatchObject({ surface: 'group' });
  expect(grp?.inbound).toMatchObject({ chatId: 'grp1', userId: 'mem1', chatType: 'group', mentionedSelf: true });
  const c2c = normalizeQQMessage('C2C_MESSAGE_CREATE', { id: 'm3', content: 'yo', author: { user_openid: 'usr1' } });
  expect(c2c).toMatchObject({ surface: 'c2c' });
  expect(c2c?.inbound).toMatchObject({ chatId: 'usr1', chatType: 'dm' });
});

test('QQ3: direct message → dm surface keyed by guild_id; unknown event → null', () => {
  const dm = normalizeQQMessage('DIRECT_MESSAGE_CREATE', {
    id: 'm4',
    content: 'hey',
    guild_id: 'dmguild',
    author: { id: 'u9' }
  });
  expect(dm).toMatchObject({ surface: 'dm' });
  expect(dm?.inbound).toMatchObject({ chatId: 'dmguild', chatType: 'dm', mentionedSelf: true });
  expect(normalizeQQMessage('GUILD_CREATE', {})).toBe(null);
});
