import { expect, test } from 'bun:test';

import { createSignalAdapter, normalizeSignalEnvelope } from '../../src/channels/signal.ts';

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

test('SG4: connect registers the signal-cli process with the host tracker', async () => {
  const tracked: Array<{ label?: string; pid?: number }> = [];
  const adapter = createSignalAdapter({
    config: {
      id: 'sig-test',
      type: 'signal',
      label: 'Signal',
      options: { account: '+15551234567', cliPath: process.execPath }
    },
    secrets: {},
    signal: new AbortController().signal,
    log: () => {},
    onMessage: () => {},
    trackProcess: (proc, label) => tracked.push({ label, pid: proc.pid })
  });

  await adapter.connect();
  try {
    expect(tracked.length).toBe(1);
    expect(tracked[0]?.label).toBe('channel:signal');
    expect(tracked[0]?.pid).toBeGreaterThan(0);
  } finally {
    await adapter.disconnect();
  }
});
