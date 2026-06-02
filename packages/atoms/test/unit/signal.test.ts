import { expect, test } from 'bun:test';

import { normalizeSignalEnvelope } from '../../src/channels/signal.ts';

test('SG1: dataMessage → inbound; group keyed by groupId, dm by sender', () => {
  const dm = normalizeSignalEnvelope({
    sourceUuid: 'uuid-1',
    sourceNumber: '+1555',
    sourceName: 'Al',
    timestamp: 1700,
    dataMessage: { message: 'hi' }
  });
  expect(dm).toMatchObject({
    chatId: 'uuid-1',
    userId: 'uuid-1',
    text: 'hi',
    chatType: 'dm',
    senderDisplay: 'Al',
    nativeMessageId: '1700'
  });
  const grp = normalizeSignalEnvelope({
    sourceUuid: 'u',
    timestamp: 1,
    dataMessage: { message: 'yo', groupInfo: { groupId: 'GID==' } }
  });
  expect(grp).toMatchObject({ chatId: 'GID==', chatType: 'group' });
});

test('SG2: sync messages (own echo) and empty bodies → null', () => {
  expect(normalizeSignalEnvelope({ syncMessage: {}, dataMessage: { message: 'x' } })).toBe(null);
  expect(normalizeSignalEnvelope({ sourceUuid: 'u' })).toBe(null);
  expect(normalizeSignalEnvelope({ sourceUuid: 'u', dataMessage: { message: null } })).toBe(null);
});

test('SG3: mentionedSelf when a mention matches selfId; command parse', () => {
  const m = normalizeSignalEnvelope(
    {
      sourceUuid: 'u',
      timestamp: 1,
      dataMessage: { message: 'hey', groupInfo: { groupId: 'G' }, mentions: [{ uuid: 'me-uuid' }] }
    },
    'me-uuid'
  );
  expect(m?.mentionedSelf).toBe(true);
  expect(normalizeSignalEnvelope({ sourceUuid: 'u', timestamp: 1, dataMessage: { message: '/reset' } })).toMatchObject({
    command: 'reset',
    kind: 'command'
  });
});
